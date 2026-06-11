import { describe, expect, it } from "vitest";
import { z } from "zod";
import { extractSchema } from "#src/core/extract/index.js";
import type { TupleIR } from "#src/core/types.js";

describe("extractTuple", () => {
  it("extracts tuple with fixed items", () => {
    const ir = extractSchema(z.tuple([z.string(), z.number()])) as TupleIR;
    expect(ir.type).toBe("tuple");
    expect(ir.items).toHaveLength(2);
    expect(ir.items[0]?.type).toBe("string");
    expect(ir.items[1]?.type).toBe("number");
    expect(ir.rest).toBeNull();
  });

  it("extracts tuple with rest element", () => {
    const ir = extractSchema(z.tuple([z.string()]).rest(z.number())) as TupleIR;
    expect(ir.items).toHaveLength(1);
    expect(ir.rest?.type).toBe("number");
  });
});
