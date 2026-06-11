import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { RefEntry } from "#src/core/extract/index.js";
import { extractSchema } from "#src/core/extract/index.js";
import type { CatchIR, FallbackIR, ObjectIR } from "#src/core/types.js";

/**
 * Catch values are evaluated at RUNTIME through the __rf table (they may be
 * ctx-reading functions or impure factories), so extraction stores a refIndex
 * pointing at the original z.catch() schema instead of a baked value.
 */
describe("extractSchema — catch", () => {
  function extractWithRefs(schema: unknown): {
    ir: ReturnType<typeof extractSchema>;
    refs: RefEntry[];
  } {
    const refs: RefEntry[] = [];
    return { ir: extractSchema(schema, refs), refs };
  }

  it("extracts catch with a runtime ref to the schema", () => {
    const schema = z.string().catch("default");
    const { ir, refs } = extractWithRefs(schema);
    expect(ir.type).toBe("catch");
    const catchIR = ir as CatchIR;
    expect(catchIR.inner.type).toBe("string");
    expect(catchIR.refIndex).toBe(0);
    expect(refs).toHaveLength(1);
    expect(refs[0]?.schema).toBe(schema);
  });

  it("extracts number/boolean/object catch schemas the same way", () => {
    for (const schema of [
      z.number().catch(0),
      z.boolean().catch(false),
      z.object({ name: z.string() }).catch({ name: "anon" }),
    ]) {
      const { ir, refs } = extractWithRefs(schema);
      expect(ir.type).toBe("catch");
      expect((ir as CatchIR).refIndex).toBe(0);
      expect(refs).toHaveLength(1);
    }
  });

  it("compiles Date and function catch values (runtime-evaluated)", () => {
    // Previously forced fallback under build-time value baking.
    const dateCatch = extractWithRefs(z.date().catch(new Date("2024-01-01")));
    expect(dateCatch.ir.type).toBe("catch");
    const fnCatch = extractWithRefs(z.number().catch((ctx) => ctx.issues.length));
    expect(fnCatch.ir.type).toBe("catch");
  });

  it("compiles catch wrapping zero-capture transform (EffectIR inner)", () => {
    const schema = z
      .string()
      .transform((s) => s.toUpperCase())
      .catch("DEFAULT");
    const { ir } = extractWithRefs(schema);
    expect(ir.type).toBe("catch");
    expect((ir as CatchIR).inner.type).toBe("effect");
  });

  it("falls back when inner type has captured-variable transform", () => {
    const external = "prefix_";
    const schema = z
      .string()
      .transform((s) => external + s)
      .catch("DEFAULT");
    const { ir } = extractWithRefs(schema);
    expect(ir.type).toBe("fallback");
    expect((ir as FallbackIR).reason).toBe("unsupported");
  });

  it("extracts nested catch in object with sequential refIndexes", () => {
    const schema = z.object({
      name: z.string().catch("anonymous"),
      age: z.number().catch(0),
    });
    const { ir, refs } = extractWithRefs(schema);
    expect(ir.type).toBe("object");
    const objIR = ir as ObjectIR;
    expect((objIR.properties["name"] as CatchIR).refIndex).toBe(0);
    expect((objIR.properties["age"] as CatchIR).refIndex).toBe(1);
    expect(refs).toHaveLength(2);
  });

  it("falls back without ref tracking (catchValue unreachable at runtime)", () => {
    const ir = extractSchema(z.string().catch("default"));
    expect(ir.type).toBe("fallback");
    expect((ir as FallbackIR).reason).toBe("unsupported");
  });
});
