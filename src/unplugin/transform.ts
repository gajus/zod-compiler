import remapping from "@jridgewell/remapping";
import { parseExpressionAt } from "acorn";
import MagicString from "magic-string";
import picomatch from "picomatch";
import type { CodegenMode } from "../core/codegen/context.js";
import { SHARED_BLOCK_MARKER } from "../core/codegen/dedupe.js";
import {
  isUnsupportedZodVersionError,
  warnUnsupportedZodOnce,
} from "../core/extract/zod-version.js";
import {
  IDENTIFIER,
  IDENTIFIER_PART,
  isIdentifierName,
  wholeIdentifier,
} from "../core/identifier.js";
import {
  FAIL_CLASS_DECL,
  FAIL_CORE_CLASS_DECL,
  FAILZ_CLASS_DECL,
  FIN_CORE_DECL,
  FIN_DECL,
  FIN_DEFERRED_CORE_DECL,
  FIN_DEFERRED_DECL,
  FINZ_DECL,
  generateIIFE,
  iifeDerefsSchema,
  iifeHelperNames,
  MK_VALIDATOR_DECL,
  usesCoreErrors,
  ZOD_CONFIG_IMPORT,
  ZOD_MSG_DECLARATION,
} from "../core/iife.js";
import { aggregateUsedHelpers, type CompiledSchemaInfo, compileSchemas } from "../core/pipeline.js";
import type { DiscoveredSchema } from "../core/types.js";
import { discoverSchemas } from "../discovery.js";
import { ProcessExitDuringLoadError } from "../loader.js";
import { mayExportSchemas } from "../static-filter.js";
import { applyEdits, type Edit, EditIndex, type Insertion, moduleHeadOffset } from "./edits.js";
import {
  analyzeZodSchemas,
  codeOnly,
  type ModuleScopeSchema,
  type SchemaAnalysis,
} from "./hoist.js";
import { compileHoistedSchemas } from "./hoist-compile.js";
import type { TransformOptions, ZodCompilerPluginOptions } from "./types.js";
import { VIRTUAL_RUNTIME_ID } from "./virtual.js";

/** JSON shape of the composed sourcemap returned alongside transformed code. */
export interface TransformSourceMap {
  version: number;
  sources: (string | null)[];
  sourcesContent?: (string | null)[];
  names: string[];
  mappings: string;
  file?: string | null;
}

/**
 * The transform pipeline as a chain of edit batches. Each batch is applied
 * to the CURRENT text through a MagicString (one stage map per batch); the
 * final original→output map is the remapping-composed chain. Deriving the
 * output string and the map from the same edit list makes divergence
 * impossible.
 */
class StagedTransform {
  current: string;
  private readonly source: string;
  private readonly maps: unknown[] = [];
  /** What each {@link apply} did, in order, for {@link locate}. */
  private readonly applied: {
    edits: readonly Edit[];
    insert: Insertion | undefined;
    /** `edits` in position order, built by the first {@link locate}. */
    byPosition?: EditIndex;
  }[] = [];

  constructor(original: string, source: string) {
    this.current = original;
    this.source = source;
  }

  apply(edits: readonly Edit[], insert?: Insertion): void {
    this.applied.push({ edits, insert });
    this.stage(edits, (s) => {
      if (insert === undefined) return false;
      s.appendLeft(insert.offset, insert.text);
      return true;
    });
  }

  /**
   * Where an offset into the ORIGINAL text now sits in `current`, or -1 for
   * one that an edit has replaced.
   *
   * The source is analysed once, before anything is applied, and some of what
   * that analysis finds can only be acted on in the last stage — by which time
   * the stages before it have moved everything. Carrying the offset through
   * their edits is exact, where searching `current` for the text again is not:
   * the same schema may have been hoisted to the module head by then.
   */
  locate(offset: number): number {
    let at = offset;
    for (const stage of this.applied) {
      const index = (stage.byPosition ??= new EditIndex(stage.edits));
      // The edits wholly before `at`, and the one after them, which is the
      // only one that can contain it. Looked up rather than walked: this runs
      // once per module-scope schema, against every edit of every stage.
      const before = index.endingBy(at);
      if (index.startsBy(before, at)) return -1;
      const { insert } = stage;
      at +=
        (insert !== undefined && insert.offset <= at ? insert.text.length : 0) +
        index.added(before);
    }
    return at;
  }

  /**
   * Apply `edits`, then prepend `deferred`'s text to the module head — both
   * inside ONE stage.
   *
   * The head injection (runtime import + shared dedup block) has to be decided
   * from the REWRITTEN source, because `computeRuntimePrefix` probes it for
   * already-present markers. Staging it separately made a whole second
   * `generateMap` over the full generated output — for what is only a prepend at
   * the module head — and then forced `remapping` to compose the two. Together
   * those were the dominant cost of a transform: on a 320-schema project they ran
   * to 64% of total wall time, more than discovery and codegen combined. Deferring
   * the insertion into the same MagicString buys byte-identical output and an
   * equivalent map for one generation and no composition — 1.6x (small schemas)
   * to 3.4x (large ones) on the transform, scaling with how much code a file
   * emits, since that is what both costs are proportional to.
   *
   * `deferred` returns TEXT, not an `Insertion`: `appendLeft` resolves offsets
   * against the PRE-edit text while `deferred` is shown the POST-edit text, so a
   * callback-supplied offset would be in the wrong coordinate system. Deriving it
   * here from `this.current` keeps the two in step by construction.
   */
  applyThen(edits: readonly Edit[], deferred?: (rewritten: string) => string | undefined): void {
    this.stage(edits, (s, rewritten) => {
      // `?.()` short-circuits its arguments, so a stage with no deferred step
      // never materializes the rewritten text.
      const head = deferred?.(rewritten());
      if (head === undefined) return false;
      s.appendLeft(moduleHeadOffset(this.current), head);
      return true;
    });
  }

