import type { UnknownIR } from "../../types.js";
import type { FastGen, SlowGen } from "../context.js";

export function slowUnknown(_ir: UnknownIR, _g: SlowGen): string {
  return "";
}

export function fastUnknown(_ir: UnknownIR, _g: FastGen): string | null {
  return "true";
}
