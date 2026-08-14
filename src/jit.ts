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
  seen.add(target);

  if (options?.eager === true) {
    materialize(schema);
    return schema as T & CompiledSchema<output<T>>;
  }

  // Snapshot Zod's own descriptors first: materialize() restores them before
  // handing the object to `__zcMkv`, so the generated code sees a pristine
  // schema — it captures the original `parseAsync` / `safeParseAsync` as its
  // throw paths, and capturing a stub there would loop back into itself.
  const original = new Map<string, PropertyDescriptor | undefined>();
  for (const slot of SLOTS) {
    original.set(slot, Object.getOwnPropertyDescriptor(target, slot));
  }

  // Installing the accessors is the one step that can throw rather than degrade:
  // a slot locked non-configurable (a future Zod, another wrapper) makes
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
        materialize(schema);
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
 * materializes the schema, which replaces these accessors with the compiled
 * methods (or restores Zod's own), so the read that follows never re-enters.
 */
function installAccessors(
  target: Record<string, unknown>,
  original: ReadonlyMap<string, PropertyDescriptor | undefined>,
  trigger: () => void,
  cancel: () => void,
): void {
  for (const slot of SLOTS) {
    Object.defineProperty(target, slot, {
      configurable: true,
      // Preserve Zod's own visibility: parse/safeParse/... are enumerable own
      // properties, `~standard` is not. `is` does not exist on a Zod schema, so
      // it follows the non-enumerable convention `compile()` already uses.
      enumerable: original.get(slot)?.enumerable ?? false,
      get() {
        trigger();
        // Whatever now occupies the slot: the compiled method, or — if
        // compilation was impossible — Zod's own, put back by restore().
        return target[slot];
      },
      set(value: unknown) {
        // Someone overwrote a method before first use (a test double, another
        // wrapper). Their value wins, and compilation is cancelled outright —
        // materializing later would restore Zod's descriptors over it.
        cancel();
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

/** Put Zod's own descriptors back, dropping the compile-on-read accessors. */
function restore(
  target: Record<string, unknown>,
  original: ReadonlyMap<string, PropertyDescriptor | undefined>,
): void {
  for (const slot of SLOTS) {
    const descriptor = original.get(slot);
    if (descriptor === undefined) delete target[slot];
    else Object.defineProperty(target, slot, descriptor);
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
function materialize(schema: unknown): void {
  if (!codegenAllowed()) return;
  try {
    buildValidator(schema);
  } catch {
    // Left as plain Zod. Deliberately silent: `jit()` is an optimization, and a
    // schema using a construct the compiler declines is a supported outcome,
    // not an error.
  }
}

/**
 * Generate the validator and evaluate it, reproducing the module a
 * `.compiled.ts` would have been: helper preamble, the file-level shared block,
 * then the `__zcMkv` IIFE whose `__rf[]` bases and install target are the live
 * schema object passed in as `__schema`.
 */
function buildValidator(schema: unknown): void {
  const { schemas, shared } = compileSchemas([{ exportName: "jit", schema }], { mode: "inline" });
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
