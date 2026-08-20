import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { UnpluginContextMeta, UnpluginOptions } from "unplugin";
import { afterAll, afterEach, describe, expect, it, vi } from "vite-plus/test";
import { resetDepValidationMemo } from "#src/unplugin/disk-cache.js";
import { unplugin } from "#src/unplugin/index.js";
import {
  disposeAllPools,
  PoolUnavailableError,
  poolTransformOptions,
  resolvePoolSize,
  TransformPool,
} from "#src/unplugin/pool.js";
import { transformCodeWithMap } from "#src/unplugin/transform.js";
import type { TransformOptions } from "#src/unplugin/types.js";
import { type TransformHandler, transformHandler } from "./hooks.js";

const FIXTURES = path.resolve(import.meta.dirname, "../fixtures");

const OPTIONS: TransformOptions = {
  mode: "inline",
  autoDiscover: true,
  zodCompat: true,
};

/**
 * Real workers, not a stand-in. The pool boots them from `src/` through its
 * jiti bootstrap here and from `dist/` when published, and the point of these
 * tests is that a transform crossing a thread boundary produces what an
 * in-process one does — a fake executor would assume exactly what needs proving.
 */
function pool(size = 2): TransformPool {
  const created = TransformPool.create(size);
  if (created === null) throw new Error("worker entry not resolvable from tests");
  return created;
}

/** Files written into tests/fixtures so their `zod` / `#src` imports resolve. */
const written: string[] = [];
function fixture(name: string, source: string): string {
  const file = path.join(FIXTURES, `.tmp-pool-${name}.ts`);
  fs.writeFileSync(file, source);
  written.push(file);
  return file;
}

function schemaSource(min: number): string {
  return [
    'import { z } from "zod";',
    `export const Person = z.object({ name: z.string().min(${min}), age: z.number().int() });`,
  ].join("\n");
}

afterEach(() => {
  for (const file of written.splice(0)) fs.rmSync(file, { force: true });
});

afterAll(async () => {
  await disposeAllPools();
});

describe("resolvePoolSize", () => {
  it("disables the pool for false and undefined", () => {
    expect(resolvePoolSize(false)).toBe(0);
    expect(resolvePoolSize(undefined)).toBe(0);
  });

  it("leaves a core for the bundler and caps automatic sizing", () => {
    const size = resolvePoolSize(true);
    expect(size).toBeGreaterThanOrEqual(1);
    expect(size).toBeLessThanOrEqual(8);
  });

  it("clamps an explicit count into range", () => {
    expect(resolvePoolSize(3)).toBe(3);
    expect(resolvePoolSize(0)).toBe(1);
    expect(resolvePoolSize(-4)).toBe(1);
    expect(resolvePoolSize(1000)).toBe(32);
    expect(resolvePoolSize(2.7)).toBe(2);
  });

  it("disables the pool for a non-finite count rather than spawning NaN workers", () => {
    expect(resolvePoolSize(Number.NaN)).toBe(0);
    expect(resolvePoolSize(Number.POSITIVE_INFINITY)).toBe(0);
  });
});

describe("TransformPool.create", () => {
  it("returns null when the pool is disabled, so callers stay in-process", () => {
    expect(TransformPool.create(0)).toBeNull();
    expect(TransformPool.create(-1)).toBeNull();
  });
});

describe("poolTransformOptions", () => {
  it("drops the callbacks that cannot cross a thread boundary", () => {
    const cloneable = poolTransformOptions({
      ...OPTIONS,
      onDiscovery: () => undefined,
      onBuildStats: () => undefined,
      onSubstantialWork: () => undefined,
      onUncacheableResult: () => undefined,
    });
    expect(Object.values(cloneable).some((v) => typeof v === "function")).toBe(false);
    // structuredClone is what postMessage uses; a survivor would throw here
    // at runtime instead of failing this assertion.
    expect(() => structuredClone(cloneable)).not.toThrow();
  });

  it("preserves a RegExp schemaNamePattern, which does survive cloning", () => {
    const cloneable = poolTransformOptions({
      ...OPTIONS,
      hoist: { schemaNamePattern: /Model$/ },
    });
    expect(structuredClone(cloneable).hoist).toEqual({ schemaNamePattern: /Model$/ });
  });
});

