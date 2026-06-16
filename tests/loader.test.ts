import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { invalidateModuleCache, loadSourceFile, ProcessExitDuringLoadError } from "#src/loader.js";

const isNode = !("Bun" in globalThis) && !("Deno" in globalThis);

const fixturesDir = path.resolve(import.meta.dirname, "fixtures");

describe("loadSourceFile", () => {
  it("loads TypeScript files", async () => {
    const mod = await loadSourceFile(path.join(fixturesDir, "simple-schema.ts"));
    expect(mod).toHaveProperty("validateUser");
  });

  it("loads JavaScript files", async () => {
    const tmpFile = path.join(fixturesDir, "__test_loader.mjs");
    await fs.promises.writeFile(tmpFile, "export const testValue = 42;\n");
    try {
      const mod = await loadSourceFile(tmpFile);
      expect(mod["testValue"]).toBe(42);
    } finally {
      await fs.promises.unlink(tmpFile).catch(() => undefined);
    }
  });

  it("caches module executions across loads", async () => {
    const tmpFile = path.join(fixturesDir, "__test_loader_cache.mjs");
    await fs.promises.writeFile(
      tmpFile,
      "globalThis.__zcLoaderCacheCount = (globalThis.__zcLoaderCacheCount ?? 0) + 1;\n" +
        "export const n = globalThis.__zcLoaderCacheCount;\n",
    );
    try {
      const first = await loadSourceFile(tmpFile);
      const second = await loadSourceFile(tmpFile);
      // Same cached execution — the side effect ran once
      expect(second["n"]).toBe(first["n"]);
    } finally {
      await fs.promises.unlink(tmpFile).catch(() => undefined);
    }
  });

  it("invalidateModuleCache() forces re-execution of project files", async () => {
    // .ts goes through the evictable jiti pipeline on Node (and native
    // import + generation suffix on Bun/Deno).
    const tmpFile = path.join(fixturesDir, "__test_loader_invalidate.ts");
    await fs.promises.writeFile(
      tmpFile,
      "globalThis.__zcLoaderInvalidateCount = ((globalThis.__zcLoaderInvalidateCount as number | undefined) ?? 0) + 1;\n" +
        "export const n: number = globalThis.__zcLoaderInvalidateCount as number;\n",
    );
    try {
      const first = await loadSourceFile(tmpFile);
      invalidateModuleCache();
      const second = await loadSourceFile(tmpFile);
      expect(second["n"]).toBe((first["n"] as number) + 1);
    } finally {
      await fs.promises.unlink(tmpFile).catch(() => undefined);
    }
  });

  it("picks up changed file content after invalidateModuleCache()", async () => {
    const tmpFile = path.join(fixturesDir, "__test_loader_changed.ts");
    await fs.promises.writeFile(tmpFile, "export const v: number = 1;\n");
    try {
      const before = await loadSourceFile(tmpFile);
      expect(before["v"]).toBe(1);

      await fs.promises.writeFile(tmpFile, "export const v: number = 2;\n");
      invalidateModuleCache();

      const after = await loadSourceFile(tmpFile);
      expect(after["v"]).toBe(2);
    } finally {
      await fs.promises.unlink(tmpFile).catch(() => undefined);
    }
  });

  it("throws on non-existent file", async () => {
    await expect(loadSourceFile("/nonexistent/file.ts")).rejects.toThrow();
  });

  it("continues loading after a failed load (serialized queue recovers)", async () => {
    await expect(loadSourceFile("/nonexistent/file.ts")).rejects.toThrow();
    const mod = await loadSourceFile(path.join(fixturesDir, "simple-schema.ts"));
    expect(mod).toHaveProperty("validateUser");
  });

  it("loads TypeScript files with extensionless imports", async () => {
    const mod = await loadSourceFile(path.join(fixturesDir, "extensionless", "schema.ts"));
    expect(mod).toHaveProperty("validateUser");
  });

  it("loads TypeScript files with enum declarations", async () => {
    const mod = await loadSourceFile(path.join(fixturesDir, "with-enum.ts"));
    expect(mod).toHaveProperty("validateItem");
  });

  it.skipIf(!isNode)("resolves tsconfig path aliases", async () => {
    const mod = await loadSourceFile(path.join(fixturesDir, "path-alias", "schema.ts"));
    expect(mod).toHaveProperty("UserSchema");
  });

  it.skipIf(!isNode)("resolves path aliases after invalidateModuleCache()", async () => {
    invalidateModuleCache();
    const mod = await loadSourceFile(path.join(fixturesDir, "path-alias", "schema.ts"));
    expect(mod).toHaveProperty("UserSchema");
  });

  it.skipIf(!isNode)("loads TSX files with JSX syntax", async () => {
    const mod = await loadSourceFile(path.join(fixturesDir, "with-jsx", "schema.tsx"));
    expect(mod).toHaveProperty("LoginSchema");
    expect(mod).toHaveProperty("LoginForm");
  });
});

describe("build-time discovery guard", () => {
  it("converts a module's process.exit() into a catchable error", async () => {
    // The env-validation-guard pattern from issue #4: a module in the import
    // graph hard-exits when secrets are missing. The guard must turn that into
    // a rejection (caught by discovery) instead of killing the test process.
    const tmpFile = path.join(fixturesDir, "__test_loader_exit.ts");
    await fs.promises.writeFile(
      tmpFile,
      "process.exit(1);\nexport const unreachable: boolean = true;\n",
    );
    try {
      await expect(loadSourceFile(tmpFile)).rejects.toThrow(ProcessExitDuringLoadError);
    } finally {
      await fs.promises.unlink(tmpFile).catch(() => undefined);
    }
  });

  it("preserves the exit code on the thrown error", async () => {
    const tmpFile = path.join(fixturesDir, "__test_loader_exit_code.ts");
    await fs.promises.writeFile(tmpFile, "process.exit(42);\n");
    try {
      await loadSourceFile(tmpFile);
      expect.unreachable("load should have rejected");
    } catch (e) {
      expect(e).toBeInstanceOf(ProcessExitDuringLoadError);
      expect((e as ProcessExitDuringLoadError).exitCode).toBe(42);
    } finally {
      await fs.promises.unlink(tmpFile).catch(() => undefined);
    }
  });

  it("sets process.env.ZOD_COMPILER during the load and clears it after", async () => {
    const tmpFile = path.join(fixturesDir, "__test_loader_marker.ts");
    await fs.promises.writeFile(
      tmpFile,
      "export const seenMarker: string | undefined = process.env.ZOD_COMPILER;\n",
    );
    try {
      expect(process.env["ZOD_COMPILER"]).toBeUndefined();
      const mod = await loadSourceFile(tmpFile);
      expect(mod["seenMarker"]).toBe("1");
      // Restored once the load settles — exits elsewhere stay unaffected.
      expect(process.env["ZOD_COMPILER"]).toBeUndefined();
    } finally {
      await fs.promises.unlink(tmpFile).catch(() => undefined);
    }
  });

  it("restores the real process.exit after a successful load", async () => {
    // oxlint-disable typescript/unbound-method -- comparing identity, not calling
    const original = process.exit;
    const mod = await loadSourceFile(path.join(fixturesDir, "simple-schema.ts"));
    expect(mod).toHaveProperty("validateUser");
    expect(process.exit).toBe(original);
    // oxlint-enable typescript/unbound-method
  });
});
