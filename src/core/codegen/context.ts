import type { BigIntCheckIR, CheckIR, DateCheckIR, SchemaIR, SetCheckIR } from "../types.js";
import type { SharedSchemaPlan } from "./dedupe.js";
import {
  lookupFastRegexSource,
  lookupWellKnownRegex,
  wellKnownRegexSourceName,
} from "./well-known-regex.js";

/** Codegen output mode. "inline" emits self-contained code (CLI .compiled.ts). "lean" emits references to imports from "virtual:zod-compiler/runtime" (unplugin). */
export type CodegenMode = "inline" | "lean";

export interface CodeGenResult {
  code: string;
  functionDef: string;
  /** Number of fallback schemas referenced by __rf[N] in the generated code. 0 = no fallbacks. */
  refCount: number;
  /**
   * Helper names referenced by this schema in lean mode (e.g. "__zcTS", "__zcReEmail").
   * Used by the unplugin transform to construct the `import { ... } from "virtual:zod-compiler/runtime"` line.
   * Always empty in inline mode.
   */
  usedHelpers: Set<string>;
  /**
   * Name of the hosted fast-check boolean function in the preamble (null when
   * the schema has no Fast Path). generateIIFE passes it to __zcMkv so parse()
   * and parseAsync() can return valid input without allocating an
   * intermediate SafeParseResult.
   */
  fastFnName: string | null;
  /**
   * True when `fastFnName` is a TOTAL predicate: `fc(input) === true` iff the
   * schema accepts `input` (mutation-free schemas, where a fast-check failure
   * can never become a slow-path success). generateIIFE installs it as the
   * zero-allocation `.is()` guard. False for partial fast paths
   * (default/catch/coerce — `fc` only shortcuts present-and-valid input, so a
   * `false` result does NOT imply rejection) and for schemas with no fast path;
   * `.is()` then derives from `safeParse(input).success`.
   */
  fastTotal: boolean;
  /**
   * Compact mode only: the `__rf[N]` index this validator delegates its cold
   * error path to (the schema itself, captured as a fresh root RefEntry). When
   * set, the pipeline appends a `{ schema, accessPath: "" }` entry at this index
   * so `generateIIFE` materializes `__rf[N]` as the original Zod schema. Absent
   * for every non-compact (fully compiled) validator.
   */
  rootDelegateRefIndex?: number;
}

/** Hosted-validator names for one recursion target (see CodeGenContext.recTargets). */
export interface RecTargetGen {
  /** True for the root target (refId 0) — reuses the schema's own functions. */
  isRoot: boolean;
  /**
   * safeParse-shaped slow validator name: `safeParse_<name>` for the root,
   * `__rsp_N` for a non-root target. `slowRecursiveRef` calls this.
   */
  slowName: string;
  /**
   * Boolean fast-check name (`__fcr_N`). Allocated lazily for the root (mirrors
   * recFastName), eagerly for non-root targets. Absent until the fast path
   * reaches a ref to this target.
   */
  fastName?: string;
  /** Inner IR hosted as the standalone validator body (non-root targets only). */
  inner?: SchemaIR;
}

/** Shared mutable state for code generation. Fast and slow paths share the same instance. */
export interface CodeGenContext {
  preamble: string[];
  counter: number;
  fnName: string;
  /** Deduplicates regex patterns: same pattern string → same preamble variable name. */
  regexCache: Map<string, string>;
  /** Codegen output mode. */
  mode: CodegenMode;
  /** Names of helpers from "virtual:zod-compiler/runtime" referenced in this schema (lean mode only). */
  usedHelpers: Set<string>;
  /**
   * Name of the fast-path boolean helper for the ROOT recursion target
   * (refId 0), allocated on first fastRecursiveRef visit. generateValidator
   * wraps the root fast expression as `function <name>(input){return <expr>;}`
   * so recursive refs can call it. undefined = root has no recursion on the
   * fast path.
   */
  recFastName?: string;
  /**
   * Hosted-validator name table for recursion targets, keyed by refId. Entry 0
   * is the root (the schema's own `safeParse_<name>` / `recFastName`); entries
   * ≥ 1 are non-root targets hosted as standalone `__rsp_N` (slow) / `__fcr_N`
   * (fast) helpers. `recursiveRef`/`recursionTarget` generators look up the
   * call target here. Undefined when not generating a full validator (e.g. unit
   * tests calling a single generator) — treated as root-only.
   */
  recTargets?: Map<number, RecTargetGen>;
  /** Dedup cache for hosted zero-capture effect functions: source text → preamble var. */
  effectFnCache?: Map<string, string>;
  /** Memo for estimateFastCost (size-gated fast-check extraction). Lazily created. */
  fastSizeCache?: WeakMap<SchemaIR, number>;
  /**
   * File-level shared slow-walk plan. Set only when generating a mutation-free
   * schema (so shared walks stay on the deferred cold path); the slow-path
   * visit() consults it to replace a repeated sub-IR with a `__zcSw_N` call.
   */
  sharedSchemas?: SharedSchemaPlan;
}

