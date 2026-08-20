/**
 * Worker-thread pool for the unplugin transform.
 *
 * Discovery — executing a schema file and its whole first-party import graph
 * so Zod's constructors run and produce the objects extract walks — is the
 * single most expensive phase of a cold build, and today it runs strictly one
 * file at a time: `loadQueue` in ../loader.ts serializes every jiti import so
 * concurrent transforms cannot double-execute a shared dependency, and the
 * bundler itself is one process. Nothing about the work requires that. Each
 * file's transform reads only `(code, id, options)` and returns
 * `{ code, map }` plus a few flags — the shape of a task, not of a stage.
 *
 * So the pool moves whole transforms off the bundler thread. Each worker owns
 * its own loader, its own jiti instance and its own copy of zod; nothing is
 * shared, which is exactly why the serialization inside a worker is harmless.
 * Measured on 120 files of deeply nested schemas: 3,633 ms sequential →
 * 1,508 ms at four workers. The pool is spawned LAZILY — a project with three
 * schema files starts three workers, not one per core.
 *
 * ## When it does NOT pay
 *
 * Independence is the whole bet, and it is a bet about the user's import
 * graph, not about their machine. In-process, the loader executes a shared
 * dependency ONCE for the whole build; N workers execute it N times. So the
 * win tracks how disjoint the schema files' graphs are, and it can invert: on
 * a fixture of the same size whose files form a 120-deep chain, four workers
 * measured 1,045 ms against 945 ms in-process — a small loss — and twelve
 * measured 3,332 ms, because each worker was re-executing most of the project
 * to compile its share of it. The same files with the chain removed went
 * 636 ms → 341 ms.
 *
 * That, plus N copies of the graph in memory, is why this is opt-in rather
 * than the default — see ZodCompilerPluginOptions.
 *
 * ## What still runs on the bundler thread
 *
 * Everything that touches shared state: the disk cache (one directory, one GC,
 * atomic writes), the static dependency crawl (pure over the filesystem, and
 * memoized across files — sharding it would multiply the memo instead of the
 * throughput), and the in-memory result cache. Workers do the executing and
 * the generating; the main thread does the bookkeeping.
 *
 * ## Executed-module reporting
 *
 * The disk cache needs `getFirstPartyModulePaths()` — the superset of modules
 * the loader has executed — to persist entries whose static dep crawl came
 * back incomplete (the common outcome on large graphs: one non-literal dynamic
 * import anywhere poisons the closure). With discovery in workers, the main
 * thread's loader executes nothing, so that superset would be empty and every
 * deferred entry would be silently dropped — no stale results, but a large
 * chunk of the cache quietly stops working.
 *
 * Workers therefore report the paths they have executed back with every
 * result, as a DELTA against what they have already reported (the full list
 * grows into the thousands and would be re-sent per file). The pool unions
 * those deltas into {@link TransformPool.firstPartyModulePaths}, which the
 * DiskCache reads synchronously at flush time exactly as it reads the loader's
 * own. A worker that cannot track modules at all — Bun/Deno, where native
 * import has no evictable cache — reports `null`, and the union degrades to
 * `null` so the cache declines to persist rather than guessing.
 */

import * as fs from "node:fs";
import { availableParallelism } from "node:os";
import { Worker } from "node:worker_threads";
import type { CodegenMode } from "../core/codegen/context.js";
import type { HoistOptions } from "./hoist.js";
import type { TransformSourceMap } from "./transform.js";
import type { BuildStats, TransformOptions } from "./types.js";

/**
 * Upper bound on pool size for `parallel: true`.
 *
 * Four, and not "one per core", because throughput peaks there and then goes
 * BACKWARDS. Measured on 120 files of deeply nested schemas (960 schemas), on
 * a machine with 12 performance cores:
 *
 *   in-process 3,633 ms · n=2 2,263 · n=4 1,508 · n=6 1,568 · n=8 1,786 · n=12 2,119
 *
 * Past four the bottleneck stops being CPU. Every worker re-executes whatever
 * of the project graph its files reach, holds its own copy of it, and ships
 * megabytes of generated source back through structured cloning that the ONE
 * receiving thread has to deserialize. More workers multiply the first two
 * costs and contend on the third.
 *
 * The same effect makes the cap protective rather than merely tidy: on a
 * fixture whose files form a 120-deep import chain — where the in-process
 * loader executes the shared graph once and every worker re-executes most of
 * it — n=4 costs 1,045 ms against 945 ms in-process, while n=12 costs 3,332 ms.
 * Overshooting turns a small loss into a rout. An explicit `parallel: <n>`
 * overrides this for anyone who has measured their own graph.
 */
