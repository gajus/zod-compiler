/**
 * Static per-file dependency graphs for disk-cache invalidation.
 *
 * The disk cache used to record `getFirstPartyModulePaths()` — the superset
 * of EVERY first-party module the loader had executed so far — as each
 * entry's dependency set. Supersets never serve stale results, but in a
 * large codebase every entry ends up recording the whole project (~1,900
 * deps, ~400KB JSON per entry in the field report), so ANY commit
 * invalidates essentially the entire cache and CI re-pays full discovery
 * every run.
 *
 * This module computes the file's ACTUAL import graph statically: scan
 * import/export/require specifiers, resolve them (relative paths with
 * extension probing, tsconfig path aliases via the loader's config, bare
 * specifiers through node resolution), and BFS across first-party files.
 * No file is executed. Type-only imports are included (over-approximation
 * only over-invalidates).
 *
 * Soundness rule: when anything cannot be analyzed — a non-literal dynamic
 * import, an unresolvable relative specifier — the crawl reports
 * `complete: false` and the caller falls back to the superset. A static
 * crawl may only replace the superset when it provably covers everything
 * the file can load.
 *
 * Cost discipline (this runs serialized on the bundler's main process, once
 * per discovery file, over closures that reach thousands of files):
 * - every existence probe uses `statSync(p, { throwIfNoEntry: false })` —
 *   a thrown ENOENT pays V8 error-plus-stack construction, and a cold crawl
 *   issues these probes by the million (the dominant cost in field samples);
 * - resolution is memoized at every level: realpath per path, createRequire
 *   per directory, resolved specifier per (directory, specifier), and the
 *   full edge list per file (mtime-validated) — repeat crawls over the
 *   shared core graph are Map lookups plus one cheap stat per file;
 * - the BFS aborts the moment the graph becomes unanalyzable: the caller
 *   discards an incomplete result for the superset anyway, so finishing the
 *   crawl would be pure waste (and incomplete is the COMMON outcome on
 *   large graphs — one dynamic import anywhere poisons the whole closure).
 */

import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as path from "node:path";
import { resolveTsconfigPathCandidates } from "../loader.js";

export interface StaticDeps {
  /** Absolute real paths of first-party files reachable from the entry. */
  deps: string[];
  /** False when the graph could not be fully analyzed — use the superset. */
  complete: boolean;
}

const SOURCE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];
const NODE_MODULES_SEGMENT = `${path.sep}node_modules${path.sep}`;
/** Specifier schemes that never resolve to project files. */
// oxlint-disable-next-line no-control-regex -- rollup-convention virtual module ids begin with NUL
const SKIP_SPECIFIER = /^(?:node:|data:|virtual:|\u0000)/;
/** Runaway guard — graphs larger than this fall back to the superset. */
const MAX_FILES = 10_000;

const INCOMPLETE: StaticDeps = { deps: [], complete: false };

/**
 * Resolution-failure sentinel. A unique symbol rather than a string literal:
 * `"incomplete" | string` collapses to `string`, so the type system could
 * not distinguish a resolved path from the failure marker.
 */
const UNRESOLVED = Symbol("unresolved");

interface FileNode {
  mtimeMs: number;
  /** Resolved first-party imports (absolute real paths), deduped. */
  edges: string[];
  /** Non-literal dynamic import/require or unresolvable specifier. */
  incomplete: boolean;
}

/**
 * Per-process memos. The file node memo is revalidated by mtime on every
 * visit; the resolution memos (specifier, realpath, require) depend on the
 * filesystem layout rather than file contents and are only dropped by
 * resetDepGraphMemo() — the same wholesale invalidation watch mode already
 * applies to the module cache (a memoized resolution can only go stale when
 * files appear/move, which fires watchChange).
 */
const nodeMemo = new Map<string, FileNode | null>();
const resolveMemo = new Map<string, string | null | typeof UNRESOLVED>();
const realpathMemo = new Map<string, string>();
const requireMemo = new Map<string, ReturnType<typeof createRequire>>();

/** Reset the per-process dep-graph memos (watch-mode file changes). */
export function resetDepGraphMemo(): void {
  nodeMemo.clear();
  resolveMemo.clear();
  realpathMemo.clear();
  requireMemo.clear();
}

