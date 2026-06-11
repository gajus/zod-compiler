import type { ReadonlyIR, SchemaIR } from "../../types.js";
import type { FastGen, SlowGen } from "../context.js";

export function slowReadonly(ir: SchemaIR & { type: "readonly" }, g: SlowGen): string {
  return g.visit(ir.inner);
}

export function fastReadonly(ir: ReadonlyIR, g: FastGen): string | null {
  return g.visit(ir.inner);
}
