import type {
  CodeGenResult,
  CodegenMode,
  ConstantKind,
  GeneratedConstant,
} from "./codegen/context.js";
import { createSharedSchemaPlan, SHARED_BLOCK_MARKER } from "./codegen/dedupe.js";
import { generateValidator } from "./codegen/index.js";
import { zodErrorClassOf, type ZodErrorClass } from "./extract/error-class.js";
import type { RefEntry } from "./extract/index.js";
import { extractSchema } from "./extract/index.js";
import type { DiscoveredSchema, SchemaIR } from "./types.js";

/** Result of compiling a single discovered schema through extract → generate pipeline. */
export interface CompiledSchemaInfo {
  exportName: string;
  codegenResult: CodeGenResult;
  refEntries: RefEntry[];
}

/** Module-scope declarations produced by file-level schema and constant dedup. */
export interface SharedSchemaBlock {
  /** Shared constants and `__zcSw_N` functions. Empty string when nothing repeats. */
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
  /**
   * Compact output (`output: "compact"`). Drop the compiled slow walk for
   * mutation-free, total-fast-path schemas and delegate their cold error path
   * to the retained Zod schema. Disables slow-walk sharing (delegated schemas
   * never emit a walk to share); delegated validators read the retained schema
   * through the `__zs` binding rather than through `__rf[]`.
   */
  compact?: boolean | undefined;
  /** When provided, per-schema failures call this and continue. Otherwise the first error throws. */
  onError?: (exportName: string, error: Error) => void;
}

/**
 * Occurrences of a generated identifier in `source`, ignoring the longer names
 * it is a prefix of — every generated name ends in `_<digits>`, so `__set_ks_1`
 * would otherwise count itself inside `__set_ks_10`.
 */
function referenceCount(source: string, name: string): number {
  let count = 0;
  for (let at = source.indexOf(name); at !== -1; at = source.indexOf(name, at + name.length)) {
    const next = source.charCodeAt(at + name.length);
    if (!(next >= 48 && next <= 57)) count += 1;
  }
  return count;
}

/**
 * Plan exact constant initializers used by at least two validators in this file.
 *
 * Names are assigned per kind (`__zcSet_0`, …) and ordered by initializer text,
 * so a given file always produces the same names for the same content.
 */
function planSharedConstants(
  results: readonly CompiledSchemaInfo[],
  constantsByResult: ReadonlyMap<CodeGenResult, readonly GeneratedConstant[]>,
): ReadonlyMap<string, string> {
  const byInitializer = new Map<string, { kind: ConstantKind; users: Set<CodeGenResult> }>();
  for (const { codegenResult } of results) {
    const source = `${codegenResult.code}\n${codegenResult.functionDef}`;
    for (const constant of constantsByResult.get(codegenResult) ?? []) {
      const declaration = `var ${constant.name}=${constant.initializer};`;
      // Fast-path generation can emit a constant before a later node aborts.
      // Its preamble is rolled back, so only collect declarations that survived.
      if (!source.includes(declaration)) continue;
      // A surviving declaration is not the same as a use. Two generators emit a
      // constant before they can decline — the build path names its FAIL
      // sentinel up front, and an abandoned fast-path walk leaves whatever it
      // declared behind — so a validator can hold a declaration it never reads.
      // Counting those as pool users hoisted constants nothing referenced, and
      // (worse) tripped the regeneration pass for a file that gained nothing by
      // it. Require the name to appear at least once beyond its own declaration.
      if (referenceCount(source, constant.name) < 2) continue;
      const entry = byInitializer.get(constant.initializer);
      if (entry === undefined) {
        byInitializer.set(constant.initializer, {
          kind: constant.kind,
          users: new Set([codegenResult]),
        });
      } else {
        entry.users.add(codegenResult);
      }
    }
  }

  const repeated = [...byInitializer.entries()]
    .filter(([, entry]) => entry.users.size >= 2)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

  const nextIndex = new Map<ConstantKind, number>();
  return new Map(
    repeated.map(([initializer, entry]) => {
      const index = nextIndex.get(entry.kind) ?? 0;
      nextIndex.set(entry.kind, index + 1);
      return [initializer, `__zc${entry.kind}_${index}`];
    }),
  );
}

