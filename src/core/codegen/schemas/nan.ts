import type { NanIR } from "../../types.js";
import type { FastGen, SlowGen } from "../context.js";
import { emit } from "../emit.js";
import { invalidType } from "../emit-issue.js";

export function slowNan(_ir: NanIR, g: SlowGen): string {
  return `${emit`
    if(typeof ${g.input}!=="number"||!Number.isNaN(${g.input})){
      ${invalidType(g, "nan")}
    }
  `}\n`;
}

export function fastNan(_ir: NanIR, g: FastGen): string | null {
  return `typeof ${g.input}==="number"&&Number.isNaN(${g.input})`;
}
