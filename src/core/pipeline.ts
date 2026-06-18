import type { CodeGenResult, CodegenMode } from "./codegen/context.js";
import { createSharedSchemaPlan } from "./codegen/dedupe.js";
import { generateValidator } from "./codegen/index.js";
import type { RefEntry } from "./extract/index.js";
import { extractSchema } from "./extract/index.js";
import type { DiscoveredSchema, SchemaIR } from "./types.js";

/** Result of compiling a single discovered schema through extract → generate pipeline. */
export interface CompiledSchemaInfo {
  exportName: string;
  codegenResult: CodeGenResult;
  refEntries: RefEntry[];
}

/** Module-scope shared-validator declarations produced by file-level dedup. */
export interface SharedSchemaBlock {
  /** Shared `__zcSw_N` functions + their preamble. Empty string when nothing repeated. */
  code: string;
  /** Runtime helper names referenced by the shared block (lean mode imports). */
  usedHelpers: Set<string>;
}

/** Output of {@link compileSchemas}: per-schema validators plus the file's shared block. */
export interface CompileSchemasResult {
  schemas: CompiledSchemaInfo[];
  shared: SharedSchemaBlock;
}

export interface CompileSchemasOptions {
  /** "inline" for CLI .compiled.ts; "lean" for unplugin (imports from virtual:zod-compiler/runtime). */
  mode: CodegenMode;
  /** Strip unknown keys from z.object() output, matching zod's default .parse(). */
  stripUnknownKeys?: boolean | undefined;
  /**
   * Compact output (`output: "compact"`). Drop the compiled slow walk for
   * mutation-free, total-fast-path schemas and delegate their cold error path
   * to the retained Zod schema. Disables slow-walk sharing (delegated schemas
   * never emit a walk to share) and appends a root self-RefEntry per delegated
   * schema so `__rf[N]` resolves to the original Zod schema.
   */
  compact?: boolean | undefined;
  /** When provided, per-schema failures call this and continue. Otherwise the first error throws. */
  onError?: (exportName: string, error: Error) => void;
}

/**
 * Run the extract → generate pipeline for each discovered schema.
 * Shared by CLI generate and unplugin transform.
 *
 * Two passes so structurally repeated schemas can be deduplicated: pass 1
 * extracts every schema's IR, then a file-level plan hoists the slow walk of
 * any shape that recurs across schemas into a shared `__zcSw_N` function; pass
 * 2 generates each validator, calling the shared walk instead of re-inlining
 * it. Files with no repetition take the same path and produce identical output
 * to single-pass codegen (the plan is empty), paying only one linear analysis.
 */
export function compileSchemas(
  schemas: DiscoveredSchema[],
  options: CompileSchemasOptions,
): CompileSchemasResult {
  const handle = (exportName: string, err: unknown): void => {
    if (options.onError) {
      options.onError(exportName, err instanceof Error ? err : new Error(String(err)));
    } else {
      throw err;
    }
  };

  // Pass 1: extract IR (and fallback refs) for every schema.
  const extracted: Array<{
    exportName: string;
    schema: unknown;
    ir: SchemaIR;
    refEntries: RefEntry[];
  }> = [];
  for (const s of schemas) {
    try {
      const refEntries: RefEntry[] = [];
      const ir = extractSchema(s.schema, refEntries, {
        stripUnknownKeys: options.stripUnknownKeys,
      });
      extracted.push({ exportName: s.exportName, schema: s.schema, ir, refEntries });
    } catch (err) {
      handle(s.exportName, err);
    }
  }

  // Compact mode delegates the cold error path of total-fast-path schemas to
  // zod, so they emit no slow walk to share — skip the plan (and the dead
  // shared functions it would generate for shapes that now only delegate).
  const plan = options.compact
    ? undefined
    : createSharedSchemaPlan(
        extracted.map((e) => e.ir),
        options.mode,
      );

  // Pass 2: generate each validator, sharing repeated slow walks via the plan.
  const results: CompiledSchemaInfo[] = [];
  for (const e of extracted) {
    try {
      const codegenResult = generateValidator(e.ir, e.exportName, {
        refCount: e.refEntries.length,
        mode: options.mode,
        sharedSchemas: plan,
        compact: options.compact,
      });
      // Compact delegation appends the schema itself as a fresh root RefEntry
      // (accessPath "" → __rf[N] = the original Zod schema, whose pristine
      // safeParse the validator delegates to). The index was reserved as
      // e.refEntries.length above, so this push lands exactly at it.
      if (codegenResult.rootDelegateRefIndex !== undefined) {
        e.refEntries.push({ schema: e.schema, accessPath: "" });
      }
      results.push({ exportName: e.exportName, codegenResult, refEntries: e.refEntries });
    } catch (err) {
      handle(e.exportName, err);
    }
  }

  return {
    schemas: results,
    shared: { code: plan?.code ?? "", usedHelpers: plan?.usedHelpers ?? new Set() },
  };
}

/**
 * Aggregate `usedHelpers` across multiple compiled schemas (typically all schemas in one file).
 * Used by the unplugin transform to construct a single import statement per file.
 */
export function aggregateUsedHelpers(schemas: CompiledSchemaInfo[]): Set<string> {
  const all = new Set<string>();
  for (const s of schemas) {
    for (const h of s.codegenResult.usedHelpers) all.add(h);
  }
  return all;
}
