import { describe, expect, it } from "vitest";
import type { OptionalIR } from "#src/core/types.js";
import { compileFastCheck, compileIR } from "../helpers.js";

describe("slow-path — optional", () => {
  it("accepts the inner type", () => {
    const ir: OptionalIR = { type: "optional", inner: { type: "string", checks: [] } };
    const safeParse = compileIR(ir);
    expect(safeParse("hello")).toEqual({ success: true, data: "hello" });
  });

  it("accepts undefined", () => {
    const ir: OptionalIR = { type: "optional", inner: { type: "string", checks: [] } };
    const safeParse = compileIR(ir);
    expect(safeParse(undefined)).toEqual({ success: true, data: undefined });
  });

  it("rejects null (optional is not nullable)", () => {
    const ir: OptionalIR = { type: "optional", inner: { type: "string", checks: [] } };
    const safeParse = compileIR(ir);
    expect(safeParse(null).success).toBe(false);
  });

  it("validates inner checks when value is present", () => {
    const ir: OptionalIR = {
      type: "optional",
      inner: { type: "string", checks: [{ kind: "min_length", minimum: 3 }] },
    };
    const safeParse = compileIR(ir);
    expect(safeParse("abc").success).toBe(true);
    expect(safeParse(undefined).success).toBe(true);
    expect(safeParse("ab").success).toBe(false);
  });
});

describe("fast-path — Optional", () => {
  it("optional string: accepts 'a', accepts undefined, rejects 42", () => {
    const fn = compileFastCheck({ type: "optional", inner: { type: "string", checks: [] } });
    expect(fn?.("a")).toBe(true);
    expect(fn?.(undefined)).toBe(true);
    expect(fn?.(42)).toBe(false);
  });

  it("ineligible inner → returns null", () => {
    expect(
      compileFastCheck({ type: "optional", inner: { type: "fallback", reason: "transform" } }),
    ).toBeNull();
  });
});