const MAX_AUTO_WORKERS = 4;

/** Hard ceiling on an explicit `parallel: <n>`, guarding a typo'd 400. */
const MAX_WORKERS = 32;

/**
 * Consecutive worker deaths before the pool gives up for the rest of the build.
 *
 * Falling back per file is the right response to ONE unlucky worker (an OOM
 * under a particularly large graph). It is the wrong response to a pool that
 * cannot work at all — a partial install, a Node build without worker support
 * — where every file would spawn a worker, wait for it to die, warn, and then
 * do the transform in-process anyway. Tripping the breaker converts that into
 * a normal serial build after the first few files.
 */
const MAX_CONSECUTIVE_FAILURES = 3;

/** The subset of TransformOptions that survives structured cloning. */
export interface PoolTransformOptions {
  mode: CodegenMode;
  runtimeId?: string | undefined;
  zodCompat?: boolean | undefined;
  compact?: boolean | undefined;
  verbose?: boolean | undefined;
  autoDiscover?: boolean | undefined;
  hoist?: boolean | HoistOptions | undefined;
}

/** Main → worker. */
export type PoolRequest =
  | { type: "transform"; seq: number; code: string; id: string; options: PoolTransformOptions }
  | { type: "invalidate"; seq: number };

/**
 * What a worker observed while transforming one file: the output plus the
 * signals the main thread's disk-cache bookkeeping needs, which arrive as
 * callbacks in the in-process path and cannot cross a thread boundary.
 */
export interface PoolTransformResult {
  output: { code: string; map: TransformSourceMap | null } | null;
  discoveryRan: boolean;
  substantialWork: boolean;
  uncacheable: boolean;
  stats: BuildStats | null;
  /**
   * First-party modules this worker executed since its last report, or `null`
   * when the worker cannot track them (Bun/Deno native import).
   */
  newModulePaths: string[] | null;
}

/** Worker → main. */
export type PoolResponse =
  | { type: "result"; seq: number; result: PoolTransformResult }
  | { type: "error"; seq: number; name: string; message: string; stack?: string | undefined }
  | { type: "invalidated"; seq: number };

/**
 * Raised when the pool itself failed — a worker that would not spawn, or one
 * that died mid-task (OOM is the realistic case; each worker holds a full
 * module graph). Distinct from a transform's own error, which is rethrown with
 * its original identity, because the caller's response differs: an
 * infrastructure failure is worth retrying on the bundler thread, a schema
 * that cannot compile is not.
 */
export class PoolUnavailableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "PoolUnavailableError";
  }
}

/**
 * Resolve `parallel` to a worker count. `false`/`undefined` disable the pool.
 *
 * `true` leaves one core for the bundler itself — it is still parsing,
 * resolving and generating chunks while transforms run — and then caps at
 * {@link MAX_AUTO_WORKERS}.
 */
export function resolvePoolSize(parallel: boolean | number | undefined): number {
  if (parallel === undefined || parallel === false) return 0;
  if (parallel === true) {
    return Math.min(Math.max(availableParallelism() - 1, 1), MAX_AUTO_WORKERS);
  }
  if (!Number.isFinite(parallel)) return 0;
  return Math.min(Math.max(Math.floor(parallel), 1), MAX_WORKERS);
}

/** Strip the callbacks from TransformOptions; what remains is cloneable. */
export function poolTransformOptions(options: TransformOptions): PoolTransformOptions {
  return {
    mode: options.mode,
    runtimeId: options.runtimeId,
    zodCompat: options.zodCompat,
    compact: options.compact,
    verbose: options.verbose,
    autoDiscover: options.autoDiscover,
    hoist: options.hoist,
  };
}

