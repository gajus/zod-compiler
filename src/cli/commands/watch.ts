import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { invalidateModuleCache } from "#src/loader.js";
import { getErrorMessage } from "../errors.js";
import { logger } from "../logger.js";
import {
  type GenerateFileResult,
  generateFile,
  isSchemaFile,
  resolveInputFiles,
} from "./generate.js";

interface WatchOptions {
  inputs: string[];
  output: string | undefined;
  zodCompat?: boolean | undefined;
  autoDiscover?: boolean | undefined;
}

/** Dependencies for runWatch, injectable for testing. */
export interface WatchDeps {
  createWatcher: (
    dir: string,
    options: { recursive: boolean; signal: AbortSignal },
    callback: (event: string, filename: string | null) => void,
  ) => fs.FSWatcher;
}

const defaultWatchDeps: WatchDeps = {
  createWatcher: (dir, options, callback) => fs.watch(dir, options, callback),
};

/**
 * Check if a file path should trigger regeneration.
 */
export function isWatchTarget(filePath: string): boolean {
  if (filePath.split(path.sep).includes("node_modules")) return false;
  return isSchemaFile(filePath);
}

/**
 * Resolve which directories to watch from input paths.
 * Files are mapped to their parent directory; subdirectories are deduplicated.
 */
export function resolveWatchDirs(inputs: string[]): string[] {
  const dirs: string[] = [];

  for (const input of inputs) {
    const abs = path.resolve(input);
    try {
      const stat = fs.statSync(abs);
      dirs.push(stat.isDirectory() ? abs : path.dirname(abs));
    } catch {
      dirs.push(path.dirname(abs));
    }
  }

  // Deduplicate: remove dirs that are subdirectories of another watched dir
  const sorted = [...new Set(dirs)].sort();
  const result: string[] = [];
  for (const dir of sorted) {
    const isSubdir = result.some((parent) => dir.startsWith(parent + path.sep));
    if (!isSubdir) {
      result.push(dir);
    }
  }

  return result;
}

/**
 * Create a debounced version of a function.
 */
export function debounce<T extends (...args: never[]) => void>(fn: T, delayMs: number): T {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return ((...args: Parameters<T>) => {
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      fn(...args);
    }, delayMs);
  }) as T;
}

/**
 * Run the watch mode: initial generate + fs.watch for changes.
 */
export async function runWatch(
  options: WatchOptions,
  deps: WatchDeps = defaultWatchDeps,
): Promise<void> {
  const files = await resolveInputFiles(options.inputs);

  if (files.length === 0) {
    logger.warn("No source files found.");
    return;
  }

  // Initial generation
  let totalSchemas = 0;
  let totalFiles = 0;

  for (const filePath of files) {
    try {
      const result = await generateFile(filePath, options.output, {
        zodCompat: options.zodCompat,
        autoDiscover: options.autoDiscover,
      });
      if (result) {
        logResult(result);
        totalSchemas += result.schemaCount;
        totalFiles++;
      }
    } catch (err) {
      logger.error(getErrorMessage(err));
    }
  }

  if (totalFiles > 0) {
    logger.info(
      `Generated ${totalSchemas} schema${totalSchemas > 1 ? "s" : ""} from ${totalFiles} file${totalFiles > 1 ? "s" : ""}.`,
    );
  } else if (options.autoDiscover) {
    logger.warn("No Zod schemas exported from any source file.");
  } else {
    logger.warn(
      "No compile() calls found in any source file. Use --auto-discover to scan plain Zod exports.",
    );
  }

  // Set up file watching
  const watchDirs = resolveWatchDirs(options.inputs);
  const ac = new AbortController();

  const pendingFiles = new Set<string>();

  const flush = debounce(async () => {
    const batch = [...pendingFiles];
    pendingFiles.clear();

    // Changed files (and any project files importing them) must re-execute;
    // node_modules stay warm in the shared loader cache.
    invalidateModuleCache();

    for (const filePath of batch) {
      try {
        const result = await generateFile(filePath, options.output, {
          zodCompat: options.zodCompat,
          autoDiscover: options.autoDiscover,
        });
        if (result) {
          logResult(result);
        }
      } catch (err) {
        logger.error(getErrorMessage(err));
      }
    }
  }, 150);

  const watchers: fs.FSWatcher[] = [];

  for (const dir of watchDirs) {
    try {
      const watcher = deps.createWatcher(
        dir,
        { recursive: true, signal: ac.signal },
        (_event, filename) => {
          if (!filename) return;
          const fullPath = path.resolve(dir, filename);
          if (isWatchTarget(fullPath)) {
            pendingFiles.add(fullPath);
            void flush();
          }
        },
      );
      watchers.push(watcher);
    } catch (err) {
      logger.error(`Failed to watch ${dir}: ${getErrorMessage(err)}`);
    }
  }

  if (watchers.length === 0) {
    logger.error("No directories could be watched.");
    return;
  }

  logger.info(
    `Watching ${watchDirs.length} director${watchDirs.length > 1 ? "ies" : "y"} for changes... (Ctrl+C to stop)`,
  );

  // Graceful shutdown
  const shutdown = () => {
    logger.dim("\nStopping watch mode...");
    ac.abort();
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // Keep process alive until aborted
  await new Promise<void>((resolve) => {
    ac.signal.addEventListener(
      "abort",
      () => {
        process.removeListener("SIGINT", shutdown);
        process.removeListener("SIGTERM", shutdown);
        resolve();
      },
      { once: true },
    );
  });
}

function logResult(result: GenerateFileResult): void {
  const relPath = path.relative(process.cwd(), result.filePath);
  const outputRelPath = path.relative(process.cwd(), result.outputPath);
  logger.success(`${relPath} -> ${outputRelPath} (${result.schemaNames.join(", ")})`);
}
