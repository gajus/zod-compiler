/**
 * The REBUILT loose / strict / catchall object — the slow-walk branch that runs
 * when a property (or the catchall) rewrites its value, so the output cannot be
 * the input by reference.
 *
 * zod parses every object into a fresh `{}`: the shape keys land first, in
 * shape order, read as `input[key]` (a prototype-inclusive read), and a loose or
 * catchall object then appends the unknown keys in the input's for-in order,
 * inherited ones promoted to own keys. Two things went wrong here before this
 * file existed:
 *
 *   - the branch cloned the input with spread and validated the CLONE's
 *     properties. Spread copies own keys only, so a value found on the
 *     prototype became `undefined`. The fast and build paths read `input[key]`
 *     like zod, so a strict object with an inherited key and a `.transform()`
 *     property REJECTED in the fast pass and then found nothing wrong in the
 *     slow walk: `safeParse` returned `success: false` with an EMPTY issue list;
 *   - the spread kept the input's key order and appended a substituted key
 *     last, where zod's fresh object has the shape keys first.
 *
 * The by-reference pass-through (nothing rewrites a value) is unchanged and
 * stays pinned as a documented divergence in known-divergences.test.ts.
 */
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import type { SafeParseSuccess } from "#src/core/types.js";
import { compileLikeProduction, expectParity } from "./parity-harness.js";

const dataOf = (r: { success: boolean }): Record<string, unknown> =>
  (r as SafeParseSuccess<Record<string, unknown>>).data;

/** Same input built fresh per call: a rebuild must not depend on sharing. */
const inherited = (proto: object, own: object = {}): object =>
  Object.assign(Object.create(proto) as object, own);

/** Property schemas that force a rebuild: each one rewrites its value. */
const rewriting = {
  transform: z.string().transform((s) => s.length),
  trim: z.string().trim(),
  default: z.string().default("d"),
  preprocess: z.preprocess((v) => (v === undefined ? "p" : v), z.string()),
  superRefine: z.string().superRefine((v, ctx) => {
    if (v === "bad") ctx.addIssue({ code: "custom", message: "bad" });
  }),
  optionalTransform: z
    .string()
    .optional()
    .transform((v) => v ?? "d"),
} as const;

const modes = {
  loose: (a: z.ZodType) => z.looseObject({ a }),
  strict: (a: z.ZodType) => z.strictObject({ a }),
  catchall: (a: z.ZodType) => z.object({ a }).catchall(z.number()),
} as const;

describe("rebuilt object — inherited keys are read like zod reads them", () => {
  for (const [propName, prop] of Object.entries(rewriting)) {
    for (const [modeName, mode] of Object.entries(modes)) {
      it(`${modeName} object with a ${propName} property`, () => {
        expectParity(
          mode(prop),
          [
            inherited({ a: "ab" }),
            inherited({ a: "bad" }),
            inherited({ a: 1 }),
            inherited({ a: " ab " }),
            inherited({ a: "ab" }, { extra: 1 }),
            inherited({ a: "ab", extra: 1 }),
            inherited({ extra: 1 }, { a: "ab" }),
            inherited({ a: undefined }),
            inherited({}),
            { a: "ab" },
            { a: 1 },
            {},
          ],
          `inh_${modeName}_${propName}`,
        );
      });
    }
  }

  it("a rejection carries zod's issues, never an empty list", () => {
    // The exact shape that used to come back as `success: false` with no
    // issues: the fast pass rejected the inherited `1`, the slow walk read
    // `undefined` off its clone and accepted it.
    const schema = z.strictObject({
      a: z
        .string()
        .optional()
        .transform((v) => v ?? "d"),
    });
    const compiled = compileLikeProduction(schema, "inhEmptyIssues");
    const zodResult = schema.safeParse(inherited({ a: 1 }));
    const ours = compiled(inherited({ a: 1 }));
    expect(zodResult.success).toBe(false);
    expect(ours.success).toBe(false);
    if (ours.success || zodResult.success) return;
    expect(ours.error.issues.length).toBeGreaterThan(0);
    expect(ours.error.issues.map((i) => `${i.code}@${i.path.join(".")}`)).toStrictEqual(
      zodResult.error.issues.map((i) => `${i.code}@${i.path.join(".")}`),
    );
  });

  it("an inherited unknown key is promoted to an own key, as zod promotes it", () => {
    for (const schema of [
      z.looseObject({ a: z.string().trim() }),
      z.object({ a: z.string().trim() }).catchall(z.number()),
    ]) {
      const compiled = compileLikeProduction(schema, "inhPromote");
      const input = () => inherited({ inh: 5 }, { a: " x " });
      const zodData = dataOf(schema.safeParse(input()));
      const ourData = dataOf(compiled(input()));
      expect(Object.hasOwn(zodData, "inh")).toBe(true);
      expect(Object.hasOwn(ourData, "inh")).toBe(true);
      expect(Object.keys(ourData)).toStrictEqual(Object.keys(zodData));
      expect(ourData).toStrictEqual(zodData);
    }
  });
});

