import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { compileSchemas } from "../../core/pipeline.js";
import type { DiscoveredSchema } from "../../core/types.js";
import { discoverSchemas } from "../../discovery.js";
import { mayExportSchemas } from "../../static-filter.js";
import { generateCompiledFileContent, resolveOutputPath, writeCompiledFile } from "../emitter.js";
import { getErrorMessage } from "../errors.js";
import { logger } from "../logger.js";

export interface GenerateOptions {
  inputs: string[];
  output: string | undefined;
  zodCompat?: boolean | undefined;
  compact?: boolean | undefined;
  autoDiscover?: boolean | undefined;
  stripUnknownKeys?: boolean | undefined;
}

export interface GenerateFileResult {
  filePath: string;
  outputPath: string;
  schemaCount: number;
  schemaNames: string[];
}

/**
 * Check if a filename is a schema file candidate.
 * Shared filter logic used by both findSchemaFiles and isWatchTarget.
 */
export function isSchemaFile(fileName: string): boolean {
  return (
    /\.(?:ts|mts|js|mjs)$/.test(fileName) &&
    !fileName.endsWith(".compiled.ts") &&
    !fileName.endsWith(".compiled.js") &&
    !fileName.endsWith(".test.ts") &&
    !fileName.endsWith(".test.js") &&
    !fileName.endsWith(".d.ts")
  );
}

/**
 * Resolve input paths to a list of source files.
 * If a path is a directory, find all .ts files (excluding .compiled.ts, .test.ts, node_modules).
 */
export async function resolveInputFiles(inputs: string[]): Promise<string[]> {
  const files: string[] = [];

  for (const input of inputs) {
    const absPath = path.resolve(input);
    const stat = await fs.promises.stat(absPath).catch(() => null);

    if (!stat) {
      logger.error(`File not found: ${input}`);
      process.exit(1);
    }

    if (stat.isDirectory()) {
      const found = await findSchemaFiles(absPath);
      files.push(...found);
    } else {
      files.push(absPath);
    }
  }

  return files;
}

export async function findSchemaFiles(dir: string): Promise<string[]> {
  const results: string[] = [];
  const entries = await fs.promises.readdir(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "dist" || entry.name.startsWith(".")) {
        continue;
      }
      const nested = await findSchemaFiles(fullPath);
      results.push(...nested);
    } else if (entry.isFile() && isSchemaFile(entry.name)) {
      results.push(fullPath);
    }
  }

  return results;
}

/**
 * Generate compiled output for a single source file.
 * Returns null if no compile() calls are found.
 */
export async function generateFile(
  filePath: string,
  outputFlag: string | undefined,
  options?: {
    zodCompat?: boolean | undefined;
    compact?: boolean | undefined;
    autoDiscover?: boolean | undefined;
    stripUnknownKeys?: boolean | undefined;
  },
): Promise<GenerateFileResult | null> {
  const relPath = path.relative(process.cwd(), filePath);

  // Static pre-filter: skip files whose exports provably cannot be schemas
  // without executing them. Unreadable files fall through to discovery,
  // which produces the proper error.
  const source = await fs.promises.readFile(filePath, "utf8").catch(() => null);
  if (source !== null && !(await mayExportSchemas(source, filePath))) {
    return null;
  }

  let schemas: DiscoveredSchema[];
  try {
    schemas = await discoverSchemas(filePath, {
      autoDiscover: options?.autoDiscover,
    });
  } catch (err) {
    throw new Error(`Failed to load ${relPath}: ${getErrorMessage(err)}`);
  }

  if (schemas.length === 0) {
    return null;
  }

  const { schemas: codegenResults, shared } = compileSchemas(schemas, {
    mode: "inline",
    stripUnknownKeys: options?.stripUnknownKeys,
    compact: options?.compact,
  });

  const outputPath = resolveOutputPath(filePath, outputFlag);
  const sourceRelPath = path.relative(path.dirname(outputPath), filePath);
  const content = generateCompiledFileContent(codegenResults, sourceRelPath, {
    zodCompat: options?.zodCompat,
    sharedCode: shared.code,
  });

  await writeCompiledFile(outputPath, content);

  return {
    filePath,
    outputPath,
    schemaCount: schemas.length,
    schemaNames: schemas.map((s) => s.exportName),
  };
}

export async function runGenerate(options: GenerateOptions): Promise<void> {
  const files = await resolveInputFiles(options.inputs);

  if (files.length === 0) {
    logger.warn("No source files found.");
    return;
  }

  let totalSchemas = 0;
  let totalFiles = 0;

  for (const filePath of files) {
    let result: GenerateFileResult | null;
    try {
      result = await generateFile(filePath, options.output, {
        zodCompat: options.zodCompat,
        compact: options.compact,
        autoDiscover: options.autoDiscover,
        stripUnknownKeys: options.stripUnknownKeys,
      });
    } catch (err) {
      logger.error(getErrorMessage(err));
      process.exit(1);
    }

    if (!result) continue;

    const relPath = path.relative(process.cwd(), result.filePath);
    const outputRelPath = path.relative(process.cwd(), result.outputPath);
    logger.success(`${relPath} -> ${outputRelPath} (${result.schemaNames.join(", ")})`);

    totalSchemas += result.schemaCount;
    totalFiles++;
  }

  if (totalFiles === 0) {
    if (options.autoDiscover) {
      logger.warn("No Zod schemas exported from any source file.");
    } else {
      logger.warn(
        "No compile() calls found in any source file. Use --schemas auto to scan plain Zod exports.",
      );
    }
  } else {
    logger.info(
      `Generated ${totalSchemas} schema${totalSchemas > 1 ? "s" : ""} from ${totalFiles} file${totalFiles > 1 ? "s" : ""}.`,
    );
  }
}
