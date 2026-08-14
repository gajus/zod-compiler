/**
 * Callbacks whose `toString()` is NOT a standalone expression.
 *
 * Effect inlining works by re-emitting a callback's own source text into the
 * generated module. That is only sound when the source parses to a function
 * expression — and acorn, asked for an expression at offset 0, parses what it
 * can rather than refusing. A method shorthand lifted off an object literal
 * stringifies to `normalize(v) { … }`, which parses as the CALL `normalize(v)`
 * and stops at the brace; a class stringifies to a ClassExpression. Neither
 * carries `params`, so every arity guard passed vacuously and the whole source
 * — trailing block and all — was emitted as an initializer:
 *
 *     var __ef_2=(normalize(v) {
 *       return typeof v === "string" ? v.trim() : v;
 *     });
 *
 * `zod-compiler generate` reported success and exited 0 while writing a
 * `.compiled.ts` that neither tsc nor node could parse.
 *
 * These shapes must degrade instead: a refine/transform to a CALL through
 * `__rf[N]`, a preprocess further still to full zod delegation (its whole
 * branch is gated on the same predicate). Either way the callback is invoked
 * exactly once and the result matches zod.
 */

import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import { generateValidator } from "#src/core/codegen/index.js";
import { isContextFreeUnaryCallback, tryCompileEffect } from "#src/core/extract/effects.js";
import { extractSchema, type RefEntry } from "#src/core/extract/index.js";
import type { SchemaIR } from "#src/core/types.js";
import { compileLikeProduction, expectParity } from "./parity-harness.js";

// `this: void` is erased at compile time — the runtime source is still the bare
// method shorthand `normalize(v) { … }` these tests are about — and it keeps the
// unbound-method lint quiet about the very pattern under test.
const helpers = {
  normalize(this: void, v: unknown) {
    return typeof v === "string" ? v.trim() : v;
  },
};

const accessorHost = {
  get fn() {
    return (v: unknown) => (typeof v === "string" ? v.toUpperCase() : v);
  },
};

class Wrapper {}

/** Every emit path must produce code the engine can actually parse. */
function expectEmitsParseableCode(schema: unknown, name: string): void {
  for (const mode of ["inline", "lean"] as const) {
    const refEntries: RefEntry[] = [];
    const ir = extractSchema(schema, refEntries);
    const generated = generateValidator(ir, name, { refCount: refEntries.length, mode });
    expect(
      () =>
        new Function("__rf", `"use strict";${generated.code}\nreturn ${generated.functionDef};`),
    ).not.toThrow();
  }
}

describe("callbacks whose source is not an expression", () => {
  it("does not treat a method shorthand as an inlineable function", () => {
    expect(isContextFreeUnaryCallback(helpers.normalize)).toBe(false);
    expect(tryCompileEffect(helpers.normalize)).toBeUndefined();
  });

  it("does not treat a class as an inlineable function", () => {
    expect(isContextFreeUnaryCallback(Wrapper)).toBe(false);
    expect(tryCompileEffect(Wrapper)).toBeUndefined();
  });

  it.each([
    ["preprocess", () => z.preprocess(helpers.normalize, z.string())],
    ["transform", () => z.string().transform(helpers.normalize as never)],
    ["refine", () => z.string().refine(helpers.normalize as never)],
    ["custom", () => z.custom(helpers.normalize as never)],
    ["overwrite", () => z.string().overwrite(helpers.normalize as never)],
    [
      "piped transform",
      () =>
        z
          .string()
          .transform(helpers.normalize as never)
          .pipe(z.string()),
    ],
    ["nested in an object", () => z.object({ a: z.preprocess(helpers.normalize, z.string()) })],
  ])("emits parseable code for a method shorthand in %s", (_name, make) => {
    expectEmitsParseableCode(make(), "methodShorthand");
  });

  it("keeps method-shorthand behaviour identical to zod", () => {
    expectParity(z.preprocess(helpers.normalize, z.string()), ["  hi  ", "hi", 5, null, undefined]);
  });

  it("keeps refine-by-method-shorthand behaviour identical to zod", () => {
    expectParity(z.string().refine(helpers.normalize as never), ["  hi  ", "", "ok"]);
  });

  /**
   * Where each rejected shape actually lands. A refine keeps its compiled path
   * and only the CALL goes through `__rf[N]`; a preprocess cannot, because
   * `isContextFreeUnaryCallback` gates that whole branch, so it delegates to
   * zod wholesale. Pinning both stops a future relaxation from silently
   * promoting one into the other.
   */
  it("degrades a refine to a call through __rf[N]", () => {
    const refs: RefEntry[] = [];
    const ir = extractSchema(z.string().refine(helpers.normalize as never), refs);
    expect(ir.checks?.[0]).toMatchObject({ kind: "refine_effect", refIndex: 0 });
    expect(refs[0]?.accessPath).toBe("._zod.def.checks[0]._zod.def.fn");
    expect(refs[0]?.schema).toBeTypeOf("function");
  });

  it("degrades a preprocess to zod delegation", () => {
    const refs: RefEntry[] = [];
    const ir = extractSchema(z.preprocess(helpers.normalize, z.string()), refs);
    expect(ir.type).toBe("pipe");
    expect((ir as { in: SchemaIR }).in.type).toBe("fallback");
  });

  /** A rejected callback must still RUN — degraded, not skipped. */
  it("still invokes a rejected callback exactly once", () => {
    let calls = 0;
    const counting = {
      tally(this: void, v: unknown) {
        calls += 1;
        return typeof v === "string" ? v.trim() : v;
      },
    };
    const compiled = compileLikeProduction(z.preprocess(counting.tally, z.string()));
    expect(compiled("  hi  ")).toMatchObject({ success: true, data: "hi" });
    expect(calls).toBe(1);
  });

  /**
   * The type check alone would accept this: `(v) => v` parses fine and the
   * unconsumed tail is simply dropped on the floor — then re-emitted. Nothing
   * can prove `toString()` returned real source, so the guard requires the
   * parse to have covered all of it.
   */
  it("rejects a callback whose toString leaves an unparsed tail", () => {
    const liar = (v: unknown) => v;
    liar.toString = () => "(v) => v; leftover";
    expect(isContextFreeUnaryCallback(liar)).toBe(false);
    expect(tryCompileEffect(liar)).toBeUndefined();
  });

  /**
   * A getter returns a genuine arrow on every access, so it stays inlineable —
   * the guard rejects source that is not a function expression, not callbacks
   * that merely arrived by an unusual route.
   */
  it("still inlines a genuine arrow reached through a getter", () => {
    expect(isContextFreeUnaryCallback(accessorHost.fn)).toBe(true);
    expectParity(z.preprocess(accessorHost.fn, z.string()), ["hi", 5]);
  });

  it.each([
    ["arrow", (v: unknown) => v],
    [
      "anonymous function",
      function (v: unknown) {
        return v;
      },
    ],
    [
      "named function",
      function named(v: unknown) {
        return v;
      },
    ],
    ["default parameter", (v: unknown = "d") => v],
  ])("still inlines %s", (_name, fn) => {
    expect(isContextFreeUnaryCallback(fn)).toBe(true);
    expect(tryCompileEffect(fn)).toBeDefined();
  });
});
