import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import {
  computeBuildFingerprint,
  DiskCache,
  resetDepValidationMemo,
} from "#src/unplugin/disk-cache.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zc-cache-test-"));
  resetDepValidationMemo();
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writeDep(name: string, content: string): string {
  const p = path.join(tmpDir, name);
  fs.writeFileSync(p, content);
  return p;
}

/** Cache-dir listing helpers (exclude bookkeeping files). */
function entryFiles(dir: string): string[] {
  return fs.readdirSync(dir).filter((f) => f.endsWith(".json") && f !== "_meta.json");
}
function depsetFiles(dir: string): string[] {
  return fs.readdirSync(path.join(dir, "deps")).filter((f) => f.endsWith(".json"));
}

describe("DiskCache", () => {
  it("key is stable for identical inputs and sensitive to id/code/options", () => {
    const a = new DiskCache(tmpDir, "opts-a");
    const b = new DiskCache(tmpDir, "opts-b");
    expect(a.key("/x.ts", "code")).toBe(a.key("/x.ts", "code"));
    expect(a.key("/x.ts", "code")).not.toBe(a.key("/y.ts", "code"));
    expect(a.key("/x.ts", "code")).not.toBe(a.key("/x.ts", "code2"));
    expect(a.key("/x.ts", "code")).not.toBe(b.key("/x.ts", "code"));
  });

  it("save → load roundtrips result, depset reference, and stats", () => {
    const dir = path.join(tmpDir, "cache");
    const cache = new DiskCache(dir, "opts");
    const dep = writeDep("dep.ts", "export const x = 1;");
    const key = cache.key("/file.ts", "source");

    cache.save(key, "transformed!", [dep], { schemas: 2, optimized: 1 });
    const entry = cache.load(key);

    expect(entry).not.toBeNull();
    expect(entry?.result).toBe("transformed!");
    expect(entry?.stats).toEqual({ schemas: 2, optimized: 1 });
    // The dep map lives in a shared content-addressed file, not the entry.
    expect(typeof entry?.depset).toBe("string");
    const depset = JSON.parse(
      fs.readFileSync(path.join(dir, "deps", `${entry?.depset}.json`), "utf8"),
    ) as { files: Record<string, unknown> };
    expect(Object.keys(depset.files)).toEqual([dep]);
  });

  it("entries with identical dep sets share one depset file", () => {
    const dir = path.join(tmpDir, "cache");
    const cache = new DiskCache(dir, "opts");
    const dep = writeDep("dep.ts", "export const x = 1;");

    cache.save(cache.key("/a.ts", "a"), "result-a", [dep]);
    cache.save(cache.key("/b.ts", "b"), "result-b", [dep]);

    expect(entryFiles(dir).length).toBe(2);
    expect(depsetFiles(dir).length).toBe(1);
  });

  it("null results roundtrip (cached negative outcomes)", () => {
    const cache = new DiskCache(path.join(tmpDir, "cache"), "opts");
    const key = cache.key("/file.ts", "source");
    cache.save(key, null, []);
    const entry = cache.load(key);
    expect(entry).not.toBeNull();
    expect(entry?.result).toBeNull();
  });

  it("misses when a dep's content changed", () => {
    const cache = new DiskCache(path.join(tmpDir, "cache"), "opts");
    const dep = writeDep("dep.ts", "export const x = 1;");
    const key = cache.key("/file.ts", "source");
    cache.save(key, "result", [dep]);

    fs.writeFileSync(dep, "export const x = 2;");
    resetDepValidationMemo();

    expect(cache.load(key)).toBeNull();
  });

  it("hits when a dep is touched but content is unchanged (hash fallback)", () => {
    const cache = new DiskCache(path.join(tmpDir, "cache"), "opts");
    const dep = writeDep("dep.ts", "export const x = 1;");
    const key = cache.key("/file.ts", "source");
    cache.save(key, "result", [dep]);

    const future = new Date(Date.now() + 5000);
    fs.utimesSync(dep, future, future);
    resetDepValidationMemo();

    expect(cache.load(key)?.result).toBe("result");
  });

  it("gives a touched dep the SAME depset id (a checkout must not fork depsets)", () => {
    // The id hashes (path, content-hash) pairs only. Folding mtime in would
    // still validate correctly — the hash fallback above covers that — but every
    // CI run starts from a fresh checkout where every mtime is the clone time,
    // so each run would write a whole new depset file for unchanged sources.
    // That is the shape of the 283 MB field incident the v2 layout exists to fix.
    const cache = new DiskCache(path.join(tmpDir, "cache"), "opts");
    const dep = writeDep("dep.ts", "export const x = 1;");
    cache.save(cache.key("/a.ts", "source-a"), "result-a", [dep]);
    expect(depsetFiles(path.join(tmpDir, "cache"))).toHaveLength(1);

    // Re-stamp the dep as a fresh checkout would, then cache a second file
    // against the same (unchanged) dependency.
    const future = new Date(Date.now() + 60_000);
    fs.utimesSync(dep, future, future);
    resetDepValidationMemo();
    cache.save(cache.key("/b.ts", "source-b"), "result-b", [dep]);

    expect(depsetFiles(path.join(tmpDir, "cache"))).toHaveLength(1);
    expect(cache.load(cache.key("/a.ts", "source-a"))?.result).toBe("result-a");
    expect(cache.load(cache.key("/b.ts", "source-b"))?.result).toBe("result-b");
  });

  it("misses when a dep file was deleted", () => {
    const cache = new DiskCache(path.join(tmpDir, "cache"), "opts");
    const dep = writeDep("dep.ts", "export const x = 1;");
    const key = cache.key("/file.ts", "source");
    cache.save(key, "result", [dep]);

    fs.rmSync(dep);
    resetDepValidationMemo();

    expect(cache.load(key)).toBeNull();
  });

  it("misses when the referenced depset file is missing or corrupt", () => {
    const dir = path.join(tmpDir, "cache");
    const cache = new DiskCache(dir, "opts");
    const dep = writeDep("dep.ts", "export const x = 1;");
    const key = cache.key("/file.ts", "source");
    cache.save(key, "result", [dep]);

    const [depsetFile] = depsetFiles(dir);
    fs.writeFileSync(path.join(dir, "deps", depsetFile as string), "{not json");
    resetDepValidationMemo();
    expect(cache.load(key)).toBeNull();

    fs.rmSync(path.join(dir, "deps", depsetFile as string));
    resetDepValidationMemo();
    expect(cache.load(key)).toBeNull();
  });

  it("misses for unknown keys and corrupt entries", () => {
    const dir = path.join(tmpDir, "cache");
    const cache = new DiskCache(dir, "opts");
    expect(cache.load(cache.key("/missing.ts", "x"))).toBeNull();

    const key = cache.key("/corrupt.ts", "x");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${key}.json`), "{not json");
    expect(cache.load(key)).toBeNull();
  });

  it("does not persist when a dep cannot be read", () => {
    const cache = new DiskCache(path.join(tmpDir, "cache"), "opts");
    const key = cache.key("/file.ts", "source");
    cache.save(key, "result", [path.join(tmpDir, "never-existed.ts")]);
    expect(cache.load(key)).toBeNull();
  });

  it("resolveDir honors an explicit directory", () => {
    expect(DiskCache.resolveDir("/explicit/dir")).toBe(path.resolve("/explicit/dir"));
  });
});

describe("DiskCache — deferred superset entries", () => {
  it("flushDeferred persists all queued entries against ONE shared depset", () => {
    const dir = path.join(tmpDir, "cache");
    const depA = writeDep("a.ts", "export const a = 1;");
    const depB = writeDep("b.ts", "export const b = 2;");
    // The provider is called once at flush — all entries share the snapshot.
    let calls = 0;
    const cache = new DiskCache(dir, "opts", () => {
      calls++;
      return [depA, depB];
    });

    const k1 = cache.key("/one.ts", "one");
    const k2 = cache.key("/two.ts", "two");
    cache.saveDeferred(k1, "result-one", { schemas: 1, optimized: 0 });
    cache.saveDeferred(k2, "result-two");

    // Nothing on disk until flush.
    expect(fs.existsSync(dir)).toBe(false);

    cache.flushDeferred();
    expect(calls).toBe(1);
    expect(entryFiles(dir).length).toBe(2);
    expect(depsetFiles(dir).length).toBe(1);

    expect(cache.load(k1)?.result).toBe("result-one");
    expect(cache.load(k1)?.stats).toEqual({ schemas: 1, optimized: 0 });
    expect(cache.load(k2)?.result).toBe("result-two");

    // Idempotent: a second flush (process-exit fallback) writes nothing new.
    cache.flushDeferred();
    expect(calls).toBe(1);
  });

  it("dropDeferred discards queued entries (watch-mode change)", () => {
    const dir = path.join(tmpDir, "cache");
    const dep = writeDep("a.ts", "export const a = 1;");
    const cache = new DiskCache(dir, "opts", () => [dep]);

    cache.saveDeferred(cache.key("/one.ts", "one"), "stale-result");
    cache.dropDeferred();
    cache.flushDeferred();

    expect(fs.existsSync(dir) ? entryFiles(dir) : []).toEqual([]);
  });

  it("flushDeferred without a usable snapshot persists nothing", () => {
    const dir = path.join(tmpDir, "cache");
    const cache = new DiskCache(dir, "opts", () => null);
    cache.saveDeferred(cache.key("/one.ts", "one"), "result");
    cache.flushDeferred();
    expect(fs.existsSync(dir) ? entryFiles(dir) : []).toEqual([]);
  });
});

describe("DiskCache — format migration and GC", () => {
  it("wipes a v1-format directory (no _meta marker) on first use", () => {
    const dir = path.join(tmpDir, "cache");
    fs.mkdirSync(dir, { recursive: true });
    // v1 entries inlined deps; 283 MB of these in the field report.
    fs.writeFileSync(path.join(dir, "deadbeef.json"), JSON.stringify({ result: "x", deps: {} }));

    const cache = new DiskCache(dir, "opts");
    expect(cache.load(cache.key("/x.ts", "x"))).toBeNull();

    expect(fs.existsSync(path.join(dir, "deadbeef.json"))).toBe(false);
    expect(JSON.parse(fs.readFileSync(path.join(dir, "_meta.json"), "utf8"))).toEqual({
      format: 2,
    });
  });

  it("leaves the transpile cache standing when it wipes its own entries", () => {
    const dir = path.join(tmpDir, "cache");
    fs.mkdirSync(path.join(dir, "jiti"), { recursive: true });
    fs.writeFileSync(path.join(dir, "deadbeef.json"), JSON.stringify({ result: "x", deps: {} }));
    // Kept beside the entries (see transpile-cache.ts) and stamped on its own
    // terms: a layout change here says nothing about a transpile, and the
    // transpiles are what makes refilling the wiped entries quick.
    const transpile = path.join(dir, "jiti", "schema.ts.0123456789abcdef.cjs");
    fs.writeFileSync(transpile, "/* zod-compiler transpile 00 */\nexports.a = 1;");

    const cache = new DiskCache(dir, "opts");
    expect(cache.load(cache.key("/x.ts", "x"))).toBeNull();

    expect(fs.existsSync(path.join(dir, "deadbeef.json"))).toBe(false);
    expect(fs.existsSync(transpile)).toBe(true);
    expect(fs.existsSync(path.join(dir, "deps"))).toBe(true);
  });

  it("GC removes expired entries and unreferenced depsets, keeps live ones", () => {
    const dir = path.join(tmpDir, "cache");
    const dep = writeDep("dep.ts", "export const x = 1;");
    const writer = new DiskCache(dir, "opts");
    const liveKey = writer.key("/live.ts", "live");
    const oldKey = writer.key("/old.ts", "old");
    writer.save(liveKey, "live-result", [dep]);
    writer.save(oldKey, "old-result", [dep]);

    // Age the old entry past the 30-day horizon and plant an orphan depset.
    const ancient = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
    fs.utimesSync(path.join(dir, `${oldKey}.json`), ancient, ancient);
    fs.writeFileSync(path.join(dir, "deps", `${"0".repeat(40)}.json`), '{"files":{}}');
    fs.rmSync(path.join(dir, "_gc"), { force: true });

    // A fresh instance triggers the throttled GC on init.
    const reader = new DiskCache(dir, "opts");
    expect(reader.load(liveKey)?.result).toBe("live-result");

    expect(fs.existsSync(path.join(dir, `${oldKey}.json`))).toBe(false);
    expect(fs.existsSync(path.join(dir, "deps", `${"0".repeat(40)}.json`))).toBe(false);
    // The live entry's depset survives.
    expect(depsetFiles(dir).length).toBe(1);
    // Marker claimed: next init within the interval skips the sweep.
    expect(fs.existsSync(path.join(dir, "_gc"))).toBe(true);
  });
});

describe("computeBuildFingerprint", () => {
  /** A package tree as an install materialises it: fresh files, fresh mtimes. */
  const PKG: Record<string, string> = {
    "dist/index.js": "export const compile = 1;",
    "dist/index.d.ts": "export declare const compile: number;",
    "dist/unplugin/disk-cache.js": "export class DiskCache {}",
    "dist/tsconfig.tsbuildinfo.json": '{"version":"5"}',
    "dist/README.md": "not part of the build identity",
  };

  function writePackage(root: string): string {
    for (const [rel, content] of Object.entries(PKG)) {
      const p = path.join(root, rel);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, content);
    }
    return root;
  }

  it("survives a reinstall that rewrites every mtime", () => {
    // pnpm's `copy` import method — forced whenever the store sits on a
    // different filesystem, as on CI runners that mount it as its own volume —
    // stamps a wall-clock mtime on every file of every install. Keyed on
    // mtime, the fingerprint rotated on each `pnpm install --frozen-lockfile`,
    // so the whole key space moved and a restored cache archive was unpacked
    // and then never read. Hardlink and APFS-clone installs preserve mtimes,
    // which is why this only ever reproduced in CI. Same class of bug the
    // depset id avoids by hashing content — one level up.
    const root = writePackage(path.join(tmpDir, "pkg"));
    const before = computeBuildFingerprint(root);

    const later = new Date(Date.now() + 24 * 60 * 60 * 1000);
    for (const rel of Object.keys(PKG)) fs.utimesSync(path.join(root, rel), later, later);

    expect(computeBuildFingerprint(root)).toBe(before);
  });

  it("is identical for the same package materialised at another path", () => {
    // A different runner, workspace directory, and store layout.
    const a = writePackage(path.join(tmpDir, "runner-a", "node_modules", "zod-compiler"));
    const b = writePackage(path.join(tmpDir, "runner-b", ".pnpm", "zod-compiler@1.0.0"));

    expect(computeBuildFingerprint(b)).toBe(computeBuildFingerprint(a));
  });

  it("still changes when the compiler is rebuilt without a version bump", () => {
    // The reason the fingerprint exists at all: file:/linked/canary installs
    // rebuild dist in place, and serving codegen from the older build would be
    // silently stale.
    const root = writePackage(path.join(tmpDir, "pkg"));
    const before = computeBuildFingerprint(root);

    fs.writeFileSync(path.join(root, "dist", "index.js"), "export const compile = 2;");

    expect(computeBuildFingerprint(root)).not.toBe(before);
  });

  it("changes when a build file appears or disappears", () => {
    const root = writePackage(path.join(tmpDir, "pkg"));
    const before = computeBuildFingerprint(root);

    fs.writeFileSync(path.join(root, "dist", "extra.js"), "export const extra = 1;");
    expect(computeBuildFingerprint(root)).not.toBe(before);

    fs.rmSync(path.join(root, "dist", "extra.js"));
    expect(computeBuildFingerprint(root)).toBe(before);
  });

  it("ignores files that are not part of the build", () => {
    const root = writePackage(path.join(tmpDir, "pkg"));
    const before = computeBuildFingerprint(root);

    fs.writeFileSync(path.join(root, "dist", "CHANGELOG.md"), "# 1.0.1");

    expect(computeBuildFingerprint(root)).toBe(before);
  });
});
