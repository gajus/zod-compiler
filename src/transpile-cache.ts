/**
 * Persistent cache for the sources discovery transpiles.
 *
 * Discovery executes schema files through jiti, and the static filter reads
 * their exports from jiti's transpile of them — both through Babel, which is
 * the single most expensive thing a cold build does: 42% of the CPU on a
 * 400-file project, against 10% for generating the validators. jiti caches
 * its output on disk, but where it does is an accident of who asked. The
 * loader's instance takes the directory of the first file it happens to be
 * created for and, finding no `node_modules` beside it, falls back to
 * `os.tmpdir()/jiti`; the static filter's is created from the working
 * directory and lands in `node_modules/.cache/jiti`. Neither is the directory
 * the README tells CI to keep, so a restored `node_modules/.cache/zod-compiler`
 * whose entries have gone stale — a dependency bump, an option change, an edit
 * to a module half the project imports — re-ran Babel over every file it had
 * to rediscover: 4.4 s against 1.9 s on that project with the transpiles kept.
 *
 * So the transpile cache lives here instead, under the plugin's own cache
 * root, behind the `transform` hook jiti offers. jiti's own cache is switched
 * off rather than pointed at the same directory, for three things it does not
 * do: it resolves its directory once per instance, where the instances are
 * process-wide and outlive the plugin that configured them; it writes entries
 * in place and without a guard, so a directory that disappears mid-build fails
 * the load of every file after it; and it never deletes anything.
 *
 * Entries are named for the file and stamped with a hash of everything the
 * output depends on, as jiti's are: one entry per source file, overwritten
 * when the file changes, so a watch session does not leave a copy per
 * keystroke. Writes are atomic, and every failure is a miss.
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { threadId } from "node:worker_threads";
import type { createJiti, JitiOptions, TransformOptions, TransformResult } from "jiti";
import { importSites, resolveTsSpecifiers } from "./ts-specifiers.js";

/** A cache directory is swept at most this often. */
export const CACHE_GC_INTERVAL_MS = 24 * 60 * 60 * 1000;
/** Entries not rewritten for this long are presumed orphaned. */
export const CACHE_MAX_ENTRY_AGE_MS = 30 * 24 * 60 * 60 * 1000;
/** Atomic-write temp files older than this were left by a process that died. */
export const CACHE_MAX_TMP_AGE_MS = 60 * 60 * 1000;

/** Directory under a cache root that holds the transpiles. */
export const TRANSPILE_CACHE_SUBDIRECTORY = "jiti";
const GC_MARKER = "_gc";
/** Bump when an entry's layout changes; older entries then read as misses. */
const FORMAT = 2;

/**
 * The cache root the build plugin keeps its persistent state in unless told
 * otherwise, or null in a project with no `node_modules` to put it under.
 */
export function projectCacheRoot(): string | null {
  const nodeModules = path.join(process.cwd(), "node_modules");
  return fs.existsSync(nodeModules) ? path.join(nodeModules, ".cache", "zod-compiler") : null;
}

/**
 * Where transpiles go: a cache root some plugin instance chose, `null` for one
 * that asked for no persistent cache, `undefined` while nothing has said.
 */
let configuredRoot: string | null | undefined;

/**
 * Keep transpiles under `root` — the plugin's cache root, so one directory
 * holds everything a CI cache has to restore — or, given `null`, out of the
 * project altogether.
 *
 * `null` is what `cache: false` means here. It still caches, in a per-user
 * directory under the OS temp dir: a build that asked for nothing persistent
 * was getting jiti's temp-dir cache before this existed, and taking that away
 * would make every one of its runs a cold one.
 *
 * Process-wide, because the jiti instances are. An entry point that never
 * calls this — the CLI, the SWC bridge, the Turbopack loader — is in the
 * `undefined` state: the default root when the project has a `node_modules`,
 * the temp directory when it does not.
 */
export function useTranspileCache(root: string | null | undefined): void {
  configuredRoot = root;
}

/** What {@link useTranspileCache} was last given, for a worker thread to adopt. */
export function transpileCacheRoot(): string | null | undefined {
  return configuredRoot;
}

/** A boolean environment variable as jiti reads one: JSON, or the fallback. */
function environmentFlag(name: string, fallback: boolean): boolean {
  const value = process.env[name];
  if (value === undefined) return fallback;
  try {
    return Boolean(JSON.parse(value));
  } catch {
    return fallback;
  }
}

/**
 * jiti's switch for its own cache, honoured for ours: `JITI_FS_CACHE=false`
 * has always meant "transpile everything afresh", and replacing the cache it
 * governed must not make it mean nothing.
 */
function enabledByEnvironment(): boolean {
  return environmentFlag("JITI_FS_CACHE", environmentFlag("JITI_CACHE", true));
}

