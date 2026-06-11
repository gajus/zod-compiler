import type { UndefinedIR } from "../../types.js";
import type { FastGen, SlowGen } from "../context.js";
import { emit } from "../emit.js";
import { invalidType } from "../emit-issue.js";

export function slowUndefined(_ir: UndefinedIR, g: SlowGen): string {
  return `${emit`
    if(${g.input}!==undefined){
      ${invalidType(g, "undefined")}
    }
  `}\n`;
}

export function fastUndefined(_ir: UndefinedIR, g: FastGen): string | null {
  return `${g.input}===undefined`;
}
