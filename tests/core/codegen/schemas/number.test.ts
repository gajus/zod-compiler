import { describe, expect, it } from "vitest";
import type { NumberIR } from "#src/core/types.js";
import { compileFastCheck, compileIR } from "../helpers.js";

describe("slow-path — number", () => {
  it("generates code that accepts a number", () => {
    const ir: NumberIR = { type: "number", checks: [] };
    const safeParse = compileIR(ir);
    expect(safeParse(42)).toEqual({ success: true, data: 42 });
  });

  it("generates code that rejects non-number", () => {
    const ir: NumberIR = { type: "number", checks: [] };
    const safeParse = compileIR(ir);
    expect(safeParse("42").success).toBe(false);
    expect(safeParse(null).success).toBe(false);
    expect(safeParse(undefined).success).toBe(false);
    expect(safeParse(true).success).toBe(false);
  });

  it("generates code that rejects NaN", () => {
    const ir: NumberIR = { type: "number", checks: [] };
    const safeParse = compileIR(ir);
    expect(safeParse(NaN).success).toBe(false);
  });

  it("generates greater_than (inclusive) check", () => {
    const ir: NumberIR = {
      type: "number",
      checks: [{ kind: "greater_than", value: 0, inclusive: true }],
    };
    const safeParse = compileIR(ir);
    expect(safeParse(0).success).toBe(true);
    expect(safeParse(1).success).toBe(true);
    expect(safeParse(-1).success).toBe(false);
  });

  it("generates greater_than (exclusive) check", () => {
    const ir: NumberIR = {
      type: "number",
      checks: [{ kind: "greater_than", value: 0, inclusive: false }],
    };
    const safeParse = compileIR(ir);
    expect(safeParse(1).success).toBe(true);
    expect(safeParse(0).success).toBe(false);
    expect(safeParse(-1).success).toBe(false);
  });

  it("generates less_than (inclusive) check", () => {
    const ir: NumberIR = {
      type: "number",
      checks: [{ kind: "less_than", value: 100, inclusive: true }],
    };
    const safeParse = compileIR(ir);
    expect(safeParse(100).success).toBe(true);
    expect(safeParse(99).success).toBe(true);
    expect(safeParse(101).success).toBe(false);
  });

  it("generates less_than (exclusive) check", () => {
    const ir: NumberIR = {
      type: "number",
      checks: [{ kind: "less_than", value: 100, inclusive: false }],
    };
    const safeParse = compileIR(ir);
    expect(safeParse(99).success).toBe(true);
    expect(safeParse(100).success).toBe(false);
  });

  it("generates number_format (safeint) check", () => {
    const ir: NumberIR = {
      type: "number",
      checks: [{ kind: "number_format", format: "safeint" }],
    };
    const safeParse = compileIR(ir);
    expect(safeParse(42).success).toBe(true);
    expect(safeParse(0).success).toBe(true);
    expect(safeParse(-1).success).toBe(true);
    expect(safeParse(3.14).success).toBe(false);
    expect(safeParse(Infinity).success).toBe(false);
  });

  it("generates multiple_of check", () => {
    const ir: NumberIR = {
      type: "number",
      checks: [{ kind: "multiple_of", value: 5 }],
    };
    const safeParse = compileIR(ir);
    expect(safeParse(0).success).toBe(true);
    expect(safeParse(5).success).toBe(true);
    expect(safeParse(10).success).toBe(true);
    expect(safeParse(3).success).toBe(false);
    expect(safeParse(7).success).toBe(false);
  });

  it("generates number_format (int32) check", () => {
    const ir: NumberIR = {
      type: "number",
      checks: [{ kind: "number_format", format: "int32" }],
    };
    const safeParse = compileIR(ir);
    expect(safeParse(42).success).toBe(true);
    expect(safeParse(0).success).toBe(true);
    expect(safeParse(-2147483648).success).toBe(true);
    expect(safeParse(2147483647).success).toBe(true);
    expect(safeParse(3.14).success).toBe(false);
    expect(safeParse(-2147483649).success).toBe(false);
    expect(safeParse(2147483648).success).toBe(false);
  });

  it("generates number_format (uint32) check", () => {
    const ir: NumberIR = {
      type: "number",
      checks: [{ kind: "number_format", format: "uint32" }],
    };
    const safeParse = compileIR(ir);
    expect(safeParse(0).success).toBe(true);
    expect(safeParse(42).success).toBe(true);
    expect(safeParse(4294967295).success).toBe(true);
    expect(safeParse(3.14).success).toBe(false);
    expect(safeParse(-1).success).toBe(false);
    expect(safeParse(4294967296).success).toBe(false);
  });

  it("generates number_format (float32) check", () => {
    const ir: NumberIR = {
      type: "number",
      checks: [{ kind: "number_format", format: "float32" }],
    };
    const safeParse = compileIR(ir);
    expect(safeParse(0).success).toBe(true);
    expect(safeParse(3.14).success).toBe(true);
    expect(safeParse(-3.4028234663852886e38).success).toBe(true);
    expect(safeParse(3.4028234663852886e38).success).toBe(true);
    expect(safeParse(-3.5e38).success).toBe(false);
    expect(safeParse(3.5e38).success).toBe(false);
  });

  it("generates number_format (float64) — no extra checks beyond isFinite", () => {
    const ir: NumberIR = {
      type: "number",
      checks: [{ kind: "number_format", format: "float64" }],
    };
    const safeParse = compileIR(ir);
    expect(safeParse(0).success).toBe(true);
    expect(safeParse(3.14).success).toBe(true);
    expect(safeParse(Number.MAX_VALUE).success).toBe(true);
    expect(safeParse(-Number.MAX_VALUE).success).toBe(true);
    expect(safeParse(Infinity).success).toBe(false);
    expect(safeParse(NaN).success).toBe(false);
  });

  it("generates range check (min + max)", () => {
    const ir: NumberIR = {
      type: "number",
      checks: [
        { kind: "greater_than", value: 1, inclusive: true },
        { kind: "less_than", value: 100, inclusive: true },
      ],
    };
    const safeParse = compileIR(ir);
    expect(safeParse(1).success).toBe(true);
    expect(safeParse(50).success).toBe(true);
    expect(safeParse(100).success).toBe(true);
    expect(safeParse(0).success).toBe(false);
    expect(safeParse(101).success).toBe(false);
  });
});

