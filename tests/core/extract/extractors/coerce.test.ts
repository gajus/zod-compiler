import { describe, expect, it } from "vitest";
import { z } from "zod";
import { extractSchema } from "#src/core/extract/index.js";
import type { BigIntIR, BooleanIR, DateIR, NumberIR, StringIR } from "#src/core/types.js";

describe("extractSchema — coerce", () => {
  it("extracts coerce flag for z.coerce.string()", () => {
    const ir = extractSchema(z.coerce.string()) as StringIR;
    expect(ir.type).toBe("string");
    expect(ir.coerce).toBe(true);
    expect(ir.checks).toEqual([]);
  });

  it("extracts coerce flag for z.coerce.number()", () => {
    const ir = extractSchema(z.coerce.number()) as NumberIR;
    expect(ir.type).toBe("number");
    expect(ir.coerce).toBe(true);
    expect(ir.checks).toEqual([]);
  });

  it("extracts coerce flag for z.coerce.boolean()", () => {
    const ir = extractSchema(z.coerce.boolean()) as BooleanIR;
    expect(ir.type).toBe("boolean");
    expect(ir.coerce).toBe(true);
  });

  it("extracts coerce flag for z.coerce.bigint()", () => {
    const ir = extractSchema(z.coerce.bigint()) as BigIntIR;
    expect(ir.type).toBe("bigint");
    expect(ir.coerce).toBe(true);
  });

  it("extracts coerce flag for z.coerce.date()", () => {
    const ir = extractSchema(z.coerce.date()) as DateIR;
    expect(ir.type).toBe("date");
    expect(ir.coerce).toBe(true);
  });

  it("non-coerce string has no coerce flag", () => {
    const ir = extractSchema(z.string()) as StringIR;
    expect(ir.type).toBe("string");
    expect(ir.coerce).toBeUndefined();
  });

  it("non-coerce number has no coerce flag", () => {
    const ir = extractSchema(z.number()) as NumberIR;
    expect(ir.type).toBe("number");
    expect(ir.coerce).toBeUndefined();
  });

  it("coerce with checks preserves both", () => {
    const ir = extractSchema(z.coerce.number().int().positive()) as NumberIR;
    expect(ir.type).toBe("number");
    expect(ir.coerce).toBe(true);
    expect(ir.checks.length).toBeGreaterThanOrEqual(2);
    expect(ir.checks).toContainEqual({ kind: "number_format", format: "safeint" });
    expect(ir.checks).toContainEqual({ kind: "greater_than", value: 0, inclusive: false });
  });

  it("coerce with string checks preserves both", () => {
    const ir = extractSchema(z.coerce.string().min(3).max(50)) as StringIR;
    expect(ir.type).toBe("string");
    expect(ir.coerce).toBe(true);
    expect(ir.checks).toContainEqual({ kind: "min_length", minimum: 3 });
    expect(ir.checks).toContainEqual({ kind: "max_length", maximum: 50 });
  });

  it("coerce with int32 format preserves coerce", () => {
    const ir = extractSchema(z.coerce.number()) as NumberIR;
    expect(ir.coerce).toBe(true);
  });
});
