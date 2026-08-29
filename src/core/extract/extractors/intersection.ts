import { hasMutation } from "../../codegen/context.js";
import type { ObjectIR, SchemaIR } from "../../types.js";
import type { Extractor } from "../types.js";

export const extractIntersection: Extractor = (def, ctx) => {
  const left = ctx.visit(def.left, "._zod.def.left");
  const right = ctx.visit(def.right, "._zod.def.right");

  // Zod RECONCILES the two sides' unrecognized_keys issues instead of taking
  // their union: handleIntersectionResults pulls every unrecognized_keys issue
  // out of both result lists, records which side named each key, and re-emits
  // one issue holding only the keys "unrecognized by BOTH sides". Nothing in a
  // sequential two-pass run pairs those key sets, so a strict side's complaint
  // that zod would cancel becomes a compiled rejection — and on the merged
  // path below it becomes a rejection with an EMPTY issue list, because the
  // cold path re-asks zod, which accepts. Delegate whenever either side can
  // raise the issue at all; this has to precede the merge, whose own strict
  // bail only inspects the two top-level objects.
  if (canReportUnrecognizedKeys(left) || canReportUnrecognizedKeys(right)) {
    return ctx.fallback("unsupported");
  }

  // The everyday `.and()` case: two default z.object() shapes with disjoint
  // keys. Zod parses each against the original input, strips each side to its
  // own keys, then merges the two outputs. A single object over the union of
  // those keys has identical acceptance and output semantics. The pristine
  // intersection remains the source of truth for cold-path issues (notably, a
  // non-object input produces one issue per side).
  const merged = mergeDisjointStripObjects(left, right);
  if (merged !== null && ctx.refs) {
    const refIndex = ctx.refs.length;
    ctx.refs.push({ schema: ctx.schema, accessPath: ctx.path });
    return { type: "zodDelegate", inner: merged, refIndex };
  }

  // Zod validates both sides on the ORIGINAL input and MERGES the results,
  // throwing on unmergable conflicts. The compiled generator runs the sides
  // sequentially on the same value — equivalent only when neither side
  // rewrites it. Mutating sides (coerce, trim, defaults, ...) delegate to Zod.
  if (hasMutation(left) || hasMutation(right)) {
    return ctx.fallback("unsupported");
  }
  return { type: "intersection", left, right };
};

/**
 * Can this side of an intersection produce an `unrecognized_keys` issue?
 *
 * Zod pairs the two sides' unrecognized keys by NAME ONLY, with no regard for
 * the path the complaint came from: `handleIntersectionResults` walks each
 * side's FLAT issue list, unions the bare `iss.keys` strings into one map, and
 * emits `[...unrecKeys].filter(([, f]) => f.l && f.r)` — "Report only keys
 * unrecognized by BOTH sides" — under the first LEFT issue's path. A strict
 * object nested in a property or an array element therefore participates in
 * the reconciliation exactly like a top-level one, so a strict object ANYWHERE
 * in a side disqualifies the compiled sequential run and the merged single
 * pass alike.
 *
 * Mirrors {@link hasMutation}'s recursion for which node kinds hold children.
 *
 * zod 4.5 widened the reconciliation to `invalid_key` as well — `collect` takes
 * any `unrecognized_keys` at the root AND any record `invalid_key` one segment
 * deep — so this covers both producers. `object.strict` reaches the
 * `handleCatchall` unrecognized-keys push; a record reaches one or the other
 * depending on its key schema (see the `record` case). A partial record over a
 * finite key set now COMPILES rather than falling back, so the old claim that a
 * compiled `record` could never raise these no longer holds.
 */
function isTotalKeySchema(ir: SchemaIR): boolean {
  // The same shape `fastRecord` treats as always-satisfied: for-in yields only
  // strings, so an unconstrained, non-coercing string schema accepts them all.
  return ir.type === "string" && ir.checks.length === 0 && ir.coerce !== true;
}

