import { describe, expect, it } from "vite-plus/test";
import { generateValidator } from "#src/core/codegen/index.js";
import type { DiscriminatedUnionIR } from "#src/core/types.js";
import { compileFastCheck, compileIR } from "../helpers.js";

describe("slow-path — discriminatedUnion", () => {
  const ir: DiscriminatedUnionIR = {
    type: "discriminatedUnion",
    discriminator: "type",
    options: [
      {
        type: "object",
        properties: {
          type: { type: "literal", values: ["a"] },
          value: { type: "string", checks: [] },
        },
      },
      {
        type: "object",
        properties: {
          type: { type: "literal", values: ["b"] },
          count: { type: "number", checks: [] },
        },
      },
    ],
    cases: [
      { value: "a", option: 0 },
      { value: "b", option: 1 },
    ],
  };

  it("accepts first discriminator option", () => {
    const safeParse = compileIR(ir);
    expect(safeParse({ type: "a", value: "hello" }).success).toBe(true);
  });

  it("accepts second discriminator option", () => {
    const safeParse = compileIR(ir);
    expect(safeParse({ type: "b", count: 42 }).success).toBe(true);
  });

  it("rejects invalid discriminator value", () => {
    const safeParse = compileIR(ir);
    expect(safeParse({ type: "c" }).success).toBe(false);
  });

  it("rejects non-object", () => {
    const safeParse = compileIR(ir);
    expect(safeParse("not object").success).toBe(false);
    expect(safeParse(null).success).toBe(false);
  });

  it("validates properties of matched option", () => {
    const safeParse = compileIR(ir);
    expect(safeParse({ type: "a", value: 42 }).success).toBe(false);
    expect(safeParse({ type: "b", count: "not number" }).success).toBe(false);
  });

  it("generates switch-based code (not sequential union)", () => {
    const result = generateValidator(ir, "duTest");
    expect(result.code + result.functionDef).toContain("switch");
    expect(result.code + result.functionDef).not.toContain("__u_");
  });
});

describe("fast-path — DiscriminatedUnion", () => {
  it("both branches work", () => {
    const fn = compileFastCheck({
      type: "discriminatedUnion",
      discriminator: "kind",
      options: [
        {
          type: "object",
          properties: {
            kind: { type: "literal", values: ["a"] },
            x: { type: "string", checks: [] },
          },
        },
        {
          type: "object",
          properties: {
            kind: { type: "literal", values: ["b"] },
            y: { type: "number", checks: [] },
          },
        },
      ],
      cases: [
        { value: "a", option: 0 },
        { value: "b", option: 1 },
      ],
    });
    expect(fn?.({ kind: "a", x: "hello" })).toBe(true);
    expect(fn?.({ kind: "b", y: 42 })).toBe(true);
    expect(fn?.({ kind: "a", x: 123 })).toBe(false);
  });

  it("any ineligible branch → returns null", () => {
    expect(
      compileFastCheck({
        type: "discriminatedUnion",
        discriminator: "type",
        options: [
          {
            type: "object",
            properties: {
              type: { type: "literal", values: ["ok"] },
              data: { type: "string", checks: [] },
            },
          },
          { type: "fallback", reason: "transform" },
        ],
        cases: [
          { value: "ok", option: 0 },
          { value: "bad", option: 1 },
        ],
      }),
    ).toBeNull();
  });
});

/**
 * Dispatch is a switch over the literal labels themselves, at every size. An
 * earlier revision routed 3+ string labels through a `{value: ordinal}` table
 * and switched on the ordinal; measured on V8 13.x (node 24) the table's keyed
 * lookup goes megamorphic as soon as the input rotates through the variants
 * and loses to the string switch at every case count up to 80 (see
 * emitFastDiscriminatedSwitch). These pin the plain switch and the verdicts
 * the table variant used to need special guards for.
 */
