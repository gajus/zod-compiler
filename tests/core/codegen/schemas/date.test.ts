import { describe, expect, it } from "vitest";
import type { DateIR } from "#src/core/types.js";
import { compileFastCheck, compileIR } from "../helpers.js";

describe("slow-path — date", () => {
  it("accepts Date objects", () => {
    const ir: DateIR = { type: "date", checks: [] };
    const safeParse = compileIR(ir);
    expect(safeParse(new Date()).success).toBe(true);
    expect(safeParse(new Date("2024-01-01")).success).toBe(true);
  });

  it("rejects non-Date values", () => {
    const ir: DateIR = { type: "date", checks: [] };
    const safeParse = compileIR(ir);
    expect(safeParse("2024-01-01").success).toBe(false);
    expect(safeParse(123).success).toBe(false);
    expect(safeParse(null).success).toBe(false);
    expect(safeParse(undefined).success).toBe(false);
  });

  it("rejects Invalid Date", () => {
    const ir: DateIR = { type: "date", checks: [] };
    const safeParse = compileIR(ir);
    expect(safeParse(new Date("invalid")).success).toBe(false);
  });

  it("validates min date check", () => {
    const minTs = new Date("2020-01-01T00:00:00.000Z").getTime();
    const ir: DateIR = {
      type: "date",
      checks: [
        {
          kind: "date_greater_than",
          value: "2020-01-01T00:00:00.000Z",
          timestamp: minTs,
          inclusive: true,
        },
      ],
    };
    const safeParse = compileIR(ir);
    expect(safeParse(new Date("2020-01-01T00:00:00.000Z")).success).toBe(true);
    expect(safeParse(new Date("2025-01-01")).success).toBe(true);
    expect(safeParse(new Date("2019-12-31")).success).toBe(false);
  });

  it("validates max date check", () => {
    const maxTs = new Date("2030-01-01T00:00:00.000Z").getTime();
    const ir: DateIR = {
      type: "date",
      checks: [
        {
          kind: "date_less_than",
          value: "2030-01-01T00:00:00.000Z",
          timestamp: maxTs,
          inclusive: true,
        },
      ],
    };
    const safeParse = compileIR(ir);
    expect(safeParse(new Date("2030-01-01T00:00:00.000Z")).success).toBe(true);
    expect(safeParse(new Date("2025-01-01")).success).toBe(true);
    expect(safeParse(new Date("2030-01-02")).success).toBe(false);
  });

  it("validates min date check with exclusive (inclusive: false)", () => {
    const minTs = new Date("2020-01-01T00:00:00.000Z").getTime();
    const ir: DateIR = {
      type: "date",
      checks: [
        {
          kind: "date_greater_than",
          value: "2020-01-01T00:00:00.000Z",
          timestamp: minTs,
          inclusive: false,
        },
      ],
    };
    const safeParse = compileIR(ir);
    expect(safeParse(new Date("2020-01-01T00:00:00.001Z")).success).toBe(true);
    expect(safeParse(new Date("2025-01-01")).success).toBe(true);
    expect(safeParse(new Date("2020-01-01T00:00:00.000Z")).success).toBe(false);
    expect(safeParse(new Date("2019-12-31")).success).toBe(false);
  });

  it("validates max date check with exclusive (inclusive: false)", () => {
    const maxTs = new Date("2030-01-01T00:00:00.000Z").getTime();
    const ir: DateIR = {
      type: "date",
      checks: [
        {
          kind: "date_less_than",
          value: "2030-01-01T00:00:00.000Z",
          timestamp: maxTs,
          inclusive: false,
        },
      ],
    };
    const safeParse = compileIR(ir);
    expect(safeParse(new Date("2029-12-31T23:59:59.999Z")).success).toBe(true);
    expect(safeParse(new Date("2025-01-01")).success).toBe(true);
    expect(safeParse(new Date("2030-01-01T00:00:00.000Z")).success).toBe(false);
    expect(safeParse(new Date("2030-01-02")).success).toBe(false);
  });

  // H2: NaN timestamp should not silently disable date checks
  it("NaN timestamp in min check silently passes all dates (documents bug)", () => {
    const ir: DateIR = {
      type: "date",
      checks: [
        {
          kind: "date_greater_than",
          value: "invalid-date",
          timestamp: NaN,
          inclusive: true,
        },
      ],
    };
    const safeParse = compileIR(ir);
    // BUG: `input.getTime() < NaN` is always false → check never rejects
    // This date should fail the min check but passes due to NaN
    const result = safeParse(new Date("2000-01-01"));
    expect(result.success).toBe(true); // documents current broken behavior
  });

  it("NaN timestamp in max check silently passes all dates (documents bug)", () => {
    const ir: DateIR = {
      type: "date",
      checks: [
        {
          kind: "date_less_than",
          value: "invalid-date",
          timestamp: NaN,
          inclusive: true,
        },
      ],
    };
    const safeParse = compileIR(ir);
    // BUG: `input.getTime() > NaN` is always false → check never rejects
    const result = safeParse(new Date("9999-12-31"));
    expect(result.success).toBe(true); // documents current broken behavior
  });
});

