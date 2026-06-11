import { hasMutation } from "../../codegen/context.js";
import type { Extractor } from "../types.js";

export const extractIntersection: Extractor = (def, ctx) => {
  const left = ctx.visit(def.left, "._zod.def.left");
  const right = ctx.visit(def.right, "._zod.def.right");
  // Zod validates both sides on the ORIGINAL input and MERGES the results,
  // throwing on unmergable conflicts. The compiled generator runs the sides
  // sequentially on the same value — equivalent only when neither side
  // rewrites it. Mutating sides (coerce, trim, defaults, ...) delegate to Zod.
  if (hasMutation(left) || hasMutation(right)) {
    return ctx.fallback("unsupported");
  }
  return { type: "intersection", left, right };
};
