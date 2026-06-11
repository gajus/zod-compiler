import { describe, expect, it } from "vitest";
import { generateValidator } from "#src/core/codegen/index.js";
import type {
  AnyIR,
  FallbackIR,
  ObjectIR,
  ReadonlyIR,
  StringIR,
  UnknownIR,
} from "#src/core/types.js";
import { compileIR } from "./helpers.js";

describe("codegen — code quality", () => {
  it("returns a valid CodeGenResult", () => {
    const ir: StringIR = { type: "string", checks: [] };
    const result = generateValidator(ir, "myValidator");
    expect(result).toHaveProperty("code");
    expect(result).toHaveProperty("functionDef");
    expect(typeof result.code).toBe("string");
    expect(typeof result.functionDef).toBe("string");
    expect(result.code.length).toBeGreaterThan(0);
    expect(result.functionDef).toContain("myValidator");
  });

  it("generates unique function names", () => {
    const ir: StringIR = { type: "string", checks: [] };
    const result1 = generateValidator(ir, "schemaA");
    const result2 = generateValidator(ir, "schemaB");
    expect(result1.functionDef).not.toBe(result2.functionDef);
  });

  it("generates syntactically valid JavaScript", () => {
    const ir: ObjectIR = {
      type: "object",
      properties: {
        name: { type: "string", checks: [{ kind: "min_length", minimum: 1 }] },
        items: {
          type: "array",
          element: { type: "number", checks: [] },
          checks: [{ kind: "max_length", maximum: 100 }],
        },
        status: { type: "enum", values: ["active", "inactive"] },
      },
    };
    const result = generateValidator(ir, "complexSchema");
    expect(() => new Function(result.code)).not.toThrow();
  });
});

describe("codegen — complex schemas", () => {
  it("generates validator for user registration schema", () => {
    const ir: ObjectIR = {
      type: "object",
      properties: {
        username: {
          type: "string",
          checks: [
            { kind: "min_length", minimum: 3 },
            { kind: "max_length", maximum: 20 },
            { kind: "string_format", format: "regex", pattern: "^[a-zA-Z0-9_]+$" },
          ],
        },
        email: {
          type: "string",
          checks: [{ kind: "string_format", format: "email" }],
        },
        age: {
          type: "number",
          checks: [
            { kind: "number_format", format: "safeint" },
            { kind: "greater_than", value: 0, inclusive: false },
            { kind: "less_than", value: 150, inclusive: true },
          ],
        },
        role: { type: "enum", values: ["admin", "user"] },
        bio: {
          type: "optional",
          inner: { type: "string", checks: [{ kind: "max_length", maximum: 500 }] },
        },
        tags: {
          type: "array",
          element: { type: "string", checks: [{ kind: "min_length", minimum: 1 }] },
          checks: [{ kind: "max_length", maximum: 10 }],
        },
      },
    };

    const safeParse = compileIR(ir);

    // Valid input
    expect(
      safeParse({
        username: "alice_123",
        email: "alice@example.com",
        age: 25,
        role: "user",
        tags: ["developer"],
      }).success,
    ).toBe(true);

    // Valid with optional bio
    expect(
      safeParse({
        username: "bob",
        email: "bob@test.com",
        age: 30,
        role: "admin",
        bio: "Hello world",
        tags: [],
      }).success,
    ).toBe(true);

    // Invalid: username too short
    expect(
      safeParse({
        username: "ab",
        email: "valid@test.com",
        age: 25,
        role: "user",
        tags: [],
      }).success,
    ).toBe(false);

    // Invalid: bad email
    expect(
      safeParse({
        username: "alice",
        email: "not-email",
        age: 25,
        role: "user",
        tags: [],
      }).success,
    ).toBe(false);

    // Invalid: age is float
    expect(
      safeParse({
        username: "alice",
        email: "alice@test.com",
        age: 25.5,
        role: "user",
        tags: [],
      }).success,
    ).toBe(false);

    // Invalid: bad role
    expect(
      safeParse({
        username: "alice",
        email: "alice@test.com",
        age: 25,
        role: "superadmin",
        tags: [],
      }).success,
    ).toBe(false);
  });
});

