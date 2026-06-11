import type { SchemaIR } from "../../types.js";
import type { ExtractorContext, ZodDef } from "../types.js";

export function extractDefault(def: ZodDef, ctx: ExtractorContext): SchemaIR {
  const inner = ctx.visit(def.innerType, "._zod.def.innerType");
  if (ctx.refs) {
    const refIndex = ctx.refs.length;
    ctx.refs.push({ schema: ctx.schema, accessPath: ctx.path });
    return { type: "default", inner, refIndex };
  }

  // Without fallback tracking, default values cannot be safely referenced at runtime.
  return ctx.fallback("unsupported");
}
