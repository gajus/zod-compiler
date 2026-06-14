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

// Regression: `.default()` applies whenever the input is undefined — INCLUDING
// when it sits under an `.optional()`/`.nullish()` (or any chain of
// optional/nullable wrappers above it). `z.string().default("d").optional()`
// yields "d" on undefined, not undefined. The optional codegen previously
// short-circuited undefined→undefined and skipped the inner default, corrupting
// the success output. (`.nullable()` was already correct — it only short-circuits
// null.) See src/core/codegen/schemas/optional.ts.
describe("edge cases — default fires through optional/nullish wrappers", () => {
  it("default under optional (both orderings)", () => {
    expectParity(z.string().default("d").optional(), [undefined, "x", 1]);
    expectParity(z.string().optional().default("d"), [undefined, "x", 1]);
  });
  it("default under nullable / nullish (every ordering yields the default on undefined)", () => {
    expectParity(z.string().default("d").nullable(), [undefined, null, "x"]);
    expectParity(z.string().nullable().default("d"), [undefined, null, "x"]);
    expectParity(z.string().default("d").nullish(), [undefined, null, "x"]);
    expectParity(z.string().default("d").optional().nullable(), [undefined, null, "x"]);
  });
  it("optional/nullable WITHOUT an inner default still short-circuits (no regression)", () => {
    expectParity(z.string().optional(), [undefined, "x"]);
    expectParity(z.string().nullable().optional(), [undefined, null, "x"]);
    expectParity(z.string().catch("c").optional(), [undefined, 1, "x"]); // catch ≠ default: undefined→undefined
  });
});

// Regression: a plain union of exactly one option IS that option — zod surfaces
// the single option's own issue (no invalid_union wrapper) and ignores any
// union-level { error }. The extractor now collapses union([X]) → X, so the
// message matches zod's inner message when the sole option aborts (invalid_type),
// which previously diverged to a generic "Invalid input". See extractors/union.ts.
describe("edge cases — single-option union collapses to its option", () => {
  it("sole aborting option surfaces its own invalid_type message", () =>
    expectParity(z.union([z.string()]), [1, "x"]));
  it("sole option's check issue still surfaces directly", () =>
    expectParity(z.union([z.string().min(5)]), ["abc", "abcde"]));
  it("union-level error is ignored, option mutation applies", () => {
    expectParity(z.union([z.string()], { error: "u" }), [1]);
    expectParity(z.union([z.string().trim()]), ["  x  "]);
  });
  it("single object option surfaces nested field issue", () =>
    expectParity(z.union([z.object({ a: z.string() })]), [1, { a: 1 }, { a: "x" }]));
});

// default/catch short-circuit semantics: the substituted value is returned
// verbatim — zod does NOT re-validate it against the base schema's checks.
describe("edge cases — default/catch value bypasses the base checks", () => {
  it("default value that would fail min() is still used", () =>
    expectParity(z.number().min(5).default(1), [undefined, 10, 2]));
  it("catch value that would fail min() is still used on failure", () =>
    expectParity(z.number().min(5).catch(1), [undefined, 10, 2, "x"]));
  it("default inside an object field", () =>
    expectParity(z.object({ a: z.string().default("d"), b: z.number() }), [
      { b: 1 },
      { a: "x", b: 1 },
      { a: 1, b: 1 },
    ]));
});

// Coercion composed WITH checks and wrappers (the matrix/edge suites exercise
// bare coerce; the conversion → check → wrap pipeline is where ordering bugs hide).
describe("edge cases — coercion composed with checks and wrappers", () => {
  it("coerce.number().int() on fractional vs integer-valued strings", () =>
    expectParity(z.coerce.number().int(), ["3.5", "3.0", "3", "x", true, 4.2]));
  it("coerce.number().int().min().max()", () =>
    expectParity(z.coerce.number().int().min(0).max(10), ["-1", "5", "11", "3.5"]));
  it("coerce.bigint().positive()", () =>
    expectParity(z.coerce.bigint().positive(), ["5", "-5", "0", 5, 1.5]));
  it("coerce.date().min()", () =>
    expectParity(z.coerce.date().min(new Date("2020-01-01")), [
      "2019-01-01",
      "2021-01-01",
      "nope",
    ]));
  it("coerce.number().optional() (coercion of undefined vs present)", () =>
    expectParity(z.coerce.number().optional(), [undefined, "5", "x"]));
});

