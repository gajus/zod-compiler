import type { VoidIR } from "../../types.js";
import type { FastGen, SlowGen } from "../context.js";
import { emit } from "../emit.js";
import { invalidType } from "../emit-issue.js";

export function slowVoid(_ir: VoidIR, g: SlowGen): string {
  return `${emit`
    if(${g.input}!==undefined){
      ${invalidType(g, "void")}
    }
  `}\n`;
}

export function fastVoid(_ir: VoidIR, g: FastGen): string | null {
  return `${g.input}===undefined`;
}
