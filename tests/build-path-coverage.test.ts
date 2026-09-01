/**
 * Which everyday schemas reach the single-pass build generator.
 *
 * The build path validates and assembles the output in ONE uninstrumented pass
 * and defers issue production behind `.error`; a schema it declines falls back
 * to the eager slow walk, which collects issues on every parse whether or not
 * anything failed. Because the generator is all-or-nothing per schema, ONE
 * unmodelled node anywhere in the tree costs the whole schema that pass — so the
 * set of constructs it covers is what decides whether ordinary application
 * schemas get it at all.
 *
 * Each case below pins the path taken (a regression here is a silent slowdown,
 * not a failure) and, alongside it, asserts full zod parity through the harness —
 * the build pass reproduces value substitution and rewrite ORDERING, which is
 * where a fast, wrong answer would otherwise hide.
 */
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import { generateValidator } from "#src/core/codegen/index.js";
import type { RefEntry } from "#src/core/extract/index.js";
import { extractSchema } from "#src/core/extract/index.js";
import { expectParity } from "./parity-harness.js";

type Path = "build" | "eager" | "fast-deferred" | "zod-delegate";

/** Which of the four validator shapes `generateValidator` emitted for `schema`. */
function pathOf(schema: unknown): Path {
  const refEntries: RefEntry[] = [];
  const ir = extractSchema(schema, refEntries);
  const result = generateValidator(ir, "p", { refCount: refEntries.length });
  const source = result.functionDef;
  if (/=__vb_\d+\(input\)/.test(source)) return "build";
  if (source.startsWith("function safeParse_p(input){return __rf")) return "zod-delegate";
  if (source.includes("__zcFinD")) return "fast-deferred";
  return "eager";
}

const item = z.object({ id: z.string(), qty: z.number().int() });

describe("build path — everyday constructs stay on the single-pass generator", () => {
  it.each([
    ["array size check over rebuilding elements", z.object({ i: z.array(item).min(1) })],
    ["array max over rebuilding elements", z.object({ i: z.array(item).max(9) })],
    ["array exact length over rebuilding elements", z.object({ i: z.array(item).length(2) })],
    [
      "array refine over rebuilding elements",
      z.object({ i: z.array(item).refine((v) => v.length > 0) }),
    ],
    ["object-level refine", z.object({ a: z.number(), b: z.number() }).refine((v) => v.a < v.b)],
    [
      "nested object-level refine",
      z.object({ n: z.object({ a: z.number() }).refine((v) => v.a > 0) }),
    ],
    ["field default", z.object({ page: z.number().int().default(1), q: z.string() })],
    ["object-valued default", z.object({ o: z.object({ a: z.string() }).default({ a: "x" }) })],
    ["default under optional", z.object({ a: z.string().default("d").optional() })],
    ["overwrite effect (.trim())", z.object({ q: z.string().trim() })],
    ["overwrite then check", z.object({ q: z.string().trim().min(1) })],
    ["check then overwrite", z.object({ q: z.string().min(1).trim() })],
    ["overwrite inside an array", z.object({ t: z.array(z.string().trim()) })],
    ["coerced string", z.object({ q: z.coerce.string().min(1) })],
    ["coerced number", z.object({ n: z.coerce.number().int().positive() })],
    ["coerced boolean", z.object({ b: z.coerce.boolean() })],
    ["coerced bigint", z.object({ n: z.coerce.bigint().positive() })],
    ["coerced date", z.object({ d: z.coerce.date().min(new Date(0)) })],
    ["custom predicate", z.object({ id: z.custom<string>((v) => typeof v === "string") })],
    ["class instance", z.object({ createdAt: z.instanceof(Date) })],
    ["stringbool", z.object({ enabled: z.stringbool() })],
    ["stringbool inside an array", z.object({ flags: z.array(z.stringbool()) })],
    ["preprocess", z.object({ page: z.preprocess((v) => Number(v), z.number().int()) })],
    ["preprocess inside an array", z.array(z.preprocess((v) => Number(v), z.number()))],
    ["sync transform", z.object({ a: z.string().transform((s) => s.length) })],
    [
      "transform over a rebuilding object",
      z.array(z.object({ a: z.string() }).transform((o) => o.a)),
    ],
    [
      "several at once",
      z.object({
        q: z.string().trim().min(1),
        page: z.number().default(1),
        i: z.array(item).min(1),
      }),
    ],
  ])("%s", (_label, schema) => {
    expect(pathOf(schema)).toBe("build");
  });

  it.each([
    // catchValue receives a ctx holding the inner schema's collected issues, and
    // this pass produces a sentinel rather than an issue list.
    ["catch", z.object({ n: z.number().catch(0) })],
    // z.url() trims, normalizes and needs try/catch.
    ["url", z.object({ u: z.url() })],
    // superRefine may rewrite through zod's payload.
    ["superRefine", z.object({ a: z.number() }).superRefine(() => {})],
  ])("declines %s and keeps the eager walk", (_label, schema) => {
    expect(pathOf(schema)).toBe("eager");
  });
});