  /**
   * One stage: apply `edits` to a fresh MagicString, let `inject` add at most
   * one insertion, then commit the text and its map. `inject` reports whether
   * it inserted, so a no-op stage can be skipped entirely.
   *
   * `rewritten` is a thunk, not a string: materializing it costs a full
   * `toString()` over generated-code-sized input, and the injectors that do not
   * read it (every `apply()` call) must not pay for it.
   */
  private stage(
    edits: readonly Edit[],
    inject: (s: MagicString, rewritten: () => string) => boolean,
  ): void {
    const s = new MagicString(this.current);
    for (const e of edits) {
      if (e.start === e.end) {
        s.appendLeft(e.start, e.text);
      } else {
        s.overwrite(e.start, e.end, e.text);
      }
    }
    // `toString()` is the only way to show the deferred step what the rewrite
    // produced; it measured well under 1% of a transform.
    const inserted = inject(s, () => (edits.length === 0 ? this.current : s.toString()));
    if (edits.length === 0 && !inserted) return;
    this.current = s.toString();
    // `hires: "boundary"` is load-bearing, not a tuning knob: without it every
    // mapping collapses to column 0, so a stack frame or debugger breakpoint in
    // untouched user code below a compiled schema lands at the start of its line
    // instead of the right column (tests/unplugin/sourcemap.test.ts pins it). It
    // is also the most expensive thing here, which is why the stage COUNT is
    // what to economize on.
    this.maps.push(s.generateMap({ source: this.source, hires: "boundary", includeContent: true }));
  }

  /** Composed original→current map, or null when nothing was applied. */
  map(): TransformSourceMap | null {
    if (this.maps.length === 0) return null;
    // A single stage needs no composition: `remapping` over a one-map chain
    // reproduces that map, and it is expensive on generated-code-sized input.
    const [only] = this.maps;
    if (this.maps.length === 1) return only as TransformSourceMap;
    const chain = [...this.maps].reverse();
    return remapping(
      chain as Parameters<typeof remapping>[0],
      () => null,
    ) as unknown as TransformSourceMap;
  }
}

/**
 * Matches a runtime (non-type-only) import from "zod".
 *
 * One of the three triggers ZOD_MENTION (the transform hook's `code` filter)
 * must remain a superset of — widening this to a specifier that does not
 * contain "zod" silently strips those files from every bundler with native
 * hook filters. `describe("code filter soundness")` fails if it drifts.
 */
