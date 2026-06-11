import { z } from "zod";
import { compile } from "#src/core/compile.js";

// Use captured variables to ensure fallback (zero-capture transforms are now compiled)
const upperCase = true;
const radix = 10;
const MultiTransformSchema = z.object({
  name: z.string().transform((v) => (upperCase ? v.toUpperCase() : v)),
  value: z.string().transform((v) => Number.parseInt(v, radix)),
  label: z.string(),
});

export const validateMulti = compile(MultiTransformSchema);
