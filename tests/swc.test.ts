import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { transform, transformWithSwc, type SwcCoreLike, type SwcOptions } from "#src/swc.js";

const fixturesDir = path.resolve(import.meta.dirname, "fixtures");

function captureSwc(calls: Array<{ code: string; options?: SwcOptions }>): SwcCoreLike {
  return {
    async transform(code, options) {
      calls.push({ code, options });
      return { code, map: options?.sourceMaps ? "{}" : undefined };
    },
  };
}

describe("zod-compiler/swc", () => {
  it("runs zod-compiler before the SWC transform using inline helpers by default", async () => {
    const fixturePath = path.join(fixturesDir, "auto-discover-simple.ts");
    const code = fs.readFileSync(fixturePath, "utf8");
    const calls: Array<{ code: string; options?: SwcOptions }> = [];

    const result = await transformWithSwc(captureSwc(calls), code, {
      filename: fixturePath,
      swc: { sourceMaps: true },
    });

    expect(result.code).toContain("safeParse_UserSchema");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.code).toContain("safeParse_UserSchema");
    expect(calls[0]?.code).toContain("function __zcMkv(");
    expect(calls[0]?.code).not.toContain("virtual:zod-compiler/runtime");
    expect(calls[0]?.options?.filename).toBe(fixturePath);
    expect(typeof calls[0]?.options?.inputSourceMap).toBe("string");
  });

  it("passes through explicit SWC inputSourceMap instead of replacing it", async () => {
    const fixturePath = path.join(fixturesDir, "auto-discover-simple.ts");
    const code = fs.readFileSync(fixturePath, "utf8");
    const calls: Array<{ code: string; options?: SwcOptions }> = [];

    await transformWithSwc(captureSwc(calls), code, {
      filename: fixturePath,
      swc: { inputSourceMap: "existing-map" },
    });

    expect(calls[0]?.options?.inputSourceMap).toBe("existing-map");
  });

  it("supports explicit lean mode for hosts that resolve the runtime import themselves", async () => {
    const fixturePath = path.join(fixturesDir, "auto-discover-simple.ts");
    const code = fs.readFileSync(fixturePath, "utf8");
    const calls: Array<{ code: string; options?: SwcOptions }> = [];

    await transformWithSwc(captureSwc(calls), code, {
      filename: fixturePath,
      zodCompiler: { codegenMode: "lean" },
    });

    expect(calls[0]?.code).toContain('from "virtual:zod-compiler/runtime"');
    expect(calls[0]?.code).not.toContain("function __zcMkv(");
  });

  it("generates executable code through real @swc/core", async () => {
    const fixturePath = path.join(fixturesDir, "auto-discover-simple.ts");
    const code = fs.readFileSync(fixturePath, "utf8");
    const result = await transform(code, {
      filename: fixturePath,
      swc: {
        jsc: {
          parser: { syntax: "typescript" },
          target: "es2022",
        },
        module: { type: "es6" },
      },
    });

    expect(result.code).toContain("safeParse_UserSchema");
    expect(result.code).not.toContain("virtual:zod-compiler/runtime");

    const tempRoot = path.resolve(import.meta.dirname, "..", ".tmp");
    fs.mkdirSync(tempRoot, { recursive: true });
    const tempDir = fs.mkdtempSync(path.join(tempRoot, "swc-"));
    try {
      const modulePath = path.join(tempDir, "schema.mjs");
      fs.writeFileSync(modulePath, result.code);

      const moduleUrl = pathToFileURL(modulePath).href;
      const mod = (await import(moduleUrl)) as {
        UserSchema: {
          is(input: unknown): boolean;
          parse(input: unknown): unknown;
          safeParse(input: unknown): { success: boolean; data?: unknown; error?: unknown };
        };
      };

      expect(mod.UserSchema.is({ name: "Ada", age: 42 })).toBe(true);
      expect(mod.UserSchema.is({ name: "", age: 42 })).toBe(false);
      expect(mod.UserSchema.safeParse({ name: "Ada", age: 42 })).toMatchObject({
        success: true,
        data: { name: "Ada", age: 42 },
      });
      expect(mod.UserSchema.safeParse({ name: "Ada", age: 1.5 }).success).toBe(false);
      expect(() => mod.UserSchema.parse({ name: "Ada", age: -1 })).toThrow();
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
