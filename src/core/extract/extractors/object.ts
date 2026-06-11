import type { RefineEffectCheckIR, SchemaIR } from "../../types.js";
import { extractChecks } from "../checks.js";
import type { ExtractorContext, ZodDef } from "../types.js";

export function extractObject(def: ZodDef, ctx: ExtractorContext): SchemaIR {
  // Unknown-key policies:
  // - z.strictObject / .strict() / .catchall(z.never()) reject unknown keys —
  //   compiled as a for-in membership pass (ObjectIR.strict). Pass-through is
  //   preserved: valid strict data has no extras, so no clone is needed.
  // - z.looseObject (catchall: unknown/any) matches compiled pass-through.
  // - .catchall(schema) validates unknown keys against a schema — fallback.
  const catchallType = def.catchall?._zod?.def?.type;
  const strict = catchallType === "never";
  if (def.catchall && !strict && catchallType !== "unknown" && catchallType !== "any") {
    return ctx.fallback("unsupported");
  }
  const strictFlag = strict ? { strict: true } : {};

  const properties: Record<string, SchemaIR> = {};
  // Fallback props whose zod schema is optional-out: mirror zod's
  // handlePropertyResult, which suppresses issues for ABSENT keys (this is
  // how z.exactOptional() accepts missing keys while rejecting explicit
  // undefined). Compiled optional/default IRs already handle absence.
  const suppressAbsentKeys: string[] = [];
  const refMark = ctx.refs?.length ?? 0;
  for (const [key, value] of Object.entries(def.shape)) {
    const propIR = ctx.visit(value, `.shape[${JSON.stringify(key)}]`);
    properties[key] = propIR;
    if (propIR.type === "fallback" && value._zod.optout === "optional") {
      suppressAbsentKeys.push(key);
    }
  }

  // Fallback coalescing: when EVERY property delegates to Zod, the per-field
  // wrapper (clone + N safeParse calls + issue path rewrites) is pure overhead
  // — measured ~1.4x slower than letting Zod validate the object in one pass.
  // Delegate the whole object instead. The discarded property fallbacks'
  // ref-table entries are rolled back so __rf[] holds only live schemas.
  const propIRs = Object.values(properties);
  if (propIRs.length > 0 && propIRs.every((p) => p.type === "fallback")) {
    if (ctx.refs) ctx.refs.length = refMark;
    return ctx.fallback("coalesced");
  }
  const suppress = suppressAbsentKeys.length > 0 ? { suppressAbsentKeys } : {};

  if (def.checks && def.checks.length > 0) {
    const { checkIRs, hasFallback } = extractChecks(def.checks);
    if (hasFallback) return ctx.fallback("refine");
    // Object codegen only supports refine effects; anything else (overwrite,
    // exotic .check() entries) must not be dropped.
    if (checkIRs.some((c) => c.kind !== "refine_effect")) {
      return ctx.fallback("unsupported");
    }
    const refineChecks = checkIRs.filter((c): c is RefineEffectCheckIR => {
      return c.kind === "refine_effect";
    });
    if (refineChecks.length > 0) {
      return { type: "object", properties, checks: refineChecks, ...strictFlag, ...suppress };
    }
  }
  return { type: "object", properties, ...strictFlag, ...suppress };
}