/**
 * Locate the worker entry next to this module.
 *
 * Published, that is `dist/unplugin/pool-worker.js` and a plain dynamic import
 * loads it. Running from source — this repository's own test suite resolves
 * `#src/**` through Vite — only the `.ts` sibling exists, and a worker starts
 * outside Vite's pipeline, in bare Node. Node's native type stripping is not
 * enough there: it erases types but does not remap the `./transform.js`
 * specifiers TypeScript requires onto the `.ts` files that actually exist. So
 * the bootstrap hands `.ts` entries to jiti, which resolves them the same way
 * the loader already resolves user schema files.
 *
 * Returns null when neither exists — the plugin's own code has been bundled
 * into a single file by a consumer, so `import.meta.url` no longer points at a
 * directory containing it. The caller falls back to in-process transforms.
 */
function resolveWorkerEntry(): { href: string; isTypeScript: boolean } | null {
  for (const [specifier, isTypeScript] of [
    ["./pool-worker.js", false],
    ["./pool-worker.ts", true],
  ] as const) {
    const url = new URL(specifier, import.meta.url);
    if (url.protocol !== "file:") continue;
    try {
      if (fs.statSync(url, { throwIfNoEntry: false })?.isFile()) {
        return { href: url.href, isTypeScript };
      }
    } catch {
      // Unreadable path — try the next candidate.
    }
  }
  return null;
}

/**
 * CommonJS bootstrap evaluated inside each worker (`eval: true`). A string
 * rather than a file because it has to work identically from `dist/` and from
 * `src/`, where no `.js` sibling exists to point a Worker at.
 */
const WORKER_BOOTSTRAP = `
const { workerData } = require("node:worker_threads");
(async () => {
  if (workerData.isTypeScript) {
    const { createJiti } = await import(workerData.jitiSpecifier);
    await createJiti(workerData.entry).import(workerData.entry);
  } else {
    await import(workerData.entry);
  }
})().catch((error) => {
  // Reaching the parent as an 'error' event is the whole point: a worker that
  // cannot load its entry must fail loudly enough for the pool to fall back,
  // not sit idle holding a task.
  setTimeout(() => { throw error; });
});
`;

/** Resolve jiti's URL for the bootstrap; bare specifier if resolution is unavailable. */
function jitiSpecifier(): string {
  try {
    return import.meta.resolve("jiti");
  } catch {
    return "jiti";
  }
}

/**
 * Live pools, so a host that outlives its bundler can shut them all down.
 *
 * Nothing in the plugin lifecycle disposes a pool on its own: workers are kept
 * warm ACROSS watch rebuilds on purpose — invalidation drops first-party
 * modules but leaves node_modules (zod itself, the expensive bulk) executed,
 * and discarding that per rebuild would re-pay boot plus a cold zod on every
 * keystroke. Idle workers are unref'd, so they never hold a process open and a
 * one-shot build exits normally. This registry exists for hosts that need
 * determinism instead — chiefly this package's own test suite, which builds
 * many plugin instances in one process.
 */
const livePools = new Set<TransformPool>();

/** Terminate every live transform pool. */
export async function disposeAllPools(): Promise<void> {
  await Promise.all([...livePools].map((pool) => pool.dispose()));
}

interface PoolWorker {
  worker: Worker;
  /** Seq of the request this worker is handling, or null when idle. */
  busy: number | null;
}

interface PendingTask {
  request: PoolRequest;
  resolve: (result: PoolTransformResult) => void;
  reject: (error: Error) => void;
}

/**
 * A lazily grown pool of transform workers.
 *
 * Not a general-purpose executor: it knows the transform protocol, and it
 * knows that a broadcast invalidation has to be ordered ahead of every
 * subsequent transform on every worker (per-worker message delivery is FIFO,
 * so posting the broadcast before any later task is sufficient — and the only
 * ordering guarantee available, since a worker mid-transform cannot be
 * interrupted).
 */
export class TransformPool {
  private readonly size: number;
  private readonly entry: { href: string; isTypeScript: boolean };
  private readonly workers: PoolWorker[] = [];
  private readonly queue: PendingTask[] = [];
  /** In-flight requests by seq, so a worker exit can reject exactly its own. */
  private readonly inflight = new Map<number, PendingTask>();
  private readonly executedModules = new Set<string>();
  /** A worker reported it cannot track executed modules — the union is unusable. */
  private moduleTrackingUnavailable = false;
  private seq = 0;
  private disposed = false;
  /** Worker deaths since the last successful result; trips MAX_CONSECUTIVE_FAILURES. */
  private consecutiveFailures = 0;
  /** Set once the breaker trips: every later run() rejects without spawning. */
  private brokenPool = false;

