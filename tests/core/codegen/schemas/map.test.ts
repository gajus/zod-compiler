import { describe, expect, it } from "vitest";
import type { MapIR } from "#src/core/types.js";
import { compileFastCheck, compileIR } from "../helpers.js";

describe("slow-path — map", () => {
  it("generates code that accepts a Map<string, number>", () => {
    const ir: MapIR = {
      type: "map",
      keyType: { type: "string", checks: [] },
      valueType: { type: "number", checks: [] },
    };
    const safeParse = compileIR(ir);
    const m = new Map([
      ["a", 1],
      ["b", 2],
    ]);
    expect(safeParse(m)).toEqual({ success: true, data: m });
  });

  it("generates code that accepts an empty Map", () => {
    const ir: MapIR = {
      type: "map",
      keyType: { type: "string", checks: [] },
      valueType: { type: "number", checks: [] },
    };
    const safeParse = compileIR(ir);
    expect(safeParse(new Map())).toEqual({ success: true, data: new Map() });
  });

  it("generates code that rejects non-Map values", () => {
    const ir: MapIR = {
      type: "map",
      keyType: { type: "string", checks: [] },
      valueType: { type: "number", checks: [] },
    };
    const safeParse = compileIR(ir);
    expect(safeParse({ a: 1 }).success).toBe(false);
    expect(safeParse([["a", 1]]).success).toBe(false);
    expect(safeParse("map").success).toBe(false);
    expect(safeParse(null).success).toBe(false);
    expect(safeParse(undefined).success).toBe(false);
    expect(safeParse(42).success).toBe(false);
  });

  it("validates Map key types", () => {
    const ir: MapIR = {
      type: "map",
      keyType: { type: "string", checks: [] },
      valueType: { type: "number", checks: [] },
    };
    const safeParse = compileIR(ir);
    const badKeys = new Map<unknown, number>([[42, 1]]);
    expect(safeParse(badKeys).success).toBe(false);
  });

  it("validates Map value types", () => {
    const ir: MapIR = {
      type: "map",
      keyType: { type: "string", checks: [] },
      valueType: { type: "number", checks: [] },
    };
    const safeParse = compileIR(ir);
    const badValues = new Map<string, unknown>([["a", "not number"]]);
    expect(safeParse(badValues).success).toBe(false);
  });

  it("validates both key and value simultaneously", () => {
    const ir: MapIR = {
      type: "map",
      keyType: { type: "string", checks: [{ kind: "min_length", minimum: 1 }] },
      valueType: { type: "number", checks: [{ kind: "greater_than", value: 0, inclusive: false }] },
    };
    const safeParse = compileIR(ir);
    expect(safeParse(new Map([["a", 1]])).success).toBe(true);
    expect(safeParse(new Map([["", 1]])).success).toBe(false);
    expect(safeParse(new Map([["a", 0]])).success).toBe(false);
    expect(safeParse(new Map([["", 0]])).success).toBe(false);
  });

  it("validates nested objects as Map values", () => {
    const ir: MapIR = {
      type: "map",
      keyType: { type: "string", checks: [] },
      valueType: {
        type: "object",
        properties: { id: { type: "number", checks: [] } },
      },
    };
    const safeParse = compileIR(ir);
    expect(safeParse(new Map([["x", { id: 1 }]])).success).toBe(true);
    expect(safeParse(new Map([["x", { id: "bad" }]])).success).toBe(false);
  });
});

describe("fast-path — map", () => {
  it("accepts a Map<string, number>", () => {
    const ir: MapIR = {
      type: "map",
      keyType: { type: "string", checks: [] },
      valueType: { type: "number", checks: [] },
    };
    const fn = compileFastCheck(ir);
    expect(fn?.(new Map([["a", 1]]))).toBe(true);
    expect(fn?.(new Map())).toBe(true);
  });

  it("rejects non-Map values", () => {
    const ir: MapIR = {
      type: "map",
      keyType: { type: "string", checks: [] },
      valueType: { type: "number", checks: [] },
    };
    const fn = compileFastCheck(ir);
    expect(fn?.({ a: 1 })).toBe(false);
    expect(fn?.(null)).toBe(false);
    expect(fn?.(42)).toBe(false);
  });

  it("validates Map key types", () => {
    const ir: MapIR = {
      type: "map",
      keyType: { type: "string", checks: [] },
      valueType: { type: "number", checks: [] },
    };
    const fn = compileFastCheck(ir);
    expect(fn?.(new Map([[42, 1]]))).toBe(false);
  });

  it("validates Map value types", () => {
    const ir: MapIR = {
      type: "map",
      keyType: { type: "string", checks: [] },
      valueType: { type: "number", checks: [] },
    };
    const fn = compileFastCheck(ir);
    expect(fn?.(new Map([["a", "b"]]))).toBe(false);
  });

  it("validates both key and value with checks", () => {
    const ir: MapIR = {
      type: "map",
      keyType: { type: "string", checks: [{ kind: "min_length", minimum: 1 }] },
      valueType: { type: "number", checks: [{ kind: "greater_than", value: 0, inclusive: false }] },
    };
    const fn = compileFastCheck(ir);
    expect(fn?.(new Map([["a", 1]]))).toBe(true);
    expect(fn?.(new Map([["", 1]]))).toBe(false);
    expect(fn?.(new Map([["a", 0]]))).toBe(false);
  });

  it("validates nested objects as Map values", () => {
    const ir: MapIR = {
      type: "map",
      keyType: { type: "string", checks: [] },
      valueType: {
        type: "object",
        properties: { id: { type: "number", checks: [] } },
      },
    };
    const fn = compileFastCheck(ir);
    expect(fn?.(new Map([["x", { id: 1 }]]))).toBe(true);
    expect(fn?.(new Map([["x", { id: "bad" }]]))).toBe(false);
  });

  it("returns null for ineligible key type", () => {
    expect(
      compileFastCheck({
        type: "map",
        keyType: { type: "fallback", reason: "transform" },
        valueType: { type: "number", checks: [] },
      }),
    ).toBeNull();
  });

  it("returns null for ineligible value type", () => {
    expect(
      compileFastCheck({
        type: "map",
        keyType: { type: "string", checks: [] },
        valueType: { type: "fallback", reason: "transform" },
      }),
    ).toBeNull();
  });

  it("skips helper for any-typed key and value", () => {
    const ir: MapIR = {
      type: "map",
      keyType: { type: "any" },
      valueType: { type: "any" },
    };
    const fn = compileFastCheck(ir);
    expect(fn?.(new Map([[1, "a"]]))).toBe(true);
  });
});
