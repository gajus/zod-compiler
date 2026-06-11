import { describe, expect, it } from "vitest";
import type { ObjectIR } from "#src/core/types.js";
import { compileFastCheck, compileIR } from "../helpers.js";

describe("slow-path — object", () => {
  it("accepts valid object", () => {
    const ir: ObjectIR = {
      type: "object",
      properties: {
        name: { type: "string", checks: [] },
        age: { type: "number", checks: [] },
      },
    };
    const safeParse = compileIR(ir);
    expect(safeParse({ name: "Alice", age: 30 })).toEqual({
      success: true,
      data: { name: "Alice", age: 30 },
    });
  });

  it("rejects non-object input", () => {
    const ir: ObjectIR = { type: "object", properties: { x: { type: "string", checks: [] } } };
    const safeParse = compileIR(ir);
    expect(safeParse("not an object").success).toBe(false);
    expect(safeParse(42).success).toBe(false);
    expect(safeParse(null).success).toBe(false);
    expect(safeParse(undefined).success).toBe(false);
  });

  it("rejects array as object", () => {
    const ir: ObjectIR = { type: "object", properties: { x: { type: "string", checks: [] } } };
    const safeParse = compileIR(ir);
    expect(safeParse([]).success).toBe(false);
  });

  it("rejects when required property is missing", () => {
    const ir: ObjectIR = {
      type: "object",
      properties: {
        name: { type: "string", checks: [] },
        age: { type: "number", checks: [] },
      },
    };
    const safeParse = compileIR(ir);
    const result = safeParse({ name: "Alice" });
    expect(result.success).toBe(false);
  });

  it("rejects when property type is wrong", () => {
    const ir: ObjectIR = {
      type: "object",
      properties: {
        name: { type: "string", checks: [] },
        age: { type: "number", checks: [] },
      },
    };
    const safeParse = compileIR(ir);
    const result = safeParse({ name: "Alice", age: "thirty" });
    expect(result.success).toBe(false);
  });

  it("validates property checks", () => {
    const ir: ObjectIR = {
      type: "object",
      properties: {
        name: { type: "string", checks: [{ kind: "min_length", minimum: 3 }] },
      },
    };
    const safeParse = compileIR(ir);
    expect(safeParse({ name: "Alice" }).success).toBe(true);
    expect(safeParse({ name: "Al" }).success).toBe(false);
  });

  it("validates nested objects", () => {
    const ir: ObjectIR = {
      type: "object",
      properties: {
        user: {
          type: "object",
          properties: {
            name: { type: "string", checks: [] },
            age: { type: "number", checks: [] },
          },
        },
      },
    };
    const safeParse = compileIR(ir);
    expect(safeParse({ user: { name: "Alice", age: 30 } }).success).toBe(true);
    expect(safeParse({ user: { name: "Alice" } }).success).toBe(false);
    expect(safeParse({ user: "not an object" }).success).toBe(false);
  });

  it("provides correct path in nested errors", () => {
    const ir: ObjectIR = {
      type: "object",
      properties: {
        user: {
          type: "object",
          properties: {
            name: { type: "string", checks: [{ kind: "min_length", minimum: 3 }] },
          },
        },
      },
    };
    const safeParse = compileIR(ir);
    const result = safeParse({ user: { name: "Al" } });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]).toMatchObject({
      path: ["user", "name"],
    });
  });

  it("accepts empty object for empty schema", () => {
    const ir: ObjectIR = { type: "object", properties: {} };
    const safeParse = compileIR(ir);
    expect(safeParse({}).success).toBe(true);
  });

  it("collects multiple issues", () => {
    const ir: ObjectIR = {
      type: "object",
      properties: {
        a: { type: "string", checks: [] },
        b: { type: "number", checks: [] },
        c: { type: "boolean" },
      },
    };
    const safeParse = compileIR(ir);
    const result = safeParse({ a: 1, b: "two", c: "three" });
    expect(result.success).toBe(false);
    expect(result.error?.issues.length).toBe(3);
  });
});

