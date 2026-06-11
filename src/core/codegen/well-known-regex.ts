/**
 * Well-known regex sources hosted in the virtual module "virtual:zod-compiler/runtime".
 *
 * In lean mode (unplugin), `g.regex()` consults this registry and emits a reference
 * like `__zcReEmail` instead of declaring `var __re_email_*=new RegExp(...)`.
 * The bundler then deduplicates the regex literal across all transformed files.
 *
 * Pattern sources are matched verbatim (string equality). Add new entries as Zod
 * exposes additional well-known formats and we want bundle-wide dedup.
 */

/** Zod v4's email regex source (string.ts uses this directly when format === "email"). */
export const EMAIL_REGEX_SOURCE = String.raw`^(?!\.)(?!.*\.\.)([A-Za-z0-9_'+\-\.]*)[A-Za-z0-9_+-]@([A-Za-z0-9][A-Za-z0-9\-]*\.)+[A-Za-z]{2,}$`;

/**
 * Behavior-equivalent rewrite of EMAIL_REGEX_SOURCE that runs ~1.45x faster on V8.
 *
 * Zod's pattern fronts two lookaheads; `(?!.*\.\.)` re-scans the entire string
 * before matching starts. The rewrite encodes the same constraints structurally:
 * the local part is dot-separated runs of `[A-Za-z0-9_'+-]` (no leading dot, no
 * empty run ⇒ no `..`) ending in `[A-Za-z0-9_+-]`, and the domain grammar already
 * makes `..` impossible (every label starts with an alphanumeric).
 *
 * Equivalence is enforced by tests/core/codegen/email-fast-regex.test.ts
 * (exhaustive short-string sweep + structured cases + random fuzz).
 */
export const EMAIL_FAST_REGEX_SOURCE = String.raw`^(?:[A-Za-z0-9_'+\-]+\.)*[A-Za-z0-9_'+\-]*[A-Za-z0-9_+-]@(?:[A-Za-z0-9][A-Za-z0-9\-]*\.)+[A-Za-z]{2,}$`;

/** Fallback UUID regex used when the extractor doesn't provide a pattern (e.g. in unit tests). */
export const UUID_REGEX_SOURCE =
  "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$";

export interface WellKnownRegex {
  /** Stable virtual-module export name. Always starts with "__zcRe". */
  name: string;
  /** Pattern source string (verbatim match against `g.regex()` 2nd argument). */
  source: string;
  /**
   * Behavior-equivalent faster pattern used for the actual `.test()` regex.
   * Issue reporting (`pattern:` field) always uses `source` so generated
   * issues stay byte-identical to zod's.
   */
  testSource?: string;
}

export const WELL_KNOWN_REGEXES: readonly WellKnownRegex[] = [
  { name: "__zcReEmail", source: EMAIL_REGEX_SOURCE, testSource: EMAIL_FAST_REGEX_SOURCE },
  { name: "__zcReUuid", source: UUID_REGEX_SOURCE },
  { name: "__zcReCuid", source: "^[cC][^\\s-]{8,}$" },
  { name: "__zcReCuid2", source: "^[0-9a-z]+$" },
  { name: "__zcReUlid", source: "^[0-9A-HJKMNP-TV-Za-hjkmnp-tv-z]{26}$" },
  { name: "__zcReNanoid", source: "^[a-zA-Z0-9_-]{21}$" },
  { name: "__zcReXid", source: "^[0-9a-vA-V]{20}$" },
  { name: "__zcReKsuid", source: "^[A-Za-z0-9]{27}$" },
  {
    name: "__zcReIpv4",
    source:
      "^(?:(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])\\.){3}(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])$",
  },
  {
    name: "__zcReIpv6",
    source:
      "^(([0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,7}:|([0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,5}(:[0-9a-fA-F]{1,4}){1,2}|([0-9a-fA-F]{1,4}:){1,4}(:[0-9a-fA-F]{1,4}){1,3}|([0-9a-fA-F]{1,4}:){1,3}(:[0-9a-fA-F]{1,4}){1,4}|([0-9a-fA-F]{1,4}:){1,2}(:[0-9a-fA-F]{1,4}){1,5}|[0-9a-fA-F]{1,4}:((:[0-9a-fA-F]{1,4}){1,6})|:((:[0-9a-fA-F]{1,4}){1,7}|:))$",
  },
  {
    name: "__zcReBase64",
    source: "^$|^(?:[0-9a-zA-Z+/]{4})*(?:(?:[0-9a-zA-Z+/]{2}==)|(?:[0-9a-zA-Z+/]{3}=))?$",
  },
  { name: "__zcReBase64Url", source: "^[A-Za-z0-9_-]*$" },
  { name: "__zcReE164", source: "^\\+[1-9]\\d{6,14}$" },
  {
    name: "__zcReGuid",
    source: "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})$",
  },
];

const SOURCE_TO_NAME: ReadonlyMap<string, string> = new Map(
  WELL_KNOWN_REGEXES.map((r) => [r.source, r.name]),
);

const SOURCE_TO_TEST_SOURCE: ReadonlyMap<string, string> = new Map(
  WELL_KNOWN_REGEXES.filter((r) => r.testSource !== undefined).map((r) => [
    r.source,
    r.testSource as string,
  ]),
);

/**
 * Look up a well-known regex by its pattern source string.
 * Returns the virtual-module export name or null if the pattern is user-defined.
 */
export function lookupWellKnownRegex(source: string): string | null {
  return SOURCE_TO_NAME.get(source) ?? null;
}

/**
 * Look up the faster behavior-equivalent test pattern for a regex source.
 * Returns null when no rewrite is registered (the pattern is used verbatim).
 * Callers must only apply the rewrite to flag-less regexes and must keep
 * reporting the ORIGINAL source in issues.
 */
export function lookupFastRegexSource(source: string): string | null {
  return SOURCE_TO_TEST_SOURCE.get(source) ?? null;
}

/**
 * Virtual-module export name for the ORIGINAL `/source/` pattern string of a
 * rewritten well-known regex (e.g. "__zcReEmailSrc"). Issue sites reference it
 * so the original pattern stays a single bundle-wide string even though the
 * runtime regex object is built from testSource.
 */
export function wellKnownRegexSourceName(source: string): string | null {
  const name = SOURCE_TO_NAME.get(source);
  if (name === undefined) return null;
  return SOURCE_TO_TEST_SOURCE.has(source) ? `${name}Src` : null;
}
