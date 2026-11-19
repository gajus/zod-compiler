import { hasMutation } from "../../codegen/context.js";
import type { SchemaIR } from "../../types.js";
import type { Extractor } from "../types.js";

/** Does this node carry a check that replaces its value with an arbitrary one? */
function rewritesValue(ir: SchemaIR): boolean {
  const checks = (ir as { checks?: readonly { kind: string }[] }).checks;
  return checks?.some((check) => check.kind === "overwrite_effect") === true;
}

/**
 * Does freezing this node's output provably do nothing?
 *
 * `Object.freeze` is a no-op on a primitive — `Object.isFrozen("a")` is already
 * `true` — so a `.readonly()` whose inner always yields one is a pure
 * type-level wrapper that can compile to its inner schema unchanged.
 *
 * Deliberately conservative. `any`/`unknown`/`custom`/`effect`/`pipe` can each
 * yield an object at runtime, `default`/`catch` can substitute one, and `date`/
 * `file` ARE objects, so none of them qualify — they keep the delegation below.
 */
function freezeIsNoop(ir: SchemaIR): boolean {
  // `.overwrite(fn)` — and the built-ins that compile to it, `.trim()` /
  // `.toLowerCase()` — substitutes whatever its callback returns, so the IR tag
  // stops predicting the output type: `z.string().overwrite(v => ({ v }))` is a
  // `string` node that yields an object, which Zod's readonly then freezes.
  // Checked ahead of the switch so no allowlisted type can smuggle one in.
  if (rewritesValue(ir)) return false;
  switch (ir.type) {
    case "string":
    case "number":
    case "boolean":
    case "bigint":
    case "symbol":
    case "null":
    case "undefined":
    case "void":
    case "nan":
    // Yields no value at all, so there is nothing for a freeze to act on.
    case "never":
    case "enum":
    case "templateLiteral":
    case "stringBool":
      return true;
    // z.literal() compares by identity and accepts reference values, so a
    // literal qualifies only when every one of its values is a primitive.
    case "literal":
      return ir.values.every(
        (value) => value === null || (typeof value !== "object" && typeof value !== "function"),
      );
    case "optional":
    case "nullable":
    case "readonly":
    // Only its ISSUES come from zod; the value is the inner's own.
    case "zodDelegate":
      return freezeIsNoop(ir.inner);
    case "union":
    case "discriminatedUnion":
      return ir.options.every(freezeIsNoop);
    default:
      return false;
  }
}

/**
 * Is the value the compiler will produce for this node one it ALLOCATED, rather
 * than the caller's own input?
 *
 * That is the precondition for emitting `Object.freeze`: freezing a fresh value
 * reproduces Zod exactly, freezing the caller's input is a side effect Zod never
 * has (it rebuilds first). A stripping object — plain `z.object()`, Zod's
 * default — is the one container BOTH compiled walks rebuild: the build pass
 * assembles a fresh `__bo_N` and the eager walk reassigns its output to a fresh
 * literal. So is an array or tuple whose members rewrite: the build pass
 * allocates the array it fills, and the eager walk slices up front before the
 * first member writes back. `strictObject`, `looseObject`, records, and arrays
 * or tuples of pass-through members are validated in place and handed back by
 * reference.
 */
