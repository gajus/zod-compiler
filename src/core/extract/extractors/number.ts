import type { CheckOrEffectIR, SchemaIR } from "../../types.js";
import { extractChecks, resolveCheckMessage } from "../checks.js";
import type { ExtractorContext, ZodDef } from "../types.js";

/** Check kinds the number codegen knows how to emit. Anything else → fallback. */
const NUMBER_CHECK_KINDS = new Set([
  "greater_than",
  "less_than",
  "multiple_of",
  "number_format",
  "refine_effect",
]);

export function extractNumber(def: ZodDef, ctx: ExtractorContext): SchemaIR {
  const coerce = def.coerce ? { coerce: true as const } : {};
  const allChecks: CheckOrEffectIR[] = [];

  // Number format schemas (z.int(), z.int32(), ...): the schema def doubles as
  // its own check def. Schema-level custom error applies to the format issue.
  if (def.check === "number_format" && def.format) {
    const resolved = resolveCheckMessage(def.error);
    if (resolved.kind === "dynamic") return ctx.fallback("refine");
    allChecks.push({
      kind: "number_format",
      format: def.format as "safeint" | "int32" | "uint32" | "float32" | "float64",
      ...(resolved.kind === "static" ? { message: resolved.message } : {}),
    });
  }

  // Appended checks (.min(), .refine(), ... — also present on format schemas
  // like z.int().refine(fn), which previously lost them entirely).
  if (def.checks && def.checks.length > 0) {
    const { checkIRs, hasFallback } = extractChecks(def.checks);
    if (hasFallback) return ctx.fallback("refine");
    allChecks.push(...checkIRs);
  }

  if (allChecks.some((c) => !NUMBER_CHECK_KINDS.has(c.kind))) {
    return ctx.fallback("unsupported");
  }

  return { type: "number", checks: allChecks, ...coerce };
}
