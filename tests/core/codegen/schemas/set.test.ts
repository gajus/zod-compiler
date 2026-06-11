import { describe, expect, it } from "vitest";
import type { SetIR } from "#src/core/types.js";
import { compileFastCheck, compileIR } from "../helpers.js";

describe("slow-path — set", () => {
  it("generates code that accepts a Set of strings", () => {
    const ir: SetIR = { type: "set", valueType: { type: "string", checks: [] } };
    const safeParse = compileIR(ir);
    expect(safeParse(new Set(["a", "b"]))).toEqual({ success: true, data: new Set(["a", "b"]) });
  });

  it("generates code that accepts an empty Set", () => {
    const ir: SetIR = { type: "set", valueType: { type: "number", checks: [] } };
    const safeParse = compileIR(ir);
    expect(safeParse(new Set())).toEqual({ success: true, data: new Set() });
  });

  it("generates code that rejects non-Set values", () => {
    const ir: SetIR = { type: "set", valueType: { type: "string", checks: [] } };
    const safeParse = compileIR(ir);
    expect(safeParse(["a", "b"]).success).toBe(false);
    expect(safeParse({ a: 1 }).success).toBe(false);
    expect(safeParse("set").success).toBe(false);
    expect(safeParse(null).success).toBe(false);
    expect(safeParse(undefined).success).toBe(false);
    expect(safeParse(42).success).toBe(false);
  });

  it("generates code that validates Set elements", () => {
    const ir: SetIR = { type: "set", valueType: { type: "number", checks: [] } };
    const safeParse = compileIR(ir);
    expect(safeParse(new Set([1, 2, 3])).success).toBe(true);
    expect(safeParse(new Set([1, "a", 3])).success).toBe(false);
  });

  it("generates min_size check", () => {
    const ir: SetIR = {
      type: "set",
      valueType: { type: "string", checks: [] },
      checks: [{ kind: "min_size", minimum: 2 }],
    };
    const safeParse = compileIR(ir);
    expect(safeParse(new Set(["a", "b"])).success).toBe(true);
    expect(safeParse(new Set(["a", "b", "c"])).success).toBe(true);
    expect(safeParse(new Set(["a"])).success).toBe(false);
    expect(safeParse(new Set()).success).toBe(false);
  });

  it("generates max_size check", () => {
    const ir: SetIR = {
      type: "set",
      valueType: { type: "string", checks: [] },
      checks: [{ kind: "max_size", maximum: 2 }],
    };
    const safeParse = compileIR(ir);
    expect(safeParse(new Set()).success).toBe(true);
    expect(safeParse(new Set(["a"])).success).toBe(true);
    expect(safeParse(new Set(["a", "b"])).success).toBe(true);
    expect(safeParse(new Set(["a", "b", "c"])).success).toBe(false);
  });

  it("generates min_size + max_size checks", () => {
    const ir: SetIR = {
      type: "set",
      valueType: { type: "string", checks: [] },
      checks: [
        { kind: "min_size", minimum: 1 },
        { kind: "max_size", maximum: 3 },
      ],
    };
    const safeParse = compileIR(ir);
    expect(safeParse(new Set()).success).toBe(false);
    expect(safeParse(new Set(["a"])).success).toBe(true);
    expect(safeParse(new Set(["a", "b", "c"])).success).toBe(true);
    expect(safeParse(new Set(["a", "b", "c", "d"])).success).toBe(false);
  });

  it("validates nested objects in Set", () => {
    const ir: SetIR = {
      type: "set",
      valueType: {
        type: "object",
        properties: { id: { type: "number", checks: [] } },
      },
    };
    const safeParse = compileIR(ir);
    const obj1 = { id: 1 };
    const obj2 = { id: 2 };
    expect(safeParse(new Set([obj1, obj2])).success).toBe(true);
    expect(safeParse(new Set([{ id: "not number" }])).success).toBe(false);
  });
});

describe("fast-path — set", () => {
  it("accepts a Set of strings", () => {
    const ir: SetIR = { type: "set", valueType: { type: "string", checks: [] } };
    const fn = compileFastCheck(ir);
    expect(fn?.(new Set(["a", "b"]))).toBe(true);
    expect(fn?.(new Set())).toBe(true);
  });

  it("rejects non-Set values", () => {
    const ir: SetIR = { type: "set", valueType: { type: "string", checks: [] } };
    const fn = compileFastCheck(ir);
    expect(fn?.(["a", "b"])).toBe(false);
    expect(fn?.(null)).toBe(false);
    expect(fn?.(42)).toBe(false);
  });

  it("validates Set elements", () => {
    const ir: SetIR = { type: "set", valueType: { type: "number", checks: [] } };
    const fn = compileFastCheck(ir);
    expect(fn?.(new Set([1, 2, 3]))).toBe(true);
    expect(fn?.(new Set([1, "a", 3]))).toBe(false);
  });

  it("validates min_size", () => {
    const ir: SetIR = {
      type: "set",
      valueType: { type: "string", checks: [] },
      checks: [{ kind: "min_size", minimum: 2 }],
    };
    const fn = compileFastCheck(ir);
    expect(fn?.(new Set(["a", "b"]))).toBe(true);
    expect(fn?.(new Set(["a"]))).toBe(false);
  });

  it("validates max_size", () => {
    const ir: SetIR = {
      type: "set",
      valueType: { type: "string", checks: [] },
      checks: [{ kind: "max_size", maximum: 2 }],
    };
    const fn = compileFastCheck(ir);
    expect(fn?.(new Set(["a", "b"]))).toBe(true);
    expect(fn?.(new Set(["a", "b", "c"]))).toBe(false);
  });

  it("validates nested objects in Set", () => {
    const ir: SetIR = {
      type: "set",
      valueType: {
        type: "object",
        properties: { id: { type: "number", checks: [] } },
      },
    };
    const fn = compileFastCheck(ir);
    expect(fn?.(new Set([{ id: 1 }, { id: 2 }]))).toBe(true);
    expect(fn?.(new Set([{ id: "bad" }]))).toBe(false);
  });

  it("returns null for ineligible element type", () => {
    const ir: SetIR = {
      type: "set",
      valueType: { type: "fallback", reason: "transform" },
    };
    expect(compileFastCheck(ir)).toBeNull();
  });

  it("skips helper for any-typed elements", () => {
    const ir: SetIR = { type: "set", valueType: { type: "any" } };
    const fn = compileFastCheck(ir);
    expect(fn?.(new Set([1, "a", null]))).toBe(true);
  });
});
