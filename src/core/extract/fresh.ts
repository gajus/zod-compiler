/**
 * Which containers a user callback is handed, so the compiled walks can give it
 * zod's own copy of each (see the `fresh` flag on the container IR nodes).
 *
 * zod parses an object, array, tuple, record, set or map into a value of its
 * own making, so every callback that runs on a parsed value holds zod's copy.
 * The compiled walks return a container that nothing rewrites by reference.
 * That is fine for the value a parse returns: it is the documented
 * container-identity difference. It is not fine for the value a callback runs
 * on. The callback was written against zod's copy, and an ordinary one edits
 * it: `.transform(a => a.sort())`, `.transform(o => { o.x = …; return o; })`,
 * a refine that normalizes a nested array. Each of those edited the caller's
 * own data.
 *
 * Marking happens while the tree is extracted, bottom-up, so the extractors
 * above a marked node see it as rewriting its value (`hasMutation`) and decide
 * accordingly. An intersection compiles only when neither side rewrites, and a
 * `.readonly()` freezes a fresh value without copying it first.
 */

import type { SchemaIR } from "../types.js";
import type { RecursionState } from "./types.js";

type ContainerIR = Extract<
  SchemaIR,
  { type: "object" | "array" | "tuple" | "record" | "set" | "map" }
>;

function isContainer(ir: SchemaIR): ir is ContainerIR {
  switch (ir.type) {
    case "object":
    case "array":
    case "tuple":
    case "record":
    case "set":
    case "map":
      return true;
    default:
      return false;
  }
}

/** A check whose callback runs on the node's parsed value. */
function isCallbackCheck(check: { kind: string }): boolean {
  return check.kind === "refine_effect" || check.kind === "super_refine_effect";
}

/**
 * The subtree whose OUTPUT the user callbacks on this node receive, or null
 * when the node adds no callback that runs on a value zod built:
 *
 *  - `.refine()` / `.superRefine()` on an object or array: zod runs the node's
 *    checks on its own parsed value. (On a string or number the value is a
 *    primitive, and every other node type with a check falls back to zod.)
 *  - `.transform(fn)`: the inner schema's parsed value.
 *  - `a.pipe(b)` where `b` runs user code: `b` parses `a`'s OUTPUT, and a
 *    callback in `b` can reach any of it. A `z.custom()` predicate holds it
 *    whole, and a `z.any()` member hands part of it on to a check above.
 *
 * `z.preprocess()`, `z.custom()` and `.catch()` callbacks are not listed: zod
 * hands each one the raw input, and so does the compiled code.
 */
export function callbackSubject(ir: SchemaIR): SchemaIR | null {
  switch (ir.type) {
    case "effect":
      return ir.effectKind === "transform" ? ir.inner : null;
    case "object":
    case "array":
      return ir.checks?.some(isCallbackCheck) === true ? ir : null;
    case "pipe":
      return runsUserCode(ir.out) ? ir.in : null;
    default:
      return null;
  }
}

/**
 * Could this subtree call user code? Conservative: anything opaque counts — a
 * delegated sub-schema runs whatever zod finds in it, and a recursive member
 * whatever its target holds.
 */
function runsUserCode(root: SchemaIR): boolean {
  const seen = new Set<SchemaIR>();
  const walk = (node: SchemaIR): boolean => {
    if (seen.has(node)) return false;
    seen.add(node);
    switch (node.type) {
      case "effect":
      case "custom":
      case "catch":
      case "fallback":
      case "recursiveRef":
        return true;
      default:
        break;
    }
    const checks = (node as { checks?: readonly { kind: string }[] }).checks;
    if (checks?.some((check) => isCallbackCheck(check) || check.kind === "overwrite_effect")) {
      return true;
    }
    return childNodes(node).some(walk);
  };
  return walk(root);
}

/**
 * Can this subtree's value hold a container? A recursive member counts, since
 * its target is not visible from here.
 */
function holdsContainer(root: SchemaIR): boolean {
  const seen = new Set<SchemaIR>();
  const walk = (node: SchemaIR): boolean => {
    if (seen.has(node)) return false;
    seen.add(node);
    if (isContainer(node) || node.type === "recursiveRef") return true;
    return childNodes(node).some(walk);
  };
  return walk(root);
}

/**
 * Mark every container in `subject` fresh. Returns false when the subtree holds
 * something no compiled walk can hand a callback zod's value for, in which case
 * the caller leaves the callback's node to zod. That something is an
 * intersection over containers: its output is zod's MERGE of two independently
 * parsed copies, while the compiled intersection validates both sides in place
 * and returns the input.
 *
 * A recursive reference reaches more of the value than this subtree shows: its
 * target's shape is the value's shape too. The target is always an ancestor
 * still being extracted, because a ref is only minted for a schema on the
 * visiting stack. So it is queued on `recursion.freshTargets`, and dispatch
 * marks it when the target is finished.
 */
export function markFresh(subject: SchemaIR, recursion: RecursionState): boolean {
  let exact = true;
  const seen = new Set<SchemaIR>();
  const visit = (node: SchemaIR): void => {
    if (seen.has(node)) return;
    seen.add(node);
    if (isContainer(node)) node.fresh = true;
    if (node.type === "intersection" && (holdsContainer(node.left) || holdsContainer(node.right))) {
      exact = false;
    }
    if (node.type === "recursiveRef") {
      (recursion.freshTargets ??= new Set<number>()).add(node.refId ?? 0);
    }
    for (const child of childNodes(node)) visit(child);
  };
  visit(subject);
  return exact;
}

/** Every child a node's output is assembled from. */
function childNodes(ir: SchemaIR): readonly SchemaIR[] {
  switch (ir.type) {
    case "object":
      return ir.catchall === undefined
        ? Object.values(ir.properties)
        : [...Object.values(ir.properties), ir.catchall];
    case "array":
      return [ir.element];
    case "tuple":
      return ir.rest === null ? ir.items : [...ir.items, ir.rest];
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
    case "optional":
    case "nullable":
    case "readonly":
    case "default":
    case "catch":
    case "effect":
    case "recursionTarget":
    case "zodDelegate":
      return [ir.inner];
    case "pipe":
      return [ir.in, ir.out];
    default:
      return [];
  }
}
