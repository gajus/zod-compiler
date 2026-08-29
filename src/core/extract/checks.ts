import type { CheckOrEffectIR, CheckStringFormat } from "../types.js";
import { isPayloadCheck, isReferenceablePredicate, tryCompileEffect } from "./effects.js";
import type { ExtractorContext, ZodCheckDef, ZodCheckSchema } from "./types.js";

/**
 * Build the `refineRef` registrar for {@link extractChecks} from an extractor's
 * context: it appends a {@link RefEntry} pointing at the check's own predicate
 * (`<schema>._zod.def.checks[i]._zod.def.fn`) so generated code can call the
 * user's function object directly. Returns undefined — meaning "fall back as
 * before" — when the extraction is not collecting refs.
 */
export function refineRefRegistrar(
  ctx: ExtractorContext,
  checks: ZodCheckSchema[],
): ((index: number) => number | undefined) | undefined {
  const refs = ctx.refs;
  if (!refs) return undefined;
  return (index) => {
    const fn = checks[index]?._zod?.def?.fn;
    if (!isReferenceablePredicate(fn)) return undefined;
    refs.push({ schema: fn, accessPath: `${ctx.path}._zod.def.checks[${index}]._zod.def.fn` });
    return refs.length - 1;
  };
}

/**
 * Build the `customParamsRef` registrar for {@link extractChecks}: it appends a
 * {@link RefEntry} pointing at the check's own `params` object
 * (`<schema>._zod.def.checks[i]._zod.def.params`), which $ZodCustom copies onto
 * the issue by reference.
 *
 * A reference rather than a baked literal because `params` is opaque user data:
 * it may hold functions, symbols or a cycle (none of which survive a literal),
 * and zod hands out the SAME object on every issue, so a per-failure copy would
 * break the identity comparison that is the point of passing params.
 *
 * Returns undefined — meaning "fall back to zod" — when refs are unavailable.
 */
export function customParamsRefRegistrar(
  ctx: ExtractorContext,
  checks: ZodCheckSchema[],
): ((index: number) => number | undefined) | undefined {
  const refs = ctx.refs;
  if (!refs) return undefined;
  return (index) => {
    refs.push({
      schema: checks[index]?._zod?.def?.params,
      accessPath: `${ctx.path}._zod.def.checks[${index}]._zod.def.params`,
    });
    return refs.length - 1;
  };
}

/**
 * Register the payload-taking callback of check `index` (`superRefine`) as an
 * `__rf[N]` reference, pointing at zod's own wrapper
 * (`<schema>._zod.def.checks[i]._zod.check`).
 *
 * Only the LAST check on a node qualifies: an issue carrying
 * `fatal`/`continue:false` aborts zod's remaining chain, and compiled output
 * runs every check unconditionally — with nothing following, there is nothing
 * left to abort, so the two agree.
 */
export function payloadCheckRef(
  ctx: ExtractorContext,
  checks: ZodCheckSchema[],
  index: number,
): number | undefined {
  if (index !== checks.length - 1) return undefined;
  const check = checks[index];
  const refs = ctx.refs;
  if (!refs || !check || !isPayloadCheck(check)) return undefined;
  refs.push({
    schema: (check._zod as { check: unknown }).check,
    accessPath: `${ctx.path}._zod.def.checks[${index}]._zod.check`,
  });
  return refs.length - 1;
}

/**
 * BUILT-IN string formats the codegen can validate without a regex pattern,
 * because it substitutes a known regex of its own (see EMAIL_REGEX_SOURCE /
 * UUID_REGEX_SOURCE in codegen/schemas/string.ts). Everything else without a
 * pattern (e.g. z.jwt(), which validates algorithmically) must fall back to Zod
 * instead of being silently skipped.
 *
 * Built-in ONLY: this is keyed on the format NAME, and a custom format's name is
 * user-chosen, so a match here proves nothing about a `$ZodCustomStringFormat`
 * — see the isCustomStringFormat gate at the use site.
 */
const PATTERNLESS_FORMATS = new Set(["email", "uuid", "url"]);

