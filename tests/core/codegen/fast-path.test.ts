import { describe, expect, it } from "vitest";
import type { CodeGenContext } from "#src/core/codegen/context.js";
import { createFastGen, generateFast } from "#src/core/codegen/fast-path.js";
import type { SchemaIR, StringIR } from "#src/core/types.js";
import { compileFastCheck } from "./helpers.js";

function makeCtx(overrides?: Partial<CodeGenContext>): CodeGenContext {
  return {
    preamble: [],
    counter: 0,
    fnName: "safeParse_test",
    regexCache: new Map(),
    mode: "inline",
    usedHelpers: new Set(),
    ...overrides,
  };
}

describe("createFastGen", () => {
  describe("properties", () => {
    it("exposes input and ctx", () => {
      const ctx = makeCtx();
      const g = createFastGen("input", ctx);
      expect(g.input).toBe("input");
      expect(g.ctx).toBe(ctx);
    });
  });

  describe("temp()", () => {
    it("generates unique variable names with incrementing counter", () => {
      const ctx = makeCtx();
      const g = createFastGen("input", ctx);
      expect(g.temp("k")).toBe("__k_0");
      expect(g.temp("k")).toBe("__k_1");
      expect(g.temp("v")).toBe("__v_2");
      expect(ctx.counter).toBe(3);
    });
  });

  describe("regex()", () => {
    it("adds RegExp declaration to preamble and returns variable name", () => {
      const ctx = makeCtx();
      const g = createFastGen("input", ctx);
      const name = g.regex("tl", "^abc$");
      expect(name).toBe("__re_tl_0");
      expect(ctx.preamble).toHaveLength(1);
      expect(ctx.preamble[0]).toContain("new RegExp");
      expect(ctx.preamble[0]).toContain("^abc$");
    });
  });

  describe("visit()", () => {
    it("generates fast-check expression for a child IR node", () => {
      const ctx = makeCtx();
      const g = createFastGen("input", ctx);
      const ir: StringIR = { type: "string", checks: [] };
      const expr = g.visit(ir);
      expect(expr).toContain('typeof input==="string"');
    });

    it("overrides input for child expression", () => {
      const ctx = makeCtx();
      const g = createFastGen("root", ctx);
      const ir: StringIR = { type: "string", checks: [] };
      const expr = g.visit(ir, { input: "child" });
      expect(expr).toContain('typeof child==="string"');
      expect(expr).not.toContain("root");
    });

    it("inherits parent input when no override given", () => {
      const ctx = makeCtx();
      const g = createFastGen("myVar", ctx);
      const ir: StringIR = { type: "string", checks: [] };
      const expr = g.visit(ir);
      expect(expr).toContain("myVar");
    });

    it("returns null for ineligible schemas (propagation)", () => {
      const ctx = makeCtx();
      const g = createFastGen("input", ctx);
      const ir: SchemaIR = {
        type: "fallback",
        reason: "transform",
      };
      const expr = g.visit(ir);
      expect(expr).toBeNull();
    });

    it("returns null for effect schemas", () => {
      const ctx = makeCtx();
      const g = createFastGen("input", ctx);
      const ir: SchemaIR = {
        type: "effect",
        effectKind: "transform",
        source: "v => v",
        inner: { type: "string", checks: [] },
      };
      expect(g.visit(ir)).toBeNull();
    });
  });

  describe("generateFast dispatch", () => {
    it("returns expression for eligible types", () => {
      const ctx = makeCtx();
      const g = createFastGen("v", ctx);

      const cases: [SchemaIR, string][] = [
        [{ type: "any" }, "true"],
        [{ type: "unknown" }, "true"],
        [{ type: "null" }, "v===null"],
        [{ type: "undefined" }, "v===undefined"],
        [{ type: "symbol" }, 'typeof v==="symbol"'],
        [{ type: "void" }, "v===undefined"],
        [{ type: "never" }, "false"],
        [{ type: "boolean" }, 'typeof v==="boolean"'],
        [{ type: "nan" }, 'typeof v==="number"&&Number.isNaN(v)'],
      ];

      for (const [ir, expected] of cases) {
        const expr = generateFast(ir, g);
        expect(expr).toBe(expected);
      }
    });

    it("returns null for statically ineligible types", () => {
      const ctx = makeCtx();
      const g = createFastGen("v", ctx);

      const ineligible: SchemaIR["type"][] = ["fallback", "effect"];

      for (const type of ineligible) {
        // Construct minimal IR for each type
        const ir = makeIneligibleIR(type);
        expect(generateFast(ir, g)).toBeNull();
      }
    });
  });
});

