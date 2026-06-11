import { describe, expect, it } from "vitest";
import type { FileIR } from "#src/core/types.js";
import { compileFastCheck, compileIR } from "../helpers.js";

describe("slow-path — file", () => {
  it("accepts File instances", () => {
    const ir: FileIR = { type: "file" };
    const safeParse = compileIR(ir);
    const file = new File(["hello"], "test.txt", { type: "text/plain" });
    expect(safeParse(file).success).toBe(true);
  });

  it("returns data as the input File", () => {
    const ir: FileIR = { type: "file" };
    const safeParse = compileIR(ir);
    const file = new File(["hello"], "test.txt");
    const result = safeParse(file);
    expect(result.success).toBe(true);
    expect(result.data).toBe(file);
  });

  it("rejects non-File values", () => {
    const ir: FileIR = { type: "file" };
    const safeParse = compileIR(ir);
    expect(safeParse("hello").success).toBe(false);
    expect(safeParse(42).success).toBe(false);
    expect(safeParse(null).success).toBe(false);
    expect(safeParse(undefined).success).toBe(false);
    expect(safeParse({}).success).toBe(false);
    expect(safeParse([]).success).toBe(false);
    expect(safeParse(true).success).toBe(false);
  });

  it("produces invalid_type issue for non-File input", () => {
    const ir: FileIR = { type: "file" };
    const safeParse = compileIR(ir);
    const result = safeParse("not a file");
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]).toMatchObject({ code: "invalid_type", expected: "file" });
  });

  it("validates min size", () => {
    const ir: FileIR = { type: "file", checks: [{ kind: "min_size", minimum: 10 }] };
    const safeParse = compileIR(ir);
    const small = new File(["hi"], "small.txt");
    const large = new File(["a".repeat(20)], "large.txt");
    expect(safeParse(small).success).toBe(false);
    expect(safeParse(large).success).toBe(true);
  });

  it("produces too_small issue for undersized file", () => {
    const ir: FileIR = { type: "file", checks: [{ kind: "min_size", minimum: 100 }] };
    const safeParse = compileIR(ir);
    const result = safeParse(new File(["hi"], "small.txt"));
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]).toMatchObject({
      code: "too_small",
      minimum: 100,
      origin: "file",
    });
  });

  it("validates max size", () => {
    const ir: FileIR = { type: "file", checks: [{ kind: "max_size", maximum: 5 }] };
    const safeParse = compileIR(ir);
    const small = new File(["hi"], "small.txt");
    const large = new File(["a".repeat(20)], "large.txt");
    expect(safeParse(small).success).toBe(true);
    expect(safeParse(large).success).toBe(false);
  });

  it("produces too_big issue for oversized file", () => {
    const ir: FileIR = { type: "file", checks: [{ kind: "max_size", maximum: 5 }] };
    const safeParse = compileIR(ir);
    const result = safeParse(new File(["a".repeat(20)], "big.txt"));
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]).toMatchObject({ code: "too_big", maximum: 5, origin: "file" });
  });

  it("validates mime type", () => {
    const ir: FileIR = { type: "file", checks: [{ kind: "mime_type", mime: ["image/png"] }] };
    const safeParse = compileIR(ir);
    const png = new File(["data"], "img.png", { type: "image/png" });
    const txt = new File(["data"], "doc.txt", { type: "text/plain" });
    expect(safeParse(png).success).toBe(true);
    expect(safeParse(txt).success).toBe(false);
  });

  it("produces invalid_value issue for wrong mime type", () => {
    const ir: FileIR = { type: "file", checks: [{ kind: "mime_type", mime: ["image/png"] }] };
    const safeParse = compileIR(ir);
    const result = safeParse(new File(["data"], "doc.txt", { type: "text/plain" }));
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]).toMatchObject({ code: "invalid_value" });
  });

  it("validates multiple mime types", () => {
    const ir: FileIR = {
      type: "file",
      checks: [{ kind: "mime_type", mime: ["image/png", "image/jpeg"] }],
    };
    const safeParse = compileIR(ir);
    const png = new File(["data"], "img.png", { type: "image/png" });
    const jpg = new File(["data"], "img.jpg", { type: "image/jpeg" });
    const txt = new File(["data"], "doc.txt", { type: "text/plain" });
    expect(safeParse(png).success).toBe(true);
    expect(safeParse(jpg).success).toBe(true);
    expect(safeParse(txt).success).toBe(false);
  });

  it("skips empty mime array (no check applied)", () => {
    const ir: FileIR = { type: "file", checks: [{ kind: "mime_type", mime: [] }] };
    const safeParse = compileIR(ir);
    const file = new File(["data"], "any.bin", { type: "application/octet-stream" });
    expect(safeParse(file).success).toBe(true);
  });

  it("validates combined size checks", () => {
    const ir: FileIR = {
      type: "file",
      checks: [
        { kind: "min_size", minimum: 1 },
        { kind: "max_size", maximum: 1000 },
      ],
    };
    const safeParse = compileIR(ir);
    const valid = new File(["hello world"], "test.txt");
    const empty = new File([], "empty.txt");
    expect(safeParse(valid).success).toBe(true);
    expect(safeParse(empty).success).toBe(false);
  });

  it("collects multiple issues from different checks", () => {
    const ir: FileIR = {
      type: "file",
      checks: [
        { kind: "min_size", minimum: 100 },
        { kind: "mime_type", mime: ["image/png"] },
      ],
    };
    const safeParse = compileIR(ir);
    const result = safeParse(new File(["hi"], "small.txt", { type: "text/plain" }));
    expect(result.success).toBe(false);
    expect(result.error?.issues).toHaveLength(2);
  });

  it("file with no checks property accepts any File", () => {
    const ir: FileIR = { type: "file" };
    const safeParse = compileIR(ir);
    const huge = new File(["x".repeat(10000)], "huge.bin", { type: "application/octet-stream" });
    expect(safeParse(huge).success).toBe(true);
  });
});

