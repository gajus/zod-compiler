/**
 * Webpack-loader entry point, for Turbopack (Next.js) and any other host that
 * runs webpack loaders but not webpack plugins.
 *
 * Turbopack deliberately supports no webpack plugins, so the unplugin build
 * plugins cannot reach it. Loaders it does run, through the real `loader-runner`
 * library, and that is enough: this module is the whole zod-compiler transform
 * behind `this.async()`.
 *
 * It emits TypeScript, not JavaScript. A `turbopack.rules` entry that sets no
 * `as`/`type` leaves the loader's output to be parsed as whatever the file
 * already was, so Turbopack's own SWC pass handles the syntax — there is no
 * second transpile here and no @swc/core dependency.
 *
 * `codegenMode: "lean"` is available here — it imports the shared helpers from
 * `zod-compiler/runtime`, a real package subpath, rather than the `virtual:` id
 * the build plugins answer from a resolve hook that a loader does not have. It
 * is opt-in; see the option's doc for why.
 *
 *   // next.config.ts
 *   export default {
 *     turbopack: {
 *       rules: {
 *         "*.{ts,tsx}": {
 *           condition: { all: [{ not: "foreign" }, { content: /[Zz]od/ }] },
 *           loaders: ["zod-compiler/turbopack"],
 *         },
 *       },
 *     },
 *   };
 *
 * The `content` condition is the Turbopack equivalent of the plugins' own code
 * filter and must stay as loose as ZOD_MENTION: narrowing it to the literal
 * specifier `"zod"` would silently skip `zod/v4`, `zod/mini` and the
 * `zod-compiler` import that drives `schemas: "explicit"` — no error, those
 * schemas just quietly stay uncompiled.
 */

import fs from "node:fs";
import remapping from "@jridgewell/remapping";
import { getFirstPartyModulePaths, invalidateModuleCache } from "./loader.js";
import { resetDepGraphMemo, transformDependencies } from "./unplugin/dep-graph.js";
import {
  log,
  shouldTransform,
  type TransformSourceMap,
  transformCodeWithMap,
} from "./unplugin/transform.js";
import type { ZodCompilerPluginOptions } from "./unplugin/types.js";
import { RUNTIME_PACKAGE_ID } from "./unplugin/virtual.js";

/**
 * Plugin options minus the ones a loader host cannot express.
 *
 * Turbopack serializes loader options through `next.config`, so they have to be
 * plain JSON — hence no `apply` (a Vite lifecycle function) and a string-only
 * `schemaNamePattern` where the plugin also accepts a RegExp.
 *
 * No `cache` either: the disk cache's dependency bookkeeping leans on a
 * `buildEnd` flush that a loader has no equivalent for, and loader hosts keep
 * their own persistent result cache — Turbopack's is keyed on content plus the
 * dependencies declared below, which is what this would have re-implemented.
 *
 * No `parallel`: the concurrency is the host's to own. Turbopack already runs
 * loaders across its own worker pool, so a pool per loader invocation would
 * multiply threads against a machine that is already saturated — and the
 * module-cache staleness stamps below assume one shared execution cache.
 */
export type ZodCompilerTurbopackOptions = Omit<
  ZodCompilerPluginOptions,
  "apply" | "cache" | "codegenMode" | "hoist" | "parallel"
> & {
  hoist?: boolean | { schemaNamePattern?: string | null | undefined } | undefined;
  /**
   * `"inline"` (default) emits the shared helpers into every transformed file.
   *
   * `"lean"` imports them from `zod-compiler/runtime` instead, so a bundle
   * carries one copy however many files were transformed. That specifier is a
   * real package subpath, which is what makes it usable from a loader at all —
   * the `virtual:` id the build plugins emit needs a `resolveId` hook, and a
   * loader has none.
   *
   * Opt-in rather than the default because it only holds when the host BUNDLES
   * the import. Next.js does for client and App Router server code, but Pages
   * Router server code externalizes node_modules imports unless
   * `bundlePagesRouterDependencies` is set — and `zod-compiler` is normally a
   * devDependency, so a production install prunes it and the route throws
   * ERR_MODULE_NOT_FOUND on the first request. A bigger bundle is the better
   * default than a runtime failure that no build step reports.
   * @default "inline"
   */
  codegenMode?: "lean" | "inline" | undefined;
};

/**
 * The slice of webpack's loader context this uses. Structural rather than
 * imported from webpack: the package must not take a webpack dependency to
 * serve a host that is not webpack.
 */
