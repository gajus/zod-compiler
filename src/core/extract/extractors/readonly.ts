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
 * literal. `strictObject`, `looseObject`, arrays, tuples and records are all
 * validated in place and handed back by reference, so they stay with Zod.
 */
function freezeTargetIsFresh(ir: SchemaIR): boolean {
  switch (ir.type) {
    // `stripUnknownKeys` marks a genuine z.object() with no catchall — exactly
    // the objects both walks rebuild rather than validate in place.
    case "object":
      return ir.stripUnknownKeys === true;
    // Freezing twice is idempotent; the inner wrapper does the work.
    case "readonly":
      return freezeTargetIsFresh(ir.inner);
    // The build pass produces the inner's value and the eager walk zod's own
    // output for it, so the wrapper is as fresh as what it wraps.
    case "zodDelegate":
      return freezeTargetIsFresh(ir.inner);
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
 * the caller's input as-is for every container except a stripping object — so
 * emitting Object.freeze would freeze the caller's own data, a side effect Zod
 * avoids by freezing the object it rebuilt. Those keep delegating to Zod, which
 * rebuilds and freezes its own output.
 */
export const extractReadonly: Extractor = (def, ctx) => {
  const refMark = ctx.refs?.length ?? 0;
  const inner = ctx.visit(def.innerType, "._zod.def.innerType");
  if (freezeIsNoop(inner)) return { type: "readonly", inner };
  if (freezeTargetIsFresh(inner)) return { type: "readonly", inner, freeze: true };
  // The whole subtree is being discarded, so roll back any ref-table entries
  // its fallbacks registered — otherwise __rf[] retains schemas the emitted
  // code never reads (same rollback extractObject does when it coalesces).
  if (ctx.refs) ctx.refs.length = refMark;
  return ctx.fallback("readonly");
};
