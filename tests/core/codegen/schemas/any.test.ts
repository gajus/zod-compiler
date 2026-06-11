import { describe, expect, it } from "vitest";
import type { AnyIR } from "#src/core/types.js";
import { compileIR } from "../helpers.js";

describe("slow-path — any", () => {
  it("accepts any value", () => {
    const ir: AnyIR = { type: "any" };
    const safeParse = compileIR(ir);
    expect(safeParse("hello")).toEqual({ success: true, data: "hello" });
    expect(safeParse(42)).toEqual({ success: true, data: 42 });
    expect(safeParse(null)).toEqual({ success: true, data: null });
    expect(safeParse(undefined)).toEqual({ success: true, data: undefined });
    expect(safeParse(true)).toEqual({ success: true, data: true });
    expect(safeParse({ a: 1 })).toEqual({ success: true, data: { a: 1 } });
  });
});
