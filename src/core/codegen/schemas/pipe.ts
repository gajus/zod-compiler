import type { PipeIR, SchemaIR } from "../../types.js";
import type { FastGen, SlowGen } from "../context.js";

export function slowPipe(ir: SchemaIR & { type: "pipe" }, g: SlowGen): string {
  // zod's handlePipeResult: run `in`; if it produced ANY issue the pipe aborts —
  // `out` does NOT run, and (inside a union) the option is flagged aborted so it
  // loses union pruning even when `in`'s only issue is a non-aborting code (e.g.
  // a `custom` refine). When the pipe is not a union option, `g.aborted` is
  // undefined and only the short-circuit applies. Capturing the issue count
  // before `in` detects whether `in` added issues regardless of what they are.
  const lenVar = g.temp("pl");
  const inCode = g.visit(ir.in);
  // Forward `aborted` into `out` too: zod returns the `out` payload directly, so
  // an abort-bearing `out` (a nested pipe/codec/transform whose own step fails)
  // must propagate its abort up to this option.
  const outCode = g.visit(ir.out, { input: g.output, output: g.output, aborted: g.aborted });
  const abortBranch = g.aborted ? `else{${g.aborted}=true;}` : "";
  return `var ${lenVar}=${g.issues}.length;\n${inCode}\nif(${g.issues}.length===${lenVar}){${outCode}}${abortBranch}\n`;
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