/**
 * A directory under the OS temp dir that only this user can enter, or null
 * when there is no such thing to be had. What is read back from the cache is
 * executed, so a temp directory shared with other users is not somewhere to
 * keep it: one of them could have created the directory first.
 */
function temporaryRoot(): string | null {
  const uid = process.getuid?.();
  const root = path.join(os.tmpdir(), uid === undefined ? "zod-compiler" : `zod-compiler-${uid}`);
  try {
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    const stat = fs.lstatSync(root);
    if (
      !stat.isDirectory() ||
      (uid !== undefined && (stat.uid !== uid || (stat.mode & 0o077) !== 0))
    ) {
      return null;
    }
    return root;
  } catch {
    return null;
  }
}

let resolved: { key: string; directory: string | null } | undefined;

/** The directory transpiles are kept in right now, or null when nowhere. */
export function transpileCacheDirectory(): string | null {
  if (!enabledByEnvironment()) return null;
  // The working directory is part of the answer while nothing is configured,
  // and a host is free to change it between builds.
  const where =
    configuredRoot === undefined ? "default" : configuredRoot === null ? "temporary" : "root";
  const key = `${where}\0${configuredRoot ?? ""}\0${process.cwd()}`;
  if (resolved?.key === key) return resolved.directory;
  const root =
    configuredRoot === undefined
      ? (projectCacheRoot() ?? temporaryRoot())
      : (configuredRoot ?? temporaryRoot());
  const directory = root === null ? null : path.join(root, TRANSPILE_CACHE_SUBDIRECTORY);
  resolved = { key, directory };
  return directory;
}

function sha1(data: string): string {
  return createHash("sha1").update(data).digest("hex");
}

let jitiVersion: string | undefined;

/**
 * The installed jiti's version, which stands for the Babel it bundles: an
 * entry written by another release may be output this one would not produce.
 */
function transpilerVersion(): string {
  if (jitiVersion === undefined) {
    try {
      const pkg = createRequire(import.meta.url)("jiti/package.json") as { version?: string };
      jitiVersion = pkg.version ?? "0";
    } catch {
      jitiVersion = "0";
    }
  }
  return jitiVersion;
}

/** Directories made and swept by this process; cleared for one that vanishes. */
const prepared = new Set<string>();

function prepare(directory: string): void {
  if (prepared.has(directory)) return;
  fs.mkdirSync(directory, { recursive: true });
  prepared.add(directory);
  collectGarbage(directory);
}

/**
 * Throttled sweep, on the transform-result cache's terms (see DiskCache.maybeGc):
 * at most once a day per directory, the marker claimed before sweeping so
 * concurrent processes skip, entries a month old and temp files an hour old
 * removed. An entry's age is the age of its content — a file that has not
 * changed in a month is transpiled once more and gets a fresh one — so what
 * this bounds is the files that no longer exist: a renamed module, a deleted
 * package, another checkout that shared the directory.
 */
export function collectGarbage(directory: string): void {
  const marker = path.join(directory, GC_MARKER);
  try {
    const now = Date.now();
    const claimed = fs.statSync(marker, { throwIfNoEntry: false });
    if (claimed !== undefined && now - claimed.mtimeMs < CACHE_GC_INTERVAL_MS) return;
    fs.writeFileSync(marker, "");

    for (const name of fs.readdirSync(directory)) {
      if (name === GC_MARKER) continue;
      const file = path.join(directory, name);
      const stat = fs.statSync(file, { throwIfNoEntry: false });
      if (stat === undefined || !stat.isFile()) continue;
      const maxAge = name.endsWith(".tmp") ? CACHE_MAX_TMP_AGE_MS : CACHE_MAX_ENTRY_AGE_MS;
      if (now - stat.mtimeMs > maxAge) fs.rmSync(file, { force: true });
    }
  } catch {
    // Best effort: a sweep that cannot run costs disk space, not correctness.
  }
}

/** Everything but the source that decides what a transpile produces. */
function variant(options: TransformOptions): string {
  return JSON.stringify([
    options.ts === true,
    options.jsx ?? false,
    options.async === true,
    options.interopDefault === true,
    options.retainLines === true,
    options.babel ?? null,
  ]);
}

function write(directory: string, file: string, content: string): void {
  // The thread id keeps two workers of one process off each other's temp file.
  const staging = `${file}.${process.pid}.${threadId}.tmp`;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      prepare(directory);
      fs.writeFileSync(staging, content);
      fs.renameSync(staging, file);
      return;
    } catch (error) {
      // The directory was there when this process first wrote to it and is not
      // now (a cache wipe, a temp-dir sweep): make it again, once.
      if (attempt === 0 && (error as NodeJS.ErrnoException).code === "ENOENT") {
        prepared.delete(directory);
        continue;
      }
      try {
        fs.rmSync(staging, { force: true });
      } catch {
        // Nothing further to try.
      }
      return;
    }
  }
}

