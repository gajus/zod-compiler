import { describe, expect, it } from "vitest";
import { z } from "zod";
import { extractRecord } from "#src/core/extract/extractors/record.js";
import { extractSchema } from "#src/core/extract/index.js";
import type { FallbackIR, RecordIR } from "#src/core/types.js";

describe("extractRecord", () => {
  it("extracts record with string keys and number values", () => {
    const ir = extractSchema(z.record(z.string(), z.number())) as RecordIR;
    expect(ir.type).toBe("record");
    expect(ir.keyType.type).toBe("string");
    expect(ir.valueType.type).toBe("number");
  });

  it("falls back when valueType is undefined via direct call", () => {
    const ir = extractRecord(
      { type: "record", keyType: {}, valueType: undefined } as never,
      {
        schema: {},
        path: "",
        refs: undefined,
        visiting: new Set(),
        visit: () => ({ type: "string", checks: [] }),
        fallback: (reason: string) => ({ type: "fallback" as const, reason }),
      } as never,
    );
    expect(ir.type).toBe("fallback");
    expect((ir as FallbackIR).reason).toBe("unsupported");
  });
});
