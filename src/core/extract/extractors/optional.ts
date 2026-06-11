import type { Extractor, ZodSchema } from "../types.js";

export const extractOptional: Extractor = (def, ctx) => {
  // z.exactOptional() shares def.type "optional" but rejects explicit
  // `undefined` (only a missing key is allowed) — compiled optionals accept
  // undefined, so delegate to Zod. Detectable only via constructor traits.
  const traits = (ctx.schema as ZodSchema | undefined)?._zod?.traits;
  if (traits?.has("$ZodExactOptional")) {
    return ctx.fallback("unsupported");
  }
  return {
    type: "optional",
    inner: ctx.visit(def.innerType, "._zod.def.innerType"),
  };
};