export interface ZodCompilerLoaderContext {
  resourcePath: string;
  async(): (error: Error | null, code?: string, map?: TransformSourceMap) => void;
  getOptions?(): ZodCompilerTurbopackOptions | undefined;
  addDependency?(file: string): void;
  cacheable?(flag: boolean): void;
  query?: unknown;
}

/**
 * Disk stamps of every module the shared execution cache is currently holding.
 *
 * Discovery executes schema files from DISK through a module cache that outlives
 * loader calls. The bundler plugins evict it from `watchChange`; a loader has no
 * such hook, so staleness has to be detected here or compiled validators keep
 * reflecting whatever the files said when they were first executed.
 *
 * Diffing the entry's own content is NOT enough, and the gap is exactly the case
 * `addDependency` exists to handle: when an imported constant changes, the host
 * re-runs the loader for a schema file whose content is UNCHANGED.
 *
 * Tracked GLOBALLY rather than per file, because that is what it describes: one
 * process-wide module cache, stale the moment any file behind it changes. A
 * per-file dependency list cannot express that — a file being transformed for
 * the FIRST time has no list yet, but the cache it is about to read from is
 * already warm and may already be stale. Keying on the cache's own inventory
 * also means one edit costs one eviction rather than one per dependent file.
 *
 * `getFirstPartyModulePaths()` is that inventory, which is why it is sound here
 * while being unsound as a per-file dependency list (see transformDependencies):
 * the question is "what is cached", not "what does this file need". It covers
 * dependencies the host never feeds through this loader at all — a constants
 * file that never mentions zod, or one a rule's `exclude` skips — but only the
 * ones jiti holds, so the two known gaps are its gaps:
 *
 * - `.js`/`.mjs` deps go through native `import()` (see loader.ts), which has no
 *   evictable cache. The build plugins are equally stale there; on Bun and Deno
 *   that is every module, and this whole mechanism is inert.
 * - A file being CREATED changes nothing's stamp, so a new module that shadows
 *   an existing resolution (`limits.ts` beside `limits/index.ts`) keeps serving
 *   the old one until some stamped file also changes. `watchChange` gives the
 *   plugins a signal for this that a loader host has no equivalent of.
 *
 * mtime+size like the disk cache's fast path, minus its content hashes: those
 * exist to survive checkouts across processes, and this map dies with the
 * process.
 */
const executedModuleStamps = new Map<string, string>();

function stampOf(file: string): string {
  try {
    const stat = fs.statSync(file, { throwIfNoEntry: false });
    return stat === undefined ? "" : `${stat.mtimeMs}:${stat.size}`;
  } catch {
    // Non-ENOENT (EACCES, ELOOP, ENOTDIR): unreadable is indistinguishable from
    // changed, and must never fail the build.
    return "";
  }
}

/**
 * Drop cached module executions when any file behind them changed on disk.
 *
 * Eviction is global (see invalidateModuleCache), so it is deliberately paired
 * with the dep-graph memos the plugin also resets in `watchChange`: a resolution
 * memoized before a file existed would otherwise pin that importer to an
 * unanalyzable graph for the life of the process.
 *
 * Costs one stat per executed module, paid by every file that reaches the
 * transform — ~3 ms per file against the 1,900-module project dep-graph.ts
 * cites, the same order as the closure walk `transformDependencies` does a few
 * lines later, and far below the discovery it is protecting.
 */
function invalidateStaleExecutions(): void {
  let stale = false;
  for (const [file, stamp] of executedModuleStamps) {
    if (stampOf(file) !== stamp) {
      stale = true;
      break;
    }
  }
  if (!stale) return;
  invalidateModuleCache();
  resetDepGraphMemo();
  executedModuleStamps.clear();
}

/**
 * Stamp whatever discovery just executed.
 *
 * Keeps the FIRST stamp for a file rather than refreshing: a file edited between
 * its execution and this call must keep its pre-edit stamp, or the next run
 * would see it as fresh and pin the stale execution permanently.
 *
 * `null` means no jiti instance exists — a runtime whose module cache cannot be
 * evicted at all (loader.ts), so there is nothing to track and nothing to fix.
 */
function recordExecutedModules(): void {
  for (const file of getFirstPartyModulePaths() ?? []) {
    if (!executedModuleStamps.has(file)) executedModuleStamps.set(file, stampOf(file));
  }
}

