import { describe, expect, it } from "vitest";
import type { NullIR } from "#src/core/types.js";
import { compileIR } from "../helpers.js";

describe("slow-path — null", () => {
  it("accepts null", () => {
    const ir: NullIR = { type: "null" };
    const safeParse = compileIR(ir);
    expect(safeParse(null)).toEqual({ success: true, data: null });
  });

  it("rejects non-null", () => {
    const ir: NullIR = { type: "null" };
    const safeParse = compileIR(ir);
    expect(safeParse(undefined).success).toBe(false);
    expect(safeParse(0).success).toBe(false);
    expect(safeParse("").success).toBe(false);
  });
});