describe("rebuilt object — key order is zod's: shape keys first, then unknown keys", () => {
  const cases: [string, z.ZodType, () => Record<string, unknown>][] = [
    [
      "loose, substituted default",
      z.looseObject({ a: z.string().default("d") }),
      () => ({ extra: 1 }),
    ],
    [
      "loose, reordered input",
      z.looseObject({ a: z.string().trim() }),
      () => ({ k: "x", a: " ab " }),
    ],
    [
      "loose, several shape keys reordered",
      z.looseObject({ b: z.string().trim(), a: z.string() }),
      () => ({ a: "1", z: 0, b: " 2 " }),
    ],
    [
      "loose, absent optional key stays absent",
      z.looseObject({ a: z.string().trim(), b: z.string().optional() }),
      () => ({ k: 1, a: " x " }),
    ],
    [
      "loose, present-but-undefined optional key survives in place",
      z.looseObject({ a: z.string().trim(), b: z.string().optional() }),
      () => ({ k: 1, b: undefined, a: " x " }),
    ],
    [
      "catchall, reordered input",
      z.object({ a: z.string().trim() }).catchall(z.number()),
      () => ({ k: 1, a: " ab " }),
    ],
    [
      "catchall, substituted default",
      z.object({ a: z.string().default("d") }).catchall(z.number()),
      () => ({ extra: 1 }),
    ],
    [
      "catchall that rewrites its own values",
      z.object({ a: z.string() }).catchall(z.coerce.number()),
      () => ({ k: "1", a: "x", j: "2" }),
    ],
    [
      "strict, substituted default",
      z.strictObject({ a: z.string().default("d"), b: z.number() }),
      () => ({ b: 1 }),
    ],
  ];

  for (const [label, schema, input] of cases) {
    it(label, () => {
      const compiled = compileLikeProduction(schema, "keyOrder");
      const zodData = dataOf(schema.safeParse(input()));
      const ourData = dataOf(compiled(input()));
      expect(Object.keys(ourData)).toStrictEqual(Object.keys(zodData));
      expect(ourData).toStrictEqual(zodData);
      // Byte-for-byte: the order is visible to anything that serializes.
      expect(JSON.stringify(ourData)).toBe(JSON.stringify(zodData));
    });
  }

  it("the pass-through case is untouched: a loose object nothing rewrites is still its input", () => {
    const schema = z.looseObject({ a: z.string() });
    const compiled = compileLikeProduction(schema, "keyOrderPassthrough");
    const input = { k: "x", a: "ab" };
    expect(dataOf(compiled(input))).toBe(input);
  });
});

