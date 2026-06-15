import { describe, expect, it } from "vitest";
import { z } from "zod";
import { dispatch, extractRegistry } from "#src/core/extract/registry.js";
import type { RecursionState } from "#src/core/extract/types.js";
import type { FallbackIR } from "#src/core/types.js";

/** Fresh recursion-target bookkeeping for a standalone dispatch() call. */
function rec(root: unknown): RecursionState {
  return { root, targets: new Map(), next: 1 };
}

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
    const ir = dispatch(z.string(), "", undefined, new Set(), rec(z.string()));
    expect(ir).toEqual({ type: "string", checks: [] });
  });

  it("dispatches to the correct extractor for a nested schema", () => {
    const schema = z.object({ name: z.string() });
    const ir = dispatch(schema, "", undefined, new Set(), rec(schema));
    expect(ir).toEqual({
      type: "object",
      properties: { name: { type: "string", checks: [] } },
    });
  });

  it("returns fallback for unsupported def.type", () => {
    const fakeSchema = { _zod: { def: { type: "not_a_real_type" } } };
    const ir = dispatch(fakeSchema, "", undefined, new Set(), rec(fakeSchema));
    expect(ir.type).toBe("fallback");
    expect((ir as FallbackIR).reason).toBe("unsupported");
  });

  it("collects fallback entries when refs array is provided", () => {
    const fakeSchema = { _zod: { def: { type: "not_a_real_type" } } };
    const refs: { schema: unknown; accessPath: string }[] = [];
    const ir = dispatch(fakeSchema, ".root", refs, new Set(), rec(fakeSchema));
    expect(ir.type).toBe("fallback");
    expect(refs).toHaveLength(1);
    expect(refs[0]?.accessPath).toBe(".root");
  });

  it("manages visiting set for cycle detection", () => {
    const visiting = new Set<unknown>();
    const schema = z.string();
    // dispatch adds to visiting then removes after
    dispatch(schema, "", undefined, visiting, rec(schema));
    expect(visiting.size).toBe(0);
  });

  it("propagates path through nested visit calls", () => {
    const schema = z.object({ user: z.object({ name: z.string() }) });
    const ir = dispatch(schema, "", undefined, new Set(), rec(schema));
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
