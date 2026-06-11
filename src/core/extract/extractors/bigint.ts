import type { BigIntCheckIR, SchemaIR } from "../../types.js";
import { hasUncompilableModifiers, resolveCheckMessage } from "../checks.js";
import type { ExtractorContext, ZodDef } from "../types.js";

/** Mirrors zod's util.BIGINT_FORMAT_RANGES — inclusive [min, max] per format. */
const BIGINT_FORMAT_RANGES: Record<string, [string, string]> = {
  int64: ["-9223372036854775808", "9223372036854775807"],
  uint64: ["0", "18446744073709551615"],
};

export function extractBigint(def: ZodDef, ctx: ExtractorContext): SchemaIR {
  const bigintChecks: BigIntCheckIR[] = [];

  // BigInt format schemas (z.int64(), z.uint64()): the schema def doubles as
  // its own check def — synthesize the range checks it enforces.
  if (def.check === "bigint_format" && def.format) {
    const range = BIGINT_FORMAT_RANGES[def.format];
    if (!range) return ctx.fallback("unsupported");
    const resolved = resolveCheckMessage(def.error);
    if (resolved.kind === "dynamic") return ctx.fallback("refine");
    const message = resolved.kind === "static" ? { message: resolved.message } : {};
    bigintChecks.push({
      kind: "bigint_greater_than",
      value: range[0],
      inclusive: true,
      ...message,
    });
    bigintChecks.push({ kind: "bigint_less_than", value: range[1], inclusive: true, ...message });
  }

  if (def.checks) {
    for (const check of def.checks) {
      const checkDef = check._zod?.def;
      if (!checkDef) continue;
      if (hasUncompilableModifiers(checkDef)) return ctx.fallback("refine");
      const resolved = resolveCheckMessage(checkDef.error);
      if (resolved.kind === "dynamic") return ctx.fallback("refine");
      const message = resolved.kind === "static" ? { message: resolved.message } : {};
      switch (checkDef.check) {
        case "greater_than":
          bigintChecks.push({
            kind: "bigint_greater_than",
            value: String(checkDef.value),
            inclusive: checkDef.inclusive,
            ...message,
          });
          break;
        case "less_than":
          bigintChecks.push({
            kind: "bigint_less_than",
            value: String(checkDef.value),
            inclusive: checkDef.inclusive,
            ...message,
          });
          break;
        case "multiple_of":
          bigintChecks.push({
            kind: "bigint_multiple_of",
            value: String(checkDef.value),
            ...message,
          });
          break;
        default:
          // Unknown check (custom refine, overwrite, ...) — never drop silently.
          return ctx.fallback("refine");
      }
    }
  }

  return { type: "bigint", checks: bigintChecks, ...(def.coerce ? { coerce: true } : {}) };
}
