import { innerAppliesDefaultOnUndefined } from "../../codegen/schemas/optional.js";
import type { Extractor, ZodSchema } from "../types.js";

export const extractOptional: Extractor = (def, ctx) => {
  // z.exactOptional() shares def.type "optional" but rejects explicit
  // `undefined` (only a missing key is allowed) — compiled optionals accept
  // undefined, so delegate to Zod. Detectable only via constructor traits.
  const traits = (ctx.schema as ZodSchema | undefined)?._zod?.traits;
  if (traits?.has("$ZodExactOptional")) {
    return ctx.fallback("unsupported");
  }
  const inner = ctx.visit(def.innerType, "._zod.def.innerType");

  // `$ZodOptional.parse` short-circuits `undefined` unless the inner schema is
  // on the "defaulted" rung of `optin`:
  //
  //   if (payload.value === undefined) {
  //     if (def.innerType._zod.optin !== "defaulted") return payload;   // short-circuit
  //     return handleOptionalResult(payload, innerType._zod.run({ value: undefined, issues: [] }, ctx));
  //   }
  //   return innerType._zod.run(payload, ctx);
  //
  // Compiled output models the short-circuit, plus the one defaulted case that
  // matters in practice: a `.default()` beneath, which must SEE the undefined so
  // the default fires (`z.string().default("d").optional()` is "d", not
  // undefined) and which can never fail on it.
  //
  // Every other defaulted inner — `z.prefault()`, `.catch()` over a default, a
  // union with a defaulted option — runs on a payload of its own, and
  // `handleOptionalResult` then yields `undefined` WITHOUT issues when that run
  // failed (`z.string().min(5).prefault("ab").optional()` parses `undefined` to
  // `undefined`). Those shapes extract to an opaque `fallback` or a union
  // anyway, and the swallow has no counterpart in the compiled optional, so
  // delegate the whole optional to zod rather than emit the inner twice.
  const innerDefaulted = (def.innerType as ZodSchema | undefined)?._zod?.optin === "defaulted";
  if (innerDefaulted && !innerAppliesDefaultOnUndefined(inner)) {
    return ctx.fallback("unsupported");
  }

  return { type: "optional", inner };
};
