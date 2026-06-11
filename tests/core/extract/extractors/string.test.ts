import { describe, expect, it } from "vitest";
import { z } from "zod";
import { extractSchema } from "#src/core/extract/index.js";
import type { StringIR } from "#src/core/types.js";

describe("extractSchema — string checks", () => {
  it("extracts min length check", () => {
    const ir = extractSchema(z.string().min(3)) as StringIR;
    expect(ir.type).toBe("string");
    expect(ir.checks).toContainEqual({ kind: "min_length", minimum: 3 });
  });

  it("extracts max length check", () => {
    const ir = extractSchema(z.string().max(50)) as StringIR;
    expect(ir.type).toBe("string");
    expect(ir.checks).toContainEqual({ kind: "max_length", maximum: 50 });
  });

  it("extracts length equals check", () => {
    const ir = extractSchema(z.string().length(10)) as StringIR;
    expect(ir.type).toBe("string");
    expect(ir.checks).toContainEqual({ kind: "length_equals", length: 10 });
  });

  it("extracts combined min + max checks", () => {
    const ir = extractSchema(z.string().min(3).max(50)) as StringIR;
    expect(ir.type).toBe("string");
    expect(ir.checks).toHaveLength(2);
    expect(ir.checks).toContainEqual({ kind: "min_length", minimum: 3 });
    expect(ir.checks).toContainEqual({ kind: "max_length", maximum: 50 });
  });

  it("extracts regex pattern check", () => {
    const ir = extractSchema(z.string().regex(/^[a-z]+$/)) as StringIR;
    expect(ir.type).toBe("string");
    expect(ir.checks).toContainEqual({
      kind: "string_format",
      format: "regex",
      pattern: "^[a-z]+$",
    });
  });

  it("extracts email format check", () => {
    const ir = extractSchema(z.email()) as StringIR;
    expect(ir.type).toBe("string");
    expect(ir.checks).toContainEqual(
      expect.objectContaining({ kind: "string_format", format: "email" }),
    );
  });

  it("extracts url format check", () => {
    const ir = extractSchema(z.url()) as StringIR;
    expect(ir.type).toBe("string");
    expect(ir.checks).toContainEqual(
      expect.objectContaining({ kind: "string_format", format: "url" }),
    );
  });

  it("extracts uuid format check", () => {
    const ir = extractSchema(z.uuid()) as StringIR;
    expect(ir.type).toBe("string");
    expect(ir.checks).toContainEqual(
      expect.objectContaining({ kind: "string_format", format: "uuid" }),
    );
  });

  it("extracts includes check", () => {
    const ir = extractSchema(z.string().includes("foo")) as StringIR;
    expect(ir.type).toBe("string");
    expect(ir.checks).toContainEqual({ kind: "includes", includes: "foo" });
  });

  it("extracts includes check with position", () => {
    const ir = extractSchema(z.string().includes("bar", { position: 3 })) as StringIR;
    expect(ir.type).toBe("string");
    expect(ir.checks).toContainEqual({ kind: "includes", includes: "bar", position: 3 });
  });

  it("extracts startsWith check", () => {
    const ir = extractSchema(z.string().startsWith("http")) as StringIR;
    expect(ir.type).toBe("string");
    expect(ir.checks).toContainEqual({ kind: "starts_with", prefix: "http" });
  });

  it("extracts endsWith check", () => {
    const ir = extractSchema(z.string().endsWith(".ts")) as StringIR;
    expect(ir.type).toBe("string");
    expect(ir.checks).toContainEqual({ kind: "ends_with", suffix: ".ts" });
  });

  it("extracts multiple checks in correct order", () => {
    const ir = extractSchema(z.string().min(1).max(100).regex(/^\w+$/)) as StringIR;
    expect(ir.checks).toHaveLength(3);
    expect(ir.checks[0]?.kind).toBe("min_length");
    expect(ir.checks[1]?.kind).toBe("max_length");
    expect(ir.checks[2]?.kind).toBe("string_format");
  });
});
