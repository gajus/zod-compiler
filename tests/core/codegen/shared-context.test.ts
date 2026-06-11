import { describe, expect, it } from "vitest";
import type { CodeGenContext } from "#src/core/codegen/context.js";
import { createFastGen, generateFast } from "#src/core/codegen/fast-path.js";
import { createSlowGen, generateSlow } from "#src/core/codegen/slow-path.js";
import type { StringIR } from "#src/core/types.js";

/**
 * The orchestrator (codegen/index.ts) creates both FastGen and SlowGen from the
 * same CodeGenContext. This test verifies the invariant: fast-path and slow-path
 * share counter and preamble, so generated variable names never collide.
 */
describe("shared CodeGenContext between fast-path and slow-path", () => {
  it("fast and slow paths share the same counter — no name collisions", () => {
    const ctx: CodeGenContext = {
      preamble: [],
      counter: 0,
      fnName: "safeParse_test",
      regexCache: new Map(),
      mode: "inline",
      usedHelpers: new Set(),
    };

    // Fast-path runs first (matches orchestrator order)
    const fg = createFastGen("input", ctx);
    const ir: StringIR = {
      type: "string",
      checks: [{ kind: "string_format", format: "email" }],
    };
    const fastExpr = generateFast(ir, fg);
    expect(fastExpr).not.toBeNull();

    const counterAfterFast = ctx.counter;
    expect(counterAfterFast).toBeGreaterThan(0);

    // Slow-path runs second with the SAME ctx
    const sg = createSlowGen("__data", "__data", "[]", "__issues", ctx);
    generateSlow(ir, sg);

    const counterAfterSlow = ctx.counter;
    // With regex dedup, slow path reuses the fast path's email regex variable
    // so counter may not increase if the only new operation was a deduped regex
    expect(counterAfterSlow).toBeGreaterThanOrEqual(counterAfterFast);

    // All preamble variable names should be unique
    const varNames = ctx.preamble
      .map((line) => {
        const match = /var (\w+)=/.exec(line);
        return match?.[1];
      })
      .filter(Boolean);
    const uniqueNames = new Set(varNames);
    expect(varNames.length).toBe(uniqueNames.size);
  });

  it("preamble entries from both paths are interleaved correctly", () => {
    const ctx: CodeGenContext = {
      preamble: [],
      counter: 0,
      fnName: "safeParse_test",
      regexCache: new Map(),
      mode: "inline",
      usedHelpers: new Set(),
    };

    const fg = createFastGen("input", ctx);
    const sg = createSlowGen("__data", "__data", "[]", "__issues", ctx);

    // Generate fast for enum (uses Set preamble)
    const enumIR = { type: "enum" as const, values: ["a", "b", "c", "d", "e", "f"] };
    generateFast(enumIR, fg);
    const preambleAfterFast = ctx.preamble.length;

    // Generate slow for same enum
    generateSlow(enumIR, sg);
    const preambleAfterSlow = ctx.preamble.length;

    expect(preambleAfterSlow).toBeGreaterThan(preambleAfterFast);

    // All generated preamble lines should be valid JS declarations
    for (const line of ctx.preamble) {
      expect(line).toMatch(/^var \w+=/);
    }
  });

  it("temp() from FastGen and SlowGen never produce duplicate names", () => {
    const ctx: CodeGenContext = {
      preamble: [],
      counter: 0,
      fnName: "safeParse_test",
      regexCache: new Map(),
      mode: "inline",
      usedHelpers: new Set(),
    };
    const fg = createFastGen("input", ctx);
    const sg = createSlowGen("__data", "__data", "[]", "__issues", ctx);

    const names = [fg.temp("x"), sg.temp("x"), fg.temp("x"), sg.temp("x")];
    const unique = new Set(names);
    expect(names.length).toBe(unique.size);
  });
});
