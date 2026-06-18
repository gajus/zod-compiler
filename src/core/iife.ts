/**
 * Shared CompiledSchema<T> IIFE generation.
 * Used by both CLI emitter and unplugin transform.
 */

import type { CompiledSchemaInfo } from "./pipeline.js";

/** Import statement required by generateIIFE output (references __zodCompilerConfig). */
export const ZOD_CONFIG_IMPORT =
  'import { config as __zodCompilerConfig, ZodRealError as __zcZodError } from "zod";';

/** File-level __zcMsg declaration (must appear once after ZOD_CONFIG_IMPORT). */
export const ZOD_MSG_DECLARATION = "var __zcMsg=__zodCompilerConfig().localeError;";

/**
 * Shared failure-result for __zcFin / __zcFinD. Inline mode (CLI emitter)
 * declares it once per compiled file; lean mode (all unplugin bundlers) declares
 * it once per bundle in the plugin-materialized runtime module (module-local —
 * generated code only ever references __zcFin/__zcFinD, never __ZcFail).
 *
 * Why a prototype getter and not `{success:false, get error(){...}}`: an object
 * literal with an inline accessor forces V8 down its slow accessor-defining
 * allocation path — ~110ns per failure, measured — which dominates the entire
 * invalid-input cost whenever callers never read `.error`. Hosting `error` on
 * the prototype turns each failure into a plain field-only instantiation (~2ns,
 * ~13x), with the lazy-cache semantics intact. (Trade-off: `error` is a
 * prototype accessor, so it no longer shows up in `Object.keys(result)` / spread
 * / JSON.stringify of the result wrapper — `.success`/`.error`/`.data` access,
 * destructuring, and `in` are unaffected.)
 *
 * One class serves both finalizers, so the instances share one hidden class:
 * __zcFin passes pre-collected issues in `_e` (with `_f===null`); __zcFinD
 * passes the hosted slow-walk in `_f` plus the input in `_i`, and the getter
 * runs the walk on first `.error` read. The whole finalization — locale fill
 * (__zcMsg applied ONLY when an issue carries no message, never overwriting a
 * baked-in custom/fallback message), input strip, and ZodError construction
 * (zod v4 JSON.stringifies every issue into `message` and captures a stack
 * trace) — stays deferred inside the cached accessor exactly as before, since
 * the issues array is observable solely through `.error`.
 */
export const FAIL_CLASS_DECL =
  "function __ZcFail(e,f,i){this.success=false;this._e=e;this._f=f;this._i=i;this._c=undefined;}" +
  'Object.defineProperty(__ZcFail.prototype,"error",{configurable:true,get:function(){' +
  "if(this._c)return this._c;" +
  "var e=this._f!==null?this._f(this._i):this._e;" +
  'for(var i=0;i<e.length;i++){if(e[i].message===undefined&&typeof __zcMsg==="function")e[i].message=__zcMsg(e[i]);e[i].input=undefined;}' +
  "return this._c=new __zcZodError(e);}});";

/** Eager finalizer (mutation / partial-fast-path schemas): issues already
 * collected in `e`; success short-circuits to a plain result literal. */
export const FIN_DECL =
  "function __zcFin(e,d){if(!e.length)return{success:true,data:d};return new __ZcFail(e,null,null);}";

/**
 * Deferred-collection finalizer for Fast-Path-eligible schemas. When the
 * fast check fails, the ENTIRE slow path (the issue-collecting re-walk) is
 * pushed into the cached `.error` accessor instead of running eagerly:
 * fast-eligible schemas never mutate, so the walk's only output is the
 * issues array, which is observable solely through `.error` — one step
 * further along the same lazy boundary `__zcFin` already established (locale
 * fill, input strip, ZodError construction). A failed safeParse whose
 * `.error` is never read costs the fast check alone.
 *
 * Takes the schema's HOSTED slow-walk function plus the input — NOT a
 * per-call closure: `__zcFinD(__sw_N, input)` allocates only the result
 * object, where `__zcFinD(function(){...})` paid a closure environment and
 * function object per failure. Hosting the walk also shrinks safeParse to
 * two statements, within V8's inlining budget (the success-path result
 * literal becomes escape-analyzable at monomorphic call sites).
 *
 * The walk re-reads `input` at `.error`-read time; a caller that mutates
 * the input between safeParse and reading `.error` sees issues for the
 * mutated value (zod materializes at parse time). Same caveat class as the
 * documented __zcFin deferral.
 */
export const FIN_DEFERRED_DECL = "function __zcFinD(f,inp){return new __ZcFail(null,f,inp);}";

/**
 * Compact-mode failure class — a lazy failure that delegates error reporting to
 * the ORIGINAL Zod schema's `safeParse`. Used by `output: "compact"`, where the
 * compiled slow walk is dropped entirely: a mutation-free schema's fast check
 * is the only generated validation, and on a fast-check failure the cold error
 * path is produced by the retained Zod schema itself (`zod` is the source of
 * truth, so the issues are byte-identical — no second validation engine).
 *
 * `_z` is the schema's PRISTINE bound safeParse (`__rf[N].safeParse.bind(...)`,
 * captured pre-`__zcMkv` by emitRfDelegate — see context.ts — so it is zod's
 * own implementation, never the compiled delegate, avoiding infinite
 * recursion). The zod parse is deferred until `.error` is read and cached, so
 * the common `safeParse(x).success`/`.is(x)` checks on invalid input cost only
 * the fast check (zod never runs) — the same deferral boundary `__zcFinD`
 * establishes for the compiled slow walk. Sound because compact mode is gated
 * on a TOTAL fast path: `fc(input) === false` ⟹ zod rejects, so `success:false`
 * holds without consulting zod.
 *
 * The getter returns zod's OWN ZodError verbatim (no locale fill / input strip /
 * re-wrap — zod already finalized it), so a delegated failure is exactly what
 * the unaltered schema would have produced.
 */
