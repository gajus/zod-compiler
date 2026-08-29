import type {
  BigIntCheckIR,
  CheckIR,
  DateCheckIR,
  LiteralValue,
  SchemaIR,
  SetCheckIR,
} from "../types.js";
import type { SharedSchemaPlan } from "./dedupe.js";
import {
  fastTestSource,
  lookupWellKnownRegex,
  wellKnownRegexSourceName,
} from "./well-known-regex.js";

/** Codegen output mode. "inline" emits self-contained code (CLI .compiled.ts). "lean" emits references to imports from "virtual:zod-compiler/runtime" (unplugin). */
export type CodegenMode = "inline" | "lean";

/**
 * Kind of a poolable constant. Decides the shared identifier's prefix, so a
 * module-scope pool stays readable (`__zcSet_0`, …) rather than opaque.
 */
export type ConstantKind = "Bf" | "Rx" | "Set";

/**
 * A poolable constant declaration emitted while generating one validator.
 *
 * Reported to the file pipeline, which pools initializers used by two or more
 * validators into a single module-scope declaration. Only value constants
 * qualify: they are allocated once at module init and read identically from
 * anywhere, so hoisting one out of a validator changes neither its identity nor
 * the hot path.
 *
 * Generated FAST-PATH functions are deliberately not poolable, even when two
 * validators emit byte-identical ones: sharing a function merges its call sites
 * onto a single feedback vector, which is exactly the polymorphism the fast
 * path is inlined to avoid. Cold slow walks are a different bargain and are
 * shared — by their own mechanism, `__zcSw_N` (see dedupe.ts).
 */
export interface GeneratedConstant {
  readonly kind: ConstantKind;
  readonly name: string;
  readonly initializer: string;
}

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
   * (default/catch — `fc` only shortcuts present-and-valid input, so a `false`
   * result does NOT imply rejection) and for schemas with no fast path, such as
   * coercion; `.is()` then derives from `safeParse(input).success`.
   */
  fastTotal: boolean;
  /**
   * Hosted predicate installed as `.is()`, when it differs from `fastFnName`.
   * A schema that rebuilds its output has no by-reference shortcut (so
   * `fastFnName` is null) yet still has an exact acceptance predicate, because
   * stripping reshapes the payload and never the verdict.
   */
  isFnName?: string | null;
  /**
   * Compact mode only: this validator reads {@link RETAINED_SCHEMA_VAR}
   * directly, so `generateIIFE` must bind it even when the schema has no
   * fallback refs of its own. Absent for every non-compact (fully compiled)
   * validator.
   */
  usesRetainedSchema?: boolean;
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
  /** Dedup cache for constant preamble declarations: initializer text → preamble var. */
  valueCache?: Map<string, string>;
  /** Reports poolable constants so the file pipeline can share exact duplicates across validators. */
  onConstant?: ((constant: GeneratedConstant) => void) | undefined;
  /** Exact initializer → file-level name, populated by the pipeline's second codegen pass. */
  sharedConstantNames?: ReadonlyMap<string, string> | undefined;
  /** Name of the build path's FAIL sentinel, declared once per validator. */
  buildFailName?: string;
  /** Hosted build-function name per recursion target refId, so back-edges resolve. */
  buildRecNames?: Map<number, string>;
  /**
   * Set by the build path when it emitted a `.default()` substitution. Such a
   * schema ACCEPTS an input its fast expression rejects — `fastDefault` demands a
   * present value, since the fast path's contract is `data === input` and a
   * substituted default is not the input — so the expression is no longer an
   * exact acceptance predicate and must not be installed as `.is()`. Stripping,
   * by contrast, reshapes only the payload, which is why a build-path schema
   * otherwise still hands its predicate over.
   */
  buildSubstitutesValue?: boolean;
  /** Memo for estimateFastCost (size-gated fast-check extraction). Lazily created. */
  fastSizeCache?: WeakMap<SchemaIR, number>;
  /** Memo for estimateRuntimeCost (cheapest-first check ordering). Lazily created. */
  fastRuntimeCostCache?: WeakMap<SchemaIR, number>;
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
  /**
   * `var` temps that the function this scope is assembling must declare, in
   * allocation order. Populated by {@link FastGen.local}; every site that
   * materializes a function body from a fresh scope emits
   * {@link declareFastTemps} at the top of that body.
   *
   * Function-scoped (never module-scoped) is load-bearing: a recursive
   * validator re-enters itself while an outer frame still holds a live temp,
   * and each invocation needs its own binding.
   */
  temps: string[];
}

