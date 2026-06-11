import { describe, expect, it } from "vitest";
import type { SymbolIR } from "#src/core/types.js";
import { compileIR } from "../helpers.js";

describe("slow-path — symbol", () => {
  it("accepts symbols", () => {
    const ir: SymbolIR = { type: "symbol" };
    const safeParse = compileIR(ir);
    const sym = Symbol("test");
    const result = safeParse(sym);
    expect(result.success).toBe(true);
    expect(result.data).toBe(sym);
    expect(safeParse(Symbol.for("test")).success).toBe(true);
  });

  it("rejects non-symbol", () => {
    const ir: SymbolIR = { type: "symbol" };
    const safeParse = compileIR(ir);
    expect(safeParse("symbol").success).toBe(false);
    expect(safeParse(42).success).toBe(false);
    expect(safeParse(null).success).toBe(false);
    expect(safeParse(undefined).success).toBe(false);
  });
});
