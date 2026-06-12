import { describe, expect, it } from "vitest";
import { z } from "zod";
import { generateValidator } from "#src/core/codegen/index.js";
import { extractSchema } from "#src/core/extract/index.js";
import { compileIR } from "../helpers.js";

/**
 * Auto-discrimination: a plain `z.union` of objects that all pin a shared key to
 * pairwise-disjoint required literals is lowered to O(1) switch dispatch on the
 * fast path (fastUnion → detectUnionDiscriminator). This is a fast-path-only
 * rewrite — the slow path keeps `z.union`'s sequential trial and `invalid_union`
 * error shape — and is gated on a minimum option count so small unions, which a
 * fully-inlined `||`-chain validates faster, are never regressed.
 */

const compile = (schema: z.ZodType) => compileIR(extractSchema(schema));

const emitsSwitch = (schema: z.ZodType): boolean => {
  const r = generateValidator(extractSchema(schema), "t");
  return `${r.code}\n${r.functionDef}`.includes("switch(");
};

/** Every input must produce the same success/failure as zod itself. */
const assertAcceptParity = (schema: z.ZodType, inputs: unknown[]) => {
  const safeParse = compile(schema);
  for (const input of inputs) {
    expect(safeParse(input).success, `input=${JSON.stringify(input)}`).toBe(
      schema.safeParse(input).success,
    );
  }
};

const tagged = (t: string | number | boolean, shape: z.ZodRawShape) =>
  z.object({ type: z.literal(t), ...shape });

/** Five object options on disjoint string literals — the canonical eligible case. */
const fiveDisjoint = z.union([
  tagged("a", { x: z.number().int() }),
  tagged("b", { y: z.string().min(1) }),
  tagged("c", { z: z.boolean() }),
  tagged("d", { w: z.array(z.string()) }),
  tagged("e", { v: z.number() }),
]);

describe("union auto-discrimination — eligible (switch dispatch)", () => {
  it("emits a switch for ≥5 disjoint string literals", () => {
    expect(emitsSwitch(fiveDisjoint)).toBe(true);
  });

  it("accepts/rejects identically to zod across every branch and miss", () => {
    assertAcceptParity(fiveDisjoint, [
      { type: "a", x: 1 },
      { type: "a", x: 1.5 }, // not int
      { type: "a" }, // missing field
      { type: "b", y: "hi" },
      { type: "b", y: "" }, // too short
      { type: "c", z: true },
      { type: "c", z: "no" },
      { type: "d", w: ["s"] },
      { type: "d", w: [1] },
      { type: "e", v: 3 },
      { type: "f" }, // unknown discriminant
      {}, // no discriminant
      null,
      [1, 2],
      "string",
      99,
    ]);
  });

  it("handles numeric and boolean discriminants", () => {
    const numeric = z.union([
      tagged(200, { body: z.string() }),
      tagged(201, { id: z.number() }),
      tagged(400, { error: z.string() }),
      tagged(404, { path: z.string() }),
      tagged(500, { trace: z.string() }),
    ]);
    expect(emitsSwitch(numeric)).toBe(true);
    assertAcceptParity(numeric, [
      { type: 200, body: "ok" },
      { type: 200, body: 5 },
      { type: 404, path: "/x" },
      { type: 418 },
    ]);
  });

  it("handles multi-value literal options that stay disjoint", () => {
    const multi = z.union([
      z.object({ t: z.literal(["a", "a2"]), x: z.number() }),
      z.object({ t: z.literal("b"), y: z.string() }),
      z.object({ t: z.literal("c"), z: z.boolean() }),
      z.object({ t: z.literal("d"), w: z.number() }),
      z.object({ t: z.literal("e"), v: z.string() }),
    ]);
    expect(emitsSwitch(multi)).toBe(true);
    assertAcceptParity(multi, [
      { t: "a", x: 1 },
      { t: "a2", x: 2 },
      { t: "a2", x: "no" },
      { t: "b", y: "s" },
      { t: "z" },
    ]);
  });

  it("keeps each option's strict unknown-key check inside its case", () => {
    const strict = z.union([
      z.strictObject({ type: z.literal("a"), x: z.number() }),
      z.strictObject({ type: z.literal("b"), y: z.string() }),
      z.strictObject({ type: z.literal("c"), z: z.boolean() }),
      z.strictObject({ type: z.literal("d"), w: z.number() }),
      z.strictObject({ type: z.literal("e"), v: z.string() }),
    ]);
    expect(emitsSwitch(strict)).toBe(true);
    assertAcceptParity(strict, [
      { type: "a", x: 1 },
      { type: "a", x: 1, extra: 9 }, // unknown key → rejected
      { type: "c", z: false },
    ]);
  });

  it("handles loose-object options that accept unknown keys", () => {
    const loose = z.union([
      z.looseObject({ type: z.literal("a"), x: z.number() }),
      z.looseObject({ type: z.literal("b"), y: z.string() }),
      z.looseObject({ type: z.literal("c"), z: z.boolean() }),
      z.looseObject({ type: z.literal("d"), w: z.number() }),
      z.looseObject({ type: z.literal("e"), v: z.string() }),
    ]);
    expect(emitsSwitch(loose)).toBe(true);
    assertAcceptParity(loose, [
      { type: "a", x: 1 },
      { type: "a", x: 1, extra: 9 }, // unknown key → accepted (loose)
      { type: "a", x: "no" },
      { type: "c", z: true },
    ]);
  });
});

