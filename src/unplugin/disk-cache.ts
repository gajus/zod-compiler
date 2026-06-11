/**
 * Persistent transform-result cache.
 *
 * The expensive part of the unplugin transform is discovery: executing the
 * schema file (and transitively its whole first-party import graph) through
 * jiti inside the bundler's single-threaded server process. The in-memory
 * caches die with the process, so every `vitest run` / build re-pays that
 * cost even when nothing changed — which is exactly the loop integration
 * tests live in.
 *
 * Entries are keyed by a hash of (plugin version, zod version, transform
 * options, file id, file content) and validated against a recorded snapshot
 * of first-party files. Validation uses an mtime+size fast path and falls
 * back to content hashing, so a `touch` without changes still hits. A
 * superset of true dependencies only over-invalidates, never serves stale
 * output.
 *
 * Layout (CACHE_FORMAT 2): dependency snapshots are CONTENT-ADDRESSED and
 * shared — `deps/<sha1>.json` holds the {path → hash/mtime/size} map, and
 * each entry stores only the dep-set id. The v1 format inlined the full dep
 * map into every entry; in a large-codebase field report 835 superset-
 * fallback entries each embedded a ~1,900-file point-in-time snapshot (813
 * DISTINCT snapshots — the executed-modules superset grows as the build
 * progresses, so per-entry copies cannot even dedupe), totalling 283 MB
 * that any commit invalidated wholesale. Sharing dep-sets also means each
 * unique set is parsed and validated once per process instead of once per
 * entry.
 *
 * Superset fallbacks (entries whose static dep crawl was incomplete) are
 * DEFERRED: queued in memory and flushed in buildEnd / process exit against
 * a single end-of-build superset snapshot, so every superset entry of a
 * build shares ONE dep-set file (recording the still-growing snapshot at
 * save time is what produced 813 distinct copies). Deferred entries are
 * dropped on watchChange — a dependency edited between queueing and flush
 * would pair post-change hashes with a pre-change result, which is the one
 * combination that can serve stale output. A killed process loses only its
 * pending superset entries (the static-complete majority persists
 * immediately); the next run re-pays discovery for those files alone.
 *
 * Writes are atomic (tmp file + rename) so concurrent bundler processes
 * (vitest workspace projects) can share one cache directory safely.
 */

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

/** Bump when the on-disk layout changes; mismatched directories are wiped. */
const CACHE_FORMAT = 2;
const META_FILE = "_meta.json";
const GC_MARKER = "_gc";
const DEPSET_DIR = "deps";
/** GC at most once per day per cache directory. */
const GC_INTERVAL_MS = 24 * 60 * 60 * 1000;
/** Entries unread for this long are presumed orphaned by key churn. */
const MAX_ENTRY_AGE_MS = 30 * 24 * 60 * 60 * 1000;
/** Stale atomic-write temp files (crashed processes) older than this are removed. */
const MAX_TMP_AGE_MS = 60 * 60 * 1000;

export interface CacheEntryStats {
  schemas: number;
  optimized: number;
}

interface DepRecord {
  hash: string;
  mtimeMs: number;
  size: number;
}

export interface CacheEntry {
  /** Transformed code, or null when the transform produced no change. */
  result: string | null;
  /** Content-addressed id of the shared dep-set file (deps/<id>.json). */
  depset: string;
  /** Build stats to replay on cache hits (only present when schemas compiled). */
  stats?: CacheEntryStats;
  /** Composed sourcemap for `result` (original → transformed). */
  map?: CacheSourceMap | null;
}

/** JSON shape of the persisted sourcemap (mirrors TransformSourceMap). */
export interface CacheSourceMap {
  version: number;
  sources: (string | null)[];
  sourcesContent?: (string | null)[];
  names: string[];
  mappings: string;
  file?: string | null;
}

interface DepsetFile {
  files: Record<string, DepRecord>;
}

interface PendingEntry {
  key: string;
  result: string | null;
  stats?: CacheEntryStats | undefined;
  map?: CacheSourceMap | null | undefined;
}

function sha1(data: string | Buffer): string {
  return createHash("sha1").update(data).digest("hex");
}

/** Read own package version once for cache keying (src and dist both sit two levels below the package root). */
function readPluginVersion(): string {
  try {
    const pkgPath = new URL("../../package.json", import.meta.url);
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8")) as { version?: string };
    return pkg.version ?? "0";
  } catch {
    return "0";
  }
}

