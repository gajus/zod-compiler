/**
 * Runtime compilation — the same extract → codegen pipeline the build plugin
 * runs, executed in-process and evaluated through `new Function`.
 *
 * The AOT paths (unplugin, CLI) need a build step to fire. Plenty of everyday
 * code has none: `tsx server.ts`, `node --experimental-strip-types`, a Jest
 * suite, a serverless handler bundled by someone else's toolchain, a library
 * that ships schemas to consumers. There `compile()` is a no-op and every parse
 * runs plain Zod. `jit()` closes that gap — one call, no build integration,
 * measured 3-25x on everyday schemas at ~0.1-0.2 ms of one-time compilation.
 *
 * Nothing here re-implements validation: {@link compileSchemas} and
 * {@link generateIIFE} are the exact modules the plugin and CLI use, so the
 * generated validator, its Zod parity and its performance are identical to what
 * a build would have emitted. The only difference is *when* the code is
 * produced.
 *
 * Compilation is LAZY by default: `jit()` installs accessors that compile on
 * the first read of a parse method and replace themselves with the compiled
 * ones. Importing a module of 500 schemas therefore costs nothing, and a
 * serverless invocation touching three of them pays for three.
 *
 * Zod itself keeps the parse methods on the PROTOTYPE (since 4.4): each is a
 * getter that binds the method on first read and installs the bound copy as an
 * own data property, so a fresh schema carries no own `parse` / `safeParse` at
 * all, while one that has been read already does. `jit()` meets both shapes —
 * it snapshots whatever the slots hold, fronts them with its own accessors, and
 * hands back exactly what it found whenever it has to step aside.
 *
 * Runtime code generation is not always permitted — a strict CSP without
 * `unsafe-eval`, some edge runtimes. Zod v4 has the same constraint (its object
 * fast-pass is itself a `new Function`) and already exposes the two switches
 * for it: the `core.util.allowsEval` probe and `z.config({ jitless: true })`.
 * `jit()` honours both and degrades to plain Zod, so one setting governs both
 * compilers. Those targets are where the build plugin belongs anyway — it emits
 * the same validator with no runtime evaluation at all.
 */

import { config as zodConfig, core as zodCore, ZodRealError, type output, type ZodType } from "zod";
import {
  FAIL_CLASS_DECL,
  FAILZ_CLASS_DECL,
  FIN_DECL,
  FIN_DEFERRED_DECL,
  FINZ_DECL,
  generateIIFE,
  MK_VALIDATOR_DECL,
  ZOD_MSG_DECLARATION,
} from "./core/iife.js";
import {
  isSupportedZodVersion,
  isUnsupportedZodVersionError,
  unsupportedZodVersionMessage,
  warnUnsupportedZodOnce,
  zodVersionOf,
} from "./core/extract/zod-version.js";
import { compileSchemas } from "./core/pipeline.js";
import type { CompiledSchema } from "./core/types.js";
import { isZodSchema } from "./is-zod-schema.js";

/**
 * The declarations `ZOD_CONFIG_IMPORT` supplies to an emitted module, minus the
 * import itself — `zod`'s three bindings arrive as parameters instead, so the
 * evaluated code has no module scope to resolve. Byte-for-byte the same helper
 * source the CLI emitter writes into a `.compiled.ts`, so a JIT validator and
 * an AOT one share their entire runtime layer.
 */
const RUNTIME_PRELUDE = [
  ZOD_MSG_DECLARATION,
  FAIL_CLASS_DECL,
  MK_VALIDATOR_DECL,
  FIN_DECL,
  FIN_DEFERRED_DECL,
  FAILZ_CLASS_DECL,
  FINZ_DECL,
].join("\n");

/**
 * Methods `__zcMkv` installs. Each is fronted by a compile-on-read accessor
 * until the schema materializes.
 *
 * `~standard` earns its place: Zod builds it as a closure over `_zod.run`, not
 * over the schema's `safeParse` property, so a Standard Schema consumer (tRPC,
 * Hono, TanStack Form) that never touches `safeParse` would otherwise keep
 * running plain Zod forever behind a "compiled" schema.
 */
const SLOTS = ["parse", "safeParse", "parseAsync", "safeParseAsync", "is", "~standard"] as const;

/** Schemas already handed to `jit()`, so a second call is a no-op rather than a recompile. */
const seen = new WeakSet<object>();

