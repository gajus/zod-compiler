import type { RefineEffectCheckIR, SchemaIR, SuperRefineEffectCheckIR } from "../../types.js";
import {
  customParamsRefRegistrar,
  extractChecks,
  payloadCheckRef,
  refineRefRegistrar,
} from "../checks.js";
import type { ExtractorContext, ZodDef } from "../types.js";

/**
 * Can this property IR raise an issue when its key is ABSENT (so the value it
 * sees is `undefined`)? Only those need zod's absent-key issue suppression
 * wrapped around them.
 *
 * `optional` and `undefined` cannot: the first short-circuits `undefined`
 * (or forwards it into a `default`, which substitutes without complaint), and
 * the second accepts it. `nullable`/`readonly` are transparent to `undefined`,
 * so they inherit the answer. Everything else — a `fallback` delegate above all
 * — is assumed to report.
 */
function reportsOnAbsentKey(ir: SchemaIR): boolean {
  switch (ir.type) {
    case "optional":
    case "undefined":
      return false;
    case "nullable":
    case "readonly":
      return reportsOnAbsentKey(ir.inner);
    default:
      return true;
  }
}

export function extractObject(def: ZodDef, ctx: ExtractorContext): SchemaIR {
  // Unknown-key policies:
  // - z.strictObject / .strict() / .catchall(z.never()) reject unknown keys —
  //   compiled as a for-in membership pass (ObjectIR.strict). Pass-through is
  //   preserved: valid strict data has no extras, so no clone is needed.
  // - z.looseObject (catchall: unknown/any) matches compiled pass-through.
  // - .catchall(schema) validates unknown keys against a schema (ObjectIR.catchall).
  // - default z.object() (no catchall): STRIPS unknown keys, as zod does
  //   (ObjectIR.stripUnknownKeys). looseObject/strictObject are unaffected —
  //   the first keeps extras by design, the second rejects them outright.
  const catchallType = def.catchall?._zod?.def?.type;
  const strict = catchallType === "never";
  const valueCatchall =
    def.catchall && !strict && catchallType !== "unknown" && catchallType !== "any"
      ? ctx.visit(def.catchall, "._zod.def.catchall")
      : undefined;
  // A delegating catchall would need zod per unknown key; hand it the object.
  if (valueCatchall?.type === "fallback") return ctx.fallback("unsupported");
  const catchallFlag = valueCatchall ? { catchall: valueCatchall } : {};
  const strictFlag = strict ? { strict: true } : {};
  const stripFlag = def.catchall ? {} : { stripUnknownKeys: true };

  // Null-prototype: on a normal object `properties["__proto__"] = ir` sets the
  // prototype instead of defining a key, so a shape declaring `__proto__` (only
  // reachable via a computed key or a dynamically built shape — an object
  // literal's `__proto__:` is the same setter) silently lost that property.
  // Every consumer reads this through Object.keys/values/entries, so dropping
  // the prototype is invisible to them.
  const properties: Record<string, SchemaIR> = Object.create(null) as Record<string, SchemaIR>;
  // Optional-OUT props: mirror zod's handlePropertyResult, which suppresses
  // issues for ABSENT keys (`if (isOptionalOut && !(key in input)) return`).
  // That is how `z.exactOptional()` accepts a missing key while rejecting an
  // explicit `undefined`.
  //
  // Gated on the property IR still being able to REPORT for an absent key, so
  // the common `.optional()` field pays nothing: its compiled form short-
  // circuits `undefined` and produces no issue to suppress. Testing
  // `propIR.type === "fallback"` — as this once did — was too narrow by exactly
  // one wrapper: `z.exactOptional(z.string()).nullable()` extracts to
  // `nullable(fallback)`, keeps `optout === "optional"` (nullable propagates
  // it), and delegated `undefined` straight into zod's exactOptional, which
  // rejects it. The object then reported an `invalid_type` for a key zod does
  // not look at.
  const suppressAbsentKeys: string[] = [];
  const refMark = ctx.refs?.length ?? 0;
  for (const [key, value] of Object.entries(def.shape)) {
    // zod never runs the schema declared under `__proto__` (its shape loop
    // skips the key outright and the output never carries it), so nothing here
    // should either: the key stays in `properties` as a recognized name for the
    // strict pass, holding a placeholder that codegen skips (see
    // parsedProperties) — the real schema is not visited, so it registers no
    // refs and cannot pull the object into a fallback.
    if (key === "__proto__") {
      properties[key] = { type: "unknown" };
      continue;
    }
    const propIR = ctx.visit(value, `.shape[${JSON.stringify(key)}]`);
    properties[key] = propIR;
    if (value._zod.optout === "optional" && reportsOnAbsentKey(propIR)) {
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
    const { checkIRs, hasFallback } = extractChecks(
      def.checks,
      refineRefRegistrar(ctx, def.checks),
      (index) => payloadCheckRef(ctx, def.checks, index),
      customParamsRefRegistrar(ctx, def.checks),
    );
    if (hasFallback) return ctx.fallback("refine");
    // Object codegen supports the two callback kinds; anything else (overwrite,
    // exotic .check() entries) must not be dropped.
    if (checkIRs.some((c) => c.kind !== "refine_effect" && c.kind !== "super_refine_effect")) {
      return ctx.fallback("unsupported");
    }
    const refineChecks = checkIRs.filter(
      (c): c is RefineEffectCheckIR | SuperRefineEffectCheckIR =>
        c.kind === "refine_effect" || c.kind === "super_refine_effect",
    );
    if (refineChecks.length > 0) {
      return {
        type: "object",
        properties,
        checks: refineChecks,
        ...strictFlag,
        ...stripFlag,
        ...catchallFlag,
        ...suppress,
      };
    }
  }
  return { type: "object", properties, ...strictFlag, ...stripFlag, ...catchallFlag, ...suppress };
}
