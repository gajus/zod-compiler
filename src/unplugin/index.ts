import process from "node:process";
import { createUnplugin, type UnpluginContextMeta } from "unplugin";
import type { CodegenMode } from "../core/codegen/context.js";
import { getFirstPartyModulePaths, invalidateModuleCache } from "../loader.js";
import { collectStaticDeps, resetDepGraphMemo } from "./dep-graph.js";
import { DiskCache, resetDepValidationMemo } from "./disk-cache.js";
import {
  poolTransformOptions,
  PoolUnavailableError,
  resolvePoolSize,
  TransformPool,
} from "./pool.js";
import {
  log,
  shouldTransform,
  TRANSFORM_ID_FILTER,
  transformCodeFilter,
  type TransformOutput,
  type TransformSourceMap,
  transformCodeWithMap,
  warn,
} from "./transform.js";
import type { BuildStats, TransformOptions, ZodCompilerPluginOptions } from "./types.js";
import { BuildStatsAccumulator } from "./types.js";
import {
  loadVirtual,
  RESOLVED_RUNTIME_ID_FILTER,
  resolveVirtualId,
  RUNTIME_SPECIFIER_FILTER,
  VIRTUAL_RUNTIME_ID,
  WP_RUNTIME_ID,
} from "./virtual.js";

/**
 * Frameworks whose resolveId/load hooks receive any import specifier, including
 * `virtual:` URIs and bare specifiers, so lean-mode cross-file dedup works.
 * webpack / rspack reject the `virtual:` URI scheme but accept bare specifiers,
 * so they use WP_RUNTIME_ID (`__zod-compiler-runtime__`) instead of VIRTUAL_RUNTIME_ID.
 */
const VIRTUAL_MODULE_FRAMEWORKS = new Set([
  "vite",
  "rollup",
  "rolldown",
  "esbuild",
  "farm",
  "bun",
  "rspack",
  "webpack",
]);

/** Frameworks that need the bare-specifier runtime ID instead of `virtual:`. */
const WP_FRAMEWORKS = new Set(["rspack", "webpack"]);

/** File extensions whose changes can affect a schema module graph. */
const SOURCE_LIKE = /\.([cm]?[jt]sx?|json)$/;

/**
 * esbuild has no hook-filter support of its own: unplugin registers a single
 * `onLoad` covering both the load and transform hooks, and its transform shim
 * reads the file off disk before any JS-side filter runs. `onLoadFilter` is
 * the one filter esbuild itself applies (in Go, before calling into JS), so it
 * carries the union of what either hook can handle — source files for
 * transform, the resolved runtime module for load (derived from the load
 * filter so the two cannot drift; a miss there would leave the lean-mode
 * runtime import unresolved). The hooks' own filters narrow it further.
 */
const ESBUILD_LOAD_FILTER = new RegExp(`\\.[cm]?[jt]sx?$|${RESOLVED_RUNTIME_ID_FILTER.source}`);

