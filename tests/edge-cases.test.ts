/**
 * Edge-case parity regression suite.
 *
 * Differential parity for subtle inputs that the broader suites don't exercise:
 * coercion of exotic/host values, collections containing NaN, numeric/date/bigint
 * boundary values, and Unicode/negative-zero corners. Every case must match Zod
 * on accept/reject, output data, and first message (or fall back, which is parity
 * by construction). These complement zod-feature-matrix's one-case-per-feature
 * coverage with adversarial inputs per feature.
 */
import { describe, it } from "vitest";
import { z } from "zod";
import { expectParity } from "./parity-harness.js";

describe("edge cases — coercion of exotic strings", () => {
  it("coerce.number: radix/format strings", () =>
    expectParity(z.coerce.number(), [
      "0x1F",
      "0b101",
      "0o17",
      "1_000",
      "1,000",
      "  5  ",
      "",
      "\t\n",
      "Infinity",
      "-Infinity",
      ".5",
      "5.",
      "1e3",
      "  ",
      "NaN",
    ]));
  it("coerce.number: non-string hosts coerce via ToNumber", () =>
    expectParity(z.coerce.number(), [
      [],
      [5],
      [5, 6],
      {},
      true,
      false,
      null,
      new Date(0),
      { valueOf: () => 7 },
    ]));
  it("coerce.bigint: radix strings, decimals, hosts (RangeError → reject)", () =>
    expectParity(z.coerce.bigint(), [
      "0x10",
      "0b11",
      "  9  ",
      "",
      "1.5",
      1.5,
      true,
      false,
      null,
      [],
      [5],
      {},
      new Date(0),
    ]));
  it("coerce.boolean: every JS value is truthy except the falsy set", () =>
    expectParity(z.coerce.boolean(), [
      "",
      "false",
      "0",
      "no",
      0,
      Number.NaN,
      null,
      undefined,
      [],
      {},
      "  ",
    ]));
  it("coerce.date: invalid calendar dates, epoch extremes, hosts", () =>
    expectParity(z.coerce.date(), [
      "2024-02-30",
      "2024-13-01",
      "",
      "  ",
      0,
      -1,
      1e15,
      8.7e15,
      true,
      [],
      [0],
      {},
      "now",
    ]));
  it("coerce.string: numbers, bigint, host objects with toString", () =>
    expectParity(z.coerce.string(), [
      123,
      true,
      null,
      undefined,
      { toString: () => "hi" },
      [1, 2],
      0,
      -0,
      Number.NaN,
      10n,
    ]));
});

describe("edge cases — collections with NaN / special values", () => {
  it("set(number) containing NaN", () =>
    expectParity(z.set(z.number()), [new Set([Number.NaN, 1])]));
  it("set(number) NaN passing the size check (element issue only)", () =>
    // Size 2 satisfies min(2), so only the NaN element issue surfaces — no
    // simultaneous size failure, so ordering is unambiguous here. The
    // size-fails-too case is a known divergence (see known-divergences.test.ts).
    expectParity(z.set(z.number()).min(2), [new Set([Number.NaN, 1])]));
  it("map(number, string) with NaN key", () =>
    expectParity(z.map(z.number(), z.string()), [new Map([[Number.NaN, "x"]])]));
  it("array(number) containing NaN rejects (NaN is not a valid number)", () =>
    expectParity(z.array(z.number()), [[1, Number.NaN, 3]]));
  it("set of trimmed elements: dedup happens after mutation", () =>
    expectParity(z.set(z.string().trim()), [new Set([" a ", "a"]), new Set([" a ", " b "])]));
});

describe("edge cases — numeric / bigint / date boundaries", () => {
  it("number.int() at the safe-integer boundary", () =>
    expectParity(z.number().int(), [
      Number.MAX_SAFE_INTEGER,
      Number.MAX_SAFE_INTEGER + 1,
      2 ** 53,
      -(2 ** 53),
      Number.MIN_SAFE_INTEGER,
    ]));
  it("number.lte(MAX_VALUE) at the float64 ceiling", () =>
    expectParity(z.number().lte(Number.MAX_VALUE), [Number.MAX_VALUE, Number.MAX_VALUE / 2]));
  it("number.min(0).max(0) accepts both signed zeros", () =>
    expectParity(z.number().min(0).max(0), [0, -0]));
  it("number.int().multipleOf(3) at integer-valued floats", () =>
    expectParity(z.number().int().multipleOf(3), [9, 9.0, 10, 1.5]));
  it("int64 at the two's-complement edges", () =>
    expectParity(z.int64(), [2n ** 63n - 1n, 2n ** 63n, -(2n ** 63n), -(2n ** 63n) - 1n]));
  it("uint64 at the unsigned edges", () =>
    expectParity(z.uint64(), [0n, -1n, 2n ** 64n - 1n, 2n ** 64n]));
  it("date.min at the exact millisecond boundary", () =>
    expectParity(z.date().min(new Date("2020-01-01T00:00:00.000Z")), [
      new Date("2020-01-01T00:00:00.000Z"),
      new Date("2019-12-31T23:59:59.999Z"),
      new Date("2020-01-01T00:00:00.001Z"),
    ]));
});

