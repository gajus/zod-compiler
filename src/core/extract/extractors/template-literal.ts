import type { SchemaIR } from "../../types.js";
import type { ExtractorContext, ZodSchema } from "../types.js";

export function extractTemplateLiteral(_def: unknown, ctx: ExtractorContext): SchemaIR {
  const schema = ctx.schema as ZodSchema;
  const pattern = schema._zod.pattern;
  if (!pattern) return ctx.fallback("unsupported");
  return { type: "templateLiteral", pattern: pattern.source };
}
