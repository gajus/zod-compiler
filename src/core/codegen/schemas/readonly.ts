import type { ReadonlyIR, SchemaIR } from "../../types.js";
import type { FastGen, SlowGen } from "../context.js";

export function slowReadonly(ir: SchemaIR & { type: "readonly" }, g: SlowGen): string {
  // Pass-through wrapper: forward the union abort flag (see slowOptional).
  return g.visit(ir.inner, { aborted: g.aborted });
}

export function fastReadonly(ir: ReadonlyIR, g: FastGen): string | null {
  return g.visit(ir.inner);
}
