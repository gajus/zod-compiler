import { hasMutation } from "../../codegen/context.js";
import type { SchemaIR } from "../../types.js";
import type { ExtractorContext, ZodDef } from "../types.js";

export function extractRecord(def: ZodDef, ctx: ExtractorContext): SchemaIR {
  if (!def.valueType) {
    return ctx.fallback("unsupported");
  }
  // Exhaustive-key records: when the key schema exposes a finite value set
  // (z.record(z.enum(...))), Zod requires EVERY key to be present and rejects
  // unrecognized keys. Compiled records only iterate input keys — delegate to
  // Zod. z.partialRecord() keeps the key schema (and its values) but sets
  // `def.partial`, which is what zod itself reads to skip the exhaustive walk;
  // the values then only decide the ISSUE a stray key raises (see RecordIR).
  const keyValues = def.keyType?._zod?.values;
  const enumerableKeys = keyValues !== undefined;
  if (enumerableKeys && !def.partial) {
    return ctx.fallback("unsupported");
  }
  // `z.looseRecord()` sets `def.mode = "loose"`, which zod checks BEFORE it ever
  // asks whether a key is recognized: an unrecognized key is copied to the
  // output verbatim rather than raising anything. The compiled walk runs the key
  // schema over every key and reports `invalid_key`, so it rejects input zod
  // passes straight through — `z.looseRecord(z.string().regex(/^a/), z.number())`
  // accepts `{b: 1}`. Nothing in RecordIR expresses "validate these keys, copy
  // the rest", so delegate.
  if (def.mode === "loose") {
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
  // Rewriting key schemas (z.string().trim()/.toUpperCase(), z.url() — whose
  // check writes back the normalized href) RE-HOME the entry in zod: the output
  // carries the parsed key, so `z.record(z.string().toUpperCase(), z.number())`
  // turns `{ a: 1 }` into `{ A: 1 }`. The compiled record cannot follow, on two
  // independent counts.
  //
  // First, the key is validated with `{ input: keyVar, output: keyVar }`, so an
  // overwrite effect reassigns the loop variable in place; the value is then
  // read as `input[keyVar]` — i.e. at the REWRITTEN key, which is absent from
  // the input object — so the value check sees `undefined` and the record is
  // wrongly rejected with `invalid_type` at the rewritten path.
  //
  // Second, even with the lookup pinned to the original key, the walk iterates
  // the input with for-in and returns it BY REFERENCE, so it has nowhere to put
  // the moved entry: producing zod's output would mean building a fresh object
  // under the parsed keys, which also has to resolve collisions (two keys
  // normalizing to one). Neither half is expressible here, so delegate.
  if (hasMutation(keyType)) {
    return ctx.fallback("unsupported");
  }
  return enumerableKeys
    ? { type: "record", keyType, valueType, enumerableKeys: true }
    : { type: "record", keyType, valueType };
}

function isStringShapedKey(ir: SchemaIR): boolean {
  switch (ir.type) {
    case "string":
    case "templateLiteral":
      return true;
    case "enum":
      return ir.values.every((v) => typeof v === "string");
    case "literal":
      // `typeof v === "string"` (not merely "has a source form") is what keeps a
      // SYMBOL key out, and it has to: the compiled record walks its input with
      // `for-in`, which yields string keys only, so a symbol-keyed entry would
      // be invisible to it — while zod's record enumerates the symbol keys too.
      // Only zod can decide such a record, so delegate.
      return ir.values.every((v) => typeof v === "string");
    case "union":
      return ir.options.every(isStringShapedKey);
    default:
      return false;
  }
}
