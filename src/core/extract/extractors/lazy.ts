import type { SchemaIR } from "../../types.js";
import type { ExtractorContext, ZodSchema } from "../types.js";

export function extractLazy(_def: unknown, ctx: ExtractorContext): SchemaIR {
  const schema = ctx.schema as ZodSchema;
  const innerSchema = schema._zod.innerType;
  if (!innerSchema) {
    return ctx.fallback("lazy");
  }
  // Cycle detected: the resolved schema is already being extracted.
  if (ctx.visiting.has(innerSchema)) {
    // A `recursiveRef` re-invokes the validator hosting its target's shape.
    // The ROOT schema's resolution is hosted by the schema's own
    // `safeParse_<name>` / fast-check, so a cycle back to it emits the implicit
    // refId 0 (the directly self-recursive case — byte-identical to before).
    const root = ctx.recursion.root as ZodSchema | undefined;
    const rootResolved = root?._zod?.def?.type === "lazy" ? root._zod.innerType : root;
    if (rootResolved === innerSchema) {
      return { type: "recursiveRef" };
    }
    // A cycle back to a NON-root sub-schema (recursive schema nested in a
    // wrapper, multiple distinct recursive sub-schemas, or mutual recursion):
    // assign the target a stable refId (≥ 1) keyed by schema identity. dispatch
    // wraps that schema's IR in a `recursionTarget` node so codegen hosts it as
    // a standalone validator the ref can call.
    let refId = ctx.recursion.targets.get(innerSchema);
    if (refId === undefined) {
      refId = ctx.recursion.next++;
      ctx.recursion.targets.set(innerSchema, refId);
    }
    return { type: "recursiveRef", refId };
  }
  return ctx.visit(innerSchema, "._zod.innerType");
}
