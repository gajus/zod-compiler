import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DiskCache, resetDepValidationMemo } from "#src/unplugin/disk-cache.js";

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
