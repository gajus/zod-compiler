import path from "node:path";
import { pathToFileURL } from "node:url";
import { type Cache, getTsconfig } from "get-tsconfig";
import type { Jiti } from "jiti";

type Runtime = "node" | "bun" | "deno";

function detectRuntime(): Runtime {
  if ("Bun" in globalThis) return "bun";
  if ("Deno" in globalThis) return "deno";
  return "node";
}

/** Cache: search dir → tsconfig lookup result (getTsconfig walks the fs otherwise). */
const tsconfigSearchCache: Cache = new Map();

/** Cache: tsconfig.json absolute path → resolved jiti alias map */
const aliasCache = new Map<string, Record<string, string>>();

interface LoaderConfig {
  /** Identity key for the shared jiti instance (tsconfig path, or "" if none). */
  key: string;
  alias: Record<string, string>;
}

/**
 * Resolve tsconfig.json path aliases into the format jiti expects.
 * Returns an empty alias map if no tsconfig.json is found or no paths are configured.
 *
 * tsconfig paths use wildcards: { "@/*": ["./src/*"] }
 * jiti uses prefix matching:   { "@": "/absolute/path/to/src" }
 *
 * The trailing "/*" is stripped from both key and value before passing to jiti.
 */
function resolveLoaderConfig(fromDir: string): LoaderConfig {
  const tsconfig = getTsconfig(fromDir, "tsconfig.json", tsconfigSearchCache);
  if (!tsconfig) return { key: "", alias: {} };

  const cached = aliasCache.get(tsconfig.path);
  if (cached) return { key: tsconfig.path, alias: cached };

  const alias: Record<string, string> = {};
  const paths = tsconfig.config.compilerOptions?.paths;
  if (paths && Object.keys(paths).length > 0) {
    const tsconfigDir = path.dirname(tsconfig.path);
    const baseUrl = tsconfig.config.compilerOptions?.baseUrl;
    const baseDir = baseUrl ? path.resolve(tsconfigDir, baseUrl) : tsconfigDir;

    for (const [pattern, targets] of Object.entries(paths)) {
      if (!targets || targets.length === 0) continue;
      const target = targets[0];
      if (!target) continue;
      // Strip trailing "/*" — jiti uses prefix matching, not glob wildcards
      const key = pattern.endsWith("/*") ? pattern.slice(0, -2) : pattern;
      const val = target.endsWith("/*") ? target.slice(0, -2) : target;
      alias[key] = path.resolve(baseDir, val);
    }
  }

  aliasCache.set(tsconfig.path, alias);
  return { key: tsconfig.path, alias };
}

/**
 * tsconfig path aliases visible from a directory, in jiti's prefix-match
 * format. Used by the static dependency crawler (unplugin/dep-graph.ts) so
 * alias imports resolve the same way the loader resolves them.
 */
export function resolveTsconfigAliases(fromDir: string): Record<string, string> {
  return resolveLoaderConfig(fromDir).alias;
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
  const { key, alias } = resolveLoaderConfig(path.dirname(absPath));
  const existing = jitiInstances.get(key);
  if (existing) return existing;

  const { createJiti } = await import("jiti");
  const created = createJiti(pathToFileURL(absPath).href, {
    moduleCache: true,
    alias,
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
    return (await import(pathToFileURL(absPath).href + suffix)) as Record<string, unknown>;
  }

  const jiti = await getJiti(absPath);
  const load = loadQueue.then(() => jiti.import(absPath));
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
    return (await import(specifier)) as Record<string, unknown>;
  }

  const jiti = await getJiti(absPath);
  const load = loadQueue.then(() => jiti.import(specifier));
  loadQueue = load.then(
    () => undefined,
    () => undefined,
  );
  return (await load) as Record<string, unknown>;
}