type Transform = (options: TransformOptions) => TransformResult;

/** A transpile, and the index kept beside it. */
interface Transpiled {
  result: TransformResult;
  /**
   * Where the output imports a relative JS-extension specifier (see
   * `importSites` in ts-specifiers.ts), or undefined for a transpile that
   * failed. Finding them takes a parse of the output, so they are found once,
   * when Babel runs, and stored with it: every later execution of the module
   * reads them back instead.
   */
  imports: readonly number[] | undefined;
}

function transpile(transform: Transform, options: TransformOptions): Transpiled {
  const result = transform(options);
  const failed = result.error !== undefined || result.code.includes("__JITI_ERROR__");
  return { result, imports: failed ? undefined : importSites(result.code) };
}

/** An entry's index and code, given where its stamp ends; null when malformed. */
function read(entry: string, from: number): Transpiled | null {
  const close = entry.indexOf(" */\n", from);
  if (close === -1) return null;
  let imports: unknown;
  try {
    imports = JSON.parse(entry.slice(from, close));
  } catch {
    return null;
  }
  if (!Array.isArray(imports) || !imports.every((offset) => typeof offset === "number")) {
    return null;
  }
  return { result: { code: entry.slice(close + 4) }, imports: imports as number[] };
}

/**
 * `transform`, answered from the cache when it holds this exact transpile.
 *
 * Nothing is kept for a result jiti would not have kept either: a source that
 * did not parse comes back as an error marker to be thrown at evaluation, and
 * the next attempt should see the file again rather than the marker.
 */
function cached(transform: Transform, options: TransformOptions): Transpiled {
  const directory = transpileCacheDirectory();
  const { filename } = options;
  if (directory === null || filename === undefined) return transpile(transform, options);

  const kind = variant(options);
  const name = path
    .basename(filename)
    .replace(/[^\w.-]/g, "_")
    .slice(0, 48);
  const file = path.join(directory, `${name}.${sha1(`${filename}\0${kind}`).slice(0, 16)}.cjs`);
  // The entry's first line: this stamp, the import index, and a closing `*/`.
  const stamp = `/* zod-compiler transpile ${sha1(`${FORMAT}\0${transpilerVersion()}\0${kind}\0${options.source}`)} `;

  let entry: string | undefined;
  try {
    entry = fs.readFileSync(file, "utf8");
  } catch {
    // No entry, or none that can be read.
  }
  if (entry?.startsWith(stamp)) {
    const kept = read(entry, stamp.length);
    if (kept !== null) return kept;
  }

  const fresh = transpile(transform, options);
  if (fresh.imports !== undefined) {
    write(directory, file, `${stamp}${JSON.stringify(fresh.imports)} */\n${fresh.result.code}`);
  }
  return fresh;
}

/** What a jiti instance does when given no options of ours, read off one. */
let defaults:
  | { babel: Transform | undefined; extensions: readonly string[] | undefined }
  | undefined;

/**
 * The options that put a jiti instance on this cache: its own switched off,
 * and its transform — the Babel one it installs when given none, read back
 * off a throwaway instance — fronted by {@link cached}.
 *
 * With `tsSpecifiers`, for an instance that EXECUTES what it transpiles, each
 * result also has its relative `./x.js` imports settled on the way out (see
 * ts-specifiers.ts). After the cache, never into it: what a specifier resolves
 * to is a fact about the directory at the time of the load, and the cache
 * holds only what follows from the source.
 *
 * Empty for a jiti that no longer exposes that transform, which leaves the
 * instance exactly as it was before this module existed.
 */
export function transpileOptions(
  create: typeof createJiti,
  behaviour: { tsSpecifiers?: boolean } = {},
): Pick<JitiOptions, "fsCache" | "transform"> {
  if (defaults === undefined) {
    const { options } = create(import.meta.url, { fsCache: false, moduleCache: false });
    defaults = { babel: options.transform, extensions: options.extensions };
  }
  const { babel, extensions } = defaults;
  if (babel === undefined) return {};
  if (behaviour.tsSpecifiers !== true || extensions === undefined) {
    return { fsCache: false, transform: (options) => cached(babel, options).result };
  }
  return {
    fsCache: false,
    transform(options) {
      const { result, imports } = cached(babel, options);
      if (imports === undefined || imports.length === 0 || options.filename === undefined) {
        return result;
      }
      const code = resolveTsSpecifiers(result.code, imports, options.filename, extensions);
      return code === result.code ? result : { ...result, code };
    },
  };
}
