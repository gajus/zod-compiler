import { describe, expect, it } from "vitest";
import type { CatchIR } from "#src/core/types.js";
import { compileFastCheck, compileIR } from "../helpers.js";

/** Stub of a z.catch() schema exposing catchValue through the __rf table. */
function catchRef(value: unknown): unknown {
  return { _zod: { def: { catchValue: () => value } } };
}

describe("slow-path — catch", () => {
  it("returns data when inner validation passes", () => {
    const ir: CatchIR = {
      type: "catch",
      inner: { type: "string", checks: [] },
      refIndex: 0,
    };
    const safeParse = compileIR(ir, "test", [catchRef("default")]);
    expect(safeParse("hello")).toEqual({ success: true, data: "hello" });
  });

  it("returns the runtime catch value when inner validation fails", () => {
    const ir: CatchIR = {
      type: "catch",
      inner: { type: "string", checks: [] },
      refIndex: 0,
    };
    const safeParse = compileIR(ir, "test", [catchRef("default")]);
    const result = safeParse(42);
    expect(result.success).toBe(true);
    expect(result.data).toBe("default");
  });

  it("returns numeric catch value on failure", () => {
    const ir: CatchIR = {
      type: "catch",
      inner: { type: "number", checks: [] },
      refIndex: 0,
    };
    const safeParse = compileIR(ir, "test", [catchRef(0)]);
    const result = safeParse("abc");
    expect(result.success).toBe(true);
    expect(result.data).toBe(0);
  });

  it("returns false as catch value on failure", () => {
    const ir: CatchIR = {
      type: "catch",
      inner: { type: "boolean" },
      refIndex: 0,
    };
    const safeParse = compileIR(ir, "test", [catchRef(false)]);
    const result = safeParse("not-a-boolean");
    expect(result.success).toBe(true);
    expect(result.data).toBe(false);
  });

  it("returns null as catch value on failure", () => {
    const ir: CatchIR = {
      type: "catch",
      inner: { type: "string", checks: [] },
      refIndex: 0,
    };
    const safeParse = compileIR(ir, "test", [catchRef(null)]);
    const result = safeParse(42);
    expect(result.success).toBe(true);
    expect(result.data).toBeNull();
  });

  it("returns undefined as catch value on failure", () => {
    const ir: CatchIR = {
      type: "catch",
      inner: { type: "string", checks: [] },
      refIndex: 0,
    };
    const safeParse = compileIR(ir, "test", [catchRef(undefined)]);
    const result = safeParse(42);
    expect(result.success).toBe(true);
    expect(result.data).toBeUndefined();
  });

  it("returns object as catch value on failure", () => {
    const ir: CatchIR = {
      type: "catch",
      inner: {
        type: "object",
        properties: { name: { type: "string", checks: [] } },
      },
      refIndex: 0,
    };
    const safeParse = compileIR(ir, "test", [catchRef({ name: "anon" })]);
    const result = safeParse("not-an-object");
    expect(result.success).toBe(true);
    expect(result.data).toEqual({ name: "anon" });
  });

  it("catch value functions receive the failure ctx per parse", () => {
    const ir: CatchIR = {
      type: "catch",
      inner: { type: "number", checks: [] },
      refIndex: 0,
    };
    const ctxCatch = {
      _zod: { def: { catchValue: (ctx: { issues: unknown[] }) => ctx.issues.length } },
    };
    const safeParse = compileIR(ir, "test", [ctxCatch]);
    const result = safeParse("nope");
    expect(result.success).toBe(true);
    expect(result.data).toBe(1);
  });

  it("non-function catchValue is used as-is", () => {
    const ir: CatchIR = {
      type: "catch",
      inner: { type: "string", checks: [] },
      refIndex: 0,
    };
    const rawValue = { _zod: { def: { catchValue: "plain" } } };
    const safeParse = compileIR(ir, "test", [rawValue]);
    const result = safeParse(42);
    expect(result.success).toBe(true);
    expect(result.data).toBe("plain");
  });

  it("catch with inner checks — inner fails check", () => {
    const ir: CatchIR = {
      type: "catch",
      inner: { type: "string", checks: [{ kind: "min_length", minimum: 5 }] },
      refIndex: 0,
    };
    const safeParse = compileIR(ir, "test", [catchRef("short")]);
    // "ab" is a string but fails min_length check → catch returns the value
    const result = safeParse("ab");
    expect(result.success).toBe(true);
    expect(result.data).toBe("short");
  });

  it("catch with inner checks — inner passes check", () => {
    const ir: CatchIR = {
      type: "catch",
      inner: { type: "string", checks: [{ kind: "min_length", minimum: 5 }] },
      refIndex: 0,
    };
    const safeParse = compileIR(ir, "test", [catchRef("short")]);
    const result = safeParse("hello world");
    expect(result.success).toBe(true);
    expect(result.data).toBe("hello world");
  });

  it("nested catch in object", () => {
    const ir = {
      type: "object" as const,
      properties: {
        name: {
          type: "catch" as const,
          inner: { type: "string" as const, checks: [] },
          refIndex: 0,
        },
        age: {
          type: "catch" as const,
          inner: { type: "number" as const, checks: [] },
          refIndex: 1,
        },
      },
    };
    const safeParse = compileIR(ir, "test", [catchRef("anonymous"), catchRef(0)]);
    const result = safeParse({ name: 42, age: "abc" });
    expect(result.success).toBe(true);
    expect(result.data).toEqual({ name: "anonymous", age: 0 });
  });
});

describe("fast-path — catch", () => {
  it("accepts valid input via fast path", () => {
    const fn = compileFastCheck({
      type: "catch",
      inner: { type: "string", checks: [] },
      refIndex: 0,
    });
    expect(fn).not.toBeNull();
    expect(fn?.("hello")).toBe(true);
  });

  it("rejects invalid input (delegates to slow path for catch value)", () => {
    const fn = compileFastCheck({
      type: "catch",
      inner: { type: "string", checks: [] },
      refIndex: 0,
    });
    expect(fn).not.toBeNull();
    expect(fn?.(42)).toBe(false);
  });

  it("validates inner checks", () => {
    const fn = compileFastCheck({
      type: "catch",
      inner: { type: "string", checks: [{ kind: "min_length", minimum: 3 }] },
      refIndex: 0,
    });
    expect(fn).not.toBeNull();
    expect(fn?.("abc")).toBe(true);
    expect(fn?.("ab")).toBe(false);
  });

  it("ineligible inner → returns null", () => {
    expect(
      compileFastCheck({
        type: "catch",
        inner: { type: "fallback", reason: "transform" },
        refIndex: 0,
      }),
    ).toBeNull();
  });

  it("nested catch inside object — object gains fast path", () => {
    const fn = compileFastCheck({
      type: "object",
      properties: {
        name: {
          type: "catch",
          inner: { type: "string", checks: [] },
          refIndex: 0,
        },
      },
    });
    expect(fn).not.toBeNull();
    expect(fn?.({ name: "hello" })).toBe(true);
  });

  it("end-to-end: fast path + slow path produce correct results", () => {
    const ir: CatchIR = {
      type: "catch",
      inner: { type: "string", checks: [] },
      refIndex: 0,
    };
    const safeParse = compileIR(ir, "test", [catchRef("fallback")]);

    // Valid input: fast path → success with input value
    expect(safeParse("hello")).toEqual({ success: true, data: "hello" });

    // Invalid input: slow path applies the runtime catch value
    expect(safeParse(42)).toEqual({ success: true, data: "fallback" });
  });
});
