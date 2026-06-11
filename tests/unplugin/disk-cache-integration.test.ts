import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { UnpluginContextMeta, UnpluginOptions } from "unplugin";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetDepValidationMemo } from "#src/unplugin/disk-cache.js";
import { unplugin } from "#src/unplugin/index.js";

const meta = { framework: "vite" } as UnpluginContextMeta;

type TransformFn = (code: string, id: string) => Promise<{ code: string; map: null } | undefined>;

interface PluginHandle {
  transform: TransformFn;
  /** Flushes deferred superset entries (real bundlers call this hook). */
  buildEnd: () => void;
}

function makePlugin(cacheDir: string, extra?: { schemas?: "explicit" | "auto" }): PluginHandle {
  const plugin = unplugin.raw({ cache: cacheDir, ...extra }, meta) as UnpluginOptions;
  return {
    transform: plugin.transform as unknown as TransformFn,
    buildEnd: plugin.buildEnd as unknown as () => void,
  };
}

const FIXTURE = path.resolve(import.meta.dirname, "../fixtures/simple-schema.ts");
const CODE = [
  'import { z } from "zod";',
  'import { compile } from "zod-compiler";',
  "const UserSchema = z.object({ name: z.string().min(1), age: z.number().int().positive() });",
  "export const validateUser = compile(UserSchema);",
].join("\n");

/** Entry files at the cache root (excludes the _meta marker and deps/). */
function entryFiles(dir: string): string[] {
  return fs.readdirSync(dir).filter((f) => f.endsWith(".json") && f !== "_meta.json");
}

let cacheDir: string;

beforeEach(() => {
  cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "zc-cache-int-"));
  resetDepValidationMemo();
});

afterEach(() => {
  fs.rmSync(cacheDir, { recursive: true, force: true });
});

describe("unplugin disk cache integration", () => {
  it("persists transform results and serves them to a fresh plugin instance", async () => {
    const plugin = makePlugin(cacheDir);
    const first = await plugin.transform(CODE, FIXTURE);
    expect(first?.code).toContain("safeParse_validateUser");
    // The fixture's #src import is statically unresolvable (no dist build in
    // the repo), so this entry takes the deferred-superset path and reaches
    // disk at buildEnd — exactly how real bundler runs persist it.
    plugin.buildEnd();

    const entries = entryFiles(cacheDir);
    expect(entries.length).toBe(1);

    // Tamper with the stored result: if the second (fresh) instance returns
    // the sentinel, the result demonstrably came from the disk cache rather
    // than a re-compile.
    const entryPath = path.join(cacheDir, entries[0] as string);
    const entry = JSON.parse(fs.readFileSync(entryPath, "utf8")) as { result: string };
    entry.result = "/* sentinel-from-disk */";
    fs.writeFileSync(entryPath, JSON.stringify(entry));

    const second = await makePlugin(cacheDir).transform(CODE, FIXTURE);
    expect(second?.code).toBe("/* sentinel-from-disk */");
  });

  it("recompiles when the schema file's recorded deps changed", async () => {
    // The copy must live inside the package so the fixture's #src import
    // resolves during discovery (same constraint as the other fixtures).
    const schemaPath = path.resolve(import.meta.dirname, "../fixtures/.tmp-disk-cache-dep.ts");
    fs.copyFileSync(FIXTURE, schemaPath);
    try {
      const plugin = makePlugin(cacheDir);
      const first = await plugin.transform(CODE, schemaPath);
      expect(first?.code).toContain("safeParse_validateUser");
      plugin.buildEnd();

      expect(entryFiles(cacheDir).length).toBe(1);

      // Tamper the stored entry, then mutate the schema file ON DISK while
      // passing the same `code` string: the content key is unchanged, but the
      // recorded dep hash no longer matches — the tampered entry must be
      // rejected and the file recompiled.
      const entryPath = path.join(cacheDir, entryFiles(cacheDir)[0] as string);
      const entry = JSON.parse(fs.readFileSync(entryPath, "utf8")) as { result: string };
      entry.result = "/* stale-sentinel */";
      fs.writeFileSync(entryPath, JSON.stringify(entry));

      fs.appendFileSync(schemaPath, "\nexport const extra = 1;\n");
      resetDepValidationMemo();

      const second = await makePlugin(cacheDir).transform(CODE, schemaPath);
      expect(second?.code).toContain("safeParse_validateUser");
      expect(second?.code).not.toContain("stale-sentinel");
    } finally {
      fs.rmSync(schemaPath, { force: true });
    }
  });

  it("cache: false disables persistence", async () => {
    const plugin = unplugin.raw({ cache: false }, meta) as UnpluginOptions;
    const transform = plugin.transform as unknown as TransformFn;
    const result = await transform(CODE, FIXTURE);
    expect(result?.code).toContain("safeParse_validateUser");
    expect(fs.readdirSync(cacheDir)).toEqual([]);
  });

  it("persists null results when the hoist scan did real work (hoist-only mode)", async () => {
    // Module-scope-only schemas, no compile(), schemas: "explicit" (the
    // hoist-only configuration): the hoist scan parses the file, finds
    // nothing to hoist, and the transform result is null. Re-deriving that
    // null cost a full scan per zod-importing file per run (35.8s/run in a
    // field report) when nulls were never persisted.
    const code = [
      'import { z } from "zod";',
      "export const UserSchema = z.object({ name: z.string().min(1) });",
    ].join("\n");
    const plugin = makePlugin(cacheDir, { schemas: "explicit" });
    expect(await plugin.transform(code, "/src/schemas.ts")).toBeUndefined();

    const entries = entryFiles(cacheDir);
    expect(entries.length).toBe(1);
    const entry = JSON.parse(
      fs.readFileSync(path.join(cacheDir, entries[0] as string), "utf8"),
    ) as {
      result: string | null;
    };
    expect(entry.result).toBeNull();

    // Prove the second (fresh) instance serves the null from disk: tamper the
    // stored result and observe the sentinel. Same options — the schemas mode
    // is part of the cache key.
    entry.result = "/* null-entry-sentinel */";
    fs.writeFileSync(path.join(cacheDir, entries[0] as string), JSON.stringify(entry));
    const second = await makePlugin(cacheDir, { schemas: "explicit" }).transform(
      code,
      "/src/schemas.ts",
    );
    expect(second?.code).toBe("/* null-entry-sentinel */");
  });

  it("does not persist purely textual bail-outs (no zod content)", async () => {
    const code = 'import { useState } from "react";\nexport const x = useState;';
    const plugin = makePlugin(cacheDir);
    expect(await plugin.transform(code, "/src/component.ts")).toBeUndefined();
    expect(fs.existsSync(cacheDir) ? entryFiles(cacheDir) : []).toEqual([]);
  });
});
