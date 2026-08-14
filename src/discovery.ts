import { isCompiledSchema } from "./core/compile.js";
import type { DiscoveredSchema } from "./core/types.js";
import { isZodSchema } from "./is-zod-schema.js";
import { loadSourceFile } from "./loader.js";

export interface DiscoverOptions {
  /** Auto-detect all exported Zod schemas without requiring compile() wrappers. */
  autoDiscover?: boolean | undefined;
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
    try {
      Object.assign(targets, defaultExport as Record<string, unknown>);
    } catch {
      // A default export that resists enumeration — a Proxy trapping `ownKeys`,
      // a getter that throws — is not a bag of schemas. The named exports of
      // this file still stand on their own.
    }
  }

  for (const [exportName, value] of Object.entries(targets)) {
    // Probing touches values the user never offered as candidates, and a Proxy
    // can answer `has` with true and then throw from `get` (an ORM model, an
    // i18n catch-all). Skipping that one export keeps the rest of the file's
    // schemas compiling, where letting it escape fails the whole build.
    try {
      if (isCompiledSchema(value)) {
        schemas.push({
          exportName,
          schema: (value as unknown as Record<string, unknown>)["schema"],
        });
      } else if (options?.autoDiscover && isZodSchema(value)) {
        schemas.push({ exportName, schema: value });
      }
    } catch {
      // Not a schema; leave it alone.
    }
  }

  return schemas;
}
