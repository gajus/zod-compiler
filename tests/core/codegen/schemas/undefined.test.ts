import { describe, expect, it } from "vitest";
import type { UndefinedIR } from "#src/core/types.js";
import { compileIR } from "../helpers.js";

describe("slow-path — undefined", () => {
  it("accepts undefined", () => {
    const ir: UndefinedIR = { type: "undefined" };
    const safeParse = compileIR(ir);
    expect(safeParse(undefined)).toEqual({ success: true, data: undefined });
  });

  it("rejects non-undefined", () => {
    const ir: UndefinedIR = { type: "undefined" };
    const safeParse = compileIR(ir);
    expect(safeParse(null).success).toBe(false);
    expect(safeParse(0).success).toBe(false);
  });
});
