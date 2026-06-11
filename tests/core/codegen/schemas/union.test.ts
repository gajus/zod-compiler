import { describe, expect, it } from "vitest";
import type { UnionIR } from "#src/core/types.js";
import { compileFastCheck, compileIR } from "../helpers.js";

describe("slow-path — union", () => {
  it("accepts first option", () => {
    const ir: UnionIR = {
      type: "union",
      options: [
        { type: "string", checks: [] },
        { type: "number", checks: [] },
      ],
    };
    const safeParse = compileIR(ir);
    expect(safeParse("hello")).toEqual({ success: true, data: "hello" });
  });

  it("accepts second option", () => {
    const ir: UnionIR = {
      type: "union",
      options: [
        { type: "string", checks: [] },
        { type: "number", checks: [] },
      ],
    };
    const safeParse = compileIR(ir);
    expect(safeParse(42)).toEqual({ success: true, data: 42 });
  });

  it("rejects value matching no option", () => {
    const ir: UnionIR = {
      type: "union",
      options: [
        { type: "string", checks: [] },
        { type: "number", checks: [] },
      ],
    };
    const safeParse = compileIR(ir);
    expect(safeParse(true).success).toBe(false);
    expect(safeParse(null).success).toBe(false);
    expect(safeParse([]).success).toBe(false);
  });

  it("validates checks within union options", () => {
    const ir: UnionIR = {
      type: "union",
      options: [
        { type: "string", checks: [{ kind: "min_length", minimum: 3 }] },
        { type: "number", checks: [{ kind: "greater_than", value: 0, inclusive: false }] },
      ],
    };
    const safeParse = compileIR(ir);
    expect(safeParse("abc").success).toBe(true);
    expect(safeParse(1).success).toBe(true);
    expect(safeParse("ab").success).toBe(false);
    expect(safeParse(0).success).toBe(false);
  });

  it("handles union with three options", () => {
    const ir: UnionIR = {
      type: "union",
      options: [
        { type: "string", checks: [] },
        { type: "number", checks: [] },
        { type: "boolean" },
      ],
    };
    const safeParse = compileIR(ir);
    expect(safeParse("hello").success).toBe(true);
    expect(safeParse(42).success).toBe(true);
    expect(safeParse(true).success).toBe(true);
    expect(safeParse(null).success).toBe(false);
  });

  it("failed branch with default does not leak output mutation to next branch", () => {
    // z.union([z.string().default("x").min(5), z.undefined()])
    // Input: undefined
    // Branch 1: default writes output="x", then min(5) fails ("x".length < 5)
    // Branch 2: z.undefined() should succeed with data=undefined, not "x"
    const ir: UnionIR = {
      type: "union",
      options: [
        {
          type: "default",
          inner: { type: "string", checks: [{ kind: "min_length", minimum: 5 }] },
          refIndex: 0,
        },
        { type: "undefined" },
      ],
    };
    const safeParse = compileIR(ir, "test", [{ _zod: { def: { defaultValue: "x" } } }]);
    const result = safeParse(undefined);
    expect(result.success).toBe(true);
    expect(result.data).toBe(undefined);
  });

  // M1: unionErrors should contain per-branch error details
  it("union error includes per-branch errors in unionErrors", () => {
    const ir: UnionIR = {
      type: "union",
      options: [
        { type: "string", checks: [] },
        { type: "number", checks: [] },
      ],
    };
    const safeParse = compileIR(ir);
    const result = safeParse(true);
    expect(result.success).toBe(false);
    const issue = result.error?.issues[0] as Record<string, unknown>;
    expect(issue["code"]).toBe("invalid_union");
    // errors should contain one flat array per failed branch
    const errors = issue["errors"] as Record<string, unknown>[][];
    expect(errors).toHaveLength(2);
    expect(errors[0]?.length).toBeGreaterThanOrEqual(1);
    expect(errors[1]?.length).toBeGreaterThanOrEqual(1);
  });
});

describe("fast-path — Union", () => {
  it("string | number: accepts 'a', accepts 42, rejects true", () => {
    const fn = compileFastCheck({
      type: "union",
      options: [
        { type: "string", checks: [] },
        { type: "number", checks: [] },
      ],
    });
    expect(fn?.("a")).toBe(true);
    expect(fn?.(42)).toBe(true);
    expect(fn?.(true)).toBe(false);
  });

  it("any ineligible option → returns null", () => {
    expect(
      compileFastCheck({
        type: "union",
        options: [
          { type: "string", checks: [] },
          { type: "fallback", reason: "transform" },
        ],
      }),
    ).toBeNull();
  });
});
