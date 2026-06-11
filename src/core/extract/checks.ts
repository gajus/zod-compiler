import type { CheckOrEffectIR, CheckStringFormat } from "../types.js";
import { tryCompileEffect } from "./effects.js";
import type { ZodCheckDef, ZodCheckSchema } from "./types.js";

/**
 * String formats the codegen can validate without a regex pattern.
 * Everything else without a pattern (e.g. z.jwt(), which validates
 * algorithmically) must fall back to Zod instead of being silently skipped.
 */
const PATTERNLESS_FORMATS = new Set(["email", "uuid", "url"]);

/**
 * Formats whose def.pattern is NOT the authoritative validator — zod's
 * runtime check is algorithmic and accepts inputs the pattern rejects
 * (e.g. z.cidrv6() splits the prefix and validates the IPv6 part separately).
 */
const NON_AUTHORITATIVE_PATTERN_FORMATS = new Set(["cidrv6"]);

/**
 * Check kinds where Zod itself installs a `when` guard
 * (`!nullish(value) && value.length/size !== undefined`). Compiled output
 * reproduces that gating structurally — length/size checks only run after the
 * typeof/instanceof guard — so a `when` on these kinds is expected and safe.
 * A `when` anywhere else must be user-supplied → fall back to Zod.
 * (A user-supplied `when` on one of these six kinds is indistinguishable from
 * the internal guard and remains unsupported.)
 */
const INTERNAL_WHEN_CHECK_KINDS = new Set([
  "min_length",
  "max_length",
  "length_equals",
  "min_size",
  "max_size",
  "size_equals",
]);

/** True when a check carries a runtime `when` predicate we cannot reproduce. */
function hasUserWhen(def: ZodCheckDef): boolean {
  return Boolean(def.when) && !INTERNAL_WHEN_CHECK_KINDS.has(def.check);
}

/**
 * True when a check can't be compiled because of runtime modifiers:
 * a user-supplied `when` predicate, or `abort: true` (which stops later
 * checks and marks the option as aborted in union pruning — compiled
 * output always runs every check).
 */
export function hasUncompilableModifiers(def: ZodCheckDef): boolean {
  return hasUserWhen(def) || def.abort === true;
}

export function extractChecks(checks: ZodCheckSchema[]): {
  checkIRs: CheckOrEffectIR[];
  hasFallback: boolean;
} {
  const checkIRs: CheckOrEffectIR[] = [];
  let hasFallback = false;

  for (const check of checks) {
    const def = check._zod?.def;
    if (!def) continue;

    // Checks gated by a user-supplied runtime `when` predicate or abort:true
    // can't be reproduced in compiled output — delegate the schema to Zod.
    if (hasUncompilableModifiers(def)) {
      hasFallback = true;
      continue;
    }

    // Per-check custom error: bake static messages into the IR; error maps
    // that read the issue (dynamic) can't be compiled — fall back so Zod
    // produces the exact message.
    const resolved = resolveCheckMessage(def.error);
    if (resolved.kind === "dynamic") {
      hasFallback = true;
      continue;
    }
    const message = resolved.kind === "static" ? { message: resolved.message } : {};

    switch (def.check) {
      case "min_length":
        checkIRs.push({ kind: "min_length", minimum: def.minimum, ...message });
        break;
      case "max_length":
        checkIRs.push({ kind: "max_length", maximum: def.maximum, ...message });
        break;
      case "length_equals":
        checkIRs.push({ kind: "length_equals", length: def.length, ...message });
        break;
      case "greater_than":
        checkIRs.push({
          kind: "greater_than",
          value: def.value,
          inclusive: def.inclusive,
          ...message,
        });
        break;
      case "less_than":
        checkIRs.push({
          kind: "less_than",
          value: def.value,
          inclusive: def.inclusive,
          ...message,
        });
        break;
      case "multiple_of":
        checkIRs.push({ kind: "multiple_of", value: def.value, ...message });
        break;
      case "number_format":
        checkIRs.push({
          kind: "number_format",
          format: def.format as "safeint" | "int32" | "uint32" | "float32" | "float64",
          ...message,
        });
        break;
      case "string_format": {
        if (def.format === "includes" && typeof def.includes === "string") {
          checkIRs.push({
            kind: "includes",
            includes: def.includes,
            ...(typeof def.position === "number" ? { position: def.position } : {}),
            ...message,
          });
          break;
        }
        if (def.format === "starts_with" && typeof def.prefix === "string") {
          checkIRs.push({ kind: "starts_with", prefix: def.prefix, ...message });
          break;
        }
        if (def.format === "ends_with" && typeof def.suffix === "string") {
          checkIRs.push({ kind: "ends_with", suffix: def.suffix, ...message });
          break;
        }
        if (def.format === "url") {
          checkIRs.push({
            kind: "string_format",
            format: "url",
            ...regexFields("hostname", "hostnameFlags", def.hostname),
            ...regexFields("protocol", "protocolFlags", def.protocol),
            ...(def.normalize ? { normalize: true } : {}),
            ...message,
          });
          break;
        }
        if (NON_AUTHORITATIVE_PATTERN_FORMATS.has(def.format)) {
          hasFallback = true;
          break;
        }
        const pattern = def.pattern instanceof RegExp ? def.pattern.source : def.pattern;
        const flags = def.pattern instanceof RegExp && def.pattern.flags ? def.pattern.flags : "";
        if (!pattern && !PATTERNLESS_FORMATS.has(def.format)) {
          // Algorithmic format (e.g. jwt) — nothing to compile.
          hasFallback = true;
          break;
        }
        checkIRs.push({
          kind: "string_format",
          format: def.format,
          ...(pattern ? { pattern } : {}),
          ...(flags ? { patternFlags: flags } : {}),
          ...message,
        });
        break;
      }
      case "overwrite": {
        // $ZodCheckOverwrite (.trim(), .toLowerCase(), ...): value = def.tx(value)
        const source = tryCompileEffect(def.tx);
        if (source) {
          checkIRs.push({ kind: "overwrite_effect", source });
        } else {
          hasFallback = true;
        }
        break;
      }
      case "custom": {
        const source = tryCompileEffect(def.fn);
        if (source) {
          checkIRs.push({ kind: "refine_effect", source, ...message });
        } else {
          hasFallback = true;
        }
        break;
      }
      default:
        // Unknown check kind — never drop silently; delegate to Zod.
        hasFallback = true;
        break;
    }
  }

  return { checkIRs, hasFallback };
}