export const unplugin = createUnplugin(
  (options: ZodCompilerPluginOptions | undefined, meta: UnpluginContextMeta) => {
    const schemasMode = options?.schemas ?? "auto";
    const autoDiscover = schemasMode === "auto";
    const outputMode = options?.output ?? "schema";
    // "compact" keeps the Zod schema (its safeParse IS the cold error path) — so
    // it is zod-compatible like "schema"; only "bag" drops the schema object.
    const zodCompat = outputMode === "schema" || outputMode === "compact";
    const compact = outputMode === "compact";
    const stats = new BuildStatsAccumulator();
    // Transform results keyed by id, validated by content: bundlers re-run
    // transform for the same file (multiple environments, watch rebuilds) —
    // identical content returns the cached result, changed content recomputes.
    const cache = new Map<
      string,
      { code: string; result: string | null; map?: TransformSourceMap | null }
    >();
    const verbose = options?.verbose === true;
    const mode: CodegenMode =
      options?.codegenMode ?? (VIRTUAL_MODULE_FRAMEWORKS.has(meta.framework) ? "lean" : "inline");
    const runtimeId = WP_FRAMEWORKS.has(meta.framework) ? WP_RUNTIME_ID : VIRTUAL_RUNTIME_ID;
    // Persistent transform-result cache: discovery executes schema files (and
    // their import graphs) in-process, and the in-memory caches die with the
    // process — without a disk cache every test run / build re-pays that cost.
    // Entries self-validate against dep content hashes, so watch invalidation
    // semantics carry across processes.
    const cacheOption = options?.cache ?? true;
    // Opt-in worker pool. Null when disabled, or when the worker entry cannot
    // be located (the plugin has been bundled into a single file by a
    // consumer) — transforms then run in-process exactly as before.
    const poolSize = resolvePoolSize(options?.parallel);
    const pool = TransformPool.create(poolSize);
    /** Dedupes the in-process-fallback warning to one per build. */
    let warnedPoolFallback = false;
    if (poolSize > 0 && pool === null) {
      warn(
        "parallel was requested but the transform worker entry could not be located " +
          "(is zod-compiler bundled into your build?). Falling back to in-process transforms.",
      );
    }
    /**
     * Executed-module superset for the disk cache's deferred entries.
     *
     * With a pool, discovery happens in the workers, so this process's own
     * loader has executed nothing and `getFirstPartyModulePaths()` alone would
     * report an empty (or absent) set — silently dropping every deferred
     * entry, which on large graphs is most of them. Both sides are unioned:
     * the workers' reports, plus anything the in-process fallback executed
     * here. A worker that cannot track modules at all (Bun/Deno native import)
     * reports null, and null wins — the cache declines to persist rather than
     * record a set it knows is incomplete.
     */
    const executedModuleSuperset = (): string[] | null => {
      const local = getFirstPartyModulePaths();
      if (pool === null) return local;
      const remote = pool.firstPartyModulePaths();
      if (remote === null) return null;
      if (local === null) return remote;
      return [...new Set([...local, ...remote])];
    };
    const diskCache =
      cacheOption === false
        ? null
        : new DiskCache(
            DiskCache.resolveDir(cacheOption),
            JSON.stringify({
              mode,
              runtimeId,
              output: outputMode,
              schemas: schemasMode,
              hoist:
                typeof options?.hoist === "object"
                  ? String(options.hoist.schemaNamePattern ?? "default")
                  : (options?.hoist ?? true),
            }),
            executedModuleSuperset,
          );
    // Vite only (other bundlers ignore the field): when the plugin runs.
    // The default compiles production builds AND test runs — tests should
    // exercise (and benefit from) the validators that ship — while plain dev
    // servers skip AOT cost and use the Zod fallback. Vitest runs Vite in
    // serve mode but is detectable via the VITEST env var / "test" mode.
    const viteApply =
      options?.apply === "all"
        ? undefined
        : (options?.apply ??
          ((_config: unknown, env: { command: string; mode: string }) =>
            env.command === "build" || env.mode === "test" || process.env["VITEST"] !== undefined));

    // Hook filters (unplugin object hooks): bundlers that support them
    // natively — Rolldown, Vite, Rollup 4.40+ — reject a module before ever
    // calling into JS, and unplugin applies the same patterns itself
    // everywhere else. The `code` filter is the big one: a file that never
    // mentions zod cannot produce output, so it no longer costs a hook call,
    // a content hash and an import scan per build.
    const codeFilter = transformCodeFilter(options);
    const transformFilter =
      codeFilter === undefined
        ? { id: TRANSFORM_ID_FILTER }
        : { code: codeFilter, id: TRANSFORM_ID_FILTER };

    return {
      name: "zod-compiler",
      enforce: "pre" as const,

      vite: viteApply === undefined ? {} : { apply: viteApply },

      esbuild: { onLoadFilter: ESBUILD_LOAD_FILTER },

      resolveId: {
        filter: { id: RUNTIME_SPECIFIER_FILTER },
        handler(id: string) {
          return resolveVirtualId(id);
        },
      },

      load: {
        filter: { id: RESOLVED_RUNTIME_ID_FILTER },
        handler(id: string) {
          return loadVirtual(id);
        },
      },

      transform: {
        filter: transformFilter,
        async handler(code: string, id: string) {
          // The filter covers the static half of shouldTransform(); the
          // include/exclude options — picomatch `contains` semantics, which the
          // native filters do not reproduce — are applied here, as is the whole
          // check for hosts that ignore filters.
          if (!shouldTransform(id, options)) return;

          const cached = cache.get(id);
          if (cached && cached.code === code) {
            return cached.result === null
              ? undefined
              : { code: cached.result, map: cached.map ?? null };
          }
          if (cached) {
            // Content changed but no watchChange fired (bundlers without the
            // hook): drop stale module executions before re-discovering.
            invalidateModuleCache();
          }

          // Disk cache: skip static-filtering, discovery (file execution!) and
          // codegen entirely when a previous process already transformed this
          // exact content and every dep it executed is unchanged.
          const diskKey = diskCache === null ? null : diskCache.key(id, code);
          if (diskCache !== null && diskKey !== null) {
            const entry = diskCache.load(diskKey);
            if (entry !== null) {
              cache.set(id, { code, result: entry.result, map: entry.map ?? null });
              if (entry.stats) {
                stats.add({
                  files: 1,
                  schemas: entry.stats.schemas,
                  optimized: entry.stats.optimized,
                  failed: 0,
                });
              }
              if (verbose && entry.result !== null) {
                log(`Using cached transform for ${id}`);
              }
              return entry.result === null
                ? undefined
                : { code: entry.result, map: entry.map ?? null };
            }
          }

          const transformOptions: TransformOptions = {
            mode,
            runtimeId,
            verbose,
            zodCompat,
            compact,
            autoDiscover,
            hoist: options?.hoist,
          };

          let discoveryRan = false;
          let substantialWork = false;
          let uncacheable = false;
          let fileStats: BuildStats | null = null;

          const inProcess = async (): Promise<TransformOutput | null> =>
            transformCodeWithMap(code, id, {
              ...transformOptions,
              onDiscovery() {
                discoveryRan = true;
              },
              onSubstantialWork() {
                substantialWork = true;
              },
              onUncacheableResult() {
                uncacheable = true;
              },
              onBuildStats(s) {
                fileStats = s;
              },
            });

          let output: TransformOutput | null;
          if (pool === null) {
            output = await inProcess();
          } else {
            try {
              // The worker reports through flags what the in-process path
              // reports through callbacks; everything downstream reads the
              // same four values either way.
              const r = await pool.run(code, id, poolTransformOptions(transformOptions));
              output = r.output;
              discoveryRan = r.discoveryRan;
              substantialWork = r.substantialWork;
              uncacheable = r.uncacheable;
              fileStats = r.stats;
            } catch (error) {
              // A transform's own error propagates — it will fail identically
              // in-process, and retrying would only pay discovery twice. Only
              // a pool fault (a worker that died holding this task) is worth
              // redoing on this thread, so a single unhealthy worker degrades
              // the build's speed rather than breaking it.
              if (!(error instanceof PoolUnavailableError)) throw error;
              // Once per build. A pool that is broken rather than unlucky
              // fails for every remaining file, and a warning per file would
              // bury the build's real output under thousands of copies.
              if (!warnedPoolFallback) {
                warnedPoolFallback = true;
                warn(
                  `${error.message} — compiling ${id} in-process instead. ` +
                    `Later files take the same path without repeating this warning.`,
                );
              }
              output = await inProcess();
            }
          }

          if (fileStats !== null) stats.add(fileStats);
          const result = output === null ? null : output.code;
          const map = output === null ? null : output.map;
          cache.set(id, { code, result, map });

          // Persist when the transform did real work: produced output, ran
          // discovery, or did parse-level work (hoist scan / static filter) —
          // even when that work concluded "no transform needed". Null results
          // used to be skipped on the theory that bail-outs are cheaper than a
          // cache probe; that holds for textual bail-outs (still never
          // persisted) but not for the scans: hoist-only mode re-paid a full
          // scan per zod-importing file per run (35.8s/run in a field report)
          // purely to re-derive nulls.
          if (
            diskCache !== null &&
            diskKey !== null &&
            !uncacheable &&
            (result !== null || discoveryRan || substantialWork)
          ) {
            // TS narrows fileStats to null here (assignment happens inside a
            // callback it cannot track) — widen back.
            const s = fileStats as BuildStats | null;
            const entryStats =
              s === null ? undefined : { schemas: s.schemas, optimized: s.optimized };
            if (!discoveryRan) {
              // Discovery-free results (hoist scans, static-filter rejections,
              // hoist-only rewrites) are pure functions of the file content:
              // no deps.
              diskCache.save(diskKey, result, [], entryStats, map);
            } else {
              // Per-file dependency sets: the file's static first-party import
              // graph, so editing an unrelated file no longer invalidates this
              // entry (the global superset recorded the whole project — in
              // large codebases every commit wiped the entire cache). The
              // entry file itself is always a dep: the cache key hashes the
              // content the BUNDLER passed, but discovery executed the file
              // from DISK — recording it guards the (rare) divergence between
              // the two. When the graph cannot be fully analyzed (non-literal
              // dynamic imports, unresolvable relative specifiers), the entry
              // is deferred and flushed in buildEnd against ONE end-of-build
              // executed-modules superset — immediate snapshots gave every
              // entry a distinct point-in-time copy (283 MB in the field).
              const staticDeps = collectStaticDeps(id);
              if (staticDeps.complete) {
                diskCache.save(diskKey, result, [id, ...staticDeps.deps], entryStats, map);
              } else {
                diskCache.saveDeferred(diskKey, result, entryStats, map);
              }
            }
          }

          if (!result) return;
          return { code: result, map };
        },
      },

      watchChange(id: string) {
        if (!SOURCE_LIKE.test(id)) return;
        if (id.includes("node_modules")) return;
        // The changed file may be a dependency of any schema file, so both
        // the module cache (executions) and the transform result cache are
        // invalidated wholesale. node_modules stay warm in the loader. Disk
        // cache entries self-validate via dep hashes — only the per-process
        // stat memo needs resetting so changed files re-hash. Pending
        // deferred entries predate the change and must not flush against
        // post-change dep hashes.
        invalidateModuleCache();
        // Workers hold their own module caches; the broadcast is ordered ahead
        // of every transform posted after this point.
        pool?.invalidate();
        resetDepValidationMemo();
        resetDepGraphMemo();
        diskCache?.dropDeferred();
        cache.clear();
      },

      buildEnd() {
        // The loader's executed-modules superset is final here — persist the
        // queued incomplete-crawl entries against one shared snapshot.
        diskCache?.flushDeferred();
        if (!verbose) return;
        if (stats.schemas === 0) return;
        log(
          `Build summary: ${stats.optimized}/${stats.schemas} schemas optimized across ${stats.files} file(s)` +
            (stats.failed > 0 ? `, ${stats.failed} failed` : ""),
        );
        stats.reset();
      },
    };
  },
);

export type { ZodCompilerPluginOptions } from "./types.js";
