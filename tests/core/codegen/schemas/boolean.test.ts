import { describe, expect, it } from "vitest";
import type { BooleanIR } from "#src/core/types.js";
import { compileIR } from "../helpers.js";

describe("slow-path — boolean", () => {
  it("accepts true and false", () => {
    const ir: BooleanIR = { type: "boolean" };
    const safeParse = compileIR(ir);
    expect(safeParse(true)).toEqual({ success: true, data: true });
    expect(safeParse(false)).toEqual({ success: true, data: false });
  });

  it("rejects non-boolean", () => {
    const ir: BooleanIR = { type: "boolean" };
    const safeParse = compileIR(ir);
    expect(safeParse(0).success).toBe(false);
    expect(safeParse("true").success).toBe(false);
    expect(safeParse(null).success).toBe(false);
  });
});
