import { describe, expect, it } from "vitest";
import type { BigIntIR } from "#src/core/types.js";
import { compileFastCheck, compileIR } from "../helpers.js";

describe("slow-path — bigint", () => {
  it("generates code that accepts a bigint", () => {
    const ir: BigIntIR = { type: "bigint", checks: [] };
    const safeParse = compileIR(ir);
    expect(safeParse(42n)).toEqual({ success: true, data: 42n });
  });

  it("generates code that rejects non-bigint", () => {
    const ir: BigIntIR = { type: "bigint", checks: [] };
    const safeParse = compileIR(ir);
    expect(safeParse(42).success).toBe(false);
    expect(safeParse("42").success).toBe(false);
    expect(safeParse(null).success).toBe(false);
    expect(safeParse(undefined).success).toBe(false);
    expect(safeParse(true).success).toBe(false);
    expect(safeParse({}).success).toBe(false);
  });

  it("generates greater_than (inclusive) check", () => {
    const ir: BigIntIR = {
      type: "bigint",
      checks: [{ kind: "bigint_greater_than", value: "0", inclusive: true }],
    };
    const safeParse = compileIR(ir);
    expect(safeParse(0n).success).toBe(true);
    expect(safeParse(1n).success).toBe(true);
    expect(safeParse(-1n).success).toBe(false);
  });

  it("generates greater_than (exclusive) check", () => {
    const ir: BigIntIR = {
      type: "bigint",
      checks: [{ kind: "bigint_greater_than", value: "0", inclusive: false }],
    };
    const safeParse = compileIR(ir);
    expect(safeParse(1n).success).toBe(true);
    expect(safeParse(0n).success).toBe(false);
    expect(safeParse(-1n).success).toBe(false);
  });

  it("generates less_than (inclusive) check", () => {
    const ir: BigIntIR = {
      type: "bigint",
      checks: [{ kind: "bigint_less_than", value: "100", inclusive: true }],
    };
    const safeParse = compileIR(ir);
    expect(safeParse(100n).success).toBe(true);
    expect(safeParse(99n).success).toBe(true);
    expect(safeParse(101n).success).toBe(false);
  });

  it("generates less_than (exclusive) check", () => {
    const ir: BigIntIR = {
      type: "bigint",
      checks: [{ kind: "bigint_less_than", value: "100", inclusive: false }],
    };
    const safeParse = compileIR(ir);
    expect(safeParse(99n).success).toBe(true);
    expect(safeParse(100n).success).toBe(false);
  });

  it("generates multiple_of check", () => {
    const ir: BigIntIR = {
      type: "bigint",
      checks: [{ kind: "bigint_multiple_of", value: "3" }],
    };
    const safeParse = compileIR(ir);
    expect(safeParse(0n).success).toBe(true);
    expect(safeParse(3n).success).toBe(true);
    expect(safeParse(9n).success).toBe(true);
    expect(safeParse(1n).success).toBe(false);
    expect(safeParse(7n).success).toBe(false);
  });

  it("generates range check (min + max)", () => {
    const ir: BigIntIR = {
      type: "bigint",
      checks: [
        { kind: "bigint_greater_than", value: "1", inclusive: true },
        { kind: "bigint_less_than", value: "100", inclusive: true },
      ],
    };
    const safeParse = compileIR(ir);
    expect(safeParse(1n).success).toBe(true);
    expect(safeParse(50n).success).toBe(true);
    expect(safeParse(100n).success).toBe(true);
    expect(safeParse(0n).success).toBe(false);
    expect(safeParse(101n).success).toBe(false);
  });

  it("generates negative bigint values in checks", () => {
    const ir: BigIntIR = {
      type: "bigint",
      checks: [{ kind: "bigint_less_than", value: "0", inclusive: false }],
    };
    const safeParse = compileIR(ir);
    expect(safeParse(-1n).success).toBe(true);
    expect(safeParse(-100n).success).toBe(true);
    expect(safeParse(0n).success).toBe(false);
    expect(safeParse(1n).success).toBe(false);
  });
});

describe("fast-path — BigInt", () => {
  it("plain bigint: accepts 1n, rejects 1", () => {
    const fn = compileFastCheck({ type: "bigint", checks: [] });
    expect(fn?.(1n)).toBe(true);
    expect(fn?.(1)).toBe(false);
  });

  it("with coerce: returns null", () => {
    expect(compileFastCheck({ type: "bigint", checks: [], coerce: true })).toBeNull();
  });

  it("bigint_greater_than inclusive", () => {
    const fn = compileFastCheck({
      type: "bigint",
      checks: [{ kind: "bigint_greater_than", value: "10", inclusive: true }],
    });
    expect(fn?.(10n)).toBe(true);
    expect(fn?.(9n)).toBe(false);
  });

  it("bigint_greater_than exclusive", () => {
    const fn = compileFastCheck({
      type: "bigint",
      checks: [{ kind: "bigint_greater_than", value: "10", inclusive: false }],
    });
    expect(fn?.(11n)).toBe(true);
    expect(fn?.(10n)).toBe(false);
  });

  it("bigint_less_than inclusive", () => {
    const fn = compileFastCheck({
      type: "bigint",
      checks: [{ kind: "bigint_less_than", value: "100", inclusive: true }],
    });
    expect(fn?.(100n)).toBe(true);
    expect(fn?.(101n)).toBe(false);
  });

  it("bigint_less_than exclusive", () => {
    const fn = compileFastCheck({
      type: "bigint",
      checks: [{ kind: "bigint_less_than", value: "100", inclusive: false }],
    });
    expect(fn?.(99n)).toBe(true);
    expect(fn?.(100n)).toBe(false);
  });

  it("bigint_multiple_of", () => {
    const fn = compileFastCheck({
      type: "bigint",
      checks: [{ kind: "bigint_multiple_of", value: "3" }],
    });
    expect(fn?.(9n)).toBe(true);
    expect(fn?.(10n)).toBe(false);
  });
});
