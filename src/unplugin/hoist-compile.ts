/**
 * Build-time compilation of hoisted schemas.
 *
 * After hoistZodSchemasMeta() lifts `z.object({...})` constructions to
 * module-scope `_zh_*` declarations, this step evaluates each hoisted
 * expression with the project's real zod module, runs the regular
 * extract → codegen pipeline on the resulting schema object, and hands the
 * transform a compiled IIFE to splice in as the declaration initializer:
 *
 *   const _zh_x = z.object({ id: z.number() });
 *     ⇣
 *   const _zh_x = /* @__PURE__ *\/ (() => { ... return __zcMkv(...); })();
 *
 * Eligibility is STRICTER than hoist eligibility. Hoisting only moves an
 * expression; compiling it bakes build-time evaluation results into
 * generated checks, so the construction must be deterministic:
 *
 * - Every EAGER free identifier must be a zod-package binding. Anything
 *   else (other imports: `getLimit()`, globals: `new Date()`,
 *   `Math.random()`) could evaluate differently at build time vs module
 *   load — those schemas stay plainly hoisted.
 * - DEFERRED references (inside refine/transform/default callbacks) are
 *   unrestricted: callbacks reach generated code via fn.toString() or stay
 *   on the runtime-constructed schema (`__rf` delegation), never via their
 *   build-time closure values. If extraction itself needs a deferred value
 *   it cannot have (z.lazy(() => ImportedChild)), evaluation throws and the
 *   schema falls back to a plain hoist.
 *
 * Every failure path is graceful: the declaration keeps its original zod
 * expression and runtime behavior is unchanged.
 */

import type { CodegenMode } from "#src/core/codegen/context.js";
import { generateValidator } from "#src/core/codegen/index.js";
import { extractSchema, type RefEntry } from "#src/core/extract/index.js";
import type { CompiledSchemaInfo } from "#src/core/pipeline.js";
import { loadModule } from "#src/loader.js";
import {
  analyzeHoistedExpression,
  collectImportBindings,
  type HoistedSchema,
  type ImportDetail,
} from "./hoist.js";

/** A hoisted declaration whose initializer can be replaced with a compiled IIFE. */
export interface CompiledHoistedSchema {
  /** The `_zh_*` declaration name. */
  name: string;
  /** Original construction expression text (becomes the IIFE's schema expression). */
  text: string;
  /** Compiled validator for the schema. */
  info: CompiledSchemaInfo;
}

/** Duck-type check mirroring discovery's isZodSchema. */
function isZodSchema(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    "_zod" in value &&
    typeof (value as { _zod: unknown })._zod === "object"
  );
}

/**
 * Evaluate a hoisted expression with its zod bindings and compile it.
 * Returns null when the schema is ineligible or anything fails.
 */
async function compileOne(
  schema: HoistedSchema,
  importDetails: Map<string, ImportDetail>,
  id: string,
  mode: CodegenMode,
  moduleCache: Map<string, Promise<Record<string, unknown>>>,
): Promise<CompiledHoistedSchema | null> {
  const analysis = analyzeHoistedExpression(schema.text);
  if (analysis === null) return null;

  // Determinism gate: eager evaluation may only touch zod bindings.
  const free = new Set([...analysis.eagerFree, ...analysis.deferredFree]);
  const bindings: Array<{ name: string; detail: ImportDetail }> = [];
  for (const name of analysis.eagerFree) {
    const detail = importDetails.get(name);
    if (!detail || !isZodSpecifier(detail.specifier)) return null;
  }
  // Inject every free import binding we can resolve (eager ones are all zod
  // by the gate above; deferred ones are best-effort — extraction only
  // dereferences them for build-time-invoked callbacks like z.lazy getters).
  for (const name of free) {
    const detail = importDetails.get(name);
    if (detail && isZodSpecifier(detail.specifier)) {
      bindings.push({ name, detail });
    } else if (analysis.eagerFree.has(name)) {
      return null;
    }
    // deferred non-zod names stay unbound: the evaluated closure would throw
    // if invoked at build time, which the try/catch below converts to a skip.
  }

  try {
    const values = await Promise.all(
      bindings.map(async ({ detail }) => {
        let loading = moduleCache.get(detail.specifier);
        if (!loading) {
          loading = loadModule(detail.specifier, id);
          moduleCache.set(detail.specifier, loading);
        }
        const mod = await loading;
        return detail.imported === "*" ? mod : mod[detail.imported];
      }),
    );

    const evaluate = new Function(
      ...bindings.map((b) => b.name),
      `"use strict"; return (${schema.text});`,
    );
    const value: unknown = evaluate(...values);
    if (!isZodSchema(value)) return null;

    const refEntries: RefEntry[] = [];
    const ir = extractSchema(value, refEntries);
    // A root fallback compiles to a pure delegation wrapper — strictly worse
    // than leaving the plain hoisted construction in place.
    if (ir.type === "fallback") return null;

    const codegenResult = generateValidator(ir, schema.name, { mode });
    return {
      name: schema.name,
      text: schema.text,
      info: { exportName: schema.name, codegenResult, refEntries },
    };
  } catch {
    return null;
  }
}

function isZodSpecifier(specifier: string): boolean {
  return (
    specifier === "zod" ||
    specifier === "zod/v4" ||
    specifier === "zod/mini" ||
    specifier === "zod/v4/mini"
  );
}

/**
 * Compile every eligible hoisted schema. Failures are silent per schema —
 * the caller leaves ineligible declarations as plain hoists.
 */
export async function compileHoistedSchemas(
  schemas: readonly HoistedSchema[],
  code: string,
  id: string,
  mode: CodegenMode,
): Promise<CompiledHoistedSchema[]> {
  const { details } = collectImportBindings(code);
  const moduleCache = new Map<string, Promise<Record<string, unknown>>>();
  const compiled: CompiledHoistedSchema[] = [];
  for (const schema of schemas) {
    const result = await compileOne(schema, details, id, mode, moduleCache);
    if (result !== null) compiled.push(result);
  }
  return compiled;
}
