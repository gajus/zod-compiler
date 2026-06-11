import { describe, expect, it } from "vitest";
import { tryCompileEffect } from "#src/core/extract/effects.js";

describe("tryCompileEffect", () => {
  // ─── Compilable (zero-capture) functions ──────────────────────────────────

  it("compiles simple arrow function", () => {
    const fn = (v: string) => v.toUpperCase();
    const source = tryCompileEffect(fn);
    expect(source).toBeDefined();
    expect(source).toContain("toUpperCase");
  });

  it("compiles arrow function with block body", () => {
    const fn = (v: number) => {
      return v * 2;
    };
    const source = tryCompileEffect(fn);
    expect(source).toBeDefined();
  });

  it("compiles function using safe globals (Math, Number, parseInt)", () => {
    const fn = (v: string) => parseInt(v, 10);
    expect(tryCompileEffect(fn)).toBeDefined();

    const fn2 = (v: number) => Math.round(v);
    expect(tryCompileEffect(fn2)).toBeDefined();

    const fn3 = (v: string) => Number(v);
    expect(tryCompileEffect(fn3)).toBeDefined();
  });

  it("compiles function using String, Boolean, Array, Object globals", () => {
    expect(tryCompileEffect((v: unknown) => String(v))).toBeDefined();
    expect(tryCompileEffect((v: unknown) => Boolean(v))).toBeDefined();
    expect(tryCompileEffect((v: unknown) => Array.isArray(v))).toBeDefined();
    expect(tryCompileEffect((v: unknown) => Object.keys(v as object))).toBeDefined();
  });

  it("compiles function with JSON global", () => {
    const fn = (v: unknown) => JSON.stringify(v);
    expect(tryCompileEffect(fn)).toBeDefined();
  });

  it("compiles function using RegExp", () => {
    const fn = (v: string) => /^[a-z]+$/.test(v);
    expect(tryCompileEffect(fn)).toBeDefined();
  });

  it("compiles function with local variable declarations", () => {
    const fn = (v: string) => {
      const trimmed = v.trim();
      const lower = trimmed.toLowerCase();
      return lower;
    };
    expect(tryCompileEffect(fn)).toBeDefined();
  });

  it("compiles function with destructuring parameter", () => {
    const fn = ({ a, b }: { a: number; b: number }) => a + b;
    expect(tryCompileEffect(fn)).toBeDefined();
  });

  it("compiles function with array destructuring parameter", () => {
    const fn = ([a, b]: [number, number]) => a + b;
    expect(tryCompileEffect(fn)).toBeDefined();
  });

  it("compiles function with rest parameter", () => {
    const fn = (...args: number[]) => args.length;
    expect(tryCompileEffect(fn)).toBeDefined();
  });

  it("compiles function with default parameter using literal", () => {
    const fn = (v: number, base = 10) => v + base;
    expect(tryCompileEffect(fn)).toBeDefined();
  });

  it("compiles identity function", () => {
    const fn = (v: unknown) => v;
    expect(tryCompileEffect(fn)).toBeDefined();
  });

  it("compiles boolean predicate (refine-style)", () => {
    const fn = (v: string) => v.length > 0;
    expect(tryCompileEffect(fn)).toBeDefined();
  });

  it("compiles function using template literals without captures", () => {
    const fn = (v: string) => `${v}!`;
    expect(tryCompileEffect(fn)).toBeDefined();
  });

  it("compiles function using typeof", () => {
    const fn = (v: unknown) => typeof v === "string";
    expect(tryCompileEffect(fn)).toBeDefined();
  });

  it("compiles function using undefined/null/NaN/Infinity globals", () => {
    expect(tryCompileEffect((v: unknown) => v === undefined)).toBeDefined();
    expect(tryCompileEffect((v: unknown) => v === null)).toBeDefined();
    expect(tryCompileEffect((v: number) => Number.isNaN(v))).toBeDefined();
    expect(tryCompileEffect((v: number) => Number.isFinite(v))).toBeDefined();
  });

  // ─── Non-compilable functions ─────────────────────────────────────────────

  it("rejects function with external variable capture", () => {
    const prefix = "hello_";
    const fn = (v: string) => prefix + v;
    expect(tryCompileEffect(fn)).toBeUndefined();
  });

  it("rejects function with external object capture", () => {
    const config = { multiplier: 2 };
    const fn = (v: number) => v * config.multiplier;
    expect(tryCompileEffect(fn)).toBeUndefined();
  });

  it("rejects function with external array capture", () => {
    const allowed = ["a", "b", "c"];
    const fn = (v: string) => allowed.includes(v);
    expect(tryCompileEffect(fn)).toBeUndefined();
  });

  it("rejects function with external function capture", () => {
    const helper = (s: string) => s.trim();
    const fn = (v: string) => helper(v);
    expect(tryCompileEffect(fn)).toBeUndefined();
  });

  it("rejects async function", () => {
    const fn = async (v: string) => v;
    expect(tryCompileEffect(fn)).toBeUndefined();
  });

  it("rejects async arrow with block body", () => {
    const fn = async (v: string) => {
      return v.toUpperCase();
    };
    expect(tryCompileEffect(fn)).toBeUndefined();
  });

  it("rejects non-function values", () => {
    expect(tryCompileEffect("not a function")).toBeUndefined();
    expect(tryCompileEffect(42)).toBeUndefined();
    expect(tryCompileEffect(null)).toBeUndefined();
    expect(tryCompileEffect(undefined)).toBeUndefined();
    expect(tryCompileEffect({})).toBeUndefined();
  });

  it("rejects native function (e.g. Array.isArray)", () => {
    expect(tryCompileEffect(Array.isArray)).toBeUndefined();
  });

  // ─── Edge cases ───────────────────────────────────────────────────────────

  it("compiles function using chained method calls", () => {
    const fn = (v: string) => v.trim().toLowerCase().replace(/\s+/g, "-");
    expect(tryCompileEffect(fn)).toBeDefined();
  });

  it("compiles function using ternary operator", () => {
    const fn = (v: number) => (v > 0 ? v : -v);
    expect(tryCompileEffect(fn)).toBeDefined();
  });

  it("compiles function using logical operators", () => {
    const fn = (v: string) => v.length > 0 && v.length < 100;
    expect(tryCompileEffect(fn)).toBeDefined();
  });

  it("compiles function returning object literal", () => {
    const fn = (v: string) => ({ value: v, length: v.length });
    expect(tryCompileEffect(fn)).toBeDefined();
  });

  it("compiles function with nested destructuring in parameter", () => {
    // Nested destructuring `{ a: { b } }` — `a` is a pattern key (not a binding), `b` is bound
    const fn = ({ a: { b } }: { a: { b: number } }) => b;
    expect(tryCompileEffect(fn)).toBeDefined();
  });

  it("rejects function with ctx parameter (2+ params) even with object literal", () => {
    // Rejected because fn.length >= 2 (ctx argument)
    const fn = (val: string, ctx: { addIssue: (arg: unknown) => void }) => {
      if (val.length < 1) ctx.addIssue({ code: "custom", message: "too short" });
    };
    expect(tryCompileEffect(fn)).toBeUndefined();
  });

  it("rejects function with ctx parameter (2+ params)", () => {
    // transform(value, ctx) and superRefine(value, ctx) use Zod's ctx object
    const transformWithCtx = (v: string, _ctx: unknown) => v.toUpperCase();
    expect(tryCompileEffect(transformWithCtx)).toBeUndefined();

    const superRefineLike = (v: string, ctx: { addIssue: (arg: unknown) => void }) => {
      if (!v) ctx.addIssue({ code: "custom", message: "empty" });
    };
    expect(tryCompileEffect(superRefineLike)).toBeUndefined();
  });

  it("rejects function capturing a module-level constant", () => {
    // Simulate a module-level constant by creating in outer scope
    const MODULE_CONST = 42;
    const fn = (v: number) => v + MODULE_CONST;
    expect(tryCompileEffect(fn)).toBeUndefined();
  });

  it("compiles function with multiple local variables", () => {
    const fn = (v: string) => {
      const a = v.length;
      const b = a * 2;
      const c = b + 1;
      return c;
    };
    expect(tryCompileEffect(fn)).toBeDefined();
  });
});