export const FAILZ_CLASS_DECL =
  "function __ZcFailZ(z,i){this.success=false;this._z=z;this._i=i;this._c=undefined;}" +
  'Object.defineProperty(__ZcFailZ.prototype,"error",{configurable:true,get:function(){' +
  "return this._c||(this._c=this._z(this._i).error);}});";

/** Compact-mode finalizer: wrap a pristine bound safeParse + input into a lazy delegated failure. */
export const FINZ_DECL = "function __zcFinZ(z,i){return new __ZcFailZ(z,i);}";

/**
 * Validator factory. Inline mode (CLI emitter) declares it once per compiled
 * file; lean mode (all unplugin bundlers) exports it once per bundle from the
 * plugin-materialized runtime module — generated code never imports it from
 * the zod-compiler package itself, so zod-compiler stays a devDependency and
 * the helper set is always version-locked to the codegen that calls it.
 * Wraps a safeParse function into the CompiledSchema interface.
 *
 * IDENTITY-PRESERVING: with zodCompat (schema != null) the compiled
 * parse/safeParse/parseAsync/safeParseAsync are installed as OWN properties
 * on the original schema object, which is returned as-is. zod v4 keys
 * several APIs on object identity — toJSONSchema's ctx.seen registers the
 * object it is handed while each processor closure captures the original
 * inst (a wrapper crashes `optionalProcessor` with "Cannot set properties
 * of undefined (setting 'ref')" the moment a compiled schema is composed
 * into another schema), and globalRegistry/.meta() is a WeakMap keyed by
 * the schema instance (a wrapper silently loses OpenAPI titles/ids). An
 * Object.create wrapper breaks both; mutating the original breaks neither
 * (zod's internal parsing flows through _zod.run, never the public
 * methods, and derived schemas — .optional(), .extend() — are fresh
 * instances that fall back to plain zod). schema=null (zodCompat: false)
 * still produces a plain method-bag object.
 *
 * fc is the schema's hosted fast-check boolean function (null when no Fast
 * Path exists). parse()/parseAsync() try it first and return the input
 * directly on success: fc is small enough for V8 to inline, so the hot parse
 * path runs with zero allocations — calling fn would allocate an intermediate
 * SafeParseResult that escape analysis cannot remove (fn never inlines).
 * Fast-path-eligible schemas never mutate, so fc(input) ⟹ data === input.
 *
 * is is the TOTAL fast-check predicate (fc when the fast path is total, else
 * null). Installed as `.is()` — a zero-allocation boolean type guard. When
 * null (partial fast path or none) `.is()` derives from fn(input).success: a
 * partial fc can pass-through valid input but its `false` does not imply
 * rejection (a default/catch may still succeed), so it would be unsound as a
 * standalone guard.
 */
export const MK_VALIDATOR_DECL =
  "function __zcMkv(fn,schema,fc,is){var w=schema||{};w.parse=fc?function(input){if(fc(input))return input;var r=fn(input);if(r.success)return r.data;throw r.error;}:function(input){var r=fn(input);if(r.success)return r.data;throw r.error;};w.safeParse=fn;w.safeParseAsync=function(input){return Promise.resolve(fn(input));};w.parseAsync=fc?function(input){if(fc(input))return Promise.resolve(input);var r=fn(input);if(r.success)return Promise.resolve(r.data);return Promise.reject(r.error);}:function(input){var r=fn(input);if(r.success)return Promise.resolve(r.data);return Promise.reject(r.error);};w.is=is||function(input){return fn(input).success;};return w;}";

function extractFunctionName(functionDef: string): string {
  const match = /^function\s+(\w+)\s*\(/.exec(functionDef);
  if (!match?.[1]) {
    throw new Error("Cannot extract function name from generated code");
  }
  return match[1];
}

/**
 * Generate a `/* @__PURE__ * /` IIFE wrapping a compiled validator.
 *
 * @param schemaExpr - Expression resolving to the original Zod schema
 *   (e.g. `"UserSchema"` in unplugin, `"(__src_X as any).schema"` in CLI)
 * @param schema
 * @param options
 */
export function generateIIFE(
  schemaExpr: string,
  schema: CompiledSchemaInfo,
  options?: { zodCompat?: boolean | undefined },
): string {
  const { codegenResult, refEntries } = schema;
  const fnName = extractFunctionName(codegenResult.functionDef);
  const zodCompat = options?.zodCompat !== false;
  const schemaArg = zodCompat ? schemaExpr : "null";
  const fcArg = codegenResult.fastFnName ?? "null";
  // `.is()` gets the fast-check directly only when it is a total predicate;
  // partial/none falls back to safeParse().success inside __zcMkv.
  const isArg = codegenResult.fastTotal ? fcArg : "null";

  return [
    "/* @__PURE__ */ (() => {",
    ...(refEntries.length > 0
      ? [`var __rf=[${refEntries.map((fb) => `${schemaExpr}${fb.accessPath}`).join(",")}];`]
      : []),
    ...codegenResult.code
      .split("\n")
      .filter((l) => l.trim() !== "" && l.trim() !== "/* zod-compiler */"),
    codegenResult.functionDef,
    `return __zcMkv(${fnName},${schemaArg},${fcArg},${isArg});`,
    "})()",
  ].join("\n");
}
