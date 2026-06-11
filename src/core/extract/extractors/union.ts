import type { SchemaIR } from "../../types.js";
import type { ExtractorContext, ZodDef, ZodSchema } from "../types.js";

export function extractUnion(def: ZodDef, ctx: ExtractorContext): SchemaIR {
  // z.xor(): exactly-one-match semantics (def.inclusive === false without a
  // discriminator). Compiled plain unions accept any match — delegate to Zod.
  // Discriminated unions also carry inclusive:false, but their compiled
  // switch dispatch is exclusive by construction.
  if (def.inclusive === false && !def.discriminator) {
    return ctx.fallback("unsupported");
  }
  if (def.discriminator) {
    // zod's `_zod.propValues[discriminator]` is the authoritative dispatch
    // table — it covers literal AND enum discriminators with typed values.
    // An option without resolvable values would be unreachable in the
    // compiled switch (rejecting valid input) — fall back instead.
    const cases: {
      value: string | number | boolean | null | bigint | undefined;
      option: number;
    }[] = [];
    for (let i = 0; i < def.options.length; i++) {
      const opt = def.options[i] as ZodSchema;
      const propValues = opt._zod.propValues?.[def.discriminator];
      if (!propValues || propValues.size === 0) {
        return ctx.fallback("unsupported");
      }
      for (const v of propValues) {
        if (
          v !== null &&
          v !== undefined &&
          typeof v !== "string" &&
          typeof v !== "number" &&
          typeof v !== "boolean" &&
          typeof v !== "bigint"
        ) {
          return ctx.fallback("unsupported");
        }
        cases.push({
          value: v as string | number | boolean | null | bigint | undefined,
          option: i,
        });
      }
    }
    const options = def.options.map((opt, i) => ctx.visit(opt, `._zod.def.options[${i}]`));
    return { type: "discriminatedUnion", discriminator: def.discriminator, options, cases };
  }
  return {
    type: "union",
    options: def.options.map((opt, i) => ctx.visit(opt, `._zod.def.options[${i}]`)),
  };
}
