import { describe, expect, it } from "vitest";
import type { IntersectionIR } from "#src/core/types.js";
import { compileFastCheck, compileIR } from "../helpers.js";

describe("slow-path — intersection", () => {
  it("accepts value matching both sides", () => {
    const ir: IntersectionIR = {
      type: "intersection",
      left: { type: "object", properties: { a: { type: "string", checks: [] } } },
      right: { type: "object", properties: { b: { type: "number", checks: [] } } },
    };
    const safeParse = compileIR(ir);
    expect(safeParse({ a: "hello", b: 42 }).success).toBe(true);
  });

  it("rejects value missing left side property", () => {
    const ir: IntersectionIR = {
      type: "intersection",
      left: { type: "object", properties: { a: { type: "string", checks: [] } } },
      right: { type: "object", properties: { b: { type: "number", checks: [] } } },
    };
    const safeParse = compileIR(ir);
    expect(safeParse({ b: 42 }).success).toBe(false);
  });

  it("rejects value missing right side property", () => {
    const ir: IntersectionIR = {
      type: "intersection",
      left: { type: "object", properties: { a: { type: "string", checks: [] } } },
      right: { type: "object", properties: { b: { type: "number", checks: [] } } },
    };
    const safeParse = compileIR(ir);
    expect(safeParse({ a: "hello" }).success).toBe(false);
  });

  it("collects issues from both sides", () => {
    const ir: IntersectionIR = {
      type: "intersection",
      left: { type: "object", properties: { a: { type: "string", checks: [] } } },
      right: { type: "object", properties: { b: { type: "number", checks: [] } } },
    };
    const safeParse = compileIR(ir);
    const result = safeParse({ a: 42, b: "not number" });
    expect(result.success).toBe(false);
    expect(result.error?.issues.length).toBeGreaterThanOrEqual(2);
  });
});

describe("fast-path — Intersection", () => {
  it("{a:string} & {b:number}: accepts {a:'x',b:1}, rejects {a:1,b:1}", () => {
    const fn = compileFastCheck({
      type: "intersection",
      left: { type: "object", properties: { a: { type: "string", checks: [] } } },
      right: { type: "object", properties: { b: { type: "number", checks: [] } } },
    });
    expect(fn?.({ a: "x", b: 1 })).toBe(true);
    expect(fn?.({ a: 1, b: 1 })).toBe(false);
  });

  it("any & string: left is 'true', returns right only", () => {
    const fn = compileFastCheck({
      type: "intersection",
      left: { type: "any" },
      right: { type: "string", checks: [] },
    });
    expect(fn?.("hello")).toBe(true);
    expect(fn?.(42)).toBe(false);
  });

  it("string & any: right is 'true', returns left only", () => {
    const fn = compileFastCheck({
      type: "intersection",
      left: { type: "string", checks: [] },
      right: { type: "any" },
    });
    expect(fn?.("hello")).toBe(true);
    expect(fn?.(42)).toBe(false);
  });

  it("ineligible left → returns null", () => {
    expect(
      compileFastCheck({
        type: "intersection",
        left: { type: "fallback", reason: "transform" },
        right: { type: "object", properties: {} },
      }),
    ).toBeNull();
  });

  it("ineligible right → returns null", () => {
    expect(
      compileFastCheck({
        type: "intersection",
        left: { type: "object", properties: {} },
        right: { type: "fallback", reason: "transform" },
      }),
    ).toBeNull();
  });
});
