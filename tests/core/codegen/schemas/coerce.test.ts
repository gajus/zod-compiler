import { describe, expect, it } from "vitest";
import type { BigIntIR, BooleanIR, DateIR, NumberIR, StringIR } from "#src/core/types.js";
import { compileIR } from "../helpers.js";

describe("slow-path — coerce string", () => {
  it("coerces number to string", () => {
    const ir: StringIR = { type: "string", checks: [], coerce: true };
    const safeParse = compileIR(ir);
    expect(safeParse(42)).toEqual({ success: true, data: "42" });
  });

  it("coerces boolean to string", () => {
    const ir: StringIR = { type: "string", checks: [], coerce: true };
    const safeParse = compileIR(ir);
    expect(safeParse(true)).toEqual({ success: true, data: "true" });
  });

  it("coerces null to string", () => {
    const ir: StringIR = { type: "string", checks: [], coerce: true };
    const safeParse = compileIR(ir);
    expect(safeParse(null)).toEqual({ success: true, data: "null" });
  });

  it("coerces undefined to string", () => {
    const ir: StringIR = { type: "string", checks: [], coerce: true };
    const safeParse = compileIR(ir);
    expect(safeParse(undefined)).toEqual({ success: true, data: "undefined" });
  });

  it("passes through string", () => {
    const ir: StringIR = { type: "string", checks: [], coerce: true };
    const safeParse = compileIR(ir);
    expect(safeParse("hello")).toEqual({ success: true, data: "hello" });
  });

  it("coerced string respects checks", () => {
    const ir: StringIR = {
      type: "string",
      checks: [{ kind: "min_length", minimum: 5 }],
      coerce: true,
    };
    const safeParse = compileIR(ir);
    expect(safeParse("hello").success).toBe(true);
    expect(safeParse(42).success).toBe(false); // "42" has length 2
  });

  it("non-coerce rejects number", () => {
    const ir: StringIR = { type: "string", checks: [] };
    const safeParse = compileIR(ir);
    expect(safeParse(42).success).toBe(false);
  });
});

describe("slow-path — coerce number", () => {
  it("coerces string to number", () => {
    const ir: NumberIR = { type: "number", checks: [], coerce: true };
    const safeParse = compileIR(ir);
    expect(safeParse("42")).toEqual({ success: true, data: 42 });
  });

  it("coerces float string to number", () => {
    const ir: NumberIR = { type: "number", checks: [], coerce: true };
    const safeParse = compileIR(ir);
    expect(safeParse("3.14")).toEqual({ success: true, data: 3.14 });
  });

  it("rejects NaN from invalid string coercion", () => {
    const ir: NumberIR = { type: "number", checks: [], coerce: true };
    const safeParse = compileIR(ir);
    expect(safeParse("abc").success).toBe(false);
  });

  it("coerces empty string to 0", () => {
    const ir: NumberIR = { type: "number", checks: [], coerce: true };
    const safeParse = compileIR(ir);
    expect(safeParse("")).toEqual({ success: true, data: 0 });
  });

  it("coerces true to 1", () => {
    const ir: NumberIR = { type: "number", checks: [], coerce: true };
    const safeParse = compileIR(ir);
    expect(safeParse(true)).toEqual({ success: true, data: 1 });
  });

  it("coerces null to 0", () => {
    const ir: NumberIR = { type: "number", checks: [], coerce: true };
    const safeParse = compileIR(ir);
    expect(safeParse(null)).toEqual({ success: true, data: 0 });
  });

  it("coerced number respects checks", () => {
    const ir: NumberIR = {
      type: "number",
      checks: [{ kind: "greater_than", value: 0, inclusive: false }],
      coerce: true,
    };
    const safeParse = compileIR(ir);
    expect(safeParse("42").success).toBe(true);
    expect(safeParse("0").success).toBe(false);
    expect(safeParse("-1").success).toBe(false);
  });
});

describe("slow-path — coerce boolean", () => {
  it("coerces truthy values to true", () => {
    const ir: BooleanIR = { type: "boolean", coerce: true };
    const safeParse = compileIR(ir);
    expect(safeParse(1)).toEqual({ success: true, data: true });
    expect(safeParse("hello")).toEqual({ success: true, data: true });
    expect(safeParse(42)).toEqual({ success: true, data: true });
  });

  it("coerces falsy values to false", () => {
    const ir: BooleanIR = { type: "boolean", coerce: true };
    const safeParse = compileIR(ir);
    expect(safeParse(0)).toEqual({ success: true, data: false });
    expect(safeParse("")).toEqual({ success: true, data: false });
    expect(safeParse(null)).toEqual({ success: true, data: false });
    expect(safeParse(undefined)).toEqual({ success: true, data: false });
  });
});

describe("slow-path — coerce bigint", () => {
  it("coerces string to bigint", () => {
    const ir: BigIntIR = { type: "bigint", checks: [], coerce: true };
    const safeParse = compileIR(ir);
    const result = safeParse("42");
    expect(result.success).toBe(true);
    expect(result.data).toBe(42n);
  });

  it("coerces number to bigint", () => {
    const ir: BigIntIR = { type: "bigint", checks: [], coerce: true };
    const safeParse = compileIR(ir);
    const result = safeParse(42);
    expect(result.success).toBe(true);
    expect(result.data).toBe(42n);
  });

  it("rejects invalid bigint coercion", () => {
    const ir: BigIntIR = { type: "bigint", checks: [], coerce: true };
    const safeParse = compileIR(ir);
    expect(safeParse("abc").success).toBe(false);
  });

  it("rejects float for bigint coercion", () => {
    const ir: BigIntIR = { type: "bigint", checks: [], coerce: true };
    const safeParse = compileIR(ir);
    expect(safeParse(3.14).success).toBe(false);
  });

  it("coerces boolean to bigint", () => {
    const ir: BigIntIR = { type: "bigint", checks: [], coerce: true };
    const safeParse = compileIR(ir);
    expect(safeParse(true).success).toBe(true);
    expect(safeParse(true).data).toBe(1n);
    expect(safeParse(false).data).toBe(0n);
  });
});

describe("slow-path — coerce date", () => {
  it("coerces string to date", () => {
    const ir: DateIR = { type: "date", checks: [], coerce: true };
    const safeParse = compileIR(ir);
    const result = safeParse("2024-01-01");
    expect(result.success).toBe(true);
    expect(result.data).toBeInstanceOf(Date);
  });

  it("coerces number (timestamp) to date", () => {
    const ir: DateIR = { type: "date", checks: [], coerce: true };
    const safeParse = compileIR(ir);
    const result = safeParse(0);
    expect(result.success).toBe(true);
    expect(result.data).toBeInstanceOf(Date);
  });

  it("rejects invalid date string coercion", () => {
    const ir: DateIR = { type: "date", checks: [], coerce: true };
    const safeParse = compileIR(ir);
    expect(safeParse("invalid").success).toBe(false);
  });

  it("passes through Date object", () => {
    const ir: DateIR = { type: "date", checks: [], coerce: true };
    const safeParse = compileIR(ir);
    const date = new Date("2024-01-01");
    const result = safeParse(date);
    expect(result.success).toBe(true);
    expect(result.data).toBeInstanceOf(Date);
  });
});