describe("fast-path — file", () => {
  it("plain file: instanceof check", () => {
    const fn = compileFastCheck({ type: "file" });
    expect(fn).not.toBeNull();
    const file = new File(["hello"], "test.txt");
    expect(fn?.(file)).toBe(true);
    expect(fn?.("hello")).toBe(false);
    expect(fn?.(null)).toBe(false);
  });

  it("file with size checks", () => {
    const fn = compileFastCheck({
      type: "file",
      checks: [
        { kind: "min_size", minimum: 3 },
        { kind: "max_size", maximum: 100 },
      ],
    });
    expect(fn).not.toBeNull();
    const small = new File(["h"], "s.txt");
    const ok = new File(["hello"], "ok.txt");
    expect(fn?.(small)).toBe(false);
    expect(fn?.(ok)).toBe(true);
  });

  it("file with single mime check", () => {
    const fn = compileFastCheck({
      type: "file",
      checks: [{ kind: "mime_type", mime: ["image/png"] }],
    });
    expect(fn).not.toBeNull();
    const png = new File(["data"], "img.png", { type: "image/png" });
    const txt = new File(["data"], "doc.txt", { type: "text/plain" });
    expect(fn?.(png)).toBe(true);
    expect(fn?.(txt)).toBe(false);
  });

  it("file with multiple mime types (Set path)", () => {
    const fn = compileFastCheck({
      type: "file",
      checks: [{ kind: "mime_type", mime: ["image/png", "image/jpeg", "image/webp"] }],
    });
    expect(fn).not.toBeNull();
    const png = new File(["data"], "img.png", { type: "image/png" });
    const jpg = new File(["data"], "img.jpg", { type: "image/jpeg" });
    const txt = new File(["data"], "doc.txt", { type: "text/plain" });
    expect(fn?.(png)).toBe(true);
    expect(fn?.(jpg)).toBe(true);
    expect(fn?.(txt)).toBe(false);
  });
});
