import { describe, expect, it } from "vitest";
import { z } from "zod";
import { extractSchema } from "#src/core/extract/index.js";
import type { MapIR } from "#src/core/types.js";

describe("extractMap", () => {
  it("extracts map with key and value types", () => {
    const ir = extractSchema(z.map(z.string(), z.number())) as MapIR;
    expect(ir.type).toBe("map");
    expect(ir.keyType.type).toBe("string");
    expect(ir.valueType.type).toBe("number");
  });
});
