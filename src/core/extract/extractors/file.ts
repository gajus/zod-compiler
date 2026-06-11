import type { FileCheckIR, SchemaIR } from "../../types.js";
import type { ExtractorContext, ZodDef } from "../types.js";

export function extractFile(def: ZodDef, ctx: ExtractorContext): SchemaIR {
  const fileChecks: FileCheckIR[] = [];
  if (def.checks) {
    for (const check of def.checks) {
      const checkDef = check._zod?.def;
      if (!checkDef) continue;
      if (checkDef.check === "min_size") {
        fileChecks.push({ kind: "min_size", minimum: checkDef.minimum });
      } else if (checkDef.check === "max_size") {
        fileChecks.push({ kind: "max_size", maximum: checkDef.maximum });
      } else if (checkDef.check === "mime_type") {
        fileChecks.push({ kind: "mime_type", mime: [...checkDef.mime] });
      } else {
        return ctx.fallback("refine");
      }
    }
  }
  return { type: "file", ...(fileChecks.length > 0 ? { checks: fileChecks } : {}) };
}