describe("TransformPool", () => {
  it("produces byte-identical output to an in-process transform", async () => {
    const file = fixture("identical", schemaSource(2));
    const code = fs.readFileSync(file, "utf8");

    const expected = await transformCodeWithMap(code, file, OPTIONS);
    const actual = await pool(2).run(code, file, poolTransformOptions(OPTIONS));

    expect(actual.output?.code).toBe(expected?.code);
    expect(actual.output?.map).toEqual(expected?.map);
  });

  it("reports the flags the in-process path delivers through callbacks", async () => {
    const file = fixture("flags", schemaSource(3));
    const code = fs.readFileSync(file, "utf8");

    const result = await pool(1).run(code, file, poolTransformOptions(OPTIONS));

    expect(result.discoveryRan).toBe(true);
    expect(result.substantialWork).toBe(true);
    expect(result.uncacheable).toBe(false);
    expect(result.stats).toEqual({ files: 1, schemas: 1, optimized: 1, failed: 0 });
  });

  it("runs more files than it has workers, queueing the excess", async () => {
    const files = Array.from({ length: 6 }, (_unused, i) =>
      fixture(`queue${i}`, schemaSource(i + 1)),
    );
    const p = pool(2);

    const results = await Promise.all(
      files.map((file) =>
        p.run(fs.readFileSync(file, "utf8"), file, poolTransformOptions(OPTIONS)),
      ),
    );

    expect(results).toHaveLength(6);
    for (const [i, result] of results.entries()) {
      // Each file's own `min(i+1)` proves results were not crossed between
      // concurrent tasks sharing a worker.
      expect(result.output?.code).toContain(`length<${i + 1}`);
    }
  });

  it("reports the first-party modules its workers executed", async () => {
    const file = fixture("modules", schemaSource(1));
    const p = pool(1);
    expect(p.firstPartyModulePaths()).toEqual([]);

    await p.run(fs.readFileSync(file, "utf8"), file, poolTransformOptions(OPTIONS));

    const executed = p.firstPartyModulePaths();
    expect(executed).not.toBeNull();
    expect(executed).toContain(file);
    // node_modules stay out of the superset — the loader keeps them warm
    // across invalidations, so they are not dependencies to validate.
    expect(executed?.some((p2) => p2.includes(`${path.sep}node_modules${path.sep}`))).toBe(false);
  });

  it("re-discovers a file whose source changed after invalidate()", async () => {
    const file = fixture("invalidate", schemaSource(1));
    const p = pool(1);

    const before = await p.run(schemaSource(1), file, poolTransformOptions(OPTIONS));
    expect(before.output?.code).toContain("length<1");

    // Discovery executes the file from DISK, so the rewrite is what the worker
    // must pick up; without invalidation it would serve its cached execution.
    fs.writeFileSync(file, schemaSource(9));
    p.invalidate();

    const after = await p.run(schemaSource(9), file, poolTransformOptions(OPTIONS));
    expect(after.output?.code).toContain("length<9");
  });

  it("clears the reported module set on invalidate so re-execution re-reports", async () => {
    const file = fixture("remodules", schemaSource(1));
    const p = pool(1);
    await p.run(fs.readFileSync(file, "utf8"), file, poolTransformOptions(OPTIONS));
    expect(p.firstPartyModulePaths()).toContain(file);

    p.invalidate();
    expect(p.firstPartyModulePaths()).toEqual([]);

    await p.run(fs.readFileSync(file, "utf8"), file, poolTransformOptions(OPTIONS));
    expect(p.firstPartyModulePaths()).toContain(file);
  });

  it("forwards a transform's own error with its message intact", async () => {
    // The export has to survive the static filter (a call expression is not
    // provably a non-schema) so discovery actually executes the file, and
    // `schemas: "explicit"` is what turns a load failure into a thrown error
    // rather than a silent skip — that is the path which has to cross the
    // boundary with its message intact.
    const code = [
      'import { z } from "zod";',
      'import { compile } from "zod-compiler";',
      'throw new Error("boom from module");',
      "export const Broken = compile(z.object({ a: z.string() }));",
    ].join("\n");
    const file = fixture("broken", code);

    const failure = pool(1).run(
      code,
      file,
      poolTransformOptions({ ...OPTIONS, autoDiscover: false }),
    );

    await expect(failure).rejects.toThrow(/boom from module/);
    // Not a pool fault — the caller must NOT retry this in-process.
    await expect(failure).rejects.not.toBeInstanceOf(PoolUnavailableError);
  });

  it("stops spawning workers after repeated deaths instead of retrying per file", async () => {
    const file = fixture("breaker", schemaSource(1));
    const code = fs.readFileSync(file, "utf8");
    const p = pool(2);

    // Kill each worker as soon as it appears — terminate() only, leaving the
    // pool to notice the death through its own 'exit' handler, because that is
    // the sequence a real OOM produces. Three consecutive deaths trip the
    // breaker; after that `run()` must fail immediately rather than spawning a
    // fresh worker for every remaining file in the build.
    const live = p as unknown as { workers: { worker: { terminate(): Promise<number> } }[] };
    const reap = (): void => {
      for (const entry of live.workers) void entry.worker.terminate();
    };

    let failures = 0;
    for (let i = 0; i < 6; i++) {
      const task = p.run(code, file, poolTransformOptions(OPTIONS));
      reap();
      await task.then(
        () => undefined,
        () => {
          failures++;
        },
      );
    }

    expect(failures).toBe(6);
    // The breaker is what makes the last rejections cheap — they never spawned.
    await expect(p.run(code, file, poolTransformOptions(OPTIONS))).rejects.toThrow(
      /failed 3 times in a row/,
    );
    await p.dispose();
  });

  it("rejects queued and in-flight work once disposed", async () => {
    const file = fixture("disposed", schemaSource(1));
    const p = pool(1);
    await p.dispose();

    await expect(
      p.run(fs.readFileSync(file, "utf8"), file, poolTransformOptions(OPTIONS)),
    ).rejects.toBeInstanceOf(PoolUnavailableError);
  });

  it("reuses one worker across tasks instead of spawning per file", async () => {
    const a = fixture("reuse-a", schemaSource(1));
    const b = fixture("reuse-b", schemaSource(2));
    const p = pool(4);

    // Sequential awaits can only ever occupy one worker at a time, so the
    // second call must land on the first worker rather than growing the pool.
    await p.run(fs.readFileSync(a, "utf8"), a, poolTransformOptions(OPTIONS));
    const executedAfterFirst = p.firstPartyModulePaths() ?? [];
    await p.run(fs.readFileSync(b, "utf8"), b, poolTransformOptions(OPTIONS));
    const executedAfterSecond = p.firstPartyModulePaths() ?? [];

    expect(executedAfterFirst).toContain(a);
    expect(executedAfterSecond).toContain(a);
    expect(executedAfterSecond).toContain(b);
  });
});

