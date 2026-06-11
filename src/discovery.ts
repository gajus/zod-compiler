import { isCompiledSchema } from "#src/core/compile.js";
import type { DiscoveredSchema } from "#src/core/types.js";
import { loadSourceFile } from "./loader.js";

export interface DiscoverOptions {
  /** Auto-detect all exported Zod schemas without requiring compile() wrappers. */
  autoDiscover?: boolean | undefined;
}

/**
 * Check if a value is a Zod schema by detecting the _zod.def structure.
 * Used by autoDiscover to find plain Zod exports.
 */
function isZodSchema(value: unknown): boolean {
  if (typeof value !== "object" || value === null || !("_zod" in value)) return false;
  const zod = (value as Record<string, unknown>)["_zod"];
  return typeof zod === "object" && zod !== null && "def" in zod;
}

/**
 * Discover schemas in a source file by importing it and scanning exports.
 *
 * - Default mode: finds compile() calls via CompiledSchema marker.
 * - autoDiscover mode: also finds plain Zod schema exports via _zod.def detection.
 *   compile() schemas take priority (isCompiledSchema checked first).
 */
export async function discoverSchemas(
  filePath: string,
  options?: DiscoverOptions,
): Promise<DiscoveredSchema[]> {
  const mod = await loadSourceFile(filePath);
  const schemas: DiscoveredSchema[] = [];
  const targets: Record<string, unknown> = { ...mod };
  const defaultExport = mod["default"];
  if (
    defaultExport != null &&
    typeof defaultExport === "object" &&
    !isCompiledSchema(defaultExport)
  ) {
    Object.assign(targets, defaultExport as Record<string, unknown>);
  }

  for (const [exportName, value] of Object.entries(targets)) {
    if (isCompiledSchema(value)) {
      schemas.push({ exportName, schema: (value as unknown as Record<string, unknown>)["schema"] });
    } else if (options?.autoDiscover && isZodSchema(value)) {
      schemas.push({ exportName, schema: value });
    }
  }

  return schemas;
}
