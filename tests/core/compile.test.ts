import { describe, expect, it } from "vitest";
import { z } from "zod";
import { compile, isCompiledSchema } from "#src/core/compile.js";

describe("compile()", () => {
  it("returns a CompiledSchema with parse/safeParse", () => {
    const schema = z.string();
    const compiled = compile(schema);

    expect(compiled.parse).toBeTypeOf("function");
    expect(compiled.safeParse).toBeTypeOf("function");
  });

  it("retains internal schema reference for CLI emitter discovery", () => {
    const schema = z.string();
    const compiled = compile(schema);

    expect((compiled as unknown as { schema: unknown }).schema).toBe(schema);
  });

  it("preserves Zod properties on the compiled schema", () => {
    const schema = z.object({ name: z.string() });
    const compiled = compile(schema);

    expect("_zod" in compiled).toBe(true);
    expect(compiled.shape).toBe(schema.shape);
  });

  it("supports safeParseAsync via Zod prototype", async () => {
    const schema = z.object({ name: z.string() });
    const compiled = compile(schema);

    const result = await compiled.safeParseAsync({ name: "Alice" });
    expect(result).toHaveProperty("success", true);
  });

  it("exposes a dev-time .is() guard delegating to Zod safeParse", () => {
    const compiled = compile(z.object({ name: z.string().min(1) }));

    expect(typeof compiled.is).toBe("function");
    expect(compiled.is({ name: "Alice" })).toBe(true);
    expect(compiled.is({ name: "" })).toBe(false);
    expect(compiled.is(null)).toBe(false);
    // Non-enumerable augmentation: must not surface as a schema key.
    expect(Object.keys(compiled as object)).not.toContain("is");
  });
});

describe("compile() — parse/safeParse validation", () => {
  const schema = z.object({
    name: z.string().min(1),
    age: z.number().int().positive(),
  });

  it("parse succeeds with valid input", () => {
    const compiled = compile(schema);
    const result = compiled.parse({ name: "Alice", age: 30 });
    expect(result).toEqual({ name: "Alice", age: 30 });
  });

  it("parse throws on invalid input", () => {
    const compiled = compile(schema);
    expect(() => compiled.parse({ name: "", age: -1 })).toThrow();
  });

  it("safeParse returns success for valid input", () => {
    const compiled = compile(schema);
    const result = compiled.safeParse({ name: "Alice", age: 30 });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual({ name: "Alice", age: 30 });
    }
  });

  it("safeParse returns error for invalid input", () => {
    const compiled = compile(schema);
    const result = compiled.safeParse({ name: "", age: -1 });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.length).toBeGreaterThan(0);
    }
  });
});

describe("compile() — non-AOT-compilable schemas", () => {
  it("works with transform schema (falls back to Zod at runtime)", () => {
    const compiled = compile(z.string().transform((v) => v.toUpperCase()));
    expect(compiled.parse("hello")).toBe("HELLO");
  });

  it("works with refine schema (falls back to Zod at runtime)", () => {
    const compiled = compile(
      z.string().refine((v) => v.startsWith("a"), { message: "Must start with a" }),
    );
    expect(compiled.parse("abc")).toBe("abc");
    expect(() => compiled.parse("xyz")).toThrow();
  });
});

describe("compile() — instanceof compatibility", () => {
  it("instanceof checks pass", () => {
    const compiled = compile(z.object({ name: z.string() }));
    expect(compiled instanceof z.ZodObject).toBe(true);
  });
});

describe("isCompiledSchema()", () => {
  it("returns true for compile() results", () => {
    const compiled = compile(z.string());
    expect(isCompiledSchema(compiled)).toBe(true);
  });

  it("returns false for plain objects", () => {
    expect(isCompiledSchema({})).toBe(false);
    const noop = () => undefined;
    expect(isCompiledSchema({ parse: noop, safeParse: noop, is: noop })).toBe(false);
  });

  it("returns false for primitives", () => {
    expect(isCompiledSchema(null)).toBe(false);
    expect(isCompiledSchema(undefined)).toBe(false);
    expect(isCompiledSchema(42)).toBe(false);
    expect(isCompiledSchema("string")).toBe(false);
  });
});
