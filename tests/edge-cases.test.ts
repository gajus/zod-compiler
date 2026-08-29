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
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import { compileLikeProduction, expectParity } from "./parity-harness.js";

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
  /**
   * `__zcFsr` mirrors `util.floatSafeRemainder`, which zod 4.5 re-implemented:
   * the decimal-scaling form it used to be gave the wrong answer at BOTH ends of
   * the float range. Subnormal-ish values scaled to zero and were accepted as a
   * multiple of anything; values at or past 1e21 stringify to exponential
   * notation, which `parseInt` truncated to 1, and were rejected. The
   * ratio/tolerance form has neither failure, and the decimal cases below are
   * what the scaling form existed to get right in the first place.
   */
  it("number.multipleOf below the decimal-scaling floor", () =>
    expectParity(z.number().multipleOf(3), [1e-7, 1e-15, Number.MIN_VALUE, 0]));
  it("number.multipleOf(0.1) at tiny magnitudes", () =>
    expectParity(z.number().multipleOf(0.1), [2e-7, 1e-15, 0.3, 0.7, 2.03]));
  it("number.multipleOf past the 1e21 exponential-notation boundary", () =>
    expectParity(z.number().multipleOf(3), [1e21, -1e21, 1e22, 1e300, Number.MAX_VALUE]));
  it("number.multipleOf(0.5) past 1e21", () =>
    expectParity(z.number().multipleOf(0.5), [1e21, 1e22]));
  it("number.multipleOf(0.07) keeps the decimal tolerance", () =>
    expectParity(z.number().multipleOf(0.07), [2.03, 0.07, 0.14, 0.08]));
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
  it("string.length counts code points (emoji is length 1)", () =>
    expectParity(z.string().length(1), ["😀", "a", "ab", "😀a", "\ud83d"]));
  it("string.min counts code points on surrogate-pair strings", () =>
    expectParity(z.string().min(2), ["😀", "a", "ab", "😀a", "😀😀"]));
  it("string.max counts code points on surrogate-pair strings", () =>
    expectParity(z.string().max(1), ["😀", "a", "ab", "😀a", "😀😀"]));
  it("array length checks count elements, not code points", () =>
    expectParity(z.array(z.string()).min(2), [["😀"], ["😀", "a"], "😀"]));
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

