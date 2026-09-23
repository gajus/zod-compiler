/**
 * Shared CompiledSchema<T> IIFE generation.
 * Used by both CLI emitter and unplugin transform.
 */

import { RETAINED_SCHEMA_VAR } from "./codegen/context.js";
import type { CompiledSchemaInfo } from "./pipeline.js";

/**
 * Import statement required by generateIIFE output (references
 * __zodCompilerConfig). `core` is bound for $ZodAsyncError: superRefine and
 * custom callbacks may only reveal that they are async through the promise
 * they return, at which point zod's own synchronous parse raises.
 */
export const ZOD_CONFIG_IMPORT =
  'import { config as __zodCompilerConfig, core as __zcCore, ZodRealError as __zcZodError } from "zod";';

/**
 * File-level `__zcMsg` declaration (must appear once after ZOD_CONFIG_IMPORT):
 * the message an issue gets when nothing was baked into it at build time.
 *
 * Resolves zod's tail of `finalizeIssue` — `config.customError` then
 * `config.localeError` then "Invalid input" — and does it PER CALL, because the
 * config is mutable: `z.config({ localeError })` in an entry point runs after
 * the schema modules it imports, so a value snapshotted at module init misses
 * it. Reading a captured `localeError` alone also dropped `customError`
 * outright, silently ignoring the global map most i18n setups install.
 *
 * The head of zod's chain — the schema's own `error` option — is baked into the
 * issue at build time and short-circuits this. The one link that cannot be
 * reproduced is a per-CALL `ctx.error`, which would have to travel through
 * `safeParse`; that entry point sits at V8's inlining budget, where even an
 * unused extra parameter measured ~12% on every parse.
 *
 * Only ever called while building an error, never on a successful parse.
 */
export const ZOD_MSG_DECLARATION =
  'function __zcUw(m){return typeof m==="string"?m:(m===undefined||m===null?undefined:m.message);}' +
  "var __zcMsg=function(iss){var c=__zodCompilerConfig(),m;" +
  "if(c.customError){m=__zcUw(c.customError(iss));if(m!==undefined&&m!==null)return m;}" +
  "if(c.localeError){m=__zcUw(c.localeError(iss));if(m!==undefined&&m!==null)return m;}" +
  'return "Invalid input";};';

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
 *
 * `input` and `continue` are left OUT, not assigned `undefined`. Key PRESENCE is
 * observable — `"input" in issue`, `Object.keys(issue)`, object spread,
 * `toStrictEqual` against a zod issue — and zod's `util.finalizeIssue` deletes
 * `continue`, and `input` whenever `reportInput` is off, so assignment left every
 * compiled issue one enumerable key wider than zod's. Each issue is COPIED
 * without them rather than `delete`d from: removing a key that is not the last
 * one added drops the object into V8's dictionary mode, ~70 ns an issue. `.error`
 * over six issues went 1.49 -> 1.06 us, over one 653 -> 608 ns. The copy keeps
 * key order and takes own keys only, so an enumerable key added to
 * `Object.prototype` stays out, as it does from zod's spread. All of it runs only
 * after a caller asks for `.error` on a failed parse, and is memoised in `_c`.
 */
export const FAIL_CLASS_DECL =
  "function __ZcFail(e,f,i){this.success=false;this._e=e;this._f=f;this._i=i;this._c=undefined;}" +
  'Object.defineProperty(__ZcFail.prototype,"error",{configurable:true,get:function(){' +
  "if(this._c)return this._c;" +
  "var e=this._f!==null?this._f(this._i):this._e;" +
  'for(var i=0;i<e.length;i++){var s=e[i],o={},k;if(s.message===undefined&&typeof __zcMsg==="function")s.message=__zcMsg(s);' +
  'for(k in s){if(k!=="input"&&k!=="continue"&&Object.prototype.hasOwnProperty.call(s,k))o[k]=s[k];}e[i]=o;}' +
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
 * `_z` is the schema's PRISTINE safeParse method, captured by
 * emitRetainedMethod (see context.ts), and `_r` is its receiver — the `__zs`
 * binding generateIIFE places above that capture. Both are read before the
 * trailing `__zcMkv` call installs anything, so the method is zod's own
 * implementation, never the compiled delegate, avoiding infinite recursion
 * without allocating a bound function. The zod parse is deferred until `.error`
 * is read and cached, so
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
  "function __ZcFailZ(z,r,i){this.success=false;this._z=z;this._r=r;this._i=i;this._c=undefined;}" +
  'Object.defineProperty(__ZcFailZ.prototype,"error",{configurable:true,get:function(){' +
  "return this._c||(this._c=this._z.call(this._r,this._i).error);}});";

