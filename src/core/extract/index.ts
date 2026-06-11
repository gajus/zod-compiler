import type { SchemaIR } from "../types.js";
import { dispatch } from "./registry.js";
import type { RefEntry } from "./types.js";

export type { RefEntry } from "./types.js";

/**
 * Extract SchemaIR from a Zod schema by traversing its `_zod.def` and `_zod.bag`.
 *
 * When `fallbacks` is provided, non-compilable sub-schemas are collected with their
 * access paths for partial fallback (Zod delegation at runtime).
 */
export function extractSchema(
  zodSchema: unknown,
  refs?: RefEntry[],
  currentPath?: string,
  visiting?: Set<unknown>,
): SchemaIR {
  return dispatch(zodSchema, currentPath ?? "", refs, visiting ?? new Set<unknown>());
}
