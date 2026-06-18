/**
 * Shared differential-parity harness: compiles a schema through the real
 * extract → codegen pipeline with a production-equivalent __zcFin (Zod locale
 * wired, mirroring ZOD_MSG_DECLARATION) and compares against Zod itself.
 */
import { expect } from "vitest";
import { ZodRealError, z } from "zod";
import { generateValidator } from "#src/core/codegen/index.js";
import type { ExtractOptions, RefEntry } from "#src/core/extract/index.js";
import { extractSchema } from "#src/core/extract/index.js";
import {
  FAIL_CLASS_DECL,
  FAILZ_CLASS_DECL,
  FIN_DECL,
  FIN_DEFERRED_DECL,
  FINZ_DECL,
} from "#src/core/iife.js";
import type { SafeParseResult } from "#src/core/types.js";

const localizedFin = new Function(
  "__zcMsg",
  "__zcZodError",
  `${FAIL_CLASS_DECL}${FIN_DECL}; return __zcFin;`,
)(z.config().localeError, ZodRealError);

const finZ = new Function(`${FAILZ_CLASS_DECL}${FINZ_DECL}; return __zcFinZ;`)() as (
  rfp: (input: unknown) => SafeParseResult<unknown>,
  input: unknown,
) => SafeParseResult<unknown>;

export interface ZodLikeSchema {
  safeParse: (input: unknown) => {
    success: boolean;
    data?: unknown;
    error?: { issues: { message: string }[] };
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
  // Compact delegation appends the schema itself as the root RefEntry (the
  // pipeline does this in production); mirror it so `__rf[N]` resolves to the
  // schema whose pristine safeParse the validator delegates to.
  const rf = refEntries.map((e) => e.schema);
  if (generated.rootDelegateRefIndex !== undefined) {
    rf.push(schema);
  }
  const factory = new Function(
    "__zcMsg",
    "__zcZodError",
    "__zcFin",
    "__zcFinZ",
    "__rf",
    `${FAIL_CLASS_DECL}${FIN_DEFERRED_DECL}\n${generated.code}\nreturn ${generated.functionDef};`,
  );
  return factory(z.config().localeError, ZodRealError, localizedFin, finZ, rf) as (
    input: unknown,
  ) => SafeParseResult<unknown>;
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

/**
 * Assert compiled accept/reject, output data, and first message match Zod for
 * every input. Schemas that throw synchronously (async refinements, function
 * schemas) must throw identically on both sides.
 */
export function expectParity(
  schema: ZodLikeSchema,
  inputs: unknown[],
  name?: string,
  extractOptions?: ExtractOptions,
  options?: { compact?: boolean },
): void {
  const compiled = compileLikeProduction(schema, name, extractOptions, options);
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
      const zodMessage = zodResult.error?.issues[0]?.message;
      const compiledMessage = (compiledResult.error.issues[0] as { message?: string })?.message;
      expect(compiledMessage, `message for ${describeInput(input)}`).toBe(zodMessage);
    }
  }
}
