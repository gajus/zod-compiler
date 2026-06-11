import { describe, expect, it } from "vitest";
import type { ArrayIR, NumberIR, ObjectIR, StringIR, TransformEffectIR } from "#src/core/types.js";
import { compileFastCheck, compileIR } from "../helpers.js";

describe("slow-path — transform effect", () => {
  it("applies transform to string input on success", () => {
    const ir: TransformEffectIR = {
      type: "effect",
      effectKind: "transform",
      source: "v => v.toUpperCase()",
      inner: { type: "string", checks: [] },
    };
    const safeParse = compileIR(ir);
    const result = safeParse("hello");
    expect(result.success).toBe(true);
    expect(result.data).toBe("HELLO");
  });

  it("applies parseInt transform", () => {
    const ir: TransformEffectIR = {
      type: "effect",
      effectKind: "transform",
      source: "v => parseInt(v, 10)",
      inner: { type: "string", checks: [] },
    };
    const safeParse = compileIR(ir);
    const result = safeParse("42");
    expect(result.success).toBe(true);
    expect(result.data).toBe(42);
  });

  it("skips transform when inner validation fails", () => {
    const ir: TransformEffectIR = {
      type: "effect",
      effectKind: "transform",
      source: "v => v.toUpperCase()",
      inner: { type: "string", checks: [{ kind: "min_length", minimum: 5 }] },
    };
    const safeParse = compileIR(ir);
    const result = safeParse("hi");
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]).toMatchObject({ code: "too_small" });
  });

  it("skips transform when type check fails", () => {
    const ir: TransformEffectIR = {
      type: "effect",
      effectKind: "transform",
      source: "v => v.toUpperCase()",
      inner: { type: "string", checks: [] },
    };
    const safeParse = compileIR(ir);
    const result = safeParse(42);
    expect(result.success).toBe(false);
  });

  it("applies Math.round transform on number", () => {
    const ir: TransformEffectIR = {
      type: "effect",
      effectKind: "transform",
      source: "v => Math.round(v)",
      inner: { type: "number", checks: [] },
    };
    const safeParse = compileIR(ir);
    expect(safeParse(3.7)).toEqual({ success: true, data: 4 });
    expect(safeParse(3.2)).toEqual({ success: true, data: 3 });
  });

  it("applies transform returning object literal", () => {
    const ir: TransformEffectIR = {
      type: "effect",
      effectKind: "transform",
      source: "v => ({ value: v, length: v.length })",
      inner: { type: "string", checks: [] },
    };
    const safeParse = compileIR(ir);
    const result = safeParse("abc");
    expect(result.success).toBe(true);
    expect(result.data).toEqual({ value: "abc", length: 3 });
  });

  it("applies chained string transform", () => {
    const ir: TransformEffectIR = {
      type: "effect",
      effectKind: "transform",
      source: 'v => v.trim().toLowerCase().replace(/\\s+/g, "-")',
      inner: { type: "string", checks: [] },
    };
    const safeParse = compileIR(ir);
    const result = safeParse("  Hello World  ");
    expect(result.success).toBe(true);
    expect(result.data).toBe("hello-world");
  });

  it("applies Number() coercion transform", () => {
    const ir: TransformEffectIR = {
      type: "effect",
      effectKind: "transform",
      source: "v => Number(v)",
      inner: { type: "string", checks: [] },
    };
    const safeParse = compileIR(ir);
    expect(safeParse("123")).toEqual({ success: true, data: 123 });
  });

  it("transform with inner checks validates before transforming", () => {
    const ir: TransformEffectIR = {
      type: "effect",
      effectKind: "transform",
      source: "v => v * 2",
      inner: {
        type: "number",
        checks: [
          { kind: "greater_than", value: 0, inclusive: false },
          { kind: "less_than", value: 100, inclusive: true },
        ],
      },
    };
    const safeParse = compileIR(ir);
    expect(safeParse(50)).toEqual({ success: true, data: 100 });
    expect(safeParse(0).success).toBe(false);
    expect(safeParse(101).success).toBe(false);
    expect(safeParse("not a number").success).toBe(false);
  });
});

