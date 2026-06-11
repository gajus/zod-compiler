import type { LiteralIR } from "../../types.js";
import type { FastGen, SlowGen } from "../context.js";
import { literalToJs } from "../context.js";
import { emit } from "../emit.js";
import { invalidValue } from "../emit-issue.js";

/** `[v1,v2,...]` source for the invalid_value issue's `values` field. */
function valuesJs(values: LiteralIR["values"]): string {
  return `[${values.map(literalToJs).join(",")}]`;
}

export function slowLiteral(ir: LiteralIR, g: SlowGen): string {
  if (ir.values.length === 1) {
    return emit`
      if(${g.input}!==${literalToJs(ir.values[0])}){
        ${invalidValue(g, valuesJs(ir.values))}
      }
    `;
  }

  const valueChecks = ir.values.map((v) => `${g.input}===${literalToJs(v)}`).join("||");

  return emit`
    if(!(${valueChecks})){
      ${invalidValue(g, valuesJs(ir.values))}
    }
  `;
}

export function fastLiteral(ir: LiteralIR, g: FastGen): string {
  const x = g.input;
  if (ir.values.length === 1) {
    return `${x}===${literalToJs(ir.values[0])}`;
  }
  // Wrap in parens — || has lower precedence than && in parent expressions
  return `(${ir.values.map((v) => `${x}===${literalToJs(v)}`).join("||")})`;
}
