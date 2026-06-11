import { describe, expect, it } from "vitest";
import type { ReadonlyIR } from "#src/core/types.js";
import { compileFastCheck, compileIR } from "../helpers.js";

describe("slow-path — readonly", () => {
  it("delegates validation to inner type", () => {
    const ir: ReadonlyIR = {
      type: "readonly",
      inner: { type: "string", checks: [] },
    };
    const safeParse = compileIR(ir);
    expect(safeParse("hello")).toEqual({ success: true, data: "hello" });
  });

  it("rejects invalid inner type", () => {
    const ir: ReadonlyIR = {
      type: "readonly",
      inner: { type: "number", checks: [] },
    };
    const safeParse = compileIR(ir);
    expect(safeParse("hello").success).toBe(false);
  });

  it("works with nested readonly", () => {
    const ir: ReadonlyIR = {
      type: "readonly",
      inner: {
        type: "readonly",
        inner: { type: "boolean" },
      },
    };
    const safeParse = compileIR(ir);
    expect(safeParse(true)).toEqual({ success: true, data: true });
    expect(safeParse("true").success).toBe(false);
  });
});

describe("fast-path — Readonly", () => {
  it("readonly string: same as string", () => {
    const fn = compileFastCheck({ type: "readonly", inner: { type: "string", checks: [] } });
    expect(fn?.("a")).toBe(true);
    expect(fn?.(42)).toBe(false);
  });

  it("ineligible inner → returns null", () => {
    expect(
      compileFastCheck({ type: "readonly", inner: { type: "fallback", reason: "transform" } }),
    ).toBeNull();
  });
});