/** Resolve the installed zod version — generated code depends on zod internals. */
function readZodVersion(): string {
  try {
    const pkgPath = path.join(process.cwd(), "node_modules", "zod", "package.json");
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8")) as { version?: string };
    return pkg.version ?? "0";
  } catch {
    return "0";
  }
}

/**
 * Build fingerprint: the newest mtime across the package's own source trees.
 * The published version string alone is not enough — file: installs, linked
 * monorepo packages, and canary builds rebuild the compiler without a version
 * bump, and serving codegen from an older compiler build would be silently
 * stale. Walking ~200 dirents once per process costs ~1ms.
 */
function readBuildFingerprint(): string {
  let newest = 0;
  let files = 0;
  const walk = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(p);
      } else if (/\.(?:js|ts|json)$/.test(entry.name)) {
        try {
          const m = fs.statSync(p).mtimeMs;
          files++;
          if (m > newest) newest = m;
        } catch {
          // unreadable file — ignore
        }
      }
    }
  };
  try {
    const root = fileURLToPath(new URL("../..", import.meta.url));
    for (const sub of ["dist", "src"]) {
      walk(path.join(root, sub));
    }
  } catch {
    return "0";
  }
  return `${newest}:${files}`;
}

const PLUGIN_VERSION = readPluginVersion();
const ZOD_VERSION = readZodVersion();
const BUILD_FINGERPRINT = readBuildFingerprint();

/**
 * Per-process memo: path → current stat (+ lazily computed content hash).
 * One fs.stat per file per process regardless of how many dep-sets
 * reference it; content is read at most once.
 */
const depStatMemo = new Map<string, { mtimeMs: number; size: number; hash?: string } | null>();

/** Per-process memo: dep-set file path → validation verdict. */
const depsetVerdictMemo = new Map<string, boolean>();

function statDep(depPath: string): { mtimeMs: number; size: number; hash?: string } | null {
  const memo = depStatMemo.get(depPath);
  if (memo !== undefined) return memo;
  let result: { mtimeMs: number; size: number; hash?: string } | null;
  try {
    const stat = fs.statSync(depPath);
    result = { mtimeMs: stat.mtimeMs, size: stat.size };
  } catch {
    result = null;
  }
  depStatMemo.set(depPath, result);
  return result;
}

function hashDep(
  depPath: string,
  stat: { mtimeMs: number; size: number; hash?: string },
): string | null {
  if (stat.hash !== undefined) return stat.hash;
  try {
    stat.hash = sha1(fs.readFileSync(depPath));
    return stat.hash;
  } catch {
    return null;
  }
}

/** Reset the per-process dep validation memos (watch-mode file changes). */
export function resetDepValidationMemo(): void {
  depStatMemo.clear();
  depsetVerdictMemo.clear();
}

/** Instances with pending deferred entries, flushed on process exit. */
const flushOnExit = new Set<DiskCache>();
let exitHookInstalled = false;

function registerExitFlush(cache: DiskCache): void {
  flushOnExit.add(cache);
  if (!exitHookInstalled) {
    exitHookInstalled = true;
    // 'exit' allows only synchronous work; every write below is sync.
    process.once("exit", () => {
      for (const c of flushOnExit) c.flushDeferred();
    });
  }
}

export class DiskCache {
  private readonly dir: string;
  private readonly optionsKey: string;
  /** Superset snapshot provider (loader's executed first-party modules). */
  private readonly superset: (() => string[] | null) | null;
  private pending: PendingEntry[] = [];
  private initialized = false;

  constructor(dir: string, optionsKey: string, superset?: () => string[] | null) {
    this.dir = dir;
    this.optionsKey = optionsKey;
    this.superset = superset ?? null;
  }

  /**
   * Resolve the cache directory: an explicit string wins; otherwise
   * node_modules/.cache/zod-compiler under cwd (falling back to a
   * project-local .zod-compiler-cache when node_modules doesn't exist).
   */
  static resolveDir(cacheOption: string | true): string {
    if (typeof cacheOption === "string") return path.resolve(cacheOption);
    const nm = path.join(process.cwd(), "node_modules");
    if (fs.existsSync(nm)) return path.join(nm, ".cache", "zod-compiler");
    return path.join(process.cwd(), ".zod-compiler-cache");
  }

  key(id: string, code: string): string {
    return sha1(
      `${PLUGIN_VERSION}\0${BUILD_FINGERPRINT}\0${ZOD_VERSION}\0${this.optionsKey}\0${id}\0${code}`,
    );
  }

  private entryPath(key: string): string {
    return path.join(this.dir, `${key}.json`);
  }

