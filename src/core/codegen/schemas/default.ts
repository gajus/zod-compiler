import type { DefaultIR } from "../../types.js";
import type { FastGen, SlowGen } from "../context.js";
import { emit } from "../emit.js";

export function slowDefault(ir: DefaultIR, g: SlowGen): string {
  // For a defined value, zod runs the inner schema and returns its payload
  // unchanged — so forward the union abort flag like the other pass-throughs
  // (a pipe inner whose `in` fails must abort this option). The default-value
  // branch produces no issues, so it never aborts.
  return emit`
    if(${g.input}===undefined){
      ${g.output}=__rf[${ir.refIndex}]._zod.def.defaultValue;
    }else{
      ${g.visit(ir.inner, { input: g.output, output: g.output, aborted: g.aborted })}
    }
  `;
}

export function fastDefault(ir: DefaultIR, g: FastGen): string | null {
  const inner = g.visit(ir.inner);
  if (inner === null) return null;
  return `(${g.input}!==undefined&&(${inner}))`;
}