// Regression: a mutating schema inside a discriminated-union OPTION (default,
// catch, coerce, transform, .trim()/.toLowerCase() overwrite, stringbool, or a
// nested object default) must apply and surface its mutation. slowDiscriminatedUnion
// visits each option writing to a fresh local (objVar); without a write-back the
// mutated clone was stranded there and the caller returned the ORIGINAL input by
// reference, silently dropping the mutation. The same mutations applied correctly
// in every other position (plain object, array, record, tuple, non-discriminated
// union) — only the discriminated dispatch lost them. See discriminated-union.ts.
describe("edge cases — discriminated-union options apply their mutations", () => {
  const optA = (inner: z.ZodTypeAny) => z.object({ t: z.literal("a"), x: inner });
  const other = z.object({ t: z.literal("b") });
  it("option field default fires on a missing key", () =>
    expectParity(z.discriminatedUnion("t", [optA(z.number().default(0)), other]), [
      { t: "a" },
      { t: "a", x: 5 },
      { t: "b" },
    ]));
  it("option field optional().default() and default().optional() both fire", () => {
    expectParity(z.discriminatedUnion("t", [optA(z.string().default("d").optional()), other]), [
      { t: "a" },
      { t: "a", x: "y" },
    ]);
    expectParity(z.discriminatedUnion("t", [optA(z.string().optional().default("d")), other]), [
      { t: "a" },
    ]);
  });
  it("option field catch substitutes on failure", () =>
    expectParity(z.discriminatedUnion("t", [optA(z.number().catch(7)), other]), [
      { t: "a", x: "bad" },
      { t: "a", x: 5 },
    ]));
  it("option field coercion converts the value", () =>
    expectParity(z.discriminatedUnion("t", [optA(z.coerce.number()), other]), [
      { t: "a", x: "5" },
      { t: "a", x: 5 },
    ]));
  it("option field overwrite checks (.trim / .toLowerCase) rewrite the value", () => {
    expectParity(z.discriminatedUnion("t", [optA(z.string().trim()), other]), [
      { t: "a", x: "  hi  " },
    ]);
    expectParity(z.discriminatedUnion("t", [optA(z.string().toLowerCase()), other]), [
      { t: "a", x: "HI" },
    ]);
  });
  it("option field zero-capture transform applies", () =>
    expectParity(z.discriminatedUnion("t", [optA(z.string().transform((s) => s.length)), other]), [
      { t: "a", x: "hello" },
    ]));
  it("option field stringbool converts string→boolean", () =>
    expectParity(z.discriminatedUnion("t", [optA(z.stringbool()), other]), [
      { t: "a", x: "true" },
      { t: "a", x: "off" },
    ]));
  it("nested object default inside an option fires", () =>
    expectParity(
      z.discriminatedUnion("t", [optA(z.object({ y: z.string().default("d") })), other]),
      [{ t: "a", x: {} }],
    ));
  it("both options mutate — each branch applies its own default", () =>
    expectParity(
      z.discriminatedUnion("t", [
        optA(z.number().default(1)),
        z.object({ t: z.literal("b"), y: z.string().default("z") }),
      ]),
      [{ t: "a" }, { t: "b" }],
    ));
  it("mutation propagates when the DU is nested in a container", () => {
    const du = z.discriminatedUnion("t", [optA(z.number().default(0)), other]);
    expectParity(z.array(du), [[{ t: "a" }, { t: "b" }]]);
    expectParity(z.object({ item: du }), [{ item: { t: "a" } }]);
    expectParity(z.record(z.string(), du), [{ k: { t: "a" } }]);
  });
});

// Regression: z.literal() with a non-finite numeric value. literalToJs baked the
// value with JSON.stringify, which maps NaN/Infinity/-Infinity all to `null`, so
// z.literal(Infinity) silently behaved like z.literal(null) — rejecting Infinity,
// accepting null, and reporting `expected null`. literalToJs now emits the value
// as a JS expression, and the NaN literal compares via Number.isNaN (NaN === NaN
// is false). See literal.ts / context.ts literalToJs.
describe("edge cases — literal with NaN / Infinity / -Infinity", () => {
  it("literal(NaN) accepts only NaN (not null), with the right message", () =>
    expectParity(z.literal(Number.NaN as unknown as number), [Number.NaN, null, 1, "NaN"]));
  it("literal(Infinity) accepts only Infinity", () =>
    expectParity(z.literal(Infinity as unknown as number), [Infinity, -Infinity, null, 1]));
  it("literal(-Infinity) accepts only -Infinity", () =>
    expectParity(z.literal(-Infinity as unknown as number), [-Infinity, Infinity, null, 1]));
  it("multi-value literal mixing finite and non-finite values", () => {
    expectParity(z.literal([1, Infinity as unknown as number]), [1, Infinity, 2, null]);
    expectParity(z.literal([Number.NaN as unknown as number, "x"]), [Number.NaN, "x", "y", null]);
  });
  it("non-finite literal nested in an object field", () =>
    expectParity(z.object({ v: z.literal(Infinity as unknown as number) }), [
      { v: Infinity },
      { v: null },
      { v: 1 },
    ]));
});

