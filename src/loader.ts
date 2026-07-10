import path from "node:path";
import { pathToFileURL } from "node:url";
import { createPathsMatcher, type Cache, getTsconfig, type PathsMatcher } from "get-tsconfig";
import type { Jiti } from "jiti";

type Runtime = "node" | "bun" | "deno";

function detectRuntime(): Runtime {
  if ("Bun" in globalThis) return "bun";
  if ("Deno" in globalThis) return "deno";
  return "node";
}

/** Cache: search dir → tsconfig lookup result (getTsconfig walks the fs otherwise). */
const tsconfigSearchCache: Cache = new Map();

/** Cache: tsconfig.json absolute path → paths matcher */
const pathsMatcherCache = new Map<string, PathsMatcher | null>();

interface LoaderConfig {
  /** Identity key for the shared jiti instance (tsconfig path, or "" if none). */
  key: string;
  tsconfigPath: string | undefined;
}

/**
 * Resolve the tsconfig.json visible from a source directory.
 *
 * jiti has first-class TypeScript paths support, so runtime discovery uses the
 * tsconfig path directly instead of translating aliases into jiti's simpler
 * prefix alias format. The static dependency crawler uses get-tsconfig's own
 * matcher for the same reason: project aliases are arbitrary TypeScript
 * `paths` patterns, not a fixed convention like "~" or "@".
 */
function resolveLoaderConfig(fromDir: string): LoaderConfig {
  const tsconfig = getTsconfig(fromDir, "tsconfig.json", tsconfigSearchCache);
  if (!tsconfig) return { key: "", tsconfigPath: undefined };

  return { key: tsconfig.path, tsconfigPath: tsconfig.path };
}

/**
 * Candidate files for a specifier using the tsconfig path mappings visible
 * from a directory. Used by the static dependency crawler so alias imports
 * resolve the same way discovery resolves them.
 */
export function resolveTsconfigPathCandidates(fromDir: string, specifier: string): string[] {
  const tsconfig = getTsconfig(fromDir, "tsconfig.json", tsconfigSearchCache);
  if (!tsconfig) return [];

  let matcher = pathsMatcherCache.get(tsconfig.path);
  if (matcher === undefined) {
    matcher = createPathsMatcher(tsconfig);
    pathsMatcherCache.set(tsconfig.path, matcher);
  }

  return matcher?.(specifier) ?? [];
}

/**
 * Shared jiti instances, keyed by tsconfig identity (the alias config).
 * Sharing one instance with `moduleCache: true` across the whole build means
 * the module graph behind schema files (zod itself, shared helpers, ...) is
 * executed roughly once per build instead of once per transformed file.
 */
const jitiInstances = new Map<string, Jiti>();

/**
 * Bumped by invalidateModuleCache(). Bun/Deno use native import, whose module
 * cache cannot be evicted — instead the generation is appended as a query
 * suffix so files re-execute after an invalidation while unchanged builds
 * share a single execution.
 */
let cacheGeneration = 0;

/** Serializes loads so concurrent transforms don't double-execute shared deps. */
let loadQueue: Promise<unknown> = Promise.resolve();

/**
 * Env var set on `process.env` while a build-time module executes. A schema
 * file's import graph commonly includes an env-validation module that calls
 * `process.exit()` when required variables are missing; in CI builds those
 * secrets are intentionally absent. Cooperating modules can guard on this
 * marker to skip validation during discovery (mirrors t3-env's
 * `SKIP_ENV_VALIDATION`):
 *
 *   if (!process.env.ZOD_COMPILER) {
 *     const r = envSchema.safeParse(process.env);
 *     if (!r.success) process.exit(1);
 *   }
 */
const DISCOVERY_ENV_MARKER = "ZOD_COMPILER";

/**
 * Thrown in place of a `process.exit()` call made while a build-time module is
 * executing (see {@link runGuarded}). Discovery already catches load failures
 * and skips the file (falling back to runtime Zod), so a non-cooperating
 * module's exit degrades gracefully instead of terminating the bundler.
 */
export class ProcessExitDuringLoadError extends Error {
  /** The code passed to the intercepted `process.exit()`, if any. */
  readonly exitCode: number | string | undefined;

  constructor(code?: number | string) {
    super(
      `process.exit(${code ?? ""}) was called while zod-compiler executed a module ` +
        `for build-time schema discovery.`,
    );
    this.name = "ProcessExitDuringLoadError";
    this.exitCode = code;
  }
}

/**
 * Ref-counted guard installed around every build-time module execution. While
 * any load is in flight it (1) sets {@link DISCOVERY_ENV_MARKER} so cooperating
 * env modules skip their exit guard, and (2) replaces `process.exit` with a
 * throw so a non-cooperating module's exit surfaces as a catchable load failure
 * rather than killing the process. Both are restored once the last concurrent
 * load settles, so exits elsewhere in the build are untouched.
 *
 * Only synchronous exits during module evaluation are caught — an exit deferred
 * past the load window (a `setTimeout`, a later event) still exits.
 */
let guardDepth = 0;
let savedExit: typeof process.exit | undefined;
let savedMarker: string | undefined;
let markerWasSet = false;

function installGuard(): void {
  markerWasSet = DISCOVERY_ENV_MARKER in process.env;
  savedMarker = process.env[DISCOVERY_ENV_MARKER];
  process.env[DISCOVERY_ENV_MARKER] = "1";
  // Capture the real exit verbatim so restoreGuard puts back the exact same
  // reference (identity matters to callers that compare process.exit).
  // oxlint-disable-next-line typescript/unbound-method -- restoring, not calling
  savedExit = process.exit;
  process.exit = ((...args: Parameters<typeof process.exit>): never => {
    throw new ProcessExitDuringLoadError(args[0] ?? undefined);
  }) as typeof process.exit;
}