/** `var a,b;` declaration for a scope's temps, or "" when it allocated none. */
export function declareFastTemps(scope: FastScope): string {
  return scope.temps.length > 0 ? `var ${scope.temps.join(",")};` : "";
}

/**
 * Fast check for a wrapper that compares its input against a sentinel and
 * otherwise delegates to an inner schema — `optional` (`===undefined`),
 * `nullable` (`===null`) and `default` (`!==undefined`).
 *
 * Written naively these read the input TWICE: once for the sentinel test and
 * again inside the inner check (which may itself read it several more times —
 * `typeof x==="string"&&x.length>=3&&x.length<=20`). V8's load elimination
 * removes the repeats only while the access is monomorphic; on the polymorphic
 * and megamorphic call sites real payloads produce (an array of objects with
 * differing key order, anything out of `JSON.parse`) every repeat is a fresh
 * megamorphic lookup. Binding the value to a local once is worth 1.1-1.7x on
 * the whole object check when the optional key is present, and is neutral when
 * it is absent.
 *
 * Only hoisted when the input is a property access; a bare local (an array
 * element variable, a record value) is already a single load, so it keeps the
 * shorter form and byte-identical output.
 */
export function fastSentinelWrapper(
  g: FastGen,
  innerIR: SchemaIR,
  sentinel: string,
  joiner: "&&" | "||",
): string | null {
  if (!isPropertyAccess(g.input)) {
    const inner = g.visit(innerIR);
    return inner === null ? null : `(${g.input}${sentinel}${joiner}(${inner}))`;
  }
  const value = g.local("w");
  const inner = g.visit(innerIR, { input: value });
  if (inner === null) return null;
  return `((${value}=${g.input})${sentinel}${joiner}(${inner}))`;
}

