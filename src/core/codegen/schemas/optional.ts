import type { OptionalIR, SchemaIR } from "../../types.js";
import type { FastGen, SlowGen } from "../context.js";
import { emit } from "../emit.js";

export function slowOptional(ir: SchemaIR & { type: "optional" }, g: SlowGen): string {
  return `${emit`
    if(${g.input}!==undefined){
      ${g.visit(ir.inner)}
    }
  `}\n`;
}

export function fastOptional(ir: OptionalIR, g: FastGen): string | null {
  const inner = g.visit(ir.inner);
  if (inner === null) return null;
  return `(${g.input}===undefined||(${inner}))`;
}
