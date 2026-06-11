import { describe, expect, it } from "vitest";
import type { NullableIR } from "#src/core/types.js";
import { compileFastCheck, compileIR } from "../helpers.js";

describe("slow-path — nullable", () => {
  it("accepts the inner type", () => {
    const ir: NullableIR = { type: "nullable", inner: { type: "string", checks: [] } };
    const safeParse = compileIR(ir);
    expect(safeParse("hello")).toEqual({ success: true, data: "hello" });
  });

  it("accepts null", () => {
    const ir: NullableIR = { type: "nullable", inner: { type: "string", checks: [] } };
    const safeParse = compileIR(ir);
    expect(safeParse(null)).toEqual({ success: true, data: null });
  });

  it("rejects undefined (nullable is not optional)", () => {
    const ir: NullableIR = { type: "nullable", inner: { type: "string", checks: [] } };
    const safeParse = compileIR(ir);
    expect(safeParse(undefined).success).toBe(false);
  });

  it("validates inner checks when value is present", () => {
    const ir: NullableIR = {
      type: "nullable",
      inner: { type: "number", checks: [{ kind: "greater_than", value: 0, inclusive: true }] },
    };
    const safeParse = compileIR(ir);
    expect(safeParse(5).success).toBe(true);
    expect(safeParse(null).success).toBe(true);
    expect(safeParse(-1).success).toBe(false);
  });
});

describe("fast-path — Nullable", () => {
  it("nullable string: accepts 'a', accepts null, rejects 42", () => {
    const fn = compileFastCheck({ type: "nullable", inner: { type: "string", checks: [] } });
    expect(fn?.("a")).toBe(true);
    expect(fn?.(null)).toBe(true);
    expect(fn?.(42)).toBe(false);
  });

  it("ineligible inner → returns null", () => {
    expect(
      compileFastCheck({ type: "nullable", inner: { type: "fallback", reason: "transform" } }),
    ).toBeNull();
  });
});