/** Compact-mode finalizer: retain a pristine safeParse, its receiver, and input lazily. */
export const FINZ_DECL = "function __zcFinZ(z,r,i){return new __ZcFailZ(z,r,i);}";

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
 *
 * parseAsync/safeParseAsync wrap the SYNC validator, which is right for every
 * schema the compiler can reproduce — none of them are async. It is wrong for
 * the ones it cannot: an `async` refinement or a `z.promise()` extracts to a
 * Zod delegate, and delegating means calling Zod's SYNCHRONOUS safeParse, which
 * raises `$ZodAsyncError` by design. Wrapping that gave the compiled schema an
 * async pair that rejected with `$ZodAsyncError` for EVERY input — including
 * valid ones — where Zod resolves normally, so `await UserSchema.parseAsync(x)`
 * stopped working the moment any part of the schema went async.
 *
 * So both are guarded: a synchronous throw hands off to the schema's ORIGINAL
 * async method, captured before these are installed — the same escape hatch
 * `~standard` already uses for its throw path, and for the same reason (the
 * compiled validator has no async mode to offer, and Zod's is exact). It also
 * fixes the smaller wart that a throwing `fn` made `parseAsync` throw
 * SYNCHRONOUSLY rather than return a rejected promise. With `zodCompat: false`
 * there is no schema to delegate to and the throw propagates as before.
 *
 * `~standard` is REPLACED, not merely preserved. Zod builds it lazily as
 * `validate: (v) => safeParse(inst, v)` — the core FUNCTION, which goes straight
 * to `inst._zod.run`. It never reads the schema's own `safeParse` property, so
 * installing the compiled one leaves this route entirely uncompiled: measured
 * 271.7 ns against the compiled 26.6 ns on the same schema, i.e. Standard Schema
 * consumers (tRPC, Hono, TanStack) were getting plain Zod.
 *
 * Zod's own `~standard` is never READ, only overwritten. Zod installs the slot
 * with `util.defineLazy` — commented there as "avoid creating objects for every
 * schema" — so it is an accessor that builds `{version, vendor, validate}` plus
 * its closure on first touch. Reading it to capture a fallback fired that getter
 * for every compiled schema while the module was still initializing.
 *
 * How much that costs depends on the entry point, and only one of them is free:
 * classic `zod` forces the slot itself during `ZodType.init` (it does
 * `Object.assign(inst["~standard"], { jsonSchema })`), so there the read hit an
 * already-built object and cost only an accessor call. `zod/mini` and raw
 * `zod/v4/core` never touch it, so for those the read built — and retained — an
 * object and a closure per schema, purely to capture a fallback the schema will
 * most likely never expose to a Standard Schema consumer.
 *
 * The throw path is rebuilt instead of captured. Zod's validate catches a
 * synchronous throw and retries through `safeParseAsync` — that is how an async
 * refinement resolves and how a throwing check surfaces as a rejected promise
 * rather than a synchronous throw — so calling the already-captured `zspa` and
 * mapping its result is the same route to the same result. `vendor` is likewise
 * a constant: schema discovery only ever admits zod schemas, and classic, mini
 * and core all hardcode `vendor: "zod"` themselves.
 *
 * Not carried over (unchanged by this, and pre-dating it): classic's
 * `~standard.jsonSchema` extension, which the replacement object has never
 * reproduced.
 *
 * Installed with defineProperty rather than assignment: Zod's lazy setter
 * redefines the slot as non-writable, so a second `__zcMkv` on the same schema
 * object — two exports aliasing one schema — would throw under ESM strict mode.
 *
 * A rebuilding schema (no `fc`) reaches `parse()` through `fn`, i.e. through a
 * SafeParseResult unwrapped a line later. Handing the build function over so
 * `parse()` could call it directly was measured and declined: the wrapper is a
 * young-generation bump allocation that V8 elides outright where `fn` inlines,
 * and even across eight schemas sharing this closure — where it cannot — the
 * direct call came out level (41.5 vs 41.8 ns), for a wider signature on every
 * bundle.
 */
export const MK_VALIDATOR_DECL =
  "function __zcMkv(fn,schema,fc,is){var w=schema||{};var zpa=w.parseAsync,zspa=w.safeParseAsync;w.parse=fc?function(input){if(fc(input))return input;var r=fn(input);if(r.success)return r.data;throw r.error;}:function(input){var r=fn(input);if(r.success)return r.data;throw r.error;};w.safeParse=fn;w.safeParseAsync=function(input){try{return Promise.resolve(fn(input));}catch(e){if(zspa)return zspa(input);throw e;}};w.parseAsync=fc?function(input){try{if(fc(input))return Promise.resolve(input);var r=fn(input);if(r.success)return Promise.resolve(r.data);return Promise.reject(r.error);}catch(e){if(zpa)return zpa(input);throw e;}}:function(input){try{var r=fn(input);if(r.success)return Promise.resolve(r.data);return Promise.reject(r.error);}catch(e){if(zpa)return zpa(input);throw e;}};w.is=is||function(input){return fn(input).success;};" +
  'Object.defineProperty(w,"~standard",{configurable:true,value:{version:1,vendor:"zod",validate:function(input){var r;try{if(fc&&fc(input))return{value:input};r=fn(input);}catch(e){if(zspa)return zspa(input).then(function(q){return q.success?{value:q.data}:{issues:q.error.issues};});throw e;}return r.success?{value:r.data}:{issues:r.error.issues};}}});' +
  "return w;}";

function extractFunctionName(functionDef: string): string {
  const match = /^function\s+(\w+)\s*\(/.exec(functionDef);
  if (!match?.[1]) {
    throw new Error("Cannot extract function name from generated code");
  }
  return match[1];
}

/**
 * Does the IIFE's preamble DEREFERENCE the retained schema at evaluation time?
 *
 * Only `__rf` does: every entry is `__zs<accessPath>`, and an access path walks
 * the schema's structure — `._zod.innerType` fires a `z.lazy()` getter,
 * `.shape` materializes a `z.object()` shape (zod v4 reads every property
 * descriptor, so ONE `.shape` read fires ALL of an object's recursion getters).
 * Binding `__zs` itself does not: constructing the schema leaves deferred
 * callbacks unforced, and `usesRetainedSchema`'s only read is `__zs.safeParse`,
 * a prototype getter that binds the method and installs the bound copy on the
 * instance without touching the schema's structure.
 *
 * The distinction decides whether the IIFE may be evaluated inside the
 * INITIALIZER of the binding the schema's own deferred callbacks close over —
 * see the self-referential path in the unplugin's autoDiscover rewrite.
 */
export function iifeDerefsSchema(schema: CompiledSchemaInfo): boolean {
  return schema.refEntries.length > 0;
}

/**
 * Generate a `/* @__PURE__ * /` IIFE wrapping a compiled validator.
 *
 * @param schemaExpr - Expression resolving to the original Zod schema
 *   (e.g. `"UserSchema"` in unplugin, `"(__src_X as any).schema"` in CLI)
 * @param schema
 * @param options - `pure: false` drops the `/* @__PURE__ * /` annotation, for
 *   the one caller that emits the IIFE as a STATEMENT following the
 *   declaration rather than as its initializer: there the call's whole point is
 *   its side effect (`__zcMkv` installing the compiled methods on the schema),
 *   and a bundler that believed it pure would drop the compilation outright.
 */
export function generateIIFE(
  schemaExpr: string,
  schema: CompiledSchemaInfo,
  options?: { zodCompat?: boolean | undefined; pure?: boolean | undefined },
): string {
  const { codegenResult, refEntries } = schema;
  const fnName = extractFunctionName(codegenResult.functionDef);
  const zodCompat = options?.zodCompat !== false;
  // Every fallback access starts from the same source schema, and compact
  // delegation names it outright. Capture it once whenever either needs it, so
  // an inline initializer is not reconstructed for each path and again for the
  // identity-preserving __zcMkv target.
  const bindsSchema = refEntries.length > 0 || codegenResult.usesRetainedSchema === true;
  const retainedSchema = bindsSchema ? RETAINED_SCHEMA_VAR : schemaExpr;
  const schemaArg = zodCompat ? retainedSchema : "null";
  const fcArg = codegenResult.fastFnName ?? "null";
  // `.is()` gets the fast-check directly only when it is a total predicate;
  // partial/none falls back to safeParse().success inside __zcMkv. A rebuilding
  // schema has no by-reference `fc` but still names its predicate separately.
  const isArg = codegenResult.isFnName ?? (codegenResult.fastTotal ? fcArg : "null");

  return [
    options?.pure === false ? "(() => {" : "/* @__PURE__ */ (() => {",
    ...(bindsSchema ? [`var ${RETAINED_SCHEMA_VAR}=${schemaExpr};`] : []),
    // Only fallback refs need the array; a compact validator with none of its
    // own reads `__zs` directly rather than allocating `[__zs]` to index into.
    ...(refEntries.length > 0
      ? [`var __rf=[${refEntries.map((fb) => `${retainedSchema}${fb.accessPath}`).join(",")}];`]
      : []),
    ...codegenResult.code
      .split("\n")
      .filter((l) => l.trim() !== "" && l.trim() !== "/* zod-compiler */"),
    codegenResult.functionDef,
    `return __zcMkv(${fnName},${schemaArg},${fcArg},${isArg});`,
    "})()",
  ].join("\n");
}