describe("slow-path — refine effect check (string)", () => {
  it("passes when refine returns true", () => {
    const ir: StringIR = {
      type: "string",
      checks: [{ kind: "refine_effect", source: 'v => v.includes("@")' }],
    };
    const safeParse = compileIR(ir);
    expect(safeParse("a@b.com").success).toBe(true);
  });

  it("fails when refine returns false", () => {
    const ir: StringIR = {
      type: "string",
      checks: [{ kind: "refine_effect", source: 'v => v.includes("@")' }],
    };
    const safeParse = compileIR(ir);
    const result = safeParse("no-at-sign");
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]).toMatchObject({ code: "custom" });
  });

  it("refine combined with standard checks", () => {
    const ir: StringIR = {
      type: "string",
      checks: [
        { kind: "min_length", minimum: 3 },
        { kind: "refine_effect", source: "v => v.startsWith('a')" },
      ],
    };
    const safeParse = compileIR(ir);
    expect(safeParse("abc").success).toBe(true);
    expect(safeParse("ab").success).toBe(false); // too short
    expect(safeParse("bcd").success).toBe(false); // doesn't start with 'a'
  });

  it("type check fails before refine runs", () => {
    const ir: StringIR = {
      type: "string",
      checks: [{ kind: "refine_effect", source: "v => v.length > 0" }],
    };
    const safeParse = compileIR(ir);
    expect(safeParse(42).success).toBe(false);
  });
});

describe("slow-path — refine effect check (number)", () => {
  it("passes when number refine returns true", () => {
    const ir: NumberIR = {
      type: "number",
      checks: [{ kind: "refine_effect", source: "v => v % 2 === 0" }],
    };
    const safeParse = compileIR(ir);
    expect(safeParse(4).success).toBe(true);
    expect(safeParse(3).success).toBe(false);
  });

  it("refine combined with number range checks", () => {
    const ir: NumberIR = {
      type: "number",
      checks: [
        { kind: "greater_than", value: 0, inclusive: false },
        { kind: "refine_effect", source: "v => v % 2 === 0" },
      ],
    };
    const safeParse = compileIR(ir);
    expect(safeParse(4).success).toBe(true);
    expect(safeParse(3).success).toBe(false); // odd
    expect(safeParse(0).success).toBe(false); // not > 0
    expect(safeParse(-2).success).toBe(false); // not > 0
  });
});

describe("slow-path — refine effect check (object)", () => {
  it("passes when object-level refine returns true", () => {
    const ir: ObjectIR = {
      type: "object",
      properties: {
        password: { type: "string", checks: [] },
        confirm: { type: "string", checks: [] },
      },
      checks: [{ kind: "refine_effect", source: "v => v.password === v.confirm" }],
    };
    const safeParse = compileIR(ir);
    expect(safeParse({ password: "abc", confirm: "abc" }).success).toBe(true);
  });

  it("fails when object-level refine returns false", () => {
    const ir: ObjectIR = {
      type: "object",
      properties: {
        password: { type: "string", checks: [] },
        confirm: { type: "string", checks: [] },
      },
      checks: [{ kind: "refine_effect", source: "v => v.password === v.confirm" }],
    };
    const safeParse = compileIR(ir);
    const result = safeParse({ password: "abc", confirm: "xyz" });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]).toMatchObject({ code: "custom" });
  });

  it("property validation runs before object-level refine", () => {
    const ir: ObjectIR = {
      type: "object",
      properties: {
        a: { type: "string", checks: [{ kind: "min_length", minimum: 3 }] },
        b: { type: "string", checks: [] },
      },
      checks: [{ kind: "refine_effect", source: "v => v.a.length > v.b.length" }],
    };
    const safeParse = compileIR(ir);
    expect(safeParse({ a: "abcd", b: "ab" }).success).toBe(true);
    expect(safeParse({ a: "ab", b: "a" }).success).toBe(false); // min_length fails
  });

  it("multiple object-level refine checks", () => {
    const ir: ObjectIR = {
      type: "object",
      properties: {
        min: { type: "number", checks: [] },
        max: { type: "number", checks: [] },
      },
      checks: [
        { kind: "refine_effect", source: "v => v.min >= 0" },
        { kind: "refine_effect", source: "v => v.max > v.min" },
      ],
    };
    const safeParse = compileIR(ir);
    expect(safeParse({ min: 0, max: 10 }).success).toBe(true);
    expect(safeParse({ min: -1, max: 10 }).success).toBe(false);
    expect(safeParse({ min: 10, max: 5 }).success).toBe(false);
  });
});

