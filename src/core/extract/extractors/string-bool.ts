import type { StringBoolIR } from "../../types.js";
import type { ExtractorContext, ZodDef } from "../types.js";

/**
 * Default probe values used to discover truthy/falsy mappings at build time.
 * Covers all Zod v4 stringbool defaults. Custom values outside this set
 * will cause the schema to fall back to Zod.
 */
const PROBE_VALUES = [
  "true",
  "false",
  "1",
  "0",
  "yes",
  "no",
  "on",
  "off",
  "y",
  "n",
  "enabled",
  "disabled",
];

/** Detect whether a pipe def is a Codec with string→boolean (i.e. stringbool). */
export function isStringBoolCodec(def: ZodDef): boolean {
  return (
    typeof def.transform === "function" &&
    typeof def.reverseTransform === "function" &&
    def.in?._zod?.def?.type === "string" &&
    def.out?._zod?.def?.type === "boolean"
  );
}

/**
 * Extract a StringBoolIR by probing the live schema with known test values.
 * Falls back if the discovered values don't fully cover the schema's accepted set.
 */
export function extractStringBool(_def: ZodDef, ctx: ExtractorContext): StringBoolIR | null {
  const schema = ctx.schema as {
    safeParse(input: unknown): { success: boolean; data?: unknown };
  };

  const truthy: string[] = [];
  const falsy: string[] = [];

  for (const val of PROBE_VALUES) {
    try {
      const result = schema.safeParse(val);
      if (result.success) {
        if (result.data === true) truthy.push(val);
        else if (result.data === false) falsy.push(val);
      }
    } catch {
      // Skip values that throw
    }
  }

  // Both sets must be non-empty to generate correct code.
  if (truthy.length === 0 || falsy.length === 0) {
    return null;
  }

  // [P1] Verify completeness: trigger a validation error to extract the full list
  // of accepted values from Zod's error response. If the schema accepts values
  // we didn't discover via probing, fall back to avoid partial compilation.
  try {
    const probe = schema.safeParse("__zod_compiler_probe__");
    if (!probe.success) {
      const issues = (probe as { error?: { issues?: Array<{ code: string; values?: string[] }> } })
        .error?.issues;
      const valueIssue = issues?.find((i) => i.code === "invalid_value");
      if (valueIssue?.values) {
        const expectedSet = new Set(valueIssue.values);
        const discoveredSet = new Set([...truthy, ...falsy]);
        for (const v of expectedSet) {
          if (!discoveredSet.has(v)) return null;
        }
      }
    }
  } catch {
    return null;
  }

  // [P2] Detect case sensitivity: search BOTH truthy and falsy for a value with
  // case variation, then test its opposite-case variant.
  let caseSensitive = false;
  for (const val of [...truthy, ...falsy]) {
    const upper = val.toUpperCase();
    if (upper !== val) {
      try {
        caseSensitive = !schema.safeParse(upper).success;
      } catch {
        // safeParse threw — can't determine, default to case-insensitive
      }
      break;
    }
  }

  return { type: "stringBool", truthy, falsy, caseSensitive };
}
