import type { DateCheckIR, SchemaIR } from "../../types.js";
import { hasUncompilableModifiers, resolveCheckMessage } from "../checks.js";
import type { ExtractorContext, ZodDef } from "../types.js";

export function extractDate(def: ZodDef, ctx: ExtractorContext): SchemaIR {
  const dateChecks: DateCheckIR[] = [];
  if (def.checks) {
    for (const check of def.checks) {
      const checkDef = check._zod?.def;
      if (!checkDef) continue;
      if (hasUncompilableModifiers(checkDef)) return ctx.fallback("refine");
      const resolved = resolveCheckMessage(checkDef.error);
      if (resolved.kind === "dynamic") return ctx.fallback("refine");
      const message = resolved.kind === "static" ? { message: resolved.message } : {};
      if (checkDef.check === "greater_than") {
        const v = checkDef.value as unknown as string;
        const ts = new Date(v).getTime();
        if (Number.isNaN(ts)) return ctx.fallback("unsupported");
        dateChecks.push({
          kind: "date_greater_than",
          value: String(v),
          timestamp: ts,
          inclusive: checkDef.inclusive,
          ...message,
        });
      } else if (checkDef.check === "less_than") {
        const v = checkDef.value as unknown as string;
        const ts = new Date(v).getTime();
        if (Number.isNaN(ts)) return ctx.fallback("unsupported");
        dateChecks.push({
          kind: "date_less_than",
          value: String(v),
          timestamp: ts,
          inclusive: checkDef.inclusive,
          ...message,
        });
      } else {
        // Unknown check (custom refine, overwrite, ...) — never drop silently.
        return ctx.fallback("refine");
      }
    }
  }
  return { type: "date", checks: dateChecks, ...(def.coerce ? { coerce: true } : {}) };
}