  private depsetPath(id: string): string {
    return path.join(this.dir, DEPSET_DIR, `${id}.json`);
  }

  /**
   * One-time directory init: wipe on format mismatch (v1 inline-deps caches
   * reached 283 MB in the field — disposable by definition), then a
   * throttled GC pass. Best-effort throughout; a concurrent wipe/GC from
   * another process can only cause cache misses, never stale hits.
   */
  private ensureDir(): void {
    if (this.initialized) return;
    this.initialized = true;
    try {
      const metaPath = path.join(this.dir, META_FILE);
      let format = 0;
      try {
        format = (JSON.parse(fs.readFileSync(metaPath, "utf8")) as { format?: number }).format ?? 0;
      } catch {
        // missing or unreadable marker — treat as foreign format
      }
      if (format !== CACHE_FORMAT) {
        fs.rmSync(this.dir, { recursive: true, force: true });
        fs.mkdirSync(path.join(this.dir, DEPSET_DIR), { recursive: true });
        fs.writeFileSync(metaPath, JSON.stringify({ format: CACHE_FORMAT }));
      } else {
        fs.mkdirSync(path.join(this.dir, DEPSET_DIR), { recursive: true });
        this.maybeGc();
      }
    } catch {
      // cache stays best-effort
    }
  }

  /**
   * Throttled sweep: entries older than MAX_ENTRY_AGE_MS (orphaned by key
   * churn — content/version/options keys never repeat once inputs change)
   * and dep-set files no surviving entry references. Runs at most once per
   * GC_INTERVAL_MS per directory; the marker is claimed BEFORE sweeping so
   * concurrent processes skip. Deleting a dep-set raced by a concurrent
   * entry write only costs that entry a future miss — save() re-creates
   * absent dep-set files.
   */
  private maybeGc(): void {
    const marker = path.join(this.dir, GC_MARKER);
    try {
      const stat = fs.statSync(marker, { throwIfNoEntry: false });
      if (stat !== undefined && Date.now() - stat.mtimeMs < GC_INTERVAL_MS) return;
      fs.writeFileSync(marker, "");

      const now = Date.now();
      const referenced = new Set<string>();
      for (const name of fs.readdirSync(this.dir)) {
        const p = path.join(this.dir, name);
        if (name.endsWith(".tmp")) {
          const st = fs.statSync(p, { throwIfNoEntry: false });
          if (st !== undefined && now - st.mtimeMs > MAX_TMP_AGE_MS) fs.rmSync(p, { force: true });
          continue;
        }
        if (!name.endsWith(".json") || name === META_FILE) continue;
        try {
          const st = fs.statSync(p);
          if (now - st.mtimeMs > MAX_ENTRY_AGE_MS) {
            fs.rmSync(p, { force: true });
            continue;
          }
          const entry = JSON.parse(fs.readFileSync(p, "utf8")) as { depset?: string };
          if (typeof entry.depset === "string") referenced.add(entry.depset);
        } catch {
          fs.rmSync(p, { force: true });
        }
      }
      for (const name of fs.readdirSync(path.join(this.dir, DEPSET_DIR))) {
        if (!name.endsWith(".json")) continue;
        const id = name.slice(0, -".json".length);
        if (!referenced.has(id)) {
          fs.rmSync(path.join(this.dir, DEPSET_DIR, name), { force: true });
        }
      }
    } catch {
      // best effort
    }
  }

  /** Load an entry and validate its dep-set. Any failure → null. */
  load(key: string): CacheEntry | null {
    this.ensureDir();
    let entry: CacheEntry;
    try {
      entry = JSON.parse(fs.readFileSync(this.entryPath(key), "utf8")) as CacheEntry;
    } catch {
      return null;
    }
    if (entry === null || typeof entry !== "object" || typeof entry.depset !== "string") {
      return null;
    }
    if (!this.validateDepset(entry.depset)) return null;
    return entry;
  }

  /**
   * Validate every dep in a dep-set, once per process per set: superset
   * entries all share one set, so the ~N-file validation (and the JSON
   * parse) happens once instead of once per entry.
   */
  private validateDepset(id: string): boolean {
    const depsetFile = this.depsetPath(id);
    const memo = depsetVerdictMemo.get(depsetFile);
    if (memo !== undefined) return memo;
    let verdict = true;
    try {
      const parsed = JSON.parse(fs.readFileSync(depsetFile, "utf8")) as DepsetFile;
      if (parsed === null || typeof parsed !== "object" || typeof parsed.files !== "object") {
        verdict = false;
      } else {
        for (const [depPath, recorded] of Object.entries(parsed.files)) {
          const current = statDep(depPath);
          if (current === null) {
            verdict = false;
            break;
          }
          if (current.mtimeMs === recorded.mtimeMs && current.size === recorded.size) continue;
          if (hashDep(depPath, current) !== recorded.hash) {
            verdict = false;
            break;
          }
        }
      }
    } catch {
      verdict = false;
    }
    depsetVerdictMemo.set(depsetFile, verdict);
    return verdict;
  }

