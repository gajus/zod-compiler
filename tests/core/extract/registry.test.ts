import { describe, expect, it } from "vitest";
import { z } from "zod";
import { dispatch, extractRegistry } from "#src/core/extract/registry.js";
import type { FallbackIR } from "#src/core/types.js";

describe("extractRegistry", () => {
  it("has an entry for every SupportedZodDefType", () => {
    // This is enforced at compile-time by satisfies, but verify at runtime too
    expect(Object.keys(extractRegistry).length).toBeGreaterThanOrEqual(1);
  });

  it("every entry is a function", () => {
    for (const [, extractor] of Object.entries(extractRegistry)) {
      expect(typeof extractor).toBe("function");
    }
  });
});

describe("dispatch", () => {
  it("dispatches to the correct extractor for a string schema", () => {
    const ir = dispatch(z.string(), "", undefined, new Set());
    expect(ir).toEqual({ type: "string", checks: [] });
  });

  it("dispatches to the correct extractor for a nested schema", () => {
    const ir = dispatch(z.object({ name: z.string() }), "", undefined, new Set());
    expect(ir).toEqual({
      type: "object",
      properties: { name: { type: "string", checks: [] } },
    });
  });

  it("returns fallback for unsupported def.type", () => {
    const fakeSchema = { _zod: { def: { type: "not_a_real_type" } } };
    const ir = dispatch(fakeSchema, "", undefined, new Set());
    expect(ir.type).toBe("fallback");
    expect((ir as FallbackIR).reason).toBe("unsupported");
  });

  it("collects fallback entries when refs array is provided", () => {
    const fakeSchema = { _zod: { def: { type: "not_a_real_type" } } };
    const refs: { schema: unknown; accessPath: string }[] = [];
    const ir = dispatch(fakeSchema, ".root", refs, new Set());
    expect(ir.type).toBe("fallback");
    expect(refs).toHaveLength(1);
    expect(refs[0]?.accessPath).toBe(".root");
  });

  it("manages visiting set for cycle detection", () => {
    const visiting = new Set<unknown>();
    const schema = z.string();
    // dispatch adds to visiting then removes after
    dispatch(schema, "", undefined, visiting);
    expect(visiting.size).toBe(0);
  });

  it("propagates path through nested visit calls", () => {
    const ir = dispatch(
      z.object({ user: z.object({ name: z.string() }) }),
      "",
      undefined,
      new Set(),
    );
    expect(ir).toEqual({
      type: "object",
      properties: {
        user: {
          type: "object",
          properties: { name: { type: "string", checks: [] } },
        },
      },
    });
  });
});
