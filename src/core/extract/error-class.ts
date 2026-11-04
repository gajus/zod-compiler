/**
 * The error class a schema's own parse methods build, which a compiled
 * validator installed on that schema has to build too.
 *
 * Classic `zod` and `zod/mini` share every internal the compiler reads
 * (`_zod.def`, `_zod.bag`, the checks), so one IR and one validator serve both.
 * The error a failed parse hands back is where they part. Classic methods build
 * classic's `ZodError`: `name: "ZodError"`, `.format()` and `.flatten()`, and
 * the `"ZodError"` trait that `instanceof z.ZodError` tests. Mini's methods
 * call zod/v4/core's parse functions, which build core's `$ZodError`:
 * `name: "$ZodError"`, none of those methods, and the `"$ZodError"` trait
 * alone. The issues are the same either way, but the class is observable, and
 * a compiled Mini schema used to answer with the classic one.
 *
 * Decided by the ROOT schema, whose methods the validator replaces. A Mini
 * object holding a classic field still fails with Mini's error from its own
 * `parse()`, so its compiled replacement does too.
 *
 * Read off the `"ZodType"` trait, which only classic's `ZodType` constructor
 * adds (Mini's adds `"ZodMiniType"`). A schema built straight from
 * `zod/v4/core` carries neither and has no parse methods of its own; core's
 * `parse()` builds the core error for it, so that is the class it gets. A
 * schema whose traits cannot be read keeps the classic class, which is what
 * every schema got before the distinction existed.
 */

/** The `name` zod gives the error class: classic's, or zod/v4/core's (Mini). */
export type ZodErrorClass = "ZodError" | "$ZodError";

export function zodErrorClassOf(schema: unknown): ZodErrorClass {
  if (typeof schema !== "object" || schema === null) return "ZodError";
  try {
    const traits = (schema as { _zod?: { traits?: { has?: unknown } } })._zod?.traits;
    if (typeof traits?.has === "function" && !(traits as Set<string>).has("ZodType")) {
      return "$ZodError";
    }
  } catch {
    // A Proxy trapping `get`: nothing zod built, so nothing to match.
  }
  return "ZodError";
}
