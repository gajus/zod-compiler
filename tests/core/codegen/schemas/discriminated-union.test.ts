import { describe, expect, it } from "vitest";
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
