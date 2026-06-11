import { describe, expect, it } from "vitest";
import type { RecordIR } from "#src/core/types.js";
import { compileFastCheck, compileIR } from "../helpers.js";

describe("slow-path — record", () => {
  it("accepts valid record", () => {
    const ir: RecordIR = {
      type: "record",
      keyType: { type: "string", checks: [] },
      valueType: { type: "number", checks: [] },
    };
    const safeParse = compileIR(ir);
    expect(safeParse({ a: 1, b: 2 }).success).toBe(true);
  });

  it("accepts empty object", () => {
    const ir: RecordIR = {
      type: "record",
      keyType: { type: "string", checks: [] },
      valueType: { type: "number", checks: [] },
    };
    const safeParse = compileIR(ir);
    expect(safeParse({}).success).toBe(true);
  });

  it("rejects non-object", () => {
    const ir: RecordIR = {
      type: "record",
      keyType: { type: "string", checks: [] },
      valueType: { type: "number", checks: [] },
    };
    const safeParse = compileIR(ir);
    expect(safeParse("not object").success).toBe(false);
    expect(safeParse(null).success).toBe(false);
    expect(safeParse([]).success).toBe(false);
  });

  it("rejects invalid value type", () => {
    const ir: RecordIR = {
      type: "record",
      keyType: { type: "string", checks: [] },
      valueType: { type: "number", checks: [] },
    };
    const safeParse = compileIR(ir);
    expect(safeParse({ a: "not number" }).success).toBe(false);
  });

  // Value error should have path pointing to the key
  it("reports value error path pointing to the key", () => {
    const ir: RecordIR = {
      type: "record",
      keyType: { type: "string", checks: [] },
      valueType: { type: "number", checks: [] },
    };
    const safeParse = compileIR(ir);
    const result = safeParse({ myKey: "not-a-number" });
    expect(result.success).toBe(false);
    const valueIssue = result.error?.issues.find(
      (i) => (i as Record<string, unknown>)["expected"] === "number",
    ) as Record<string, unknown> | undefined;
    expect(valueIssue).toBeDefined();
    expect(valueIssue?.["path"]).toEqual(["myKey"]);
  });

  it("validates key type constraints", () => {
    const ir: RecordIR = {
      type: "record",
      keyType: { type: "string", checks: [{ kind: "min_length", minimum: 3 }] },
      valueType: { type: "number", checks: [] },
    };
    const safeParse = compileIR(ir);
    // Key "ab" is too short (min 3)
    expect(safeParse({ ab: 1 }).success).toBe(false);
    // Key "abc" is fine
    expect(safeParse({ abc: 1 }).success).toBe(true);
  });

  it("wraps key errors in invalid_key issue (matches Zod)", () => {
    const ir: RecordIR = {
      type: "record",
      keyType: { type: "string", checks: [{ kind: "min_length", minimum: 5 }] },
      valueType: { type: "number", checks: [] },
    };
    const safeParse = compileIR(ir);
    const result = safeParse({ ab: 1 });
    expect(result.success).toBe(false);
    const issue = result.error?.issues[0] as Record<string, unknown>;
    expect(issue["code"]).toBe("invalid_key");
    expect(issue["origin"]).toBe("record");
    expect(issue["path"]).toEqual(["ab"]);
    expect(Array.isArray(issue["issues"])).toBe(true);
    const inner = (issue["issues"] as Record<string, unknown>[])[0];
    expect(inner).toBeDefined();
    expect(inner?.["code"]).toBe("too_small");
  });

  it("short-circuits on key error — does not validate value (matches Zod)", () => {
    const ir: RecordIR = {
      type: "record",
      keyType: { type: "string", checks: [{ kind: "min_length", minimum: 5 }] },
      valueType: { type: "number", checks: [] },
    };
    const safeParse = compileIR(ir);
    // Key "ab" is too short AND value is wrong type
    const result = safeParse({ ab: "not-a-number" });
    expect(result.success).toBe(false);
    // Zod only reports the key error (short-circuits)
    expect(result.error?.issues.length).toBe(1);
    expect((result.error?.issues[0] as Record<string, unknown> | undefined)?.["code"]).toBe(
      "invalid_key",
    );
  });
});

describe("fast-path — Record", () => {
  it("Record<string, number>: accepts {a: 1}, rejects {a: 'x'}", () => {
    const fn = compileFastCheck({
      type: "record",
      keyType: { type: "string", checks: [] },
      valueType: { type: "number", checks: [] },
    });
    expect(fn?.({ a: 1 })).toBe(true);
    expect(fn?.({ a: "x" })).toBe(false);
  });

  it("rejects null", () => {
    const fn = compileFastCheck({
      type: "record",
      keyType: { type: "string", checks: [] },
      valueType: { type: "any" },
    });
    expect(fn?.(null)).toBe(false);
  });

  it("rejects non-object", () => {
    const fn = compileFastCheck({
      type: "record",
      keyType: { type: "string", checks: [] },
      valueType: { type: "any" },
    });
    expect(fn?.("string")).toBe(false);
  });

  it("Record<any, any>: both key and value are 'true', skips .every()", () => {
    const fn = compileFastCheck({
      type: "record",
      keyType: { type: "any" },
      valueType: { type: "any" },
    });
    expect(fn?.({ a: 1, b: "x" })).toBe(true);
    expect(fn?.(null)).toBe(false);
  });

  it("Record<any, number>: only value check in .every()", () => {
    const fn = compileFastCheck({
      type: "record",
      keyType: { type: "any" },
      valueType: { type: "number", checks: [] },
    });
    expect(fn?.({ a: 1, b: 2 })).toBe(true);
    expect(fn?.({ a: "x" })).toBe(false);
  });

  it("ineligible key → returns null", () => {
    expect(
      compileFastCheck({
        type: "record",
        keyType: { type: "fallback", reason: "transform" },
        valueType: { type: "number", checks: [] },
      }),
    ).toBeNull();
  });

  it("ineligible value → returns null", () => {
    expect(
      compileFastCheck({
        type: "record",
        keyType: { type: "string", checks: [] },
        valueType: { type: "fallback", reason: "transform" },
      }),
    ).toBeNull();
  });
});
