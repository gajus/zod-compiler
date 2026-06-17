import type { OptionalIR, SchemaIR } from "../../types.js";
import type { FastGen, SlowGen } from "../context.js";
import { emit } from "../emit.js";

/**
 * Zod's `.optional()` short-circuits `undefined → undefined`, EXCEPT when its
 * inner chain applies a default to undefined: `z.string().default("d").optional()`
 * yields "d", not undefined (the default fires THROUGH the optional, and through
 * any nullable/optional wrappers between them — `default().nullish()`,
 * `default().optional().nullable()`, ...). Only `default` consumes undefined into
 * a value; `catch`, object-field defaults, and plain types do not, so the optional
 * legitimately short-circuits there. Peel optional/nullable wrappers to decide.
 */
function innerAppliesDefaultOnUndefined(ir: SchemaIR): boolean {
  let cur = ir;
  while (cur.type === "optional" || cur.type === "nullable") cur = cur.inner;
  return cur.type === "default";
}

export function slowOptional(ir: SchemaIR & { type: "optional" }, g: SlowGen): string {
  // Pass-through wrapper: forward the union abort flag (zod returns the inner
  // payload unchanged, so a pipe inner's `aborted` must reach the option).
  const fwd = { aborted: g.aborted };
  // When the inner chain handles undefined (a default), undefined must flow into
  // it so the default applies — the inner code already gates on undefined itself.
  if (innerAppliesDefaultOnUndefined(ir.inner)) {
    return `${g.visit(ir.inner, fwd)}\n`;
  }
  return `${emit`
    if(${g.input}!==undefined){
      ${g.visit(ir.inner, fwd)}
    }
  `}\n`;
}

export function fastOptional(ir: OptionalIR, g: FastGen): string | null {
  const inner = g.visit(ir.inner);
  if (inner === null) return null;
  // Same rule as the slow path: an inner default needs undefined to reach it, so
  // drop the `===undefined` shortcut (which would let safeParse return the raw
  // undefined before the eager slow path applies the default). The inner
  // fast-default expr already returns false on undefined, routing to the slow path.
  if (innerAppliesDefaultOnUndefined(ir.inner)) return inner;
  return `(${g.input}===undefined||(${inner}))`;
}
