import type { SchemaIR } from "../../types.js";
import { extractChecks } from "../checks.js";
import type { ExtractorContext, ZodDef } from "../types.js";

/** Check kinds the array codegen knows how to emit. Anything else → fallback. */
const ARRAY_CHECK_KINDS = new Set(["min_length", "max_length", "length_equals", "refine_effect"]);

export function extractArray(def: ZodDef, ctx: ExtractorContext): SchemaIR {
  const element = ctx.visit(def.element, "._zod.def.element");
  if (!def.checks || def.checks.length === 0) {
    return { type: "array", element, checks: [] };
  }
  const { checkIRs, hasFallback } = extractChecks(def.checks);
  // Previously hasFallback was ignored here, silently dropping uncompilable
  // refinements (e.g. captured-variable .refine()) from compiled output.
  if (hasFallback) return ctx.fallback("refine");
  if (checkIRs.some((c) => !ARRAY_CHECK_KINDS.has(c.kind))) {
    return ctx.fallback("unsupported");
  }
  return { type: "array", element, checks: checkIRs };
}
