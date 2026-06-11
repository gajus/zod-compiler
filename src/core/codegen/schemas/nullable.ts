import type { NullableIR, SchemaIR } from "../../types.js";
import type { FastGen, SlowGen } from "../context.js";
import { emit } from "../emit.js";

export function slowNullable(ir: SchemaIR & { type: "nullable" }, g: SlowGen): string {
  return `${emit`
    if(${g.input}!==null){
      ${g.visit(ir.inner)}
    }
  `}\n`;
}

export function fastNullable(ir: NullableIR, g: FastGen): string | null {
  const inner = g.visit(ir.inner);
  if (inner === null) return null;
  return `(${g.input}===null||(${inner}))`;
}