// ─── Slow Path context ────────────────────────────────────────────────────────

/** Context object for slow-path (error-collecting) generator functions. */
export interface SlowGen {
  readonly input: string;
  readonly output: string;
  readonly path: string;
  readonly issues: string;
  readonly ctx: CodeGenContext;
  /**
   * Schema-level static error message of the node being generated
   * (z.string({ error: "..." })). Default message for issues this node emits
   * when the individual check has no message of its own. Set by generateSlow()
   * from ir.typeMessage; never inherited by child nodes.
   */
  readonly typeMsg?: string | undefined;

  /**
   * Name of a boolean variable that this node sets to `true` when it aborts in
   * the zod sense (`payload.aborted`) — currently only a pipe/codec whose `in`
   * step fails (zod's `handlePipeResult` sets `left.aborted = true`). A `union`
   * allocates one per option and reads it during pruning so a pipe option whose
   * `in` failed counts as aborted even when its only issue is a non-aborting
   * `custom`/check-level code. Undefined when the node is not inside an
   * abort-tracking option, in which case the abort is a no-op.
   *
   * Unlike input/output/path/issues, this is NOT inherited by `visit()`: it is
   * cleared at every boundary unless a node explicitly forwards it (the
   * pass-through wrappers optional/nullable/readonly do), mirroring how zod
   * propagates `payload.aborted` through transparent wrappers but not across
   * container boundaries.
   */
  readonly aborted?: string | undefined;

  /**
   * Recursively generate validation for a child IR node.
   * input/output/path/issues are inherited from parent unless overridden;
   * `aborted` is the exception — it is only set when explicitly passed (see the
   * `aborted` field doc), so it never leaks into container children.
   * Union generators use `{ issues }` to redirect child errors to temporary arrays.
   * Container generators use `{ input, output, path }` for element traversal.
   */
  visit(
    ir: SchemaIR,
    overrides?: {
      input?: string;
      output?: string;
      path?: string;
      issues?: string;
      // `| undefined` (unlike the others): pass-through wrappers forward
      // `g.aborted` verbatim, which is undefined outside an abort-tracking option.
      aborted?: string | undefined;
    },
  ): string;

  /** Generate a unique temp variable name: `__${prefix}_${counter++}` */
  temp(prefix: string): string;

  /** Add a regex to preamble and return the variable name. */
  regex(prefix: string, pattern: string, flags?: string): string;

  /** Add a Set to preamble and return the variable name. */
  set(prefix: string, values: readonly unknown[]): string;
}

/** Slow-path generator function signature — registered in slowRegistry. */
export type SlowGenerator<T extends SchemaIR = SchemaIR> = (ir: T, g: SlowGen) => string;

// ─── Fast Path context ────────────────────────────────────────────────────────

/**
 * Per-emitted-function size accumulator for size-gated fast-check extraction.
 * Shared by every node inlined into the same function; a fresh instance starts
 * each hosted helper (and the root). See fast-size.ts / generateFast.
 */
export interface FastScope {
  used: number;
}

/** Context object for fast-path (boolean expression) generator functions. */
export interface FastGen {
  readonly input: string;
  readonly ctx: CodeGenContext;

  /**
   * Whether the CURRENT node may be hoisted into its own boolean helper when it
   * (with the already-emitted siblings) would overflow the function size cap.
   * False for the root and for a helper's own top node — those are already their
   * own function — but their children are extractable. See generateFast.
   */
  readonly extractable: boolean;

  /** Accumulated size (≈ chars) of the function currently being assembled. */
  readonly scope: FastScope;

  /**
   * Set on the gen for a discriminated-union option only: the discriminator
   * key. Signals `fastObject` to omit its type-guard and skip re-checking that
   * property (the switch already matched its value). Never propagated to child
   * nodes — nested objects keep their own guard.
   */
  readonly discSkipKey?: string | undefined;

