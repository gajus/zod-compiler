import { z } from "zod";
import { compile } from "#src/core/compile.js";

// Use a captured variable to ensure fallback (zero-capture transforms are now compiled)
const radix = 10;
const TransformSchema = z.object({
  name: z.string(),
  value: z.string().transform((v) => Number.parseInt(v, radix)),
});

export const validateTransform = compile(TransformSchema);
