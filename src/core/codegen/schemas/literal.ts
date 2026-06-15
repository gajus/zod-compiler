import type { LiteralIR } from "../../types.js";
import type { FastGen, SlowGen } from "../context.js";
import { literalToJs } from "../context.js";
import { emit } from "../emit.js";
import { invalidValue } from "../emit-issue.js";

/** `[v1,v2,...]` source for the invalid_value issue's `values` field. */
function valuesJs(values: LiteralIR["values"]): string {
  return `[${values.map(literalToJs).join(",")}]`;
}

/**
 * Equality test `x === value`, except for the literal NaN value: `NaN === NaN`
 * is false under `===`, but zod accepts NaN against `z.literal(NaN)` by value, so
 * a NaN literal compares via `Number.isNaN`. (Infinity/-Infinity compare fine
 * under `===` once literalToJs emits them as the right expression.)
 */
function literalEq(x: string, v: LiteralIR["values"][number]): string {
  if (typeof v === "number" && Number.isNaN(v)) return `Number.isNaN(${x})`;
  return `${x}===${literalToJs(v)}`;
}

export function slowLiteral(ir: LiteralIR, g: SlowGen): string {
  if (ir.values.length === 1) {
    return emit`
      if(!(${literalEq(g.input, ir.values[0])})){
        ${invalidValue(g, valuesJs(ir.values))}
      }
    `;
  }

  const valueChecks = ir.values.map((v) => literalEq(g.input, v)).join("||");

  return emit`
    if(!(${valueChecks})){
      ${invalidValue(g, valuesJs(ir.values))}
    }
  `;
}

export function fastLiteral(ir: LiteralIR, g: FastGen): string {
  const x = g.input;
  if (ir.values.length === 1) {
    return literalEq(x, ir.values[0]);
  }
  // Wrap in parens — || has lower precedence than && in parent expressions
  return `(${ir.values.map((v) => literalEq(x, v)).join("||")})`;
}