export interface JitOptions {
  /**
   * Compile immediately instead of on first use. Costs ~0.1-0.2 ms per schema
   * at import time; useful for a long-lived server that would rather pay during
   * startup than on the first request, or to surface a compilation failure
   * eagerly. Default `false`.
   */
  eager?: boolean | undefined;
  /** Use compact codegen and delegate cold error production to Zod. @default "schema" */
  output?: "schema" | "compact" | undefined;
}

/**
 * Compile `schema` in-process and install the compiled `parse` / `safeParse` /
 * `parseAsync` / `safeParseAsync` / `is` / `~standard` on it.
 *
 * Returns the SAME object — identity-preserving exactly as the build plugin is,
 * so `.shape`, `_zod`, `instanceof`, `z.toJSONSchema()`, `.meta()` and
 * composition into a larger schema all keep working, and every existing
 * reference to the schema picks the compiled methods up.
 *
 * ```ts
 * import { z } from "zod";
 * import { jit } from "zod-compiler/jit";
 *
 * export const UserSchema = jit(z.object({ name: z.string(), email: z.email() }));
 * UserSchema.safeParse(input); // compiled on this first call
 * ```
 *
 * Schemas the compiler cannot reproduce fall back to Zod per sub-schema, the
 * same way they do at build time; a schema that cannot be compiled at all is
 * left as plain Zod.
 */
export function jit<T extends ZodType>(
  schema: T,
  options?: JitOptions,
): T & CompiledSchema<output<T>> {
  const target = schema as unknown as Record<string, unknown>;
  if (seen.has(target)) return schema as T & CompiledSchema<output<T>>;

  // A schema built by a zod this release does not reproduce is left as plain
  // Zod — correct, just not faster — and said so once (see zod-version.ts).
  // Not thrown: `jit()` runs at module scope, where a throw takes the importing
  // app down at boot over what is a dependency-range problem. Checked before
  // anything is installed, so neither the eager path nor a later
  // compile-on-read accessor can reach the pipeline for it. A value that is not
  // a zod schema at all is not a version problem and takes the usual route.
  const version = zodVersionOf(schema);
  if (isZodSchema(schema) && !isSupportedZodVersion(version)) {
    warnUnsupportedZodOnce(unsupportedZodVersionMessage(version));
    return schema as T & CompiledSchema<output<T>>;
  }
  seen.add(target);

  if (options?.eager === true) {
    materialize(schema, options);
    return schema as T & CompiledSchema<output<T>>;
  }

  // Snapshot what each slot holds before anything is installed: materialize()
  // restores it before handing the object to `__zcMkv`, so the generated code
  // sees a pristine schema — it captures the original `parseAsync` /
  // `safeParseAsync` as its throw paths, and capturing a stub there would loop
  // back into itself. An untouched schema holds NOTHING here: Zod keeps the
  // methods on the prototype and only installs a bound own copy on first read,
  // so `undefined` is the common entry and means "back to the prototype". A
  // schema that was read before `jit()` — or that the build plugin's `__zcMkv`
  // already materialized — carries the copies, and those go back verbatim.
  const original = new Map<string, PropertyDescriptor | undefined>();
  try {
    for (const slot of SLOTS) {
      original.set(slot, Object.getOwnPropertyDescriptor(target, slot));
    }
  } catch {
    // The target answers a descriptor query with a throw — an exotic wrapper,
    // not anything Zod built. Without a snapshot there is nothing to roll back
    // to, so install nothing and hand back the schema exactly as it came.
    return schema as T & CompiledSchema<output<T>>;
  }

  // Installing the accessors is the step most likely to throw rather than
  // degrade: a slot locked non-configurable (a future Zod, another wrapper) makes
  // defineProperty raise, and `jit()` is called at module scope — so an
  // unhandled throw here takes down the importing app at boot. Roll back to
  // whatever Zod had and leave the schema alone instead.
  let pending = true;
  try {
    installAccessors(
      target,
      original,
      () => {
        if (!pending) return;
        pending = false;
        restore(target, original);
        materialize(schema, options);
      },
      () => {
        if (!pending) return;
        pending = false;
        // Restore EVERY slot, not just the one being written. A left-behind
        // accessor whose trigger has been cancelled would read `target[slot]`
        // and re-enter itself — unbounded recursion, which is what a later read
        // of an untouched slot (`~standard`, from a Standard Schema consumer)
        // would otherwise hit.
        //
        // Reached only when something WRITES a slot before anything reads one: a
        // test double, another wrapper, or an AOT `safeParse` assigned directly.
        // The build plugin's own `__zcMkv` does not land here — its first
        // statement READS `parseAsync`/`safeParseAsync` to capture their
        // originals, so it triggers materialization and then overwrites the
        // compiled-by-jit methods with the compiled-by-plugin ones.
        restore(target, original);
      },
    );
  } catch {
    pending = false;
    restore(target, original);
  }

  return schema as T & CompiledSchema<output<T>>;
}

