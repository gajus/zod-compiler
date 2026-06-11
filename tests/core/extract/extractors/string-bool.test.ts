import { describe, expect, it } from "vitest";
import { z } from "zod";
import { isStringBoolCodec } from "#src/core/extract/extractors/string-bool.js";
import { extractSchema } from "#src/core/extract/index.js";
import type { StringBoolIR } from "#src/core/types.js";
import { zodAtLeast } from "../../../zod-version.js";

describe("isStringBoolCodec", () => {
  it("returns false for empty def", () => {
    expect(isStringBoolCodec({} as never)).toBe(false);
  });

  it("returns false when transform is missing", () => {
    expect(
      isStringBoolCodec({
        reverseTransform: () => undefined,
        in: { _zod: { def: { type: "string" } } },
        out: { _zod: { def: { type: "boolean" } } },
      } as never),
    ).toBe(false);
  });

  it("returns false when reverseTransform is missing", () => {
    expect(
      isStringBoolCodec({
        transform: () => undefined,
        in: { _zod: { def: { type: "string" } } },
        out: { _zod: { def: { type: "boolean" } } },
      } as never),
    ).toBe(false);
  });

  it("returns false when in type is not string", () => {
    expect(
      isStringBoolCodec({
        transform: () => undefined,
        reverseTransform: () => undefined,
        in: { _zod: { def: { type: "number" } } },
        out: { _zod: { def: { type: "boolean" } } },
      } as never),
    ).toBe(false);
  });

  it("returns false when out type is not boolean", () => {
    expect(
      isStringBoolCodec({
        transform: () => undefined,
        reverseTransform: () => undefined,
        in: { _zod: { def: { type: "string" } } },
        out: { _zod: { def: { type: "number" } } },
      } as never),
    ).toBe(false);
  });

  it.skipIf(!zodAtLeast("4.1"))("returns true for z.stringbool() def", () => {
    const def = z.stringbool()._zod.def;
    expect(isStringBoolCodec(def as never)).toBe(true);
  });
});

// stringBool codec pattern (reverseTransform) requires Zod >= 4.1
describe.skipIf(!zodAtLeast("4.1"))("extractSchema — stringBool", () => {
  it("extracts default stringbool", () => {
    const ir = extractSchema(z.stringbool()) as StringBoolIR;
    expect(ir.type).toBe("stringBool");
    expect(ir.caseSensitive).toBe(false);
    expect(ir.truthy).toContain("true");
    expect(ir.truthy).toContain("1");
    expect(ir.truthy).toContain("yes");
    expect(ir.falsy).toContain("false");
    expect(ir.falsy).toContain("0");
    expect(ir.falsy).toContain("no");
  });

  it("extracts all default truthy values", () => {
    const ir = extractSchema(z.stringbool()) as StringBoolIR;
    expect(ir.truthy).toEqual(expect.arrayContaining(["true", "1", "yes", "on", "y", "enabled"]));
  });

  it("extracts all default falsy values", () => {
    const ir = extractSchema(z.stringbool()) as StringBoolIR;
    expect(ir.falsy).toEqual(expect.arrayContaining(["false", "0", "no", "off", "n", "disabled"]));
  });

  it("detects case-sensitive mode", () => {
    const ir = extractSchema(z.stringbool({ case: "sensitive" })) as StringBoolIR;
    expect(ir.type).toBe("stringBool");
    expect(ir.caseSensitive).toBe(true);
  });

  it("detects case-insensitive mode (default)", () => {
    const ir = extractSchema(z.stringbool()) as StringBoolIR;
    expect(ir.caseSensitive).toBe(false);
  });

  it("extracts custom truthy/falsy values when within probe set", () => {
    // Custom values that overlap with our probe set
    const ir = extractSchema(
      z.stringbool({ truthy: ["1", "yes"], falsy: ["0", "no"] }),
    ) as StringBoolIR;
    expect(ir.type).toBe("stringBool");
    expect(ir.truthy).toContain("1");
    expect(ir.truthy).toContain("yes");
    expect(ir.truthy).not.toContain("true");
    expect(ir.falsy).toContain("0");
    expect(ir.falsy).toContain("no");
    expect(ir.falsy).not.toContain("false");
  });

  it("falls back when custom truthy values are outside probe set", () => {
    const ir = extractSchema(z.stringbool({ truthy: ["ja", "oui"], falsy: ["nein", "non"] }));
    // All custom values are outside probe set → both sets empty → fallback
    expect(ir.type).toBe("fallback");
  });

  it("falls back when only truthy values are outside probe set", () => {
    const ir = extractSchema(z.stringbool({ truthy: ["ja"], falsy: ["0", "no"] }));
    // truthy is empty (no probe hit) → fallback to prevent broken codegen
    expect(ir.type).toBe("fallback");
  });

  it("falls back when only falsy values are outside probe set", () => {
    const ir = extractSchema(z.stringbool({ truthy: ["1", "yes"], falsy: ["nein"] }));
    // falsy is empty (no probe hit) → fallback
    expect(ir.type).toBe("fallback");
  });

  // [P1] Partial compilation: falls back when probe discovers only a subset
  it("falls back when custom values are partially outside probe set", () => {
    // "1" is in probe set but "ja" is not → partial discovery → must fall back
    const ir = extractSchema(z.stringbool({ truthy: ["1", "ja"], falsy: ["0", "no"] }));
    expect(ir.type).toBe("fallback");
  });

  // [P2] Case sensitivity must check falsy values too
  it("detects case-sensitive mode from falsy tokens when truthy has no case variant", () => {
    // truthy=["1"] has no case variant, but falsy=["false"] does
    const ir = extractSchema(
      z.stringbool({ truthy: ["1"], falsy: ["false"], case: "sensitive" }),
    ) as StringBoolIR;
    expect(ir.type).toBe("stringBool");
    expect(ir.caseSensitive).toBe(true);
  });
});
