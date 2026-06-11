import { describe, expect, it } from "vitest";
import { z } from "zod";
import { extractNumber } from "#src/core/extract/extractors/number.js";
import { extractSchema } from "#src/core/extract/index.js";
import type { FallbackIR, NumberIR } from "#src/core/types.js";

describe("extractSchema — number checks", () => {
  it("extracts min (inclusive) check", () => {
    const ir = extractSchema(z.number().min(0)) as NumberIR;
    expect(ir.checks).toContainEqual({ kind: "greater_than", value: 0, inclusive: true });
  });

  it("extracts max (inclusive) check", () => {
    const ir = extractSchema(z.number().max(100)) as NumberIR;
    expect(ir.checks).toContainEqual({ kind: "less_than", value: 100, inclusive: true });
  });

  it("extracts positive (exclusive > 0) check", () => {
    const ir = extractSchema(z.number().positive()) as NumberIR;
    expect(ir.checks).toContainEqual({ kind: "greater_than", value: 0, inclusive: false });
  });

  it("extracts negative (exclusive < 0) check", () => {
    const ir = extractSchema(z.number().negative()) as NumberIR;
    expect(ir.checks).toContainEqual({ kind: "less_than", value: 0, inclusive: false });
  });

  it("extracts nonnegative (inclusive >= 0) check", () => {
    const ir = extractSchema(z.number().nonnegative()) as NumberIR;
    expect(ir.checks).toContainEqual({ kind: "greater_than", value: 0, inclusive: true });
  });

  it("extracts nonpositive (inclusive <= 0) check", () => {
    const ir = extractSchema(z.number().nonpositive()) as NumberIR;
    expect(ir.checks).toContainEqual({ kind: "less_than", value: 0, inclusive: true });
  });

  it("extracts int (safeint format) check", () => {
    const ir = extractSchema(z.number().int()) as NumberIR;
    expect(ir.checks).toContainEqual({ kind: "number_format", format: "safeint" });
  });

  it("extracts multipleOf check", () => {
    const ir = extractSchema(z.number().multipleOf(5)) as NumberIR;
    expect(ir.checks).toContainEqual({ kind: "multiple_of", value: 5 });
  });

  it("extracts int32 format check", () => {
    const ir = extractSchema(z.int32()) as NumberIR;
    expect(ir.checks).toContainEqual({ kind: "number_format", format: "int32" });
  });

  it("extracts uint32 format check", () => {
    const ir = extractSchema(z.uint32()) as NumberIR;
    expect(ir.checks).toContainEqual({ kind: "number_format", format: "uint32" });
  });

  it("extracts float32 format check", () => {
    const ir = extractSchema(z.float32()) as NumberIR;
    expect(ir.checks).toContainEqual({ kind: "number_format", format: "float32" });
  });

  it("extracts float64 format check", () => {
    const ir = extractSchema(z.float64()) as NumberIR;
    expect(ir.checks).toContainEqual({ kind: "number_format", format: "float64" });
  });

  it("extracts combined int + positive checks", () => {
    const ir = extractSchema(z.number().int().positive()) as NumberIR;
    expect(ir.checks).toContainEqual({ kind: "number_format", format: "safeint" });
    expect(ir.checks).toContainEqual({ kind: "greater_than", value: 0, inclusive: false });
  });

  it("extracts min + max range checks", () => {
    const ir = extractSchema(z.number().min(1).max(100)) as NumberIR;
    expect(ir.checks).toHaveLength(2);
    expect(ir.checks).toContainEqual({ kind: "greater_than", value: 1, inclusive: true });
    expect(ir.checks).toContainEqual({ kind: "less_than", value: 100, inclusive: true });
  });
});

describe("extractNumber — branch coverage", () => {
  it("extracts plain number with no checks", () => {
    const ir = extractSchema(z.number()) as NumberIR;
    expect(ir).toEqual({ type: "number", checks: [] });
  });

  it("extracts number with coerce", () => {
    const ir = extractSchema(z.coerce.number()) as NumberIR;
    expect(ir.type).toBe("number");
    expect(ir.coerce).toBe(true);
    expect(ir.checks).toEqual([]);
  });

  it("extracts coerce + checks combined", () => {
    const ir = extractSchema(z.coerce.number().min(0)) as NumberIR;
    expect(ir.coerce).toBe(true);
    expect(ir.checks).toContainEqual({ kind: "greater_than", value: 0, inclusive: true });
  });

  it("falls back for number with non-compilable refine", () => {
    const captured = "external";
    const schema = z.number().refine((v) => String(v) === captured);
    const refs: { schema: unknown; accessPath: string }[] = [];
    const ir = extractSchema(schema, refs);
    expect(ir.type).toBe("fallback");
    expect((ir as FallbackIR).reason).toBe("refine");
  });

  it("number_format path with coerce via direct call", () => {
    const ir = extractNumber(
      { check: "number_format", format: "int32", coerce: true } as never,
      { fallback: () => ({ type: "fallback" }) } as never,
    ) as NumberIR;
    expect(ir.type).toBe("number");
    expect(ir.coerce).toBe(true);
    expect(ir.checks).toContainEqual({ kind: "number_format", format: "int32" });
  });

  it("returns empty checks when def.checks is undefined", () => {
    const ir = extractNumber(
      { checks: undefined } as never,
      { fallback: () => ({ type: "fallback" }) } as never,
    ) as NumberIR;
    expect(ir).toEqual({ type: "number", checks: [] });
  });

  it("returns empty checks when def.checks is empty array", () => {
    const ir = extractNumber(
      { checks: [] } as never,
      { fallback: () => ({ type: "fallback" }) } as never,
    ) as NumberIR;
    expect(ir).toEqual({ type: "number", checks: [] });
  });
});