export const HAS_RUNTIME_ZOD_IMPORT =
  /import\s+(?!type\s)[^;]*from\s+["']zod(?:\/v\d+)?(?:[/-]mini)?["']/;

/**
 * Opt-in phase timing (ZOD_COMPILER_TIMING=1): accumulates per-phase wall time
 * across all transform calls and prints a summary on process exit. Used to
 * attribute plugin overhead in real builds/test runs.
 */
const TIMING = process.env["ZOD_COMPILER_TIMING"] === "1";

/** A single file's discovery exceeding this is worth an actionable warning. */
const SLOW_DISCOVERY_WARN_MS = 5_000;
const phaseTotals = new Map<string, { ms: number; calls: number }>();
let timingHookInstalled = false;

/** Dedupes the process.exit-during-discovery warning to one per process. */
let warnedProcessExit = false;

function timePhase<T>(phase: string, fn: () => T): T {
  if (!TIMING) return fn();
  const t0 = performance.now();
  const done = (): void => {
    const dt = performance.now() - t0;
    const agg = phaseTotals.get(phase) ?? { ms: 0, calls: 0 };
    agg.ms += dt;
    agg.calls++;
    phaseTotals.set(phase, agg);
  };
  if (!timingHookInstalled) {
    timingHookInstalled = true;
    process.on("exit", () => {
      const rows = [...phaseTotals.entries()].sort((a, b) => b[1].ms - a[1].ms);
      for (const [name, { ms, calls }] of rows) {
        log(`timing ${name}: ${ms.toFixed(1)}ms over ${calls} call(s)`);
      }
    });
  }
  const r = fn();
  if (r instanceof Promise) {
    return r.finally(done) as T;
  }
  done();
  return r;
}

/**
 * Check if a file should be transformed by the plugin.
 */
export function shouldTransform(id: string, options?: ZodCompilerPluginOptions): boolean {
  if (!/\.[cm]?[jt]sx?$/.test(id)) return false;
  if (id.includes("node_modules")) return false;
  if (id.endsWith(".d.ts")) return false;
  if (id.endsWith(".compiled.ts") || id.endsWith(".compiled.js")) return false;

  if (options?.exclude?.some((pattern) => picomatch.isMatch(id, pattern, { contains: true })))
    return false;
  if (
    options?.include &&
    !options.include.some((pattern) => picomatch.isMatch(id, pattern, { contains: true }))
  )
    return false;

  return true;
}

/**
 * `id` half of the transform hook filter: the option-independent checks of
 * shouldTransform(), restated as patterns the bundler can evaluate itself.
 * Rolldown, Vite and Rollup 4.40+ apply hook filters natively, so a rejected
 * module never crosses into JS; unplugin applies the same patterns in JS for
 * the rest (webpack/rspack skip installing the transform loader entirely).
 *
 * The `include`/`exclude` options stay out of the filter on purpose: they are
 * matched with picomatch's `contains: true` semantics, which the native glob
 * support (patterns resolved against cwd, matched whole) would silently
 * narrow — shouldTransform() keeps applying them inside the handler.
 */
export const TRANSFORM_ID_FILTER: { exclude: RegExp[]; include: RegExp[] } = {
  exclude: [/node_modules/, /\.d\.ts$/, /\.compiled\.[jt]s$/],
  include: [/\.[cm]?[jt]sx?$/],
};

/**
 * Every transform path that can change a file needs the substring "zod" (or
 * "Zod") somewhere in the source. There are exactly three triggers, and each
 * one is pinned by `describe("code filter soundness")` in the transform tests:
 *
 * 1. auto-discovery — HAS_RUNTIME_ZOD_IMPORT (above), which only matches
 *    specifiers spelled "zod…";
 * 2. `schemas: "explicit"` — an import from "zod-compiler" (the package name);
 * 3. hoisting — a root imported from ZOD_MODULES or an identifier matching
 *    SCHEMA_NAME_PATTERN (both in hoist.ts; a *custom* pattern drops this
 *    filter entirely, see transformCodeFilter). Compiling a module-scope
 *    schema in place rides on the same scan and is narrower still: only a
 *    chain rooted at a ZOD_MODULES binding is ever compiled that way.
 *
 * Adding a fourth trigger that can fire without a "zod" mention MUST widen
 * this pattern, or those files are silently skipped on every bundler with
 * native hook filters — no error, schemas just quietly stay uncompiled.
 *
 * Spelled as a character class rather than an `i` flag: native filters
 * recompile these patterns outside JS, where flag support is narrower.
 */
const ZOD_MENTION = /[Zz]od/;

/**
 * `code` half of the transform hook filter, or undefined when no sound filter
 * exists. A custom `hoist.schemaNamePattern` promotes arbitrary imported
 * identifiers to schema roots (`UserModel`), so nothing in such a file is
 * guaranteed to mention zod — those setups keep the unfiltered behavior.
 */
export function transformCodeFilter(options?: ZodCompilerPluginOptions): RegExp | undefined {
  const namePattern = typeof options?.hoist === "object" ? options.hoist.schemaNamePattern : null;
  // `null` disables name matching and `undefined` keeps the default
  // /ZodSchema$/ — both leave a "zod" mention as the only way in.
  return namePattern === null || namePattern === undefined ? ZOD_MENTION : undefined;
}

export function log(msg: string): void {
  // oxlint-disable-next-line no-console -- build output
  console.log(`[zod-compiler] ${msg}`);
}

export function warn(msg: string): void {
  // oxlint-disable-next-line no-console -- build output
  console.warn(`[zod-compiler] ${msg}`);
}

export interface TransformOutput {
  code: string;
  map: TransformSourceMap | null;
}

/**
 * Transform source code by replacing compile() calls with optimized validators.
 * Returns the transformed code or null if no transformation was needed.
 * Compatibility wrapper over transformCodeWithMap() — discards the map.
 */
export async function transformCode(
  code: string,
  id: string,
  options: TransformOptions,
): Promise<string | null> {
  const result = await transformCodeWithMap(code, id, options);
  return result === null ? null : result.code;
}

/**
 * transformCode + a composed sourcemap (original → output). Stack traces in
 * transformed files shift by prepended declarations and expanded IIFEs
 * without it — a vitest assertion can be reported dozens of lines off.
 */
export async function transformCodeWithMap(
  code: string,
  id: string,
  options: TransformOptions,
): Promise<TransformOutput | null> {
  const verbose = options.verbose === true;
  const autoDiscover = options.autoDiscover === true;
  const mode = options.mode;
  const staged = new StagedTransform(code, id);

  // Hoist Zod schema construction out of function bodies to module scope
  // (babel-plugin-zod-hoist equivalent). Mode-independent: inline schemas
  // live exactly in the files that export none. analyzeZodSchemas() bails
  // in microseconds when no eligible imports exist.
  //
  // The same scan reports the schemas built AT module scope that export
  // discovery will never see (see analyzeZodSchemas), to be compiled where
  // they stand further down. That follows `schemas: "auto"` and not `hoist`:
  // nothing is moved, and it is what "auto" already means for the hoisted
  // ones — a schema with no exported name to opt in with gets compiled anyway.
  let hoistedSchemas: SchemaAnalysis["hoist"] = null;
  let moduleScope: ModuleScopeSchema[] = [];
  if ((options.hoist !== false || autoDiscover) && code.includes("import")) {
    const analysis = timePhase("hoist", () =>
      analyzeZodSchemas(code, {
        ...(typeof options.hoist === "object" ? options.hoist : undefined),
        hoist: options.hoist !== false,
        moduleScope: autoDiscover,
        onScan: options.onSubstantialWork,
      }),
    );
    hoistedSchemas = analysis.hoist;
    moduleScope = analysis.moduleScope;
    if (hoistedSchemas !== null) {
      staged.apply(hoistedSchemas.edits, hoistedSchemas.insert);
      if (verbose) {
        log(`Hoisted inline Zod schemas in ${id}`);
      }
    }
  }

  // Compile the hoisted schemas (autoDiscover only — compiling anonymous
  // schemas is auto-discovery of unexported module-scope schemas). Each
  // hoisted `const _zh_x = z.object({...});` whose construction is
  // deterministic (eager refs are zod bindings only) is evaluated at build
  // time and its initializer replaced with the compiled validator IIFE;
  // anything ineligible stays a plain hoist.
  const hoistHelpers = new Set<string>();
  let hoistCompiledCount = 0;
  if (autoDiscover && hoistedSchemas !== null && hoistedSchemas.schemas.length > 0) {
    const hoistCompiled = await timePhase("hoist-compile", () =>
      compileHoistedSchemas(hoistedSchemas.schemas, code, id, mode, {
        zodRun: options.zodCompat !== false,
      }),
    );
    const spliceEdits: Edit[] = [];
    // The declarations sit at the module head in the order they were compiled
    // in, so each is looked for after the last. Searching from the top for
    // every one was quadratic in the number of them.
    let after = 0;
    for (const h of hoistCompiled) {
      const decl = `const ${h.name} = ${h.text};`;
      let at = staged.current.indexOf(decl, after);
      if (at === -1) at = staged.current.indexOf(decl);
      if (at === -1) continue;
      after = at + decl.length;
      const iife = generateIIFE(h.text, h.info, { zodCompat: options.zodCompat });
      spliceEdits.push({ start: at, end: at + decl.length, text: `const ${h.name} = ${iife};` });
      hoistCompiledCount++;
      for (const helper of h.info.codegenResult.usedHelpers) {
        hoistHelpers.add(helper);
      }
      for (const helper of iifeHelperNames(h.info, { zodCompat: options.zodCompat })) {
        hoistHelpers.add(helper);
      }
      if (verbose) {
        log(`  ✓ ${h.name} (hoisted schema compiled)`);
      }
    }
    staged.apply(spliceEdits);
    if (hoistCompiledCount > 0) {
      if (!usesCoreErrors(hoistHelpers)) hoistHelpers.add("__zcFin");
    }
  }

  // Compile the module-scope schemas the scan reported, through the same
  // build-time evaluation and the same determinism gate as the hoisted ones
  // (see hoist-compile.ts): an expression that reaches for anything but zod
  // stays exactly as written. Nothing is spliced yet. Whether a private
  // binding still wants a validator of its own depends on what discovery goes
  // on to compile, so the edits are settled in the last stage.
  const inPlace: { schema: ModuleScopeSchema; info: CompiledSchemaInfo | null }[] = [];
  if (moduleScope.length > 0) {
    const distinct = new Map<string, { name: string; text: string }>();
    for (const { label, text } of moduleScope) {
      distinct.set(`${label}\0${text}`, { name: label, text });
    }
    const compiled = await timePhase("hoist-compile", () =>
      compileHoistedSchemas([...distinct.values()], code, id, mode, {
        compact: options.compact,
        zodRun: options.zodCompat !== false,
      }),
    );
    const infos = new Map(compiled.map((c) => [`${c.name}\0${c.text}`, c.info]));
    for (const schema of moduleScope) {
      // `output: "bag"` leaves a bag of methods where the schema was. An
      // argument is handed to whatever it was an argument of either way, as a
      // hoisted one is; a binding is the file's own, and is only replaced when
      // the file does nothing with it that a bag cannot do.
      const bagged = options.zodCompat === false && schema.name !== undefined;
      const info =
        bagged && schema.contained !== true
          ? undefined
          : infos.get(`${schema.label}\0${schema.text}`);
      inPlace.push({ schema, info: info ?? null });
    }
  }

  /** Module-scope schemas that were this pass's to compile, and those it did. */
  let inPlaceFound = 0;
  let inPlaceCount = 0;

  /**
   * The in-place edits that stand, given the declarations discovery rewrote
   * (`rewritten`, by exported name; `spans`, by extent in `staged.current`).
   *
   * A schema gets ONE validator. `const X = …; export { X }` and
   * `export default { X }` are discovered under the binding's own name and
   * compiled at its declaration — the very extent an in-place edit would
   * take. `export const Alias = X` and `export const v = compile(X)` are
   * discovered under another, and their validator is installed on the object
   * X holds. And an argument inside a declaration that was rewritten
   * (`export const S = lib.same(z.object(…))`, where the call hands its
   * argument back) is that export, or a part of it.
   */
  const settleInPlace = (rewritten: ReadonlySet<string>, spans: readonly Edit[]): Edit[] => {
    const edits: Edit[] = [];
    const rewrites = new EditIndex(spans);
    let taken = 0;
    for (const { schema, info } of inPlace) {
      const start = staged.locate(schema.start);
      const end = start + schema.text.length;
      // The scan's offsets are trusted no further than this: the text has to
      // be there, and (they come in source order) clear of the one before.
      if (start < taken || staged.current.slice(start, end) !== schema.text) continue;
      if (
        schema.within?.some((name) => rewritten.has(name)) === true ||
        rewrites.overlaps(start, end)
      ) {
        continue;
      }
      inPlaceFound++;
      if (info === null) continue;
      taken = end;
      edits.push({
        start,
        end,
        text: generateIIFE(schema.text, info, { zodCompat: options.zodCompat }),
      });
      inPlaceCount++;
      for (const helper of info.codegenResult.usedHelpers) {
        hoistHelpers.add(helper);
      }
      for (const helper of iifeHelperNames(info, { zodCompat: options.zodCompat })) {
        hoistHelpers.add(helper);
      }
      if (verbose) {
        log(`  ✓ ${schema.label} (module-scope schema compiled in place)`);
      }
    }
    if (inPlaceCount > 0) {
      if (!usesCoreErrors(hoistHelpers)) hoistHelpers.add("__zcFin");
    }
    return edits;
  };

  // When only hoisting and in-place compilation changed the file, that is
  // still a transform result — with runtime helpers injected if anything
  // compiled.
  const finishHoistOnly = (): TransformOutput | null => {
    const edits = settleInPlace(new Set(), []);
    if (staged.current === code && edits.length === 0) return null;
    if (hoistCompiledCount + inPlaceCount > 0) {
      options.onBuildStats?.({
        files: 1,
        schemas: (hoistedSchemas?.schemas.length ?? 0) + inPlaceFound,
        optimized: hoistCompiledCount + inPlaceCount,
        failed: 0,
      });
      // Decided from the rewritten text, in the edits' own stage (see applyThen).
      staged.applyThen(
        edits,
        (text) => computeRuntimePrefix(text, hoistHelpers, mode, options.runtimeId) ?? undefined,
      );
    }
    return { code: staged.current, map: staged.map() };
  };

  // Quick bail-out check. Both gates are also encoded in the transform hook's
  // `code` filter (ZOD_MENTION) so bundlers can skip the hook call entirely —
  // relaxing either one here without widening that pattern makes the bundler
  // drop those files before this code ever runs.
  if (autoDiscover) {
    // autoDiscover: any file with a runtime Zod import is a candidate.
    // Skip `import type` — these files have no runtime schemas.
    if (!HAS_RUNTIME_ZOD_IMPORT.test(staged.current)) return finishHoistOnly();
  } else {
    // Legacy mode: require compile() from zod-compiler. The word-boundary
    // check matters: the package name itself contains the substring
    // "compile", so a plain includes("compile") would match every import of
    // "zod-compiler" — \bcompile\b does not match inside "zod-compiler"
    // (no boundary between "e" and "r") but matches compile( / { compile }.
    if (!staged.current.includes("zod-compiler") || !/\bcompile\b/.test(staged.current))
      return finishHoistOnly();
  }

  // Static pre-filter: skip files whose exports provably cannot be schemas
  // (functions, components, constants, type-only modules) without executing
  // them. Conservative — anything ambiguous stays a candidate. The filter
  // transpiles + parses the file, so its outcome is worth persisting even
  // when the eventual result is null.
  //
  // It reads the file AS WRITTEN, not `staged.current`. The stages above only
  // add unexported `_zh_*` declarations and swap an in-function expression for
  // one of their names, so the exports — all the filter classifies — are the
  // same either way. The text is not: a hoisted schema that compiled has
  // become a whole validator, and transpiling that to reach a verdict already
  // fixed by the original cost 7.1 ms a file against 1.4 ms, a sixth of a cold
  // build on a project where half the zod-importing files build their schemas
  // inside functions.
  options.onSubstantialWork?.();
  if (!(await timePhase("static-filter", () => mayExportSchemas(code, id))))
    return finishHoistOnly();

  // Discover schemas by executing the file. Module executions are cached in
  // the shared loader; watch/HMR changes invalidate via invalidateModuleCache().
  options.onDiscovery?.();
  let schemas: DiscoveredSchema[];
  const discoverStart = performance.now();
  try {
    schemas = await timePhase("discover", () => discoverSchemas(id, { autoDiscover }));
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // A module in the import graph called process.exit() during discovery —
    // typically an env-validation guard in a CI build where secrets are
    // intentionally absent. The loader converts that exit into a catchable
    // error so the build survives; the affected files just fall back to
    // runtime Zod. Handle it in both modes (never crash on a build-time exit)
    // and surface the cooperative remedy once.
    if (e instanceof ProcessExitDuringLoadError) {
      // The result reflects missing secrets, not file content — never persist
      // it to the content-hashed disk cache (a later secret-ful build would be
      // served this stale "nothing compiled" entry).
      options.onUncacheableResult?.();
      if (!warnedProcessExit) {
        warnedProcessExit = true;
        warn(
          `${id} (or a module it imports) called process.exit during build-time schema ` +
            `discovery — those files fall back to runtime Zod instead of crashing the build. ` +
            `This is usually an env-validation guard; wrap it in ` +
            `\`if (!process.env.ZOD_COMPILER) { ... }\` to keep these schemas compiled, or set ` +
            `schemas:"explicit" / use include to scope discovery.`,
        );
      }
      return finishHoistOnly();
    }
    // In autoDiscover mode, files that can't be loaded (JSX components,
    // unresolved path aliases, etc.) are expected — warn and skip.
    if (autoDiscover) {
      if (verbose) {
        warn(`Skipping ${id}: ${msg}`);
      }
      return finishHoistOnly();
    }
    throw new Error(`[zod-compiler] Failed to load schemas from ${id}: ${msg}`);
  }
  const discoverMs = performance.now() - discoverStart;
  if (discoverMs >= SLOW_DISCOVERY_WARN_MS) {
    // Discovery executes the file's whole first-party import graph inside
    // the bundler's single-threaded process — on saturated CI hosts a large
    // graph can stall the event loop long enough to trip test timeouts.
    // Surface the cost with the two effective remedies.
    warn(
      `Discovery of ${id} took ${(discoverMs / 1000).toFixed(1)}s executing its import graph ` +
        `in the bundler process. Persist node_modules/.cache/zod-compiler across CI runs to pay ` +
        `this once, or narrow autoDiscover/include for test runs (see README "Large projects ` +
        `and CI"). ZOD_COMPILER_TIMING=1 prints a per-phase breakdown.`,
    );
  }
  if (schemas.length === 0) return finishHoistOnly();

  // Lean mode (every bundler in VIRTUAL_MODULE_FRAMEWORKS — Vite/Rollup/webpack/rspack/etc.)
  // imports shared helpers from a runtime module for cross-file dedup: virtual:zod-compiler/runtime
  // on virtual-friendly bundlers, the __zod-compiler-runtime__ bare specifier on webpack/rspack.
  // Inline mode (CLI emitter, and any bundler not in VIRTUAL_MODULE_FRAMEWORKS) emits self-contained
  // file-level helpers.
  let failedCount = 0;
  const { schemas: compiled, shared } = timePhase("compile", () =>
    compileSchemas(schemas, {
      mode,
      compact: options.compact,
      zodRun: options.zodCompat !== false,
      onError(exportName, error) {
        failedCount++;
        // An unsupported zod fails every export of every file the same way:
        // one explanation per process says more than a line per export.
        if (isUnsupportedZodVersionError(error)) {
          warnUnsupportedZodOnce(error.message);
          return;
        }
        warn(
          `Failed to compile "${exportName}" in ${id}: ${error.message}. Keeping original${autoDiscover ? "" : " compile()"} call.`,
        );
      },
    }),
  );

  if (verbose) {
    if (autoDiscover) {
      log(
        `Auto-discovering: ${id} (${schemas.length} Zod export${schemas.length > 1 ? "s" : ""} found)`,
      );
    }
    for (const s of compiled) {
      const rfCount = s.refEntries.length;
      const rfSuffix = rfCount > 0 ? ` (${rfCount} ref${rfCount > 1 ? "s" : ""})` : "";
      log(`  ✓ ${s.exportName}${rfSuffix}`);
    }
    if (failedCount > 0) {
      log(`  ✗ ${failedCount} schema(s) failed`);
    }
  }

  if (compiled.length === 0) return finishHoistOnly();

  // Two-pass rewrite: separate compile() schemas from autoDiscover schemas.
  // Both passes collect edits against the same pristine stage input — their
  // target regions are disjoint (compile() assignments vs plain exported
  // declarations of OTHER names), so one batched application is equivalent
  // to the historical sequential rewrites.
  let rewriteEdits: readonly Edit[];
  /** Exports whose declaration was actually rewritten — not all that compiled are. */
  const rewritten = new Set<string>();
  if (autoDiscover) {
    // Detect compile() schemas by checking source code patterns
    const compileExportNames = compileAssignedNames(
      staged.current,
      compiled.map((s) => s.exportName),
    );
    const compileSchemaInfos = compiled.filter((s) => compileExportNames.has(s.exportName));
    const autoDiscoverSchemaInfos = compiled.filter((s) => !compileExportNames.has(s.exportName));

    const edits: Edit[] = [];
    // Pass 1: compile() schemas (includes compile-import removal — only when
    // compile() schemas were actually rewritten, mirroring the historical
    // conditional rewriteSource call)
    if (compileSchemaInfos.length > 0) {
      edits.push(
        ...collectCompileRewriteEdits(
          staged.current,
          compileSchemaInfos,
          { zodCompat: options.zodCompat },
          rewritten,
        ),
      );
    }
    // Pass 2: plain exported schemas
    if (autoDiscoverSchemaInfos.length > 0) {
      edits.push(
        ...collectAutoDiscoverEdits(
          staged.current,
          autoDiscoverSchemaInfos,
          { zodCompat: options.zodCompat },
          rewritten,
        ),
      );
    }
    rewriteEdits = edits;
  } else {
    rewriteEdits = collectCompileRewriteEdits(staged.current, compiled, {
      zodCompat: options.zodCompat,
    });
  }
  // The module-scope schemas discovery did not already account for, compiled
  // in place — in this same stage: their extents and the rewrites' are disjoint.
  const inPlaceEdits = settleInPlace(rewritten, rewriteEdits);

  // Report build stats only when at least one schema was compiled
  // (hoisted and in-place compiles count alongside export schemas).
  options.onBuildStats?.({
    files: 1,
    schemas: schemas.length + (hoistedSchemas?.schemas.length ?? 0) + inPlaceFound,
    optimized: compiled.length + hoistCompiledCount + inPlaceCount,
    failed: failedCount,
  });

  // __zcMkv wraps every IIFE. __zcFin has always been supplied alongside it
  // whether called or not; that default is skipped when the file's validators
  // fail with core errors (zod/mini, via __zcFinC/__zcFinDC), since a validator
  // that does call __zcFin lists it already. Helpers used by compiled hoisted
  // and in-place schemas ride along in the same injection.
  const usedHelpers = aggregateUsedHelpers(compiled);
  for (const schema of compiled) {
    for (const helper of iifeHelperNames(schema, { zodCompat: options.zodCompat })) {
      usedHelpers.add(helper);
    }
  }
  for (const helper of hoistHelpers) {
    usedHelpers.add(helper);
  }
  if (!usesCoreErrors(usedHelpers)) usedHelpers.add("__zcFin");
  // Shared dedup validators ride the same runtime import.
  for (const helper of shared.usedHelpers) {
    usedHelpers.add(helper);
  }

  // Head = runtime helpers/import, then the file-level shared dedup block, then
  // the rewritten source. Shared constants and `__zcSw_N` functions live at
  // module scope so every IIFE closes over them; they must follow the runtime
  // import (lean) and the helper decls (inline) that they reference. Guard against
  // double-injection on watch/HMR re-runs the same way computeRuntimePrefix
  // does — a second copy would redeclare every `__zcSw_N`.
  //
  // Deferred into the rewrite's own stage rather than staged after it: both
  // decisions read the REWRITTEN text, and giving a bare prepend its own stage
  // doubled the sourcemap work and added a composition pass (see applyThen).
  staged.applyThen([...rewriteEdits, ...inPlaceEdits], (text) => {
    const prefix = computeRuntimePrefix(text, usedHelpers, mode, options.runtimeId);
    const needsShared = shared.code !== "" && !text.includes(SHARED_BLOCK_MARKER);
    const head = (prefix ?? "") + (needsShared ? `${shared.code}\n` : "");
    return head === "" ? undefined : head;
  });
  return { code: staged.current, map: staged.map() };
}

/**
 * Prepend the runtime helpers required by the rewritten source.
 *
 * Lean mode emits a single `import { ... } from "<runtimeId>";` line —
 * bundlers whose resolveId hook intercepts the specifier dedup helpers across
 * every transformed file into one shared virtual module.
 *
 * Inline mode prepends file-level `function __zcMkv` / `function __zcFin`
 * declarations directly so the file is self-contained.
 *
 * Idempotent: if the file already contains the relevant marker (re-run during
 * watch/HMR), we skip re-injection.
 */
/** The runtime-helper text to prepend, or null when nothing is needed. */
function computeRuntimePrefix(
  code: string,
  usedHelpers: Set<string>,
  mode: CodegenMode,
  runtimeId: string = VIRTUAL_RUNTIME_ID,
): string | null {
  if (mode === "lean") {
    if (usedHelpers.size === 0) return null;
    // Match the import STATEMENT, not the bare id. `zod-compiler/runtime` is a
    // plain package specifier and a substring of `virtual:zod-compiler/runtime`,
    // so a file merely mentioning either — a comment, a docs snippet — would
    // suppress the import while codegen still emits calls to the helpers.
    if (code.includes(`from "${runtimeId}"`)) return null;
    const names = [...usedHelpers].sort().join(", ");
    return `import { ${names} } from "${runtimeId}";\n`;
  }
  // Inline mode (CLI emitter, and any bundler not in VIRTUAL_MODULE_FRAMEWORKS):
  // ship file-level helper declarations instead of a virtual import.
  // Codegen emits per-IIFE issue literals + per-IIFE `__re_*` decls,
  // so we only need __zcMkv / __zcFin (plus __zcMsg via the zod config import).
  if (!code.includes("__zcMkv")) return null;
  const prefix: string[] = [];
  if (!code.includes("__zodCompilerConfig")) {
    prefix.push(ZOD_CONFIG_IMPORT, ZOD_MSG_DECLARATION);
  }
  if (!code.includes("function __zcMkv(")) {
    prefix.push(MK_VALIDATOR_DECL);
  }
  // Validators of zod/mini schemas fail with core's `$ZodError`, through the
  // __zcFinC/__zcFinDC twins and their own __ZcFailC (see FAIL_CORE_CLASS_DECL).
  const needsFinC = code.includes("__zcFinC(") && !code.includes("function __zcFinC(");
  const needsFinDC = code.includes("__zcFinDC(") && !code.includes("function __zcFinDC(");
  const usesCore = code.includes("__zcFinC(") || code.includes("__zcFinDC(");
  // __zcFin and __zcFinD both construct __ZcFail; declare it once before either,
  // guarding against a header already shipped earlier in the same module.
  // __zcFin is supplied even when nothing calls it, as it always has been —
  // except beside the core twins, where it would be dead code.
  const needsFin = !code.includes("function __zcFin(") && (!usesCore || code.includes("__zcFin("));
  const needsFinD = code.includes("__zcFinD(") && !code.includes("function __zcFinD(");
  if ((needsFin || needsFinD) && !code.includes("function __ZcFail(")) {
    prefix.push(FAIL_CLASS_DECL);
  }
  if (needsFin) {
    prefix.push(FIN_DECL);
  }
  if (needsFinD) {
    prefix.push(FIN_DEFERRED_DECL);
  }
  if ((needsFinC || needsFinDC) && !code.includes("function __ZcFailC(")) {
    prefix.push(FAIL_CORE_CLASS_DECL);
  }
  if (needsFinC) {
    prefix.push(FIN_CORE_DECL);
  }
  if (needsFinDC) {
    prefix.push(FIN_DEFERRED_CORE_DECL);
  }
  // Compact mode (output: "compact") delegates cold errors to zod via __zcFinZ,
  // which constructs its own __ZcFailZ (distinct from __ZcFail).
  const needsFinZ = code.includes("__zcFinZ(") && !code.includes("function __zcFinZ(");
  if (needsFinZ && !code.includes("function __ZcFailZ(")) {
    prefix.push(FAILZ_CLASS_DECL);
  }
  if (needsFinZ) {
    prefix.push(FINZ_DECL);
  }
  return prefix.length > 0 ? `${prefix.join("\n")}\n` : null;
}

/**
 * Find the matching closing parenthesis for a compile() call,
 * handling nested parentheses like compile(z.object({...})).
 * Returns the index of the closing ')' or -1 if not found.
 */
function findMatchingParen(code: string, openIndex: number): number {
  let depth = 1;
  for (let i = openIndex + 1; i < code.length; i++) {
    if (code[i] === "(") depth++;
    else if (code[i] === ")") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * Rewrite source code by replacing compile() calls with IIFE-wrapped optimized validators.
 */
export function rewriteSource(
  code: string,
  schemas: CompiledSchemaInfo[],
  options?: { zodCompat?: boolean | undefined },
): string {
  return applyEdits(code, collectCompileRewriteEdits(code, schemas, options));
}

/**
 * Edits for rewriteSource (compile() call replacements + compile-import
 * removal, once no call is left to read it), collected against pristine
 * `code`. Each schema's declaration is
 * a distinct region and the import statement is distinct from all of them,
 * so the batch is non-overlapping and order-independent.
 */
function collectCompileRewriteEdits(
  code: string,
  schemas: CompiledSchemaInfo[],
  options?: { zodCompat?: boolean | undefined },
  rewritten?: Set<string>,
): Edit[] {
  const edits: Edit[] = [];
  for (const schema of schemas) {
    // A name no binding can have (`export { S as "user-schema" }`) is not
    // assigned anywhere.
    if (!isIdentifierName(schema.exportName)) continue;
    const match = findCompileAssignment(code, schema.exportName);
    if (!match) continue;

    // Find the matching closing paren (handles nested parens)
    const openParenIndex = match.index + match[0].length - 1;
    const closeParenIndex = findMatchingParen(code, openParenIndex);
    if (closeParenIndex === -1) continue;

    const schemaArgName = code
      .slice(openParenIndex + 1, closeParenIndex)
      .trim()
      .replace(/,\s*$/, "");
    const prefix = match[1] ?? "";
    edits.push({
      start: match.index,
      end: closeParenIndex + 1,
      text: prefix + generateIIFE(schemaArgName, schema, options),
    });
    rewritten?.add(schema.exportName);
  }
  // The binding goes with its last use. A call left as written — `const S: T =
  // compile(…)`, whose annotation the pattern does not get past — still reads
  // it, and with the import gone the module threw a ReferenceError as it
  // loaded.
  const removals = collectRemoveCompileImportEdits(code);
  if (!mentionedOutside(codeOnly(code), "compile", [...edits, ...removals])) {
    edits.push(...removals);
  }
  return edits;
}

/** Is `name` written in `code` anywhere but inside one of `edits`? */
function mentionedOutside(code: string, name: string, edits: readonly Edit[]): boolean {
  const covered = [...edits].sort((a, b) => a.start - b.start);
  let next = 0;
  for (const { index } of code.matchAll(new RegExp(wholeIdentifier(name), "gu"))) {
    while (next < covered.length && (covered[next] as Edit).end <= index) next++;
    const edit = covered[next];
    if (edit === undefined || edit.start > index) return true;
  }
  return false;
}

/**
 * The first `<name> = compile<…>(` in `code` that assigns `name` itself, not a
 * longer name it ends (`$User` for `User`). The boundary is checked where a
 * match is found: a lookbehind for an identifier character, at the head of the
 * pattern, slowed the search for its literal name enough to cost a file of
 * 4,000 `compile()` exports a tenth of its transform.
 */
function findCompileAssignment(code: string, name: string): RegExpExecArray | null {
  const pattern = new RegExp(
    `(${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*=\\s*)compile\\s*(?:<[^>]*(?:<[^>]*>[^>]*)?>)?\\s*\\(`,
    "g",
  );
  for (let match = pattern.exec(code); match !== null; match = pattern.exec(code)) {
    if (identifierStartBefore(code, match.index) === match.index) return match;
    pattern.lastIndex = match.index + 1;
  }
  return null;
}

/**
 * Find the end position of a JavaScript expression starting at `start` using acorn.
 * Returns the end offset, or -1 if the expression cannot be parsed.
 */
export function findExpressionEnd(code: string, start: number): number {
  try {
    // Parsed from a slice rather than at an offset into `code`: handed a start
    // position, acorn's constructor counts the lines before it by splitting
    // everything up to there, so a file of declarations parsed one by one was
    // quadratic in its length.
    const node = parseExpressionAt(code.slice(start), 0, {
      ecmaVersion: "latest",
      sourceType: "module",
    });
    return start + node.end;
  } catch {
    return -1;
  }
}

/**
 * Rewrite source code by replacing plain Zod schema exports with IIFE-wrapped optimized validators.
 * Used by autoDiscover mode (no compile() wrappers needed).
 */
export function rewriteSourceAutoDiscover(
  code: string,
  schemas: CompiledSchemaInfo[],
  options?: { zodCompat?: boolean | undefined },
): string {
  return applyEdits(code, collectAutoDiscoverEdits(code, schemas, options));
}

/**
 * Does `expr` mention `name` as an identifier?
 *
 * Deliberately lexical, and deliberately biased toward YES. A false positive
 * costs one export its `@__PURE__` annotation; a false negative emits an IIFE
 * that dereferences a binding still under initialization. The expression text
 * is often TypeScript (`z.custom<T>(...)`), which no JS parser here can be
 * trusted to walk, so a lexical scan for the whole name — which cannot miss a
 * real identifier reference — is the sound direction to be wrong in. (`\b`
 * could: it sees no edge at a `$` or a letter outside ASCII, so `$Node` and
 * `Nodé` were never found in their own getters.)
 */
function mentionsIdentifier(expr: string, name: string): boolean {
  return new RegExp(wholeIdentifier(name), "u").test(expr);
}

/** One character, or one surrogate pair, that an identifier can continue with. */
const IDENTIFIER_CHARACTER = new RegExp(`^${IDENTIFIER_PART}$`, "u");

/** Where the run of identifier characters that ends at `end` begins. */
function identifierStartBefore(code: string, end: number): number {
  let start = end;
  while (start > 0) {
    const last = code.charCodeAt(start - 1);
    const width =
      last >= 0xdc00 &&
      last <= 0xdfff &&
      start > 1 &&
      (code.charCodeAt(start - 2) & 0xfc00) === 0xd800
        ? 2
        : 1;
    if (!IDENTIFIER_CHARACTER.test(code.slice(start - width, start))) break;
    start -= width;
  }
  return start;
}

/**
 * Which of `names` are assigned a `compile(…)` call in `code`: those written,
 * whole, in front of a `= compile(`.
 *
 * The assignments are found once, and the name in front of each is read off.
 * Building a pattern per name and running it over the whole file was
 * quadratic in the schemas a file exports, most of which have no `compile(` to
 * find.
 */
function compileAssignedNames(code: string, names: readonly string[]): Set<string> {
  const assigned = new Set<string>();
  for (const site of code.matchAll(/=\s*compile[\s<(]/g)) {
    let end = site.index;
    while (end > 0 && /\s/.test(code[end - 1] as string)) end--;
    assigned.add(code.slice(identifierStartBefore(code, end), end));
  }
  const found = new Set<string>();
  if (assigned.size === 0) return found;
  for (const name of names) {
    if (assigned.has(name)) found.add(name);
  }
  return found;
}

/**
 * Where the initializer of each of `names` starts in `code`: just past the `=`
 * (and the whitespace after it) of the first `(const|let|var) <name>[: <type>] =`
 * declaring it.
 *
 * One pass over the file for all of them. A pattern per name, each run from the
 * top of the file, made the rewrite quadratic in the schemas a file exports —
 * the shape of a module generated from an OpenAPI document. A declaration
 * keyword is followed by the identifier it binds, which is either one of
 * `names` or not; that is the same first match the per-name pattern found, for
 * every name a declaration can bind.
 */
function findInitializers(code: string, names: ReadonlySet<string>): Map<string, number> {
  const starts = new Map<string, number>();
  const keyword = /(?:const|let|var)\s+/g;
  const binding = new RegExp(IDENTIFIER, "uy");
  const equals = /(?:\s*:[^=]*)?\s*=\s*/y;
  while (starts.size < names.size && keyword.exec(code) !== null) {
    binding.lastIndex = keyword.lastIndex;
    const name = binding.exec(code)?.[0];
    if (name === undefined || !names.has(name) || starts.has(name)) continue;
    equals.lastIndex = binding.lastIndex;
    if (equals.exec(code) !== null) starts.set(name, equals.lastIndex);
  }
  return starts;
}

/**
 * Edits for rewriteSourceAutoDiscover, collected against pristine `code`.
 * `rewritten` receives the name of each export an edit was made for.
 */
function collectAutoDiscoverEdits(
  code: string,
  schemas: CompiledSchemaInfo[],
  options?: { zodCompat?: boolean | undefined },
  rewritten?: Set<string>,
): Edit[] {
  const edits: Edit[] = [];
  // Match: export? (const|let|var) ExportName[: TypeAnnotation] = <expr>
  const initializers = findInitializers(code, new Set(schemas.map((s) => s.exportName)));
  for (const schema of schemas) {
    const rhsStart = initializers.get(schema.exportName);
    if (rhsStart === undefined) continue;
    const rhsEnd = findExpressionEnd(code, rhsStart);
    if (rhsEnd === -1) continue;

    const originalExpr = code.slice(rhsStart, rhsEnd).trim();

    // A RECURSIVE schema defers its self-reference through a callback —
    // `z.lazy(() => z.array(Node))`, or zod v4's getter form
    // `get children() { return z.array(Node) }` — and that callback closes over
    // the module binding declared here. Replacing the initializer puts the
    // IIFE's `var __rf=[__zs._zod.innerType...]` preamble INSIDE that binding's
    // own initializer, so forcing the callback re-enters a binding that is not
    // yet assigned: a TDZ ReferenceError at module init, or — once a bundler
    // lowers the top-level `const` to `var`, as esbuild does — a silent
    // `undefined` that zod's `defineLazy` then CACHES, permanently poisoning
    // the schema for every consumer (`z.array(undefined)`).
    //
    // So the deref moves out of the initializer: the declaration keeps its
    // original expression and the IIFE follows it as a statement, mutating the
    // now-assigned schema in place. `__zcMkv` returns its argument (identity is
    // preserved by design), so the export is the same object either way, and
    // `__rfp_N`'s pristine-`safeParse` capture still happens before the
    // trailing `__zcMkv` installs anything. The cost is this export's
    // `@__PURE__` annotation — a self-referential schema is no longer
    // droppable when unused.
    if (iifeDerefsSchema(schema) && mentionsIdentifier(originalExpr, schema.exportName)) {
      // `output: "bag"` replaces the export with a method bag rather than
      // mutating the schema, so there is nothing to mutate in place — and the
      // user's own recursive reference would resolve to the bag regardless.
      if (options?.zodCompat === false) {
        warn(
          `Skipping self-referential export "${schema.exportName}": output "bag" cannot preserve its recursive reference. Keeping the original schema.`,
        );
        continue;
      }
      // Re-emitting `originalExpr` verbatim is what makes splitting the
      // declaration safe for `const Schema = <expr>, other = 1;`:
      // findExpressionEnd parses an Expression, and the comma operator makes
      // that span the whole declarator list, so the siblings are inside the
      // text being written back rather than after the statement terminator.
      edits.push({
        start: rhsStart,
        end: rhsEnd,
        text: `${originalExpr};\n${generateIIFE(schema.exportName, schema, { ...options, pure: false })};`,
      });
      rewritten?.add(schema.exportName);
      continue;
    }

    edits.push({
      start: rhsStart,
      end: rhsEnd,
      text: generateIIFE(originalExpr, schema, options),
    });
    rewritten?.add(schema.exportName);
  }
  return edits;
}

/**
 * Remove the `compile` binding from `import { compile, ... } from "zod-compiler"` statements.
 * If `compile` is the only import, the entire import line is removed.
 */
export function removeCompileImport(code: string): string {
  return applyEdits(code, collectRemoveCompileImportEdits(code));
}

/** Edits stripping the `compile` binding from zod-compiler import statements. */
function collectRemoveCompileImportEdits(code: string): Edit[] {
  // Match: import { ... } from "zod-compiler" or 'zod-compiler'
  const importPattern = /import\s*\{([^}]*)\}\s*from\s*["']zod-compiler["'];?/g;
  const edits: Edit[] = [];
  for (const match of code.matchAll(importPattern)) {
    const imports = match[1] ?? "";
    const names = imports
      .split(",")
      .map((n) => n.trim())
      .filter(Boolean);
    const remaining = names.filter((n) => n !== "compile");
    const text =
      remaining.length === 0 ? "" : `import { ${remaining.join(", ")} } from "zod-compiler";`;
    if (text !== match[0]) {
      edits.push({ start: match.index, end: match.index + match[0].length, text });
    }
  }
  return edits;
}