describe("codegen — any", () => {
  it("accepts all values", () => {
    const ir: AnyIR = { type: "any" };
    const safeParse = compileIR(ir);
    expect(safeParse("hello").success).toBe(true);
    expect(safeParse(42).success).toBe(true);
    expect(safeParse(null).success).toBe(true);
    expect(safeParse(undefined).success).toBe(true);
    expect(safeParse({}).success).toBe(true);
    expect(safeParse([]).success).toBe(true);
  });
});

describe("codegen — unknown", () => {
  it("accepts all values", () => {
    const ir: UnknownIR = { type: "unknown" };
    const safeParse = compileIR(ir);
    expect(safeParse("hello").success).toBe(true);
    expect(safeParse(42).success).toBe(true);
    expect(safeParse(null).success).toBe(true);
    expect(safeParse(undefined).success).toBe(true);
    expect(safeParse({}).success).toBe(true);
  });
});

describe("codegen — readonly", () => {
  it("validates inner type", () => {
    const ir: ReadonlyIR = { type: "readonly", inner: { type: "string", checks: [] } };
    const safeParse = compileIR(ir);
    expect(safeParse("hello").success).toBe(true);
    expect(safeParse(42).success).toBe(false);
  });

  it("validates inner object", () => {
    const ir: ReadonlyIR = {
      type: "readonly",
      inner: { type: "object", properties: { x: { type: "number", checks: [] } } },
    };
    const safeParse = compileIR(ir);
    expect(safeParse({ x: 1 }).success).toBe(true);
    expect(safeParse({ x: "a" }).success).toBe(false);
  });
});

// ─── Partial Fallback CodeGen ────────────────────────────────────────────────

describe("codegen — partial fallback", () => {
  it("generates pre-captured __rf delegate for fallback with index", () => {
    const ir: ObjectIR = {
      type: "object",
      properties: {
        name: { type: "string", checks: [] },
        slug: { type: "fallback", reason: "transform", refIndex: 0 } satisfies FallbackIR,
      },
    };
    const result = generateValidator(ir, "test", { refCount: 1 });
    // The capture lives in the preamble; parse-time code calls the delegate
    // var (never `__rf[0].safeParse`, which __zcMkv mutation can shadow).
    expect(result.code).toContain("var __rfp_0=__rf[0].safeParse.bind(__rf[0]);");
    expect(result.functionDef).toContain("__rfp_0(");
    expect(result.functionDef).not.toContain("__rf[0].safeParse");
    expect(result.refCount).toBe(1);
  });

  it("generates old-style error push for fallback without index", () => {
    const ir: ObjectIR = {
      type: "object",
      properties: {
        name: { type: "string", checks: [] },
        slug: { type: "fallback", reason: "transform" } satisfies FallbackIR,
      },
    };
    const result = generateValidator(ir, "test");
    expect(result.functionDef).toContain("Fallback schema: transform");
    expect(result.functionDef).not.toContain("__rf");
  });

  it("delegates to Zod and validates correctly at runtime", () => {
    const { z } = require("zod");
    const slugSchema = z.string().min(1);
    const ir: ObjectIR = {
      type: "object",
      properties: {
        name: { type: "string", checks: [] },
        slug: { type: "fallback", reason: "refine", refIndex: 0 } satisfies FallbackIR,
      },
    };
    const safeParse = compileIR(ir, "test", [slugSchema]);

    expect(safeParse({ name: "Alice", slug: "hello" }).success).toBe(true);
    expect(safeParse({ name: 42, slug: "hello" }).success).toBe(false);
    expect(safeParse({ name: "Alice", slug: "" }).success).toBe(false);
    expect(safeParse({ name: "Alice", slug: 42 }).success).toBe(false);
  });

  it("writes back transformed data on success", () => {
    const { z } = require("zod");
    const transformSchema = z.string().transform((v: string) => v.toUpperCase());
    const ir: ObjectIR = {
      type: "object",
      properties: {
        name: { type: "string", checks: [] },
        slug: { type: "fallback", reason: "transform", refIndex: 0 } satisfies FallbackIR,
      },
    };
    const safeParse = compileIR(ir, "test", [transformSchema]);

    const result = safeParse({ name: "Alice", slug: "hello" });
    expect(result.success).toBe(true);
    expect(result.data).toEqual({ name: "Alice", slug: "HELLO" });
  });
});