function freezeTargetIsFresh(ir: SchemaIR): boolean {
  switch (ir.type) {
    // `stripUnknownKeys` marks a genuine z.object() with no catchall — exactly
    // the objects both walks rebuild rather than validate in place. So does
    // `fresh`: a container a callback is handed is rebuilt on every path.
    case "object":
      return ir.stripUnknownKeys === true || ir.fresh === true;
    // `hasMutation` on a member is the eager walk's own test for copying up
    // front (slowArray, slowTuple). The build pass agrees wherever it runs at
    // all: every member rewrite it models puts the container in the rebuild
    // set, and one it does not model (`.catch()`, a delegate) declines the
    // whole pass, leaving the eager walk.
    case "array":
      return ir.fresh === true || hasMutation(ir.element);
    case "tuple":
      return (
        ir.fresh === true ||
        ir.items.some(hasMutation) ||
        (ir.rest !== null && hasMutation(ir.rest))
      );
    // An inner readonly that freezes produced a value of its own to do it on;
    // otherwise freezing twice is idempotent and the answer is its inner's.
    case "readonly":
      return ir.freeze === true || freezeTargetIsFresh(ir.inner);
    // The build pass produces the inner's value and the eager walk zod's own
    // output for it, so the wrapper is as fresh as what it wraps.
    case "zodDelegate":
      return freezeTargetIsFresh(ir.inner);
    default:
      return false;
  }
}

/**
 * Is this node's value an ARRAY the compiled walks may hand back by reference,
 * so that freezing a `slice()` of it reproduces what zod freezes?
 *
 * Zod parses an array or tuple into a fresh one holding each member's result.
 * For a node that reaches here — {@link freezeTargetIsFresh} said no, so no
 * member rewrites — those results are the input's own elements, and a shallow
 * copy is that same array. (The one thing a copy keeps that zod's rebuild does
 * not is a hole in a sparse input, which is the container-identity divergence
 * every compiled array already documents.)
 *
 * Arrays only. An object's copy would have to reproduce zod's KEY ORDER as
 * well — shape order, then the unknown keys — which a spread of the input does
 * not, so pass-through objects and records stay with zod, as do sets and maps.
 * A wrapper that can yield something other than the array (`.optional()`,
 * `.nullable()`, a union) is not looked through: there would be nothing to
 * slice.
 */
function isPassThroughArray(ir: SchemaIR): boolean {
  switch (ir.type) {
    case "array":
    case "tuple":
      return true;
    // Its value is the inner's in the build pass, zod's rebuilt one in the eager walk.
    case "zodDelegate":
      return isPassThroughArray(ir.inner);
    default:
      return false;
  }
}

/**
 * z.readonly() freezes the parse OUTPUT in Zod.
 *
 * Over a primitive that freeze is unobservable, so the wrapper compiles away
 * entirely and a single readonly field stops forcing its whole enclosing object
 * onto the eager walk.
 *
 * Over a container it is very much observable, and compiled validators return
 * the caller's input as-is for every container they did not have to rebuild —
 * so emitting Object.freeze there would freeze the caller's own data, a side
 * effect Zod avoids by freezing the value it rebuilt. Three outcomes follow:
 *
 *  - the walks rebuilt the value anyway (a stripping object, an array of them):
 *    freeze it;
 *  - the value is an array handed back by reference: freeze a shallow copy,
 *    which is what zod's rebuild amounts to (see {@link isPassThroughArray}).
 *    Delegating these instead cost the whole schema its compiled path —
 *    `z.array(z.number().int()).readonly()` ran at zod's own speed, 213 ns
 *    against 41 for the copy;
 *  - anything else (a pass-through object or record, a set, a map, a date)
 *    keeps delegating to Zod, which rebuilds and freezes its own output.
 */
export const extractReadonly: Extractor = (def, ctx) => {
  const refMark = ctx.refs?.length ?? 0;
  const inner = ctx.visit(def.innerType, "._zod.def.innerType");
  if (freezeIsNoop(inner)) return { type: "readonly", inner };
  if (freezeTargetIsFresh(inner)) return { type: "readonly", inner, freeze: true };
  if (isPassThroughArray(inner)) return { type: "readonly", inner, freeze: true, copy: "array" };
  // The whole subtree is being discarded, so roll back any ref-table entries
  // its fallbacks registered — otherwise __rf[] retains schemas the emitted
  // code never reads (same rollback extractObject does when it coalesces).
  if (ctx.refs) ctx.refs.length = refMark;
  return ctx.fallback("readonly");
};