function emitSharedConstants(sharedConstantNames: ReadonlyMap<string, string>): string {
  return [...sharedConstantNames]
    .map(([initializer, name]) => {
      // `/* @__PURE__ */` earns its bytes only on a constructor call, where it
      // tells a bundler the declaration is droppable when nothing reads it. On a
      // plain object literal it is inert, and the annotation is longer than the
      // initializer it annotates.
      const pure = initializer.startsWith("new ") ? "/* @__PURE__ */" : "";
      return `var ${name}=${pure}${initializer};`;
    })
    .join("\n");
}

/**
 * Run the extract → generate pipeline for each discovered schema.
 * Shared by CLI generate and unplugin transform.
 *
 * Pass 1 extracts every schema's IR and plans repeated slow walks. Pass 2
 * generates each validator, calling shared `__zcSw_N` functions instead of
 * re-inlining them. Exact constant initializers reported during generation are
 * then pooled when at least two validators use them. Files with no repetition
 * keep their original local declarations.
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
    errorClass: ZodErrorClass;
  }> = [];
  for (const s of schemas) {
    try {
      const refEntries: RefEntry[] = [];
      const ir = extractSchema(s.schema, refEntries);
      extracted.push({
        exportName: s.exportName,
        schema: s.schema,
        ir,
        refEntries,
        // Read off the schema object, whose methods the validator replaces;
        // the IR is the same for classic and mini.
        errorClass: zodErrorClassOf(s.schema),
      });
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

  // Pass 2: generate each validator, sharing repeated slow walks via the plan
  // and observing which constant declarations survive codegen rollback.
  const generated: Array<{
    exportName: string;
    schema: unknown;
    ir: SchemaIR;
    refEntries: RefEntry[];
    errorClass: ZodErrorClass;
    codegenResult: CodeGenResult;
  }> = [];
  const constantsByResult = new Map<CodeGenResult, GeneratedConstant[]>();
  for (const e of extracted) {
    try {
      const constants = new Map<string, GeneratedConstant>();
      const codegenResult = generateValidator(e.ir, e.exportName, {
        refCount: e.refEntries.length,
        mode: options.mode,
        sharedSchemas: plan,
        compact: options.compact,
        errorClass: e.errorClass,
        onConstant(constant) {
          constants.set(constant.name, constant);
        },
      });
      constantsByResult.set(codegenResult, [...constants.values()]);
      generated.push({
        exportName: e.exportName,
        schema: e.schema,
        ir: e.ir,
        refEntries: e.refEntries,
        errorClass: e.errorClass,
        codegenResult,
      });
    } catch (err) {
      handle(e.exportName, err);
    }
  }

  const initialResults = generated.map(
    ({ exportName, codegenResult, refEntries }): CompiledSchemaInfo => ({
      exportName,
      codegenResult,
      refEntries,
    }),
  );
  const sharedConstantNames = planSharedConstants(initialResults, constantsByResult);

  // Regenerate only when sharing is profitable. Selecting shared names before
  // emission avoids textual rewriting of generated JavaScript, where a user
  // enum string can legally contain text resembling a generated identifier.
  if (sharedConstantNames.size > 0) {
    for (const entry of generated) {
      entry.codegenResult = generateValidator(entry.ir, entry.exportName, {
        refCount: entry.refEntries.length,
        mode: options.mode,
        sharedSchemas: plan,
        compact: options.compact,
        errorClass: entry.errorClass,
        sharedConstantNames,
      });
    }
  }

  const results: CompiledSchemaInfo[] = generated.map((entry) => ({
    exportName: entry.exportName,
    codegenResult: entry.codegenResult,
    refEntries: entry.refEntries,
  }));

  const sharedConstantCode = emitSharedConstants(sharedConstantNames);
  const slowWalkCode = plan?.code ?? "";
  const sharedCode =
    sharedConstantCode === ""
      ? slowWalkCode
      : slowWalkCode === ""
        ? `${SHARED_BLOCK_MARKER}\n${sharedConstantCode}`
        : `${slowWalkCode}\n${sharedConstantCode}`;

  return {
    schemas: results,
    shared: { code: sharedCode, usedHelpers: plan?.usedHelpers ?? new Set() },
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
