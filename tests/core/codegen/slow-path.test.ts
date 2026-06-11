import { describe, expect, it } from "vitest";
import type { CodeGenContext } from "#src/core/codegen/context.js";
import { createSlowGen, generateSlow } from "#src/core/codegen/slow-path.js";
import type { ArrayIR, SchemaIR, StringIR } from "#src/core/types.js";

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

describe("createSlowGen", () => {
  describe("properties", () => {
    it("exposes input, output, path, issues, ctx", () => {
      const ctx = makeCtx();
      const g = createSlowGen("in", "out", "p", "iss", ctx);
      expect(g.input).toBe("in");
      expect(g.output).toBe("out");
      expect(g.path).toBe("p");
      expect(g.issues).toBe("iss");
      expect(g.ctx).toBe(ctx);
    });
  });

  describe("temp()", () => {
    it("generates unique variable names with incrementing counter", () => {
      const ctx = makeCtx();
      const g = createSlowGen("in", "out", "[]", "__issues", ctx);
      expect(g.temp("i")).toBe("__i_0");
      expect(g.temp("i")).toBe("__i_1");
      expect(g.temp("obj")).toBe("__obj_2");
      expect(ctx.counter).toBe(3);
    });

    it("shares counter across multiple SlowGen instances", () => {
      const ctx = makeCtx();
      const g1 = createSlowGen("a", "a", "[]", "iss", ctx);
      const g2 = createSlowGen("b", "b", "[]", "iss", ctx);
      expect(g1.temp("x")).toBe("__x_0");
      expect(g2.temp("x")).toBe("__x_1");
      expect(ctx.counter).toBe(2);
    });
  });

  describe("regex()", () => {
    it("adds RegExp declaration to preamble and returns variable name", () => {
      const ctx = makeCtx();
      const g = createSlowGen("in", "out", "[]", "__issues", ctx);
      const name = g.regex("email", "^[a-z]+$");
      expect(name).toBe("__re_email_0");
      expect(ctx.preamble).toHaveLength(1);
      expect(ctx.preamble[0]).toContain("new RegExp");
      expect(ctx.preamble[0]).toContain("^[a-z]+$");
    });

    it("increments counter for each regex", () => {
      const ctx = makeCtx();
      const g = createSlowGen("in", "out", "[]", "__issues", ctx);
      const r1 = g.regex("a", "a");
      const r2 = g.regex("b", "b");
      expect(r1).toBe("__re_a_0");
      expect(r2).toBe("__re_b_1");
      expect(ctx.preamble).toHaveLength(2);
    });
  });

  describe("set()", () => {
    it("adds Set declaration to preamble and returns variable name", () => {
      const ctx = makeCtx();
      const g = createSlowGen("in", "out", "[]", "__issues", ctx);
      const name = g.set("enum", ["a", "b", "c"]);
      expect(name).toBe("__set_enum_0");
      expect(ctx.preamble).toHaveLength(1);
      expect(ctx.preamble[0]).toContain("new Set");
      expect(ctx.preamble[0]).toContain('"a","b","c"');
    });
  });

  describe("visit()", () => {
    it("generates validation for a child IR node", () => {
      const ctx = makeCtx();
      const g = createSlowGen("input", "input", "[]", "__issues", ctx);
      const ir: StringIR = { type: "string", checks: [] };
      const code = g.visit(ir);
      expect(code).toContain('typeof input!=="string"');
      expect(code).toContain("__issues.push");
    });

    it("overrides input and output for child validation", () => {
      const ctx = makeCtx();
      const g = createSlowGen("root", "root", "[]", "__issues", ctx);
      const ir: StringIR = { type: "string", checks: [] };
      const code = g.visit(ir, { input: "child", output: "child" });
      expect(code).toContain('typeof child!=="string"');
      expect(code).not.toContain("root");
    });

    it("overrides path for child validation", () => {
      const ctx = makeCtx();
      const g = createSlowGen("input", "input", "[]", "__issues", ctx);
      const ir: StringIR = { type: "string", checks: [] };
      const code = g.visit(ir, { path: '["name"]' });
      expect(code).toContain('["name"]');
    });

    it("overrides issues for union-style branch isolation", () => {
      const ctx = makeCtx();
      const g = createSlowGen("input", "input", "[]", "__issues", ctx);
      const ir: StringIR = { type: "string", checks: [] };
      const code = g.visit(ir, { issues: "__tmpIssues" });
      expect(code).toContain("__tmpIssues.push");
      expect(code).not.toContain("__issues.push");
    });

    it("inherits parent values when no overrides given", () => {
      const ctx = makeCtx();
      const g = createSlowGen("myInput", "myOutput", "myPath", "myIssues", ctx);
      const ir: StringIR = { type: "string", checks: [] };
      const code = g.visit(ir);
      expect(code).toContain("myInput");
      expect(code).toContain("myIssues");
      expect(code).toContain("myPath");
    });

    it("recursively visits nested schemas", () => {
      const ctx = makeCtx();
      const g = createSlowGen("input", "input", "[]", "__issues", ctx);
      const ir: ArrayIR = {
        type: "array",
        element: { type: "string", checks: [] },
        checks: [],
      };
      const code = g.visit(ir);
      expect(code).toContain("Array.isArray");
      expect(code).toContain('"string"');
    });
  });

  describe("generateSlow dispatch", () => {
    it("dispatches to correct generator for each IR type", () => {
      const ctx = makeCtx();
      const g = createSlowGen("v", "v", "[]", "iss", ctx);

      // Types that produce non-empty validation code
      const typesWithCode: SchemaIR[] = [
        { type: "string", checks: [] },
        { type: "number", checks: [] },
        { type: "boolean" },
        { type: "null" },
        { type: "undefined" },
        { type: "never" },
        { type: "nan" },
        { type: "symbol" },
        { type: "void" },
      ];

      for (const ir of typesWithCode) {
        const code = generateSlow(ir, g);
        expect(typeof code).toBe("string");
        expect(code.length).toBeGreaterThan(0);
      }

      // any/unknown produce empty code (always valid)
      expect(generateSlow({ type: "any" }, g)).toBe("");
      expect(generateSlow({ type: "unknown" }, g)).toBe("");
    });
  });
});
