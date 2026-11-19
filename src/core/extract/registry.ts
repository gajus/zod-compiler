import type { FallbackIR, SchemaIR } from "../types.js";
import { resolveCheckMessage } from "./checks.js";
import { extractAny } from "./extractors/any.js";
import { extractArray } from "./extractors/array.js";
import { extractBigint } from "./extractors/bigint.js";
import { extractBoolean } from "./extractors/boolean.js";
import { extractCatch } from "./extractors/catch.js";
import { extractCustom } from "./extractors/custom.js";
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
import { callbackSubject, markFresh } from "./fresh.js";
import { makeRecursiveRef } from "./recursion.js";
import type {
  Extractor,
  ExtractorContext,
  RecursionState,
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
  custom: extractCustom,
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

/** What an extractor asked of `dispatch` beyond the IR it returned. */
interface ExtractionRequests {
  /** Leave this node's issues to zod (see ExtractorContext.delegateIssues). */
  delegateIssues: boolean;
}

function createExtractorContext(
  schema: unknown,
  path: string,
  refs: RefEntry[] | undefined,
  visiting: Set<unknown>,
  recursion: RecursionState,
  requests: ExtractionRequests,
): ExtractorContext {
  return {
    schema,
    path,
    refs,
    visiting,
    recursion,
    visit(childSchema: unknown, pathSuffix?: string): SchemaIR {
      const childPath = pathSuffix ? `${path}${pathSuffix}` : path;
      return dispatch(childSchema, childPath, refs, visiting, recursion);
    },
    fallback(reason: FallbackIR["reason"]) {
      return makeFallback(reason, schema, refs, path);
    },
    delegateIssues() {
      requests.delegateIssues = true;
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
  recursion: RecursionState,
): SchemaIR {
  const schema = zodSchema as ZodSchema;
  const def = schema._zod.def;

  // Cycle with no `z.lazy()` marker. Zod v4's documented getter form
  // (`get subcategories() { return z.array(Category) }`) closes the loop through
  // an ordinary shape entry, so nothing on the way down announces the back-edge
  // — re-entering a schema still on the `visiting` stack IS the announcement.
  // Without this, the walk recurses through the same shape forever and dies
  // with "Maximum call stack size exceeded" before codegen ever runs.
  //
  // `lazy` is excluded because a lazy node is NOT the cycle's target — the
  // schema it RESOLVES to is, and that is what the ref must be keyed on.
  // Re-entering a lazy node is normal (`z.lazy(() => z.object({ next:
  // Lazy.optional() }))` reaches the ROOT lazy again through its own subtree),
  // and keying the ref on the wrapper would compare it against a root that
  // `makeRecursiveRef` has already resolved through its lazy, miss the match,
  // and mint a non-root refId — costing every root-level `z.lazy()` recursion
  // a hosted helper validator instead of self-calling `safeParse_<name>`.
  // extractLazy re-checks `visiting` against the resolved schema on the way in,
  // so those cycles are still caught, one frame later and with the right key.
  //
  // Checked BEFORE `visiting.add` and outside the try: `visiting` is a plain
  // Set, so returning from inside it would run the `finally` and delete an
  // entry the OUTER frame for this same schema still owns — blinding the
  // detector to every later back-edge to that target (a second self-reference
  // in the same object would recurse forever again).
  if (def.type !== "lazy" && visiting.has(zodSchema)) {
    return makeRecursiveRef(zodSchema, recursion);
  }

  visiting.add(zodSchema);
  try {
    const extractor = extractRegistry[def.type as SupportedZodDefType];
    // Per node: a child gets a context (and requests) of its own through visit().
    const requests: ExtractionRequests = { delegateIssues: false };
    const ctx = createExtractorContext(zodSchema, path, refs, visiting, recursion, requests);
    let ir = extractor ? extractor(def, ctx) : makeFallback("unsupported", zodSchema, refs, path);
    if (ir.type === "fallback") return ir;

    // Safety net: checks attached to a type whose extractor ignores them.
    if (def.checks && def.checks.length > 0 && !CHECKS_AWARE_TYPES.has(def.type)) {
      return makeFallback("refine", zodSchema, refs, path);
    }

    // A callback on this node runs on a value zod built. Mark the containers in
    // that value so every compiled walk builds them too, rather than handing the
    // callback the caller's own (see extract/fresh.ts). Done before the
    // extractors above this node run, so they see the rebuild.
    const subject = callbackSubject(ir);
    if (subject !== null && !markFresh(subject, recursion)) {
      return makeFallback(
        ir.type === "effect" ? "transform" : ir.type === "pipe" ? "unsupported" : "refine",
        zodSchema,
        refs,
        path,
      );
    }

    // Schema-level custom error (z.string({ error: "..." })): bake static
    // messages as the node's default issue message. A dynamic error map can't
    // be baked, so the node's issues go to zod instead (below).
    if (def.error !== undefined) {
      const resolved = resolveCheckMessage(def.error);
      if (resolved.kind === "dynamic") {
        requests.delegateIssues = true;
      } else if (resolved.kind === "static") {
        ir = { ...ir, typeMessage: resolved.message };
      }
    }

    // A message only zod can produce — a dynamic error map on the schema or on
    // one of its checks. The map cannot change what the node accepts or yields,
    // so the IR extracted above stands and keeps its fast and build paths; only
    // the issue walk is handed to the retained schema, which runs the map on
    // the failure it is reporting. (Delegating the whole node, as this once
    // did, cost the enclosing schema its fast path, its build path and its
    // `.is()` over what is, on valid input, dead code: 96.5 against 32.4 ns for
    // one such field in a seven-field object, 106 against 7.4 ns on rejection.)
    //
    // Without a ref table there is nothing to hold the retained schema, so the
    // node falls back as before. A `custom` node already produces its issues
    // through its own schema, and a `zodDelegate` already delegates.
    if (requests.delegateIssues) {
      if (refs === undefined) return makeFallback("refine", zodSchema, refs, path);
      if (ir.type !== "custom" && ir.type !== "zodDelegate") {
        const refIndex = refs.length;
        refs.push({ schema: zodSchema, accessPath: path });
        ir = { type: "zodDelegate", inner: ir, refIndex };
      }
    }

    // This schema is the target of a non-root recursive cycle (a `recursiveRef`
    // with refId ≥ 1 was emitted for it deeper in the walk): wrap its IR as the
    // OUTERMOST transformation so codegen hosts it as a standalone validator.
    // Done last — after the fallback post-processing above — so a target that
    // delegates to Zod returns its fallback leaf, discarding the whole subtree
    // (including the inner `recursiveRef`) instead of leaving a dangling ref.
    // The root target (refId 0) is the schema's own function and is never
    // wrapped.
    const refId = recursion.targets.get(zodSchema);
    if (refId !== undefined) {
      // A callback below reaches this target through a back-edge, so the
      // target's containers are part of the callback's argument too.
      if (recursion.freshTargets?.has(refId) === true && !markFresh(ir, recursion)) {
        return makeFallback("unsupported", zodSchema, refs, path);
      }
      return { type: "recursionTarget", refId, inner: ir };
    }
    return ir;
  } finally {
    visiting.delete(zodSchema);
  }
}