// A mutating element schema (coerce / zero-capture transform / stringbool /
// default) forces the container to REBUILD from the validated elements instead
// of returning the input by reference — the output must carry every converted
// value at the right position/key. Earlier suites cover this only for
// `.trim()` inside Set/Map (zod-parity); array/record/tuple element conversion
// (and dedup/order interactions in Set/Map) exercise distinct rebuild codegen.
describe("edge cases — mutating element schemas rebuild the collection", () => {
  it("array of coerced numbers yields the converted array", () =>
    expectParity(z.array(z.coerce.number()), [["1", "2", "3"], ["1", "x"], [], ["1", true, null]]));
  it("array of zero-capture transforms maps each element", () =>
    expectParity(z.array(z.string().transform((s) => s.length)), [
      ["a", "bb", "ccc"],
      ["a", 1],
    ]));
  it("array of stringbool converts each element", () =>
    expectParity(z.array(z.stringbool()), [
      ["true", "false", "on", "off"],
      ["true", "maybe"],
    ]));
  it("record of coerced numbers converts each value, keeps keys", () =>
    expectParity(z.record(z.string(), z.coerce.number()), [{ a: "1", b: "2" }, { a: "x" }]));
  it("record of zero-capture transforms maps each value", () =>
    expectParity(
      z.record(
        z.string(),
        z.string().transform((s) => s.toUpperCase()),
      ),
      [{ a: "x", b: "y" }],
    ));
  it("tuple with coerced and transformed slots", () =>
    expectParity(z.tuple([z.coerce.number(), z.coerce.boolean()]), [
      ["5", "yes"],
      ["x", ""],
    ]));
  it("tuple mixing a transform slot with a plain slot", () =>
    expectParity(z.tuple([z.string().transform((s) => s.length), z.number()]), [
      ["ab", 1],
      ["ab", "x"],
    ]));
  it("set of coerced numbers dedups AFTER conversion", () =>
    // "1" and 1 both coerce to 1 — the resulting Set must collapse them, matching
    // Zod's post-conversion dedup (distinct from the trimmed-string case above).
    expectParity(z.set(z.coerce.number()), [new Set<unknown>(["1", 1, "2"]), new Set(["x"])]));
  it("map with coerced keys and values", () =>
    expectParity(z.map(z.coerce.string(), z.coerce.number()), [
      new Map<unknown, unknown>([
        [1, "2"],
        [3, "4"],
      ]),
    ]));
  it("array of objects each carrying a field default", () =>
    expectParity(z.array(z.object({ n: z.string().default("d"), m: z.number() })), [
      [{ m: 1 }, { n: "x", m: 2 }],
    ]));
});

// Container-level `.catch()` / `.default()` wrap a whole array/object/record.
// The matrix covers primitive catch/default; a container substitute value (and
// the present-but-invalid → substitute path) is a distinct codegen branch.
describe("edge cases — container-level catch and default", () => {
  it("array().catch substitutes on any failure", () =>
    expectParity(z.array(z.number()).catch([]), [[1, 2], [1, "x"], "nope", undefined]));
  it("object().catch substitutes the whole object", () =>
    expectParity(z.object({ a: z.string() }).catch({ a: "fallback" }), [
      { a: "x" },
      { a: 1 },
      "nope",
    ]));
  it("array().default fills a missing input", () =>
    expectParity(z.array(z.number()).default([]), [undefined, [1, 2], [1, "x"]]));
  it("object().default fills a missing input but still validates a present one", () =>
    expectParity(z.object({ a: z.string() }).default({ a: "d" }), [
      undefined,
      { a: "x" },
      { a: 1 },
    ]));
  it("record().default fills a missing input", () =>
    expectParity(z.record(z.string(), z.number()).default({}), [undefined, { a: 1 }, { a: "x" }]));
});

