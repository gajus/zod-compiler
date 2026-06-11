import { describe, expect, it } from "vitest";
import { diagnoseSchema } from "#src/core/diagnostic.js";
import type { SchemaIR } from "#src/core/types.js";

// ─── Fast Path Eligibility (via diagnoseSchema) ────────────────────────────

describe("fastPathEligible", () => {
  it("eligible for simple string schema", () => {
    const ir: SchemaIR = { type: "string", checks: [] };
    expect(diagnoseSchema(ir).fastPathEligible).toBe(true);
  });

  it("eligible for object with primitive properties", () => {
    const ir: SchemaIR = {
      type: "object",
      properties: {
        name: { type: "string", checks: [] },
        age: { type: "number", checks: [] },
      },
    };
    expect(diagnoseSchema(ir).fastPathEligible).toBe(true);
  });

  it("ineligible for fallback node", () => {
    const ir: SchemaIR = { type: "fallback", reason: "transform" };
    const result = diagnoseSchema(ir);
    expect(result.fastPathEligible).toBe(false);
    expect(result.fastPathBlocker).toBe("fallback (transform)");
  });

  it("eligible for default node (non-undefined input uses fast path)", () => {
    const ir: SchemaIR = {
      type: "default",
      inner: { type: "string", checks: [] },
      refIndex: 0,
    };
    expect(diagnoseSchema(ir).fastPathEligible).toBe(true);
    expect(diagnoseSchema(ir).fastPathBlocker).toBeUndefined();
  });

  it("eligible for catch node (valid inner input uses fast path)", () => {
    const ir: SchemaIR = {
      type: "catch",
      inner: { type: "string", checks: [] },
      defaultValue: "",
    };
    expect(diagnoseSchema(ir).fastPathEligible).toBe(true);
    expect(diagnoseSchema(ir).fastPathBlocker).toBeUndefined();
  });

  it("eligible for date node (non-coerce)", () => {
    const ir: SchemaIR = { type: "date", checks: [] };
    expect(diagnoseSchema(ir).fastPathEligible).toBe(true);
  });

  it("ineligible for coerced date", () => {
    const ir: SchemaIR = { type: "date", checks: [], coerce: true };
    expect(diagnoseSchema(ir).fastPathBlocker).toBe("coerce (date)");
  });

  it("eligible for set node", () => {
    const ir: SchemaIR = { type: "set", valueType: { type: "string", checks: [] } };
    expect(diagnoseSchema(ir).fastPathEligible).toBe(true);
  });

  it("eligible for map node", () => {
    const ir: SchemaIR = {
      type: "map",
      keyType: { type: "string", checks: [] },
      valueType: { type: "number", checks: [] },
    };
    expect(diagnoseSchema(ir).fastPathEligible).toBe(true);
  });

  it("eligible for recursiveRef node (compiled as root fast-check helper call)", () => {
    const ir: SchemaIR = { type: "recursiveRef" };
    expect(diagnoseSchema(ir).fastPathEligible).toBe(true);
  });

  it("ineligible for coerced string", () => {
    const ir: SchemaIR = { type: "string", checks: [], coerce: true };
    expect(diagnoseSchema(ir).fastPathBlocker).toBe("coerce (string)");
  });

  it("ineligible for coerced number", () => {
    const ir: SchemaIR = { type: "number", checks: [], coerce: true };
    expect(diagnoseSchema(ir).fastPathBlocker).toBe("coerce (number)");
  });

  it("eligible for nested default in object", () => {
    const ir: SchemaIR = {
      type: "object",
      properties: {
        name: { type: "string", checks: [] },
        value: { type: "default", inner: { type: "string", checks: [] }, refIndex: 0 },
      },
    };
    expect(diagnoseSchema(ir).fastPathEligible).toBe(true);
    expect(diagnoseSchema(ir).fastPathBlocker).toBeUndefined();
  });

  it("ineligible for nested blocker in array", () => {
    const ir: SchemaIR = {
      type: "array",
      element: { type: "fallback", reason: "refine" },
      checks: [],
    };
    expect(diagnoseSchema(ir).fastPathBlocker).toBe("fallback (refine)");
  });

  it("eligible for any/unknown", () => {
    expect(diagnoseSchema({ type: "any" }).fastPathEligible).toBe(true);
    expect(diagnoseSchema({ type: "unknown" }).fastPathEligible).toBe(true);
  });

  it("eligible for optional/nullable/readonly wrappers", () => {
    const ir: SchemaIR = {
      type: "optional",
      inner: {
        type: "nullable",
        inner: { type: "string", checks: [] },
      },
    };
    expect(diagnoseSchema(ir).fastPathEligible).toBe(true);
  });

  it("eligible for union of eligible types", () => {
    const ir: SchemaIR = {
      type: "union",
      options: [
        { type: "string", checks: [] },
        { type: "number", checks: [] },
      ],
    };
    expect(diagnoseSchema(ir).fastPathEligible).toBe(true);
  });

  it("ineligible for union with ineligible option", () => {
    const ir: SchemaIR = {
      type: "union",
      options: [
        { type: "string", checks: [] },
        { type: "fallback", reason: "transform" },
      ],
    };
    expect(diagnoseSchema(ir).fastPathBlocker).toBe("fallback (transform)");
  });

  it("eligible for pipe of eligible types", () => {
    const ir: SchemaIR = {
      type: "pipe",
      in: { type: "string", checks: [] },
      out: { type: "string", checks: [] },
    };
    expect(diagnoseSchema(ir).fastPathEligible).toBe(true);
  });

  it("eligible for intersection of eligible types", () => {
    const ir: SchemaIR = {
      type: "intersection",
      left: { type: "object", properties: { a: { type: "string", checks: [] } } },
      right: { type: "object", properties: { b: { type: "number", checks: [] } } },
    };
    expect(diagnoseSchema(ir).fastPathEligible).toBe(true);
  });

  it("eligible for tuple of eligible types", () => {
    const ir: SchemaIR = {
      type: "tuple",
      items: [
        { type: "string", checks: [] },
        { type: "number", checks: [] },
      ],
      rest: null,
    };
    expect(diagnoseSchema(ir).fastPathEligible).toBe(true);
  });

  it("eligible for tuple with default rest", () => {
    const ir: SchemaIR = {
      type: "tuple",
      items: [{ type: "string", checks: [] }],
      rest: { type: "default", inner: { type: "string", checks: [] }, refIndex: 0 },
    };
    expect(diagnoseSchema(ir).fastPathEligible).toBe(true);
    expect(diagnoseSchema(ir).fastPathBlocker).toBeUndefined();
  });

  it("eligible for record of eligible types", () => {
    const ir: SchemaIR = {
      type: "record",
      keyType: { type: "string", checks: [] },
      valueType: { type: "number", checks: [] },
    };
    expect(diagnoseSchema(ir).fastPathEligible).toBe(true);
  });

  it("eligible for discriminatedUnion of eligible types", () => {
    const ir: SchemaIR = {
      type: "discriminatedUnion",
      discriminator: "type",
      options: [
        {
          type: "object",
          properties: {
            type: { type: "literal", values: ["a"] },
            value: { type: "string", checks: [] },
          },
        },
      ],
      mapping: { a: 0 },
    };
    expect(diagnoseSchema(ir).fastPathEligible).toBe(true);
  });

  it("eligible for leaf primitives", () => {
    const leaves: SchemaIR[] = [
      { type: "boolean" },
      { type: "bigint", checks: [] },
      { type: "symbol" },
      { type: "null" },
      { type: "undefined" },
      { type: "void" },
      { type: "nan" },
      { type: "never" },
      { type: "literal", values: [42] },
      { type: "enum", values: ["a", "b"] },
      { type: "templateLiteral", pattern: "^test$" },
    ];
    for (const ir of leaves) {
      expect(diagnoseSchema(ir).fastPathEligible).toBe(true);
    }
  });
});

