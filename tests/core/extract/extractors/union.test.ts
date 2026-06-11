import { describe, expect, it } from "vitest";
import { z } from "zod";
import { extractUnion } from "#src/core/extract/extractors/union.js";
import { extractSchema } from "#src/core/extract/index.js";
import type { DiscriminatedUnionIR, UnionIR } from "#src/core/types.js";

describe("extractSchema — union", () => {
  it("extracts a string | number union", () => {
    const ir = extractSchema(z.union([z.string(), z.number()])) as UnionIR;
    expect(ir.type).toBe("union");
    expect(ir.options).toHaveLength(2);
    expect(ir.options[0]?.type).toBe("string");
    expect(ir.options[1]?.type).toBe("number");
  });

  it("extracts a union with multiple types", () => {
    const ir = extractSchema(z.union([z.string(), z.number(), z.boolean()])) as UnionIR;
    expect(ir.options).toHaveLength(3);
    expect(ir.options.map((o) => o.type)).toEqual(["string", "number", "boolean"]);
  });

  it("extracts a union containing object schemas", () => {
    const ir = extractSchema(
      z.union([
        z.object({ type: z.literal("a"), value: z.string() }),
        z.object({ type: z.literal("b"), value: z.number() }),
      ]),
    ) as UnionIR;
    expect(ir.options).toHaveLength(2);
    expect(ir.options[0]?.type).toBe("object");
    expect(ir.options[1]?.type).toBe("object");
  });
});

describe("extractSchema — discriminatedUnion", () => {
  it("extracts discriminatedUnion with mapping", () => {
    const ir = extractSchema(
      z.discriminatedUnion("type", [
        z.object({ type: z.literal("a"), value: z.string() }),
        z.object({ type: z.literal("b"), count: z.number() }),
      ]),
    ) as DiscriminatedUnionIR;
    expect(ir.type).toBe("discriminatedUnion");
    expect(ir.discriminator).toBe("type");
    expect(ir.options).toHaveLength(2);
    expect(ir.cases).toEqual([
      { value: "a", option: 0 },
      { value: "b", option: 1 },
    ]);
  });

  it("extracts discriminatedUnion with 3 options", () => {
    const ir = extractSchema(
      z.discriminatedUnion("kind", [
        z.object({ kind: z.literal("circle"), radius: z.number() }),
        z.object({ kind: z.literal("square"), size: z.number() }),
        z.object({ kind: z.literal("rect"), w: z.number(), h: z.number() }),
      ]),
    ) as DiscriminatedUnionIR;
    expect(ir.discriminator).toBe("kind");
    expect(ir.options).toHaveLength(3);
    expect(ir.cases).toEqual([
      { value: "circle", option: 0 },
      { value: "square", option: 1 },
      { value: "rect", option: 2 },
    ]);
  });

  // M4: All options with literal discriminators should have complete mapping
  it("mapping covers all literal discriminator values", () => {
    const ir = extractSchema(
      z.discriminatedUnion("type", [
        z.object({ type: z.literal("a"), value: z.string() }),
        z.object({ type: z.literal("b"), count: z.number() }),
      ]),
    ) as DiscriminatedUnionIR;
    // Every option index should appear in the dispatch cases
    const mappedIndices = new Set(ir.cases.map((c) => c.option));
    for (let i = 0; i < ir.options.length; i++) {
      expect(mappedIndices.has(i)).toBe(true);
    }
  });

  it("enum discriminators map every value to their option", () => {
    // Previously only literal discriminators were mapped, leaving enum
    // options unreachable in the compiled switch (rejecting valid input).
    const ir = extractSchema(
      z.discriminatedUnion("type", [
        z.object({ type: z.enum(["a", "c"]), value: z.string() }),
        z.object({ type: z.literal("b"), count: z.number() }),
      ]),
    ) as DiscriminatedUnionIR;
    expect(ir.type).toBe("discriminatedUnion");
    expect(ir.options).toHaveLength(2);
    expect(ir.cases).toEqual([
      { value: "a", option: 0 },
      { value: "c", option: 0 },
      { value: "b", option: 1 },
    ]);
  });

  it("falls back when an option has no resolvable discriminator values", () => {
    // An option without propValues would be unreachable in the compiled
    // switch (its valid inputs rejected) — the whole DU must delegate to Zod.
    const ir = extractUnion(
      {
        discriminator: "type",
        options: [
          { _zod: { def: { type: "string" } } },
          {
            _zod: {
              def: { type: "object", shape: {} },
              propValues: { type: new Set(["b"]) },
            },
          },
        ],
      } as never,
      {
        schema: {},
        path: "test",
        refs: undefined,
        visiting: new Set(),
        visit: (() => ({ type: "object" as const, properties: {} })) as never,
        fallback: (reason: string) => ({ type: "fallback", reason }),
      } as never,
    );
    expect(ir.type).toBe("fallback");
  });
});