describe("fast-path — Number", () => {
  it("plain number: accepts 42, rejects '42'", () => {
    const fn = compileFastCheck({ type: "number", checks: [] });
    expect(fn?.(42)).toBe(true);
    expect(fn?.("42")).toBe(false);
  });

  it("with coerce: returns null", () => {
    expect(compileFastCheck({ type: "number", checks: [], coerce: true })).toBeNull();
  });

  it("rejects NaN", () => {
    const fn = compileFastCheck({ type: "number", checks: [] });
    expect(fn?.(Number.NaN)).toBe(false);
  });

  it("rejects Infinity", () => {
    const fn = compileFastCheck({ type: "number", checks: [] });
    expect(fn?.(Number.POSITIVE_INFINITY)).toBe(false);
  });

  it("safeint: accepts 1, rejects 1.5", () => {
    const fn = compileFastCheck({
      type: "number",
      checks: [{ kind: "number_format", format: "safeint" }],
    });
    expect(fn?.(1)).toBe(true);
    expect(fn?.(1.5)).toBe(false);
  });

  it("int32: accepts 0, rejects 2147483648", () => {
    const fn = compileFastCheck({
      type: "number",
      checks: [{ kind: "number_format", format: "int32" }],
    });
    expect(fn?.(0)).toBe(true);
    expect(fn?.(2147483648)).toBe(false);
  });

  it("uint32: accepts 0, rejects -1, rejects 4294967296", () => {
    const fn = compileFastCheck({
      type: "number",
      checks: [{ kind: "number_format", format: "uint32" }],
    });
    expect(fn?.(0)).toBe(true);
    expect(fn?.(-1)).toBe(false);
    expect(fn?.(4294967296)).toBe(false);
  });

  it("float32: range check only (zod accepts non-representable in-range floats)", () => {
    const fn = compileFastCheck({
      type: "number",
      checks: [{ kind: "number_format", format: "float32" }],
    });
    expect(fn?.(1.5)).toBe(true);
    // zod's float32 check is a pure range check — 1.1 is accepted even
    // though Math.fround(1.1) !== 1.1. A fround-based fast check would
    // disagree with the slow path / zod on every such value.
    expect(fn?.(1.1)).toBe(true);
    expect(fn?.(3.5e38)).toBe(false);
    expect(fn?.(-3.5e38)).toBe(false);
  });

  it("float64: accepts any finite number", () => {
    const fn = compileFastCheck({
      type: "number",
      checks: [{ kind: "number_format", format: "float64" }],
    });
    expect(fn?.(Number.MAX_VALUE)).toBe(true);
    expect(fn?.(Number.MIN_VALUE)).toBe(true);
  });

  it("greater_than inclusive", () => {
    const fn = compileFastCheck({
      type: "number",
      checks: [{ kind: "greater_than", value: 5, inclusive: true }],
    });
    expect(fn?.(5)).toBe(true);
    expect(fn?.(4)).toBe(false);
  });

  it("greater_than exclusive", () => {
    const fn = compileFastCheck({
      type: "number",
      checks: [{ kind: "greater_than", value: 5, inclusive: false }],
    });
    expect(fn?.(6)).toBe(true);
    expect(fn?.(5)).toBe(false);
  });

  it("less_than inclusive", () => {
    const fn = compileFastCheck({
      type: "number",
      checks: [{ kind: "less_than", value: 10, inclusive: true }],
    });
    expect(fn?.(10)).toBe(true);
    expect(fn?.(11)).toBe(false);
  });

  it("less_than exclusive", () => {
    const fn = compileFastCheck({
      type: "number",
      checks: [{ kind: "less_than", value: 10, inclusive: false }],
    });
    expect(fn?.(9)).toBe(true);
    expect(fn?.(10)).toBe(false);
  });

  it("string-only checks on number schema are skipped", () => {
    const fn = compileFastCheck({
      type: "number",
      checks: [
        { kind: "min_length", minimum: 1 },
        { kind: "max_length", maximum: 10 },
        { kind: "length_equals", length: 5 },
        { kind: "string_format", format: "email" },
        { kind: "includes", includes: "foo" },
        { kind: "starts_with", prefix: "bar" },
        { kind: "ends_with", suffix: "baz" },
      ],
    });
    // All string-only checks are skipped, only typeof/isNaN/isFinite remain
    expect(fn?.(42)).toBe(true);
    expect(fn?.("42")).toBe(false);
  });

  it("multiple_of: accepts 6 for 3, rejects 7", () => {
    const fn = compileFastCheck({
      type: "number",
      checks: [{ kind: "multiple_of", value: 3 }],
    });
    expect(fn?.(6)).toBe(true);
    expect(fn?.(7)).toBe(false);
  });
});