describe("edge cases — string Unicode and negative zero", () => {
  it("string.length counts UTF-16 code units (emoji is length 2)", () =>
    expectParity(z.string().length(1), ["😀", "a", "ab"]));
  it("string.min on surrogate-pair strings", () =>
    expectParity(z.string().min(2), ["😀", "a", "ab"]));
  it("literal(0) treats -0 and 0 as equal (=== semantics)", () =>
    expectParity(z.literal(0), [0, -0]));
  it("literal(-0) treats 0 and -0 as equal", () => expectParity(z.literal(-0), [0, -0]));
  it("number.positive() rejects both zeros", () => expectParity(z.number().positive(), [0, -0, 1]));
});

describe("edge cases — stringbool and templateLiteral inputs", () => {
  it("stringbool: case-insensitive truthy/falsy and unknowns", () =>
    expectParity(z.stringbool(), ["TRUE", "True", "ON", "off", "y", "n", "enabled", " true ", ""]));
  it("templateLiteral with an enum interpolation", () =>
    expectParity(z.templateLiteral(["v", z.enum(["1", "2"])]), ["v1", "v2", "v3", "v", "1"]));
});

// Regression: collections must surface an invalid-element issue BEFORE a failing
// size check, matching Zod's parse-then-check order. (Previously the compiler
// emitted size checks first and reported too_small/too_big ahead of the element
// issue.)
describe("edge cases — collection element-before-size issue ordering", () => {
  it("array.min: element invalid_type precedes too_small", () =>
    expectParity(z.array(z.number()).min(3), [["x"]]));
  it("array.max: element invalid_type precedes too_big", () =>
    expectParity(z.array(z.number()).max(1), [["x", "y"]]));
  it("array.length: element invalid_type precedes the length issue", () =>
    expectParity(z.array(z.number()).length(3), [["x"], ["x", "y", "z", 1]]));
  it("array.refine: element invalid_type precedes the refine issue", () =>
    expectParity(
      z.array(z.number()).refine((a) => a.length > 2, "need 3"),
      [["x"]],
    ));
  it("set.min: element invalid_type precedes too_small", () =>
    expectParity(z.set(z.number()).min(2), [new Set([Number.NaN])]));
  it("set.max: element invalid_type precedes too_big", () =>
    expectParity(z.set(z.number()).max(1), [new Set([Number.NaN, "z"])]));
  it("array of objects: element error precedes too_small", () =>
    expectParity(z.array(z.object({ n: z.number() })).min(3), [[{ n: "x" }]]));
  it("nested array: inner element error precedes inner size, then outer", () =>
    expectParity(z.array(z.array(z.number()).min(2)).min(2), [[["x"]]]));
});

// Regression: a discriminated union whose options share a discriminator value is
// a misconfigured schema. Zod throws "Duplicate discriminator value" at parse;
// the extractor now delegates such unions to Zod so the throw is reproduced
// rather than silently dispatching to the first matching option.
describe("edge cases — discriminated union with duplicate discriminator", () => {
  it("throws at parse like Zod (delegated)", () => {
    const dup = z.discriminatedUnion("t", [
      z.object({ t: z.literal("a"), x: z.string() }),
      z.object({ t: z.literal("a"), y: z.number() }),
    ]);
    expectParity(dup, [
      { t: "a", x: "s" },
      { t: "a", y: 1 },
    ]);
  });
  it("non-duplicate discriminated union still compiles and matches Zod", () =>
    expectParity(
      z.discriminatedUnion("t", [
        z.object({ t: z.literal("a"), x: z.string() }),
        z.object({ t: z.literal("b"), y: z.number() }),
      ]),
      [{ t: "a", x: "s" }, { t: "b", y: 1 }, { t: "c" }, { t: "a", x: 1 }],
    ));
  it("enum discriminators with an overlapping value fall back like Zod", () =>
    expectParity(
      z.discriminatedUnion("t", [
        z.object({ t: z.enum(["a", "b"]), x: z.string() }),
        z.object({ t: z.enum(["b", "c"]), y: z.number() }),
      ]),
      [
        { t: "a", x: "s" },
        { t: "b", x: "s" },
        { t: "c", y: 1 },
      ],
    ));
});