describe("build path — the predicate it hands `.is()`", () => {
  /** What generateIIFE would install as `.is()` (mirrors its isArg resolution). */
  function isGuardOf(schema: unknown): "predicate" | "safeParse" {
    const refEntries: RefEntry[] = [];
    const ir = extractSchema(schema, refEntries);
    const result = generateValidator(ir, "p", { refCount: refEntries.length });
    const arg = result.isFnName ?? (result.fastTotal ? result.fastFnName : null);
    return arg === null || arg === undefined ? "safeParse" : "predicate";
  }

  it.each([
    ["array size check", z.array(item).min(1)],
    ["object-level refine", z.object({ a: z.number(), b: z.number() }).refine((v) => v.a < v.b)],
    ["nested array size check", z.object({ items: z.array(item).min(1) })],
  ])("installs a zero-allocation predicate for %s", (_label, schema) => {
    // These reach the build pass, and stripping reshapes the payload without
    // changing the verdict — so the fast expression is an exact acceptance test.
    // On the eager walk they had no predicate to hand over at all.
    expect(isGuardOf(schema)).toBe("predicate");
  });

  it.each([
    // Substitutes a value the fast check demands be present.
    ["a default", z.object({ page: z.number().default(1) })],
    // No fast path exists: an overwrite rewrites the value, and an effect is
    // statically fast-ineligible.
    ["an overwrite", z.object({ q: z.string().trim() })],
    ["a transform", z.object({ a: z.string().transform((s) => s.length) })],
  ])("falls back to safeParse().success for %s", (_label, schema) => {
    expect(isGuardOf(schema)).toBe("safeParse");
  });
});