// Wrapper chains, pipe+coercion, ISO format options, and zero-boundary checks —
// each compiles a path the one-case-per-feature matrix does not reach.
describe("edge cases — wrapper chains, pipe+coerce, ISO options, zero boundaries", () => {
  it("deeply chained optional/nullable wrappers", () => {
    expectParity(z.string().optional().nullable().optional(), [undefined, null, "x", 1]);
    expectParity(z.array(z.string()).optional().default([]), [undefined, ["a"], "x"]);
    expectParity(z.number().catch(0).optional().nullable(), [undefined, null, 5, "x"]);
  });
  it("coercion piped into a checked schema", () => {
    expectParity(z.coerce.number().pipe(z.number().int()), ["5", "5.5", "x"]);
    expectParity(z.string().pipe(z.coerce.number()), ["5", "x", 5]);
  });
  it("ISO format constructor options", () => {
    expectParity(z.iso.time({ precision: 3 }), ["12:30:00.123", "12:30:00", "12:30:00.1"]);
    expectParity(z.iso.datetime({ local: true }), ["2024-01-01T12:30:00", "2024-01-01T12:30:00Z"]);
    expectParity(z.iso.datetime({ offset: true }), [
      "2024-01-01T12:30:00+02:00",
      "2024-01-01T12:30:00Z",
      "2024-01-01T12:30:00",
    ]);
  });
  it("zero-boundary length/size/multipleOf checks", () => {
    expectParity(z.string().min(0), ["", "x"]);
    expectParity(z.string().length(0), ["", "x"]);
    expectParity(z.array(z.number()).length(0), [[], [1]]);
    expectParity(z.number().multipleOf(0), [0, 1, 5]); // x % 0 is NaN — only 0 can pass in Zod
    // `x % 0n` THROWS where the number branch merely yields NaN, so zod 4.5
    // guards the divisor ($ZodCheckMultipleOf) and reports not_multiple_of for
    // every input. Emitting the bare `%` here crashed safeParse outright.
    expectParity(z.bigint().multipleOf(0n), [0n, 1n, 5n]);
    expectParity(z.object({ v: z.bigint().multipleOf(0n) }), [{ v: 0n }, { v: 1n }]);
  });
});

/**
 * `z.string().min()/.max()/.length()` measure Unicode CODE POINTS, and the
 * compiled form skips that count when the UTF-16 unit count already settles the
 * verdict. The skip threshold has to round a FRACTIONAL bound up: `min(2.5)` is
 * only certain at 5 units, and the `2 * min - 1` form claimed it at 4 — where
 * two astral characters are 4 units but just 2 code points, which zod rejects.
 */
describe("edge cases — fractional length bounds over astral characters", () => {
  const ASTRAL = ["", "a", "😀", "😀a", "😀😀", "😀😀😀", "😀😀😀😀", "abcd", "\uD800", "👨‍👩‍👦"];
  for (const bound of [0.5, 1.5, 2.5, 3.5]) {
    it(`string.min(${bound})`, () => expectParity(z.string().min(bound), [...ASTRAL]));
    it(`string.max(${bound})`, () => expectParity(z.string().max(bound), [...ASTRAL]));
    it(`string.length(${bound})`, () => expectParity(z.string().length(bound), [...ASTRAL]));
    it(`object property min(${bound})`, () =>
      expectParity(
        z.object({ v: z.string().min(bound) }),
        ASTRAL.map((v) => ({ v })),
      ));
    // The when-gated copy: an array's length check still fires on a string, and
    // zod measures THAT in code points.
    it(`array.min(${bound}) over a string`, () =>
      expectParity(z.array(z.number()).min(bound), [...ASTRAL]));
  }
});

/**
 * A shape may legitimately declare `__proto__`. It cannot be written as a plain
 * object-literal key (`{__proto__: x}` is the prototype setter, quoted form
 * included), but a computed key or a dynamically built shape — generating a
 * schema from DB columns or an OpenAPI document — produces one, and Zod stores
 * and validates it like any other key.
 *
 * The IR used to collect properties into a normal object, so `properties[key] =
 * ir` re-entered that same setter and dropped the property. What survived was a
 * shape Zod validates and the compiler did not: an unsound ACCEPT for
 * object/looseObject (the field went unchecked, and a required one could be
 * missing entirely), and a false REJECT for strictObject (the declared key read
 * as unrecognized). Inputs carry a real own `__proto__` only via JSON.parse,
 * which is exactly how untrusted payloads arrive.
 *
 * These assert the VERDICT and the issues. Output data is compared only under
 * `stripUnknownKeys`, where the compiler rebuilds the object as Zod does; the
 * by-reference default differs for this key and is pinned in
 * known-divergences.test.ts.
 */
