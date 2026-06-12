/**
 * Exhaustive Zod feature matrix.
 *
 * One differential parity case per public Zod v4 feature: every schema
 * constructor, check, string format, wrapper, composition primitive, and
 * coercion. Each case must either compile with exact Zod parity or fall back
 * to Zod (which is parity by construction). This suite is the proof that
 * zod-compiler covers the entire Zod surface without silent divergence.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { compileLikeProduction, expectParity } from "./parity-harness.js";

const GOOD_JWT =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";

describe("feature matrix — primitives", () => {
  it("string", () => expectParity(z.string(), ["x", "", 1, null, undefined]));
  it("number", () => expectParity(z.number(), [1, 1.5, Number.NaN, Infinity, "1", null]));
  it("int", () => expectParity(z.int(), [1, 1.5, Number.MAX_SAFE_INTEGER + 1, "1"]));
  it("boolean", () => expectParity(z.boolean(), [true, false, 0, "true"]));
  it("bigint", () => expectParity(z.bigint(), [1n, 1, "1"]));
  it("symbol", () => expectParity(z.symbol(), [Symbol("s"), "s"]));
  it("undefined", () => expectParity(z.undefined(), [undefined, null, 0]));
  it("null", () => expectParity(z.null(), [null, undefined, 0]));
  it("void", () => expectParity(z.void(), [undefined, null]));
  it("never", () => expectParity(z.never(), [undefined, null, "x", 1]));
  it("any", () => expectParity(z.any(), ["x", 1, null, undefined, {}]));
  it("unknown", () => expectParity(z.unknown(), ["x", 1, null, undefined, {}]));
  it("nan", () => expectParity(z.nan(), [Number.NaN, 1, "NaN"]));
  it("date", () => expectParity(z.date(), [new Date(), new Date("invalid"), "2024-01-01", 0]));
});

describe("feature matrix — literals and enums", () => {
  it("literal string", () => expectParity(z.literal("a"), ["a", "b", 1]));
  it("literal number", () => expectParity(z.literal(5), [5, "5", 6]));
  it("literal boolean", () => expectParity(z.literal(true), [true, false]));
  it("literal null", () => expectParity(z.literal(null), [null, undefined]));
  it("literal multi-value", () => expectParity(z.literal(["a", "b", 3]), ["a", "b", 3, "c", 4]));
  it("enum", () => expectParity(z.enum(["a", "b", "c"]), ["a", "c", "d", 1, null]));
  it("enum 2 values (inline path)", () => expectParity(z.enum(["a", "b"]), ["a", "b", "c"]));
  it("enum many values (Set path)", () =>
    expectParity(z.enum(["a", "b", "c", "d", "e"]), ["a", "e", "f"]));
  it("nativeEnum string values", () =>
    expectParity(z.nativeEnum({ A: "alpha", B: "beta" }), ["alpha", "beta", "A", "x"]));
  it("nativeEnum numeric values", () => {
    enum E {
      A = 1,
      B = 2,
    }
    expectParity(z.nativeEnum(E), [1, 2, 3, "A", "1"]);
  });
  it("nativeEnum mixed values", () =>
    expectParity(z.nativeEnum({ A: 1, B: "two" }), [1, "two", 2, "A"]));
  it("keyof", () =>
    expectParity(z.keyof(z.object({ a: z.string(), b: z.number() })), ["a", "b", "c"]));
});

describe("feature matrix — string checks", () => {
  it("min/max", () => expectParity(z.string().min(2).max(4), ["a", "ab", "abcd", "abcde"]));
  it("length", () => expectParity(z.string().length(3), ["ab", "abc", "abcd"]));
  it("regex", () => expectParity(z.string().regex(/^a+$/), ["aaa", "b"]));
  it("regex with flags", () => expectParity(z.string().regex(/^a+$/i), ["AAA", "aaa", "b"]));
  it("includes", () => expectParity(z.string().includes("@"), ["a@b", "ab"]));
  it("includes with position", () =>
    expectParity(z.string().includes("@", { position: 2 }), ["ab@c", "@abc"]));
  it("startsWith", () => expectParity(z.string().startsWith("ab"), ["abc", "bc"]));
  it("endsWith", () => expectParity(z.string().endsWith("yz"), ["xyz", "xy"]));
  it("trim", () => expectParity(z.string().trim(), ["  pad  ", "clean"]));
  it("toLowerCase", () => expectParity(z.string().toLowerCase(), ["MiXeD", "low"]));
  it("toUpperCase", () => expectParity(z.string().toUpperCase(), ["MiXeD", "UP"]));
  it("normalize", () => expectParity(z.string().normalize(), ["é", "plain"]));
  it("slugify (falls back: captured util)", () =>
    expectParity(z.string().check(z.slugify()), ["Hello World!", "ok"]));
  it("lowercase check", () => expectParity(z.string().lowercase(), ["abc", "Abc"]));
  it("uppercase check", () => expectParity(z.string().uppercase(), ["ABC", "AbC"]));
  it("chained checks across mutation", () =>
    // min(2) sees the raw (padded) value; max(4) sees the trimmed value
    expectParity(z.string().min(2).trim().max(4), ["  abc  ", " abcdef ", "a", "abcd"]));
});

describe("feature matrix — string formats", () => {
  it("email", () => expectParity(z.email(), ["a@b.com", "nope"]));
  it("email custom pattern", () =>
    expectParity(z.email({ pattern: z.regexes.html5Email }), ["a@b.com", "nope"]));
  it("uuid", () => expectParity(z.uuid(), ["123e4567-e89b-42d3-a456-426614174000", "nope"]));
  it("uuidv4", () => expectParity(z.uuidv4(), ["123e4567-e89b-42d3-a456-426614174000", "nope"]));
  it("uuidv6", () => expectParity(z.uuidv6(), ["1ec9414c-232a-6b00-b3c8-9f6bdeced846", "nope"]));
  it("uuidv7", () => expectParity(z.uuidv7(), ["017f22e2-79b0-7cc3-98c4-dc0c0c07398f", "nope"]));
  it("guid", () => expectParity(z.guid(), ["123e4567-e89b-12d3-a456-426614174000", "nope"]));
  it("url", () => expectParity(z.url(), ["https://a.com", " https://a.com ", "nope"]));
  it("url with hostname/protocol options", () =>
    expectParity(z.url({ protocol: /^https$/, hostname: /\.com$/ }), [
      "https://a.com",
      "http://a.com",
      "https://a.org",
    ]));
  it("httpUrl", () => expectParity(z.httpUrl(), ["https://a.com", "ftp://a.com", "nope"]));
  it("hostname", () => expectParity(z.hostname(), ["example.com", "not a host!"]));
  it("emoji", () => expectParity(z.emoji(), ["😀", "x"]));
  it("nanoid", () => expectParity(z.nanoid(), ["V1StGXR8_Z5jdHi6B-myT", "nope!"]));
  it("cuid", () => expectParity(z.cuid(), ["cjld2cjxh0000qzrmn831i7rn", "nope"]));
  it("cuid2", () => expectParity(z.cuid2(), ["tz4a98xxat96iws9zmbrgj3a", "NOPE"]));
  it("ulid", () => expectParity(z.ulid(), ["01ARZ3NDEKTSV4RRFFQ69G5FAV", "nope"]));
  it("xid", () => expectParity(z.xid(), ["9m4e2mr0ui3e8a215n4g", "nope"]));
  it("ksuid", () => expectParity(z.ksuid(), ["2naeRjTrrHJAkfd3tOuEjw90WVA", "no"]));
  it("ipv4", () => expectParity(z.ipv4(), ["192.168.1.1", "999.1.1.1"]));
  it("ipv6", () => expectParity(z.ipv6(), ["2001:db8::1", "nope"]));
  it("cidrv4", () => expectParity(z.cidrv4(), ["192.168.1.0/24", "192.168.1.1"]));
  it("cidrv6", () => expectParity(z.cidrv6(), ["2001:db8::/32", "nope"]));
  it("mac", () => expectParity(z.mac(), ["00:1A:2B:3C:4D:5E", "nope"]));
  it("base64", () => expectParity(z.base64(), ["aGVsbG8=", "@@@"]));
  it("base64url", () => expectParity(z.base64url(), ["aGVsbG8", "@@@"]));
  it("e164", () => expectParity(z.e164(), ["+12125551234", "12125551234"]));
  it("jwt (falls back: algorithmic)", () => expectParity(z.jwt(), [GOOD_JWT, "not-a-jwt"]));
  it("hex", () => expectParity(z.hex(), ["deadBEEF", "xyz"]));
  it("hash sha256", () => expectParity(z.hash("sha256"), ["a".repeat(64), "short"]));
  it("iso.date", () => expectParity(z.iso.date(), ["2024-01-15", "2024-13-01", "nope"]));
  it("iso.time", () => expectParity(z.iso.time(), ["12:30:00", "25:00:00"]));
  it("iso.datetime", () =>
    expectParity(z.iso.datetime(), ["2024-01-15T12:30:00Z", "2024-01-15", "nope"]));
  it("iso.datetime with offset", () =>
    expectParity(z.iso.datetime({ offset: true }), [
      "2024-01-15T12:30:00+02:00",
      "2024-01-15T12:30:00Z",
    ]));
  it("iso.duration", () => expectParity(z.iso.duration(), ["P1Y2M3D", "nope"]));
  it("custom stringFormat", () =>
    expectParity(
      z.stringFormat("hashtag", (s) => s.startsWith("#")),
      ["#yes", "no"],
    ));
  it("custom stringFormat with pattern", () =>
    expectParity(z.stringFormat("digits", /^\d+$/), ["123", "abc"]));
});

describe("feature matrix — numbers", () => {
  it("gt/gte/lt/lte", () => expectParity(z.number().gt(0).lte(10), [0, 0.1, 10, 10.1, -1]));
  it("positive/negative", () => {
    expectParity(z.number().positive(), [1, 0, -1]);
    expectParity(z.number().negative(), [-1, 0, 1]);
    expectParity(z.number().nonnegative(), [0, 1, -1]);
    expectParity(z.number().nonpositive(), [0, -1, 1]);
  });
  it("multipleOf int", () => expectParity(z.number().multipleOf(5), [10, 11]));
  it("int32", () => expectParity(z.int32(), [1, 2147483648, 1.5]));
  it("uint32", () => expectParity(z.uint32(), [1, -1, 4294967296]));
  it("float32", () => expectParity(z.float32(), [1.5, 3.5e38]));
  it("float64", () => expectParity(z.float64(), [1.5, Infinity]));
  it("number int check", () => expectParity(z.number().int(), [1, 1.5]));
});

describe("feature matrix — bigints", () => {
  it("range checks", () => expectParity(z.bigint().gt(0n).lte(10n), [0n, 1n, 10n, 11n]));
  it("positive", () => expectParity(z.bigint().positive(), [1n, 0n, -1n]));
  it("multipleOf", () => expectParity(z.bigint().multipleOf(3n), [9n, 10n]));
  it("int64", () => expectParity(z.int64(), [1n, 2n ** 63n, -(2n ** 63n) - 1n]));
  it("uint64", () => expectParity(z.uint64(), [1n, -1n, 2n ** 64n]));
});

describe("feature matrix — dates", () => {
  it("min/max", () =>
    expectParity(z.date().min(new Date("2020-01-01")).max(new Date("2030-01-01")), [
      new Date("2025-06-15"),
      new Date("2019-12-31"),
      new Date("2031-01-01"),
    ]));
});

describe("feature matrix — objects", () => {
  it("basic + nested", () =>
    expectParity(z.object({ a: z.string(), n: z.object({ b: z.number() }) }), [
      { a: "x", n: { b: 1 } },
      { a: "x", n: { b: "1" } },
      { a: 1, n: { b: 1 } },
      null,
      [],
    ]));
  it("optional / nullable / nullish props", () =>
    expectParity(
      z.object({
        o: z.string().optional(),
        n: z.string().nullable(),
        ni: z.string().nullish(),
      }),
      [{ n: null }, { o: "x", n: "y", ni: null }, { o: 1, n: null }, { n: undefined }],
    ));
  it("exactOptional prop (falls back)", () =>
    expectParity(z.object({ a: z.exactOptional(z.string()) }), [{}, { a: "x" }, { a: undefined }]));
  it("strictObject", () =>
    expectParity(z.strictObject({ a: z.string() }), [
      { a: "x" },
      { a: "x", b: 1 },
      { a: 1, b: 1, c: 2 },
      {},
    ]));
  it(".strict()", () =>
    expectParity(z.object({ a: z.string() }).strict(), [{ a: "x" }, { a: "x", b: 1 }]));
  it("looseObject", () =>
    expectParity(z.looseObject({ a: z.string() }), [{ a: "x", b: 1 }, { a: 1 }]));
  it("catchall", () =>
    expectParity(z.object({ a: z.string() }).catchall(z.number()), [
      { a: "x", b: 1 },
      { a: "x", b: "y" },
    ]));
  it("pick/omit/partial/required/extend", () => {
    const base = z.object({ a: z.string(), b: z.number() });
    expectParity(base.pick({ a: true }), [{ a: "x" }, { a: 1 }]);
    expectParity(base.omit({ b: true }), [{ a: "x" }, { a: 1 }]);
    expectParity(base.partial(), [{}, { a: "x" }, { a: 1 }]);
    expectParity(base.partial().required(), [{ a: "x", b: 1 }, {}]);
    expectParity(base.extend({ c: z.boolean() }), [
      { a: "x", b: 1, c: true },
      { a: "x", b: 1 },
    ]);
  });
});

describe("feature matrix — collections", () => {
  it("array + checks", () =>
    expectParity(z.array(z.number()).min(1).max(3), [[1], [1, 2, 3], [], [1, 2, 3, 4], ["x"]]));
  it("array length / nonempty", () => {
    expectParity(z.array(z.string()).length(2), [["a", "b"], ["a"]]);
    expectParity(z.array(z.string()).nonempty(), [["a"], []]);
  });
  it("tuple variants", () => {
    expectParity(z.tuple([]), [[], ["x"]]);
    expectParity(z.tuple([z.string(), z.number()]), [["a", 1], ["a"], ["a", 1, 2], []]);
    expectParity(z.tuple([z.string()]).rest(z.number()), [["a"], ["a", 1, 2], ["a", "b"]]);
    expectParity(z.tuple([z.string(), z.number().optional()]), [["a"], ["a", 1], ["a", "b"]]);
  });
  it("record string keys", () =>
    expectParity(z.record(z.string(), z.number()), [{ a: 1 }, {}, { a: "x" }, null]));
  it("record with key pattern", () =>
    expectParity(z.record(z.string().regex(/^k/), z.number()), [{ k1: 1 }, { x: 1 }]));
  it("record enum keys (exhaustive — falls back)", () =>
    expectParity(z.record(z.enum(["a", "b"]), z.number()), [
      { a: 1, b: 2 },
      { a: 1 },
      { a: 1, b: 2, c: 3 },
    ]));
  it("partialRecord", () =>
    expectParity(z.partialRecord(z.enum(["a", "b"]), z.number()), [{ a: 1 }, {}, { a: "x" }]));
  it("set + size checks", () =>
    expectParity(z.set(z.string()).min(1).max(2), [
      new Set(["a"]),
      new Set(),
      new Set(["a", "b", "c"]),
      ["a"],
    ]));
  it("set size", () =>
    expectParity(z.set(z.string()).size(2), [new Set(["a", "b"]), new Set(["a"])]));
  it("map", () =>
    expectParity(z.map(z.string(), z.number()), [
      new Map([["a", 1]]),
      new Map([["a", "x"]]),
      new Map([[1, 1]]),
      {},
    ]));
  it("file", () => {
    expectParity(z.file(), [new File(["x"], "a.txt"), "not a file"]);
    expectParity(z.file().min(1).max(10).mime("text/plain"), [
      new File(["hello"], "a.txt", { type: "text/plain" }),
      new File(["hello"], "a.png", { type: "image/png" }),
      new File([], "empty.txt", { type: "text/plain" }),
    ]);
  });
  it("file custom messages (regression: extractor dropped them)", () =>
    expectParity(
      z
        .file()
        .min(100, "file too small")
        .max(1000, "file too big")
        .mime(["text/plain"], "bad type"),
      [
        new File(["x"], "a.txt", { type: "text/plain" }), // too small
        new File(["x".repeat(2000)], "a.txt", { type: "text/plain" }), // too big
        new File(["x".repeat(500)], "a.png", { type: "image/png" }), // in range, bad mime
        new File(["x".repeat(500)], "a.txt", { type: "text/plain" }), // valid
      ],
    ));
});

describe("feature matrix — wrappers", () => {
  it("optional", () => expectParity(z.string().optional(), ["x", undefined, null]));
  it("exactOptional (falls back)", () =>
    expectParity(z.exactOptional(z.string()), ["x", undefined]));
  it("nullable", () => expectParity(z.string().nullable(), ["x", null, undefined]));
  it("nullish", () => expectParity(z.string().nullish(), ["x", null, undefined, 1]));
  it("nonoptional (falls back)", () =>
    expectParity(z.string().optional().nonoptional(), ["x", undefined]));
  it("default value", () => expectParity(z.string().default("d"), [undefined, "x", 1]));
  it("default function", () =>
    expectParity(
      z.string().default(() => "fn"),
      [undefined, "x"],
    ));
  it("prefault (falls back)", () => expectParity(z.string().prefault("d"), [undefined, "x"]));
  it("catch value", () => expectParity(z.number().catch(42), ["nope", 1, undefined]));
  it("catch function", () =>
    expectParity(
      z.number().catch(() => 7),
      ["nope", 1],
    ));
  it("readonly (falls back, freezes)", () =>
    expectParity(z.object({ a: z.string() }).readonly(), [{ a: "x" }, { a: 1 }]));
  it("brand", () => expectParity(z.string().brand("B"), ["x", 1]));
  it("success (falls back)", () => expectParity(z.success(z.string()), ["x", 1]));
});

describe("feature matrix — composition", () => {
  it("union", () => expectParity(z.union([z.string(), z.number()]), ["x", 1, true, null]));
  it("union with checks", () =>
    expectParity(z.union([z.string().min(2), z.number().positive()]), ["a", "ab", 1, -1]));
  it("xor (falls back)", () => {
    expectParity(z.xor([z.string(), z.string().min(2)]), ["a", "ab", 1]);
  });
  it("discriminatedUnion", () =>
    expectParity(
      z.discriminatedUnion("t", [
        z.object({ t: z.literal("a"), x: z.string() }),
        z.object({ t: z.literal("b"), y: z.number() }),
      ]),
      [{ t: "a", x: "s" }, { t: "b", y: 1 }, { t: "c" }, { t: "a", x: 1 }],
    ));
  it("intersection", () =>
    expectParity(z.intersection(z.object({ a: z.string() }), z.object({ b: z.number() })), [
      { a: "x", b: 1 },
      { a: "x" },
      { b: 1 },
    ]));
  it("pipe", () => expectParity(z.string().pipe(z.string().min(2)), ["ab", "a", 1]));
  it("transform zero-capture", () =>
    expectParity(
      z.string().transform((v) => v.length),
      ["abc", 1],
    ));
  it("transform with capture (falls back)", () => {
    const suffix = "!";
    expectParity(
      z.string().transform((v) => v + suffix),
      ["abc", 1],
    );
  });
  it("standalone transform (falls back)", () =>
    expectParity(
      z.transform((v) => String(v)),
      [1, "x"],
    ));
  it("preprocess", () =>
    expectParity(
      z.preprocess((v) => String(v), z.string().min(2)),
      [123, 1],
    ));
  it("refine", () =>
    expectParity(
      z.number().refine((v) => v % 2 === 0, "even"),
      [2, 3],
    ));
  it("superRefine (falls back)", () =>
    expectParity(
      z.string().superRefine((v, ctx) => {
        if (v.length < 2) ctx.addIssue({ code: "custom", message: "too short" });
      }),
      ["a", "ab"],
    ));
  it("check() with built-in checks", () =>
    expectParity(z.number().check(z.gt(0), z.lt(10)), [5, 0, 10]));
  it("custom (falls back)", () =>
    expectParity(
      z.custom<string>((v) => typeof v === "string"),
      ["x", 1],
    ));
  it("instanceof (falls back)", () => expectParity(z.instanceof(Date), [new Date(), "x"]));
  it("lazy self-recursive", () => {
    interface Tree {
      value: string;
      children: Tree[];
    }
    const Tree: z.ZodType<Tree> = z.lazy(() =>
      z.object({ value: z.string(), children: z.array(Tree) }),
    );
    expectParity(Tree, [
      { value: "a", children: [] },
      { value: "a", children: [{ value: "b", children: [] }] },
      { value: "a", children: [{ value: 1, children: [] }] },
    ]);
  });
  it("json", () => expectParity(z.json(), ["x", 1, true, null, { a: [1, "b", null] }, undefined]));
  it("templateLiteral", () =>
    expectParity(z.templateLiteral(["id-", z.number()]), ["id-5", "id-x", "5"]));
  it("codec (falls back)", () => {
    const codec = z.codec(z.string(), z.number(), {
      decode: (s: string) => Number(s),
      encode: (n: number) => String(n),
    });
    expectParity(codec, ["5", 5]);
  });
  it("stringbool", () =>
    expectParity(z.stringbool(), ["true", "false", "yes", "no", "1", "0", "maybe", 1]));
});

describe("feature matrix — remaining surface", () => {
  it("looseRecord", () =>
    expectParity(z.looseRecord(z.string(), z.number()), [{ a: 1 }, { a: "x" }, {}]));
  it("property check (falls back)", () =>
    expectParity(z.object({ a: z.string() }).check(z.property("a", z.string().min(2))), [
      { a: "ab" },
      { a: "x" },
    ]));
  it("describe/meta are metadata-only", () => {
    expectParity(z.string().describe("a description"), ["x", 1]);
    expectParity(z.string().meta({ id: "m1", title: "t" }), ["x", 1]);
  });
  it("literal bigint", () => expectParity(z.literal(5n), [5n, 6n, 5]));
});

describe("feature matrix — coercion", () => {
  it("coerce.string", () => expectParity(z.coerce.string(), [1, true, "x", null]));
  it("coerce.number", () => expectParity(z.coerce.number(), ["5", "x", true, "", null]));
  it("coerce.boolean", () => expectParity(z.coerce.boolean(), ["", "false", 0, 1]));
  it("coerce.bigint", () => expectParity(z.coerce.bigint(), ["5", 5, "x", 1.5]));
  it("coerce.date", () => expectParity(z.coerce.date(), ["2024-01-01", "nope", 0]));
  it("coercion of hostile inputs throws/rejects identically", () => {
    expectParity(z.coerce.string(), [Symbol("s")]);
    expectParity(z.coerce.number(), [Symbol("s")]);
  });
});

describe("feature matrix — numeric edge semantics", () => {
  it("multipleOf uses zod's float-safe remainder", () => {
    expectParity(z.number().multipleOf(0.1), [0.3, 0.31, 0.7, 1]);
    expectParity(z.number().multipleOf(0.01), [49.99, 49.995]);
    expectParity(z.number().multipleOf(1e-2), [0.05, 0.055]);
  });
});

describe("feature matrix — multi-failure issue order", () => {
  it("string issues follow zod insertion order", () =>
    expectParity(z.string().regex(/^x/).min(5), ["abc"]));
  it("number issues follow zod insertion order", () =>
    expectParity(z.number().multipleOf(7).positive(), [-3]));
});

describe("feature matrix — discriminated union discriminator kinds", () => {
  it("numeric discriminator values dispatch correctly", () =>
    expectParity(
      z.discriminatedUnion("v", [
        z.object({ v: z.literal(1), a: z.string() }),
        z.object({ v: z.literal(2), b: z.number() }),
      ]),
      [{ v: 1, a: "s" }, { v: 2, b: 3 }, { v: "1", a: "s" }, { v: 3 }],
    ));
  it("boolean discriminator values dispatch correctly", () =>
    expectParity(
      z.discriminatedUnion("ok", [
        z.object({ ok: z.literal(true), data: z.string() }),
        z.object({ ok: z.literal(false), error: z.string() }),
      ]),
      [{ ok: true, data: "d" }, { ok: false, error: "e" }, { ok: "true" }],
    ));
  it("enum discriminators dispatch to their option", () =>
    expectParity(
      z.discriminatedUnion("t", [
        z.object({ t: z.enum(["a", "c"]), value: z.string() }),
        z.object({ t: z.literal("b"), count: z.number() }),
      ]),
      [
        { t: "a", value: "v" },
        { t: "c", value: "v" },
        { t: "b", count: 1 },
        { t: "c", value: 2 },
        { t: "d" },
      ],
    ));
});

describe("feature matrix — catch value semantics", () => {
  it("ctx-reading catch functions see the failure context", () =>
    expectParity(
      z.number().catch((ctx) => ctx.issues.length),
      ["nope", 1],
    ));
  it("impure catch factories run per parse (not baked at build time)", () => {
    let calls = 0;
    const schema = z.number().catch(() => {
      calls++;
      return calls;
    });
    const compiled = compileLikeProduction(schema, "impureCatch");
    const first = compiled("x");
    const second = compiled("y");
    expect(first.success && second.success).toBe(true);
    expect(first.success && second.success && first.data !== second.data).toBe(true);
  });
});

describe("feature matrix — intersection merge semantics", () => {
  it("mutating sides delegate to zod (merge conflicts throw identically)", () => {
    expectParity(z.intersection(z.string().trim(), z.string().toUpperCase()), [" x ", "X"]);
    expectParity(z.intersection(z.object({ a: z.string().trim() }), z.looseObject({})), [
      { a: " x " },
    ]);
  });
});

describe("feature matrix — recursion placement", () => {
  it("recursive schema nested inside a wrapper validates the right shape", () => {
    interface Tree {
      value: string;
      children: Tree[];
    }
    const Tree: z.ZodType<Tree> = z.lazy(() =>
      z.object({ value: z.string(), children: z.array(Tree) }),
    );
    expectParity(z.object({ root: Tree, label: z.number() }), [
      { root: { value: "a", children: [] }, label: 1 },
      { root: { value: "a", children: [{ value: "b", children: [] }] }, label: 1 },
      { root: { value: "a", children: [{ value: 1, children: [] }] }, label: 1 },
      { root: { label: 1 }, label: 1 },
    ]);
  });
  it("mutually recursive schemas validate correctly", () => {
    interface A {
      b?: B | undefined;
    }
    interface B {
      a?: A | undefined;
    }
    const A: z.ZodType<A> = z.lazy(() => z.object({ b: B.optional() }));
    const B: z.ZodType<B> = z.lazy(() => z.object({ a: A.optional() }));
    expectParity(A, [{}, { b: {} }, { b: { a: { b: {} } } }, { b: { a: 1 } }]);
  });
});

describe("feature matrix — record key kinds", () => {
  it("number keys delegate to zod (numeric-string key coercion)", () =>
    expectParity(z.record(z.number(), z.string()), [{ 1: "a" }, { x: "a" }, {}]));
  it("union-of-strings keys compile", () =>
    expectParity(z.record(z.union([z.string().min(2), z.string().max(1)]), z.number()), [
      { ab: 1 },
      { a: 1 },
    ]));
});

describe("feature matrix — union message fidelity", () => {
  it("surfaced single-option issues keep custom messages", () =>
    expectParity(z.union([z.string().min(2, "too short!"), z.number()]), ["a"]));
});

// Custom-message parity across every check-bearing type. Before this sweep only
// `string` and `union` asserted custom-message parity, yet number/bigint/date/
// set/array/record all bake messages too — and `file` silently dropped them
// (the bug fixed alongside this suite). Each input below fails exactly one
// check so the baked message is the first surfaced issue.
describe("feature matrix — custom message parity", () => {
  it("number checks", () => {
    expectParity(z.number().gt(0, "must be positive"), [-1, 0, 1]);
    expectParity(z.number().gte(5, "min 5"), [4, 5]);
    expectParity(z.number().lt(10, "too big"), [10, 9]);
    expectParity(z.number().lte(10, "max 10"), [11, 10]);
    expectParity(z.number().multipleOf(5, "must be /5"), [7, 10]);
    expectParity(z.int("must be int"), [1.5, 2]);
  });
  it("bigint checks", () => {
    expectParity(z.bigint().gte(0n, "no negatives"), [-1n, 0n]);
    expectParity(z.bigint().lte(10n, "too big"), [11n, 10n]);
    expectParity(z.bigint().multipleOf(3n, "by three"), [7n, 9n]);
  });
  it("date checks", () => {
    expectParity(z.date().min(new Date("2020-01-01"), "too early"), [
      new Date("2019-01-01"),
      new Date("2020-06-01"),
    ]);
    expectParity(z.date().max(new Date("2020-01-01"), "too late"), [
      new Date("2021-01-01"),
      new Date("2019-06-01"),
    ]);
  });
  it("set checks", () => {
    expectParity(z.set(z.string()).min(2, "need two"), [new Set(["a"]), new Set(["a", "b"])]);
    expectParity(z.set(z.string()).max(1, "too many"), [new Set(["a", "b"]), new Set(["a"])]);
  });
  it("array checks", () => {
    expectParity(z.array(z.number()).min(2, "need 2"), [[1], [1, 2]]);
    expectParity(z.array(z.number()).max(3, "max 3"), [[1, 2, 3, 4], [1]]);
    expectParity(z.array(z.number()).length(2, "exactly 2"), [[1], [1, 2]]);
  });
  it("record key check", () =>
    expectParity(z.record(z.string().min(3, "key too short"), z.number()), [
      { ab: 1 },
      { abc: 1 },
    ]));
});

describe("feature matrix — parse-mode edge cases", () => {
  it("async refinement throws identically in sync parse", () =>
    expectParity(
      z.string().refine(async (v) => v.length > 1),
      ["ab"],
    ));
  it("function schema", () => {
    expectParity(z.function({ input: [z.string()], output: z.string() }), [
      (s: string) => s,
      "not a function",
    ]);
  });
  it("promise schema", () => {
    expectParity(z.promise(z.string()), [Promise.resolve("x"), "x"]);
  });
});
