import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import type { createJiti, TransformOptions, TransformResult } from "jiti";
import type { UnpluginContextMeta, UnpluginOptions } from "unplugin";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { transformHandler } from "./unplugin/hooks.js";

/**
 * Module state is the subject here — the directory in force, the transform
 * read off jiti, the set of directories already swept — and all of it is
 * process-wide by design. Each test therefore takes its own copy of the module
 * graph, the way a new build process would.
 */
async function freshCache(): Promise<typeof import("#src/transpile-cache.js")> {
  vi.resetModules();
  return import("#src/transpile-cache.js");
}

type Transform = (options: TransformOptions) => TransformResult;

/**
 * A jiti whose Babel is the given function. The cache never looks inside a
 * transpile, so a stand-in that counts its calls shows what Babel would have
 * been asked to do without paying for it.
 */
function jitiWith(transform: Transform): typeof createJiti {
  return (() => ({ options: { transform } })) as unknown as typeof createJiti;
}

function echo(): ReturnType<typeof vi.fn<Transform>> {
  return vi.fn<Transform>((options) => ({ code: `/* out */${options.source}` }));
}

const SOURCE = `export const answer: number = 41;\n`;
const REQUEST: TransformOptions = { source: SOURCE, filename: "/project/src/answer.ts", ts: true };

let root: string;

/** The transpiles kept under a root — not the sweep marker, not temp files. */
function entries(dir = path.join(root, "jiti")): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((name) => name.endsWith(".cjs"));
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "zc-transpile-"));
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  fs.rmSync(root, { recursive: true, force: true });
});

