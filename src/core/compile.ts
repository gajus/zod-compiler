import type { output, ZodType } from "zod";
import type { CompiledSchema } from "./types.js";

const COMPILED_MARKER = Symbol.for("zod-compiler:compiled");

/**
 * Dev-time fallback: returns the ORIGINAL schema object, augmented with a
 * non-enumerable `schema` self-reference (CLI emitter discovery reads
 * `(__src_X as any).schema`) and the compiled marker.
 *
 * Identity preservation is load-bearing: zod v4 keys toJSONSchema's
 * processing context and globalRegistry/.meta() on schema object identity —
 * an Object.create facade crashes toJSONSchema the moment the compiled
 * schema is composed into another schema, and silently loses .meta()
 * metadata. parse/safeParse/... remain the schema's own zod methods.
 */
function createFallback<T>(zodSchema: unknown): CompiledSchema<T> {
  const facade = zodSchema as CompiledSchema<T>;
  if (!("schema" in (facade as object))) {
    Object.defineProperty(facade, "schema", { value: zodSchema, enumerable: false });
  }
  return facade;
}

/**
 * Compile a Zod schema into an optimized validator.
 *
 * At dev-time, falls back to Zod's runtime validation: the schema itself is
 * returned (identity-preserving for toJSONSchema/.meta()), tagged with the
 * compiled marker so build-time discovery can find it.
 * After `npx zod-compiler generate`, import from the `.compiled.ts` file instead.
 *
 * The return type is `T & CompiledSchema<output<T>>`, preserving the original
 * Zod schema type for compatibility with libraries like `@hono/zod-validator`.
 */
export function compile<T extends ZodType>(zodSchema: T): T & CompiledSchema<output<T>> {
  const result = createFallback<output<T>>(zodSchema);
  if (!(COMPILED_MARKER in (result as object))) {
    Object.defineProperty(result, COMPILED_MARKER, { value: true, enumerable: false });
  }
  return result as T & CompiledSchema<output<T>>;
}

/**
 * Check if a value is a CompiledSchema created by compile().
 * Used by the CLI to discover schemas in source files.
 */
export function isCompiledSchema(value: unknown): value is CompiledSchema<unknown> {
  return typeof value === "object" && value !== null && COMPILED_MARKER in value;
}
