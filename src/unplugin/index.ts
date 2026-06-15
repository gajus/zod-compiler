import process from "node:process";
import { createUnplugin, type UnpluginContextMeta } from "unplugin";
import type { CodegenMode } from "../core/codegen/context.js";
import { getFirstPartyModulePaths, invalidateModuleCache } from "../loader.js";
import { collectStaticDeps, resetDepGraphMemo } from "./dep-graph.js";
import { DiskCache, resetDepValidationMemo } from "./disk-cache.js";
import {
  log,
  shouldTransform,
  type TransformSourceMap,
  transformCodeWithMap,
} from "./transform.js";
import type { BuildStats, ZodCompilerPluginOptions } from "./types.js";
import { BuildStatsAccumulator } from "./types.js";
import {
  loadVirtual,
  RESOLVED_RUNTIME_ID,
  resolveVirtualId,
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

export const unplugin = createUnplugin(
  (options: ZodCompilerPluginOptions | undefined, meta: UnpluginContextMeta) => {
    const schemasMode = options?.schemas ?? "auto";
    const autoDiscover = schemasMode === "auto";
    const outputMode = options?.output ?? "schema";
    const zodCompat = outputMode === "schema";
    const stats = new BuildStatsAccumulator();
    // Transform results keyed by id, validated by content: bundlers re-run
    // transform for the same file (multiple environments, watch rebuilds) —
    // identical content returns the cached result, changed content recomputes.
    const cache = new Map<
      string,
      { code: string; result: string | null; map?: TransformSourceMap | null }
    >();
    const verbose = options?.verbose === true;
    const mode: CodegenMode = VIRTUAL_MODULE_FRAMEWORKS.has(meta.framework) ? "lean" : "inline";
    const runtimeId = WP_FRAMEWORKS.has(meta.framework) ? WP_RUNTIME_ID : VIRTUAL_RUNTIME_ID;
    // Persistent transform-result cache: discovery executes schema files (and
    // their import graphs) in-process, and the in-memory caches die with the
    // process — without a disk cache every test run / build re-pays that cost.
    // Entries self-validate against dep content hashes, so watch invalidation
    // semantics carry across processes.
    const cacheOption = options?.cache ?? true;
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
            getFirstPartyModulePaths,
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

    return {
      name: "zod-compiler",
      enforce: "pre" as const,

      vite: viteApply === undefined ? {} : { apply: viteApply },

      resolveId(id: string) {
        return resolveVirtualId(id);
      },

      loadInclude(id: string): boolean {
        return id === RESOLVED_RUNTIME_ID;
      },

      load(id: string) {
        return loadVirtual(id);
      },

      transformInclude(id: string): boolean {
        return shouldTransform(id, options);
      },

      async transform(code: string, id: string) {
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

        let discoveryRan = false;
        let substantialWork = false;
        let fileStats: BuildStats | null = null;
        const output = await transformCodeWithMap(code, id, {
          mode,
          runtimeId,
          verbose,
          zodCompat,
          autoDiscover,
          hoist: options?.hoist,
          onDiscovery() {
            discoveryRan = true;
          },
          onSubstantialWork() {
            substantialWork = true;
          },
          onBuildStats(s) {
            stats.add(s);
            fileStats = s;
          },
        });
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