describe("transpileOptions()", () => {
  it("switches jiti's own cache off and fronts its transform with ours", async () => {
    const cache = await freshCache();
    const options = cache.transpileOptions(jitiWith(echo()));
    expect(options.fsCache).toBe(false);
    expect(options.transform).toBeTypeOf("function");
  });

  it("leaves a jiti that exposes no transform exactly as it was", async () => {
    const cache = await freshCache();
    const bare = (() => ({ options: {} })) as unknown as typeof createJiti;
    // Switching jiti's cache off without one of our own behind it would turn
    // every load into a transpile.
    expect(cache.transpileOptions(bare)).toEqual({});
  });

  it("answers a repeated transpile from disk", async () => {
    const cache = await freshCache();
    cache.useTranspileCache(root);
    const babel = echo();
    const { transform } = cache.transpileOptions(jitiWith(babel));

    const first = transform?.(REQUEST);
    const second = transform?.(REQUEST);

    expect(babel).toHaveBeenCalledTimes(1);
    expect(second).toEqual({ code: first?.code });
    expect(entries()).toEqual([expect.stringMatching(/^answer\.ts\.[0-9a-f]{16}\.cjs$/)]);
  });

  it("answers it for a later process too", async () => {
    const before = await freshCache();
    before.useTranspileCache(root);
    before.transpileOptions(jitiWith(echo())).transform?.(REQUEST);

    // Nothing carries over but the directory.
    const after = await freshCache();
    after.useTranspileCache(root);
    const babel = echo();
    const result = after.transpileOptions(jitiWith(babel)).transform?.(REQUEST);

    expect(babel).not.toHaveBeenCalled();
    expect(result?.code).toBe(`/* out */${SOURCE}`);
  });

  it("keeps one entry per file, overwritten when the file changes", async () => {
    const cache = await freshCache();
    cache.useTranspileCache(root);
    const babel = echo();
    const { transform } = cache.transpileOptions(jitiWith(babel));

    transform?.(REQUEST);
    const edited = transform?.({ ...REQUEST, source: SOURCE.replace("41", "42") });

    // A watch session rewrites a file hundreds of times; a copy per keystroke
    // would be the unbounded growth this cache is not allowed.
    expect(babel).toHaveBeenCalledTimes(2);
    expect(edited?.code).toContain("42");
    expect(entries()).toHaveLength(1);
    // And the old text is a miss again, not a stale hit.
    transform?.(REQUEST);
    expect(babel).toHaveBeenCalledTimes(3);
  });

  it("keeps apart what Babel would transpile differently", async () => {
    const cache = await freshCache();
    cache.useTranspileCache(root);
    const babel = echo();
    const { transform } = cache.transpileOptions(jitiWith(babel));

    transform?.(REQUEST);
    // The static filter and the loader ask for the same file in different
    // dialects; one must not be handed the other's output.
    transform?.({ ...REQUEST, async: true });
    transform?.({ ...REQUEST, jsx: true });
    transform?.({ ...REQUEST, interopDefault: true });
    transform?.({ ...REQUEST, filename: "/project/other/answer.ts" });

    expect(babel).toHaveBeenCalledTimes(5);
    expect(entries()).toHaveLength(5);
  });

  it("does not keep a transpile that failed", async () => {
    const cache = await freshCache();
    cache.useTranspileCache(root);
    // What jiti's Babel returns for a file that does not parse: a marker that
    // throws once evaluated, and the error beside it.
    const babel = vi.fn<Transform>(() => ({
      code: `exports.__JITI_ERROR__ = {"message":"Unexpected token"}`,
      error: new SyntaxError("Unexpected token"),
    }));
    const { transform } = cache.transpileOptions(jitiWith(babel));

    transform?.(REQUEST);
    transform?.(REQUEST);

    expect(babel).toHaveBeenCalledTimes(2);
    expect(entries()).toEqual([]);
  });

  it("treats an entry it cannot vouch for as a miss", async () => {
    const cache = await freshCache();
    cache.useTranspileCache(root);
    const babel = echo();
    const { transform } = cache.transpileOptions(jitiWith(babel));
    transform?.(REQUEST);
    const file = path.join(root, "jiti", entries()[0] as string);

    // Another jiti release, another layout, a half-written file: none carries
    // the stamp this exact transpile would.
    for (const content of ["", "/* zod-compiler transpile 0000 */\nexports.answer = 0;", "{"]) {
      fs.writeFileSync(file, content);
      expect(transform?.(REQUEST)?.code).toBe(`/* out */${SOURCE}`);
    }
    expect(babel).toHaveBeenCalledTimes(4);
  });

  it("passes a source with no file name straight through", async () => {
    const cache = await freshCache();
    cache.useTranspileCache(root);
    const babel = echo();
    const { transform } = cache.transpileOptions(jitiWith(babel));

    transform?.({ source: SOURCE });
    transform?.({ source: SOURCE });

    expect(babel).toHaveBeenCalledTimes(2);
    expect(entries()).toEqual([]);
  });

  it("makes the directory again when it vanishes mid-build", async () => {
    const cache = await freshCache();
    cache.useTranspileCache(root);
    const babel = echo();
    const { transform } = cache.transpileOptions(jitiWith(babel));
    transform?.(REQUEST);

    // A cache wipe from another process. jiti's own cache writes without a
    // guard, so from here on every load threw.
    fs.rmSync(path.join(root, "jiti"), { recursive: true });

    expect(transform?.({ ...REQUEST, source: "export const b = 1;" })?.code).toContain("b = 1");
    expect(entries()).toHaveLength(1);
  });

  it("transpiles without caching when nothing can be written", async () => {
    const cache = await freshCache();
    // A file where the cache root should be: no directory can be made under it.
    const blocked = path.join(root, "not-a-directory");
    fs.writeFileSync(blocked, "");
    cache.useTranspileCache(blocked);
    const babel = echo();
    const { transform } = cache.transpileOptions(jitiWith(babel));

    expect(transform?.(REQUEST)?.code).toBe(`/* out */${SOURCE}`);
    expect(transform?.(REQUEST)?.code).toBe(`/* out */${SOURCE}`);
    expect(babel).toHaveBeenCalledTimes(2);
  });

  it("honours JITI_FS_CACHE=false, the switch for the cache it replaced", async () => {
    vi.stubEnv("JITI_FS_CACHE", "false");
    const cache = await freshCache();
    cache.useTranspileCache(root);
    const babel = echo();
    const { transform } = cache.transpileOptions(jitiWith(babel));

    transform?.(REQUEST);
    transform?.(REQUEST);

    expect(cache.transpileCacheDirectory()).toBeNull();
    expect(babel).toHaveBeenCalledTimes(2);
    expect(entries()).toEqual([]);
  });
});