// ─── diagnoseSchema ─────────────────────────────────────────────────────────

describe("diagnoseSchema", () => {
  it("returns 100% coverage for simple string", () => {
    const ir: SchemaIR = { type: "string", checks: [] };
    const result = diagnoseSchema(ir);

    expect(result.total).toBe(1);
    expect(result.compilable).toBe(1);
    expect(result.coveragePct).toBe(100);
    expect(result.fastPathEligible).toBe(true);
    expect(result.fallbacks).toHaveLength(0);
  });

  it("returns 0% coverage for fallback", () => {
    const ir: SchemaIR = { type: "fallback", reason: "transform" };
    const result = diagnoseSchema(ir);

    expect(result.total).toBe(1);
    expect(result.compilable).toBe(0);
    expect(result.coveragePct).toBe(0);
    expect(result.fastPathEligible).toBe(false);
    expect(result.fallbacks).toHaveLength(1);
    expect(result.fallbacks[0]?.reason).toBe("transform");
    expect(result.fallbacks[0]?.hint).toContain("Extract transform");
  });

  it("returns partial coverage for mixed object", () => {
    const ir: SchemaIR = {
      type: "object",
      properties: {
        name: { type: "string", checks: [] },
        slug: { type: "fallback", reason: "transform" },
      },
    };
    const result = diagnoseSchema(ir);

    expect(result.total).toBe(2);
    expect(result.compilable).toBe(1);
    expect(result.coveragePct).toBe(50);
    expect(result.fastPathEligible).toBe(false);
    expect(result.fallbacks).toHaveLength(1);
    expect(result.fallbacks[0]?.path).toBe(".slug");
  });

  it("reports correct paths for nested objects", () => {
    const ir: SchemaIR = {
      type: "object",
      properties: {
        user: {
          type: "object",
          properties: {
            email: { type: "string", checks: [] },
            bio: { type: "fallback", reason: "refine" },
          },
        },
      },
    };
    const result = diagnoseSchema(ir);

    expect(result.fallbacks).toHaveLength(1);
    expect(result.fallbacks[0]?.path).toBe(".user.bio");
    expect(result.fallbacks[0]?.reason).toBe("refine");
  });

  it("handles array element fallback", () => {
    const ir: SchemaIR = {
      type: "array",
      element: { type: "fallback", reason: "custom" },
      checks: [],
    };
    const result = diagnoseSchema(ir);

    expect(result.total).toBe(1);
    expect(result.compilable).toBe(0);
    expect(result.fallbacks[0]?.path).toBe("[]");
    expect(result.fallbacks[0]?.hint).toContain("z.custom()");
  });

  it("handles union fallback", () => {
    const ir: SchemaIR = {
      type: "union",
      options: [
        { type: "string", checks: [] },
        { type: "fallback", reason: "lazy" },
      ],
    };
    const result = diagnoseSchema(ir);

    expect(result.total).toBe(2);
    expect(result.compilable).toBe(1);
    expect(result.coveragePct).toBe(50);
    expect(result.fallbacks[0]?.path).toBe("[1]");
  });

  it("handles tuple with rest", () => {
    const ir: SchemaIR = {
      type: "tuple",
      items: [{ type: "string", checks: [] }],
      rest: { type: "fallback", reason: "unsupported" },
    };
    const result = diagnoseSchema(ir);

    expect(result.total).toBe(2);
    expect(result.compilable).toBe(1);
    expect(result.fallbacks[0]?.path).toBe("[...rest]");
  });

  it("handles record key/value", () => {
    const ir: SchemaIR = {
      type: "record",
      keyType: { type: "string", checks: [] },
      valueType: { type: "fallback", reason: "superRefine" },
    };
    const result = diagnoseSchema(ir);

    expect(result.total).toBe(2);
    expect(result.compilable).toBe(1);
    expect(result.fallbacks[0]?.path).toBe("[value]");
    expect(result.fallbacks[0]?.hint).toContain("superRefine");
  });

  it("handles intersection", () => {
    const ir: SchemaIR = {
      type: "intersection",
      left: { type: "object", properties: { a: { type: "string", checks: [] } } },
      right: { type: "object", properties: { b: { type: "fallback", reason: "transform" } } },
    };
    const result = diagnoseSchema(ir);

    expect(result.fallbacks).toHaveLength(1);
    expect(result.fallbacks[0]?.path).toBe("[right].b");
  });

  it("handles set element", () => {
    const ir: SchemaIR = {
      type: "set",
      valueType: { type: "string", checks: [] },
    };
    const result = diagnoseSchema(ir);

    expect(result.total).toBe(1);
    expect(result.compilable).toBe(1);
    expect(result.fastPathEligible).toBe(true);
  });

  it("handles map key/value", () => {
    const ir: SchemaIR = {
      type: "map",
      keyType: { type: "string", checks: [] },
      valueType: { type: "number", checks: [] },
    };
    const result = diagnoseSchema(ir);

    expect(result.total).toBe(2);
    expect(result.compilable).toBe(2);
    expect(result.fastPathEligible).toBe(true);
  });

  it("handles pipe in/out", () => {
    const ir: SchemaIR = {
      type: "pipe",
      in: { type: "string", checks: [] },
      out: { type: "fallback", reason: "transform" },
    };
    const result = diagnoseSchema(ir);

    expect(result.total).toBe(2);
    expect(result.compilable).toBe(1);
    expect(result.fallbacks[0]?.path).toBe("[out]");
  });

  it("optional/nullable/readonly are transparent (use parent path)", () => {
    const ir: SchemaIR = {
      type: "object",
      properties: {
        name: {
          type: "optional",
          inner: {
            type: "nullable",
            inner: { type: "string", checks: [] },
          },
        },
      },
    };
    const result = diagnoseSchema(ir);

    expect(result.total).toBe(1);
    expect(result.compilable).toBe(1);
  });

  it("default/catch inner is traversed", () => {
    const ir: SchemaIR = {
      type: "default",
      inner: { type: "fallback", reason: "transform" },
      refIndex: 0,
    };
    const result = diagnoseSchema(ir);

    expect(result.total).toBe(1);
    expect(result.compilable).toBe(0);
  });

  it("returns 100% for empty object", () => {
    const ir: SchemaIR = { type: "object", properties: {} };
    const result = diagnoseSchema(ir);

    expect(result.coveragePct).toBe(100);
    // Empty object has 1 node (the object itself as a leaf)
    expect(result.total).toBe(1);
    expect(result.compilable).toBe(1);
  });

  it("fastPathBlocker is set when not eligible", () => {
    const ir: SchemaIR = {
      type: "object",
      properties: {
        value: { type: "fallback", reason: "transform" },
      },
    };
    const result = diagnoseSchema(ir);

    expect(result.fastPathEligible).toBe(false);
    expect(result.fastPathBlocker).toBe("fallback (transform)");
  });

  it("fastPathBlocker is undefined when eligible", () => {
    const ir: SchemaIR = { type: "string", checks: [] };
    const result = diagnoseSchema(ir);

    expect(result.fastPathEligible).toBe(true);
    expect(result.fastPathBlocker).toBeUndefined();
  });

  it("root node type is set correctly", () => {
    const ir: SchemaIR = { type: "string", checks: [] };
    const result = diagnoseSchema(ir);

    expect(result.root.type).toBe("string");
    expect(result.root.status).toBe("compiled");
    expect(result.root.children).toHaveLength(0);
  });

  it("fallback hints are set for all known reasons", () => {
    const reasons = [
      "transform",
      "refine",
      "superRefine",
      "custom",
      "lazy",
      "unsupported",
    ] as const;
    for (const reason of reasons) {
      const ir: SchemaIR = { type: "fallback", reason };
      const result = diagnoseSchema(ir);
      expect(result.fallbacks[0]?.hint).toBeTruthy();
      expect(result.fallbacks[0]?.hint.length).toBeGreaterThan(0);
    }
  });

  it("discriminatedUnion options are traversed", () => {
    const ir: SchemaIR = {
      type: "discriminatedUnion",
      discriminator: "type",
      options: [
        {
          type: "object",
          properties: {
            type: { type: "literal", values: ["a"] },
            data: { type: "fallback", reason: "refine" },
          },
        },
      ],
      mapping: { a: 0 },
    };
    const result = diagnoseSchema(ir);

    expect(result.fallbacks).toHaveLength(1);
    expect(result.fallbacks[0]?.path).toBe("[0].data");
  });
});
