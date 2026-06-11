import type { SchemaIR } from "../../types.js";
import type { ExtractorContext, ZodDef } from "../types.js";

export function extractRecord(def: ZodDef, ctx: ExtractorContext): SchemaIR {
  if (!def.valueType) {
    return ctx.fallback("unsupported");
  }
  // Exhaustive-key records: when the key schema exposes a finite value set
  // (z.record(z.enum(...))), Zod requires EVERY key to be present and rejects
  // unrecognized keys. Compiled records only iterate input keys — delegate to
  // Zod. z.partialRecord() clears `_zod.values`, so it still compiles.
  const keyValues = def.keyType?._zod?.values;
  if (keyValues !== undefined && keyValues.size > 0) {
    return ctx.fallback("unsupported");
  }
  const keyType = ctx.visit(def.keyType, "._zod.def.keyType");
  const valueType = ctx.visit(def.valueType, "._zod.def.valueType");
  // Object keys are strings at runtime. Zod coerces/validates numeric-string
  // keys for z.record(z.number(), ...) — the compiled key check would run
  // typeof on the string key and reject everything. Only string-shaped key
  // schemas compile; everything else delegates to Zod.
  if (!isStringShapedKey(keyType)) {
    return ctx.fallback("unsupported");
  }
  return { type: "record", keyType, valueType };
}

function isStringShapedKey(ir: SchemaIR): boolean {
  switch (ir.type) {
    case "string":
    case "templateLiteral":
      return true;
    case "enum":
      return ir.values.every((v) => typeof v === "string");
    case "literal":
      return ir.values.every((v) => typeof v === "string");
    case "union":
      return ir.options.every(isStringShapedKey);
    default:
      return false;
  }
}