describe("slow-path — refine custom message", () => {
  it("uses custom message when provided", () => {
    const ir: StringIR = {
      type: "string",
      checks: [
        { kind: "refine_effect", source: "v => v.includes('@')", message: "must contain @" },
      ],
    };
    const safeParse = compileIR(ir);
    const result = safeParse("no-at");
    expect(result.success).toBe(false);
    const issue = result.error?.issues[0] as { message: string };
    expect(issue.message).toBe("must contain @");
  });

  it("omits message when none provided so __zcFin applies the locale default", () => {
    // Baking a hardcoded "Invalid" would diverge from Zod ("Invalid input")
    // and, worse, block the locale default in __zcFin. Raw issues must carry no
    // message; the test harness runs __zcFin with __zcMsg undefined.
    const ir: StringIR = {
      type: "string",
      checks: [{ kind: "refine_effect", source: "v => v.includes('@')" }],
    };
    const safeParse = compileIR(ir);
    const result = safeParse("no-at");
    expect(result.success).toBe(false);
    const issue = result.error?.issues[0] as { message?: string };
    expect(issue.message).toBeUndefined();
  });
});

describe("slow-path — check ordering preserves refine_effect position", () => {
  it("refine_effect before min_length stays before min_length", () => {
    const ir: StringIR = {
      type: "string",
      checks: [
        { kind: "refine_effect", source: "v => v.startsWith('x')" },
        { kind: "min_length", minimum: 10 },
      ],
    };
    const safeParse = compileIR(ir);
    // "ab" fails both: refine (doesn't start with x) and min_length (len 2 < 10)
    const result = safeParse("ab");
    expect(result.success).toBe(false);
    const issues = result.error?.issues as { code: string }[];
    // refine_effect should be first (original order preserved)
    expect(issues[0]?.code).toBe("custom");
    expect(issues[1]?.code).toBe("too_small");
  });

  it("min_length before refine_effect: min stays first", () => {
    const ir: StringIR = {
      type: "string",
      checks: [
        { kind: "min_length", minimum: 10 },
        { kind: "refine_effect", source: "v => v.startsWith('x')" },
      ],
    };
    const safeParse = compileIR(ir);
    const result = safeParse("ab");
    expect(result.success).toBe(false);
    const issues = result.error?.issues as { code: string }[];
    expect(issues[0]?.code).toBe("too_small");
    expect(issues[1]?.code).toBe("custom");
  });
});

// ─── Fast Path — refine_effect ──────────────────────────────────────────────

describe("fast-path — refine_effect (string)", () => {
  it("passes when refine returns true", () => {
    const ir: StringIR = {
      type: "string",
      checks: [{ kind: "refine_effect", source: 'v => v.includes("@")' }],
    };
    const fn = compileFastCheck(ir);
    expect(fn?.("a@b.com")).toBe(true);
  });

  it("fails when refine returns false", () => {
    const ir: StringIR = {
      type: "string",
      checks: [{ kind: "refine_effect", source: 'v => v.includes("@")' }],
    };
    const fn = compileFastCheck(ir);
    expect(fn?.("no-at-sign")).toBe(false);
  });

  it("type check fails before refine runs", () => {
    const ir: StringIR = {
      type: "string",
      checks: [{ kind: "refine_effect", source: "v => v.length > 0" }],
    };
    const fn = compileFastCheck(ir);
    expect(fn?.(42)).toBe(false);
  });

  it("refine combined with standard checks", () => {
    const ir: StringIR = {
      type: "string",
      checks: [
        { kind: "min_length", minimum: 3 },
        { kind: "refine_effect", source: "v => v.startsWith('a')" },
      ],
    };
    const fn = compileFastCheck(ir);
    expect(fn?.("abc")).toBe(true);
    expect(fn?.("ab")).toBe(false);
    expect(fn?.("bcd")).toBe(false);
  });
});

