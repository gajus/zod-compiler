/**
 * Fast Path: produces a boolean expression string for eligible schemas.
 * When the expression evaluates to `true` at runtime, the input is valid and
 * safeParse can return success immediately without allocating an issues array.
 *
 * Returns `null` if the schema is not eligible for Fast Path (contains coerce,
 * default, transform, or other non-pure constructs).
 */

import type { SchemaIR } from "../types.js";
import type { CodeGenContext, FastGen, FastGenerator, FastScope } from "./context.js";
import { emitRegex, emitTemp } from "./context.js";
import {
  CALL_COST,
  EXTRACT_CAP,
  estimateFastCost,
  HOISTABLE,
  MIN_EXTRACT,
  predictedInlineSize,
} from "./fast-size.js";
import { fastAny } from "./schemas/any.js";
import { fastArray } from "./schemas/array.js";
import { fastBigInt } from "./schemas/bigint.js";
import { fastBoolean } from "./schemas/boolean.js";
import { fastCatch } from "./schemas/catch.js";
import { fastDate } from "./schemas/date.js";
import { fastDefault } from "./schemas/default.js";
import { fastDiscriminatedUnion } from "./schemas/discriminated-union.js";
import { fastEnum } from "./schemas/enum.js";
import { fastFile } from "./schemas/file.js";
import { fastIntersection } from "./schemas/intersection.js";
import { fastLiteral } from "./schemas/literal.js";
import { fastMap } from "./schemas/map.js";
import { fastNan } from "./schemas/nan.js";
import { fastNever } from "./schemas/never.js";
import { fastNull } from "./schemas/null.js";
import { fastNullable } from "./schemas/nullable.js";
import { fastNumber } from "./schemas/number.js";
import { fastObject } from "./schemas/object.js";
import { fastOptional } from "./schemas/optional.js";
import { fastPipe } from "./schemas/pipe.js";
import { fastReadonly } from "./schemas/readonly.js";
import { fastRecord } from "./schemas/record.js";
import { fastRecursiveRef } from "./schemas/recursive-ref.js";
import { fastSet } from "./schemas/set.js";
import { fastString } from "./schemas/string.js";
import { fastSymbol } from "./schemas/symbol.js";
import { fastTemplateLiteral } from "./schemas/template-literal.js";
import { fastTuple } from "./schemas/tuple.js";
import { fastUndefined } from "./schemas/undefined.js";
import { fastUnion } from "./schemas/union.js";
import { fastUnknown } from "./schemas/unknown.js";
import { fastVoid } from "./schemas/void.js";

// ─── Typed registry ─────────────────────────────────────────────────────────
// `null` = statically ineligible (the type NEVER has a fast path).
// Non-null function = may return null at runtime (dynamically ineligible, e.g. when coerce is present).

const fastRegistry = {
  // Primitives (order follows SchemaIR union in types.ts)
  string: fastString,
  number: fastNumber,
  boolean: fastBoolean,
  bigint: fastBigInt,
  date: fastDate,
  symbol: fastSymbol,
  null: fastNull,
  undefined: fastUndefined,
  void: fastVoid,
  nan: fastNan,
  never: fastNever,
  any: fastAny,
  unknown: fastUnknown,
  literal: fastLiteral,
  enum: fastEnum,
  // Containers
  object: fastObject,
  array: fastArray,
  tuple: fastTuple,
  record: fastRecord,
  set: fastSet,
  map: fastMap,
  file: fastFile,
  // Unions & Intersections
  union: fastUnion,
  discriminatedUnion: fastDiscriminatedUnion,
  intersection: fastIntersection,
  // Modifiers
  optional: fastOptional,
  nullable: fastNullable,
  readonly: fastReadonly,
  default: fastDefault,
  pipe: fastPipe,
  // Effects
  effect: null, // statically ineligible
  // Special
  templateLiteral: fastTemplateLiteral,
  catch: fastCatch,
  fallback: null, // statically ineligible
  recursiveRef: fastRecursiveRef,
  stringBool: null, // statically ineligible — output type (boolean) differs from input (string)
} satisfies {
  [K in SchemaIR["type"]]: FastGenerator<Extract<SchemaIR, { type: K }>> | null;
};

// ─── Factory ─────────────────────────────────────────────────────────────────

