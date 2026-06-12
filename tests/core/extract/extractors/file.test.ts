import { describe, expect, it } from "vitest";
import { z } from "zod";
import { extractSchema } from "#src/core/extract/index.js";
import type { FileIR } from "#src/core/types.js";

describe("extractSchema — file", () => {
  it("extracts plain file", () => {
    const ir = extractSchema(z.file());
    expect(ir).toEqual<FileIR>({ type: "file" });
  });

  it("extracts file with min size", () => {
    const ir = extractSchema(z.file().min(1024)) as FileIR;
    expect(ir.type).toBe("file");
    expect(ir.checks).toHaveLength(1);
    expect(ir.checks?.[0]).toEqual({ kind: "min_size", minimum: 1024 });
  });

  it("extracts file with max size", () => {
    const ir = extractSchema(z.file().max(5_000_000)) as FileIR;
    expect(ir.type).toBe("file");
    expect(ir.checks).toHaveLength(1);
    expect(ir.checks?.[0]).toEqual({ kind: "max_size", maximum: 5_000_000 });
  });

  it("extracts file with mime type", () => {
    const ir = extractSchema(z.file().mime("image/png")) as FileIR;
    expect(ir.type).toBe("file");
    expect(ir.checks).toHaveLength(1);
    expect(ir.checks?.[0]).toEqual({ kind: "mime_type", mime: ["image/png"] });
  });

  it("extracts file with multiple mime types", () => {
    const ir = extractSchema(z.file().mime(["image/png", "image/jpeg"])) as FileIR;
    expect(ir.type).toBe("file");
    expect(ir.checks).toHaveLength(1);
    expect(ir.checks?.[0]).toEqual({ kind: "mime_type", mime: ["image/png", "image/jpeg"] });
  });

  it("extracts file with all checks combined", () => {
    const ir = extractSchema(z.file().min(100).max(1_000_000).mime("application/pdf")) as FileIR;
    expect(ir.type).toBe("file");
    expect(ir.checks).toHaveLength(3);
  });

  it("omits checks property when no checks", () => {
    const ir = extractSchema(z.file());
    expect(ir).not.toHaveProperty("checks");
  });

  it("preserves custom messages on size and mime checks", () => {
    const ir = extractSchema(
      z.file().min(100, "too small").max(1000, "too big").mime(["text/plain"], "bad type"),
    ) as FileIR;
    expect(ir.checks).toEqual([
      { kind: "min_size", minimum: 100, message: "too small" },
      { kind: "max_size", maximum: 1000, message: "too big" },
      { kind: "mime_type", mime: ["text/plain"], message: "bad type" },
    ]);
  });

  it("falls back when a file check has a dynamic (input-dependent) error map", () => {
    const ir = extractSchema(
      z.file().min(100, { error: (iss) => `too small: ${(iss as { input: unknown }).input}` }),
    );
    expect(ir.type).toBe("fallback");
  });

  it("falls back when file has refine check", () => {
    const schema = z.file().refine((f) => f.name.endsWith(".pdf"), "Must be PDF");
    const ir = extractSchema(schema);
    expect(ir.type).toBe("fallback");
  });

  it("falls back when file has superRefine check", () => {
    const schema = z.file().superRefine((f, ctx) => {
      if (f.size === 0) ctx.addIssue({ code: "custom", message: "Empty file" });
    });
    const ir = extractSchema(schema);
    expect(ir.type).toBe("fallback");
  });
});