const STATIC_SPECIFIER =
  /(?:\bfrom\s*|\bimport\s+|\bimport\s*\(\s*|\brequire\s*\(\s*)["']([^"'\n]+)["']/g;
// No /g flag: `.test()` on a global regex resumes from lastIndex of the
// PREVIOUS file's match, silently missing dynamic imports (a missed
// detection records a falsely-complete dep set — stale cache).
const DYNAMIC_CALL = /\b(?:import|require)\s*\(\s*(?!["'])[^)\s]/;

/** statSync that reports ENOENT as undefined instead of an exception. */
function tryStat(p: string): fs.Stats | undefined {
  try {
    return fs.statSync(p, { throwIfNoEntry: false });
  } catch {
    // Non-ENOENT errors (ENOTDIR from probing `file.ts/index.ts`, EACCES):
    // treat as absent.
    return undefined;
  }
}

function tryFile(p: string): string | null {
  return tryStat(p)?.isFile() ? p : null;
}

/** Probe a path (possibly extensionless) to an existing file. */
function probeFile(base: string): string | null {
  const hasExtension = path.extname(base) !== "";
  if (hasExtension) {
    if (tryFile(base)) return base;
    // Extensioned path that doesn't exist as-is: TS source referenced with a
    // .js specifier (nodenext style). Probe the extension-family swap before
    // the append/index probes — in nodenext codebases this is the common hit
    // and skips ~16 dead probes per import.
    if (/\.[cm]?js$/.test(base)) {
      const hit =
        tryFile(base.replace(/\.([cm]?)js$/, ".$1ts")) ??
        tryFile(base.replace(/\.[cm]?js$/, ".tsx"));
      if (hit) return hit;
    }
  }
  for (const ext of SOURCE_EXTENSIONS) {
    const hit = tryFile(base + ext);
    if (hit) return hit;
  }
  for (const ext of SOURCE_EXTENSIONS) {
    const hit = tryFile(path.join(base, `index${ext}`));
    if (hit) return hit;
  }
  // Extensionless path that exists exactly (e.g. ./bin/cli).
  return hasExtension ? null : tryFile(base);
}

function realpathOf(p: string): string {
  let real = realpathMemo.get(p);
  if (real === undefined) {
    try {
      real = fs.realpathSync(p);
    } catch {
      real = p; // keep the unresolved path
    }
    realpathMemo.set(p, real);
  }
  return real;
}

function firstPartyOrNull(resolved: string): string | null {
  const real = realpathOf(resolved);
  return real.includes(NODE_MODULES_SEGMENT) ? null : real;
}

/** Node resolution is a function of the importing DIRECTORY, not the file. */
function requireFor(dir: string): ReturnType<typeof createRequire> {
  let req = requireMemo.get(dir);
  if (req === undefined) {
    req = createRequire(path.join(dir, "__zod_compiler_resolve__.js"));
    requireMemo.set(dir, req);
  }
  return req;
}

/**
 * Resolve one specifier from a directory. Returns:
 * - an absolute path (first-party file to record + crawl)
 * - null when the dep is intentionally out of scope (node_modules, builtins)
 * - UNRESOLVED when resolution failed and the graph cannot be trusted
 */
function resolveSpecifier(rawSpec: string, fromDir: string): string | null | typeof UNRESOLVED {
  if (SKIP_SPECIFIER.test(rawSpec)) return null;
  const memoKey = `${fromDir}\0${rawSpec}`;
  const memoized = resolveMemo.get(memoKey);
  if (memoized !== undefined) return memoized;
  const result = resolveSpecifierUncached(rawSpec, fromDir);
  resolveMemo.set(memoKey, result);
  return result;
}

function resolveSpecifierUncached(
  rawSpec: string,
  fromDir: string,
): string | null | typeof UNRESOLVED {
  // Vite-style resource queries (./logo.svg?url, ./shader.glsl?raw) resolve
  // to the underlying file.
  const q = rawSpec.indexOf("?");
  const spec = q === -1 ? rawSpec : rawSpec.slice(0, q);
  if (spec === "") return null;

  if (spec.startsWith("./") || spec.startsWith("../")) {
    const hit = probeFile(path.resolve(fromDir, spec));
    return hit === null ? UNRESOLVED : firstPartyOrNull(hit);
  }

  const { candidates, viaPathsPattern } = resolveTsconfigPathCandidates(fromDir, spec);
  for (const candidate of candidates) {
    const hit = probeFile(candidate);
    if (hit !== null) {
      return firstPartyOrNull(hit);
    }
  }
  // An explicit `paths` match is authoritative: every candidate missing means
  // the import cannot be trusted. Implicit baseUrl candidates are proposed
  // for EVERY bare specifier (npm packages, `#` imports) and only mean "try
  // baseDir first" — a miss falls through to node resolution below.
  if (viaPathsPattern) return UNRESOLVED;

  // Bare specifier (package) or package.json "imports" (#...): node
  // resolution from the importing directory. node_modules results are out of
  // scope (zod's version is part of the cache key); symlinked workspace
  // packages realpath outside node_modules and are crawled as first-party.
  try {
    const resolved = requireFor(fromDir).resolve(spec);
    if (!path.isAbsolute(resolved)) return null; // node builtin
    return firstPartyOrNull(resolved);
  } catch {
    // Unresolvable from Node's algorithm. jiti may still resolve it (e.g.
    // ESM-only packages without CJS entries) — the file itself stays a dep
    // through the entry, but its subtree is unknown for bare packages.
    // Treat unresolvable BARE specifiers as out-of-scope third-party
    // (caught by the zod-version/plugin key when relevant) only when they
    // cannot be project files; '#' subpath imports stay strict.
    return spec.startsWith("#") ? UNRESOLVED : null;
  }
}

/**
 * Scan + resolve one file into its edge list. Memoized by mtime, so the
 * shared core graph is read and resolved once per process — each entry's
 * closure walk after that is one cheap stat plus Map lookups per file.
 * Returns null for unreadable files.
 */
function fileNode(filePath: string): FileNode | null {
  const stat = tryStat(filePath);
  if (stat === undefined || !stat.isFile()) {
    nodeMemo.set(filePath, null);
    return null;
  }
  const memo = nodeMemo.get(filePath);
  if (memo !== undefined && memo !== null && memo.mtimeMs === stat.mtimeMs) return memo;

  let source: string;
  try {
    source = fs.readFileSync(filePath, "utf8");
  } catch {
    nodeMemo.set(filePath, null);
    return null;
  }
  // String/comment contents can false-positive both patterns; extra
  // specifiers only add deps (safe), a false `incomplete` only falls back
  // to the superset (safe).
  let incomplete = DYNAMIC_CALL.test(source);
  const edges: string[] = [];
  const seen = new Set<string>();
  const dir = path.dirname(filePath);
  for (const m of source.matchAll(STATIC_SPECIFIER)) {
    const spec = m[1];
    if (!spec) continue;
    const resolved = resolveSpecifier(spec, dir);
    if (resolved === UNRESOLVED) {
      incomplete = true;
    } else if (resolved !== null && !seen.has(resolved)) {
      seen.add(resolved);
      edges.push(resolved);
    }
  }
  const node: FileNode = { mtimeMs: stat.mtimeMs, edges, incomplete };
  nodeMemo.set(filePath, node);
  return node;
}

/**
 * Compute the static first-party dependency closure of `entryFile`.
 * The entry itself is excluded (its content is part of the cache key).
 */
export function collectStaticDeps(entryFile: string): StaticDeps {
  const entry = firstPartyOrNull(path.resolve(entryFile));
  if (entry === null) return INCOMPLETE;

  const visited = new Set<string>([entry]);
  const queue: string[] = [entry];

  while (queue.length > 0) {
    if (visited.size > MAX_FILES) return INCOMPLETE;
    const file = queue.pop() as string;
    const node = fileNode(file);
    // Any unanalyzable node poisons the whole closure; the caller falls back
    // to the superset, so abort instead of crawling to exhaustion.
    if (node === null || node.incomplete) return INCOMPLETE;
    for (const dep of node.edges) {
      if (!visited.has(dep)) {
        visited.add(dep);
        queue.push(dep);
      }
    }
  }

  visited.delete(entry);
  return { deps: [...visited], complete: true };
}
