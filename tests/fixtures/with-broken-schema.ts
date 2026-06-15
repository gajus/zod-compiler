import { z } from "zod";
import { compile } from "zod-compiler";

const GoodSchema = z.string();
export const goodValidator = compile(GoodSchema);

// Manually create a broken compiled schema that passes isCompiledSchema
// but fails during extractSchema (schema property is null)
const brokenCompiled = { schema: null };
Object.defineProperty(brokenCompiled, Symbol.for("zod-compiler:compiled"), {
  value: true,
  enumerable: false,
});
export const brokenValidator = brokenCompiled;