/**
 * Front every installed method with a compile-on-read accessor. `trigger`
 * materializes the schema, which normally replaces these accessors with the
 * compiled methods (or restores what Zod had). When that replacement does not
 * take, the getter serves Zod's own method rather than re-reading the slot —
 * see the re-entrancy note in the body.
 */
function installAccessors(
  target: Record<string, unknown>,
  original: ReadonlyMap<string, PropertyDescriptor | undefined>,
  trigger: () => void,
  cancel: () => void,
): void {
  for (const slot of SLOTS) {
    // Re-entrancy is settled structurally rather than by inspection. Reading the
    // slot again is how this getter normally hands over — to the compiled method
    // materialize() installed, or to whatever restore() put back — but the
    // handover can fail to take: a target frozen after `jit()` refuses both, and
    // a second copy of this module in the graph leaves ITS accessor on the slot,
    // so the two bounce reads between them. `trigger()` is spent by then, so
    // either way the read recurses until the stack blows. While a read is already
    // in flight, or once the accessor is known to be stranded, serve Zod's own
    // method instead: a schema that cannot be compiled still parses.
    let reading = false;
    // A stranded accessor is permanent, so what it serves is resolved once.
    let stranded: { value: unknown } | undefined;
    const serveZod = (): unknown => {
      stranded ??= { value: fromZod(target, original, slot) };
      return stranded.value;
    };
    const read = function (): unknown {
      if (reading) return serveZod();
      reading = true;
      try {
        trigger();
        if (stillFrontedBy(target, slot, read)) return serveZod();
        return target[slot];
      } finally {
        reading = false;
      }
    };
    Object.defineProperty(target, slot, {
      configurable: true,
      // Keep the schema's own-key set as it was. A slot Zod already materialized
      // is an enumerable own copy, so the accessor fronting it is enumerable too;
      // an untouched slot has no own key at all, and `is` never exists on a Zod
      // schema, so those stay out of `Object.keys` — the non-enumerable
      // convention `compile()` already uses.
      enumerable: original.get(slot)?.enumerable ?? false,
      get: read,
      set(value: unknown) {
        // Someone overwrote a method before first use (a test double, another
        // wrapper). Their value wins, and compilation is cancelled outright —
        // materializing later would restore the snapshot over it. With the
        // accessor gone the write does what it would have without `jit()`:
        // overwrite the own copy, or run Zod's prototype setter, which installs
        // one. Only a target that refused the rollback still routes here, and a
        // direct define is the one way left to honour the write.
        cancel();
        if (!stillFrontedBy(target, slot, read)) {
          target[slot] = value;
          return;
        }
        Object.defineProperty(target, slot, {
          configurable: true,
          enumerable: original.get(slot)?.enumerable ?? false,
          value,
          writable: true,
        });
      },
    });
  }
}

/**
 * Is `slot` still fronted by this very accessor — i.e. did the replacement that
 * `trigger()` was supposed to perform not take? A target that will not answer
 * the question is assumed to still hold it, since reading the slot to find out
 * is the recursion being avoided.
 */
function stillFrontedBy(
  target: Record<string, unknown>,
  slot: string,
  getter: () => unknown,
): boolean {
  try {
    return Object.getOwnPropertyDescriptor(target, slot)?.get === getter;
  } catch {
    return true;
  }
}

/**
 * Zod's own value for `slot`, bypassing the accessor that fronts it.
 *
 * A slot the snapshot holds is answered from the snapshot. One it does not hold
 * lives on the prototype, where Zod's getter binds the method to its receiver
 * and installs the bound copy as an own property — on a target that accepts
 * the install, that also replaces the stranded accessor with the copy, which is
 * the handover materialize() could not make. A target that refuses the install
 * (frozen, or a wrapper that vetoes `defineProperty`) makes Zod's getter throw
 * instead; there the read goes through a stand-in that inherits from the target,
 * so the copy lands on the stand-in and the method reaches `_zod` through the
 * chain. `undefined` for `is`, which no plain Zod schema carries — the same
 * thing every other degradation path leaves there.
 */