describe("transpileCacheDirectory()", () => {
  it("is `jiti/` under the root it was given", async () => {
    const cache = await freshCache();
    cache.useTranspileCache(root);
    expect(cache.transpileCacheDirectory()).toBe(path.join(root, "jiti"));
    expect(cache.transpileCacheRoot()).toBe(root);
  });

  it("defaults to the plugin's default root, the directory the README has CI keep", async () => {
    const cache = await freshCache();
    fs.mkdirSync(path.join(root, "node_modules"));
    vi.spyOn(process, "cwd").mockReturnValue(root);

    expect(cache.transpileCacheRoot()).toBeUndefined();
    expect(cache.projectCacheRoot()).toBe(
      path.join(root, "node_modules", ".cache", "zod-compiler"),
    );
    expect(cache.transpileCacheDirectory()).toBe(
      path.join(root, "node_modules", ".cache", "zod-compiler", "jiti"),
    );
  });

  it("stays out of a project that has no node_modules to hide it under", async () => {
    const cache = await freshCache();
    const temp = path.join(root, "tmp");
    fs.mkdirSync(temp);
    vi.spyOn(process, "cwd").mockReturnValue(root);
    vi.spyOn(os, "tmpdir").mockReturnValue(temp);

    expect(cache.projectCacheRoot()).toBeNull();
    const directory = cache.transpileCacheDirectory();
    expect(directory?.startsWith(temp + path.sep)).toBe(true);
    expect(path.basename(directory as string)).toBe("jiti");
  });

  it("follows the working directory until something is configured", async () => {
    const cache = await freshCache();
    const a = path.join(root, "a");
    const b = path.join(root, "b");
    fs.mkdirSync(path.join(a, "node_modules"), { recursive: true });
    fs.mkdirSync(path.join(b, "node_modules"), { recursive: true });
    const cwd = vi.spyOn(process, "cwd").mockReturnValue(a);
    expect(cache.transpileCacheDirectory()?.startsWith(a)).toBe(true);
    cwd.mockReturnValue(b);
    expect(cache.transpileCacheDirectory()?.startsWith(b)).toBe(true);
  });

  it("keeps a build that asked for no persistent cache out of the project", async () => {
    const cache = await freshCache();
    const temp = path.join(root, "tmp");
    fs.mkdirSync(temp);
    fs.mkdirSync(path.join(root, "node_modules"));
    vi.spyOn(process, "cwd").mockReturnValue(root);
    vi.spyOn(os, "tmpdir").mockReturnValue(temp);
    cache.useTranspileCache(null);

    const babel = echo();
    const { transform } = cache.transpileOptions(jitiWith(babel));
    transform?.(REQUEST);
    transform?.(REQUEST);

    // Still cached — it always was, in jiti's temp directory — just not here.
    expect(babel).toHaveBeenCalledTimes(1);
    expect(fs.readdirSync(path.join(root, "node_modules"))).toEqual([]);
    expect(cache.transpileCacheDirectory()?.startsWith(temp + path.sep)).toBe(true);
    expect(entries(cache.transpileCacheDirectory() as string)).toHaveLength(1);
  });

  it.skipIf(process.getuid === undefined)(
    "refuses a temp directory another user could have planted entries in",
    async () => {
      const cache = await freshCache();
      const temp = path.join(root, "tmp");
      // What it reads back is executed, so the per-user directory has to be
      // this user's alone. Here somebody made it first and left it open.
      const shared = path.join(temp, `zod-compiler-${process.getuid?.()}`);
      fs.mkdirSync(shared, { recursive: true });
      fs.chmodSync(shared, 0o777);
      vi.spyOn(os, "tmpdir").mockReturnValue(temp);
      cache.useTranspileCache(null);

      const babel = echo();
      const { transform } = cache.transpileOptions(jitiWith(babel));
      transform?.(REQUEST);
      transform?.(REQUEST);

      expect(cache.transpileCacheDirectory()).toBeNull();
      expect(babel).toHaveBeenCalledTimes(2);
      expect(fs.readdirSync(shared)).toEqual([]);
    },
  );
});

