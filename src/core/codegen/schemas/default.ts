import type { DefaultIR } from "../../types.js";
import type { FastGen, SlowGen } from "../context.js";
import { fastSentinelWrapper, rejectsUndefined } from "../context.js";
import { emit } from "../emit.js";

/**
 * Expression for the declared default value, read off the retained schema so a
 * reference-typed default keeps zod's identity (one shared object, not a copy).
 */
export function defaultValueExpr(ir: DefaultIR): string {
  return `__rf[${ir.refIndex}]._zod.def.defaultValue`;
}

/**
 * Zod's `handleDefaultResult`: after the inner schema runs on a DEFINED input,
 * an `undefined` result gets the default applied too — so
 * `z.string().transform(() => undefined).default("d")` yields "d", not undefined.
 *
 * Emitted only when the inner can actually yield `undefined`, which is what
 * `rejectsUndefined` decides; the overwhelmingly common
 * `z.number().default(1)` shape therefore pays nothing for it.
 */
export function needsPostInnerDefault(ir: DefaultIR): boolean {
  return !rejectsUndefined(ir.inner);
}

export function slowDefault(ir: DefaultIR, g: SlowGen): string {
  // For a defined value, zod runs the inner schema and returns its payload
  // unchanged — so forward the union abort flag like the other pass-throughs
  // (a pipe inner whose `in` fails must abort this option). The default-value
  // branch produces no issues, so it never aborts.
  const reapply = needsPostInnerDefault(ir)
    ? `if(${g.output}===undefined){${g.output}=${defaultValueExpr(ir)};}`
    : "";
  return emit`
    if(${g.input}===undefined){
      ${g.output}=${defaultValueExpr(ir)};
    }else{
      ${g.visit(ir.inner, { input: g.output, output: g.output, aborted: g.aborted })}
      ${reapply}
    }
  `;
}

/**
 * By-reference form: a present value that the inner accepts. `undefined` is
 * refused even though the schema takes it, because the fast path's caller hands
 * back the INPUT on success and the schema's answer there is the default.
 *
 * Acceptance form (see FastGen.acceptance): `undefined` accepted, as zod does —
 * the default fires, and the schema succeeds. Only a verdict is read from this
 * form, so no payload can go wrong; it is what makes `.is()` on a defaulted
 * schema a total, zero-allocation predicate.
 */
export function fastDefault(ir: DefaultIR, g: FastGen): string | null {
  if (g.acceptance === true) return fastSentinelWrapper(g, ir.inner, "===undefined", "||");
  return fastSentinelWrapper(g, ir.inner, "!==undefined", "&&");
}
