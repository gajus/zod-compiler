import type { FileCheckIR, SchemaIR } from "../../types.js";
import { hasUncompilableModifiers, resolveCheckMessage } from "../checks.js";
import type { ExtractorContext, ZodDef } from "../types.js";

export function extractFile(def: ZodDef, ctx: ExtractorContext): SchemaIR {
  const fileChecks: FileCheckIR[] = [];
  if (def.checks) {
    for (const check of def.checks) {
      const checkDef = check._zod?.def;
      if (!checkDef) continue;
      if (hasUncompilableModifiers(checkDef)) return ctx.fallback("refine");
      const resolved = resolveCheckMessage(checkDef.error);
      if (resolved.kind === "dynamic") return ctx.fallback("refine");
      const message = resolved.kind === "static" ? { message: resolved.message } : {};
      if (checkDef.check === "min_size") {
        fileChecks.push({ kind: "min_size", minimum: checkDef.minimum, ...message });
      } else if (checkDef.check === "max_size") {
        fileChecks.push({ kind: "max_size", maximum: checkDef.maximum, ...message });
      } else if (checkDef.check === "mime_type") {
        fileChecks.push({ kind: "mime_type", mime: [...checkDef.mime], ...message });
      } else {
        return ctx.fallback("refine");
      }
    }
  }
  return { type: "file", ...(fileChecks.length > 0 ? { checks: fileChecks } : {}) };
}
