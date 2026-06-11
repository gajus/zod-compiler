import { describe, expect, it } from "vitest";
import { z } from "zod";
import { extractSchema } from "#src/core/extract/index.js";
import type { FallbackIR, TemplateLiteralIR } from "#src/core/types.js";

describe("extractSchema — templateLiteral", () => {
  it("extracts simple template literal pattern", () => {
    const schema = z.templateLiteral([z.literal("user-"), z.number().int()]);
    const ir = extractSchema(schema) as TemplateLiteralIR;
    expect(ir.type).toBe("templateLiteral");
    expect(ir.pattern).toBeDefined();
    expect(typeof ir.pattern).toBe("string");
  });

  it("pattern matches expected strings", () => {
    const schema = z.templateLiteral([z.literal("user-"), z.number().int()]);
    const ir = extractSchema(schema) as TemplateLiteralIR;
    const regex = new RegExp(ir.pattern);
    expect(regex.test("user-42")).toBe(true);
    expect(regex.test("user-0")).toBe(true);
    expect(regex.test("admin-42")).toBe(false);
    expect(regex.test("user-")).toBe(false);
  });

  it("extracts template literal with multiple parts", () => {
    const schema = z.templateLiteral([z.string(), z.literal("-v"), z.number().int()]);
    const ir = extractSchema(schema) as TemplateLiteralIR;
    expect(ir.type).toBe("templateLiteral");
    const regex = new RegExp(ir.pattern);
    expect(regex.test("hello-v1")).toBe(true);
    expect(regex.test("x-v42")).toBe(true);
  });

  it("extracts template literal with only literals", () => {
    const schema = z.templateLiteral([z.literal("hello"), z.literal(" "), z.literal("world")]);
    const ir = extractSchema(schema) as TemplateLiteralIR;
    expect(ir.type).toBe("templateLiteral");
    const regex = new RegExp(ir.pattern);
    expect(regex.test("hello world")).toBe(true);
    expect(regex.test("hello  world")).toBe(false);
  });

  it("falls back when pattern is falsy", () => {
    const schema = z.templateLiteral([z.literal("hello")]);
    // Simulate missing pattern
    (schema._zod as unknown as Record<string, unknown>).pattern = undefined;
    const ir = extractSchema(schema);
    expect(ir.type).toBe("fallback");
    expect((ir as FallbackIR).reason).toBe("unsupported");
  });
});
