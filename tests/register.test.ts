import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vite-plus/test";

const execFileAsync = promisify(execFile);
const root = path.resolve(import.meta.dirname, "..");
const builtRegister = path.join(root, "dist", "register", "index.js");
const fixtures = path.join(root, "tests", "fixtures", "register");
const tsx = path.join(root, "node_modules", ".bin", "tsx");

async function run(
  fixture: string,
  mode: "javascript" | "tsx",
  cwd = root,
): Promise<{ after: string; before: string }> {
  const executable = mode === "tsx" ? tsx : process.execPath;
  const preload = ["--import", builtRegister];
  const { stdout } = await execFileAsync(executable, [...preload, path.join(fixtures, fixture)], {
    cwd,
  });
  return JSON.parse(stdout) as { after: string; before: string };
}

/**
 * The uninstrumented shape. Zod keeps `safeParse` on the prototype and installs
 * a bound own copy on first read, so a plain schema has no own descriptor
 * before the call and `bound safeParse` after it; an instrumented one shows
 * jit()'s accessor before and the compiled `safeParse_jit` after.
 */
const PLAIN_ZOD = { after: "bound safeParse", before: "undefined" };

describe.skipIf(!existsSync(builtRegister))("zod-compiler/register", () => {
  it("instruments native ESM imports", async () => {
    await expect(run("esm-runner.mjs", "javascript")).resolves.toStrictEqual({
      after: "safeParse_jit",
      before: "function",
    });
  });

  it("instruments CommonJS require calls", async () => {
    await expect(run("cjs-runner.cjs", "javascript")).resolves.toStrictEqual({
      after: "safeParse_jit",
      before: "function",
    });
  });

  it("chains with tsx for TypeScript applications", async () => {
    await expect(run("tsx-runner.ts", "tsx")).resolves.toStrictEqual({
      after: "safeParse_jit",
      before: "function",
    });
  });

  /**
   * The hook runs for every module the process loads and only ever adds an
   * optimization, so nothing it does may fail a load. A config value of the
   * wrong shape used to surface as `TypeError: options.include.some is not a
   * function` from inside zod-compiler, at startup, in the user's first module.
   */
  it.each([
    ["include of the wrong type", { include: "src/**" }],
    ["exclude of the wrong type", { exclude: "dist" }],
    ["an unparseable schemaNamePattern", { hoist: { schemaNamePattern: "[" } }],
  ])("boots with plain Zod rather than crashing on %s", async (_name, badConfig) => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "zod-compiler-register-"));
    try {
      writeFileSync(path.join(dir, "zod-compiler.json"), JSON.stringify(badConfig));
      // Resolving at all means the app booted; this exact shape is the
      // uninstrumented one, i.e. the schema fell back to plain Zod.
      await expect(run("esm-runner.mjs", "javascript", dir)).resolves.toStrictEqual(PLAIN_ZOD);
    } finally {
      rmSync(dir, { force: true, recursive: true });
    }
  });

  it("loads zod-compiler.json from the working directory", async () => {
    await expect(run("esm-runner.mjs", "javascript", fixtures)).resolves.toStrictEqual(PLAIN_ZOD);
  });
});
