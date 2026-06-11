import type { NullIR } from "../../types.js";
import type { FastGen, SlowGen } from "../context.js";
import { emit } from "../emit.js";
import { invalidType } from "../emit-issue.js";

export function slowNull(_ir: NullIR, g: SlowGen): string {
  return `${emit`
    if(${g.input}!==null){
      ${invalidType(g, "null")}
    }
  `}\n`;
}

export function fastNull(_ir: NullIR, g: FastGen): string | null {
  return `${g.input}===null`;
}