describe("fast-path — date", () => {
  it("accepts Date objects", () => {
    const ir: DateIR = { type: "date", checks: [] };
    const fn = compileFastCheck(ir);
    expect(fn?.(new Date())).toBe(true);
    expect(fn?.(new Date("2024-01-01"))).toBe(true);
  });

  it("rejects non-Date values", () => {
    const ir: DateIR = { type: "date", checks: [] };
    const fn = compileFastCheck(ir);
    expect(fn?.("2024-01-01")).toBe(false);
    expect(fn?.(123)).toBe(false);
    expect(fn?.(null)).toBe(false);
    expect(fn?.(undefined)).toBe(false);
  });

  it("rejects Invalid Date", () => {
    const ir: DateIR = { type: "date", checks: [] };
    const fn = compileFastCheck(ir);
    expect(fn?.(new Date("invalid"))).toBe(false);
  });

  it("validates min date check (inclusive)", () => {
    const minTs = new Date("2020-01-01T00:00:00.000Z").getTime();
    const ir: DateIR = {
      type: "date",
      checks: [
        { kind: "date_greater_than", value: "2020-01-01", timestamp: minTs, inclusive: true },
      ],
    };
    const fn = compileFastCheck(ir);
    expect(fn?.(new Date("2020-01-01T00:00:00.000Z"))).toBe(true);
    expect(fn?.(new Date("2025-01-01"))).toBe(true);
    expect(fn?.(new Date("2019-12-31"))).toBe(false);
  });

  it("validates min date check (exclusive)", () => {
    const minTs = new Date("2020-01-01T00:00:00.000Z").getTime();
    const ir: DateIR = {
      type: "date",
      checks: [
        { kind: "date_greater_than", value: "2020-01-01", timestamp: minTs, inclusive: false },
      ],
    };
    const fn = compileFastCheck(ir);
    expect(fn?.(new Date("2020-01-01T00:00:00.001Z"))).toBe(true);
    expect(fn?.(new Date("2020-01-01T00:00:00.000Z"))).toBe(false);
  });

  it("validates max date check (inclusive)", () => {
    const maxTs = new Date("2030-01-01T00:00:00.000Z").getTime();
    const ir: DateIR = {
      type: "date",
      checks: [{ kind: "date_less_than", value: "2030-01-01", timestamp: maxTs, inclusive: true }],
    };
    const fn = compileFastCheck(ir);
    expect(fn?.(new Date("2030-01-01T00:00:00.000Z"))).toBe(true);
    expect(fn?.(new Date("2030-01-02"))).toBe(false);
  });

  it("validates max date check (exclusive)", () => {
    const maxTs = new Date("2030-01-01T00:00:00.000Z").getTime();
    const ir: DateIR = {
      type: "date",
      checks: [{ kind: "date_less_than", value: "2030-01-01", timestamp: maxTs, inclusive: false }],
    };
    const fn = compileFastCheck(ir);
    expect(fn?.(new Date("2029-12-31T23:59:59.999Z"))).toBe(true);
    expect(fn?.(new Date("2030-01-01T00:00:00.000Z"))).toBe(false);
  });

  it("returns null for coerced date", () => {
    expect(compileFastCheck({ type: "date", checks: [], coerce: true })).toBeNull();
  });
});
