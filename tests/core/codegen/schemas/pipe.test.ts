import { describe, expect, it } from "vitest";
import type { PipeIR } from "#src/core/types.js";
import { compileFastCheck, compileIR } from "../helpers.js";

describe("slow-path — pipe (non-transform)", () => {
  it("validates input through both schemas", () => {
    const ir: PipeIR = {
      type: "pipe",
      in: { type: "string", checks: [] },
      out: { type: "string", checks: [{ kind: "min_length", minimum: 3 }] },
    };
    const safeParse = compileIR(ir);
    expect(safeParse("hello").success).toBe(true);
    expect(safeParse("ab").success).toBe(false);
    expect(safeParse(42).success).toBe(false);
  });

  it("rejects when input schema fails", () => {
    const ir: PipeIR = {
      type: "pipe",
      in: { type: "number", checks: [{ kind: "greater_than", value: 0, inclusive: false }] },
      out: { type: "number", checks: [] },
    };
    const safeParse = compileIR(ir);
    expect(safeParse(5).success).toBe(true);
    expect(safeParse(0).success).toBe(false);
    expect(safeParse("not number").success).toBe(false);
  });

  it("rejects when output schema fails", () => {
    const ir: PipeIR = {
      type: "pipe",
      in: { type: "string", checks: [] },
      out: { type: "string", checks: [{ kind: "max_length", maximum: 5 }] },
    };
    const safeParse = compileIR(ir);
    expect(safeParse("short").success).toBe(true);
    expect(safeParse("too long string").success).toBe(false);
  });

  it("pipes different compatible types (number → number with checks)", () => {
    const ir: PipeIR = {
      type: "pipe",
      in: { type: "number", checks: [] },
      out: {
        type: "number",
        checks: [
          { kind: "greater_than", value: 0, inclusive: true },
          { kind: "less_than", value: 100, inclusive: true },
        ],
      },
    };
    const safeParse = compileIR(ir);
    expect(safeParse(50).success).toBe(true);
    expect(safeParse(0).success).toBe(true);
    expect(safeParse(100).success).toBe(true);
    expect(safeParse(-1).success).toBe(false);
    expect(safeParse(101).success).toBe(false);
  });
});

describe("fast-path — Pipe", () => {
  it("pipe(string, string): accepts 'a', rejects 42", () => {
    const fn = compileFastCheck({
      type: "pipe",
      in: { type: "string", checks: [] },
      out: { type: "string", checks: [] },
    });
    expect(fn?.("a")).toBe(true);
    expect(fn?.(42)).toBe(false);
  });

  it("pipe(any, string): in is 'true', returns out only", () => {
    const fn = compileFastCheck({
      type: "pipe",
      in: { type: "any" },
      out: { type: "string", checks: [] },
    });
    expect(fn?.("hello")).toBe(true);
    expect(fn?.(42)).toBe(false);
  });

  it("pipe(string, any): out is 'true', returns in only", () => {
    const fn = compileFastCheck({
      type: "pipe",
      in: { type: "string", checks: [] },
      out: { type: "any" },
    });
    expect(fn?.("hello")).toBe(true);
    expect(fn?.(42)).toBe(false);
  });

  it("pipe with ineligible in → returns null", () => {
    expect(
      compileFastCheck({
        type: "pipe",
        in: { type: "fallback", reason: "transform" },
        out: { type: "string", checks: [] },
      }),
    ).toBeNull();
  });

  it("pipe with ineligible out → returns null", () => {
    expect(
      compileFastCheck({
        type: "pipe",
        in: { type: "string", checks: [] },
        out: { type: "fallback", reason: "transform" },
      }),
    ).toBeNull();
  });
});