function restoreGuard(): void {
  if (savedExit) {
    process.exit = savedExit;
    savedExit = undefined;
  }
  if (markerWasSet) {
    process.env[DISCOVERY_ENV_MARKER] = savedMarker as string;
  } else {
    delete process.env[DISCOVERY_ENV_MARKER];
  }
}

/**
 * Run a build-time module import with the discovery guard active. Nested and
 * concurrent loads share a single install via the ref count.
 */
async function runGuarded<T>(run: () => Promise<T>): Promise<T> {
  if (guardDepth++ === 0) installGuard();
  try {
    return await run();
  } finally {
    if (--guardDepth === 0) restoreGuard();
  }
}

const NODE_MODULES_SEGMENT = `${path.sep}node_modules${path.sep}`;

/**
 * Drop every first-party (non-node_modules) module from the shared loader
 * caches. Called on watch/HMR file changes so the next discovery re-executes
 * changed schema graphs.
 *
 * Eviction is deliberately first-party-wide rather than per-module: jiti's
 * module cache only records importer→dep edges on cache misses, so a precise
 * reverse-dependency walk would miss importers of already-cached modules and
 * serve stale schemas. Evicting all project files (cheap to re-execute) while
 * keeping node_modules (the expensive bulk — zod itself) warm is both correct
 * and fast.
 */
export function invalidateModuleCache(): void {
  cacheGeneration++;
  for (const jiti of jitiInstances.values()) {
    for (const key of Object.keys(jiti.cache)) {
      if (!key.includes(NODE_MODULES_SEGMENT)) {
        delete jiti.cache[key];
      }
    }
  }
}

/**
 * Absolute paths of every first-party (non-node_modules) module currently
 * executed by the shared loader. Used by the unplugin disk cache to record
 * which source files a schema file's discovery depended on — a superset is
 * safe (it can only over-invalidate, never serve stale results).
 *
 * Returns null when no jiti instance exists (Bun/Deno native import — no
 * evictable cache, so dependency tracking is unavailable).
 */
export function getFirstPartyModulePaths(): string[] | null {
  if (jitiInstances.size === 0) return null;
  const paths: string[] = [];
  for (const jiti of jitiInstances.values()) {
    for (const key of Object.keys(jiti.cache)) {
      if (!key.includes(NODE_MODULES_SEGMENT)) {
        paths.push(key);
      }
    }
  }
  return paths;
}

async function getJiti(absPath: string): Promise<Jiti> {
  const { key, tsconfigPath } = resolveLoaderConfig(path.dirname(absPath));
  const existing = jitiInstances.get(key);
  if (existing) return existing;

  const { createJiti } = await import("jiti");
  const created = createJiti(pathToFileURL(absPath).href, {
    moduleCache: true,
    ...(tsconfigPath ? { tsconfigPaths: tsconfigPath } : {}),
    jsx: true,
  });
  jitiInstances.set(key, created);
  return created;
}

/**
 * Dynamically import a source file (.ts or .js).
 * - Bun/Deno: native TypeScript support, direct import
 * - Node.js: uses a shared jiti instance for reliable TypeScript transpilation
 *   (handles extensionless imports, enums, path aliases, and all TS syntax)
 *
 * Module executions are cached across calls; use invalidateModuleCache()
 * when source files change (watch/HMR).
 */
export async function loadSourceFile(filePath: string): Promise<Record<string, unknown>> {
  const absPath = path.resolve(filePath);
  const runtime = detectRuntime();

  // Bun/Deno execute TypeScript natively. .mjs files bypass jiti even on
  // Node (jiti hands them to native import, outside its evictable cache),
  // so the generation suffix is the only way to refresh them.
  if (runtime === "bun" || runtime === "deno" || absPath.endsWith(".mjs")) {
    const suffix = cacheGeneration > 0 ? `?zcGen=${cacheGeneration}` : "";
    return (await runGuarded(() => import(pathToFileURL(absPath).href + suffix))) as Record<
      string,
      unknown
    >;
  }

  const jiti = await getJiti(absPath);
  const load = loadQueue.then(() => runGuarded(() => jiti.import(absPath)));
  loadQueue = load.then(
    () => undefined,
    () => undefined,
  );
  return (await load) as Record<string, unknown>;
}

/**
 * Import a module by SPECIFIER as `fromFile` would: relative specifiers
 * resolve against the importing file's directory; bare specifiers (`zod`)
 * resolve through node_modules / the shared jiti instance, so the value is
 * the same module instance discovery executions see. Used by the hoisted-
 * schema compile step to evaluate hoisted expressions at build time.
 */
export async function loadModule(
  specifier: string,
  fromFile: string,
): Promise<Record<string, unknown>> {
  if (specifier.startsWith("./") || specifier.startsWith("../")) {
    return loadSourceFile(path.resolve(path.dirname(path.resolve(fromFile)), specifier));
  }

  const absPath = path.resolve(fromFile);
  const runtime = detectRuntime();
  if (runtime === "bun" || runtime === "deno") {
    return (await runGuarded(() => import(specifier))) as Record<string, unknown>;
  }

  const jiti = await getJiti(absPath);
  const load = loadQueue.then(() => runGuarded(() => jiti.import(specifier)));
  loadQueue = load.then(
    () => undefined,
    () => undefined,
  );
  return (await load) as Record<string, unknown>;
}
