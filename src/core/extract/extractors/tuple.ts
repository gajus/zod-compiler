import type { SchemaIR } from "../../types.js";
import type { ExtractorContext, ZodDef, ZodSchema } from "../types.js";

/**
 * Port of `$ZodTuple`'s `getTupleOptStart`, run against the LIVE item schemas:
 * the index after the last item that fails `omittable`, or 0 when every item
 * passes it. See {@link TupleIR.optStart} for why this is read from the zod
 * schema rather than inferred from the extracted IR.
 */
function optStart(items: unknown[], omittable: (item: ZodSchema["_zod"]) => boolean): number {
  for (let i = items.length - 1; i >= 0; i--) {
    if (!omittable((items[i] as ZodSchema)._zod)) return i + 1;
  }
  return 0;
}

export function extractTuple(def: ZodDef, ctx: ExtractorContext): SchemaIR {
  const items = def.items.map((item, i) => ctx.visit(item, `._zod.def.items[${i}]`));
  const rest = def.rest ? ctx.visit(def.rest, "._zod.def.rest") : null;
  // optin is a three-rung ladder, so any rung above `undefined` permits an
  // absent slot; optout stays two-valued.
  const optinStart = optStart(def.items, (z) => z.optin !== undefined);
  const optoutStart = optStart(def.items, (z) => z.optout === "optional");
  const optionalIn = def.items.flatMap((item, i) =>
    (item as ZodSchema)._zod.optin === "optional" ? [i] : [],
  );
  return {
    type: "tuple",
    items,
    rest,
    optStart: optinStart,
    ...(optoutStart < def.items.length ? { optoutStart } : {}),
    ...(optionalIn.length > 0 ? { optionalIn } : {}),
  };
}
