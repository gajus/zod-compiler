/**
 * Worker entry for the transform pool (see ./pool.ts).
 *
 * One transform at a time, on its own module graph. The worker owns a private
 * loader — its own jiti instance, its own zod, its own execution cache — which
 * is what makes running several of these concurrently sound: the serialization
 * inside ../loader.ts exists to stop concurrent transforms from double-
 * executing a SHARED dependency, and nothing is shared across threads.
 *
 * The protocol deliberately carries no callbacks. In-process, the transform
 * reports progress through `onDiscovery`/`onSubstantialWork`/
 * `onUncacheableResult`/`onBuildStats`, all of which the disk cache reads to
 * decide whether and how to persist. Functions do not survive structured
 * cloning, so they are collapsed here into flags on a single reply — the main
 * thread reconstructs exactly the decisions it would have made.
 */

import { parentPort } from "node:worker_threads";
import { getFirstPartyModulePaths, invalidateModuleCache } from "../loader.js";
import type { PoolRequest, PoolResponse, PoolTransformResult } from "./pool.js";
import { transformCodeWithMap } from "./transform.js";
import type { BuildStats } from "./types.js";

const port = parentPort;
if (port === null) {
  throw new Error("zod-compiler pool worker was started outside a worker thread");
}

/**
 * Paths already reported to the pool. The executed-module list grows into the
 * thousands on a real project and the main thread only needs the union, so
 * each reply carries the delta since the last one rather than the whole set.
 */
let reported = new Set<string>();

/**
 * Modules executed since the previous report, or null when this runtime cannot
 * track them at all (Bun/Deno use native import, whose cache cannot be
 * enumerated or evicted). Null propagates: the pool stops offering a superset
 * and the disk cache declines to persist deferred entries, which is what the
 * in-process path already does on those runtimes.
 */
function moduleDelta(): string[] | null {
  const all = getFirstPartyModulePaths();
  if (all === null) return null;
  const delta: string[] = [];
  for (const p of all) {
    if (!reported.has(p)) {
      reported.add(p);
      delta.push(p);
    }
  }
  return delta;
}

async function handleTransform(
  request: Extract<PoolRequest, { type: "transform" }>,
): Promise<PoolResponse> {
  let discoveryRan = false;
  let substantialWork = false;
  let uncacheable = false;
  let stats: BuildStats | null = null;

  try {
    const output = await transformCodeWithMap(request.code, request.id, {
      ...request.options,
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
        stats = s;
      },
    });
    const result: PoolTransformResult = {
      output,
      discoveryRan,
      substantialWork,
      uncacheable,
      // TS cannot see the assignment inside the callback above.
      stats: stats as BuildStats | null,
      newModulePaths: moduleDelta(),
    };
    return { type: "result", seq: request.seq, result };
  } catch (error) {
    // The transform's own failures — a schema file that will not load in
    // `schemas: "explicit"` mode — must reach the bundler with their original
    // message, so they are forwarded rather than swallowed. The pool rebuilds
    // the Error on the other side; only these three fields survive cloning.
    const e = error instanceof Error ? error : new Error(String(error));
    return { type: "error", seq: request.seq, name: e.name, message: e.message, stack: e.stack };
  }
}

port.on("message", (request: PoolRequest) => {
  if (request.type === "invalidate") {
    invalidateModuleCache();
    // The loader just dropped every first-party module, so the next discovery
    // re-executes and must re-report them: a delta against the pre-change set
    // would report nothing and the pool's union would keep paths whose entries
    // are gone. Harmless for cache soundness (a superset only over-
    // invalidates) but it would grow without bound across a long watch session.
    reported = new Set<string>();
    port.postMessage({ type: "invalidated", seq: request.seq } satisfies PoolResponse);
    return;
  }

  void handleTransform(request).then(
    (response) => {
      port.postMessage(response);
    },
    (error: unknown) => {
      // handleTransform catches its own failures; this is the last resort for
      // a fault in the reply path itself (an output that will not clone).
      const e = error instanceof Error ? error : new Error(String(error));
      port.postMessage({
        type: "error",
        seq: request.seq,
        name: e.name,
        message: e.message,
        stack: e.stack,
      } satisfies PoolResponse);
    },
  );
});