describe("pass-through object — a nested replacement never edits the caller's object", () => {
  // A pass-through property rewrites nothing, but a nested object or record
  // still hands back a proto-scrubbed COPY when its input carries an own
  // `__proto__`. That copy has to land on the OUTPUT: writing it into the input
  // swapped the caller's nested value in place and threw on a frozen input.
  const withProto = () => JSON.parse('{"a":"x","__proto__":{"polluted":true}}') as object;

  it("nested loose object: the output is a copy, the input keeps its own value", () => {
    const schema = z.looseObject({ n: z.looseObject({ a: z.string() }) });
    const compiled = compileLikeProduction(schema, "nestedScrubCopy");
    const input = { n: withProto() };
    const ours = dataOf(compiled(input));
    const zodData = dataOf(schema.safeParse({ n: withProto() }));
    expect(ours).not.toBe(input);
    expect(input.n).toBe(input.n); // the caller's object is not rewired
    expect(Object.hasOwn(input.n, "__proto__")).toBe(true); // ...nor edited
    expect(Object.hasOwn(ours["n"] as object, "__proto__")).toBe(false);
    expect(Object.hasOwn(zodData["n"] as object, "__proto__")).toBe(false);
    expect(ours).toStrictEqual(zodData);
    expect(Object.getPrototypeOf(Object.assign({}, ours["n"] as object))).toBe(Object.prototype);
  });

  it("nested record: same protocol", () => {
    const schema = z.looseObject({ r: z.record(z.string(), z.string()) });
    const compiled = compileLikeProduction(schema, "nestedRecordScrubCopy");
    const input = { r: withProto() };
    const ours = dataOf(compiled(input));
    expect(ours).not.toBe(input);
    expect(Object.hasOwn(input.r, "__proto__")).toBe(true);
    expect(Object.hasOwn(ours["r"] as object, "__proto__")).toBe(false);
    expect(ours).toStrictEqual(dataOf(schema.safeParse({ r: withProto() })));
  });

  it("a frozen input parses instead of throwing out of safeParse", () => {
    const schema = z.looseObject({ n: z.looseObject({ a: z.string() }) });
    const compiled = compileLikeProduction(schema, "nestedScrubFrozen");
    const input = Object.freeze({ n: Object.freeze(withProto()) });
    const ours = compiled(input);
    const zodResult = schema.safeParse(input);
    expect(ours.success).toBe(true);
    expect(zodResult.success).toBe(true);
    expect(dataOf(ours)).toStrictEqual(dataOf(zodResult));
  });

  it("a catchall's nested replacement lands the same way", () => {
    const schema = z.object({ a: z.string() }).catchall(z.record(z.string(), z.string()));
    const compiled = compileLikeProduction(schema, "catchallScrubCopy");
    const input = { a: "x", r: withProto() };
    const ours = dataOf(compiled(input));
    expect(ours).not.toBe(input);
    expect(Object.hasOwn(input.r, "__proto__")).toBe(true);
    expect(Object.hasOwn(ours["r"] as object, "__proto__")).toBe(false);
    expect(ours).toStrictEqual(dataOf(schema.safeParse({ a: "x", r: withProto() })));
  });

  it("with nothing to replace, the input still comes back by reference", () => {
    const schema = z.looseObject({ n: z.looseObject({ a: z.string() }) });
    const compiled = compileLikeProduction(schema, "nestedNoScrub");
    const input = { n: { a: "x" } };
    expect(dataOf(compiled(input))).toBe(input);
  });
});

describe("rebuilt object — `__proto__` handling is unchanged", () => {
  const polluting = () => JSON.parse('{"a":" x ","__proto__":{"polluted":true},"k":1}') as object;

  it("a rebuilt loose object never copies an own `__proto__`", () => {
    const schema = z.looseObject({ a: z.string().trim() });
    const compiled = compileLikeProduction(schema, "rebuildProtoLoose");
    const ours = dataOf(compiled(polluting()));
    const zodData = dataOf(schema.safeParse(polluting()));
    expect(Object.hasOwn(ours, "__proto__")).toBe(false);
    expect(Object.hasOwn(zodData, "__proto__")).toBe(false);
    expect(Object.keys(ours)).toStrictEqual(Object.keys(zodData));
    const assigned = Object.assign({}, ours) as { polluted?: boolean };
    expect(assigned.polluted).toBeUndefined();
  });

  it("a rebuilt catchall skips it without validating it, as zod does", () => {
    expectParity(
      z.object({ a: z.string().trim() }).catchall(z.number()),
      [polluting()],
      "rebuildProtoCatchall",
    );
  });

  it("a rebuilt strict object still reports it as an unrecognized key", () => {
    expectParity(z.strictObject({ a: z.string().trim() }), [polluting()], "rebuildProtoStrict");
  });
});