function fromZod(
  target: Record<string, unknown>,
  original: ReadonlyMap<string, PropertyDescriptor | undefined>,
  slot: string,
): unknown {
  const descriptor = original.get(slot);
  if (descriptor !== undefined) {
    // A snapshot can hold another accessor (a second copy of this module
    // installed first), so invoke it rather than reading a `value` it lacks.
    return descriptor.get === undefined ? descriptor.value : descriptor.get.call(target);
  }
  const proto = Object.getPrototypeOf(target) as object | null;
  if (proto === null) return undefined;
  try {
    return Reflect.get(proto, slot, target);
  } catch {
    return Reflect.get(proto, slot, Object.create(target));
  }
}

/**
 * Compile every Zod schema found among an object's own values — typically a
 * module namespace, so a whole schema file opts in with one call:
 *
 * ```ts
 * import * as schemas from "./schemas.js";
 * jitAll(schemas);
 * ```
 *
 * The namespace object itself is never written to (a module namespace is
 * read-only); `jit()` mutates the schema objects it holds, which is what every
 * importer of that module already references.
 */
export function jitAll(schemas: object, options?: JitOptions): void {
  for (const value of Object.values(schemas)) {
    if (isZodSchema(value)) jit(value, options);
  }
}

/**
 * Put back what the snapshot holds, dropping the compile-on-read accessors: the
 * own copy Zod (or the build plugin) had installed, or nothing at all, so the
 * slot reads through to Zod's prototype getter again.
 */
function restore(
  target: Record<string, unknown>,
  original: ReadonlyMap<string, PropertyDescriptor | undefined>,
): void {
  for (const slot of SLOTS) {
    // Per slot, because this also runs as the rollback for a failed install: a
    // target that refuses one slot must not cost the others their restoration.
    // A slot left fronted by its accessor still reads correctly — the getter
    // serves Zod's own method — but it keeps a redundant indirection, so
    // restoring what can be restored is worth the try/catch.
    try {
      const descriptor = original.get(slot);
      if (descriptor === undefined) delete target[slot];
      else Object.defineProperty(target, slot, descriptor);
    } catch {
      // Nothing further to try for this slot.
    }
  }
}

/**
 * Whether runtime code generation is permitted here. Read per call, never
 * snapshotted: `z.config({ jitless: true })` runs in an entry point, after the
 * schema modules it imports have already been evaluated.
 */
function codegenAllowed(): boolean {
  return zodCore.globalConfig.jitless !== true && zodCore.util.allowsEval.value;
}

/**
 * Run the pipeline and let the generated IIFE install its methods on `schema`.
 * Swallows failure: a schema that cannot be compiled keeps Zod's own methods,
 * which the caller already has, so there is nothing to report and nothing to
 * break.
 */
function materialize(schema: unknown, options?: JitOptions): void {
  if (!codegenAllowed()) return;
  try {
    buildValidator(schema, options);
  } catch (error) {
    // Left as plain Zod. Deliberately silent: `jit()` is an optimization, and a
    // schema using a construct the compiler declines is a supported outcome,
    // not an error. The one exception is the zod version guard — a mismatched
    // zod is a configuration problem the user has to hear about. `jit()` itself
    // refuses such a schema before installing anything; this covers a caller
    // that reached the pipeline another way.
    if (isUnsupportedZodVersionError(error)) warnUnsupportedZodOnce(error.message);
  }
}

/**
 * Generate the validator and evaluate it, reproducing the module a
 * `.compiled.ts` would have been: helper preamble, the file-level shared block,
 * then the `__zcMkv` IIFE whose `__rf[]` bases and install target are the live
 * schema object passed in as `__schema`.
 */
function buildValidator(schema: unknown, options?: JitOptions): void {
  const { schemas, shared } = compileSchemas([{ exportName: "jit", schema }], {
    compact: options?.output === "compact",
    mode: "inline",
  });
  const compiled = schemas[0];
  if (compiled === undefined) throw new Error("zod-compiler: schema produced no validator");

  const body = [RUNTIME_PRELUDE, shared.code, `return ${generateIIFE("__schema", compiled)};`].join(
    "\n",
  );

  // The three bindings ZOD_CONFIG_IMPORT would have imported, passed in so the
  // evaluated code needs no module resolution of its own.
  // oxlint-disable-next-line no-new-func -- generating the validator IS the feature
  const factory = new Function(
    "__zodCompilerConfig",
    "__zcCore",
    "__zcZodError",
    "__schema",
    body,
  ) as (
    zodConfigFn: typeof zodConfig,
    zodCoreNs: typeof zodCore,
    zodErrorCtor: typeof ZodRealError,
    target: unknown,
  ) => unknown;

  factory(zodConfig, zodCore, ZodRealError, schema);
}