function makeIneligibleIR(type: string): SchemaIR {
  switch (type) {
    case "date":
      return { type: "date", checks: [] };
    case "set":
      return { type: "set", valueType: { type: "string", checks: [] } };
    case "map":
      return {
        type: "map",
        keyType: { type: "string", checks: [] },
        valueType: { type: "string", checks: [] },
      };
    case "default":
      return { type: "default", inner: { type: "string", checks: [] }, refIndex: 0 };
    case "catch":
      return { type: "catch", inner: { type: "string", checks: [] }, defaultValue: "" };
    case "fallback":
      return { type: "fallback", reason: "transform" };
    case "effect":
      return {
        type: "effect",
        effectKind: "transform",
        source: "v => v",
        inner: { type: "string", checks: [] },
      };
    default:
      throw new Error(`Unknown type: ${type}`);
  }
}

describe("fast-path — dispatcher", () => {
  it("any → always true", () => {
    const fn = compileFastCheck({ type: "any" });
    expect(fn?.("anything")).toBe(true);
  });

  it("unknown → always true", () => {
    const fn = compileFastCheck({ type: "unknown" });
    expect(fn?.(42)).toBe(true);
  });

  it("null → true for null, false for other", () => {
    const fn = compileFastCheck({ type: "null" });
    expect(fn?.(null)).toBe(true);
    expect(fn?.(undefined)).toBe(false);
  });

  it("undefined → true for undefined, false for other", () => {
    const fn = compileFastCheck({ type: "undefined" });
    expect(fn?.(undefined)).toBe(true);
    expect(fn?.(null)).toBe(false);
  });

  it("symbol → true for Symbol(), false for other", () => {
    const fn = compileFastCheck({ type: "symbol" });
    expect(fn?.(Symbol())).toBe(true);
    expect(fn?.("symbol")).toBe(false);
  });

  it("void → true for undefined, false for other", () => {
    const fn = compileFastCheck({ type: "void" });
    expect(fn?.(undefined)).toBe(true);
    expect(fn?.(null)).toBe(false);
  });

  it("nan → true for NaN, false for 0", () => {
    const fn = compileFastCheck({ type: "nan" });
    expect(fn?.(Number.NaN)).toBe(true);
    expect(fn?.(0)).toBe(false);
  });

  it("never → always false", () => {
    const fn = compileFastCheck({ type: "never" });
    expect(fn?.("anything")).toBe(false);
  });

  it("boolean → true for true/false, false for 0/'true'", () => {
    const fn = compileFastCheck({ type: "boolean" });
    expect(fn?.(true)).toBe(true);
    expect(fn?.(false)).toBe(true);
    expect(fn?.(0)).toBe(false);
    expect(fn?.("true")).toBe(false);
  });

  it("boolean with coerce → null", () => {
    expect(compileFastCheck({ type: "boolean", coerce: true })).toBeNull();
  });

  it("fallback → null", () => {
    expect(compileFastCheck({ type: "fallback", reason: "transform" })).toBeNull();
  });

  it("default → eligible (non-undefined passes, undefined falls to slow path)", () => {
    const fn = compileFastCheck({
      type: "default",
      inner: { type: "string", checks: [] },
      refIndex: 0,
    });
    expect(fn).not.toBeNull();
    expect(fn?.("hello")).toBe(true);
    expect(fn?.(undefined)).toBe(false);
    expect(fn?.(42)).toBe(false);
  });

  it("catch → eligible (valid input passes, invalid falls to slow path)", () => {
    const fn = compileFastCheck({
      type: "catch",
      inner: { type: "string", checks: [] },
      defaultValue: "",
    });
    expect(fn).not.toBeNull();
    expect(fn?.("hello")).toBe(true);
    expect(fn?.(42)).toBe(false);
  });

  it("date (non-coerce) → instanceof + getTime checks", () => {
    const fn = compileFastCheck({ type: "date", checks: [] });
    expect(fn?.(new Date())).toBe(true);
    expect(fn?.(new Date("invalid"))).toBe(false);
    expect(fn?.("2024-01-01")).toBe(false);
    expect(fn?.(null)).toBe(false);
  });

  it("date with coerce → null", () => {
    expect(compileFastCheck({ type: "date", checks: [], coerce: true })).toBeNull();
  });

  it("date with range checks", () => {
    const minTs = new Date("2020-01-01").getTime();
    const maxTs = new Date("2030-01-01").getTime();
    const fn = compileFastCheck({
      type: "date",
      checks: [
        { kind: "date_greater_than", value: "2020-01-01", timestamp: minTs, inclusive: true },
        { kind: "date_less_than", value: "2030-01-01", timestamp: maxTs, inclusive: false },
      ],
    });
    expect(fn?.(new Date("2025-01-01"))).toBe(true);
    expect(fn?.(new Date("2020-01-01"))).toBe(true);
    expect(fn?.(new Date("2019-12-31"))).toBe(false);
    expect(fn?.(new Date("2030-01-01"))).toBe(false);
  });

  it("set of strings → instanceof + element check", () => {
    const fn = compileFastCheck({ type: "set", valueType: { type: "string", checks: [] } });
    expect(fn?.(new Set(["a", "b"]))).toBe(true);
    expect(fn?.(new Set())).toBe(true);
    expect(fn?.(new Set([1, 2]))).toBe(false);
    expect(fn?.(["a"])).toBe(false);
    expect(fn?.(null)).toBe(false);
  });

  it("set with size checks", () => {
    const fn = compileFastCheck({
      type: "set",
      valueType: { type: "number", checks: [] },
      checks: [
        { kind: "min_size", minimum: 1 },
        { kind: "max_size", maximum: 3 },
      ],
    });
    expect(fn?.(new Set([1]))).toBe(true);
    expect(fn?.(new Set([1, 2, 3]))).toBe(true);
    expect(fn?.(new Set())).toBe(false);
    expect(fn?.(new Set([1, 2, 3, 4]))).toBe(false);
  });

  it("set with ineligible element → null", () => {
    expect(
      compileFastCheck({
        type: "set",
        valueType: { type: "fallback", reason: "transform" },
      }),
    ).toBeNull();
  });

  it("map of string→number → instanceof + entry checks", () => {
    const fn = compileFastCheck({
      type: "map",
      keyType: { type: "string", checks: [] },
      valueType: { type: "number", checks: [] },
    });
    expect(fn?.(new Map([["a", 1]]))).toBe(true);
    expect(fn?.(new Map())).toBe(true);
    expect(fn?.(new Map([[42, 1]]))).toBe(false);
    expect(fn?.(new Map([["a", "b"]]))).toBe(false);
    expect(fn?.({})).toBe(false);
    expect(fn?.(null)).toBe(false);
  });

  it("map with ineligible key → null", () => {
    expect(
      compileFastCheck({
        type: "map",
        keyType: { type: "fallback", reason: "transform" },
        valueType: { type: "number", checks: [] },
      }),
    ).toBeNull();
  });

  it("recursiveRef → call to root fast-check helper", () => {
    const ctx = makeCtx();
    const g = createFastGen("input", ctx);
    const expr = generateFast({ type: "recursiveRef" }, g);
    expect(ctx.recFastName).toBeDefined();
    expect(expr).toBe(`${ctx.recFastName}(input)`);
  });

  it("templateLiteral → regex check", () => {
    const fn = compileFastCheck({ type: "templateLiteral", pattern: "^hello-\\d+$" });
    expect(fn?.("hello-123")).toBe(true);
    expect(fn?.("goodbye-123")).toBe(false);
    expect(fn?.(42)).toBe(false);
  });

  it("string with coerce → null", () => {
    expect(compileFastCheck({ type: "string", checks: [], coerce: true })).toBeNull();
  });

  it("bigint with coerce → null", () => {
    expect(compileFastCheck({ type: "bigint", checks: [], coerce: true })).toBeNull();
  });
});
