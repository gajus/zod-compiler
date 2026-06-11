import type { Extractor, ZodSchema } from "../types.js";

export const extractEnum: Extractor = (def, ctx) => {
  // `_zod.values` is zod's authoritative accepted-value set — for TS numeric
  // enums it excludes reverse mappings ({A:1, "1":"A"} → values [1]), which
  // Object.values(def.entries) would wrongly include.
  const valueSet = (ctx.schema as ZodSchema | undefined)?._zod?.values;
  const values = valueSet !== undefined ? [...valueSet] : Object.values(def.entries);
  if (!values.every((v) => typeof v === "string" || typeof v === "number")) {
    return ctx.fallback("unsupported");
  }
  return {
    type: "enum",
    values: values as (string | number)[],
  };
};
