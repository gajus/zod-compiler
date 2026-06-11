import type { SchemaIR } from "../../types.js";
import type { ExtractorContext, ZodDef } from "../types.js";

/**
 * z.catch(): the catch value is computed PER PARSE in Zod — it may be a
 * function reading the failure ctx ({ value, issues, error, input }) or an
 * impure factory (() => new Date()). Baking a build-time evaluation would
 * freeze those, so the compiled validator calls the original schema's
 * catchValue at runtime through the __rf table (same mechanism as default).
 */
export function extractCatch(def: ZodDef, ctx: ExtractorContext): SchemaIR {
  const inner = ctx.visit(def.innerType, "._zod.def.innerType");
  if (inner.type === "fallback") return ctx.fallback("unsupported");

  if (ctx.refs) {
    const refIndex = ctx.refs.length;
    ctx.refs.push({ schema: ctx.schema, accessPath: ctx.path });
    return { type: "catch", inner, refIndex };
  }

  // Without fallback tracking, the runtime catchValue cannot be referenced.
  return ctx.fallback("unsupported");
}