describe("union auto-discrimination — ineligible (falls back to ||-chain)", () => {
  it("a literal shared by two options is ambiguous → no switch, still correct", () => {
    // The crux: `{type:"a", y:5}` matches the SECOND "a" arm, which a naive
    // switch (dispatching only to the first) would wrongly reject.
    const ambiguous = z.union([
      tagged("a", { x: z.string() }),
      tagged("a", { y: z.number() }),
      tagged("c", { z: z.boolean() }),
      tagged("d", { w: z.number() }),
      tagged("e", { v: z.string() }),
    ]);
    expect(emitsSwitch(ambiguous)).toBe(false);
    assertAcceptParity(ambiguous, [
      { type: "a", x: "s" },
      { type: "a", y: 5 },
      { type: "a", x: "s", y: 5 },
      { type: "c", z: true },
    ]);
  });

  it("an option missing the key → no switch", () => {
    const missing = z.union([
      tagged("a", { x: z.number() }),
      tagged("b", { y: z.string() }),
      tagged("c", { z: z.boolean() }),
      tagged("d", { w: z.number() }),
      z.object({ other: z.string() }),
    ]);
    expect(emitsSwitch(missing)).toBe(false);
    assertAcceptParity(missing, [{ type: "a", x: 1 }, { other: "s" }, { type: "a", other: "s" }]);
  });

  it("a non-literal discriminator key → no switch", () => {
    const nonLiteral = z.union([
      z.object({ type: z.string(), x: z.number() }),
      tagged("b", { y: z.string() }),
      tagged("c", { z: z.boolean() }),
      tagged("d", { w: z.number() }),
      tagged("e", { v: z.string() }),
    ]);
    expect(emitsSwitch(nonLiteral)).toBe(false);
    assertAcceptParity(nonLiteral, [
      { type: "anything", x: 1 },
      { type: "b", y: "s" },
    ]);
  });

  it("an optional discriminator (not required) → no switch", () => {
    const optional = z.union([
      z.object({ type: z.literal("a").optional(), x: z.number() }),
      tagged("b", { y: z.string() }),
      tagged("c", { z: z.boolean() }),
      tagged("d", { w: z.number() }),
      tagged("e", { v: z.string() }),
    ]);
    expect(emitsSwitch(optional)).toBe(false);
    assertAcceptParity(optional, [{ type: "a", x: 1 }, { x: 1 }, { type: "b", y: "s" }]);
  });

  it("a non-object option → no switch", () => {
    const mixed = z.union([
      tagged("a", { x: z.number() }),
      tagged("b", { y: z.string() }),
      tagged("c", { z: z.boolean() }),
      tagged("d", { w: z.number() }),
      z.string(),
    ]);
    expect(emitsSwitch(mixed)).toBe(false);
    assertAcceptParity(mixed, [{ type: "a", x: 1 }, "hello", { type: "z" }]);
  });

  it("below the option-count threshold → no switch (small unions not regressed)", () => {
    // 3 and 4 options stay on the ||-chain; 5 (tested above) is the first to switch.
    const three = z.union([
      tagged("a", { x: z.number() }),
      tagged("b", { y: z.string() }),
      tagged("c", { z: z.boolean() }),
    ]);
    const four = z.union([
      tagged("a", { x: z.number() }),
      tagged("b", { y: z.string() }),
      tagged("c", { z: z.boolean() }),
      tagged("d", { w: z.number() }),
    ]);
    expect(emitsSwitch(three)).toBe(false);
    expect(emitsSwitch(four)).toBe(false);
    assertAcceptParity(three, [{ type: "a", x: 1 }, { type: "c", z: true }, { type: "d" }]);
    assertAcceptParity(four, [{ type: "a", x: 1 }, { type: "d", w: 2 }, { type: "e" }]);
  });
});

describe("union auto-discrimination — error parity (slow path untouched)", () => {
  it("a failing eligible union reports zod's invalid_union issue shape", () => {
    const safeParse = compile(fiveDisjoint);
    const shape = (issues: readonly unknown[]) =>
      issues.map((i) => {
        const issue = i as { code: string; path: readonly (string | number)[] };
        return { code: issue.code, path: issue.path };
      });

    for (const input of [{ type: "a", x: 1.5 }, { type: "z" }, { foo: 1 }, 42]) {
      const mine = safeParse(input);
      const zod = fiveDisjoint.safeParse(input);
      expect(mine.success).toBe(false);
      expect(zod.success).toBe(false);
      expect(shape(mine.error?.issues ?? [])).toEqual(shape(zod.error?.issues ?? []));
    }
  });
});
