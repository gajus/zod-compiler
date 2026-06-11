import type { AnyIR } from "../../types.js";
import type { FastGen, SlowGen } from "../context.js";

export function slowAny(_ir: AnyIR, _g: SlowGen): string {
  return "";
}

export function fastAny(_ir: AnyIR, _g: FastGen): string | null {
  return "true";
}
