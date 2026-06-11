import { describe, expect, it } from "vitest";
import { generateValidator } from "#src/core/codegen/index.js";
import type { EnumIR } from "#src/core/types.js";
import { compileFastCheck, compileIR } from "../helpers.js";

describe("slow-path — enum", () => {
  it("accepts valid enum values", () => {
    const ir: EnumIR = { type: "enum", values: ["admin", "user", "guest"] };
    const safeParse = compileIR(ir);
    expect(safeParse("admin").success).toBe(true);
    expect(safeParse("user").success).toBe(true);
    expect(safeParse("guest").success).toBe(true);
  });

  it("rejects invalid enum values", () => {
    const ir: EnumIR = { type: "enum", values: ["admin", "user", "guest"] };
    const safeParse = compileIR(ir);
    expect(safeParse("superadmin").success).toBe(false);
    expect(safeParse("").success).toBe(false);
    expect(safeParse(42).success).toBe(false);
    expect(safeParse(null).success).toBe(false);
  });

  it("generates Set-based lookup for enums with 6+ values", () => {
    const ir: EnumIR = { type: "enum", values: ["a", "b", "c", "d", "e", "f"] };
    const result = generateValidator(ir, "enumTest");
    expect(result.code).toContain("Set");
  });

  it("generates inline equality checks for enums with 1-5 values", () => {
    const ir: EnumIR = { type: "enum", values: ["admin", "user", "guest", "owner", "bot"] };
    const result = generateValidator(ir, "enumSmall");
    expect(result.code).not.toContain("Set");
    // The slow walk is hosted in the preamble (result.code) for non-recursive
    // fast-path schemas; search both halves.
    expect(result.code + result.functionDef).toContain('!=="admin"');
    expect(result.code + result.functionDef).toContain('!=="bot"');
  });

  it("inline enum accepts valid values", () => {
    const ir: EnumIR = { type: "enum", values: ["yes", "no"] };
    const safeParse = compileIR(ir);
    expect(safeParse("yes").success).toBe(true);
    expect(safeParse("no").success).toBe(true);
    expect(safeParse("maybe").success).toBe(false);
  });
});

describe("fast-path — Enum", () => {
  it("small enum (<=3): accepts 'a', rejects 'd'", () => {
    const fn = compileFastCheck({ type: "enum", values: ["a", "b", "c"] });
    expect(fn?.("a")).toBe(true);
    expect(fn?.("d")).toBe(false);
  });

  it("large enum (>3): accepts 'a', rejects 'e'", () => {
    const fn = compileFastCheck({ type: "enum", values: ["a", "b", "c", "d"] });
    expect(fn?.("a")).toBe(true);
    expect(fn?.("e")).toBe(false);
  });

  it("single-value enum", () => {
    const fn = compileFastCheck({ type: "enum", values: ["only"] });
    expect(fn?.("only")).toBe(true);
    expect(fn?.("other")).toBe(false);
  });
});