/**
 * String formats whose `def.pattern` is NOT the validator Zod actually runs.
 *
 * Zod attaches a `def.pattern` to every string format because `toJSONSchema()`
 * needs one to emit. A handful of constructors then REPLACE the pattern check
 * outright: `$ZodStringFormat.init` installs the pattern check with `??=`, and
 * the constructor's following `inst._zod.check = …` assignment overwrites it.
 * The pattern survives only as JSON Schema metadata. Compiling it produces a
 * verdict Zod does not share — in BOTH directions — so these delegate instead.
 *
 * - `ipv6`: Zod validates with `new URL("http://[" + value + "]")`. The URL
 *   parser accepts IPv4-mapped forms the regex has no alternative for
 *   (`"::ffff:1.2.3.4"`, `"1:2:3:4:5:6:1.2.3.4"`) and, since it strips tabs and
 *   ends the host at `@` or `/`, even non-addresses (`"@_c.Z=\t/X+9"`).
 * - `cidrv6`: splits on `/`, range-checks the prefix as a number, then runs the
 *   same `new URL` probe on the address half — inheriting every `ipv6` gap.
 * - `base64`: `length % 4 === 0 && atob(value)` does not throw. `atob` is
 *   HTML's forgiving-base64 decode, which STRIPS ASCII whitespace before
 *   decoding, so Zod accepts `"AAAA    "`, `"\t\t\t\tAAAA"` and `"+c \n"` —
 *   all rejected by `regexes.base64`, whose charset has no room for whitespace.
 * - `base64url`: `regexes.base64url.test(v)` AND an `atob` of the re-padded
 *   value. The regex alone is `^[A-Za-z0-9_-]*$`, which accepts every
 *   `length % 4 === 1` string (`"a"`, `"-"`, `"A"`, `"9"`) that decoding fails.
 *
 * Every other string format compiles its pattern, which is only safe while that
 * pattern and Zod's installed check keep agreeing. What keeps this list honest
 * — in both directions — is tests/string-format-parity.test.ts, which fuzzes
 * every reachable string format against Zod over one shared corpus.
 */
const NON_AUTHORITATIVE_PATTERN_FORMATS = new Set([
  "base64",
  "base64url",
  "cidrv6",
  // $ZodCreditCard's pattern is shape-only by design ("the Luhn check below is
  // not expressible as a pattern"); its `_zod.check` runs the checksum on top.
  "credit_card",
  "ipv6",
]);

/**
 * True when a `string_format` check is a `$ZodCustomStringFormat` — the family
 * Zod's `_stringFormat` helper builds: `z.stringFormat()`, and the built-ins
 * `z.hex()`, `z.hostname()` and `z.hash()` that route through it.
 *
 * `def.fn` is the structural marker: `_stringFormat` is the ONLY producer of a
 * `string_format` check def that carries one (every other format — guid, uuid,
 * email, ipv4, iso.*, lowercase/uppercase, regex, includes/starts_with/ends_with
 * — is built from a plain `{ check, format, pattern }` def). A name list cannot
 * stand in for it: `z.stringFormat("anything", /re/)` lets the caller pick the
 * format name, so the set of names is open.
 *
 * Two things follow from being in this family, both about Zod's OVERRIDE of
 * `inst._zod.check` (see `$ZodCustomStringFormat` in zod/v4/core/schemas.js):
 * the issue it pushes is bare (see CheckStringFormat.bareIssue), and it calls
 * `def.fn` rather than testing `def.pattern` — which is what makes a `g`/`y`
 * pattern stateful (see {@link isStatefulCustomFormat}).
 */
function isCustomStringFormat(def: ZodCheckDef): boolean {
  return typeof def.fn === "function";
}

/**
 * True when a `string_format` check validates through `def.fn` over a STATEFUL
 * (`g`/`y`-flagged) pattern — a custom format built by Zod's `_stringFormat`
 * helper, i.e. `z.stringFormat("name", /ab/g)`.
 *
 * Such a format is stateful in Zod, while the compiled output is deliberately
 * stateless — so the two diverge from the first successful match onward.
 * `_stringFormat` stores the regex as `def.pattern` AND closes over it as
 * `def.fn = (val) => fnOrRegex.test(val)`.
 * `$ZodCustomStringFormat` validates by calling that `def.fn`, and NOTHING
 * resets `lastIndex`, so a `g`/`y` regex carries its cursor across parses:
 * `z.stringFormat("f", /ab/g).safeParse("abab")` returns true, true, FALSE,
 * true over four calls. Contrast `$ZodCheckRegex` — what `.regex(/ab/g)` builds
 * — which does an explicit `def.pattern.lastIndex = 0` before testing and is
 * therefore stateless. The codegen's `lastIndexReset` reproduces THAT reset,
 * which is right for `.regex()` and is exactly what makes a custom format
 * diverge. The state lives in the user's own RegExp object, which the compiled
 * validator does not hold, so there is nothing faithful to emit: delegate.
 *
 * This needs a predicate rather than a name set like
 * NON_AUTHORITATIVE_PATTERN_FORMATS above, because a custom format's name is
 * user-chosen and cannot be enumerated. Narrowness matters in both clauses:
 * `def.fn` alone would over-delegate the built-ins Zod also routes through
 * `_stringFormat` (hostname, hex, hash), and the flag test alone would
 * over-delegate `.regex(/…/g)` — both of which stay compiled because their
 * patterns are unflagged and their check is not `def.fn`, respectively.
 */
function isStatefulCustomFormat(def: ZodCheckDef): boolean {
  return (
    isCustomStringFormat(def) && def.pattern instanceof RegExp && /[gy]/.test(def.pattern.flags)
  );
}

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

