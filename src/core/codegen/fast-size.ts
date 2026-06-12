/**
 * Fast-path size estimation, used to bound the size of each emitted fast-check
 * function. V8's TurboFan refuses to optimize functions whose bytecode exceeds
 * ~60KB and falls back to the weaker Maglev tier — measured ~1.3-1.8x slower on
 * deeply-nested schemas whose monolithic fast-check crosses that budget. By
 * extracting large, self-contained sub-schemas into their own boolean helpers
 * (`generateFast`), each function stays small enough to TurboFan.
 *
 * `estimateFastCost` is a path-agnostic subtree estimate in approximate
 * generated-character units (it can't see the access-path prefix the node will
 * be emitted under, since that lives in the call site, not the IR). The actual
 * emitted size of an inlined node grows with that prefix length — `input["a"]
 * ["b"]["c"]…` repeated per check — so the extraction decision scales the
 * estimate by `1 + inputLen/PATH_GROWTH_DIVISOR` (see `predictedInlineSize`).
 * The accumulator itself (generateFast) tracks EXACT emitted chars via the
 * returned string length, so only the look-ahead prediction is approximate.
 */

import type { SchemaIR } from "../types.js";

/**
 * Per-function soft size cap, in emitted characters. Once the fast-check being
 * assembled would exceed this, the next large hoistable sub-schema is split into
 * its own helper. Set below the ~60KB bytecode point where TurboFan bails (chars
 * over-approximate bytecode) with margin for one look-ahead mis-prediction.
 */
export const EXTRACT_CAP = 38_000;

/**
 * Each nesting level lengthens every access path inside a node (`x["a"]` →
 * `x["a"]["b"]`), inflating real emitted chars above the path-agnostic estimate.
 * The extraction look-ahead multiplies the estimate by `1 + inputLen/this` so a
 * deep subtree is split before it inlines into an over-budget function. Smaller
 * ⇒ more eager splitting at depth. Calibrated against deeply-nested fixtures.
 */
const PATH_GROWTH_DIVISOR = 26;

/**
 * Predicted emitted size of inlining `ir` at a call site whose input expression
 * is `inputLen` chars long — the path-agnostic subtree estimate scaled up for
 * the access-path prefix that estimate omits. Used only for the extract/inline
 * decision; the running total uses exact emitted lengths.
 */
export function predictedInlineSize(
  ir: SchemaIR,
  inputLen: number,
  cache: WeakMap<SchemaIR, number>,
): number {
  return estimateFastCost(ir, cache) * (1 + inputLen / PATH_GROWTH_DIVISOR);
}

/**
 * Floor for extraction: never hoist a sub-schema smaller than this even when
 * the enclosing function is over the cap — a tiny helper trades a real call for
 * no optimization benefit. Only sub-schemas big enough to matter are split.
 */
export const MIN_EXTRACT = 1_200;

/** Approximate size contributed to the enclosing function by an extracted call `__fo_N(expr)`. */
export const CALL_COST = 24;

/**
 * Node types whose fast-check is a self-contained boolean over a single input
 * expression and large enough to be worth hoisting into `function f(p){return …}`.
 * Thin wrappers (optional/nullable/default/…) are omitted: their inner schema is
 * visited through `generateFast` and gets hoisted on its own when large.
 */
export const HOISTABLE: ReadonlySet<SchemaIR["type"]> = new Set([
  "object",
  "record",
  "tuple",
  "discriminatedUnion",
  "union",
  "intersection",
]);

/** A node's own contribution to the emitted fast-check, EXCLUDING its children. */
function shallowFastCost(ir: SchemaIR): number {
  switch (ir.type) {
    case "object":
      return 50 + Object.keys(ir.properties).length * 25 + (ir.strict ? 120 : 0);
    case "string":
      return 20 + ir.checks.length * 35;
    case "number":
      return 25 + ir.checks.length * 30;
    case "bigint":
    case "date":
      return 25 + (ir.checks?.length ?? 0) * 25;
    case "enum":
      return 15 + ir.values.length * 12;
    case "tuple":
      return 40 + ir.items.length * 15;
    case "union":
      return 12 + ir.options.length * 6;
    case "discriminatedUnion":
      return 45 + ir.cases.length * 12;
    case "array":
    case "record":
    case "set":
    case "map":
      return 55;
    case "file":
    case "templateLiteral":
      return 40;
    case "literal":
    case "optional":
    case "nullable":
    case "default":
      return 22;
    case "recursiveRef":
      return 15;
    default:
      return 18;
  }
}

/** Child IR nodes that the fast generator recurses into (mirrors the fast schema generators). */
function fastChildren(ir: SchemaIR): readonly SchemaIR[] {
  switch (ir.type) {
    case "object":
      return Object.values(ir.properties);
    case "array":
      return [ir.element];
    case "tuple":
      return ir.rest !== null ? [...ir.items, ir.rest] : ir.items;
    case "record":
    case "map":
      return [ir.keyType, ir.valueType];
    case "set":
      return [ir.valueType];
    case "union":
    case "discriminatedUnion":
      return ir.options;
    case "intersection":
      return [ir.left, ir.right];
    case "pipe":
      return [ir.in, ir.out];
    case "optional":
    case "nullable":
    case "readonly":
    case "default":
    case "catch":
      return [ir.inner];
    default:
      return [];
  }
}

/**
 * Estimated total size of a node's fast-check (the node plus everything inlined
 * beneath it). Memoized per IR node: schemas dedupe shared sub-trees and the
 * estimate is consulted at every nesting level, so without the cache a deep tree
 * would be re-walked quadratically.
 */
export function estimateFastCost(ir: SchemaIR, cache: WeakMap<SchemaIR, number>): number {
  const cached = cache.get(ir);
  if (cached !== undefined) return cached;
  // Defensive cycle break (the IR is a tree today; recursiveRef is a leaf).
  cache.set(ir, 0);
  let total = shallowFastCost(ir);
  for (const child of fastChildren(ir)) total += estimateFastCost(child, cache);
  cache.set(ir, total);
  return total;
}
