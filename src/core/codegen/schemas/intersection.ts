import type { IntersectionIR, SchemaIR } from "../../types.js";
import type { FastGen, SlowGen } from "../context.js";

export function slowIntersection(ir: SchemaIR & { type: "intersection" }, g: SlowGen): string {
  return `${g.visit(ir.left)}${g.visit(ir.right, { input: g.output, output: g.output })}`;
}

export function fastIntersection(ir: IntersectionIR, g: FastGen): string | null {
  const left = g.visit(ir.left);
  if (left === null) return null;
  const right = g.visit(ir.right);
  if (right === null) return null;
  return left === "true" ? right : right === "true" ? left : `${left}&&${right}`;
}
