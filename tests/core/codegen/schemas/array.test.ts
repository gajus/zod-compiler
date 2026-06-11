import { describe, expect, it } from "vitest";
import type { ArrayIR } from "#src/core/types.js";
import { compileFastCheck, compileIR } from "../helpers.js";

describe("slow-path — array", () => {
  it("accepts valid array", () => {
    const ir: ArrayIR = { type: "array", element: { type: "string", checks: [] }, checks: [] };
    const safeParse = compileIR(ir);
    expect(safeParse(["a", "b", "c"])).toEqual({ success: true, data: ["a", "b", "c"] });
  });

  it("accepts empty array", () => {
    const ir: ArrayIR = { type: "array", element: { type: "string", checks: [] }, checks: [] };
    const safeParse = compileIR(ir);
    expect(safeParse([])).toEqual({ success: true, data: [] });
  });

  it("rejects non-array", () => {
    const ir: ArrayIR = { type: "array", element: { type: "string", checks: [] }, checks: [] };
    const safeParse = compileIR(ir);
    expect(safeParse("not array").success).toBe(false);
    expect(safeParse(42).success).toBe(false);
    expect(safeParse({}).success).toBe(false);
    expect(safeParse(null).success).toBe(false);
  });

  it("rejects array with invalid element type", () => {
    const ir: ArrayIR = { type: "array", element: { type: "string", checks: [] }, checks: [] };
    const safeParse = compileIR(ir);
    const result = safeParse(["valid", 42, "also valid"]);
    expect(result.success).toBe(false);
  });

  it("provides correct path for element errors", () => {
    const ir: ArrayIR = { type: "array", element: { type: "number", checks: [] }, checks: [] };
    const safeParse = compileIR(ir);
    const result = safeParse([1, "two", 3]);
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]).toMatchObject({
      path: [1],
    });
  });

  it("validates min_length check", () => {
    const ir: ArrayIR = {
      type: "array",
      element: { type: "string", checks: [] },
      checks: [{ kind: "min_length", minimum: 2 }],
    };
    const safeParse = compileIR(ir);
    expect(safeParse(["a", "b"]).success).toBe(true);
    expect(safeParse(["a"]).success).toBe(false);
    expect(safeParse([]).success).toBe(false);
  });

  it("validates max_length check", () => {
    const ir: ArrayIR = {
      type: "array",
      element: { type: "string", checks: [] },
      checks: [{ kind: "max_length", maximum: 3 }],
    };
    const safeParse = compileIR(ir);
    expect(safeParse(["a", "b", "c"]).success).toBe(true);
    expect(safeParse(["a", "b", "c", "d"]).success).toBe(false);
  });

  it("validates length_equals check", () => {
    const ir: ArrayIR = {
      type: "array",
      element: { type: "number", checks: [] },
      checks: [{ kind: "length_equals", length: 3 }],
    };
    const safeParse = compileIR(ir);
    expect(safeParse([1, 2, 3]).success).toBe(true);
    expect(safeParse([1, 2]).success).toBe(false);
    expect(safeParse([1, 2, 3, 4]).success).toBe(false);
  });

  it("validates array of objects", () => {
    const ir: ArrayIR = {
      type: "array",
      element: {
        type: "object",
        properties: {
          id: { type: "number", checks: [] },
          name: { type: "string", checks: [] },
        },
      },
      checks: [],
    };
    const safeParse = compileIR(ir);
    expect(safeParse([{ id: 1, name: "Alice" }]).success).toBe(true);
    expect(safeParse([{ id: "one", name: "Alice" }]).success).toBe(false);
  });
});

describe("fast-path — Array", () => {
  it("simple array: string[] accepts ['a'], rejects [42]", () => {
    const fn = compileFastCheck({
      type: "array",
      element: { type: "string", checks: [] },
      checks: [],
    });
    expect(fn?.(["a"])).toBe(true);
    expect(fn?.([42])).toBe(false);
  });

  it("min_length check", () => {
    const fn = compileFastCheck({
      type: "array",
      element: { type: "any" },
      checks: [{ kind: "min_length", minimum: 2 }],
    });
    expect(fn?.([1, 2])).toBe(true);
    expect(fn?.([1])).toBe(false);
  });

  it("max_length check", () => {
    const fn = compileFastCheck({
      type: "array",
      element: { type: "any" },
      checks: [{ kind: "max_length", maximum: 2 }],
    });
    expect(fn?.([1, 2])).toBe(true);
    expect(fn?.([1, 2, 3])).toBe(false);
  });

  it("any element (no .every needed)", () => {
    const fn = compileFastCheck({
      type: "array",
      element: { type: "any" },
      checks: [],
    });
    expect(fn?.([1, "a", null])).toBe(true);
  });

  it("length_equals check", () => {
    const fn = compileFastCheck({
      type: "array",
      element: { type: "any" },
      checks: [{ kind: "length_equals", length: 3 }],
    });
    expect(fn?.([1, 2, 3])).toBe(true);
    expect(fn?.([1, 2])).toBe(false);
    expect(fn?.([1, 2, 3, 4])).toBe(false);
  });

  it("ineligible element → returns null", () => {
    expect(
      compileFastCheck({
        type: "array",
        element: { type: "fallback", reason: "transform" },
        checks: [],
      }),
    ).toBeNull();
  });
});