describe("build path — zod parity for the newly covered constructs", () => {
  it("array size checks and refines", () => {
    const rows = [{ id: "a", qty: 1 }];
    expectParity(z.array(item).min(2), [[], rows, [...rows, { id: "b", qty: 2 }]], "amin");
    expectParity(z.array(item).max(1), [rows, [...rows, { id: "b", qty: 2 }]], "amax");
    expectParity(z.array(item).length(1), [[], rows, [...rows, ...rows]], "alen");
    // A bad element AND a failed size check: one issue list, zod's order.
    expectParity(z.array(item).min(2), [[{ id: 1, qty: "x" }]], "aboth");
    expectParity(
      z.array(item).refine((v) => v.length % 2 === 0, "even"),
      [rows, [...rows, ...rows]],
      "aref",
    );
    // The refine sees the STRIPPED payload, as zod's checks do.
    expectParity(
      z
        .array(z.object({ a: z.string() }))
        .refine((v) => v.every((o) => Object.keys(o).length === 1)),
      [[{ a: "x", extra: 1 }]],
      "arefstrip",
    );
  });

  it("object-level refines", () => {
    expectParity(
      z.object({ a: z.number(), b: z.number() }).refine((v) => v.a < v.b, "a<b"),
      [{ a: 1, b: 2 }, { a: 3, b: 2 }, { a: 3, b: 2, extra: 9 }, "nope"],
      "oref",
    );
    // Zod skips the check chain when a property produced issues; the build pass
    // gets that for free, having returned FAIL at the property.
    expectParity(
      z.object({ a: z.number() }).refine(() => {
        throw new Error("refine must not run");
      }),
      [{ a: "bad" }],
      "orefsuppress",
    );
    expectParity(
      z.object({ a: z.number() }).refine((v) => Object.keys(v).length === 1, "one key"),
      [{ a: 1, extra: 2 }],
      "orefstrip",
    );
  });

  it("defaults, including every wrapper ordering", () => {
    expectParity(z.object({ n: z.number().default(0) }), [{}, { n: 5 }, { n: "x" }], "dnum");
    expectParity(z.string().default("d").optional(), [undefined, "y"], "dopt");
    expectParity(z.string().optional().default("d"), [undefined, "y"], "doptd");
    expectParity(z.string().default("d").nullish(), [undefined, null, "y"], "dnullish");
    expectParity(z.string().default("d").nullable(), [undefined, null, "y"], "dnullable");
    expectParity(z.string().nullable().default("d"), [undefined, null, "y"], "dnulld");
    expectParity(
      z.object({ o: z.object({ a: z.string() }).default({ a: "q" }) }),
      [{}, { o: { a: "z" } }, { o: { a: 1 } }],
      "dobj",
    );
    // The substituted value is NOT validated — zod's $ZodDefault short-circuits.
    expectParity(
      z.union([z.string().min(5).default("x"), z.undefined()]),
      [undefined, "ab", "abcdef"],
      "dunion",
    );
  });

  it("overwrite effects apply at their declared position", () => {
    expectParity(z.object({ q: z.string().trim() }), [{ q: "  hi  " }, { q: 5 }], "otrim");
    // Ordering is observable: trim-then-min rejects "   " where min-then-trim accepts.
    expectParity(z.object({ q: z.string().trim().min(1) }), [{ q: "   " }, { q: " a " }], "opre");
    expectParity(z.object({ q: z.string().min(1).trim() }), [{ q: "   " }, { q: "" }], "opost");
    expectParity(
      z.object({ q: z.string().toLowerCase().includes("AB") }),
      [{ q: "xABy" }, { q: "xaby" }],
      "olower",
    );
    expectParity(
      z.object({ q: z.string().includes("AB").toLowerCase() }),
      [{ q: "xABy" }, { q: "xaby" }],
      "oincl",
    );
    expectParity(
      z.object({ q: z.string().trim().regex(/^a+$/) }),
      [{ q: " aa " }, { q: " ab " }],
      "ore",
    );
    expectParity(
      z.object({
        q: z
          .string()
          .trim()
          .refine((s) => s.length > 1, "long"),
      }),
      [{ q: " ab " }, { q: " a " }],
      "oref2",
    );
    expectParity(
      z.object({ t: z.array(z.string().trim().min(1)) }),
      [{ t: [" a "] }, { t: ["  "] }],
      "oarr",
    );
    expectParity(z.object({ q: z.string().trim().default(" d ") }), [{}, { q: " a " }], "odef");
  });

  it("sync transforms", () => {
    expectParity(
      z.object({ a: z.string().transform((s) => s.length) }),
      [{ a: "abc" }, { a: 5 }],
      "t1",
    );
    const factor = 3;
    // Capturing callback: called by reference through the schema, still built.
    expectParity(
      z.object({ a: z.number().transform((n) => n * factor) }),
      [{ a: 2 }, { a: "x" }],
      "t2",
    );
    expectParity(
      z.object({ a: z.string() }).transform((o) => ({ ...o, b: 1 })),
      [{ a: "x" }, { a: "x", extra: 2 }, { a: 1 }],
      "t3",
    );
    expectParity(
      z.array(z.object({ a: z.string() }).transform((o) => o.a)),
      [[{ a: "x" }], [{ a: 1 }]],
      "t4",
    );
    expectParity(
      z.object({
        a: z
          .number()
          .default(2)
          .transform((n) => n + 1),
      }),
      [{}, { a: 5 }, { a: "x" }],
      "t5",
    );
  });

  it("native coercions, checks, and throwing conversions", () => {
    expectParity(
      z.object({ q: z.coerce.string().min(2) }),
      [{ q: 12 }, { q: "x" }, { q: Symbol("s") }],
      "cstr",
    );
    expectParity(
      z.object({ q: z.coerce.string().trim().min(2) }),
      [{ q: 12 }, { q: " x " }, { q: "  " }],
      "cstrtrim",
    );
    expectParity(
      z.object({ n: z.coerce.number().int().positive() }),
      [{ n: "12" }, { n: "1.5" }, { n: "x" }, { n: Symbol("s") }],
      "cnum",
    );
    expectParity(
      z.object({ n: z.coerce.number().refine((n) => n % 2 === 0, "even") }),
      [{ n: "12" }, { n: "11" }, { n: "x" }],
      "cnumref",
    );
    expectParity(
      z.object({ b: z.coerce.boolean() }),
      [{ b: "" }, { b: "false" }, { b: 0 }, { b: 1 }],
      "cbool",
    );
    expectParity(
      z.object({ n: z.coerce.bigint().positive() }),
      [{ n: "12" }, { n: 3 }, { n: "x" }, { n: 1.5 }],
      "cbig",
    );
    expectParity(
      z.object({ d: z.coerce.date().min(new Date(0)) }),
      [{ d: "2024-01-01" }, { d: 0 }, { d: -1 }, { d: "nope" }, { d: Symbol("s") }],
      "cdate",
    );
  });

  it("stringbool conversion, casing, custom values, and invalid inputs", () => {
    expectParity(
      z.object({ enabled: z.stringbool(), strict: z.stringbool({ case: "sensitive" }) }),
      [
        { enabled: "YES", strict: "true" },
        { enabled: "off", strict: "false" },
        { enabled: "maybe", strict: "true" },
        { enabled: "yes", strict: "TRUE" },
        { enabled: true, strict: "false" },
      ],
      "stringbool",
    );
    expectParity(
      z.array(z.stringbool({ truthy: ["1", "yes"], falsy: ["0", "no"] })),
      [["1", "no", "YES"], ["true"], [1]],
      "stringboolCustom",
    );
    // The exact-spelling shortcut (no toLowerCase() on a verbatim hit) must not
    // change a verdict in either direction: a lowercase hit, an uppercase hit
    // the shortcut misses, a near-miss with surrounding whitespace, a value
    // that only lowercases INTO a spelling, and the empty string.
    expectParity(
      z.object({ f: z.stringbool() }),
      [
        { f: "enabled" },
        { f: "ENABLED" },
        { f: "Enabled" },
        { f: " yes" },
        { f: "yes " },
        { f: "" },
        { f: "TRUE" },
        { f: "False" },
        { f: "0" },
        { f: "yess" },
        { f: "MAYBE" },
        { f: "İ" },
        { f: "ﬀ" },
      ],
      "stringboolExact",
    );
    // The same codec on the EAGER walk (a sibling `.catch()` declines the
    // build pass), where slowStringBool takes the shortcut.
    expectParity(
      z.object({ f: z.stringbool(), c: z.string().catch("c") }),
      [
        { f: "on", c: "x" },
        { f: "ON", c: 1 },
        { f: "Off", c: "y" },
        { f: "nope", c: "z" },
      ],
      "stringboolEager",
    );
  });
});
