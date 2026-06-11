import { describe, expect, it } from "vitest";
import type { CodeGenContext, SlowGen } from "#src/core/codegen/context.js";
import {
  invalidFormat,
  invalidType,
  invalidValue,
  tooBig,
  tooSmall,
} from "#src/core/codegen/emit-issue.js";

function makeGen(mode: "inline" | "lean"): SlowGen {
  const ctx: CodeGenContext = {
    preamble: [],
    counter: 0,
    fnName: "test",
    regexCache: new Map(),
    mode,
    usedHelpers: new Set(),
  };
  return {
    input: "_d",
    output: "_d",
    path: "[]",
    issues: "_e",
    ctx,
    visit: () => "",
    temp: () => "__t",
    regex: () => "__re",
    set: () => "__set",
  };
}

describe("emit-issue", () => {
  describe("inline mode (CLI emitter)", () => {
    it("tooSmall emits literal object", () => {
      const g = makeGen("inline");
      const code = tooSmall(g, 3, "string", true);
      expect(code).toBe(
        '_e.push({code:"too_small",minimum:3,origin:"string",inclusive:true,input:_d,path:[]});',
      );
      expect(g.ctx.usedHelpers.size).toBe(0);
    });

    it("tooSmall with exact emits exact:true", () => {
      const g = makeGen("inline");
      const code = tooSmall(g, 5, "string", true, { exact: true });
      expect(code).toContain("exact:true");
      expect(code).toContain("minimum:5");
    });

    it("tooBig emits literal object", () => {
      const g = makeGen("inline");
      const code = tooBig(g, 100, "number", true);
      expect(code).toBe(
        '_e.push({code:"too_big",maximum:100,origin:"number",inclusive:true,input:_d,path:[]});',
      );
    });

    it("invalidType emits literal object", () => {
      const g = makeGen("inline");
      const code = invalidType(g, "string");
      expect(code).toBe('_e.push({code:"invalid_type",expected:"string",input:_d,path:[]});');
    });

    it("invalidType with extra inlines extra fields", () => {
      const g = makeGen("inline");
      const code = invalidType(g, "number", { extra: 'received:"NaN"' });
      expect(code).toContain('received:"NaN"');
    });

    it("invalidFormat with extra serializes extra fields", () => {
      const g = makeGen("inline");
      const code = invalidFormat(g, "email", { extra: "pattern:__re.toString()" });
      expect(code).toContain('format:"email"');
      expect(code).toContain("pattern:__re.toString()");
    });

    it("invalidValue accepts pre-serialized values expression", () => {
      const g = makeGen("inline");
      const code = invalidValue(g, '["a","b","c"]');
      expect(code).toContain('values:["a","b","c"]');
    });
  });

  describe("lean mode (unplugin)", () => {
    it("tooSmall emits factory call and registers helper", () => {
      const g = makeGen("lean");
      const code = tooSmall(g, 3, "string", true);
      expect(code).toBe('_e.push(__zcTS(3,"string",true,_d,[]));');
      expect(g.ctx.usedHelpers.has("__zcTS")).toBe(true);
    });

    it("tooSmall exact uses __zcTSx variant", () => {
      const g = makeGen("lean");
      const code = tooSmall(g, 5, "string", true, { exact: true });
      expect(code).toBe('_e.push(__zcTSx(5,"string",_d,[]));');
      expect(g.ctx.usedHelpers.has("__zcTSx")).toBe(true);
    });

    it("tooBig emits __zcTB factory call", () => {
      const g = makeGen("lean");
      const code = tooBig(g, 100, "number", true);
      expect(code).toBe('_e.push(__zcTB(100,"number",true,_d,[]));');
      expect(g.ctx.usedHelpers.has("__zcTB")).toBe(true);
    });

    it("invalidType emits __zcIT factory call", () => {
      const g = makeGen("lean");
      const code = invalidType(g, "string");
      expect(code).toBe('_e.push(__zcIT("string",_d,[]));');
      expect(g.ctx.usedHelpers.has("__zcIT")).toBe(true);
    });

    it("invalidType with extra falls back to inline (factory has no extra slot)", () => {
      const g = makeGen("lean");
      const code = invalidType(g, "number", { extra: 'received:"NaN"' });
      expect(code).toContain('received:"NaN"');
      // No factory used in this case.
      expect(g.ctx.usedHelpers.has("__zcIT")).toBe(false);
    });

    it("invalidFormat with extra wraps extra in object literal", () => {
      const g = makeGen("lean");
      const code = invalidFormat(g, "email", { extra: "pattern:__re.toString()" });
      expect(code).toBe('_e.push(__zcIF("email",_d,[],{pattern:__re.toString()}));');
      expect(g.ctx.usedHelpers.has("__zcIF")).toBe(true);
    });

    it("invalidValue emits __zcIV factory call", () => {
      const g = makeGen("lean");
      const code = invalidValue(g, '["a","b"]');
      expect(code).toBe('_e.push(__zcIV(["a","b"],_d,[]));');
      expect(g.ctx.usedHelpers.has("__zcIV")).toBe(true);
    });
  });
});
