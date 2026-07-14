import fs from "node:fs/promises";
import type { TransformOptions } from "./unplugin/types.js";
import type { TransformSourceMap } from "./unplugin/transform.js";
import { transformCodeWithMap } from "./unplugin/transform.js";
import type { ZodCompilerPluginOptions } from "./unplugin/types.js";

/**
 * Minimal @swc/core option shape. zod-compiler keeps @swc/core optional so
 * non-SWC users do not install a native dependency just by using the package.
 */
export interface SwcOptions {
  filename?: string | undefined;
  inputSourceMap?: boolean | string | TransformSourceMap | undefined;
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

export type ZodCompilerSwcOptions = Omit<ZodCompilerPluginOptions, "apply" | "codegenMode"> & {
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

async function transformWith(
  swc: SwcCoreLike,
  code: string,
  options: SwcBridgeTransformOptions,
): Promise<SwcOutput> {
  const zodResult = await transformCodeWithMap(
    code,
    options.filename,
    toTransformOptions(options.zodCompiler),
  );

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
      return transformWith(await loadSwc(), code, mergeOptions(defaults, { ...options, filename }));
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