  /**
   * Recursively generate fast-check expression for a child IR node.
   * Returns null if any child is ineligible for fast path.
   */
  visit(ir: SchemaIR, overrides?: { input?: string; discSkipKey?: string }): string | null;

  /**
   * A FastGen for emitting a SEPARATE function body (a hand-built preamble
   * helper such as a discriminated-union switch or an array-element loop). It
   * carries a FRESH size accumulator, so the helper's own content is size-gated
   * against the cap independently of the caller — without this, a helper's body
   * accrues to the caller's scope while the helper itself grows unbounded.
   */
  scoped(input: string): FastGen;

  /** Generate a unique temp variable name. */
  temp(prefix: string): string;

  /** Add a regex to preamble and return the variable name. */
  regex(prefix: string, pattern: string, flags?: string): string;
}

/** Fast-path generator function signature — registered in fastRegistry. */
export type FastGenerator<T extends SchemaIR = SchemaIR> = (ir: T, g: FastGen) => string | null;

// ─── Shared emit helpers (used by both slow-path and fast-path factories) ────

/** Allocate a fresh `__${prefix}_${n}` identifier and bump the shared counter. */
export function emitTemp(ctx: CodeGenContext, prefix: string): string {
  return `__${prefix}_${ctx.counter++}`;
}

/**
 * Host a zero-capture effect function (refine predicate, transform,
 * overwrite) in the preamble and return its variable name. The inline
 * `(${source})(x)` form evaluates the function expression — allocating a
 * function object — on EVERY parse at every effect site, including inside
 * the "zero-allocation" fast chain. V8's escape analysis erases that in
 * optimized frames, but interpreter/baseline/deopt frames pay it, and the
 * full source text re-parses as bytecode at each site. Zero-capture sources
 * reference only their own parameters and safe globals by construction, so
 * a single preamble binding is semantically identical. Deduped per schema
 * by source text.
 */
export function emitEffectFn(ctx: CodeGenContext, source: string): string {
  ctx.effectFnCache ??= new Map();
  const cached = ctx.effectFnCache.get(source);
  if (cached !== undefined) return cached;
  const name = `__ef_${ctx.counter++}`;
  ctx.preamble.push(`var ${name}=(${source});`);
  ctx.effectFnCache.set(source, name);
  return name;
}

/**
 * Pristine fallback delegate: declare `var __rfp_N=__rf[N].safeParse.bind(__rf[N]);`
 * in the preamble and return the variable name. Generated code must NEVER read
 * `__rf[N].safeParse` at parse time: `__zcMkv` installs the compiled safeParse as
 * an OWN property on the original schema object, and whenever `__rf[N]` is that
 * same object the read resolves to the compiled delegate itself — infinite
 * recursion (RangeError on every parse). The fallback entry and the __zcMkv
 * target ARE the same object in compile mode (schemaExpr is the compile()
 * argument identifier) and the CLI emitter ((__src_X as any).schema); in
 * autoDiscover mode they are two textually identical constructions that any
 * downstream CSE/dedup transform (babel-plugin-zod-hoist in a field incident)
 * collapses back into one. Capturing at IIFE evaluation — before the trailing
 * `return __zcMkv(...)` mutates anything — pins zod's own implementation; the
 * worst case under cross-validator merges is delegating to an equivalent
 * compiled validator (whose own delegates were captured even earlier), never
 * a cycle.
 */
export function emitRfDelegate(ctx: CodeGenContext, refIndex: number): string {
  const name = `__rfp_${refIndex}`;
  const decl = `var ${name}=__rf[${refIndex}].safeParse.bind(__rf[${refIndex}]);`;
  if (!ctx.preamble.includes(decl)) {
    ctx.preamble.push(decl);
  }
  return name;
}

/**
 * Resolve a regex pattern to a runtime variable name.
 * Lean mode short-circuits well-known patterns to virtual-module names so the
 * bundler can dedup across files; everything else is cached + declared in the
 * per-IIFE preamble exactly once per pattern.
 */