describe("collectGarbage()", () => {
  const DAY = 24 * 60 * 60 * 1000;

  function plant(dir: string, name: string, ageMs: number): string {
    const file = path.join(dir, name);
    fs.writeFileSync(file, "x");
    const when = new Date(Date.now() - ageMs);
    fs.utimesSync(file, when, when);
    return file;
  }

  it("is on the transform cache's terms: a month for entries, an hour for temp files", async () => {
    const cache = await freshCache();
    expect(cache.CACHE_GC_INTERVAL_MS).toBe(DAY);
    expect(cache.CACHE_MAX_ENTRY_AGE_MS).toBe(30 * DAY);
    expect(cache.CACHE_MAX_TMP_AGE_MS).toBe(60 * 60 * 1000);
  });

  it("removes what has gone unwritten for a month and temp files a crash left", async () => {
    const cache = await freshCache();
    const live = plant(root, "live.ts.0000000000000000.cjs", 29 * DAY);
    const orphan = plant(root, "renamed.ts.1111111111111111.cjs", 31 * DAY);
    const writing = plant(root, "live.ts.0000000000000000.cjs.1.0.tmp", 60 * 1000);
    const crashed = plant(root, "dead.ts.2222222222222222.cjs.9.0.tmp", 2 * 60 * 60 * 1000);
    fs.mkdirSync(path.join(root, "not-ours"));

    cache.collectGarbage(root);

    expect(fs.existsSync(live)).toBe(true);
    expect(fs.existsSync(writing)).toBe(true);
    expect(fs.existsSync(orphan)).toBe(false);
    expect(fs.existsSync(crashed)).toBe(false);
    expect(fs.existsSync(path.join(root, "not-ours"))).toBe(true);
  });

  it("sweeps a directory at most once a day, whoever asks", async () => {
    const cache = await freshCache();
    cache.collectGarbage(root);
    // The marker is claimed, so a second build today — this process or any
    // other sharing the directory — leaves the listing alone.
    const orphan = plant(root, "late.ts.3333333333333333.cjs", 31 * DAY);
    cache.collectGarbage(root);
    expect(fs.existsSync(orphan)).toBe(true);

    const yesterday = new Date(Date.now() - DAY - 1000);
    fs.utimesSync(path.join(root, "_gc"), yesterday, yesterday);
    cache.collectGarbage(root);
    expect(fs.existsSync(orphan)).toBe(false);
  });

  it("runs the first time a process writes to the directory", async () => {
    const cache = await freshCache();
    cache.useTranspileCache(root);
    fs.mkdirSync(path.join(root, "jiti"));
    const orphan = plant(path.join(root, "jiti"), "gone.ts.4444444444444444.cjs", 31 * DAY);

    cache.transpileOptions(jitiWith(echo())).transform?.(REQUEST);

    expect(fs.existsSync(orphan)).toBe(false);
    expect(entries()).toHaveLength(1);
  });

  it("does not throw for a directory that is not there", async () => {
    const cache = await freshCache();
    expect(() => cache.collectGarbage(path.join(root, "absent"))).not.toThrow();
  });
});

