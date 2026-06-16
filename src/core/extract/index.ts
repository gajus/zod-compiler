import type { SchemaIR } from "../types.js";
import { dispatch } from "./registry.js";
import type { ExtractOptions, RecursionState, RefEntry } from "./types.js";

export type { ExtractOptions, RefEntry } from "./types.js";

/**
 * Extract SchemaIR from a Zod schema by traversing its `_zod.def` and `_zod.bag`.
 *
 * When `fallbacks` is provided, non-compilable sub-schemas are collected with their
 * access paths for partial fallback (Zod delegation at runtime).
 */
export function extractSchema(
  zodSchema: unknown,
  refs?: RefEntry[],
  options?: ExtractOptions,
): SchemaIR {
  // Path, cycle-detection set, and recursion bookkeeping are internal to one
  // extraction — recursion re-enters through dispatch()/ctx.visit(), never back
  // through extractSchema — so they're always seeded fresh here.
  const rec: RecursionState = {
    root: zodSchema,
    targets: new Map<unknown, number>(),
    next: 1,
  };
  return dispatch(zodSchema, "", refs, new Set<unknown>(), rec, options ?? {});
}
