import type { SchemaIR } from "../types.js";
import { makeFallback } from "./fallback.js";
import { markFresh } from "./fresh.js";
import { dispatch } from "./registry.js";
import type { RecursionState, RefEntry } from "./types.js";
import { assertSupportedZod } from "./zod-version.js";

export type { RefEntry } from "./types.js";

/**
 * Extract SchemaIR from a Zod schema by traversing its `_zod.def` and `_zod.bag`.
 *
 * When `fallbacks` is provided, non-compilable sub-schemas are collected with their
 * access paths for partial fallback (Zod delegation at runtime).
 */
export function extractSchema(zodSchema: unknown, refs?: RefEntry[]): SchemaIR {
  // Refuse a zod whose semantics the emitted code does not reproduce (see
  // zod-version.ts). Once, at the root: every entry point reaches extraction
  // through here, and a schema's subtree comes from the same zod copy as its
  // root does.
  assertSupportedZod(zodSchema);
  // Path, cycle-detection set, and recursion bookkeeping are internal to one
  // extraction — recursion re-enters through dispatch()/ctx.visit(), never back
  // through extractSchema — so they're always seeded fresh here.
  const rec: RecursionState = {
    root: zodSchema,
    targets: new Map<unknown, number>(),
    next: 1,
  };
  const ir = dispatch(zodSchema, "", refs, new Set<unknown>(), rec);
  // A callback reaches the root through a back-edge (refId 0), so the root's
  // containers are part of its argument. The root is the one target dispatch
  // never wraps, so it is marked here (see extract/fresh.ts).
  if (rec.freshTargets?.has(0) === true && !markFresh(ir, rec)) {
    return makeFallback("unsupported", zodSchema, refs, "");
  }
  return ir;
}
