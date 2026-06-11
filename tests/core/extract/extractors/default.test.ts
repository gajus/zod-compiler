import { describe, expect, it } from "vitest";
import { z } from "zod";
import { extractSchema } from "#src/core/extract/index.js";
import type { RefEntry } from "#src/core/extract/types.js";
import type { DefaultIR, FallbackIR } from "#src/core/types.js";

describe("extractSchema — default (no fallback tracking)", () => {
  it("always falls back without fallback tracking", () => {
    const ir = extractSchema(z.string().default("hello"));
    expect(ir.type).toBe("fallback");
    expect((ir as FallbackIR).reason).toBe("unsupported");
  });
});

describe("extractSchema — default (with fallback tracking)", () => {
  it("uses runtime reference for static default", () => {
    const refs: RefEntry[] = [];
    const ir = extractSchema(z.string().default("hello"), refs) as DefaultIR;
    expect(ir.type).toBe("default");
    expect(ir.refIndex).toBe(0);
    expect(refs).toHaveLength(1);
  });

  it("uses runtime reference for factory default", () => {
    const refs: RefEntry[] = [];
    const ir = extractSchema(
      z.string().default(() => "dynamic"),
      refs,
    ) as DefaultIR;
    expect(ir.type).toBe("default");
    expect(ir.refIndex).toBe(0);
    expect(refs).toHaveLength(1);
  });

  it("uses runtime reference for Date factory default (not a fallback)", () => {
    const refs: RefEntry[] = [];
    const ir = extractSchema(
      z.date().default(() => new Date()),
      refs,
    ) as DefaultIR;
    expect(ir.type).toBe("default");
    expect(ir.refIndex).toBe(0);
    expect(refs).toHaveLength(1);
  });

  it("uses runtime reference for dynamic object factory default", () => {
    let counter = 0;
    const refs: RefEntry[] = [];
    const ir = extractSchema(
      z.object({ id: z.number() }).default(() => ({ id: counter++ })),
      refs,
    ) as DefaultIR;
    expect(ir.type).toBe("default");
    expect(ir.refIndex).toBe(0);
    expect(refs).toHaveLength(1);
  });

  it("assigns incrementing fallback indices", () => {
    const refs: RefEntry[] = [];
    const schema = z.object({
      a: z.string().default("x"),
      b: z.number().default(() => Date.now()),
    });
    const ir = extractSchema(schema, refs);
    expect(ir.type).toBe("object");
    expect(refs.length).toBeGreaterThanOrEqual(2);
  });
});
