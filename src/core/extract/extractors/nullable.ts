import type { Extractor } from "../types.js";

export const extractNullable: Extractor = (def, ctx) => ({
  type: "nullable",
  inner: ctx.visit(def.innerType, "._zod.def.innerType"),
});