describe("fast-path — string-label switch dispatch", () => {
  const variantIR = (values: string[]): DiscriminatedUnionIR => ({
    cases: values.map((value, i) => ({ option: i, value })),
    discriminator: "type",
    options: values.map(() => ({
      properties: { payload: { checks: [], type: "string" } },
      type: "object",
    })),
    type: "discriminatedUnion",
  });
  const codeOf = (ir: DiscriminatedUnionIR): string => {
    const r = generateValidator(ir, "du");
    return `${r.code}\n${r.functionDef}`;
  };

  it("switches on the labels directly, with no lookup table, at any size", () => {
    for (const values of [
      ["a", "b"],
      ["a", "b", "c"],
      Array.from({ length: 12 }, (_, i) => `v${i}`),
    ]) {
      const code = codeOf(variantIR(values));
      expect(code).toContain("switch(__dx_");
      for (const value of values) expect(code).toContain(`case ${JSON.stringify(value)}:return `);
      expect(code).not.toContain(`{"${values[0]}":1,`);
      expect(code).not.toContain("typeof __dv_");
    }
  });

  it("accepts every variant and rejects unknown discriminators", () => {
    const fn = compileFastCheck(variantIR(["alpha", "beta", "gamma", "delta"]));
    for (const type of ["alpha", "beta", "gamma", "delta"]) {
      expect(fn?.({ payload: "p", type })).toBe(true);
    }
    expect(fn?.({ payload: "p", type: "epsilon" })).toBe(false);
    expect(fn?.({ payload: "p" })).toBe(false);
    expect(fn?.({ payload: 1, type: "alpha" })).toBe(false);
  });

  it("rejects a non-string discriminator that would COERCE to a valid key", () => {
    // The matched case drops its own discriminator check, so the dispatch
    // itself must be strict: `{toString(){return "alpha"}}`, which strict
    // equality never matched, must not select a case and pass.
    const fn = compileFastCheck(variantIR(["alpha", "beta", "gamma"]));
    const coercing = {
      payload: "p",
      type: {
        toString() {
          return "alpha";
        },
      },
    };
    expect(fn?.(coercing)).toBe(false);
    expect(fn?.({ payload: "p", type: 1 })).toBe(false);
    expect(fn?.({ payload: "p", type: null })).toBe(false);
  });

  it("does not treat Object.prototype members as variants", () => {
    const fn = compileFastCheck(variantIR(["alpha", "beta", "gamma"]));
    for (const type of ["toString", "constructor", "hasOwnProperty", "__proto__"]) {
      expect(fn?.({ payload: "p", type }), type).toBe(false);
    }
  });

  it("dispatches a __proto__ discriminator value like any other label", () => {
    const code = codeOf(variantIR(["alpha", "__proto__", "gamma"]));
    expect(code).toContain('case "__proto__":');
    const fn = compileFastCheck(variantIR(["alpha", "__proto__", "gamma"]));
    expect(fn?.({ payload: "p", type: "__proto__" })).toBe(true);
    expect(fn?.({ payload: "p", type: "alpha" })).toBe(true);
    expect(fn?.({ payload: "p", type: "nope" })).toBe(false);
  });

  it("emits one case per value, sharing the option's check between them", () => {
    const ir: DiscriminatedUnionIR = {
      cases: [
        { option: 0, value: "a" },
        { option: 0, value: "b" },
        { option: 1, value: "c" },
      ],
      discriminator: "type",
      options: [
        { properties: { payload: { checks: [], type: "string" } }, type: "object" },
        { properties: { n: { checks: [], type: "number" } }, type: "object" },
      ],
      type: "discriminatedUnion",
    };
    const code = codeOf(ir);
    expect(code).toContain('case "a":return ');
    expect(code).toContain('case "b":return ');
    expect(code).toContain('case "c":return ');
    const fn = compileFastCheck(ir);
    expect(fn?.({ payload: "p", type: "a" })).toBe(true);
    expect(fn?.({ payload: "p", type: "b" })).toBe(true);
    expect(fn?.({ n: 1, type: "c" })).toBe(true);
    expect(fn?.({ n: 1, type: "a" })).toBe(false);
  });
});