export function emitRegex(
  ctx: CodeGenContext,
  prefix: string,
  pattern: string,
  flags?: string,
): string {
  if (ctx.mode === "lean" && !flags) {
    const wellKnown = lookupWellKnownRegex(pattern);
    if (wellKnown !== null) {
      ctx.usedHelpers.add(wellKnown);
      return wellKnown;
    }
  }
  const cacheKey = flags ? `${flags}\u0000${pattern}` : pattern;
  const cached = ctx.regexCache.get(cacheKey);
  if (cached) return cached;
  const name = `__re_${prefix}_${ctx.counter++}`;
  const flagsArg = flags ? `,${escapeString(flags)}` : "";
  // Flag-less well-known patterns may carry a faster behavior-equivalent
  // rewrite; the regex OBJECT uses it while issue sites keep reporting the
  // original pattern (see slowString).
  const testSource = flags ? null : lookupFastRegexSource(pattern);
  ctx.preamble.push(`var ${name}=new RegExp(${escapeString(testSource ?? pattern)}${flagsArg});`);
  ctx.regexCache.set(cacheKey, name);
  return name;
}

/**
 * Resolve the ORIGINAL `/source/flags` pattern string of a regex for issue
 * reporting. Only needed when emitRegex swapped in a faster equivalent test
 * pattern (the runtime regex's toString() would leak the rewrite). Lean mode
 * references the shared `<name>Src` virtual export so the original pattern
 * stays a single bundle-wide string; inline mode declares it once per IIFE.
 */
export function emitRegexSourceString(ctx: CodeGenContext, pattern: string): string {
  if (ctx.mode === "lean") {
    const srcName = wellKnownRegexSourceName(pattern);
    if (srcName !== null) {
      ctx.usedHelpers.add(srcName);
      return srcName;
    }
  }
  const cacheKey = `src\u0000${pattern}`;
  const cached = ctx.regexCache.get(cacheKey);
  if (cached) return cached;
  const name = `__res_${ctx.counter++}`;
  ctx.preamble.push(`var ${name}=${escapeString(`/${pattern}/`)};`);
  ctx.regexCache.set(cacheKey, name);
  return name;
}

/** Declare a `new Set([...])` in the preamble and return its variable name. */
export function emitSet(ctx: CodeGenContext, prefix: string, values: readonly unknown[]): string {
  const name = `__set_${prefix}_${ctx.counter++}`;
  ctx.preamble.push(`var ${name}=new Set(${JSON.stringify([...values])});`);
  return name;
}

/**
 * Enum values at or below this count use inline === checks instead of Set.has().
 * Measured on V8: for ≤5 values, an === chain beats Set.has by up to ~3x with
 * realistic (distinct-prefix, JSON-parsed) values — V8 internalizes strings on
 * successful comparison, making subsequent arms pointer-equality — and is no
 * worse than Set.has even with adversarial shared-prefix values.
 */
export const ENUM_INLINE_THRESHOLD = 5;

const CHECK_PRIORITY: Record<string, number> = {
  // Cheapest: length/size comparisons (O(1))
  min_length: 10,
  max_length: 11,
  length_equals: 12,
  min_size: 13,
  max_size: 14,
  // Number format checks (comparison + bitwise)
  number_format: 15,
  // Range comparisons
  greater_than: 20,
  less_than: 21,
  bigint_greater_than: 20,
  bigint_less_than: 21,
  date_greater_than: 22,
  date_less_than: 23,
  // Modulo
  multiple_of: 30,
  bigint_multiple_of: 30,
  // String prefix/suffix (O(prefix/suffix length))
  starts_with: 40,
  ends_with: 41,
  // String search (O(n·m) worst case)
  includes: 42,
  // Regex (most expensive)
  string_format: 50,
};

export function escapeString(s: string | number): string {
  return JSON.stringify(s);
}

/**
 * JS source for a primitive literal value (literal schemas, discriminator
 * case labels). JSON.stringify covers string/number/boolean/null; bigint
 * needs the `n` suffix (JSON.stringify throws and String(5n) renders a
 * number literal that never strict-equals a bigint); undefined isn't JSON.
 */
export function literalToJs(v: string | number | boolean | null | bigint | undefined): string {
  if (typeof v === "bigint") return `${v}n`;
  if (v === undefined) return "undefined";
  // JSON.stringify maps NaN/±Infinity to "null"; emit them as JS expressions so a
  // non-finite numeric literal round-trips (z.literal(Infinity) must compare
  // against Infinity, not null). String(NaN)="NaN", String(Infinity)="Infinity",
  // String(-Infinity)="-Infinity" — all valid JS that evaluate to the value.
  if (typeof v === "number" && !Number.isFinite(v)) return String(v);
  return JSON.stringify(v);
}

