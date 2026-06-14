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
  // A plain union of exactly one option IS that option: zod surfaces the single
  // option's issues directly (no invalid_union wrapper) and ignores a union-level
  // `{ error }`. Collapsing union([X]) → X matches that exactly — and avoids the
  // wrapper the slow path would otherwise emit when the sole option aborts
  // (invalid_type), which diverged from zod's inner message. When the union
  // carries its own `error`, delegate to zod instead: dispatch() would re-apply
  // it as the collapsed node's typeMessage, but zod drops it for a single-option
  // union — fallback reproduces zod's exact (inner) message.
  if (!def.discriminator && def.options.length === 1) {
    if (def.error !== undefined) return ctx.fallback("unsupported");
    return ctx.visit(def.options[0], "._zod.def.options[0]");
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
    // A discriminator value claimed by two options is a misconfigured schema:
    // zod throws "Duplicate discriminator value" at PARSE time. The compiled
    // switch would instead silently dispatch to the first matching case, so
    // delegate to zod to reproduce the throw exactly.
    const seenValues = new Set<string | number | boolean | null | bigint | undefined>();
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
        if (seenValues.has(v)) {
          return ctx.fallback("unsupported");
        }
        seenValues.add(v);
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
