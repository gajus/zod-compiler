import { describe, expect, it } from "vitest";
import { z } from "zod";
import { extractRegistry } from "#src/core/extract/registry.js";

/**
 * Runtime probe test: verifies that extractRegistry covers all Zod v4 def.type
 * values and contains no stale entries. Catches Zod version drift in CI.
 */
describe("extractRegistry — Zod def.type coverage", () => {
  // Instantiate every z.* factory to collect all def.type values Zod produces
  const zodFactories = [
    z.string(),
    z.number(),
    z.boolean(),
    z.bigint(),
    z.date(),
    z.symbol(),
    z.null(),
    z.undefined(),
    z.any(),
    z.unknown(),
    z.void(),
    z.nan(),
    z.never(),
    z.literal("x"),
    z.enum(["a"]),
    z.object({}),
    z.array(z.string()),
    z.tuple([z.string()]),
    z.record(z.string(), z.string()),
    z.set(z.string()),
    z.map(z.string(), z.string()),
    z.union([z.string(), z.number()]),
    z.intersection(z.string(), z.string()),
    z.optional(z.string()),
    z.nullable(z.string()),
    z.readonly(z.string()),
    z.string().default(""),
    z.string().pipe(z.string()),
    z.lazy(() => z.string()),
    z.string().catch(""),
    z.templateLiteral([z.literal("hello")]),
    z.file(),
  ];

  const zodDefTypes = new Set(
    zodFactories.map((s) => (s as { _zod: { def: { type: string } } })._zod.def.type),
  );
  const registeredTypes = new Set(Object.keys(extractRegistry));

  it("every Zod def.type has an extractor in the registry", () => {
    const missing = [...zodDefTypes].filter((t) => !registeredTypes.has(t));
    expect(missing).toEqual([]);
  });

  it("every registry key corresponds to a Zod def.type", () => {
    const stale = [...registeredTypes].filter((t) => !zodDefTypes.has(t));
    expect(stale).toEqual([]);
  });
});
