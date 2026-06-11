import type { CheckOrEffectIR, SchemaIR } from "../../types.js";
import { extractChecks } from "../checks.js";
import type { ExtractorContext, ZodCheckSchema, ZodDef } from "../types.js";

/** Check kinds the string codegen knows how to emit. Anything else → fallback. */
const STRING_CHECK_KINDS = new Set([
  "min_length",
  "max_length",
  "length_equals",
  "includes",
  "starts_with",
  "ends_with",
  "string_format",
  "refine_effect",
  "overwrite_effect",
]);

export function extractString(def: ZodDef, ctx: ExtractorContext): SchemaIR {
  const coerce = def.coerce ? { coerce: true as const } : {};
  const allChecks: CheckOrEffectIR[] = [];

  // String format schemas (z.email(), z.url(), ...): the schema def doubles as
  // its own check def (check: "string_format"). Reuse extractChecks so pattern
  // flags, url constraints, and custom messages are handled uniformly.
  if (def.check === "string_format") {
    const { checkIRs, hasFallback } = extractChecks([
      { _zod: { def } } as unknown as ZodCheckSchema,
    ]);
    if (hasFallback) return ctx.fallback("unsupported");
    allChecks.push(...checkIRs);
  }

  // Appended checks (.min(), .refine(), .trim(), ... — also present on format
  // schemas like z.email().min(5), which previously lost them entirely).
  if (def.checks && def.checks.length > 0) {
    const { checkIRs, hasFallback } = extractChecks(def.checks);
    if (hasFallback) return ctx.fallback("refine");
    allChecks.push(...checkIRs);
  }

  if (allChecks.some((c) => !STRING_CHECK_KINDS.has(c.kind))) {
    return ctx.fallback("unsupported");
  }

  return { type: "string", checks: allChecks, ...coerce };
}
