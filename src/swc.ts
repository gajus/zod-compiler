import fs from "node:fs/promises";
import path from "node:path";
import { invalidateModuleCache } from "./loader.js";
import { shouldTransform, transformCodeWithMap } from "./unplugin/transform.js";
import type { TransformOptions, ZodCompilerPluginOptions } from "./unplugin/types.js";

/**
 * Minimal @swc/core option shape. zod-compiler keeps @swc/core optional so
 * non-SWC users do not install a native dependency just by using the package.
 * `inputSourceMap` matches @swc/core: a JSON string or a boolean — swc does
 * not accept map objects.
 */
export interface SwcOptions {
  filename?: string | undefined;
  inputSourceMap?: boolean | string | undefined;
  sourceMaps?: boolean | "inline" | undefined;
  [key: string]: unknown;
}

export interface SwcOutput {
  code: string;
  map?: string | undefined;
  [key: string]: unknown;
}

export interface SwcCoreLike {
  transform(code: string, options?: SwcOptions): Promise<SwcOutput>;
}

/**
 * Plugin options that make sense for a transformer host. `apply` is Vite
 * lifecycle and `cache` is the bundler disk cache — the bridge keeps no
 * persistent cache, so hosts that need one must key transform results on
 * content themselves. `include`/`exclude` are honored: files they reject
 * pass through to SWC without the zod-compiler step.
 */
export type ZodCompilerSwcOptions = Omit<
  ZodCompilerPluginOptions,
  "apply" | "cache" | "codegenMode"
> & {
  /**
   * SWC is a transformer, not a bundler plugin host, so inline is the safe
   * default. Lean mode may emit virtual runtime imports that SWC cannot resolve
   * unless another tool handles them after SWC.
   */
  codegenMode?: "inline" | "lean" | undefined;
};

export interface SwcBridgeDefaults {
  /** Options passed through to @swc/core.transform. */
  swc?: SwcOptions | undefined;
  /** zod-compiler options. Defaults match the build plugins except codegenMode is "inline". */
  zodCompiler?: ZodCompilerSwcOptions | undefined;
}

export interface SwcBridgeTransformOptions extends SwcBridgeDefaults {
  /** Absolute or project-relative filename for schema discovery and SWC config resolution. */
  filename: string;
}

export interface SwcBridge {
  transform(code: string, options: SwcBridgeTransformOptions): Promise<SwcOutput>;
  transformFile(filename: string, options?: SwcBridgeDefaults): Promise<SwcOutput>;
}

function toTransformOptions(options?: ZodCompilerSwcOptions): TransformOptions {
  const output = options?.output ?? "schema";
  return {
    mode: options?.codegenMode ?? "inline",
    verbose: options?.verbose,
    zodCompat: output === "schema" || output === "compact",
    compact: output === "compact",
    autoDiscover: (options?.schemas ?? "auto") === "auto",
    stripUnknownKeys: options?.stripUnknownKeys,
    hoist: options?.hoist,
  };
}

/**
 * Per-call options win key-by-key over factory defaults. The merge is
 * shallow: a per-call `swc.jsc` replaces the default `jsc` wholesale rather
 * than deep-merging parser/target settings.
 */
function mergeOptions(
  defaults: SwcBridgeDefaults | undefined,
  options: SwcBridgeTransformOptions,
): SwcBridgeTransformOptions {
  return {
    filename: options.filename,
    swc: { ...defaults?.swc, ...options.swc },
    zodCompiler: { ...defaults?.zodCompiler, ...options.zodCompiler },
  };
}

async function loadSwc(): Promise<SwcCoreLike> {
  try {
    return (await import("@swc/core")) as unknown as SwcCoreLike;
  } catch (error) {
    const cause = error instanceof Error ? `: ${error.message}` : "";
    throw new Error(
      `zod-compiler/swc requires @swc/core to be installed by the consuming project${cause}`,
    );
  }
}

/**
 * Last content seen per filename. Discovery executes schema files from DISK
 * through a module cache that outlives transform calls, so when a host (dev
 * server, watch-mode test runner) re-transforms a file with new content, the
 * stale executions must be dropped or the compiled validators keep
 * reflecting the old schema. Same content-diff scheme as the unplugin
 * transform hook; tracked for every file fed to the bridge — an excluded
 * file can still be a dependency a schema file executed.
 */
const lastSeenCode = new Map<string, string>();

function invalidateOnContentChange(filename: string, code: string): void {
  const key = path.resolve(filename);
  const previous = lastSeenCode.get(key);
  if (previous !== undefined && previous !== code) {
    invalidateModuleCache();
  }
  lastSeenCode.set(key, code);
}

async function transformWith(
  swc: SwcCoreLike,
  code: string,
  options: SwcBridgeTransformOptions,
): Promise<SwcOutput> {
  invalidateOnContentChange(options.filename, code);

  const zodResult = shouldTransform(options.filename, options.zodCompiler)
    ? await transformCodeWithMap(code, options.filename, toTransformOptions(options.zodCompiler))
    : null;

  const swcOptions: SwcOptions = {
    ...options.swc,
    filename: options.swc?.filename ?? options.filename,
  };
  if (zodResult?.map && swcOptions.inputSourceMap === undefined) {
    swcOptions.inputSourceMap = JSON.stringify(zodResult.map);
  }

  return swc.transform(zodResult?.code ?? code, swcOptions);
}

export async function transform(
  code: string,
  options: SwcBridgeTransformOptions,
): Promise<SwcOutput> {
  return transformWith(await loadSwc(), code, options);
}

export async function transformFile(
  filename: string,
  options?: SwcBridgeDefaults,
): Promise<SwcOutput> {
  const code = await fs.readFile(filename, "utf8");
  return transform(code, { ...options, filename });
}

export function createSwcCompiler(defaults?: SwcBridgeDefaults): SwcBridge {
  return {
    transform(code, options) {
      return transform(code, mergeOptions(defaults, options));
    },
    async transformFile(filename, options) {
      const code = await fs.readFile(filename, "utf8");
      return transform(code, mergeOptions(defaults, { ...options, filename }));
    },
  };
}

/**
 * Test seam for the SWC bridge. It is exported because it is also useful for
 * custom hosts that already own a @swc/core-compatible transform function.
 */
export async function transformWithSwc(
  swc: SwcCoreLike,
  code: string,
  options: SwcBridgeTransformOptions,
): Promise<SwcOutput> {
  return transformWith(swc, code, options);
}

export default function zodCompiler(defaults?: SwcBridgeDefaults): SwcBridge {
  return createSwcCompiler(defaults);
}