describe("fast-path — Object", () => {
  it("simple object: {name: string} accepts {name: 'a'}, rejects {name: 42}", () => {
    const fn = compileFastCheck({
      type: "object",
      properties: { name: { type: "string", checks: [] } },
    });
    expect(fn?.({ name: "a" })).toBe(true);
    expect(fn?.({ name: 42 })).toBe(false);
  });

  it("rejects null", () => {
    const fn = compileFastCheck({ type: "object", properties: {} });
    expect(fn?.(null)).toBe(false);
  });

  it("rejects array", () => {
    const fn = compileFastCheck({ type: "object", properties: {} });
    expect(fn?.([])).toBe(false);
  });

  it("rejects non-object", () => {
    const fn = compileFastCheck({ type: "object", properties: {} });
    expect(fn?.("string")).toBe(false);
  });

  it("nested object", () => {
    const fn = compileFastCheck({
      type: "object",
      properties: {
        inner: { type: "object", properties: { x: { type: "number", checks: [] } } },
      },
    });
    expect(fn?.({ inner: { x: 1 } })).toBe(true);
    expect(fn?.({ inner: { x: "a" } })).toBe(false);
  });

  it("ineligible property → returns null", () => {
    expect(
      compileFastCheck({
        type: "object",
        properties: { f: { type: "fallback", reason: "transform" } },
      }),
    ).toBeNull();
  });
});

describe("strict objects (unknown-key rejection)", () => {
  const strictIR: ObjectIR = {
    type: "object",
    strict: true,
    properties: {
      name: { type: "string", checks: [] },
      age: { type: "number", checks: [] },
    },
  };

  it("slow path: accepts exact keys, passes input through", () => {
    const safeParse = compileIR(strictIR);
    const input = { name: "Alice", age: 30 };
    const result = safeParse(input);
    expect(result.success).toBe(true);
    expect(result.data).toBe(input); // pass-through, no clone
  });

  it("slow path: one unrecognized_keys issue carrying ALL unknown keys, after property issues", () => {
    const safeParse = compileIR(strictIR);
    const result = safeParse({ name: 1, age: 30, e1: true, e2: true });
    expect(result.success).toBe(false);
    const issues = result.error?.issues as { code: string; keys?: string[] }[];
    expect(issues.map((i) => i.code)).toEqual(["invalid_type", "unrecognized_keys"]);
    expect(issues[1]?.keys).toEqual(["e1", "e2"]);
  });

  it("slow path: inherited enumerable keys count (zod for-in parity)", () => {
    const safeParse = compileIR(strictIR);
    const input = Object.create({ inherited: 1 }) as Record<string, unknown>;
    input["name"] = "Alice";
    input["age"] = 30;
    const result = safeParse(input);
    expect(result.success).toBe(false);
    expect((result.error?.issues[0] as { keys?: string[] } | undefined)?.keys).toEqual([
      "inherited",
    ]);
  });

  it("slow path: >5 keys uses Set membership", () => {
    const wide: ObjectIR = {
      type: "object",
      strict: true,
      properties: Object.fromEntries(
        Array.from("abcdefg", (k) => [k, { type: "string", checks: [] }]),
      ),
    };
    const safeParse = compileIR(wide);
    const ok = Object.fromEntries(Array.from("abcdefg", (k) => [k, "v"]));
    expect(safeParse(ok).success).toBe(true);
    expect(safeParse({ ...ok, zz: "v" }).success).toBe(false);
  });

  it("fast path: strict stays eligible and rejects extras", () => {
    const fn = compileFastCheck(strictIR);
    expect(fn).not.toBeNull();
    expect(fn?.({ name: "Alice", age: 30 })).toBe(true);
    expect(fn?.({ name: "Alice", age: 30, extra: 1 })).toBe(false);
  });

  it("fast path: empty strict shape rejects any key", () => {
    const fn = compileFastCheck({ type: "object", strict: true, properties: {} });
    expect(fn?.({})).toBe(true);
    expect(fn?.({ any: 1 })).toBe(false);
  });
});
