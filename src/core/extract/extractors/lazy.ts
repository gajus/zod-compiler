import type { SchemaIR } from "../../types.js";
import type { ExtractorContext, ZodSchema } from "../types.js";

export function extractLazy(_def: unknown, ctx: ExtractorContext): SchemaIR {
  const schema = ctx.schema as ZodSchema;
  const innerSchema = schema._zod.innerType;
  if (!innerSchema) {
    return ctx.fallback("lazy");
  }
  // Cycle detected: the resolved schema is already being extracted.
  if (ctx.visiting.has(innerSchema)) {
    // recursiveRef codegen re-invokes the ROOT safeParse function, so it is
    // only correct when the cycle target IS the root schema's resolution
    // (a directly self-recursive lazy at the top). A cycle back to an inner
    // node (recursive schema nested in a wrapper, mutual recursion) would
    // validate against the wrong shape — delegate to Zod.
    const root = ctx.visiting.values().next().value as ZodSchema | undefined;
    const rootResolved = root?._zod?.def?.type === "lazy" ? root._zod.innerType : root;
    if (rootResolved === innerSchema) {
      return { type: "recursiveRef" };
    }
    return ctx.fallback("lazy");
  }
  return ctx.visit(innerSchema, "._zod.innerType");
}