/**
 * @param inputExpr  the input expression this node validates
 * @param ctx        shared codegen context
 * @param extractable whether THIS node may be hoisted (false for the root and a
 *   helper's own top node — see generateFast); children are always extractable
 * @param scope      size accumulator for the function being assembled (a child
 *   visit shares the parent's scope; a hoisted helper body gets a fresh one)
 */
export function createFastGen(
  inputExpr: string,
  ctx: CodeGenContext,
  extractable = false,
  scope: FastScope = { used: 0 },
): FastGen {
  return {
    input: inputExpr,
    ctx,
    extractable,
    scope,
    visit(ir, overrides) {
      // A child shares this function's scope and is itself extractable.
      return generateFast(ir, createFastGen(overrides?.input ?? inputExpr, ctx, true, scope));
    },
    scoped: (input) => createFastGen(input, ctx, true, { used: 0 }),
    temp: (prefix) => emitTemp(ctx, prefix),
    regex: (prefix, pattern, flags) => emitRegex(ctx, prefix, pattern, flags),
  };
}

// ─── Dispatch ────────────────────────────────────────────────────────────────

/**
 * Generate a boolean expression string that validates input against the schema.
 * Returns `null` if the schema (or any nested part) is not eligible for fast checking.
 *
 * Size-gated extraction: when inlining `ir` would push the function being
 * assembled past EXTRACT_CAP, it is hoisted into its own boolean helper
 * `function __fo_N(p){return <expr over p>;}` and replaced by a call. This keeps
 * every emitted function under V8's TurboFan optimization budget — a single
 * giant fast-check otherwise drops to the slower Maglev tier (measured ~3-4.5x
 * on deeply-nested schemas). The running total `g.scope.used` is EXACT emitted
 * chars (the returned string's length); only the extract look-ahead is an
 * estimate, scaled for access-path length. Small schemas never approach the
 * cap, so their output is byte-identical to the fully-inlined form; large
 * aggregates do split (still semantically identical — only the boolean's shape
 * changes).
 */
export function generateFast(ir: SchemaIR, g: FastGen): string | null {
  const gen = fastRegistry[ir.type];
  if (gen === null) return null;

  if (g.extractable && HOISTABLE.has(ir.type)) {
    const cache = fastSizeCache(g.ctx);
    const overBudget = g.scope.used + predictedInlineSize(ir, g.input.length, cache) > EXTRACT_CAP;
    // Extract a sub-schema big enough to be worth a call; but once the function
    // is ALREADY over budget, extract any hoistable child regardless of size —
    // otherwise a crowd of small siblings (e.g. a discriminated union of many
    // small options) grows the function unbounded since none alone clears
    // MIN_EXTRACT.
    if (overBudget && (g.scope.used > EXTRACT_CAP || estimateFastCost(ir, cache) >= MIN_EXTRACT)) {
      const param = emitTemp(g.ctx, "op");
      // Generate the body relative to the helper's parameter, in a fresh scope;
      // the top node is non-extractable (it IS this helper) while its children
      // stay extractable, so an oversized helper splits further recursively.
      const inner = generateFast(ir, createFastGen(param, g.ctx, false, { used: 0 }));
      if (inner === null) return null; // ineligible sub-schema disables the whole fast path
      const fnName = emitTemp(g.ctx, "fo");
      g.ctx.preamble.push(`function ${fnName}(${param}){return ${inner};}`);
      g.scope.used += CALL_COST;
      return `${fnName}(${g.input})`;
    }
  }

  // Inlined: charge the enclosing function this node's EXACT emitted size. The
  // node's own text plus its inlined descendants is exactly the returned string;
  // children mutated the shared scope as they were visited, but the parent's
  // length is authoritative, so overwrite rather than add.
  const before = g.scope.used;
  // oxlint-disable-next-line typescript/no-explicit-any -- registry dispatch requires type erasure at call site
  const out = (gen as any)(ir, g) as string | null;
  if (out === null) return null;
  g.scope.used = before + out.length;
  return out;
}

/** Per-compile memo for estimateFastCost, stashed on the shared context. */
function fastSizeCache(ctx: CodeGenContext): WeakMap<SchemaIR, number> {
  return (ctx.fastSizeCache ??= new WeakMap<SchemaIR, number>());
}