describe("fast-path — refine_effect (number)", () => {
  it("passes when number refine returns true", () => {
    const ir: NumberIR = {
      type: "number",
      checks: [{ kind: "refine_effect", source: "v => v % 2 === 0" }],
    };
    const fn = compileFastCheck(ir);
    expect(fn?.(4)).toBe(true);
    expect(fn?.(3)).toBe(false);
  });

  it("refine combined with number range checks", () => {
    const ir: NumberIR = {
      type: "number",
      checks: [
        { kind: "greater_than", value: 0, inclusive: false },
        { kind: "refine_effect", source: "v => v % 2 === 0" },
      ],
    };
    const fn = compileFastCheck(ir);
    expect(fn?.(4)).toBe(true);
    expect(fn?.(3)).toBe(false);
    expect(fn?.(0)).toBe(false);
    expect(fn?.(-2)).toBe(false);
  });
});

describe("fast-path — refine_effect (object)", () => {
  it("passes when object-level refine returns true", () => {
    const ir: ObjectIR = {
      type: "object",
      properties: {
        password: { type: "string", checks: [] },
        confirm: { type: "string", checks: [] },
      },
      checks: [{ kind: "refine_effect", source: "v => v.password === v.confirm" }],
    };
    const fn = compileFastCheck(ir);
    expect(fn?.({ password: "abc", confirm: "abc" })).toBe(true);
  });

  it("fails when object-level refine returns false", () => {
    const ir: ObjectIR = {
      type: "object",
      properties: {
        password: { type: "string", checks: [] },
        confirm: { type: "string", checks: [] },
      },
      checks: [{ kind: "refine_effect", source: "v => v.password === v.confirm" }],
    };
    const fn = compileFastCheck(ir);
    expect(fn?.({ password: "abc", confirm: "xyz" })).toBe(false);
  });

  it("property check short-circuits before refine", () => {
    const ir: ObjectIR = {
      type: "object",
      properties: {
        a: { type: "number", checks: [] },
      },
      checks: [{ kind: "refine_effect", source: "v => v.a > 0" }],
    };
    const fn = compileFastCheck(ir);
    expect(fn?.({ a: "not a number" })).toBe(false);
  });
});

describe("fast-path — refine_effect (array)", () => {
  it("passes when array refine returns true", () => {
    const ir: ArrayIR = {
      type: "array",
      element: { type: "number", checks: [] },
      checks: [{ kind: "refine_effect", source: "arr => arr[0] < arr[arr.length - 1]" }],
    };
    const fn = compileFastCheck(ir);
    expect(fn?.([1, 2, 3])).toBe(true);
  });

  it("fails when array refine returns false", () => {
    const ir: ArrayIR = {
      type: "array",
      element: { type: "number", checks: [] },
      checks: [{ kind: "refine_effect", source: "arr => arr[0] < arr[arr.length - 1]" }],
    };
    const fn = compileFastCheck(ir);
    expect(fn?.([3, 2, 1])).toBe(false);
  });

  it("refine combined with size checks", () => {
    const ir: ArrayIR = {
      type: "array",
      element: { type: "string", checks: [] },
      checks: [
        { kind: "min_length", minimum: 1 },
        { kind: "refine_effect", source: "arr => arr.includes('x')" },
      ],
    };
    const fn = compileFastCheck(ir);
    expect(fn?.(["x", "y"])).toBe(true);
    expect(fn?.(["a", "b"])).toBe(false);
    expect(fn?.([])).toBe(false);
  });
});