/** True for an expression that performs a property load (`x["a"]`, `x.a`, `x[0][1]`). */
function isPropertyAccess(expr: string): boolean {
  return expr.includes("[") || expr.includes(".");
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

  /**
   * Allocate a unique name AND record it on this scope so the enclosing
   * emitted function declares it as a `var` (see {@link FastScope.temps}).
   * Use for a value bound inside an expression — `(t=x["k"])===undefined` —
   * where `temp()` alone would leave the name undeclared.
   */
  local(prefix: string): string;

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
 * Callable expression for a user callback — a refine predicate or a transform.
 *
 * A zero-capture callback is hosted from its source text; one that CAPTURES
 * outer variables is called by reference through `__rf[N]` — the user's own
 * function object, reached from the schema — instead of costing the schema its
 * compiled path. The reference is aliased into a preamble binding rather than
 * re-read per call, for the same reason call-invoked helpers are (a per-call
 * array element load is not a foldable callee).
 */
export function emitEffectCallable(
  ctx: CodeGenContext,
  effect: { refIndex?: number | undefined; source?: string | undefined },
): string {
  if (effect.refIndex !== undefined) return emitConstant(ctx, "rfn", `__rf[${effect.refIndex}]`);
  if (effect.source === undefined) {
    throw new Error("effect has neither inlineable source nor a reference index");
  }
  return emitEffectFn(ctx, effect.source);
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
 * Identifier `generateIIFE` binds the retained Zod schema to, once per export.
 *
 * Compact delegation reaches the schema through this binding rather than
 * through `__rf[]`. Routing it through the array meant every compact validator
 * — the common case being one with no fallback refs at all — declared a
 * one-element `var __rf=[__zs];` whose only reads were `__rf[0]`, i.e. an array
 * allocation per compiled schema at module init to alias a binding that was
 * already in scope. Naming the schema directly also keeps the reference a
 * foldable constant instead of an element load (the same reason
 * {@link emitEffectCallable} aliases its `__rf[N]` into a preamble binding).
 */
export const RETAINED_SCHEMA_VAR = "__zs";

/**
 * Capture the retained schema's pristine `safeParse` without allocating a bound
 * function. Declared in the preamble, which `generateIIFE` places after the
 * `__zs` binding and before the trailing `__zcMkv` call — so the capture is
 * zod's own implementation, never the compiled delegate that call installs
 * (see {@link emitRfDelegate} for the recursion this avoids).
 */
export function emitRetainedMethod(ctx: CodeGenContext): string {
  const name = "__rfm_z";
  const decl = `var ${name}=${RETAINED_SCHEMA_VAR}.safeParse;`;
  if (!ctx.preamble.includes(decl)) {
    ctx.preamble.push(decl);
  }
  return name;
}

/**
 * Is a RegExp built with these flags safe to share between validators?
 *
 * `g` and `y` make the object STATEFUL: `.test()` advances `lastIndex` and the
 * next call resumes from there. Generated code is already correct about this —
 * every flagged site emits a `lastIndex=0` reset first (see `lastIndexReset` in
 * schemas/string.ts, the only generator that passes flags through) — so pooling
 * them would in fact work today.
 *
 * They are held back anyway, because the pool changes what a future lapse
 * costs. A missing reset on a validator-local regex misbehaves inside one
 * export, deterministically. On a pooled one it misbehaves across exports, and
 * only in the order the module happens to evaluate them. Flagged patterns are
 * rare enough that the sharing is not worth buying that failure mode. Every
 * other flag (`i`, `m`, `s`, `u`, `v`, `d`) is pure configuration and pools like
 * any other constant.
 */
function isPoolableRegex(flags: string | undefined): boolean {
  return flags === undefined || !/[gy]/.test(flags);
}

/**
 * Resolve a regex pattern to a runtime variable name.
 *
 * Three layers, widest first. Lean mode short-circuits well-known patterns to
 * virtual-module names, deduping them across the whole bundle. What is left is
 * pooled at FILE level when two or more validators build the identical RegExp —
 * the same bargain Sets get, and a larger one in practice: a repeated enum is
 * one `new Set([...])`, while a repeated `z.iso.datetime()` or shared
 * `.regex()` is a several-hundred-byte pattern plus a RegExp construction per
 * validator at module init. Anything still unique is cached and declared in the
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
  const flagsArg = flags ? `,${escapeString(flags)}` : "";
  // Flag-less patterns may carry a faster behavior-equivalent rewrite (a
  // well-known table entry, repeat unrolling, or both); the regex OBJECT uses
  // it while issue sites keep reporting the original pattern (see slowString).
  const testSource = flags ? null : fastTestSource(pattern);
  const initializer = `new RegExp(${escapeString(testSource ?? pattern)}${flagsArg})`;
  const localPrefix = `re_${prefix}`;
  const name = isPoolableRegex(flags)
    ? emitPooledConstant(ctx, "Rx", localPrefix, initializer)
    : emitConstant(ctx, localPrefix, initializer);
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

/**
 * Declare a constant value in the preamble and return its variable name,
 * reusing an earlier declaration of the SAME initializer.
 *
 * Value tables are reached from both halves of a validator — an enum's `Set`
 * from its fast check and again from its slow walk, a strict shape's key table
 * likewise — and repeat across sibling properties that share a value list. One
 * declaration per USE emitted the payload two or four times: measured 17% of a
 * 20-value enum schema's generated bytes, 16% for an object with two identical
 * enums. Keyed by initializer text, so only identical payloads collapse.
 */
export function emitConstant(ctx: CodeGenContext, prefix: string, initializer: string): string {
  ctx.valueCache ??= new Map();
  const cached = ctx.valueCache.get(initializer);
  if (cached !== undefined) return cached;
  const name = `__${prefix}_${ctx.counter++}`;
  ctx.preamble.push(`var ${name}=${initializer};`);
  ctx.valueCache.set(initializer, name);
  return name;
}

/**
 * Declare a poolable constant in the preamble and return its variable name —
 * unless the file pipeline has already decided to hoist this exact initializer
 * to module scope, in which case the shared name is returned and nothing is
 * declared locally.
 *
 * The pipeline learns which initializers repeat by running codegen once and
 * collecting what was reported here, so every poolable constant must route
 * through this function rather than calling {@link emitConstant} directly.
 */
export function emitPooledConstant(
  ctx: CodeGenContext,
  kind: ConstantKind,
  localPrefix: string,
  initializer: string,
): string {
  const sharedName = ctx.sharedConstantNames?.get(initializer);
  if (sharedName !== undefined) return sharedName;
  const name = emitConstant(ctx, localPrefix, initializer);
  ctx.onConstant?.({ kind, name, initializer });
  return name;
}

/** Declare a `new Set([...])` in the preamble and return its variable name. */
export function emitSet(ctx: CodeGenContext, prefix: string, values: readonly unknown[]): string {
  const initializer = `new Set(${JSON.stringify([...values])})`;
  return emitPooledConstant(ctx, "Set", `set_${prefix}`, initializer);
}

/**
 * Shape-key count at or below which the unknown-key pass compares with an
 * inline `===` chain rather than a hashed lookup.
 *
 * This is deliberately NOT {@link ENUM_INLINE_THRESHOLD}: the two look alike but
 * are different workloads. An enum compares schema literals against arbitrary
 * INPUT strings, which may be long, share prefixes, and are not necessarily
 * internalized — so a hashed set earns its keep quickly. A shape-key test
 * compares them against keys arriving from `for-in`, i.e. the object's own
 * internalized key strings, so every arm of the chain is a pointer compare that
 * V8 predicts perfectly, while `table[k]` / `set.has(k)` pays a string hash and
 * probe per key.
 *
 * Measured over a strict object's for-in pass (JSON-parsed input, 8 rotated
 * shapes), `===` chain vs the previous `{k:1}` table: 3.7x at 6 keys, 3.8x at
 * 10, 3.1x at 20, 3.1x at 48 — the chain still leads at 64 (283 ns vs 690) and
 * only loses past ~96, where `Set.has` (not the table, which never wins at any
 * size) takes over. 64 sits below that crossover and above any realistic shape.
 */
export const KEY_MEMBERSHIP_INLINE_THRESHOLD = 64;

/**
 * Boolean membership test for one key variable against a fixed key list.
 * Empty list recognizes nothing.
 *
 * `Set.has` is the large-shape fallback rather than a `{key:1}` object table:
 * the table is also `__proto__`-hostile (an own `__proto__` key cannot be set
 * by an object literal, so that key would silently read as unknown), which the
 * Set has no trouble with.
 */
export function keyMembershipTest(
  ctx: CodeGenContext,
  keys: readonly string[],
  keyVar: string,
): string {
  if (keys.length === 0) return "false";
  if (keys.length <= KEY_MEMBERSHIP_INLINE_THRESHOLD) {
    return keys.map((k) => `${keyVar}===${escapeString(k)}`).join("||");
  }
  return `${emitSet(ctx, "ks", keys)}.has(${keyVar})`;
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

/** The {@link LiteralValue}s that {@link literalToJs} can spell. */
export type SourceFormLiteral = string | number | boolean | null | bigint | undefined;

/**
 * Can {@link literalToJs} render this value as JS source that strict-equals it?
 *
 * Total by construction — it NAMES the value kinds that have a source form
 * rather than excluding the ones that don't, so every reference value falls out
 * on the false side. That matters because `literalToJs` used to end in a bare
 * `JSON.stringify`, which does not fail loudly on the values it cannot spell:
 * for a symbol it RETURNS `undefined` (the value, not a string), so
 * `z.literal(sym)` compiled to the comparison `x===undefined` — rejecting the
 * symbol it was built from and accepting `undefined`. An object is mis-rendered
 * the other way: `{}` stringifies to `"{}"`, and `x==={}` is never true, so the
 * very object the schema was built from was rejected. Both take the runtime
 * membership path instead (see the literal generator).
 */
export function hasSourceForm(v: LiteralValue): v is SourceFormLiteral {
  if (v === null) return true;
  const t = typeof v;
  return t === "string" || t === "number" || t === "boolean" || t === "bigint" || t === "undefined";
}

/**
 * JS source for a primitive literal value (literal schemas, discriminator
 * case labels). JSON.stringify covers string/number/boolean/null; bigint
 * needs the `n` suffix (JSON.stringify throws and String(5n) renders a
 * number literal that never strict-equals a bigint); undefined isn't JSON.
 *
 * The parameter type is deliberately NARROWER than {@link LiteralValue}: every
 * caller must first prove its value is spellable with {@link hasSourceForm}.
 */
export function literalToJs(v: SourceFormLiteral): string {
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
 * Helpers that generated code invokes through `Function.prototype.call`, and
 * which therefore must be aliased into a module-local binding in lean mode.
 *
 * V8 folds a local `const` callee into a constant and inlines straight through
 * `x.call(...)`; an IMPORTED binding is a cell it will not fold, so the same
 * expression stays a generic property load plus a generic call — measured 4.5x
 * (5 keys) to 6.5x (20 keys) slower on the record fast path, 35.9 ns vs 7.2 ns
 * for a 5-key record. Aliasing the import into the IIFE recovers all of it
 * (7.4 ns). A DIRECT call to an imported function (`__zcFsr(v,s)`) is not
 * penalized — measured identical — and neither is an imported RegExp receiver,
 * so only the `.call` sites are listed here.
 */
const CALL_INVOKED_HELPERS: ReadonlySet<string> = new Set(["__zcHop"]);

/**
 * Reference a shared runtime helper (e.g. __zcFsr) from generated code.
 * Lean mode: registers it for the `virtual:zod-compiler/runtime` import.
 * Inline mode: declares it once in the per-IIFE preamble.
 */
export function emitRuntimeHelper(ctx: CodeGenContext, name: string, decl: string): string {
  if (ctx.mode === "lean") {
    ctx.usedHelpers.add(name);
    if (CALL_INVOKED_HELPERS.has(name)) return emitConstant(ctx, "lh", name);
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
 * A superRefine callback receives zod's payload, whose `value` is public,
 * typed, writable API ($RefinementCtx extends ParsePayload) — so any node
 * carrying one MAY rewrite its value and must be treated as mutating. Which
 * callbacks actually do is undecidable here; the emitted fast check settles it
 * at runtime by refusing when the value changed (see ZC_SR_OK_DECL), so a
 * non-mutating callback still exits through the fast path.
 */
function hasSuperRefine(checks: readonly { kind: string }[] | undefined): boolean {
  return checks !== undefined && checks.some((c) => c.kind === "super_refine_effect");
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
/**
 * Can this tuple's output differ from a SHORT input it accepts?
 *
 * $ZodTuple runs every item even when the input is shorter, and
 * `handleTupleResults` writes each result back (`final.value[i] = r.value`)
 * unless the slot is at or past `optoutStart` and on the "optional" rung of
 * `optin` — that one ends the output where the input ended. Every other absent
 * slot lands in the output: below `optoutStart` as whatever the item made of
 * `undefined` (an own `undefined` for `z.string().optional()`, "c" for
 * `.catch("c")`), at or past it as a substituted value (a "defaulted" item).
 * `z.tuple([z.string(), z.number().default(1)])` therefore answers `["x"]` with
 * `["x", 1]`, length 2, and `z.tuple([z.any()]).rest(z.number())` answers `[]`
 * with `[undefined]`. So the tuple is a mutating node — its output is not its
 * input — exactly when some slot that CAN be absent is not a truncating one.
 * Without a rest element only slots from `optStart` on can be absent (a shorter
 * input is `too_small`); with one, any slot can.
 */
export function tupleRewritesShortInput(ir: SchemaIR & { type: "tuple" }): boolean {
  const len = ir.items.length;
  const optoutStart = ir.optoutStart ?? len;
  const optionalIn = ir.optionalIn ?? [];
  for (let i = ir.rest === null ? ir.optStart : 0; i < len; i++) {
    if (i < optoutStart || !optionalIn.includes(i)) return true;
  }
  return false;
}

export function hasMutation(ir: SchemaIR): boolean {
  switch (ir.type) {
    case "string":
      // url checks trim (and optionally normalize) the value; overwrite
      // effects (.trim(), .toLowerCase()) rewrite it.
      return (
        ir.coerce === true ||
        hasSuperRefine(ir.checks) ||
        ir.checks.some(
          (c) =>
            c.kind === "overwrite_effect" || (c.kind === "string_format" && c.format === "url"),
        )
      );
    case "number":
      return ir.coerce === true || hasSuperRefine(ir.checks);
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
      return (
        ir.stripUnknownKeys === true ||
        hasSuperRefine(ir.checks) ||
        (ir.catchall !== undefined && hasMutation(ir.catchall)) ||
        Object.values(ir.properties).some((p) => hasMutation(p))
      );
    case "array":
      return hasSuperRefine(ir.checks) || hasMutation(ir.element);
    case "tuple":
      return (
        ir.items.some(hasMutation) ||
        (ir.rest !== null && hasMutation(ir.rest)) ||
        tupleRewritesShortInput(ir)
      );
    case "record":
      return hasMutation(ir.valueType);
    // A freezing readonly produces a value that is not its input, exactly as a
    // strip object does — so it must never take a by-reference shortcut.
    case "readonly":
      return ir.freeze === true || hasMutation(ir.inner);
    case "optional":
    case "nullable":
    case "recursionTarget":
    case "zodDelegate":
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
 * Is a defaulted property's key guaranteed to appear in the stripped output?
 *
 * Distinct from {@link rejectsUndefined}, which asks whether `undefined` is
 * REJECTED — a `.default()` accepts it and yet still produces a defined value, so
 * only this question earns the key a slot in the output object literal. The two
 * answers coincide everywhere else.
 *
 * Sound for both branches of a default: the substituted value is defined
 * (`alwaysDefined`, checked against the schema at extraction time), and the inner
 * branch runs only when `input[key] !== undefined`, which implies `key in input`
 * — so zod's presence test keeps the key whatever the inner produced.
 */
export function outputAlwaysDefined(ir: SchemaIR): boolean {
  return ir.type === "default" ? ir.alwaysDefined === true : rejectsUndefined(ir);
}

/**
 * Does this schema reject `undefined` outright?
 *
 * Read as "does an absent key already fail on its own" by the object extractor,
 * which otherwise has to report the absence itself (zod's `nonoptional`
 * issue), and as "is a fixed-length rebuild exact" by the tuple build.
 * Conservative: anything that might accept, produce, or default to `undefined`
 * answers false.
 */
export function rejectsUndefined(ir: SchemaIR): boolean {
  switch (ir.type) {
    // Coercion turns undefined into a value (`String(undefined)`), so a
    // coercing primitive is NOT a rejector.
    case "string":
    case "number":
    case "boolean":
    case "bigint":
    case "date":
      return ir.coerce !== true;
    case "symbol":
    case "null":
    case "nan":
    case "never":
    case "enum":
    case "object":
    case "array":
    case "tuple":
    case "record":
    case "set":
    case "map":
    case "file":
    case "templateLiteral":
    case "discriminatedUnion":
    case "stringBool":
      return true;
    case "literal":
      return !ir.values.includes(undefined);
    case "union":
      return ir.options.every(rejectsUndefined);
    case "intersection":
      return rejectsUndefined(ir.left) || rejectsUndefined(ir.right);
    case "nullable":
    case "readonly":
    case "recursionTarget":
    case "zodDelegate":
      return rejectsUndefined(ir.inner);
    default:
      // optional / any / unknown / undefined / void / default / catch /
      // fallback / effect / pipe / recursiveRef — each can yield undefined,
      // or is opaque enough that we must not assume otherwise.
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
