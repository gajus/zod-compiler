/**
 * Opt-in unknown-key stripping (`stripUnknownKeys` build option).
 *
 * By default the compiler returns a valid object BY REFERENCE, keeping unknown
 * keys (see known-divergences.test.ts). With `stripUnknownKeys` enabled, a
 * genuine `z.object()` instead rebuilds a fresh object from only the declared
 * keys — matching zod's default `.parse()` strip — while `z.looseObject()`
 * still keeps extras and `z.strictObject()` still rejects them.
 *
 * The pinned divergences in known-divergences.test.ts compile with the option
 * OFF and therefore stay valid; this suite asserts the option ON reaches full
 * parity with zod for the exact positions those pins enumerate.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { SafeParseSuccess } from "#src/core/types.js";
import { compileLikeProduction, expectParity } from "./parity-harness.js";

const STRIP = { stripUnknownKeys: true } as const;

const dataOf = (r: { success: boolean }): Record<string, unknown> =>
  (r as SafeParseSuccess<Record<string, unknown>>).data;

describe("stripUnknownKeys — parity with zod's default strip", () => {
  it("top-level object strips extra keys", () => {
    expectParity(
      z.object({ a: z.string(), n: z.number() }),
      [{ a: "x", n: 1, b: 2, c: "extra" }],
      "stripTop",
      STRIP,
    );
  });

  it("nested object strips extra keys at depth", () => {
    expectParity(
      z.object({ outer: z.object({ a: z.string() }) }),
      [{ outer: { a: "x", b: 2 }, extra: 9 }],
      "stripNested",
      STRIP,
    );
  });

  it("object inside an array element strips extra keys", () => {
    expectParity(
      z.array(z.object({ a: z.string() })),
      [
        [
          { a: "x", b: 1 },
          { a: "y", z: 9 },
        ],
      ],
      "stripArrayEl",
      STRIP,
    );
  });

  it(".pick() result strips extra keys", () => {
    expectParity(
      z.object({ a: z.string(), b: z.number() }).pick({ a: true }),
      [{ a: "x", b: 1, c: 9 }],
      "stripPick",
      STRIP,
    );
  });

  it(".partial() result strips extra keys", () => {
    expectParity(
      z.object({ a: z.string(), b: z.number() }).partial(),
      [{ a: "x", z: 9 }, {}, { b: 2, extra: true }],
      "stripPartial",
      STRIP,
    );
  });

  it(".omit() / .extend() results strip extra keys", () => {
    expectParity(
      z.object({ a: z.string(), b: z.number() }).omit({ b: true }),
      [{ a: "x", b: 1 }],
      "stripOmit",
      STRIP,
    );
    expectParity(
      z.object({ a: z.string() }).extend({ b: z.number() }),
      [{ a: "x", b: 1, c: 9 }],
      "stripExtend",
      STRIP,
    );
  });

  it("discriminated-union option strips extra keys", () => {
    expectParity(
      z.discriminatedUnion("t", [
        z.object({ t: z.literal("a"), x: z.string() }),
        z.object({ t: z.literal("b"), y: z.number() }),
      ]),
      [
        { t: "a", x: "s", extra: 9 },
        { t: "b", y: 4, junk: "drop" },
      ],
      "stripDU",
      STRIP,
    );
  });

  it("plain union of objects strips extra keys per matched option", () => {
    expectParity(
      z.union([z.object({ a: z.string() }), z.object({ b: z.number() })]),
      [
        { a: "x", junk: 1 },
        { b: 2, junk: 3 },
      ],
      "stripUnion",
      STRIP,
    );
  });

  it("preserves presence semantics: optional, default, nullable", () => {
    expectParity(
      z.object({ a: z.string().optional() }),
      [{}, { a: "x", extra: 1 }, { a: undefined }],
      "stripOptional",
      STRIP,
    );
    expectParity(
      z.object({ a: z.string().default("d") }),
      [{ extra: 1 }, { a: "v", extra: 1 }],
      "stripDefault",
      STRIP,
    );
    expectParity(
      z.object({ a: z.string().nullable() }),
      [{ a: null, extra: 1 }],
      "stripNullable",
      STRIP,
    );
  });

  it("strips value-mutating fields after rewriting them", () => {
    expectParity(
      z.object({ a: z.string().trim() }),
      [{ a: "  hi  ", extra: 1 }],
      "stripTrim",
      STRIP,
    );
    expectParity(z.object({ n: z.coerce.number() }), [{ n: "42", extra: 1 }], "stripCoerce", STRIP);
  });

  it("empty z.object({}) strips everything", () => {
    expectParity(z.object({}), [{ a: 1, b: 2 }, {}], "stripEmpty", STRIP);
  });

  it("rejection parity is unchanged by stripping", () => {
    expectParity(
      z.object({ a: z.string(), n: z.number() }),
      [{ a: 1, n: "no", extra: true }, "not an object", null, []],
      "stripReject",
      STRIP,
    );
  });
});

describe("stripUnknownKeys — looseObject / strictObject unaffected", () => {
  it("looseObject still keeps unknown keys", () => {
    expectParity(z.looseObject({ a: z.string() }), [{ a: "x", b: 1, c: 2 }], "stripLoose", STRIP);
  });

  it("strictObject still rejects unknown keys", () => {
    expectParity(
      z.strictObject({ a: z.string() }),
      [{ a: "x", b: 1 }, { a: "x" }],
      "stripStrict",
      STRIP,
    );
  });
});

describe("stripUnknownKeys — intersection delegates to zod (merge+strip)", () => {
  it("intersection of objects strips keys outside both shapes", () => {
    expectParity(
      z.intersection(z.object({ a: z.string() }), z.object({ b: z.number() })),
      [{ a: "x", b: 1, c: 9 }],
      "stripIntersection",
      STRIP,
    );
  });
});

describe("stripUnknownKeys — mechanism", () => {
  it("returns a FRESH object (not the input by reference)", () => {
    const schema = z.object({ a: z.string() });
    const input = { a: "x", b: 1 };
    const compiled = compileLikeProduction(schema, "stripFresh", STRIP);
    const r = compiled(input);
    expect(r.success).toBe(true);
    expect(dataOf(r)).not.toBe(input);
    expect(dataOf(r)).toEqual({ a: "x" });
    expect(Object.keys(dataOf(r))).toEqual(["a"]);
    // input itself is never mutated
    expect(input).toEqual({ a: "x", b: 1 });
  });

  it("drops symbol-keyed extras", () => {
    const sym = Symbol("s");
    const schema = z.object({ a: z.string() });
    const compiled = compileLikeProduction(schema, "stripSym", STRIP);
    const r = compiled({ a: "x", [sym]: 9 });
    expect(r.success).toBe(true);
    expect(sym in dataOf(r)).toBe(false);
    expect(Object.keys(dataOf(r))).toEqual(["a"]);
  });

  it("strips a JSON-style own-enumerable __proto__ key without polluting", () => {
    const schema = z.object({ a: z.string() });
    const input = JSON.parse('{"a":"x","__proto__":{"polluted":true}}') as Record<string, unknown>;
    const compiled = compileLikeProduction(schema, "stripProto", STRIP);
    const r = compiled(input);
    expect(r.success).toBe(true);
    expect(Object.keys(dataOf(r))).toEqual(["a"]);
    expect(Object.getPrototypeOf(dataOf(r))).toBe(Object.prototype);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("does NOT strip when the option is OFF (default behavior preserved)", () => {
    const schema = z.object({ a: z.string() });
    const input = { a: "x", b: 1 };
    const compiled = compileLikeProduction(schema, "noStrip");
    const r = compiled(input);
    expect(r.success).toBe(true);
    expect(dataOf(r)).toBe(input); // returned by reference, extras kept
    expect(Object.keys(dataOf(r))).toEqual(["a", "b"]);
  });
});
