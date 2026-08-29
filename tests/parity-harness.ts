/**
 * Shared differential-parity harness: compiles a schema through the real
 * extract → codegen pipeline with a production-equivalent __zcFin (Zod locale
 * wired, mirroring ZOD_MSG_DECLARATION) and compares against Zod itself.
 */
import { expect } from "vite-plus/test";
import { ZodRealError, z, core } from "zod";
import { generateValidator } from "#src/core/codegen/index.js";
import { RETAINED_SCHEMA_VAR } from "#src/core/codegen/context.js";
import type { ExtractOptions, RefEntry } from "#src/core/extract/index.js";
import { extractSchema } from "#src/core/extract/index.js";
import {
  FAIL_CLASS_DECL,
  FAILZ_CLASS_DECL,
  FIN_DECL,
  FIN_DEFERRED_DECL,
  FINZ_DECL,
  ZOD_CONFIG_IMPORT,
  ZOD_MSG_DECLARATION,
} from "#src/core/iife.js";
import type { SafeParseResult } from "#src/core/types.js";
import { RESOLVED_RUNTIME_ID, loadVirtual } from "#src/unplugin/virtual.js";

/**
 * `__zcMsg` built from the SAME declaration production emits, not a stand-in:
 * it resolves `config.customError`/`config.localeError` per call, so a harness
 * that passed a snapshotted `localeError` would silently exercise neither.
 * Since zod 4.5 the snapshot is also plain empty: the English locale is
 * installed on the first schema construction, not at import, so a module-scope
 * `z.config().localeError` reads `undefined` and every compiled issue loses its
 * message. Every harness that hands the finalizer a `__zcMsg` uses this one.
 */
export const zcMsg = new Function("__zodCompilerConfig", `${ZOD_MSG_DECLARATION}return __zcMsg;`)(
  z.config,
) as (issue: unknown) => string;

const localizedFin = new Function(
  "__zcMsg",
  "__zcZodError",
  `${FAIL_CLASS_DECL}${FIN_DECL}; return __zcFin;`,
)(zcMsg, ZodRealError);

const finZ = new Function(`${FAILZ_CLASS_DECL}${FINZ_DECL}; return __zcFinZ;`)() as (
  rfp: (input: unknown) => SafeParseResult<unknown>,
  receiver: unknown,
  input: unknown,
) => SafeParseResult<unknown>;

export interface ZodLikeSchema {
  safeParse: (input: unknown) => {
    success: boolean;
    data?: unknown;
    error?: { issues: { message: string }[]; message: string };
  };
}

export function compileLikeProduction(
  schema: unknown,
  name = "parity",
  extractOptions?: ExtractOptions,
  options?: { compact?: boolean },
): (input: unknown) => SafeParseResult<unknown> {
  const refEntries: RefEntry[] = [];
  const ir = extractSchema(schema, refEntries, extractOptions);
  const generated = generateValidator(ir, name, {
    refCount: refEntries.length,
    compact: options?.compact,
  });
  const rf = refEntries.map((e) => e.schema);
  const factory = new Function(
    "__zodCompilerConfig",
    "__zcZodError",
    "__zcCore",
    "__zcFin",
    "__zcFinZ",
    "__rf",
    // Compact delegation reads the retained schema through this binding, which
    // generateIIFE emits per export (the pipeline does not route it through
    // `__rf`); bind it here so the generated code sees what production sees.
    RETAINED_SCHEMA_VAR,
    // Strict, like the ES module the generated code ships inside: an
    // assignment to an undeclared identifier must fail here, not in the bundle.
    `"use strict";${ZOD_MSG_DECLARATION}${FAIL_CLASS_DECL}${FIN_DEFERRED_DECL}\n${generated.code}\nreturn ${generated.functionDef};`,
  );
  return factory(z.config, ZodRealError, core, localizedFin, finZ, rf, schema) as (
    input: unknown,
  ) => SafeParseResult<unknown>;
}

