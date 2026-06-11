import { describe, expect, it } from "vitest";
import type { VoidIR } from "#src/core/types.js";
import { compileIR } from "../helpers.js";

describe("slow-path — void", () => {
  it("accepts undefined", () => {
    const ir: VoidIR = { type: "void" };
    const safeParse = compileIR(ir);
    expect(safeParse(undefined)).toEqual({ success: true, data: undefined });
  });

  it("rejects non-undefined", () => {
    const ir: VoidIR = { type: "void" };
    const safeParse = compileIR(ir);
    expect(safeParse(null).success).toBe(false);
    expect(safeParse(0).success).toBe(false);
    expect(safeParse("").success).toBe(false);
    expect(safeParse(false).success).toBe(false);
  });
});
