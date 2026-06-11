import { describe, expect, it } from "vitest";
import type { DefaultIR } from "#src/core/types.js";
import { compileFastCheck, compileIR } from "../helpers.js";

/** Create a mock fallback schema with the given default value. */
function mockFb(defaultValue: unknown) {
  return {
    _zod: { def: { defaultValue } },
    safeParse: () => ({ success: true, data: defaultValue }),
  };
}

describe("slow-path — default", () => {
  it("uses default value when input is undefined", () => {
    const ir: DefaultIR = {
      type: "default",
      inner: { type: "string", checks: [] },
      refIndex: 0,
    };
    const safeParse = compileIR(ir, "test", [mockFb("hello")]);
    const result = safeParse(undefined);
    expect(result.success).toBe(true);
    expect(result.data).toBe("hello");
  });

  it("uses provided value when not undefined", () => {
    const ir: DefaultIR = {
      type: "default",
      inner: { type: "string", checks: [] },
      refIndex: 0,
    };
    const safeParse = compileIR(ir, "test", [mockFb("hello")]);
    const result = safeParse("world");
    expect(result.success).toBe(true);
    expect(result.data).toBe("world");
  });

  it("validates provided value against inner type", () => {
    const ir: DefaultIR = {
      type: "default",
      inner: { type: "string", checks: [] },
      refIndex: 0,
    };
    const safeParse = compileIR(ir, "test", [mockFb("hello")]);
    expect(safeParse(42).success).toBe(false);
  });

  it("null is not replaced by default (not undefined)", () => {
    const ir: DefaultIR = {
      type: "default",
      inner: { type: "string", checks: [] },
      refIndex: 0,
    };
    const safeParse = compileIR(ir, "test", [mockFb("hello")]);
    expect(safeParse(null).success).toBe(false);
  });

  it("default value skips inner validation (matches Zod behavior)", () => {
    const ir: DefaultIR = {
      type: "default",
      inner: { type: "string", checks: [{ kind: "min_length", minimum: 10 }] },
      refIndex: 0,
    };
    const safeParse = compileIR(ir, "test", [mockFb("x")]);
    // Zod: z.string().min(10).default("x").safeParse(undefined) → { success: true, data: "x" }
    // Default value is trusted and inner validation is skipped
    const result = safeParse(undefined);
    expect(result.success).toBe(true);
    expect(result.data).toBe("x");
  });

  it("non-undefined input still validates against inner schema", () => {
    const ir: DefaultIR = {
      type: "default",
      inner: { type: "string", checks: [{ kind: "min_length", minimum: 10 }] },
      refIndex: 0,
    };
    const safeParse = compileIR(ir, "test", [mockFb("x")]);
    // "short" does not meet min(10)
    expect(safeParse("short").success).toBe(false);
    // "longstringhere" meets min(10)
    expect(safeParse("longstringhere").success).toBe(true);
  });

  it("object default value works correctly", () => {
    const defaultObj = { name: "default" };
    const ir: DefaultIR = {
      type: "default",
      inner: {
        type: "object",
        properties: {
          name: { type: "string", checks: [] },
        },
      },
      refIndex: 0,
    };
    const safeParse = compileIR(ir, "test", [mockFb(defaultObj)]);
    const result = safeParse(undefined);
    expect(result.success).toBe(true);
    expect(result.data).toEqual({ name: "default" });
  });
});

describe("fast-path — default", () => {
  it("accepts valid non-undefined input via fast path", () => {
    const fn = compileFastCheck({
      type: "default",
      inner: { type: "string", checks: [] },
      refIndex: 0,
    });
    expect(fn).not.toBeNull();
    expect(fn?.("world")).toBe(true);
  });

  it("rejects undefined (delegates to slow path for default application)", () => {
    const fn = compileFastCheck({
      type: "default",
      inner: { type: "string", checks: [] },
      refIndex: 0,
    });
    expect(fn).not.toBeNull();
    expect(fn?.(undefined)).toBe(false);
  });

  it("rejects invalid non-undefined input", () => {
    const fn = compileFastCheck({
      type: "default",
      inner: { type: "string", checks: [] },
      refIndex: 0,
    });
    expect(fn).not.toBeNull();
    expect(fn?.(42)).toBe(false);
  });

  it("validates inner checks for non-undefined input", () => {
    const fn = compileFastCheck({
      type: "default",
      inner: { type: "string", checks: [{ kind: "min_length", minimum: 3 }] },
      refIndex: 0,
    });
    expect(fn).not.toBeNull();
    expect(fn?.("abc")).toBe(true);
    expect(fn?.("ab")).toBe(false);
    expect(fn?.(undefined)).toBe(false);
  });

  it("ineligible inner → returns null", () => {
    expect(
      compileFastCheck({
        type: "default",
        inner: { type: "fallback", reason: "transform" },
        refIndex: 0,
      }),
    ).toBeNull();
  });

  it("nested default inside object — object gains fast path", () => {
    const fn = compileFastCheck({
      type: "object",
      properties: {
        name: {
          type: "default",
          inner: { type: "string", checks: [] },
          refIndex: 0,
        },
      },
    });
    // Object with non-undefined property should pass fast path
    expect(fn).not.toBeNull();
    expect(fn?.({ name: "hello" })).toBe(true);
  });

  it("end-to-end: fast path + slow path produce correct results", () => {
    const ir: DefaultIR = {
      type: "default",
      inner: { type: "string", checks: [] },
      refIndex: 0,
    };
    const safeParse = compileIR(ir, "test", [mockFb("hello")]);

    // Valid input: should use fast path, return input as-is
    expect(safeParse("world")).toEqual({ success: true, data: "world" });

    // undefined: slow path applies default
    expect(safeParse(undefined)).toEqual({ success: true, data: "hello" });

    // Invalid: slow path collects errors
    expect(safeParse(42).success).toBe(false);
  });
});