// zod's shape loop skips a declared `__proto__` outright: the key is
// recognized (never reported as unknown) but its schema never runs and the
// output never carries it, in every object mode.
describe("edge cases — a shape declaring __proto__", () => {
  const shapeWith = (inner: z.ZodType): Record<string, z.ZodType> =>
    Object.fromEntries([
      ["__proto__", inner],
      ["b", z.string()],
    ]) as Record<string, z.ZodType>;

  /** Own `__proto__` arrives only through JSON.parse — an object literal would set the prototype. */
  const inputs = [
    JSON.parse('{"__proto__":"s","b":"x"}'),
    JSON.parse('{"__proto__":123,"b":"x"}'),
    JSON.parse('{"__proto__":"s","b":1}'),
    JSON.parse('{"b":"x"}'),
    JSON.parse('{"__proto__":"s","b":"x","extra":1}'),
    {},
    { b: "x" },
  ];

  /** Verdict + issue parity, leaving the by-reference output difference aside. */
  const expectVerdictParity = (schema: z.ZodType, cases: unknown[], name: string) => {
    const compiled = compileLikeProduction(schema, name);
    for (const input of cases) {
      const zodResult = schema.safeParse(input);
      const mine = compiled(input);
      const label = `${name}: ${JSON.stringify(input)}`;
      expect(mine.success, label).toBe(zodResult.success);
      if (!mine.success && !zodResult.success) {
        const codes = (r: { error?: { issues: readonly unknown[] } }) =>
          (r.error?.issues ?? []).map((raw) => {
            const issue = raw as { code: string; path: readonly (string | number)[] };
            return { code: issue.code, path: issue.path };
          });
        expect(codes(mine), label).toEqual(codes(zodResult));
      }
    }
  };

  it("z.object strips the declared key without validating it", () =>
    expectVerdictParity(z.object(shapeWith(z.string())), inputs, "protoObject"));
  it("z.strictObject recognizes it rather than reporting it unknown", () =>
    expectVerdictParity(z.strictObject(shapeWith(z.string())), inputs, "protoStrict"));
  it("z.looseObject skips it too", () =>
    expectVerdictParity(z.looseObject(shapeWith(z.string())), inputs, "protoLoose"));
  it("skips it when nested", () =>
    expectVerdictParity(
      z.object({ outer: z.object(shapeWith(z.string())) }),
      [
        JSON.parse('{"outer":{"__proto__":"s","b":"x"}}'),
        JSON.parse('{"outer":{"__proto__":123,"b":"x"}}'),
        JSON.parse('{"outer":{"b":"x"}}'),
      ],
      "protoNested",
    ));
  it("its checks and wrappers never run", () => {
    expectVerdictParity(
      z.object(shapeWith(z.string().min(3))),
      [JSON.parse('{"__proto__":"abc","b":"x"}'), JSON.parse('{"__proto__":"ab","b":"x"}')],
      "protoChecks",
    );
    expectVerdictParity(
      z.object(shapeWith(z.string().optional())),
      [
        JSON.parse('{"__proto__":"s","b":"x"}'),
        JSON.parse('{"b":"x"}'),
        JSON.parse('{"__proto__":1,"b":"x"}'),
      ],
      "protoOptional",
    );
  });

  // Strip mode rebuilds the output exactly as Zod does, so full parity —
  // including the absence of this key from the data — holds there.
  it("full parity under stripUnknownKeys", () =>
    expectParity(z.object(shapeWith(z.string())), inputs, "protoStrip", {
      stripUnknownKeys: true,
    }));

  // Other Object.prototype names are ordinary string keys under plain
  // assignment, but they share the "declared key shadows an inherited name"
  // shape, so they are pinned alongside.
  it.each(["constructor", "toString", "valueOf", "hasOwnProperty"])(
    "z.strictObject with a declared %s key",
    (key) =>
      expectParity(
        z.strictObject(
          Object.fromEntries([
            [key, z.string()],
            ["b", z.string()],
          ]) as Record<string, z.ZodType>,
        ),
        [JSON.parse(`{${JSON.stringify(key)}:"s","b":"x"}`), JSON.parse('{"b":"x"}')],
      ),
  );
});