  /**
   * Stat + hash every dep into a content-addressed record map. The id hashes
   * sorted (path, content-hash) pairs ONLY — mtimes are validation fast-path
   * hints and must not fork the file name across checkouts/touches. Returns
   * null when any dep cannot be read (an unvalidatable set must not persist).
   */
  private buildDepset(depPaths: readonly string[]): { id: string; content: DepsetFile } | null {
    const records: Record<string, DepRecord> = {};
    for (const depPath of depPaths) {
      if (records[depPath] !== undefined) continue;
      const stat = statDep(depPath);
      const hash = stat === null ? null : hashDep(depPath, stat);
      if (stat === null || hash === null) return null;
      records[depPath] = { hash, mtimeMs: stat.mtimeMs, size: stat.size };
    }
    const sorted = Object.keys(records).sort();
    const id = sha1(sorted.map((p) => `${p}\0${(records[p] as DepRecord).hash}`).join("\n"));
    return { id, content: { files: records } };
  }

  /** Write a dep-set file if absent (content-addressed: same id ⟹ same bytes). */
  private writeDepset(id: string, content: DepsetFile): boolean {
    const file = this.depsetPath(id);
    try {
      if (fs.existsSync(file)) return true;
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(content));
      fs.renameSync(tmp, file);
      return true;
    } catch {
      return false;
    }
  }

  private writeEntry(
    key: string,
    depsetId: string,
    result: string | null,
    stats?: CacheEntryStats,
    map?: CacheSourceMap | null,
  ): void {
    const entry: CacheEntry = { result, depset: depsetId };
    if (stats) entry.stats = stats;
    if (map !== undefined && map !== null) {
      // The remapping result is a class instance; persist its JSON fields.
      entry.map = {
        version: map.version,
        sources: map.sources,
        ...(map.sourcesContent !== undefined ? { sourcesContent: map.sourcesContent } : {}),
        names: map.names,
        mappings: map.mappings,
        ...(map.file !== undefined ? { file: map.file } : {}),
      };
    }
    try {
      const file = this.entryPath(key);
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(entry));
      fs.renameSync(tmp, file);
    } catch {
      // Cache writes are best-effort; failures only cost a recompute.
    }
  }

  /** Persist an entry whose dependency set is fully known (static crawl complete). */
  save(
    key: string,
    result: string | null,
    depPaths: readonly string[],
    stats?: CacheEntryStats,
    map?: CacheSourceMap | null,
  ): void {
    this.ensureDir();
    const built = this.buildDepset(depPaths);
    if (built === null) return;
    if (!this.writeDepset(built.id, built.content)) return;
    this.writeEntry(key, built.id, result, stats, map);
  }

  /**
   * Queue an entry whose static dep crawl was incomplete. Persisted by
   * flushDeferred() against ONE end-of-build superset snapshot — recording
   * the snapshot at save time gave every entry a distinct point-in-time
   * copy (the executed-modules set grows as discovery progresses).
   */
  saveDeferred(
    key: string,
    result: string | null,
    stats?: CacheEntryStats,
    map?: CacheSourceMap | null,
  ): void {
    if (this.superset === null) return;
    this.pending.push({ key, result, stats, map });
    registerExitFlush(this);
  }

  /**
   * Flush queued superset entries against the current loader snapshot.
   * Wired to buildEnd and (as a fallback) process exit; idempotent.
   */
  flushDeferred(): void {
    if (this.pending.length === 0) return;
    const pending = this.pending;
    this.pending = [];
    const snapshot = this.superset === null ? null : this.superset();
    if (snapshot === null) return;
    this.ensureDir();
    const built = this.buildDepset(snapshot);
    if (built === null) return;
    if (!this.writeDepset(built.id, built.content)) return;
    for (const p of pending) {
      this.writeEntry(p.key, built.id, p.result, p.stats, p.map);
    }
  }

  /**
   * Discard queued superset entries (watch-mode file change): their results
   * predate the change, but a flush would record post-change dep hashes —
   * the one pairing that could validate a stale result.
   */
  dropDeferred(): void {
    this.pending = [];
  }
}
