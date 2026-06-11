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
 * Finalization helper. Inline mode (CLI emitter) declares it once per compiled
 * file; lean mode (all unplugin bundlers) exports it once per bundle from the
 * plugin-materialized runtime module.
 * Processes issues (adds messages, strips input) and returns SafeParseResult.
 * Each generated safeParse function calls __zcFin(_e, _d) instead of inlining this logic.
 *
 * The locale default (__zcMsg) is applied ONLY when an issue carries no message,
 * mirroring Zod's precedence: check/schema-level custom messages baked into
 * generated issues — and messages on issues copied from fallback sub-schemas —
 * must never be overwritten by the locale map.
 *
 * The whole finalization (message fill, input strip, ZodError construction)
 * runs lazily inside a cached accessor (zod v3's safeParse trick): zod v4's
 * $ZodError initializer JSON.stringifies all issues into `message` and
 * $ZodRealError's Error parent captures a stack trace — paying that (plus a
 * locale __zcMsg call per issue) on every failed safeParse dominates
 * invalid-input cost when callers never read `.error`. The issues array is
 * only observable through `.error`, so deferring is safe.
 */
export const FIN_DECL =
  'function __zcFin(e,d){if(!e.length)return{success:true,data:d};var c;return{success:false,get error(){if(c)return c;for(var i=0;i<e.length;i++){if(e[i].message===undefined&&typeof __zcMsg==="function")e[i].message=__zcMsg(e[i]);e[i].input=undefined;}return c=new __zcZodError(e);}};}';

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
export const FIN_DEFERRED_DECL =
  'function __zcFinD(f,inp){var c;return{success:false,get error(){if(c)return c;var e=f(inp);for(var i=0;i<e.length;i++){if(e[i].message===undefined&&typeof __zcMsg==="function")e[i].message=__zcMsg(e[i]);e[i].input=undefined;}return c=new __zcZodError(e);}};}';

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
 */
export const MK_VALIDATOR_DECL =
  "function __zcMkv(fn,schema,fc){var w=schema||{};w.parse=fc?function(input){if(fc(input))return input;var r=fn(input);if(r.success)return r.data;throw r.error;}:function(input){var r=fn(input);if(r.success)return r.data;throw r.error;};w.safeParse=fn;w.safeParseAsync=function(input){return Promise.resolve(fn(input));};w.parseAsync=fc?function(input){if(fc(input))return Promise.resolve(input);var r=fn(input);if(r.success)return Promise.resolve(r.data);return Promise.reject(r.error);}:function(input){var r=fn(input);if(r.success)return Promise.resolve(r.data);return Promise.reject(r.error);};return w;}";

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

  return [
    "/* @__PURE__ */ (() => {",
    ...(refEntries.length > 0
      ? [`var __rf=[${refEntries.map((fb) => `${schemaExpr}${fb.accessPath}`).join(",")}];`]
      : []),
    ...codegenResult.code
      .split("\n")
      .filter((l) => l.trim() !== "" && l.trim() !== "/* zod-compiler */"),
    codegenResult.functionDef,
    `return __zcMkv(${fnName},${schemaArg},${fcArg});`,
    "})()",
  ].join("\n");
}
