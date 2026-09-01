/**
 * Well-known regex sources hosted in the virtual module "virtual:zod-compiler/runtime".
 *
 * In lean mode (unplugin), `g.regex()` consults this registry and emits a reference
 * like `__zcReEmail` instead of declaring `var __re_email_*=new RegExp(...)`.
 * The bundler then deduplicates the regex literal across all transformed files.
 *
 * Pattern sources are matched verbatim (string equality). Add new entries as Zod
 * exposes additional well-known formats and we want bundle-wide dedup.
 *
 * Verbatim matching means an entry goes STALE SILENTLY when Zod edits a pattern:
 * nothing breaks, the lookup just stops hitting and every transformed file
 * re-declares its own RegExp. The 4.5 bump did exactly that to `cuid`, `ulid`
 * and `iso.datetime` — the last being the ~330-character source this table
 * exists for. tests/core/codegen/well-known-regex.test.ts pins every entry
 * against the live Zod pattern so the next upgrade fails loudly instead.
 */

import { unrollRepeats } from "./regex-unroll.js";

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
 *
 * Generated code no longer runs this pattern: the flag-less default is tested
 * by the `__zcEmail` scanner instead (see {@link isDefaultEmailPattern} and
 * ZC_EMAIL_DECL in issue-decls.ts). The table entry stays because its `Src`
 * companion is what issue sites report, and so lean mode keeps that string a
 * single bundle-wide constant; the RegExp export itself is simply unreferenced.
 */
export const EMAIL_FAST_REGEX_SOURCE = String.raw`^(?:[A-Za-z0-9_'+\-]+\.)*[A-Za-z0-9_'+\-]*[A-Za-z0-9_+-]@(?:[A-Za-z0-9][A-Za-z0-9\-]*\.)+[A-Za-z]{2,}$`;

/**
 * Is this exactly zod's default email pattern, flag-less?
 *
 * Generated code tests that one pattern with the `__zcEmail` scanner (see
 * ZC_EMAIL_DECL) rather than with either RegExp above, whatever format name
 * the check carries — `z.email()`, `z.string().regex(z.regexes.email)` and a
 * `z.stringFormat("x", z.regexes.email)` all run the same regex in zod and so
 * get the same verdict here. Only the TEST changes: the issue still reports the
 * pattern string, and a flagged copy keeps its RegExp since the flags would be
 * part of what it reports.
 */
export function isDefaultEmailPattern(pattern: string, flags: string | undefined): boolean {
  return !flags && pattern === EMAIL_REGEX_SOURCE;
}

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
  { name: "__zcReCuid", source: "^[cC][0-9a-z]{6,}$" },
  { name: "__zcReCuid2", source: "^[0-9a-z]+$" },
  { name: "__zcReUlid", source: "^[0-7][0-9A-HJKMNP-TV-Za-hjkmnp-tv-z]{25}$" },
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
  // The ISO family. Zod BUILDS these from the call's options, so only the
  // default spelling is a fixed string — `z.iso.datetime({ offset: true })` or
  // `{ precision: 3 }` produces a different source that simply misses this
  // exact-match table and keeps its per-IIFE declaration. Defaults are worth
  // listing anyway: `z.iso.datetime()` is everywhere in API schemas and its
  // pattern is ~330 characters, so a bundle that repeats it per validator pays
  // for it in bytes and in a RegExp construction per schema at module init.
  {
    name: "__zcReIsoDate",
    source:
      "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))$",
  },
  { name: "__zcReIsoTime", source: "^(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?$" },
  {
    name: "__zcReIsoDateTime",
    source:
      "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d+)?(?:Z))$",
  },
  {
    name: "__zcReIsoDuration",
    source:
      "^P(?:(\\d+W)|(?!.*W)(?=\\d|T\\d)(\\d+Y)?(\\d+M)?(\\d+D)?(T(?=\\d)(\\d+H)?(\\d+M)?(\\d+([.,]\\d+)?S)?)?)$",
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
 * Look up the hand-written behavior-equivalent test pattern for a regex source.
 * Returns null when no rewrite is registered in {@link WELL_KNOWN_REGEXES}.
 *
 * This is the TABLE lookup only. Codegen calls {@link fastTestSource}, which
 * layers automatic repeat unrolling on top and also covers user-supplied
 * patterns that are in no table.
 */
export function lookupFastRegexSource(source: string): string | null {
  return SOURCE_TO_TEST_SOURCE.get(source) ?? null;
}

/**
 * The pattern a generated `.test()` should actually run for `source`, or null
 * when `source` is already the best form.
 *
 * Two behavior-preserving rewrites compose here: the hand-written table entry
 * above (currently just email), then {@link unrollRepeats}, which turns bounded
 * repeats of single-character atoms into explicit repetition — worth 1.3-3.4x
 * on the string formats everyday schemas use (uuid, guid, ulid, nanoid, xid,
 * ksuid, base64, e164, iso.date). Unrolling runs on the table rewrite when
 * there is one, so the two stack.
 *
 * Callers must apply this only to flag-less regexes (the flagged form would
 * need its flags carried into the reported pattern too) and must keep
 * reporting the ORIGINAL source in issues — see `emitRegexSourceString`.
 */
export function fastTestSource(source: string): string | null {
  const tableRewrite = SOURCE_TO_TEST_SOURCE.get(source) ?? null;
  return unrollRepeats(tableRewrite ?? source) ?? tableRewrite;
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
  return fastTestSource(source) !== null ? `${name}Src` : null;
}
