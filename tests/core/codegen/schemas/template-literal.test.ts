import { describe, expect, it } from "vitest";
import type { TemplateLiteralIR } from "#src/core/types.js";
import { compileIR } from "../helpers.js";

describe("slow-path — templateLiteral", () => {
  it("accepts matching string", () => {
    const ir: TemplateLiteralIR = { type: "templateLiteral", pattern: "^user-\\d+$" };
    const safeParse = compileIR(ir);
    expect(safeParse("user-42")).toEqual({ success: true, data: "user-42" });
  });

  it("accepts another matching string", () => {
    const ir: TemplateLiteralIR = { type: "templateLiteral", pattern: "^user-\\d+$" };
    const safeParse = compileIR(ir);
    expect(safeParse("user-0")).toEqual({ success: true, data: "user-0" });
  });

  it("rejects non-matching string", () => {
    const ir: TemplateLiteralIR = { type: "templateLiteral", pattern: "^user-\\d+$" };
    const safeParse = compileIR(ir);
    const result = safeParse("admin-42");
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]).toMatchObject({
      code: "invalid_format",
      format: "template_literal",
    });
  });

  it("rejects non-string input", () => {
    const ir: TemplateLiteralIR = { type: "templateLiteral", pattern: "^user-\\d+$" };
    const safeParse = compileIR(ir);
    const result = safeParse(42);
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]).toMatchObject({
      code: "invalid_type",
      expected: "string",
    });
  });

  it("rejects null", () => {
    const ir: TemplateLiteralIR = { type: "templateLiteral", pattern: "^hello$" };
    const safeParse = compileIR(ir);
    expect(safeParse(null).success).toBe(false);
  });

  it("rejects undefined", () => {
    const ir: TemplateLiteralIR = { type: "templateLiteral", pattern: "^hello$" };
    const safeParse = compileIR(ir);
    expect(safeParse(undefined).success).toBe(false);
  });

  it("handles complex pattern", () => {
    const ir: TemplateLiteralIR = {
      type: "templateLiteral",
      pattern: "^[a-z]+-v\\d+$",
    };
    const safeParse = compileIR(ir);
    expect(safeParse("hello-v1").success).toBe(true);
    expect(safeParse("test-v42").success).toBe(true);
    expect(safeParse("HELLO-v1").success).toBe(false);
    expect(safeParse("hello-v").success).toBe(false);
  });

  it("handles exact match pattern", () => {
    const ir: TemplateLiteralIR = { type: "templateLiteral", pattern: "^hello world$" };
    const safeParse = compileIR(ir);
    expect(safeParse("hello world").success).toBe(true);
    expect(safeParse("hello world!").success).toBe(false);
    expect(safeParse("hello").success).toBe(false);
  });

  it("rejects empty string when pattern requires content", () => {
    const ir: TemplateLiteralIR = { type: "templateLiteral", pattern: "^user-\\d+$" };
    const safeParse = compileIR(ir);
    expect(safeParse("").success).toBe(false);
  });
});