// Containers nested INSIDE one another — the feature matrix tests each container
// in isolation; real schemas nest them, and issue paths must thread through.
describe("edge cases — nested container combinations", () => {
  it("array of discriminated unions", () =>
    expectParity(
      z.array(
        z.discriminatedUnion("t", [
          z.object({ t: z.literal("a"), x: z.string() }),
          z.object({ t: z.literal("b"), y: z.number() }),
        ]),
      ),
      [
        [
          { t: "a", x: "s" },
          { t: "b", y: 1 },
        ],
        [{ t: "a", x: 1 }],
        [{ t: "c" }],
      ],
    ));
  it("record of arrays", () =>
    expectParity(z.record(z.string(), z.array(z.number())), [
      { a: [1, 2], b: [3] },
      { a: [1, "x"] },
    ]));
  it("map with object values", () =>
    expectParity(z.map(z.string(), z.object({ n: z.number() })), [
      new Map([["a", { n: 1 }]]),
      new Map([["a", { n: "x" } as { n: number }]]),
    ]));
  it("set of objects", () =>
    expectParity(z.set(z.object({ n: z.number() })), [
      new Set([{ n: 1 }]),
      new Set([{ n: "x" } as { n: number }]),
    ]));
  it("nested record of record", () =>
    expectParity(z.record(z.string(), z.record(z.string(), z.number())), [
      { a: { b: 1 } },
      { a: { b: "x" } },
    ]));
});

// Multi-issue ordering and path correctness in nested structures (zod reports in
// a specific order; paths must be exact arrays, not just present format() keys).
describe("edge cases — multi-issue ordering and paths", () => {
  it("object: failing fields keep definition order", () =>
    expectParity(z.object({ a: z.string(), b: z.number(), c: z.boolean() }), [
      { a: 1, b: "x", c: "y" },
      { a: 1 }, // missing + present-wrong mix
    ]));
  it("array of objects: per-element issue paths", () =>
    expectParity(z.array(z.object({ n: z.number() })), [[{ n: 1 }, { n: "x" }, { n: "y" }]]));
  it("record: multiple bad values keep key order", () =>
    expectParity(z.record(z.string(), z.number()), [{ a: "x", b: "y", c: 1 }]));
  it("map: a key issue and a value issue coexist", () =>
    expectParity(z.map(z.number(), z.string()), [
      new Map<unknown, unknown>([
        ["k", 1],
        [2, "ok"],
      ]) as Map<number, string>,
    ]));
  it("deeply nested object path", () =>
    expectParity(z.object({ a: z.object({ b: z.object({ c: z.number() }) }) }), [
      { a: { b: { c: "x" } } },
    ]));
  it("strict object: field issue ordered before unrecognized keys", () =>
    expectParity(z.strictObject({ a: z.number() }), [{ a: "x", extra: 1, more: 2 }]));
});

// Template literals with varied interpolation parts (the matrix has only the
// number case; boolean/optional/literal-union parts compile distinct patterns).
describe("edge cases — template literal interpolations", () => {
  it("multiple interpolations", () =>
    expectParity(z.templateLiteral([z.string(), "-", z.number()]), ["a-1", "-1", "a-x", "a-"]));
  it("boolean interpolation", () =>
    expectParity(z.templateLiteral(["flag:", z.boolean()]), ["flag:true", "flag:false", "flag:x"]));
  it("literal-union interpolation", () =>
    expectParity(z.templateLiteral(["x", z.literal(["a", "b"])]), ["xa", "xb", "xc"]));
});

// Custom messages on top-level format constructors (z.email("m"), not just the
// chained z.string().email("m") the matrix covers) — the recently-fixed
// custom-message-dropping bug class lived in exactly these extractor paths.
describe("edge cases — top-level format constructor custom messages", () => {
  it("email / url / uuid / ipv4 keep their custom message", () => {
    expectParity(z.email("bad email"), ["nope", "a@b.com"]);
    expectParity(z.url("bad url"), ["nope", "https://a.com"]);
    expectParity(z.uuid("bad uuid"), ["nope", "123e4567-e89b-42d3-a456-426614174000"]);
    expectParity(z.ipv4("bad ip"), ["999.1.1.1", "192.168.1.1"]);
  });
  it("iso.datetime keeps its custom message", () =>
    expectParity(z.iso.datetime("bad dt"), ["nope", "2024-01-15T12:30:00Z"]));
});

// Static-vs-dynamic error-map classification (resolveCheckMessage in checks.ts):
// a function that returns a constant {message} object bakes statically; one that
// inspects the issue (via property read, `in`, or Object.keys) is dynamic and
// must fall back so zod produces the exact message.
describe("edge cases — error-map shapes (static bake vs dynamic fallback)", () => {
  it("constant error map returning a {message} object bakes", () =>
    expectParity(z.string({ error: () => ({ message: "custom obj" }) }), [42, "x"]));
  it("error map probing the issue via `in` falls back", () =>
    expectParity(z.string({ error: (iss) => ("input" in iss ? "has" : "no") }), [42]));
  it("error map probing the issue via Object.keys falls back", () =>
    expectParity(z.string({ error: (iss) => (Object.keys(iss).length ? "k" : "n") }), [42]));
});
