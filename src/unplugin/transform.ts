import remapping from "@jridgewell/remapping";
import { parseExpressionAt } from "acorn";
import MagicString from "magic-string";
import picomatch from "picomatch";
import type { CodegenMode } from "#src/core/codegen/context.js";
import { SHARED_BLOCK_MARKER } from "#src/core/codegen/dedupe.js";
import {
  FAIL_CLASS_DECL,
  FIN_DECL,
  FIN_DEFERRED_DECL,
  generateIIFE,
  MK_VALIDATOR_DECL,
  ZOD_CONFIG_IMPORT,
  ZOD_MSG_DECLARATION,
} from "#src/core/iife.js";
import {
  aggregateUsedHelpers,
  type CompiledSchemaInfo,
  compileSchemas,
} from "#src/core/pipeline.js";
import type { DiscoveredSchema } from "#src/core/types.js";
import { discoverSchemas } from "#src/discovery.js";
import { mayExportSchemas } from "#src/static-filter.js";
import { applyEdits, type Edit, type Insertion } from "./edits.js";
import { hoistZodSchemasMeta } from "./hoist.js";
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

  constructor(original: string, source: string) {
    this.current = original;
    this.source = source;
  }

  apply(edits: readonly Edit[], insert?: Insertion): void {
    if (edits.length === 0 && insert === undefined) return;
    const s = new MagicString(this.current);
    for (const e of edits) {
      if (e.start === e.end) {
        s.appendLeft(e.start, e.text);
      } else {
        s.overwrite(e.start, e.end, e.text);
      }
    }
    if (insert !== undefined) {
      s.appendLeft(insert.offset, insert.text);
    }
    this.current = s.toString();
    this.maps.push(s.generateMap({ source: this.source, hires: "boundary", includeContent: true }));
  }

  /** Composed original→current map, or null when nothing was applied. */
  map(): TransformSourceMap | null {
    if (this.maps.length === 0) return null;
    const chain = [...this.maps].reverse();
    return remapping(
      chain as Parameters<typeof remapping>[0],
      () => null,
    ) as unknown as TransformSourceMap;
  }
}

