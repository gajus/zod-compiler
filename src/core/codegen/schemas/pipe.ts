import type { PipeIR, SchemaIR } from "../../types.js";
import type { FastGen, SlowGen } from "../context.js";

export function slowPipe(ir: SchemaIR & { type: "pipe" }, g: SlowGen): string {
  // Validate input schema first, then output schema sequentially
  return `${g.visit(ir.in)}${g.visit(ir.out, { input: g.output, output: g.output })}`;
}

export function fastPipe(ir: PipeIR, g: FastGen): string | null {
  // Only eligible if `out` is the same as `in` (non-transform pipe)
  // We check `in` only — if the pipe has a transform, `out` would be a fallback
  const inCheck = g.visit(ir.in);
  if (inCheck === null) return null;
  // Check if out schema is eligible (non-fallback)
  const outCheck = g.visit(ir.out);
  if (outCheck === null) return null;
  // Both in and out must pass
  return inCheck === "true" ? outCheck : outCheck === "true" ? inCheck : `${inCheck}&&${outCheck}`;
}