function canReportUnrecognizedKeys(ir: SchemaIR): boolean {
  switch (ir.type) {
    case "object":
      return (
        ir.strict === true ||
        (ir.catchall !== undefined && canReportUnrecognizedKeys(ir.catchall)) ||
        Object.values(ir.properties).some((p) => canReportUnrecognizedKeys(p))
      );
    case "array":
      return canReportUnrecognizedKeys(ir.element);
    case "tuple":
      return (
        ir.items.some(canReportUnrecognizedKeys) ||
        (ir.rest !== null && canReportUnrecognizedKeys(ir.rest))
      );
    // A record raises a RECONCILED key issue two ways: `unrecognized_keys` when
    // an enumerable key schema declares the owned set, and `invalid_key` when a
    // constrained key schema rejects one. An unconstrained string key schema
    // accepts every own enumerable string key and so raises neither.
    case "record":
      return (
        ir.enumerableKeys === true ||
        !isTotalKeySchema(ir.keyType) ||
        canReportUnrecognizedKeys(ir.valueType)
      );
    case "set":
      return canReportUnrecognizedKeys(ir.valueType);
    case "map":
      return canReportUnrecognizedKeys(ir.keyType) || canReportUnrecognizedKeys(ir.valueType);
    case "catch":
    case "default":
    case "effect":
    case "nullable":
    case "optional":
    case "readonly":
    case "recursionTarget":
    case "zodDelegate":
      return canReportUnrecognizedKeys(ir.inner);
    case "discriminatedUnion":
    case "union":
      return ir.options.some(canReportUnrecognizedKeys);
    case "intersection":
      return canReportUnrecognizedKeys(ir.left) || canReportUnrecognizedKeys(ir.right);
    case "pipe":
      return canReportUnrecognizedKeys(ir.in) || canReportUnrecognizedKeys(ir.out);
    // Zod runs the original sub-schema here, which may be (or contain) a strict
    // object that no IR node records.
    case "fallback":
      return true;
    // A back-edge whose target can sit OUTSIDE this side's IR — refId 0 points
    // at the compiled root, which may be an enclosing strict object. Unknowable
    // locally, so assume the worst.
    case "recursiveRef":
      return true;
    default:
      // Leaves and predicate nodes: primitives, literals, enums, templateLiteral,
      // stringBool, file, and custom (which emits `custom` issues only).
      return false;
  }
}

/** Merge only the object-intersection shape whose equivalence is statically obvious. */
function mergeDisjointStripObjects(left: SchemaIR, right: SchemaIR): ObjectIR | null {
  if (left.type !== "object" || right.type !== "object") return null;
  if (left.stripUnknownKeys !== true || right.stripUnknownKeys !== true) return null;
  if (
    left.strict === true ||
    right.strict === true ||
    left.catchall !== undefined ||
    right.catchall !== undefined ||
    left.checks !== undefined ||
    right.checks !== undefined
  ) {
    return null;
  }

  const leftKeys = Object.keys(left.properties);
  if (leftKeys.some((key) => Object.hasOwn(right.properties, key))) return null;

  const properties: Record<string, SchemaIR> = Object.create(null) as Record<string, SchemaIR>;
  for (const key of leftKeys) properties[key] = left.properties[key] as SchemaIR;
  const rightKeys = Object.keys(right.properties);
  for (const key of rightKeys) {
    properties[key] = right.properties[key] as SchemaIR;
  }
  // Integer-like keys are enumerated before other strings regardless of
  // insertion order. If that changes left-then-right traversal, a successful
  // parse could observe transform/refine callbacks in a different order.
  const expectedOrder = [...leftKeys, ...rightKeys];
  if (!Object.keys(properties).every((key, index) => key === expectedOrder[index])) return null;
  // The absent-key lists are per key, and the keys are disjoint, so each side's
  // rules carry over to the merged shape unchanged.
  const merged = (
    field: "skipAbsentKeys" | "suppressAbsentKeys" | "nonoptionalKeys",
  ): Partial<Pick<ObjectIR, typeof field>> => {
    const keys = [...(left[field] ?? []), ...(right[field] ?? [])];
    return keys.length > 0 ? { [field]: keys } : {};
  };
  return {
    type: "object",
    properties,
    stripUnknownKeys: true,
    ...merged("skipAbsentKeys"),
    ...merged("suppressAbsentKeys"),
    ...merged("nonoptionalKeys"),
  };
}