/**
 * Lean-mode (unplugin) counterpart of {@link compileLikeProduction}. There the
 * generated code does not inline issue objects at each site — it CALLS the
 * factories hosted in "virtual:zod-compiler/runtime", so an issue's shape lives
 * in two places at once and the two can drift.
 *
 * The helper bodies come from the real virtual module source rather than a
 * transcription: `loadVirtual` is the same function the bundler plugins call,
 * with the `import` line and the `export` keywords stripped so the module body
 * can be evaluated as a function body. An inline emit and its lean helper that
 * disagree about an issue's fields therefore cannot both pass.
 */
export function compileLeanLikeProduction(
  schema: unknown,
  name = "leanParity",
): (input: unknown) => SafeParseResult<unknown> {
  const refEntries: RefEntry[] = [];
  const ir = extractSchema(schema, refEntries);
  const generated = generateValidator(ir, name, {
    refCount: refEntries.length,
    mode: "lean",
  });
  const runtime = (loadVirtual(RESOLVED_RUNTIME_ID) ?? "")
    .replace(ZOD_CONFIG_IMPORT, "")
    .replaceAll(/^export /gm, "");
  const factory = new Function(
    "__zodCompilerConfig",
    "__zcCore",
    "__zcZodError",
    "__rf",
    `"use strict";${runtime}\n${generated.code}\nreturn ${generated.functionDef};`,
  );
  return factory(
    z.config,
    core,
    ZodRealError,
    refEntries.map((e) => e.schema),
  ) as (input: unknown) => SafeParseResult<unknown>;
}

/** JSON.stringify that survives BigInt, symbols, and other non-serializable inputs. */
function describeInput(input: unknown): string {
  try {
    return (
      JSON.stringify(input, (_k, v) =>
        typeof v === "bigint" ? `${v}n` : typeof v === "symbol" ? String(v) : v,
      ) ?? String(input)
    );
  } catch {
    return String(input);
  }
}

/** `code@path` for one issue, with the segments rendered so symbols survive. */
function issueSignature(issue: { code?: string; path?: unknown[] }): string {
  const path = (issue.path ?? []).map((seg) => (typeof seg === "symbol" ? String(seg) : seg));
  return `${issue.code}@${JSON.stringify(path, (_k, v) => (typeof v === "bigint" ? `${v}n` : v))}`;
}

/**
 * Render one value inside an issue into something `toStrictEqual` can compare
 * without erasing anything that distinguishes two issues.
 *
 * Rebuilds objects key by key instead of picking fields, so KEY PRESENCE is
 * part of the result: a key one side omits and the other emits — even holding
 * `undefined` — produces a different rendering. `Reflect.ownKeys` rather than
 * `Object.keys` for the same reason, since a non-enumerable or symbol key is
 * still an own key that `Object.keys`-based diffing would drop.
 *
 * The scalar cases exist because `toStrictEqual`'s diff cannot render them (or
 * renders two different values identically):
 *   - symbols and bigints: legal `path` segments and `values` members;
 *   - functions: reachable through a custom issue's `params`;
 *   - RegExp: zod reports SOME patterns as a RegExp object (`z.string().regex()`,
 *     `z.string().base64url()`) and OTHERS as a source string, and the two are
 *     observably different to an error map — so the RegExp form is tagged rather
 *     than flattened to its source, which would make `/src/` and `src` compare
 *     equal and hide exactly the bug this file exists to catch;
 *   - Date: `minimum`/`maximum` on a date range issue, whose own-key walk would
 *     otherwise be the empty object for every instant.
 *
 * `seen` is per-path (added on the way down, removed on the way up), so a
 * repeated sibling reference still renders in full while a true cycle stops at
 * `[circular]` rather than overflowing the stack. That matters because the
 * failure mode it guards is real: an issue carrying an `input` key holding the
 * input itself is one self-reference away from being uncomparable.
 */