  private constructor(size: number, entry: { href: string; isTypeScript: boolean }) {
    this.size = size;
    this.entry = entry;
  }

  /**
   * Build a pool of `size` workers, or return null when workers are
   * unavailable in this installation (the entry could not be located). Callers
   * treat null as "run in-process".
   */
  static create(size: number): TransformPool | null {
    if (size <= 0) return null;
    const entry = resolveWorkerEntry();
    if (entry === null) return null;
    const pool = new TransformPool(size, entry);
    livePools.add(pool);
    return pool;
  }

  /** Transform one file on a worker. Rejects with the transform's own error, or PoolUnavailableError. */
  run(code: string, id: string, options: PoolTransformOptions): Promise<PoolTransformResult> {
    if (this.disposed) {
      return Promise.reject(new PoolUnavailableError("Transform pool is disposed"));
    }
    if (this.brokenPool) {
      return Promise.reject(
        new PoolUnavailableError(
          `Transform workers failed ${MAX_CONSECUTIVE_FAILURES} times in a row; this build is running in-process`,
        ),
      );
    }
    return new Promise<PoolTransformResult>((resolve, reject) => {
      const request: PoolRequest = { type: "transform", seq: this.seq++, code, id, options };
      this.dispatch({ request, resolve, reject });
    });
  }

  /**
   * Drop every worker's executed-module cache, so the next discovery re-runs
   * changed schema graphs. Mirrors the loader's invalidateModuleCache() for
   * the in-process path; called from watchChange.
   *
   * Fire-and-forget: the broadcast is posted to every live worker before any
   * later transform can be, and per-worker FIFO delivery does the rest. A
   * transform ALREADY executing in a worker keeps its pre-change module cache
   * — the same window the in-process path has, where invalidation lands
   * between awaits — and the main thread's own result cache is cleared
   * alongside, so the file is recomputed either way.
   */
  invalidate(): void {
    if (this.disposed) return;
    this.executedModules.clear();
    this.moduleTrackingUnavailable = false;
    for (const entry of this.workers) {
      entry.worker.postMessage({ type: "invalidate", seq: this.seq++ } satisfies PoolRequest);
    }
  }

  /**
   * Union of the first-party modules every worker has executed, or null when
   * any worker cannot track them. Synchronous, because DiskCache.flushDeferred
   * runs from `buildEnd` and from a process 'exit' hook, where only
   * synchronous work is allowed — which is why workers push deltas rather than
   * answering a query.
   */
  firstPartyModulePaths(): string[] | null {
    if (this.moduleTrackingUnavailable) return null;
    // An empty array is a real answer — no worker has executed anything yet
    // (every file hit the disk cache). It is the CALLER's job not to pair an
    // empty superset with an entry that ran discovery; DiskCache.flushDeferred
    // refuses that combination outright.
    return [...this.executedModules];
  }

