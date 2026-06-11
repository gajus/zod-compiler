import type { SchemaIR, SetCheckIR } from "../../types.js";
import { hasUncompilableModifiers, resolveCheckMessage } from "../checks.js";
import type { ExtractorContext, ZodDef } from "../types.js";

export function extractSet(def: ZodDef, ctx: ExtractorContext): SchemaIR {
  const valueType = ctx.visit(def.valueType, "._zod.def.valueType");
  const setChecks: SetCheckIR[] = [];
  if (def.checks) {
    for (const check of def.checks) {
      const checkDef = check._zod?.def;
      if (!checkDef) continue;
      if (hasUncompilableModifiers(checkDef)) return ctx.fallback("refine");
      const resolved = resolveCheckMessage(checkDef.error);
      if (resolved.kind === "dynamic") return ctx.fallback("refine");
      const message = resolved.kind === "static" ? { message: resolved.message } : {};
      if (checkDef.check === "min_size") {
        setChecks.push({ kind: "min_size", minimum: checkDef.minimum, ...message });
      } else if (checkDef.check === "max_size") {
        setChecks.push({ kind: "max_size", maximum: checkDef.maximum, ...message });
      } else if (checkDef.check === "size_equals") {
        setChecks.push({ kind: "size_equals", size: checkDef.size, ...message });
      } else {
        // Unknown check (custom refine, overwrite, ...) — never drop silently.
        return ctx.fallback("refine");
      }
    }
  }
  return { type: "set", valueType, ...(setChecks.length > 0 ? { checks: setChecks } : {}) };
}