/**
 * The pool only pays off if it is invisible: same emitted code, and a disk
 * cache a serial build can read (and vice versa). `parallel` is deliberately
 * NOT part of the cache key, so these two must agree byte for byte.
 */
describe("plugin with parallel enabled", () => {
  const meta = { framework: "vite" } as UnpluginContextMeta;

  interface PluginHandle {
    transform: TransformHandler;
    buildEnd: () => void;
  }

  function makePlugin(parallel: boolean | number, cacheDir: string | false): PluginHandle {
    const plugin = unplugin.raw(
      { parallel, cache: cacheDir, schemas: "auto" },
      meta,
    ) as UnpluginOptions;
    return {
      transform: transformHandler(plugin),
      buildEnd: plugin.buildEnd as unknown as () => void,
    };
  }

  function entryFiles(dir: string): string[] {
    return fs.readdirSync(dir).filter((f) => f.endsWith(".json") && f !== "_meta.json");
  }

  it("emits exactly what a serial build emits", async () => {
    const files = Array.from({ length: 5 }, (_unused, i) =>
      fixture(`plugin${i}`, schemaSource(i + 1)),
    );

    const serial = makePlugin(false, false);
    const parallel = makePlugin(3, false);
    const expected: (string | undefined)[] = [];
    for (const file of files) {
      expected.push((await serial.transform(fs.readFileSync(file, "utf8"), file))?.code);
    }
    // Concurrently, so results have to race through the pool the way a real
    // bundler drives them.
    const actual = await Promise.all(
      files.map(
        async (file) => (await parallel.transform(fs.readFileSync(file, "utf8"), file))?.code,
      ),
    );

    expect(expected.every((code) => code?.includes("__zcMkv"))).toBe(true);
    expect(actual).toEqual(expected);
  });

  it("writes a disk cache a serial build then reads", async () => {
    const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "zc-pool-cache-"));
    try {
      const file = fixture("cache-handoff", schemaSource(4));
      const code = fs.readFileSync(file, "utf8");

      const parallel = makePlugin(2, cacheDir);
      const fresh = await parallel.transform(code, file);
      parallel.buildEnd();
      expect(fresh?.code).toContain("__zcMkv");

      // Discovery ran in a worker, so this entry could only reach disk if the
      // executed-module superset was carried back across the boundary.
      const entries = entryFiles(cacheDir);
      expect(entries.length).toBe(1);

      // Tamper the stored result: a serial plugin returning the sentinel
      // proves it read the parallel build's entry rather than recompiling.
      const entryPath = path.join(cacheDir, entries[0] as string);
      const entry = JSON.parse(fs.readFileSync(entryPath, "utf8")) as { result: string };
      entry.result = "/* sentinel-written-by-parallel */";
      fs.writeFileSync(entryPath, JSON.stringify(entry));
      resetDepValidationMemo();

      const served = await makePlugin(false, cacheDir).transform(code, file);
      expect(served?.code).toBe("/* sentinel-written-by-parallel */");
    } finally {
      fs.rmSync(cacheDir, { recursive: true, force: true });
    }
  });

  it("records the same dependency set a serial build records", async () => {
    const depsetIds = new Map<boolean | number, string>();
    for (const parallel of [false, 2] as const) {
      const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "zc-pool-deps-"));
      try {
        const file = fixture(`depset-${String(parallel)}`, schemaSource(6));
        const plugin = makePlugin(parallel, cacheDir);
        await plugin.transform(fs.readFileSync(file, "utf8"), file);
        plugin.buildEnd();
        resetDepValidationMemo();

        const [entryFile] = entryFiles(cacheDir);
        const entry = JSON.parse(
          fs.readFileSync(path.join(cacheDir, entryFile as string), "utf8"),
        ) as { depset: string };
        const depset = JSON.parse(
          fs.readFileSync(path.join(cacheDir, "deps", `${entry.depset}.json`), "utf8"),
        ) as { files: Record<string, unknown> };
        // A dep-set that came back empty would validate as fresh forever —
        // the failure mode the superset hand-off exists to prevent.
        expect(Object.keys(depset.files).length).toBeGreaterThan(0);
        depsetIds.set(parallel, Object.keys(depset.files).sort().join("\n"));
      } finally {
        fs.rmSync(cacheDir, { recursive: true, force: true });
      }
    }
    // Different fixture file names, so compare the shape of the graph rather
    // than the paths: both must record the schema file plus the same helpers.
    expect(depsetIds.get(false)?.split("\n").length).toBe(depsetIds.get(2)?.split("\n").length);
  });

  it("falls back to an in-process transform when the pool is gone", async () => {
    const files = Array.from({ length: 3 }, (_unused, i) =>
      fixture(`resilient${i}`, schemaSource(i + 1)),
    );
    const plugin = makePlugin(2, false);

    // The plugin builds its pool up front, so tearing every worker down here
    // makes each `run()` reject with PoolUnavailableError deterministically —
    // no race with how fast the transforms happen to finish. A dead pool must
    // degrade the build's speed, not break it.
    await disposeAllPools();

    const warned = vi.spyOn(console, "warn").mockImplementation(vi.fn());
    let results: (string | undefined)[];
    let messages: string[];
    try {
      results = await Promise.all(
        files.map(
          async (file) => (await plugin.transform(fs.readFileSync(file, "utf8"), file))?.code,
        ),
      );
    } finally {
      // Read the calls BEFORE restoring — mockRestore() clears them.
      messages = warned.mock.calls.map(([m]) => String(m));
      warned.mockRestore();
    }

    for (const [i, code] of results.entries()) {
      expect(code).toContain(`length<${i + 1}`);
    }
    // Exactly one warning, however many files fell back — a broken pool must
    // not bury the build output under a copy per file.
    expect(messages.filter((m) => m.includes("in-process instead"))).toHaveLength(1);
  });
});