  /** Terminate every worker. Pending and queued tasks reject. */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    livePools.delete(this);
    const error = new PoolUnavailableError("Transform pool was disposed");
    for (const task of this.queue.splice(0)) task.reject(error);
    for (const task of this.inflight.values()) task.reject(error);
    this.inflight.clear();
    await Promise.all(this.workers.splice(0).map((entry) => entry.worker.terminate()));
  }

  /** Hand a task to an idle worker, grow the pool, or queue it. */
  private dispatch(task: PendingTask): void {
    const idle = this.workers.find((entry) => entry.busy === null);
    if (idle !== undefined) {
      this.send(idle, task);
      return;
    }
    if (this.workers.length < this.size) {
      let created: PoolWorker;
      try {
        created = this.spawn();
      } catch (error) {
        task.reject(
          new PoolUnavailableError(
            `Could not start a zod-compiler transform worker: ${error instanceof Error ? error.message : String(error)}`,
            { cause: error },
          ),
        );
        return;
      }
      this.workers.push(created);
      this.send(created, task);
      return;
    }
    this.queue.push(task);
  }

  private send(entry: PoolWorker, task: PendingTask): void {
    entry.busy = task.request.seq;
    this.inflight.set(task.request.seq, task);
    // A worker is unref'd while idle so it never holds the process open, and
    // ref'd while it owns a task so the process cannot exit out from under the
    // promise the caller is awaiting.
    entry.worker.ref();
    entry.worker.postMessage(task.request);
  }

  private spawn(): PoolWorker {
    const worker = new Worker(WORKER_BOOTSTRAP, {
      eval: true,
      workerData: {
        entry: this.entry.href,
        isTypeScript: this.entry.isTypeScript,
        jitiSpecifier: jitiSpecifier(),
      },
    });
    const entry: PoolWorker = { worker, busy: null };
    worker.unref();
    worker.on("message", (message: PoolResponse) => {
      this.onMessage(entry, message);
    });
    worker.on("error", (error: Error) => {
      this.onWorkerGone(entry, error);
    });
    worker.on("exit", (code) => {
      if (this.disposed) return;
      this.onWorkerGone(entry, new Error(`worker exited with code ${code}`));
    });
    return entry;
  }

  private onMessage(entry: PoolWorker, message: PoolResponse): void {
    if (message.type === "invalidated") return;
    const task = this.inflight.get(message.seq);
    this.inflight.delete(message.seq);
    if (entry.busy === message.seq) {
      entry.busy = null;
      entry.worker.unref();
    }
    if (task !== undefined) {
      if (message.type === "result") {
        // A worker that answered is a working worker: an earlier death was
        // this file's bad luck, not a pool that cannot run.
        this.consecutiveFailures = 0;
        this.recordModulePaths(message.result.newModulePaths);
        task.resolve(message.result);
      } else {
        // Rebuild the transform's own error on this side of the boundary. The
        // message is what surfaces in the bundler's output, so it has to
        // survive verbatim — this is the path a genuine "Failed to load
        // schemas from …" travels.
        const error = new Error(message.message);
        error.name = message.name;
        if (message.stack !== undefined) error.stack = message.stack;
        task.reject(error);
      }
    }
    this.drain();
  }

  /**
   * A worker died — OOM while holding a large module graph is the realistic
   * cause. Its task fails with PoolUnavailableError so the caller can retry
   * in-process, and the worker is dropped from the pool; the next dispatch
   * spawns a replacement.
   */
  private onWorkerGone(entry: PoolWorker, cause: Error): void {
    const index = this.workers.indexOf(entry);
    // Node emits 'error' and then 'exit' for the same death; only the first
    // one still finds the worker in the pool, so only it counts as a failure.
    if (index === -1) return;
    this.workers.splice(index, 1);
    if (++this.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) this.brokenPool = true;
    const seq = entry.busy;
    entry.busy = null;
    if (seq !== null) {
      const task = this.inflight.get(seq);
      this.inflight.delete(seq);
      task?.reject(
        new PoolUnavailableError(`zod-compiler transform worker failed: ${cause.message}`, {
          cause,
        }),
      );
    }
    // Executed-module reports from a dead worker describe a module cache that
    // no longer exists, but the union is a SUPERSET — keeping stale paths can
    // only over-invalidate cache entries, never validate a stale one.
    this.drain();
  }

  private drain(): void {
    if (this.brokenPool) {
      // The breaker tripped while these waited. Spawning for them would repeat
      // the failure per file; hand them back so the caller runs them itself.
      const error = new PoolUnavailableError(
        `Transform workers failed ${MAX_CONSECUTIVE_FAILURES} times in a row; this build is running in-process`,
      );
      for (const task of this.queue.splice(0)) task.reject(error);
      return;
    }
    while (this.queue.length > 0) {
      const idle = this.workers.find((e) => e.busy === null);
      if (idle === undefined) {
        // No idle worker; grow if the pool is under size (a death may have
        // freed a slot), otherwise wait for the next completion.
        if (this.workers.length >= this.size) return;
        const task = this.queue.shift();
        if (task === undefined) return;
        this.dispatch(task);
        continue;
      }
      const task = this.queue.shift();
      if (task === undefined) return;
      this.send(idle, task);
    }
  }

  private recordModulePaths(paths: string[] | null): void {
    if (paths === null) {
      this.moduleTrackingUnavailable = true;
      return;
    }
    for (const p of paths) this.executedModules.add(p);
  }
}