/**
 * Reference a shared runtime helper (e.g. __zcFsr) from generated code.
 * Lean mode: registers it for the `virtual:zod-compiler/runtime` import.
 * Inline mode: declares it once in the per-IIFE preamble.
 */
export function emitRuntimeHelper(ctx: CodeGenContext, name: string, decl: string): string {
  if (ctx.mode === "lean") {
    ctx.usedHelpers.add(name);
  } else if (!ctx.preamble.includes(decl)) {
    ctx.preamble.push(decl);
  }
  return name;
}

/**
 * Extend a path expression with one or more scalar segment expressions
 * (escaped string literals, numeric literals, or loop-variable names).
 *
 * Path expressions are only ever composed by these helpers starting from the
 * `[]` root, so any path that looks like an array literal IS one — the new
 * segment is spliced in to keep issue paths a single array allocation
 * (`["data","items",__i_7]`) instead of an allocation per nesting level
 * (`["data"].concat("items").concat(__i_7)`). Opaque expressions fall back
 * to .concat().
 */
export function extendPath(parentPath: string, segExpr: string): string {
  if (parentPath === "[]") return `[${segExpr}]`;
  if (parentPath.startsWith("[") && parentPath.endsWith("]")) {
    return `${parentPath.slice(0, -1)},${segExpr}]`;
  }
  return `${parentPath}.concat(${segExpr})`;
}

/** Extend a path expression with a static string key. */
export function extendStaticPath(parentPath: string, key: string): string {
  return extendPath(parentPath, escapeString(key));
}

/** Extend a path expression with a numeric index. */
export function extendStaticPathIndex(parentPath: string, index: number): string {
  return extendPath(parentPath, String(index));
}

/**
 * Check if a SchemaIR tree produces output that is not the input itself —
 * either value-mutating operations (coerce, default, catch, overwrite) that
 * write back to the input expression, or a strip object that rebuilds a fresh
 * object from its known keys. Used by container generators to decide whether to
 * clone (so the rebuilt/mutated value never writes through to the caller's
 * input), by generateValidator to keep such schemas off the by-reference fast
 * path, and by the shared-walk dedup + intersection extractor to exclude them.
 */
export function hasMutation(ir: SchemaIR): boolean {
  switch (ir.type) {
    case "string":
      // url checks trim (and optionally normalize) the value; overwrite
      // effects (.trim(), .toLowerCase()) rewrite it.
      return (
        ir.coerce === true ||
        ir.checks.some(
          (c) =>
            c.kind === "overwrite_effect" || (c.kind === "string_format" && c.format === "url"),
        )
      );
    case "number":
    case "boolean":
    case "bigint":
    case "date":
      return ir.coerce === true;
    case "default":
    case "catch":
    case "effect":
    case "fallback":
    case "stringBool":
      return true;
    case "object":
      // A strip object produces a FRESH output (only the declared keys), so it
      // mutates: parents must clone before it writes back, it never takes the
      // by-reference fast path, and intersections of strip objects delegate to
      // zod (see extractIntersection's hasMutation guard) — matching zod's
      // parse-both-sides-then-merge semantics instead of over-stripping.
      return ir.stripUnknownKeys === true || Object.values(ir.properties).some(hasMutation);
    case "array":
      return hasMutation(ir.element);
    case "tuple":
      return ir.items.some(hasMutation) || (ir.rest !== null && hasMutation(ir.rest));
    case "record":
      return hasMutation(ir.valueType);
    case "optional":
    case "nullable":
    case "readonly":
    case "recursionTarget":
      return hasMutation(ir.inner);
    case "union":
    case "discriminatedUnion":
      return ir.options.some(hasMutation);
    case "intersection":
      return hasMutation(ir.left) || hasMutation(ir.right);
    case "pipe":
      return hasMutation(ir.in) || hasMutation(ir.out);
    case "set":
      return hasMutation(ir.valueType);
    case "map":
      return hasMutation(ir.keyType) || hasMutation(ir.valueType);
    case "file":
      return false;
    default:
      return false;
  }
}

/**
 * Sort comparator for CheckIR: cheapest/most-discriminating checks first.
 * Used by fast-path generators after filtering out refine_effect entries.
 */
export function checkPriority(
  a: CheckIR | BigIntCheckIR | DateCheckIR | SetCheckIR,
  b: CheckIR | BigIntCheckIR | DateCheckIR | SetCheckIR,
): number {
  return (CHECK_PRIORITY[a.kind] ?? 99) - (CHECK_PRIORITY[b.kind] ?? 99);
}
