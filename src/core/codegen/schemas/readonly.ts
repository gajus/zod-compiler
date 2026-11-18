import type { ReadonlyIR, SchemaIR } from "../../types.js";
import type { FastGen, SlowGen } from "../context.js";

export function slowReadonly(ir: SchemaIR & { type: "readonly" }, g: SlowGen): string {
  // Pass-through wrapper: forward the union abort flag (see slowOptional).
  const inner = g.visit(ir.inner, { aborted: g.aborted });
  if (ir.freeze !== true) return inner;
  // Guarded because the walk only reassigns `output` to its rebuilt object once
  // the type check passed — a failed one leaves the CALLER's input sitting
  // there, and freezing that is the side effect zod avoids.
  //
  // The mark is RELATIVE to the issues already collected, never against zero:
  // zod runs every node on a fresh payload and freezes whenever THAT node's
  // parse is clean, while the compiled walk shares one issues array across
  // siblings, so an absolute test would skip the freeze as soon as an earlier
  // sibling had failed. Same relative-mark discipline as slowObject's
  // refineMark, slowPipe's lenVar and slowEffect's beforeVar.
  //
  // `copy` slices first: the walk leaves a pass-through array in `output` as
  // the caller's own (see ReadonlyIR.copy). A clean inner means the value is
  // that array, so there is always something to slice — and slicing a value the
  // walk happened to copy already (a member handed back a replacement) costs a
  // second small copy on a path that only runs eagerly when no build pass does.
  const mark = g.temp("rf");
  const value = ir.copy === "array" ? `${g.output}.slice()` : g.output;
  return `var ${mark}=${g.issues}.length;\n${inner}if(${g.issues}.length===${mark}){${g.output}=Object.freeze(${value});}\n`;
}

export function fastReadonly(ir: ReadonlyIR, g: FastGen): string | null {
  return g.visit(ir.inner);
}
