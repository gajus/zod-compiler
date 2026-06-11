import { describe, expect, it } from "vitest";
import type { LiteralIR } from "#src/core/types.js";
import { compileFastCheck, compileIR } from "../helpers.js";

describe("slow-path — literal", () => {
  it("accepts matching string literal", () => {
    const ir: LiteralIR = { type: "literal", values: ["hello"] };
    const safeParse = compileIR(ir);
    expect(safeParse("hello")).toEqual({ success: true, data: "hello" });
  });

  it("rejects non-matching string literal", () => {
    const ir: LiteralIR = { type: "literal", values: ["hello"] };
    const safeParse = compileIR(ir);
    expect(safeParse("world").success).toBe(false);
  });

  it("accepts matching number literal", () => {
    const ir: LiteralIR = { type: "literal", values: [42] };
    const safeParse = compileIR(ir);
    expect(safeParse(42)).toEqual({ success: true, data: 42 });
    expect(safeParse(43).success).toBe(false);
  });

  it("accepts matching boolean literal", () => {
    const ir: LiteralIR = { type: "literal", values: [true] };
    const safeParse = compileIR(ir);
    expect(safeParse(true)).toEqual({ success: true, data: true });
    expect(safeParse(false).success).toBe(false);
  });

  it("accepts matching null literal", () => {
    const ir: LiteralIR = { type: "literal", values: [null] };
    const safeParse = compileIR(ir);
    expect(safeParse(null)).toEqual({ success: true, data: null });
    expect(safeParse(undefined).success).toBe(false);
  });

  it("uses strict equality (no type coercion)", () => {
    const ir: LiteralIR = { type: "literal", values: [0] };
    const safeParse = compileIR(ir);
    expect(safeParse(0).success).toBe(true);
    expect(safeParse("0").success).toBe(false);
    expect(safeParse(false).success).toBe(false);
    expect(safeParse(null).success).toBe(false);
  });

  describe("multi-value literals", () => {
    it("accepts any of multiple string values", () => {
      const ir: LiteralIR = { type: "literal", values: ["foo", "bar"] };
      const safeParse = compileIR(ir);
      expect(safeParse("foo")).toEqual({ success: true, data: "foo" });
      expect(safeParse("bar")).toEqual({ success: true, data: "bar" });
      expect(safeParse("baz").success).toBe(false);
    });

    it("accepts any of multiple number values", () => {
      const ir: LiteralIR = { type: "literal", values: [1, 2, 3] };
      const safeParse = compileIR(ir);
      expect(safeParse(1).success).toBe(true);
      expect(safeParse(2).success).toBe(true);
      expect(safeParse(3).success).toBe(true);
      expect(safeParse(4).success).toBe(false);
    });

    it("accepts mixed types (string, number, null)", () => {
      const ir: LiteralIR = { type: "literal", values: ["hello", 42, null] };
      const safeParse = compileIR(ir);
      expect(safeParse("hello").success).toBe(true);
      expect(safeParse(42).success).toBe(true);
      expect(safeParse(null).success).toBe(true);
      expect(safeParse("world").success).toBe(false);
      expect(safeParse(0).success).toBe(false);
      expect(safeParse(undefined).success).toBe(false);
    });

    it("returns invalid_literal error with all expected values", () => {
      const ir: LiteralIR = { type: "literal", values: ["a", "b"] };
      const safeParse = compileIR(ir);
      const result = safeParse("c");
      expect(result.success).toBe(false);
      expect(result.error?.issues[0]).toMatchObject({
        code: "invalid_value",
        values: ["a", "b"],
      });
    });
  });
});

describe("fast-path — Literal", () => {
  it("single value: accepts 'foo', rejects 'bar'", () => {
    const fn = compileFastCheck({ type: "literal", values: ["foo"] });
    expect(fn?.("foo")).toBe(true);
    expect(fn?.("bar")).toBe(false);
  });

  it("multiple values: accepts 'a' or 'b', rejects 'c'", () => {
    const fn = compileFastCheck({ type: "literal", values: ["a", "b"] });
    expect(fn?.("a")).toBe(true);
    expect(fn?.("b")).toBe(true);
    expect(fn?.("c")).toBe(false);
  });

  it("numeric literal: accepts 42, rejects 43", () => {
    const fn = compileFastCheck({ type: "literal", values: [42] });
    expect(fn?.(42)).toBe(true);
    expect(fn?.(43)).toBe(false);
  });

  it("boolean literal: accepts true, rejects false", () => {
    const fn = compileFastCheck({ type: "literal", values: [true] });
    expect(fn?.(true)).toBe(true);
    expect(fn?.(false)).toBe(false);
  });

  it("null literal: accepts null, rejects undefined", () => {
    const fn = compileFastCheck({ type: "literal", values: [null] });
    expect(fn?.(null)).toBe(true);
    expect(fn?.(undefined)).toBe(false);
  });
});
