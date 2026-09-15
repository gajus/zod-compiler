/**
 * Context-free z.preprocess callbacks belong on the single-pass build path:
 * transform the raw value first, then validate/build the callback output.
 */
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import { generateValidator } from "#src/core/codegen/index.js";
import { extractSchema, type RefEntry } from "#src/core/extract/index.js";
import type { PreprocessEffectIR } from "#src/core/types.js";
import { expectParity } from "./parity-harness.js";

function extractWithRefs(schema: unknown) {
  const refs: RefEntry[] = [];
  return { ir: extractSchema(schema, refs), refs };
}

describe("preprocess extraction and build path", () => {
  it("inlines a zero-capture preprocessor", () => {
    const { ir, refs } = extractWithRefs(z.preprocess((value) => Number(value), z.number().int()));
    expect(ir).toMatchObject({ type: "effect", effectKind: "preprocess" });
    expect((ir as PreprocessEffectIR).source).toContain("Number");
    expect(refs).toHaveLength(0);
  });

  it("calls a capturing preprocessor through its retained function reference", () => {
    const multiplier = 3;
    const { ir, refs } = extractWithRefs(
      z.preprocess((value) => Number(value) * multiplier, z.number()),
    );
    expect(ir).toMatchObject({ type: "effect", effectKind: "preprocess", refIndex: 0 });
    expect(refs.map((ref) => ref.accessPath)).toEqual(["._zod.def.in._zod.def.transform"]);
  });

  it("emits the single-pass builder", () => {
    const { ir, refs } = extractWithRefs(
      z.object({ page: z.preprocess((value) => Number(value), z.number().int().positive()) }),
    );
    const generated = generateValidator(ir, "preprocess", { refCount: refs.length });
    expect(generated.functionDef).toMatch(/=__vb_\d+\(input\)/);
    expect(generated.functionDef).toContain("__zcFinD");
  });

  it("delegates callbacks that can observe Zod's parse context", () => {
    const callbackWithDefaultContext = (value: unknown, ctx: unknown = null) =>
      ctx ? value : "missing";
    const cases = [
      z.preprocess((value, ctx) => {
        if (value === "bad") ctx.addIssue({ code: "custom", message: "bad" });
        return value;
      }, z.string()),
      z.preprocess(callbackWithDefaultContext, z.string()),
      z.preprocess((value, ...context) => (context.length ? value : "missing"), z.string()),
    ];
    for (const schema of cases) {
      const { ir } = extractWithRefs(schema);
      expect(ir.type).toBe("pipe");
      expect(ir.type === "pipe" && ir.in.type).toBe("fallback");
    }
  });
});

describe("preprocess parity", () => {
  it("matches scalar conversion, output checks, and issue messages", () => {
    expectParity(
      z.preprocess(
        (value) => Number(value),
        z.number({ error: "number required" }).int().positive(),
      ),
      ["42", 3, "0", "nope", null, undefined],
    );
  });

  it("builds a realistic nested query object", () => {
    const radix = 10;
    const schema = z.object({
      filters: z.object({
        active: z.preprocess((value) => value === "true", z.boolean()),
        tags: z.preprocess(
          (value) => (typeof value === "string" ? value.split(",") : value),
          z.array(z.string().min(1)),
        ),
      }),
      page: z.preprocess((value) => parseInt(String(value), radix), z.number().int().positive()),
      q: z.preprocess((value) => String(value).trim(), z.string().min(1)),
    });
    expectParity(schema, [
      { filters: { active: "true", tags: "a,b" }, page: "2", q: " hello ", extra: 1 },
      { filters: { active: "false", tags: "" }, page: "bad", q: " " },
      { filters: null, page: "2", q: "ok" },
      null,
    ]);
  });

  it("preserves defaults, optionals, and post-preprocess transforms", () => {
    const schema = z.object({
      count: z.preprocess(
        (value) => (value === "" ? undefined : Number(value)),
        z.number().default(10),
      ),
      label: z.preprocess(
        (value) => String(value),
        z.string().transform((value) => value.toUpperCase()),
      ),
      note: z.preprocess((value) => value, z.string().optional()),
    });
    expectParity(schema, [
      { count: "", label: "hello" },
      { count: "3", label: 42, note: "x" },
      { count: "bad", label: "ok", note: 1 },
    ]);
  });

  it("writes the preprocessed value through when another field disables the build path", () => {
    const schema = z.object({
      amount: z.preprocess((value) => Number(value), z.number().positive()),
      recovered: z.number().catch(0),
    });
    expectParity(schema, [
      { amount: "12", recovered: "bad" },
      { amount: "bad", recovered: "bad" },
    ]);
  });

  it("checks a rewriting inner schema against the value it rewrote", () => {
    // The inner reads back what it wrote — `.min(1)` after `.trim()`, `.min(5)`
    // after a coercion — so it has to read and write the preprocessed value
    // through one expression. Handed two, the checks saw the value from before
    // the rewrite: beside a field that keeps the walk eager, `"  "` passed.
    const schema = z.object({
      name: z.preprocess((value) => value, z.string().trim().min(1)),
      size: z.preprocess((value) => value, z.coerce.number().min(5)),
      recovered: z.number().catch(0),
    });
    expectParity(schema, [
      { name: "  ", size: "7", recovered: 1 },
      { name: " a ", size: "3", recovered: 1 },
      { name: " a ", size: "7", recovered: "bad" },
    ]);
    // At the root the build pass settles valid input, and an invalid one reaches
    // the walk behind `.error` — which reported no issue at all.
    expectParity(
      z.preprocess((value) => value, z.string().trim().min(1)),
      ["  ", " a ", 1],
    );
    expectParity(
      z.preprocess((value) => value, z.coerce.number().min(5)),
      ["3", "7", "x"],
    );
  });

  it("retains Zod for context-aware callbacks", () => {
    const schema = z.preprocess((value, ctx) => {
      if (value === "blocked") ctx.addIssue({ code: "custom", message: "blocked" });
      return String(value);
    }, z.string().min(2));
    expectParity(schema, ["okay", "x", "blocked", 42]);
  });

  it("retains Zod for async callbacks", () => {
    const schema = z.preprocess(async (value) => String(value), z.string());
    expectParity(schema, ["okay", 42]);
  });
});