/** Matches a runtime (non-type-only) import from "zod". */
const HAS_RUNTIME_ZOD_IMPORT = /import\s+(?!type\s)[^;]*from\s+["']zod["']/;

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

export function log(msg: string): void {
  // oxlint-disable-next-line no-console -- build output
  console.log(`[zod-compiler] ${msg}`);
}

function warn(msg: string): void {
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
  // live exactly in the files that export none. hoistZodSchemasMeta() bails
  // in microseconds when no eligible imports exist.
  let hoistedSchemas: ReturnType<typeof hoistZodSchemasMeta> = null;
  if (options.hoist !== false && code.includes("import")) {
    hoistedSchemas = timePhase("hoist", () =>
      hoistZodSchemasMeta(code, {
        ...(typeof options.hoist === "object" ? options.hoist : undefined),
        onScan: options.onSubstantialWork,
      }),
    );
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
      compileHoistedSchemas(hoistedSchemas.schemas, code, id, mode),
    );
    const spliceEdits: Edit[] = [];
    for (const h of hoistCompiled) {
      const decl = `const ${h.name} = ${h.text};`;
      const at = staged.current.indexOf(decl);
      if (at === -1) continue;
      const iife = generateIIFE(h.text, h.info, { zodCompat: options.zodCompat });
      spliceEdits.push({ start: at, end: at + decl.length, text: `const ${h.name} = ${iife};` });
      hoistCompiledCount++;
      for (const helper of h.info.codegenResult.usedHelpers) {
        hoistHelpers.add(helper);
      }
      if (verbose) {
        log(`  ✓ ${h.name} (hoisted schema compiled)`);
      }
    }
    staged.apply(spliceEdits);
    if (hoistCompiledCount > 0) {
      hoistHelpers.add("__zcMkv");
      hoistHelpers.add("__zcFin");
    }
  }

  // When only hoisting (± hoisted-schema compilation) changed the file, that
  // is still a transform result — with runtime helpers injected if any
  // hoisted schema compiled.
  const finishHoistOnly = (): TransformOutput | null => {
    if (staged.current === code) return null;
    if (hoistCompiledCount > 0) {
      options.onBuildStats?.({
        files: 1,
        schemas: hoistedSchemas?.schemas.length ?? 0,
        optimized: hoistCompiledCount,
        failed: 0,
      });
      const prefix = computeRuntimePrefix(staged.current, hoistHelpers, mode, options.runtimeId);
      if (prefix !== null) {
        staged.apply([], { offset: 0, text: prefix });
      }
    }
    return { code: staged.current, map: staged.map() };
  };

  // Quick bail-out check
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
  options.onSubstantialWork?.();
  if (!(await timePhase("static-filter", () => mayExportSchemas(staged.current, id))))
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
      onError(exportName, error) {
        failedCount++;
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

  // Report build stats only when at least one schema was compiled
  // (hoisted-schema compiles count alongside export schemas).
  options.onBuildStats?.({
    files: 1,
    schemas: schemas.length + (hoistedSchemas?.schemas.length ?? 0),
    optimized: compiled.length + hoistCompiledCount,
    failed: failedCount,
  });

  // __zcMkv and __zcFin are always needed (they wrap every IIFE). Helpers used
  // by compiled hoisted schemas ride along in the same injection.
  const usedHelpers = aggregateUsedHelpers(compiled);
  usedHelpers.add("__zcMkv");
  usedHelpers.add("__zcFin");
  for (const helper of hoistHelpers) {
    usedHelpers.add(helper);
  }
  // Shared dedup validators ride the same runtime import.
  for (const helper of shared.usedHelpers) {
    usedHelpers.add(helper);
  }

  // Two-pass rewrite: separate compile() schemas from autoDiscover schemas.
  // Both passes collect edits against the same pristine stage input — their
  // target regions are disjoint (compile() assignments vs plain exported
  // declarations of OTHER names), so one batched application is equivalent
  // to the historical sequential rewrites.
  if (autoDiscover) {
    // Detect compile() schemas by checking source code patterns
    const compileExportNames = new Set<string>();
    for (const s of compiled) {
      const pattern = new RegExp(`\\b${s.exportName}\\s*=\\s*compile[\\s<(]`);
      if (pattern.test(staged.current)) {
        compileExportNames.add(s.exportName);
      }
    }
    const compileSchemaInfos = compiled.filter((s) => compileExportNames.has(s.exportName));
    const autoDiscoverSchemaInfos = compiled.filter((s) => !compileExportNames.has(s.exportName));

    const edits: Edit[] = [];
    // Pass 1: compile() schemas (includes compile-import removal — only when
    // compile() schemas were actually rewritten, mirroring the historical
    // conditional rewriteSource call)
    if (compileSchemaInfos.length > 0) {
      edits.push(
        ...collectCompileRewriteEdits(staged.current, compileSchemaInfos, {
          zodCompat: options.zodCompat,
        }),
      );
    }
    // Pass 2: plain exported schemas
    if (autoDiscoverSchemaInfos.length > 0) {
      edits.push(
        ...collectAutoDiscoverEdits(staged.current, autoDiscoverSchemaInfos, {
          zodCompat: options.zodCompat,
        }),
      );
    }
    staged.apply(edits);
  } else {
    staged.apply(
      collectCompileRewriteEdits(staged.current, compiled, { zodCompat: options.zodCompat }),
    );
  }

  const prefix = computeRuntimePrefix(staged.current, usedHelpers, mode, options.runtimeId);
  // Head = runtime helpers/import, then the file-level shared dedup block, then
  // the rewritten source. The shared `__zcSw_N` functions live at module scope
  // so every IIFE closes over them; they must follow the runtime import (lean)
  // and the helper decls (inline) that they reference. Guard against
  // double-injection on watch/HMR re-runs the same way computeRuntimePrefix
  // does — a second copy would redeclare every `__zcSw_N`.
  const needsShared = shared.code !== "" && !staged.current.includes(SHARED_BLOCK_MARKER);
  const head = (prefix ?? "") + (needsShared ? `${shared.code}\n` : "");
  if (head !== "") {
    staged.apply([], { offset: 0, text: head });
  }
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
    if (code.includes(runtimeId)) return null;
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
  // __zcFin and __zcFinD both construct __ZcFail; declare it once before either,
  // guarding against a header already shipped earlier in the same module.
  const needsFin = !code.includes("function __zcFin(");
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
 * removal), collected against pristine `code`. Each schema's declaration is
 * a distinct region and the import statement is distinct from all of them,
 * so the batch is non-overlapping and order-independent.
 */
function collectCompileRewriteEdits(
  code: string,
  schemas: CompiledSchemaInfo[],
  options?: { zodCompat?: boolean | undefined },
): Edit[] {
  const edits: Edit[] = [];
  for (const schema of schemas) {
    // Match: <exportName> = compile<...>( with word boundary to prevent substring matches
    const prefixPattern = new RegExp(
      `(\\b${schema.exportName}\\s*=\\s*)compile\\s*(?:<[^>]*(?:<[^>]*>[^>]*)?>)?\\s*\\(`,
    );
    const match = prefixPattern.exec(code);
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
  }
  edits.push(...collectRemoveCompileImportEdits(code));
  return edits;
}

/**
 * Find the end position of a JavaScript expression starting at `start` using acorn.
 * Returns the end offset, or -1 if the expression cannot be parsed.
 */
export function findExpressionEnd(code: string, start: number): number {
  try {
    const node = parseExpressionAt(code, start, {
      ecmaVersion: "latest",
      sourceType: "module",
    });
    return node.end;
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

/** Edits for rewriteSourceAutoDiscover, collected against pristine `code`. */
function collectAutoDiscoverEdits(
  code: string,
  schemas: CompiledSchemaInfo[],
  options?: { zodCompat?: boolean | undefined },
): Edit[] {
  const edits: Edit[] = [];
  for (const schema of schemas) {
    const escapedName = schema.exportName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // Match: export? (const|let|var) ExportName[: TypeAnnotation] = <expr>
    const assignPattern = new RegExp(
      `((?:export\\s+)?(?:const|let|var)\\s+${escapedName}(?:\\s*:[^=]*)?\\s*=\\s*)`,
    );
    const match = assignPattern.exec(code);
    if (!match) continue;

    const rhsStart = match.index + match[0].length;
    const rhsEnd = findExpressionEnd(code, rhsStart);
    if (rhsEnd === -1) continue;

    const originalExpr = code.slice(rhsStart, rhsEnd).trim();
    edits.push({
      start: rhsStart,
      end: rhsEnd,
      text: generateIIFE(originalExpr, schema, options),
    });
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
