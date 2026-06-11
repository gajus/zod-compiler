import { describe, expect, it } from "vitest";
import { z } from "zod";
import { extractSet } from "#src/core/extract/extractors/set.js";
import { extractSchema } from "#src/core/extract/index.js";
import type { SetIR } from "#src/core/types.js";

describe("extractSchema — set", () => {
  it("extracts plain set with no checks", () => {
    const ir = extractSchema(z.set(z.string())) as SetIR;
    expect(ir.type).toBe("set");
    expect(ir.valueType.type).toBe("string");
    expect(ir.checks).toBeUndefined();
  });

  it("extracts set with number value type", () => {
    const ir = extractSchema(z.set(z.number())) as SetIR;
    expect(ir.type).toBe("set");
    expect(ir.valueType.type).toBe("number");
  });

  it("extracts set with min size check", () => {
    const ir = extractSchema(z.set(z.string()).min(1)) as SetIR;
    expect(ir.type).toBe("set");
    expect(ir.checks).toContainEqual({ kind: "min_size", minimum: 1 });
  });

  it("extracts set with max size check", () => {
    const ir = extractSchema(z.set(z.string()).max(10)) as SetIR;
    expect(ir.type).toBe("set");
    expect(ir.checks).toContainEqual({ kind: "max_size", maximum: 10 });
  });

  it("extracts set with both min and max size checks", () => {
    const ir = extractSchema(z.set(z.number()).min(1).max(100)) as SetIR;
    expect(ir.type).toBe("set");
    expect(ir.checks).toHaveLength(2);
    expect(ir.checks).toContainEqual({ kind: "min_size", minimum: 1 });
    expect(ir.checks).toContainEqual({ kind: "max_size", maximum: 100 });
  });

  it("extracts size_equals check from z.set().size()", () => {
    const ir = extractSchema(z.set(z.string()).size(5)) as SetIR;
    expect(ir.type).toBe("set");
    expect(ir.checks).toEqual([{ kind: "size_equals", size: 5 }]);
  });

  it("falls back on set refine instead of dropping it", () => {
    const ir = extractSchema(z.set(z.string()).refine((s) => s.size > 0));
    expect(ir.type).toBe("fallback");
  });

  it("recursively extracts inner value type", () => {
    const ir = extractSchema(z.set(z.object({ name: z.string() }))) as SetIR;
    expect(ir.type).toBe("set");
    expect(ir.valueType.type).toBe("object");
  });

  it("skips checks without _zod.def", () => {
    const ir = extractSet(
      {
        type: "set",
        checks: [{ _zod: undefined }],
        valueType: {},
      } as never,
      {
        schema: {},
        path: "test",
        refs: undefined,
        visiting: new Set(),
        visit: () => ({ type: "string", checks: [] }),
        fallback: (reason) => ({ type: "fallback", reason }),
      } as never,
    ) as SetIR;
    expect(ir.type).toBe("set");
    expect(ir.checks).toBeUndefined();
  });
});
