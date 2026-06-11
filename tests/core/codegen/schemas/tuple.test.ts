import { describe, expect, it } from "vitest";
import type { TupleIR } from "#src/core/types.js";
import { compileFastCheck, compileIR } from "../helpers.js";

describe("slow-path — tuple", () => {
  it("accepts valid tuple", () => {
    const ir: TupleIR = {
      type: "tuple",
      items: [
        { type: "string", checks: [] },
        { type: "number", checks: [] },
      ],
      rest: null,
    };
    const safeParse = compileIR(ir);
    expect(safeParse(["hello", 42]).success).toBe(true);
  });

  it("rejects non-array", () => {
    const ir: TupleIR = {
      type: "tuple",
      items: [{ type: "string", checks: [] }],
      rest: null,
    };
    const safeParse = compileIR(ir);
    expect(safeParse("not array").success).toBe(false);
    expect(safeParse(null).success).toBe(false);
    expect(safeParse({}).success).toBe(false);
  });

  it("rejects wrong element type", () => {
    const ir: TupleIR = {
      type: "tuple",
      items: [
        { type: "string", checks: [] },
        { type: "number", checks: [] },
      ],
      rest: null,
    };
    const safeParse = compileIR(ir);
    expect(safeParse([42, "hello"]).success).toBe(false);
  });

  it("rejects extra elements without rest", () => {
    const ir: TupleIR = {
      type: "tuple",
      items: [{ type: "string", checks: [] }],
      rest: null,
    };
    const safeParse = compileIR(ir);
    expect(safeParse(["a", "b"]).success).toBe(false);
  });

  it("accepts extra elements with rest", () => {
    const ir: TupleIR = {
      type: "tuple",
      items: [{ type: "string", checks: [] }],
      rest: { type: "number", checks: [] },
    };
    const safeParse = compileIR(ir);
    expect(safeParse(["a", 1, 2, 3]).success).toBe(true);
  });

  it("validates rest element types", () => {
    const ir: TupleIR = {
      type: "tuple",
      items: [{ type: "string", checks: [] }],
      rest: { type: "number", checks: [] },
    };
    const safeParse = compileIR(ir);
    expect(safeParse(["a", 1, "bad"]).success).toBe(false);
  });

  it("provides correct path for element errors", () => {
    const ir: TupleIR = {
      type: "tuple",
      items: [
        { type: "string", checks: [] },
        { type: "number", checks: [] },
      ],
      rest: null,
    };
    const safeParse = compileIR(ir);
    const result = safeParse(["hello", "not a number"]);
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]).toMatchObject({ path: [1] });
  });

  // H3: Tuple should reject arrays with fewer elements than required
  it("rejects array with fewer elements than required (no rest)", () => {
    const ir: TupleIR = {
      type: "tuple",
      items: [
        { type: "string", checks: [] },
        { type: "number", checks: [] },
      ],
      rest: null,
    };
    const safeParse = compileIR(ir);
    // Missing second element — should fail
    const result = safeParse(["hello"]);
    expect(result.success).toBe(false);
    // Should have a meaningful error, ideally "too_small" rather than just
    // "Expected number, received undefined" for element [1]
    expect(result.error?.issues.length).toBeGreaterThanOrEqual(1);
  });

  it("rejects empty array for non-empty tuple", () => {
    const ir: TupleIR = {
      type: "tuple",
      items: [{ type: "string", checks: [] }],
      rest: null,
    };
    const safeParse = compileIR(ir);
    const result = safeParse([]);
    expect(result.success).toBe(false);
  });

  it("rejects array with fewer elements than required (with rest)", () => {
    const ir: TupleIR = {
      type: "tuple",
      items: [
        { type: "string", checks: [] },
        { type: "number", checks: [] },
      ],
      rest: { type: "boolean" },
    };
    const safeParse = compileIR(ir);
    // Even with rest, the required items must be present
    const result = safeParse(["hello"]);
    expect(result.success).toBe(false);
  });
});

describe("fast-path — Tuple", () => {
  it("[string, number]: accepts ['a', 1], rejects ['a', 'b']", () => {
    const fn = compileFastCheck({
      type: "tuple",
      items: [
        { type: "string", checks: [] },
        { type: "number", checks: [] },
      ],
      rest: null,
    });
    expect(fn?.(["a", 1])).toBe(true);
    expect(fn?.(["a", "b"])).toBe(false);
  });

  it("exact length (no rest): rejects extra elements", () => {
    const fn = compileFastCheck({
      type: "tuple",
      items: [{ type: "string", checks: [] }],
      rest: null,
    });
    expect(fn?.(["a"])).toBe(true);
    expect(fn?.(["a", "b"])).toBe(false);
  });

  it("with rest element", () => {
    const fn = compileFastCheck({
      type: "tuple",
      items: [{ type: "string", checks: [] }],
      rest: { type: "number", checks: [] },
    });
    expect(fn?.(["a", 1, 2])).toBe(true);
    expect(fn?.(["a", 1, "b"])).toBe(false);
  });

  it("items with 'any' type skip per-index check", () => {
    const fn = compileFastCheck({
      type: "tuple",
      items: [{ type: "any" }, { type: "string", checks: [] }],
      rest: null,
    });
    expect(fn?.([42, "hello"])).toBe(true);
    expect(fn?.([42, 123])).toBe(false);
  });

  it("rest element with 'any' type skips .every()", () => {
    const fn = compileFastCheck({
      type: "tuple",
      items: [{ type: "string", checks: [] }],
      rest: { type: "any" },
    });
    expect(fn?.(["a", 1, true, null])).toBe(true);
    expect(fn?.([42, 1, true])).toBe(false);
  });

  it("ineligible rest element → returns null", () => {
    expect(
      compileFastCheck({
        type: "tuple",
        items: [{ type: "string", checks: [] }],
        rest: { type: "fallback", reason: "transform" },
      }),
    ).toBeNull();
  });

  it("ineligible item → returns null", () => {
    expect(
      compileFastCheck({
        type: "tuple",
        items: [{ type: "fallback", reason: "transform" }],
        rest: null,
      }),
    ).toBeNull();
  });
});
