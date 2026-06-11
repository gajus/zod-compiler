import type { SchemaIR } from "../../types.js";
import type { ExtractorContext, ZodDef } from "../types.js";

export function extractTuple(def: ZodDef, ctx: ExtractorContext): SchemaIR {
  const items = def.items.map((item, i) => ctx.visit(item, `._zod.def.items[${i}]`));
  const rest = def.rest ? ctx.visit(def.rest, "._zod.def.rest") : null;
  return { type: "tuple", items, rest };
}
