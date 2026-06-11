import type { FallbackIR, SchemaIR } from "../types.js";
import { resolveCheckMessage } from "./checks.js";
import { extractAny } from "./extractors/any.js";
import { extractArray } from "./extractors/array.js";
import { extractBigint } from "./extractors/bigint.js";
import { extractBoolean } from "./extractors/boolean.js";
import { extractCatch } from "./extractors/catch.js";
import { extractDate } from "./extractors/date.js";
import { extractDefault } from "./extractors/default.js";
import { extractEnum } from "./extractors/enum.js";
import { extractFile } from "./extractors/file.js";
import { extractIntersection } from "./extractors/intersection.js";
import { extractLazy } from "./extractors/lazy.js";
import { extractLiteral } from "./extractors/literal.js";
import { extractMap } from "./extractors/map.js";
import { extractNan } from "./extractors/nan.js";
import { extractNever } from "./extractors/never.js";
import { extractNull } from "./extractors/null.js";
import { extractNullable } from "./extractors/nullable.js";
import { extractNumber } from "./extractors/number.js";
import { extractObject } from "./extractors/object.js";
import { extractOptional } from "./extractors/optional.js";
import { extractPipe } from "./extractors/pipe.js";
import { extractReadonly } from "./extractors/readonly.js";
import { extractRecord } from "./extractors/record.js";
import { extractSet } from "./extractors/set.js";
import { extractString } from "./extractors/string.js";
import { extractSymbol } from "./extractors/symbol.js";
import { extractTemplateLiteral } from "./extractors/template-literal.js";
import { extractTuple } from "./extractors/tuple.js";
import { extractUndefined } from "./extractors/undefined.js";
import { extractUnion } from "./extractors/union.js";
import { extractUnknown } from "./extractors/unknown.js";
import { extractVoid } from "./extractors/void.js";
import { makeFallback } from "./fallback.js";
import type {
  Extractor,
  ExtractorContext,
  RefEntry,
  SupportedZodDefType,
  ZodSchema,
} from "./types.js";

// ─── Typed registry ─────────────────────────────────────────────────────────
// Adding a new SupportedZodDefType without registering an extractor here causes
// a compile error, preventing silent-missing-case bugs.
//
// Note: SupportedZodDefType covers Zod's def.type values, not SchemaIR types.
// SchemaIR types like discriminatedUnion, recursiveRef, effect, and fallback are
// produced by extractors (e.g. union emits discriminatedUnion, lazy emits
// recursiveRef) but have no corresponding Zod def.type.

export const extractRegistry = {
  // Primitives (order follows SupportedZodDefType union in types.ts)
  boolean: extractBoolean,
  null: extractNull,
  undefined: extractUndefined,
  any: extractAny,
  unknown: extractUnknown,
  symbol: extractSymbol,
  void: extractVoid,
  nan: extractNan,
  never: extractNever,
  literal: extractLiteral,
  enum: extractEnum,
  optional: extractOptional,
  nullable: extractNullable,
  readonly: extractReadonly,
  intersection: extractIntersection,
  // Complex extractors
  string: extractString,
  number: extractNumber,
  bigint: extractBigint,
  date: extractDate,
  object: extractObject,
  array: extractArray,
  tuple: extractTuple,
  record: extractRecord,
  set: extractSet,
  map: extractMap,
  union: extractUnion,
  default: extractDefault,
  pipe: extractPipe,
  lazy: extractLazy,
  catch: extractCatch,
  template_literal: extractTemplateLiteral,
  file: extractFile,
} satisfies Record<SupportedZodDefType, Extractor>;

// ─── Factory ────────────────────────────────────────────────────────────────
// Lives here (not in types.ts) to avoid circular imports:
// visit() → dispatch() → imports from types.ts

function createExtractorContext(
  schema: unknown,
  path: string,
  refs: RefEntry[] | undefined,
  visiting: Set<unknown>,
): ExtractorContext {
  return {
    schema,
    path,
    refs,
    visiting,
    visit(childSchema: unknown, pathSuffix?: string): SchemaIR {
      const childPath = pathSuffix ? `${path}${pathSuffix}` : path;
      return dispatch(childSchema, childPath, refs, visiting);
    },
    fallback(reason: FallbackIR["reason"]) {
      return makeFallback(reason, schema, refs, path);
    },
  };
}

// ─── Dispatch ───────────────────────────────────────────────────────────────

/**
 * def.type values whose extractors consume `def.checks`. In Zod v4, `.refine()`
 * (and `.check()`) appends to the checks array of WHATEVER schema type it is
 * called on — z.string().nullable().refine(...) puts the check on the nullable.
 * For every other type, checks present on the def would be silently dropped by
 * extraction, so dispatch() forces a Zod fallback instead (validation hole
 * otherwise: compiled output accepts input Zod rejects).
 */
const CHECKS_AWARE_TYPES: ReadonlySet<string> = new Set([
  "string",
  "number",
  "bigint",
  "date",
  "object",
  "array",
  "set",
  "file",
]);

/**
 * Central dispatch — replaces extractSchemaInner().
 * visit() and dispatch() form a mutually recursive pair, both in this file.
 */
export function dispatch(
  zodSchema: unknown,
  path: string,
  refs: RefEntry[] | undefined,
  visiting: Set<unknown>,
): SchemaIR {
  const schema = zodSchema as ZodSchema;
  const def = schema._zod.def;

  visiting.add(zodSchema);
  try {
    const extractor = extractRegistry[def.type as SupportedZodDefType];
    const ctx = createExtractorContext(zodSchema, path, refs, visiting);
    let ir = extractor ? extractor(def, ctx) : makeFallback("unsupported", zodSchema, refs, path);
    if (ir.type === "fallback") return ir;

    // Safety net: checks attached to a type whose extractor ignores them.
    if (def.checks && def.checks.length > 0 && !CHECKS_AWARE_TYPES.has(def.type)) {
      return makeFallback("refine", zodSchema, refs, path);
    }

    // Schema-level custom error (z.string({ error: "..." })): bake static
    // messages as the node's default issue message; dynamic error maps can't
    // be compiled — delegate to Zod so messages stay exact.
    if (def.error !== undefined) {
      const resolved = resolveCheckMessage(def.error);
      if (resolved.kind === "dynamic") {
        return makeFallback("refine", zodSchema, refs, path);
      }
      if (resolved.kind === "static") {
        ir = { ...ir, typeMessage: resolved.message };
      }
    }
    return ir;
  } finally {
    visiting.delete(zodSchema);
  }
}
