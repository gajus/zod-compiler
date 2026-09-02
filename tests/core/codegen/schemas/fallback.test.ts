import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import type { CodeGenContext } from "#src/core/codegen/context.js";
import { slowFallback } from "#src/core/codegen/schemas/fallback.js";
import { createSlowGen } from "#src/core/codegen/slow-path.js";
import type { FallbackIR } from "#src/core/types.js";
import { compileIR } from "../helpers.js";

describe("slow-path — fallback", () => {
  it("runs the retained schema through _zod.run when refIndex is present", () => {
    const ir: FallbackIR = { type: "fallback", reason: "transform", refIndex: 0 };
    const ctx: CodeGenContext = {
      preamble: [],
      counter: 0,
      fnName: "safeParse_test",
      regexCache: new Map(),
      mode: "inline",
      usedHelpers: new Set(),
    };
    const g = createSlowGen("input", "input", "[]", "__issues", ctx);
    const code = slowFallback(ir, g);
    // The retained schema's `_zod` is aliased in the preamble and run through
    // `_zod.run` (never `safeParse`, which an own-property install can shadow):
    // the raw payload is where zod's per-issue abort flags still exist.
    expect(ctx.preamble).toContain("var __rfz_0=__rf[0]._zod;");
    expect(code).toContain("__zcRd(__rfz_0,input,__rf_c0)");
    expect(code).toContain("__zcRf(__rf_r0.issues,__rf_c0,__issues,[])");
    expect(code).not.toContain("safeParse");
    expect(code).toContain("__rf_r0");
  });

  it("generates error push when refIndex is absent", () => {
    const ir: FallbackIR = { type: "fallback", reason: "transform" };
    const ctx: CodeGenContext = {
      preamble: [],
      counter: 0,
      fnName: "safeParse_test",
      regexCache: new Map(),
      mode: "inline",
      usedHelpers: new Set(),
    };
    const g = createSlowGen("input", "input", "[]", "__issues", ctx);
    const code = slowFallback(ir, g);
    expect(code).toContain("Fallback schema: transform");
    expect(code).not.toContain("__rf");
  });

  it("uses correct variable names for different indices", () => {
    const ir: FallbackIR = { type: "fallback", reason: "refine", refIndex: 3 };
    const ctx: CodeGenContext = {
      preamble: [],
      counter: 0,
      fnName: "safeParse_test",
      regexCache: new Map(),
      mode: "inline",
      usedHelpers: new Set(),
    };
    const g = createSlowGen("v", "v", "p", "iss", ctx);
    const code = slowFallback(ir, g);
    expect(ctx.preamble).toContain("var __rfz_3=__rf[3]._zod;");
    expect(code).toContain("__zcRd(__rfz_3,v,__rf_c3)");
    expect(code).toContain("__zcRf(__rf_r3.issues,__rf_c3,iss,p)");
    expect(code).toContain("__rf_r3");
  });

  it("delegates to Zod and validates correctly at runtime", () => {
    const schema = z.string().min(1);
    const ir: FallbackIR = { type: "fallback", reason: "refine", refIndex: 0 };
    const safeParse = compileIR(ir, "test", [schema]);

    expect(safeParse("hello").success).toBe(true);
    expect(safeParse("").success).toBe(false);
  });

  it("writes back transformed data on success", () => {
    const schema = z.string().transform((v: string) => v.toUpperCase());
    const ir: FallbackIR = { type: "fallback", reason: "transform", refIndex: 0 };
    const safeParse = compileIR(ir, "test", [schema]);

    const result = safeParse("hello");
    expect(result.success).toBe(true);
    expect(result.data).toBe("HELLO");
  });
});
