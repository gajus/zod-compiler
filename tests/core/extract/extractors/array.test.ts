import { describe, expect, it } from "vitest";
import { z } from "zod";
import { extractSchema } from "#src/core/extract/index.js";
import type { ArrayIR } from "#src/core/types.js";

describe("extractArray", () => {
  it("extracts array with element type", () => {
    const ir = extractSchema(z.array(z.number())) as ArrayIR;
    expect(ir.type).toBe("array");
    expect(ir.element.type).toBe("number");
    expect(ir.checks).toEqual([]);
  });

  it("extracts array with min/max checks", () => {
    const ir = extractSchema(z.array(z.string()).min(1).max(10)) as ArrayIR;
    expect(ir.checks).toContainEqual({ kind: "min_length", minimum: 1 });
    expect(ir.checks).toContainEqual({ kind: "max_length", maximum: 10 });
  });

  it("extracts array with nested object element", () => {
    const ir = extractSchema(z.array(z.object({ id: z.number() }))) as ArrayIR;
    expect(ir.element.type).toBe("object");
  });
});