function regexFields(
  sourceKey: "hostname" | "protocol",
  flagsKey: "hostnameFlags" | "protocolFlags",
  value: unknown,
): Partial<CheckStringFormat> {
  if (!(value instanceof RegExp)) return {};
  return { [sourceKey]: value.source, ...(value.flags ? { [flagsKey]: value.flags } : {}) };
}

// ─── Static error message extraction ────────────────────────────────────────

export type ResolvedMessage =
  | { kind: "none" }
  | { kind: "static"; message: string }
  | { kind: "dynamic" };

/**
 * Classify a check/schema-level `error` param.
 *
 * Zod normalizes `.min(3, "msg")` / `{ error: "msg" }` / `{ message: "msg" }`
 * into an error-map function that ignores its issue argument and returns the
 * string. We call the function with an access-tracking Proxy: if it never
 * inspects the issue, its return value is a constant we can bake into the
 * generated issue. If it reads any issue property (input-dependent message),
 * it is dynamic and the schema must fall back to Zod for exact messages.
 */
export function resolveCheckMessage(error: unknown): ResolvedMessage {
  if (error === null || error === undefined) return { kind: "none" };
  if (typeof error === "string") return { kind: "static", message: error };
  if (typeof error !== "function") return { kind: "dynamic" };

  let accessed = false;
  const track = () => {
    accessed = true;
  };
  const probe = new Proxy(
    {},
    {
      get(_t, prop) {
        track();
        // Avoid breaking string coercion / await probing inside error maps.
        if (prop === Symbol.toPrimitive || prop === "toString" || prop === "valueOf") {
          return () => "";
        }
        return undefined;
      },
      has() {
        track();
        return false;
      },
      ownKeys() {
        track();
        return [];
      },
      getOwnPropertyDescriptor() {
        track();
        return undefined;
      },
    },
  );

  let result: unknown;
  try {
    result = (error as (issue: unknown) => unknown)(probe);
  } catch {
    return { kind: "dynamic" };
  }
  if (accessed) return { kind: "dynamic" };
  if (typeof result === "string") return { kind: "static", message: result };
  if (
    result !== null &&
    typeof result === "object" &&
    typeof (result as { message?: unknown }).message === "string"
  ) {
    return { kind: "static", message: (result as { message: string }).message };
  }
  // Error map deferred (returned undefined) — no custom message.
  if (result === undefined) return { kind: "none" };
  return { kind: "dynamic" };
}