describe("where the build keeps its transpiles", () => {
  const FIXTURES = path.resolve(import.meta.dirname, "fixtures");
  const written: string[] = [];

  /** A source inside the package, so its `zod` import resolves. */
  function fixture(name: string, source: string): string {
    const file = path.join(FIXTURES, `.tmp-transpile-${name}.ts`);
    fs.writeFileSync(file, source);
    written.push(file);
    return file;
  }

  afterEach(() => {
    for (const file of written.splice(0)) fs.rmSync(file, { force: true });
  });

  it("the loader reads back what it stored there", async () => {
    const cache = await freshCache();
    const { invalidateModuleCache, loadSourceFile } = await import("#src/loader.js");
    cache.useTranspileCache(root);
    const file = fixture("loader", SOURCE);

    expect((await loadSourceFile(file))["answer"]).toBe(41);
    expect(entries()).toEqual([expect.stringMatching(/^\.tmp-transpile-loader\.ts\./)]);

    // Change what is stored, under its original stamp. If the next execution
    // of the unchanged file answers 42, it came from the directory rather than
    // from Babel.
    const entry = path.join(root, "jiti", entries()[0] as string);
    fs.writeFileSync(entry, fs.readFileSync(entry, "utf8").replace("41", "42"));
    invalidateModuleCache();

    expect((await loadSourceFile(file))["answer"]).toBe(42);
  });

  it("the static filter keeps its transpile there too", async () => {
    const cache = await freshCache();
    const { mayExportSchemas } = await import("#src/static-filter.js");
    cache.useTranspileCache(root);
    // Functions only, and no export a line of regex can call a candidate: the
    // verdict takes a transpile.
    const code = `import { z } from "zod";\nexport function parse(v: unknown) { return z.string().parse(v); }\n`;

    expect(await mayExportSchemas(code, "/project/src/handlers.ts")).toBe(false);

    expect(entries()).toEqual([expect.stringMatching(/^handlers\.ts\.[0-9a-f]{16}\.cjs$/)]);
  });

  describe("under the plugin's `cache` option", () => {
    const meta = { framework: "vite" } as UnpluginContextMeta;
    const CODE = `import { z } from "zod";\nexport const Row = z.object({ id: z.number().int() });\n`;

    async function freshPlugin(): Promise<{
      cache: typeof import("#src/transpile-cache.js");
      make: (options: Record<string, unknown>) => UnpluginOptions;
    }> {
      const cache = await freshCache();
      const { unplugin } = await import("#src/unplugin/index.js");
      return { cache, make: (options) => unplugin.raw(options, meta) as UnpluginOptions };
    }

    it("a directory puts them under it, beside the transform entries", async () => {
      const { make } = await freshPlugin();
      const file = fixture("plugin-dir", CODE);

      const result = await transformHandler(make({ cache: root }))(CODE, file);

      expect(result?.code).toContain("__zcMkv(");
      expect(entries()).toEqual([expect.stringMatching(/^\.tmp-transpile-plugin-dir\.ts\./)]);
      // One directory for a CI cache to restore: the entries and the transpiles.
      expect(fs.readdirSync(root)).toEqual(expect.arrayContaining(["_meta.json", "deps", "jiti"]));
    });

    it("the default puts them under node_modules/.cache/zod-compiler", async () => {
      const { make } = await freshPlugin();
      fs.mkdirSync(path.join(root, "node_modules"));
      vi.spyOn(process, "cwd").mockReturnValue(root);
      const file = fixture("plugin-default", CODE);

      const result = await transformHandler(make({}))(CODE, file);

      expect(result?.code).toContain("__zcMkv(");
      // The path the README's CI recipe restores, now holding both.
      const cacheRoot = path.join(root, "node_modules", ".cache", "zod-compiler");
      expect(fs.readdirSync(cacheRoot)).toEqual(expect.arrayContaining(["_meta.json", "jiti"]));
      expect(entries(path.join(cacheRoot, "jiti"))).toHaveLength(1);
    });

    it("`false` writes nothing into the project", async () => {
      const { cache, make } = await freshPlugin();
      const temp = path.join(root, "tmp");
      fs.mkdirSync(temp);
      // A project whose node_modules is where the default root would be.
      fs.mkdirSync(path.join(root, "node_modules"));
      vi.spyOn(process, "cwd").mockReturnValue(root);
      vi.spyOn(os, "tmpdir").mockReturnValue(temp);
      const file = fixture("plugin-off", CODE);

      const result = await transformHandler(make({ cache: false }))(CODE, file);

      expect(result?.code).toContain("__zcMkv(");
      expect(cache.transpileCacheRoot()).toBeNull();
      expect(fs.readdirSync(path.join(root, "node_modules"))).toEqual([]);
      // The file was transpiled and the transpile was kept — in the temp
      // directory, where jiti put it before any of this existed.
      const kept = cache.transpileCacheDirectory() as string;
      expect(kept.startsWith(temp + path.sep)).toBe(true);
      expect(entries(kept)).toEqual([expect.stringMatching(/^\.tmp-transpile-plugin-off\.ts\./)]);
    });

    it("each instance transpiles into its own root, whichever was built last", async () => {
      const { make } = await freshPlugin();
      const mine = path.join(root, "mine");
      const theirs = path.join(root, "theirs");
      const handler = transformHandler(make({ cache: mine }));
      // A second plugin in the same process — another Vitest project, say.
      // The setting is module state and it has just been overwritten.
      make({ cache: theirs });
      const file = fixture("plugin-two", CODE);

      await handler(CODE, file);

      expect(entries(path.join(mine, "jiti"))).toHaveLength(1);
      expect(entries(path.join(theirs, "jiti"))).toEqual([]);
    });
  });
});
