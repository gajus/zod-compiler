import { describe, expect, it } from "vitest";
import type { NanIR } from "#src/core/types.js";
import { compileIR } from "../helpers.js";

describe("slow-path — nan", () => {
  it("accepts NaN", () => {
    const ir: NanIR = { type: "nan" };
    const safeParse = compileIR(ir);
    const result = safeParse(NaN);
    expect(result.success).toBe(true);
  });

  it("rejects non-NaN", () => {
    const ir: NanIR = { type: "nan" };
    const safeParse = compileIR(ir);
    expect(safeParse(0).success).toBe(false);
    expect(safeParse(42).success).toBe(false);
    expect(safeParse(Infinity).success).toBe(false);
    expect(safeParse("NaN").success).toBe(false);
    expect(safeParse(null).success).toBe(false);
    expect(safeParse(undefined).success).toBe(false);
  });
});