function renderIssueValue(value: unknown, seen: Set<object>): unknown {
  if (typeof value === "bigint") return `[bigint ${value}]`;
  if (typeof value === "symbol") return `[symbol ${String(value)}]`;
  if (typeof value === "function") return `[function ${value.name || "anonymous"}]`;
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return "[circular]";
  if (value instanceof RegExp) return `[RegExp /${value.source}/${value.flags}]`;
  if (value instanceof Date) {
    return `[Date ${Number.isNaN(value.getTime()) ? "Invalid Date" : value.toISOString()}]`;
  }
  seen.add(value);
  try {
    if (Array.isArray(value)) return value.map((entry) => renderIssueValue(entry, seen));
    const rendered: Record<string, unknown> = {};
    for (const key of Reflect.ownKeys(value)) {
      const label = typeof key === "symbol" ? `[symbol ${String(key)}]` : key;
      rendered[label] = renderIssueValue((value as Record<PropertyKey, unknown>)[key], seen);
    }
    // A class instance and a plain object with the same fields are different
    // things; keep the constructor visible so one cannot pass for the other.
    const proto: unknown = Object.getPrototypeOf(value);
    if (proto !== Object.prototype) {
      rendered["[[class]]"] = proto === null ? "null-prototype" : value.constructor?.name;
    }
    return rendered;
  } finally {
    seen.delete(value);
  }
}

/** One issue rendered whole — every own key, recursively — for strict comparison. */
function renderIssue(issue: unknown): unknown {
  return renderIssueValue(issue, new Set());
}

/**
 * Assert compiled accept/reject, output data, and the whole ISSUE LIST match Zod
 * for every input. Schemas that throw synchronously (async refinements, function
 * schemas) must throw identically on both sides.
 *
 * The issue list is compared as `code@path` per issue, in order, plus the first
 * message. Comparing only that first message — as this harness once did — is
 * blind to a dropped issue, an extra one, and to every path segment: three
 * shipped bugs (set elements getting an invented index, map entries addressed by
 * position instead of by key, an outer refine suppressed by a field's own failed
 * check) all passed a green suite because nothing here looked at paths.
 *
 * `code@path` plus one message is still only three fields of an issue, and an
 * issue is public API — error maps read it, and consumers destructure it. Every
 * OTHER field was invisible here until a hand sweep turned up six divergences a
 * fully green suite could not see, all of them shipped:
 *
 *   - `too_small`/`too_big` on a size-checked collection missing `origin`;
 *   - a tuple's under-length `too_small` carrying an INVENTED `inclusive`, which
 *     zod's under-length branch does not set at all;
 *   - `z.stringbool()`'s `invalid_value` missing `expected: "stringbool"`;
 *   - a custom string format reporting `pattern` as the RegExp's `toString()`
 *     (`/src/`) where zod reports the bare `source` (`src`);
 *   - a discriminated union inventing an `options` key on its `invalid_union`;
 *   - `input` left on a finalized issue, which zod `delete`s — so every compiled
 *     issue was one key wider than zod's.
 *
 * None of those changes a code, a path, or the first message. So the issue list
 * is ALSO compared whole: each issue rebuilt key by key, recursively (through a
 * union's `errors` and an invalid_key/invalid_element wrapper's `issues`), with
 * key presence significant in both directions — see {@link renderIssueValue}.
 * The code+path and first-message assertions are kept ahead of it because they
 * name the failure in one line; the whole-shape assertion is the one that is
 * actually complete.
 *
 * Two things stay out of reach, and both are pinned in
 * tests/known-divergences.test.ts rather than papered over here:
 *
 *   - `inst`, the live $ZodType that raised an issue. zod deletes it during
 *     finalization, so it never appears on either side of this comparison — but
 *     where it survives into user-visible API (`z.catch()`'s raw `ctx.issues`)
 *     the compiler has no counterpart to offer.
 *   - WHEN the error is built. zod builds it inside safeParse; a compiled
 *     failure defers it to the `.error` accessor. The comparison below forces
 *     that accessor before judging throw parity, so the two sides are compared
 *     doing the same work; the timing itself still differs.
 */
export function expectParity(
  schema: ZodLikeSchema,
  inputs: unknown[],
  name?: string,
  extractOptions?: ExtractOptions,
  options?: { compact?: boolean },
): void {
  expectCompiledParity(
    compileLikeProduction(schema, name, extractOptions, options),
    schema,
    inputs,
  );
}

/**
 * {@link expectParity} against the LEAN build — the same schema, the same
 * inputs, but with every issue produced by the virtual runtime module's
 * factories instead of an inline object literal. See
 * {@link compileLeanLikeProduction}; the two emit paths agree only if both pass.
 */
