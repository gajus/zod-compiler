import type { NeverIR } from "../../types.js";
import type { FastGen, SlowGen } from "../context.js";
import { emit } from "../emit.js";
import { invalidType } from "../emit-issue.js";

export function slowNever(_ir: NeverIR, g: SlowGen): string {
  return `${emit`
    ${invalidType(g, "never")}
  `}\n`;
}

export function fastNever(_ir: NeverIR, _g: FastGen): string | null {
  return "false";
}
