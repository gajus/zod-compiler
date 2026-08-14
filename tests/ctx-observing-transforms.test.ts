/**
 * Transforms that can observe zod's SECOND argument.
 *
 * Zod invokes a transform as `def.transform(payload.value, payload)`. Both
 * compiled routes — inlining the callback's source, and calling the user's own
 * function through `__rf[N]` — pass the value alone, so either is sound only for
 * a callback that does not read that second argument.
 *
 * `fn.length` cannot decide this: it stops counting at the first default and
 * ignores a rest element, so `(...args) => args.length` reports 0 and
 * `(v, ctx = null) => …` reports 1. Both slipped past the arity guard and then
 * silently computed a DIFFERENT result compiled than under zod — wrong data, no
 * error.
 *
 * The guard reads the parsed parameter list instead, and reports only what that
 * list PROVES. A signature it cannot read — a native like `Number`, a bound
 * function — is not thereby suspect: refusing those would cost a very common
 * idiom its compiled path for no correctness gain, and `.transform(Number)`
 * delegating measured ~1.4x SLOWER than plain zod.
 */

import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import { extractSchema } from "#src/core/extract/index.js";
import type { RefEntry } from "#src/core/extract/index.js";
import { expectParity } from "./parity-harness.js";

// Declared standalone so zod's contextual `$RefinementCtx` type does not apply:
// these are about what arrives at RUNTIME — one argument under the compiled
// routes, two under zod.
const restElement = (...args: unknown[]): unknown => args.length;
const defaultedSecond = (_v: unknown, ctx: unknown = null): unknown =>
  ctx === null ? "no" : "yes";
const defaultedFirst = (_v: unknown = "d", ctx?: unknown): unknown =>
  ctx === undefined ? "no" : "yes";
const readsArguments = function (this: void): unknown {
  return arguments.length;
};

// `this: void` is erased at compile time; the runtime source stays a bare method
// shorthand, whose parameter list is only recoverable by re-parsing it as the
// object literal it came from.
const helpers = {
  trim(this: void, v: unknown) {
    return typeof v === "string" ? v.trim() : v;
  },
  collect(this: void, ...args: unknown[]) {
    return args.length;
  },
};

const routeOf = (schema: unknown): string => {
  const ir = extractSchema(schema, []);
  if (ir.type === "fallback") return "fallback";
  if ("source" in ir) return "inline";
  if ("refIndex" in ir) return "reference";
  return ir.type;
};

describe("transforms that can observe zod's parse context", () => {
  it.each([
    ["rest element", restElement],
    ["defaulted second parameter", defaultedSecond],
    ["defaulted first parameter", defaultedFirst],
    ["arguments object", readsArguments],
    ["method shorthand with a rest element", helpers.collect],
  ])("delegates to zod and matches it for a transform using %s", (_name, fn) => {
    expect(routeOf(z.string().transform(fn as never))).toBe("fallback");
    expectParity(z.string().transform(fn as never) as never, ["x", "  y  ", ""]);
  });

  /**
   * The guard reports only what it can prove, so everything whose signature is
   * safe — or simply unreadable — keeps the compiled path it had. Losing any of
   * these would be a straight performance regression on ordinary code.
   */
  it.each([
    ["plain unary arrow", (v: string) => v.trim(), "inline"],
    ["method shorthand", helpers.trim, "reference"],
    ["native Number", Number, "reference"],
    ["native String", String, "reference"],
  ])("keeps %s on the compiled path", (_name, fn, expected) => {
    expect(routeOf(z.string().transform(fn as never))).toBe(expected);
  });

  it("still compiles a capturing transform by reference", () => {
    const suffix = "!";
    const refs: RefEntry[] = [];
    const ir = extractSchema(
      z.string().transform((v: string) => v + suffix),
      refs,
    );
    expect(ir).toMatchObject({ type: "effect", effectKind: "transform", refIndex: 0 });
    expect(refs[0]?.accessPath).toBe("._zod.def.out._zod.def.transform");
    expect(refs[0]?.schema).toBeTypeOf("function");
  });

  it.each([
    ["native Number", Number, ["42", "x"]],
    ["method shorthand", helpers.trim, ["  hi  ", "hi"]],
  ])("keeps %s behaviour identical to zod", (_name, fn, inputs) => {
    expectParity(z.string().transform(fn as never) as never, inputs);
  });
});