export function expectLeanParity(schema: ZodLikeSchema, inputs: unknown[], name?: string): void {
  expectCompiledParity(compileLeanLikeProduction(schema, name), schema, inputs);
}

function expectCompiledParity(
  compiled: (input: unknown) => SafeParseResult<unknown>,
  schema: ZodLikeSchema,
  inputs: unknown[],
): void {
  for (const input of inputs) {
    let zodResult: ReturnType<ZodLikeSchema["safeParse"]> | undefined;
    let zodThrew: string | undefined;
    try {
      zodResult = schema.safeParse(input);
    } catch (e) {
      zodThrew = e instanceof Error ? e.constructor.name : "unknown";
    }
    // oxlint-disable-next-line typescript/no-redundant-type-constituents -- false positive: SafeParseSuccess<unknown> is not a top type
    let compiledResult: SafeParseResult<unknown> | undefined;
    let compiledThrew: string | undefined;
    try {
      compiledResult = compiled(input);
      // A compiled FAILURE defers the whole issue walk — locale message build
      // included — into the cached `.error` accessor (see FAIL_CLASS_DECL), so
      // work zod does inside safeParse happens here instead. Touching `.error`
      // makes throw parity compare like with like: a schema whose message
      // cannot be built (z.literal(Symbol()), whose locale stringifies the
      // symbol) throws on both sides rather than only on zod's. The timing
      // difference that remains is pinned in known-divergences.test.ts.
      if (!compiledResult.success) void compiledResult.error;
    } catch (e) {
      compiledThrew = e instanceof Error ? e.constructor.name : "unknown";
    }

    expect(compiledThrew, `throw parity for ${describeInput(input)}`).toBe(zodThrew);
    if (zodThrew !== undefined || !zodResult || !compiledResult) continue;

    expect(compiledResult.success, `accept/reject for ${describeInput(input)}`).toBe(
      zodResult.success,
    );
    if (zodResult.success && compiledResult.success) {
      if (typeof zodResult.data === "function") {
        // Function schemas return a fresh wrapper per parse — identity differs.
        expect(typeof compiledResult.data, `output kind for ${describeInput(input)}`).toBe(
          "function",
        );
      } else {
        expect(compiledResult.data, `output data for ${describeInput(input)}`).toEqual(
          zodResult.data,
        );
      }
    }
    if (!zodResult.success && !compiledResult.success) {
      const zodIssues = (zodResult.error?.issues ?? []) as { code?: string; path?: unknown[] }[];
      const compiledIssues = compiledResult.error.issues as { code?: string; path?: unknown[] }[];
      expect(
        compiledIssues.map(issueSignature),
        `issue codes+paths for ${describeInput(input)}`,
      ).toStrictEqual(zodIssues.map(issueSignature));

      const zodMessage = zodResult.error?.issues[0]?.message;
      const compiledMessage = (compiledResult.error.issues[0] as { message?: string })?.message;
      expect(compiledMessage, `message for ${describeInput(input)}`).toBe(zodMessage);

      expect(
        compiledIssues.map(renderIssue),
        `full issue shape for ${describeInput(input)}`,
      ).toStrictEqual(zodIssues.map(renderIssue));

      // ...and finally the error's own `message`, which is the ONE assertion
      // above that is sensitive to KEY ORDER. `ZodError`'s message is
      // `JSON.stringify(issues, …, 2)`, so the order each issue's keys were
      // inserted in is printed text — and `toStrictEqual` above compares objects
      // key-order-insensitively, so a compiled issue carrying exactly the right
      // fields in a different order passed everything else while rendering a
      // different error than zod for essentially every failure. zod's own orders
      // are irregular (`{expected, code}` everywhere but `{code, expected}` in a
      // discriminated union; `origin` leads a check's `too_small` and trails a
      // tuple's), so this is the only practical way to hold them.
      expect(
        (compiledResult.error as unknown as { message: string }).message,
        `error.message for ${describeInput(input)}`,
      ).toBe(zodResult.error?.message);
    }
  }
}