function readOptions(context: ZodCompilerLoaderContext): ZodCompilerTurbopackOptions {
  const options = context.getOptions?.();
  if (options !== undefined) return options;
  // `getOptions` is standard but not universal; `query` is the older shape.
  return typeof context.query === "object" && context.query !== null
    ? (context.query as ZodCompilerTurbopackOptions)
    : {};
}

/**
 * Declare what a rebuild must watch. The host caches this file's output keyed on
 * its own content, but discovery executed the whole import graph — without these
 * an edit to an imported constant leaves a stale validator in the bundle.
 */
function declareDependencies(
  context: ZodCompilerLoaderContext,
  id: string,
  verbose: boolean,
): void {
  const { files, complete } = transformDependencies(id);
  for (const file of files) context.addDependency?.(file);
  if (complete) return;
  // The graph could not be analyzed (a non-literal dynamic import anywhere in
  // the closure), so the list above is just this file — not enough for the host
  // to know when to re-run us. Asking to be re-run every build is the only
  // answer left. Freshness itself does not depend on this: whether the loader
  // is re-invoked once or every time, invalidateStaleExecutions decides what
  // discovery may reuse.
  context.cacheable?.(false);
  if (verbose) {
    log(`Cannot analyze the import graph of ${id} — re-running its transform every build`);
  }
}

interface LoaderResult {
  code: string;
  map?: TransformSourceMap | undefined;
}

/** The transform itself, split out so the loader shell stays callback-only. */
async function run(
  context: ZodCompilerLoaderContext,
  source: string,
  inputMap: TransformSourceMap | undefined,
): Promise<LoaderResult> {
  const id = context.resourcePath;
  const options = readOptions(context);

  if (!shouldTransform(id, options)) return { code: source, map: inputMap };

  // Before discovery can read a stale execution. Note this covers an edit to
  // THIS file too: discovery executed it, so it carries a stamp of its own —
  // there is no separate host-content diff, which would only ever fire for
  // content that differs from the disk discovery actually reads.
  invalidateStaleExecutions();

  const output = options.output ?? "schema";
  let discoveryRan = false;
  const result = await transformCodeWithMap(source, id, {
    mode: options.codegenMode ?? "inline",
    runtimeId: RUNTIME_PACKAGE_ID,
    verbose: options.verbose,
    // "compact" keeps the Zod schema (its safeParse IS the cold error path), so
    // only "bag" drops Zod compatibility.
    zodCompat: output === "schema" || output === "compact",
    compact: output === "compact",
    autoDiscover: (options.schemas ?? "auto") === "auto",
    hoist: options.hoist,
    onDiscovery: () => {
      discoveryRan = true;
    },
    onUncacheableResult: () => {
      // Discovery recovered from a process.exit (an env guard in a secret-less
      // build): the result is a function of the ENVIRONMENT, not the file, so it
      // must not be cached against this content.
      context.cacheable?.(false);
    },
  });

  // Only discovery reads other files. A hoist-only or bailed-out transform is a
  // pure function of this file's content, which the host already keys on.
  if (discoveryRan) {
    recordExecutedModules();
    declareDependencies(context, id, options.verbose === true);
  }

  if (result === null) return { code: source, map: inputMap };
  return { code: result.code, map: composeMaps(result.map, inputMap) };
}

/** Chain this transform's map onto an earlier loader's, newest first. */
function composeMaps(
  map: TransformSourceMap | null,
  inputMap: TransformSourceMap | undefined,
): TransformSourceMap | undefined {
  if (map === null) return inputMap;
  if (inputMap === undefined) return map;
  return remapping(
    [map, inputMap] as Parameters<typeof remapping>[0],
    () => null,
  ) as unknown as TransformSourceMap;
}

export default function zodCompilerLoader(
  this: ZodCompilerLoaderContext,
  source: string,
  inputMap?: TransformSourceMap,
): void {
  const callback = this.async();
  const succeed = (result: LoaderResult): void => callback(null, result.code, result.map);
  const fail = (error: unknown): void =>
    callback(error instanceof Error ? error : new Error(String(error)));

  // Two `then` handlers rather than one plus a try/catch: loader-runner invokes
  // the host's continuation synchronously from `callback`, so a throw inside it
  // would re-enter a catch and call back a second time. As rejection handlers of
  // the SAME promise, exactly one of these can ever run.
  run(this, source, inputMap).then(succeed, fail);
}