export function extractChecks(
  checks: ZodCheckSchema[],
  /**
   * Registers the predicate of the check at `index` as an `__rf[N]` reference
   * and returns N, or undefined when references are unavailable (no refs array)
   * or the callback's shape cannot be called directly. Supplied by extractors
   * that know their schema's access path; omitted by callers that do not, which
   * simply keeps the old fall-back-to-zod behavior.
   */
  refineRef?: (index: number) => number | undefined,
  /** Registers a payload-taking callback (superRefine); see payloadCheckRef. */
  payloadRefFor?: (index: number) => number | undefined,
  /** Registers a `.refine(fn, { params })` payload; see customParamsRefRegistrar. */
  customParamsRef?: (index: number) => number | undefined,
): {
  checkIRs: CheckOrEffectIR[];
  hasFallback: boolean;
} {
  const checkIRs: CheckOrEffectIR[] = [];
  let hasFallback = false;

  for (const [index, check] of checks.entries()) {
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
        // `z.stringFormat(name, …)` lets the CALLER pick the format name, so a
        // custom format can be named "email", "url" — anything a built-in is
        // named. The name therefore does NOT identify which validator Zod runs;
        // only the structural `def.fn` marker does. Every branch below that
        // treats a name as proof of a built-in's behaviour is gated on this.
        const isCustom = isCustomStringFormat(def);

        // A custom format over a g/y regex advances that regex's lastIndex on
        // every parse and Zod never resets it — see isStatefulCustomFormat.
        if (isStatefulCustomFormat(def)) {
          hasFallback = true;
          break;
        }
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
        // z.url() validates with the URL parser plus optional hostname/protocol
        // probes, and carries no pattern worth compiling. A custom format merely
        // NAMED "url" shares none of that — it validates through `def.fn` — so
        // taking this branch both discarded the user's own `def.pattern` and
        // answered with the URL parser's verdict instead of the user's.
        if (def.format === "url" && !isCustom) {
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
        // Not gated on isCustom: this set only ever adds a fallback, so a custom
        // format that happens to borrow one of these names loses its fast path
        // but never its verdict.
        if (NON_AUTHORITATIVE_PATTERN_FORMATS.has(def.format)) {
          hasFallback = true;
          break;
        }
        const pattern = def.pattern instanceof RegExp ? def.pattern.source : def.pattern;
        const flags = def.pattern instanceof RegExp && def.pattern.flags ? def.pattern.flags : "";
        if (!pattern && !(!isCustom && PATTERNLESS_FORMATS.has(def.format))) {
          // Nothing to compile: an algorithmic built-in (e.g. jwt), or a custom
          // format built from a FUNCTION rather than a regex. For the latter the
          // predicate lives only in `def.fn`, and a name-matched built-in regex
          // is emphatically not it — `z.stringFormat("email", (v) => v.length
          // === 3)` accepts "abc" and rejects "a@b.co", the exact inverse of the
          // email regex. Delegate to Zod.
          hasFallback = true;
          break;
        }
        checkIRs.push({
          kind: "string_format",
          format: def.format,
          ...(pattern ? { pattern } : {}),
          ...(flags ? { patternFlags: flags } : {}),
          ...(isCustom ? { bareIssue: true } : {}),
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
        // superRefine / raw .check(): the callback collects issues from zod's
        // payload rather than returning a verdict, so it is referenced and
        // called with a synthesized payload (see SuperRefineEffectCheckIR).
        if (isPayloadCheck(check)) {
          const payloadRef = payloadRefFor?.(index);
          if (payloadRef === undefined) {
            hasFallback = true;
            break;
          }
          checkIRs.push({ kind: "super_refine_effect", refIndex: payloadRef });
          break;
        }
        // `.refine(fn, { path })` reports the issue against a member of the
        // refined value; anything but plain string/number segments is a shape
        // the generated path expression cannot reproduce.
        const customPath = Array.isArray(def.path) ? def.path : undefined;
        if (customPath?.some((p) => typeof p !== "string" && typeof p !== "number")) {
          hasFallback = true;
          break;
        }
        const pathIR = customPath && customPath.length > 0 ? { path: customPath } : {};
        // `.refine(fn, { params })`: zod attaches the object to the issue, and
        // an error map reads it back. Held as a reference (see
        // customParamsRefRegistrar); with no ref array to hold it, the issue
        // cannot be reproduced at all, so the schema goes to zod.
        let paramsIR: { paramsRefIndex?: number } = {};
        if (def.params !== undefined) {
          const paramsRefIndex = customParamsRef?.(index);
          if (paramsRefIndex === undefined) {
            hasFallback = true;
            break;
          }
          paramsIR = { paramsRefIndex };
        }
        const source = tryCompileEffect(def.fn);
        if (source) {
          checkIRs.push({ kind: "refine_effect", source, ...pathIR, ...paramsIR, ...message });
          break;
        }
        // Not inlineable (the predicate captures outer variables). Call the
        // user's own function object through a schema reference instead of
        // delegating: a captured `.refine()` at the root otherwise costs the
        // whole schema its compiled path.
        const refIndex = refineRef?.(index);
        if (refIndex !== undefined) {
          checkIRs.push({ kind: "refine_effect", refIndex, ...pathIR, ...paramsIR, ...message });
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
