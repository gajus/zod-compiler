import { describe, expect, it } from "vitest";
import { z } from "zod";
import { extractBigint } from "#src/core/extract/extractors/bigint.js";
import { extractSchema } from "#src/core/extract/index.js";
import type { BigIntIR } from "#src/core/types.js";

describe("extractSchema — bigint checks", () => {
  it("extracts plain bigint with no checks", () => {
    const ir = extractSchema(z.bigint()) as BigIntIR;
    expect(ir).toEqual<BigIntIR>({ type: "bigint", checks: [] });
  });

  it("extracts min (inclusive) check via .min()", () => {
    const ir = extractSchema(z.bigint().min(0n)) as BigIntIR;
    expect(ir.type).toBe("bigint");
    expect(ir.checks).toContainEqual({
      kind: "bigint_greater_than",
      value: "0",
      inclusive: true,
    });
  });

  it("extracts max (inclusive) check via .max()", () => {
    const ir = extractSchema(z.bigint().max(100n)) as BigIntIR;
    expect(ir.type).toBe("bigint");
    expect(ir.checks).toContainEqual({
      kind: "bigint_less_than",
      value: "100",
      inclusive: true,
    });
  });

  it("extracts positive (exclusive > 0) check", () => {
    const ir = extractSchema(z.bigint().positive()) as BigIntIR;
    expect(ir.type).toBe("bigint");
    expect(ir.checks).toContainEqual({
      kind: "bigint_greater_than",
      value: "0",
      inclusive: false,
    });
  });

  it("extracts negative (exclusive < 0) check", () => {
    const ir = extractSchema(z.bigint().negative()) as BigIntIR;
    expect(ir.type).toBe("bigint");
    expect(ir.checks).toContainEqual({
      kind: "bigint_less_than",
      value: "0",
      inclusive: false,
    });
  });

  it("extracts nonnegative (inclusive >= 0) check", () => {
    const ir = extractSchema(z.bigint().nonnegative()) as BigIntIR;
    expect(ir.type).toBe("bigint");
    expect(ir.checks).toContainEqual({
      kind: "bigint_greater_than",
      value: "0",
      inclusive: true,
    });
  });

  it("extracts nonpositive (inclusive <= 0) check", () => {
    const ir = extractSchema(z.bigint().nonpositive()) as BigIntIR;
    expect(ir.type).toBe("bigint");
    expect(ir.checks).toContainEqual({
      kind: "bigint_less_than",
      value: "0",
      inclusive: true,
    });
  });

  it("extracts multipleOf check", () => {
    const ir = extractSchema(z.bigint().multipleOf(5n)) as BigIntIR;
    expect(ir.type).toBe("bigint");
    expect(ir.checks).toContainEqual({
      kind: "bigint_multiple_of",
      value: "5",
    });
  });

  it("extracts combined min + max range checks", () => {
    const ir = extractSchema(z.bigint().min(1n).max(100n)) as BigIntIR;
    expect(ir.checks).toHaveLength(2);
    expect(ir.checks).toContainEqual({
      kind: "bigint_greater_than",
      value: "1",
      inclusive: true,
    });
    expect(ir.checks).toContainEqual({
      kind: "bigint_less_than",
      value: "100",
      inclusive: true,
    });
  });

  it("extracts combined positive + multipleOf checks", () => {
    const ir = extractSchema(z.bigint().positive().multipleOf(3n)) as BigIntIR;
    expect(ir.checks).toHaveLength(2);
    expect(ir.checks).toContainEqual({
      kind: "bigint_greater_than",
      value: "0",
      inclusive: false,
    });
    expect(ir.checks).toContainEqual({
      kind: "bigint_multiple_of",
      value: "3",
    });
  });

  it("serializes bigint values as strings", () => {
    const ir = extractSchema(z.bigint().min(9007199254740993n)) as BigIntIR;
    expect(ir.checks[0]).toMatchObject({
      kind: "bigint_greater_than",
      value: "9007199254740993",
    });
  });

  it("skips checks without _zod.def", () => {
    const ir = extractBigint({
      type: "bigint",
      checks: [{ _zod: undefined }],
    } as never) as BigIntIR;
    expect(ir).toEqual({ type: "bigint", checks: [] });
  });

  it("extracts coerce flag", () => {
    const ir = extractSchema(z.coerce.bigint()) as BigIntIR;
    expect(ir.type).toBe("bigint");
    expect(ir.coerce).toBe(true);
  });
});
