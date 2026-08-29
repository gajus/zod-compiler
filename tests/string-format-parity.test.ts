/**
 * Differential parity for EVERY Zod string format reachable from the public API.
 *
 * Why this file exists: `def.pattern` is not always the validator Zod runs.
 * Zod attaches a pattern to every string format because `toJSONSchema()` needs
 * one to emit, and `$ZodStringFormat.init` installs a pattern-testing check with
 * `inst._zod.check ??= …`. But several constructors follow that init with a bare
 * `inst._zod.check = …` assignment, which overwrites the pattern check with an
 * algorithmic one — `new URL("http://[…]")` for ipv6/cidrv6, `atob` for
 * base64/base64url. For those formats the pattern is metadata that DISAGREES
 * with the runtime verdict, in both directions: the ipv6 regex has no branch for
 * IPv4-mapped addresses Zod accepts, and the base64url regex (`^[A-Za-z0-9_-]*$`)
 * accepts every `length % 4 === 1` string that Zod's decode rejects.
 *
 * zod-compiler compiles `def.pattern`, so a format whose pattern and check
 * disagree must be delegated to Zod instead — see NON_AUTHORITATIVE_PATTERN_FORMATS
 * in src/core/extract/checks.ts. This file is what tells the two classes apart:
 * every format is fuzzed against Zod over one shared corpus, so a pattern that
 * silently stops matching its check — here, or after a Zod upgrade — fails here
 * rather than in a user's validator.
 */
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import { extractSchema } from "#src/core/extract/index.js";
import { compileLikeProduction, expectParity } from "./parity-harness.js";

/** Deterministic LCG (numerical recipes constants) — never Math.random. */
function lcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state / 0x1_00_00_00_00;
  };
}

/**
 * Alphabets chosen so random draws land inside — and just outside — the
 * charsets these formats care about. The last one carries ASCII whitespace,
 * which is what exposed base64: `atob` strips it before decoding, the regex
 * cannot match it.
 */
const ALPHABETS = [
  "0123456789abcdefABCDEF:.",
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=",
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_",
  "0123456789.:/-",
  "abcXYZ019.:-_+/=@% \t\n",
];

function randomStrings(count: number): string[] {
  const rand = lcg(0x5eed_1234);
  const out: string[] = [];
  for (let index = 0; index < count; index++) {
    const alphabet = ALPHABETS[index % ALPHABETS.length] as string;
    const length = Math.floor(rand() * 12);
    let value = "";
    for (let charIndex = 0; charIndex < length; charIndex++) {
      value += alphabet[Math.floor(rand() * alphabet.length)];
    }
    out.push(value);
  }
  return out;
}

/**
 * Hand-picked inputs, each one an edge the random draws would rarely reach:
 * every known pattern-vs-check disagreement, plus a canonical valid value per
 * format so an over-eager delegation that rejects everything cannot pass.
 */
const HAND_PICKED = [
  // Short strings — base64url's regex accepts all of these, its decode does not.
  "",
  "a",
  "-",
  "A",
  "9",
  "_",
  "aa",
  "aaa",
  "aaaa",
  // base64 padding and whitespace (atob's forgiving decode strips whitespace).
  "aGVsbG8=",
  "aGVsbG8",
  "a===",
  "A===",
  "AA==",
  "AAA=",
  "AAAA",
  "====",
  "AA=A",
  "AAAA    ",
  "AAAA\n\n\n\n",
  "\t\t\t\tAAAA",
  "AAAA\t",
  "AA==AA==",
  "+c \n",
  // IPv6, including IPv4-mapped forms the regex has no alternative for.
  "::ffff:1.2.3.4",
  "::ffff:192.168.0.1",
  "64:ff9b::1.2.3.4",
  "1:2:3:4:5:6:1.2.3.4",
  "::1",
  "::",
  "2001:db8::1",
  "0:0:0:0:0:0:0:1",
  "fe80::1%eth0",
  // `new URL` strips tabs and ends the host at `@` or `/` — Zod accepts this.
  "@_c.Z=\t/X+9",
  // CIDR.
  "::ffff:1.2.3.4/64",
  "2001:db8::/32",
  "::/0",
  "::1/129",
  "10.0.0.0/8",
  "10.0.0.0/33",
  // IPv4 / MAC / hex / hashes.
  "1.2.3.4",
  "192.168.1.1",
  "256.1.1.1",
  "deadbeef",
  "DEADBEEF",
  "d41d8cd98f00b204e9800998ecf8427e",
  "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  "00:1A:2B:3C:4D:5E",
  "00-1A-2B-3C-4D-5E",
  // Hostnames, emails, URLs.
  "example.com",
  "localhost",
  "a.b.c",
  "-bad-.com",
  "john@example.com",
  "john..doe@example.com",
  "https://example.com",
  "http://example.com/a?b=c",
  "ftp://example.com",
  "not a url",
  // Identifiers.
  "3f2504e0-4f89-41d3-9a0c-0305e82c3301",
  "00000000-0000-0000-0000-000000000000",
  "cjld2cjxh0000qzrmn831i7rn",
  "tz4a98xxat96iws9zmbrgj3a",
  "01ARZ3NDEKTSV4RRFFQ69G5FAV",
  "9m4e2mr0ui3e8a215n4g",
  "2naeRjTrKbDPVJEXBTGfAP1H3Kz",
  "V1StGXR8_Z5jdHi6B-myT",
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJhIjoxfQ.sig",
  // Misc.
  "+14155552671",
  "😀",
  "abc",
  "ABC",
  "AbC",
  "2024-06-15",
  "2024-02-30",
  "12:34:56",
  "2024-06-15T12:34:56Z",
  "P3Y6M4DT12H30M5S",
];

const CORPUS: readonly string[] = [...HAND_PICKED, ...randomStrings(200)];

/** Every string format reachable from Zod's public API. */
const FORMATS: [name: string, schema: z.ZodType][] = [
  ["ipv4", z.ipv4()],
  ["ipv6", z.ipv6()],
  ["cidrv4", z.cidrv4()],
  ["cidrv6", z.cidrv6()],
  ["base64", z.base64()],
  ["base64url", z.base64url()],
  ["hex", z.hex()],
  ["hostname", z.hostname()],
  ["hash md5", z.hash("md5")],
  ["hash sha256", z.hash("sha256")],
  ["hash md5 (base64)", z.hash("md5", { enc: "base64" })],
  ["hash sha256 (base64url)", z.hash("sha256", { enc: "base64url" })],
  ["mac", z.mac()],
  ["email", z.email()],
  ["url", z.url()],
  ["httpUrl", z.httpUrl()],
  ["uuid", z.uuid()],
  ["guid", z.guid()],
  ["cuid", z.cuid()],
  ["cuid2", z.cuid2()],
  ["ulid", z.ulid()],
  ["xid", z.xid()],
  ["ksuid", z.ksuid()],
  ["nanoid", z.nanoid()],
  ["jwt", z.jwt()],
  ["e164", z.e164()],
  ["emoji", z.emoji()],
  ["iso.datetime", z.iso.datetime()],
  ["iso.date", z.iso.date()],
  ["iso.time", z.iso.time()],
  ["iso.duration", z.iso.duration()],
  ["lowercase", z.string().lowercase()],
  ["uppercase", z.string().uppercase()],
  ["stringFormat (regex)", z.stringFormat("custom_re", /^[ab]+$/)],
  ["stringFormat (fn)", z.stringFormat("custom_fn", (value) => value.length === 3)],
];

describe("string format parity", () => {
  for (const [name, schema] of FORMATS) {
    it(`${name} matches Zod across the corpus`, () => {
      expectParity(schema, [...CORPUS], `fmt_${name.replace(/\W/g, "_")}`);
    });
  }
});

/**
 * A custom string format built from a `g`/`y`-flagged regex is STATEFUL in Zod,
 * and repeated parses of one schema disagree with each other.
 *
 * `z.stringFormat(name, /re/)` routes through `_stringFormat`, which keeps the
 * regex as `def.pattern` and ALSO closes over it as
 * `def.fn = (val) => fnOrRegex.test(val)`. `$ZodCustomStringFormat` validates by
 * calling `def.fn` and never touches `lastIndex`, so a `g`/`y` regex resumes
 * where the previous parse stopped. `$ZodCheckRegex` — what `.regex()` builds —
 * does an explicit `def.pattern.lastIndex = 0` first and stays stateless. The
 * codegen emits that reset for every flagged pattern, which is correct for
 * `.regex()` and wrong for a custom format, so those now delegate to Zod.
 *
 * Zod's sequence is pinned literally rather than compared side-by-side alone:
 * if an upstream Zod release starts resetting `lastIndex` in
 * `$ZodCustomStringFormat`, this fails loudly instead of quietly agreeing at a
 * new value and leaving the delegation unexplained.
 *
 * EVERY case below builds TWO schema instances, one per side. Sharing one
 * instance would let both sides advance the SAME RegExp's `lastIndex`, and the
 * comparison would pass no matter what the compiler did.
 */
describe("stateful custom string format (g/y flag)", () => {
  /** Four repeated parses of the same input, as a pass/fail sequence. */
  function sequence(parse: (value: unknown) => { success: boolean }, input: string): boolean[] {
    return [1, 2, 3, 4].map(() => parse(input).success);
  }

  for (const flag of ["g", "y"] as const) {
    it(`z.stringFormat with /ab/${flag} reproduces Zod's stateful sequence`, () => {
      // "abab" matches at index 0 then 2; the third test starts at lastIndex 4,
      // fails, and resets the cursor — so the fourth passes again.
      const zodSide = z.stringFormat("stateful", new RegExp("ab", flag));
      expect(sequence((v) => zodSide.safeParse(v), "abab")).toStrictEqual([
        true,
        true,
        false,
        true,
      ]);

      const compiledSide = z.stringFormat("stateful", new RegExp("ab", flag));
      const compiled = compileLikeProduction(compiledSide, `stateful_${flag}`);
      expect(sequence(compiled, "abab")).toStrictEqual([true, true, false, true]);
    });

    it(`z.stringFormat with /ab/${flag} delegates instead of compiling`, () => {
      const ir = extractSchema(z.stringFormat("stateful", new RegExp("ab", flag)), []);
      expect(ir.type).toBe("fallback");
    });

    // Control: $ZodCheckRegex resets lastIndex itself, so .regex() is stateless
    // on both sides and must keep compiling — this is not the bug.
    it(`.regex(/ab/${flag}) stays stateless and stays compiled`, () => {
      const zodSide = z.string().regex(new RegExp("ab", flag));
      expect(sequence((v) => zodSide.safeParse(v), "abab")).toStrictEqual([true, true, true, true]);

      const compiledSide = z.string().regex(new RegExp("ab", flag));
      const compiled = compileLikeProduction(compiledSide, `regex_${flag}`);
      expect(sequence(compiled, "abab")).toStrictEqual([true, true, true, true]);

      expect(extractSchema(z.string().regex(new RegExp("ab", flag)), []).type).not.toBe("fallback");
    });
  }

  // Control: an UNflagged custom format has no cursor to carry, so the fix must
  // not cost it its compiled path.
  it("an unflagged custom format still compiles", () => {
    const ir = extractSchema(z.stringFormat("digits", /^\d+$/), []);
    expect(ir.type).not.toBe("fallback");

    const zodSide = z.stringFormat("digits", /^\d+$/);
    expect(sequence((v) => zodSide.safeParse(v), "123")).toStrictEqual([true, true, true, true]);

    const compiled = compileLikeProduction(z.stringFormat("digits", /^\d+$/), "unflagged_custom");
    expect(sequence(compiled, "123")).toStrictEqual([true, true, true, true]);
  });

  // Control: Zod routes these built-ins through the same `_stringFormat` helper,
  // so they DO carry `def.fn` — only the unflagged pattern keeps them compiled.
  // Delegating on `def.fn` alone would silently cost all three their fast path.
  it.each([
    ["hostname", () => z.hostname()],
    ["hex", () => z.hex()],
    ["hash md5", () => z.hash("md5")],
  ])("built-in %s carries def.fn but still compiles", (_name, make) => {
    const schema = make();
    expect(typeof (schema._zod.def as { fn?: unknown }).fn).toBe("function");
    expect(extractSchema(schema, []).type).not.toBe("fallback");
  });
});

/**
 * WHICH FIELDS an `invalid_format` issue carries. Zod is not uniform here, and
 * the split is decided by which check instance ends up installed:
 *
 *   `$ZodCheckStringFormat.init` installs the DEFAULT pattern check with
 *   `inst._zod.check ??= …`, and that default pushes `origin: "string"` plus
 *   `pattern: def.pattern.toString()`. Any constructor that OVERRIDES
 *   `inst._zod.check` afterwards pushes its OWN issue instead — and none of
 *   them repeats `origin`/`pattern`.
 *
 * Four groups fall out, all represented below:
 *
 *   origin + pattern  the `??=` default survived — ipv4, uuid, email, iso.*,
 *                     lowercase/uppercase, `.regex()`, …
 *   origin, no pattern  $ZodCheckIncludes/StartsWith/EndsWith skip
 *                     $ZodCheckStringFormat entirely (they init from $ZodCheck
 *                     and assign `inst._zod.check` directly). The pattern they
 *                     build goes into the bag for JSON Schema, never the issue.
 *   neither           $ZodCustomStringFormat — `z.stringFormat()` and the
 *                     built-ins routed through `_stringFormat` (hex, hostname,
 *                     hash). Validates via `def.fn`, pushes `{code, format,
 *                     input}`. The compiler tells this group apart by the
 *                     structural `def.fn` marker, NOT by format name: a custom
 *                     format's name is user-chosen, so no list can enumerate it.
 *   url               $ZodURL also overrides. No `origin`; the hostname and
 *                     protocol notes carry `pattern` as `regex.source` — bare
 *                     source, unlike the default check's `.toString()`.
 *
 * The compiler emitted one uniform shape and was wrong in BOTH directions: it
 * dropped `origin` from includes/starts_with/ends_with and invented
 * `origin`+`pattern` for hex/hostname/hash/stringFormat. `expectParity` above
 * could not see it — it compares issue code, path and the first message only.
 *
 * Each case pins ZOD's own key set literally before comparing sides, so an
 * upstream change to either shape fails here instead of silently redefining
 * what parity means.
 */
describe("invalid_format issue fields", () => {
  /**
   * An issue reduced to comparable form: keys sorted, nothing dropped. Both
   * sides now `delete` `input` during finalization (zod in `util.finalizeIssue`,
   * the compiler in FAIL_CLASS_DECL), so an `input` key surviving on either side
   * is drift and must fail here rather than be normalized away.
   */
  function normalizeIssue(issue: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(issue).sort()) {
      out[key] = issue[key];
    }
    return out;
  }

  /** Zod's own first issue for an input it must reject. */
  function zodIssueFor(schema: z.ZodType, input: string, name: string): Record<string, unknown> {
    const result = schema.safeParse(input);
    const issue = result.error?.issues[0] as Record<string, unknown> | undefined;
    expect(issue, `${name}: input must be rejected by zod`).toBeDefined();
    return issue ?? {};
  }

  /** Zod's first issue and the compiled first issue for the same input. */
  function bothSides(
    schema: z.ZodType,
    input: string,
    name: string,
  ): { compiled: Record<string, unknown>; zod: Record<string, unknown> } {
    const zod = zodIssueFor(schema, input, name);
    const compiledResult = compileLikeProduction(schema, name)(input);
    expect(compiledResult.success, `${name}: input must be rejected by the compiler`).toBe(false);
    const compiled = compiledResult.success
      ? {}
      : (compiledResult.error.issues[0] as unknown as Record<string, unknown>);
    return { compiled: normalizeIssue(compiled), zod: normalizeIssue(zod) };
  }

  const FIELD_CASES: [name: string, schema: z.ZodType, input: string, zodKeys: string[]][] = [
    // ── the `??=` default check survived: origin + pattern ──────────────────
    ["ipv4", z.ipv4(), "nope", ["code", "format", "message", "origin", "path", "pattern"]],
    ["cidrv4", z.cidrv4(), "nope", ["code", "format", "message", "origin", "path", "pattern"]],
    ["mac", z.mac(), "nope", ["code", "format", "message", "origin", "path", "pattern"]],
    ["email", z.email(), "nope", ["code", "format", "message", "origin", "path", "pattern"]],
    ["uuid", z.uuid(), "nope", ["code", "format", "message", "origin", "path", "pattern"]],
    ["guid", z.guid(), "nope", ["code", "format", "message", "origin", "path", "pattern"]],
    ["cuid", z.cuid(), "nope", ["code", "format", "message", "origin", "path", "pattern"]],
    ["cuid2", z.cuid2(), "!!", ["code", "format", "message", "origin", "path", "pattern"]],
    ["ulid", z.ulid(), "nope", ["code", "format", "message", "origin", "path", "pattern"]],
    ["xid", z.xid(), "nope", ["code", "format", "message", "origin", "path", "pattern"]],
    ["ksuid", z.ksuid(), "nope", ["code", "format", "message", "origin", "path", "pattern"]],
    ["nanoid", z.nanoid(), "!!", ["code", "format", "message", "origin", "path", "pattern"]],
    ["e164", z.e164(), "nope", ["code", "format", "message", "origin", "path", "pattern"]],
    ["emoji", z.emoji(), "nope", ["code", "format", "message", "origin", "path", "pattern"]],
    [
      "iso.datetime",
      z.iso.datetime(),
      "nope",
      ["code", "format", "message", "origin", "path", "pattern"],
    ],
    ["iso.date", z.iso.date(), "nope", ["code", "format", "message", "origin", "path", "pattern"]],
    ["iso.time", z.iso.time(), "nope", ["code", "format", "message", "origin", "path", "pattern"]],
    [
      "iso.duration",
      z.iso.duration(),
      "nope",
      ["code", "format", "message", "origin", "path", "pattern"],
    ],
    [
      "lowercase",
      z.string().lowercase(),
      "ABC",
      ["code", "format", "message", "origin", "path", "pattern"],
    ],
    [
      "uppercase",
      z.string().uppercase(),
      "abc",
      ["code", "format", "message", "origin", "path", "pattern"],
    ],
    [
      "regex",
      z.string().regex(/^[ab]+$/),
      "zz",
      ["code", "format", "message", "origin", "path", "pattern"],
    ],
    // ── own check, no $ZodCheckStringFormat: origin, no pattern ─────────────
    [
      "includes",
      z.string().includes("ab"),
      "zz",
      ["code", "format", "includes", "message", "origin", "path"],
    ],
    [
      "includes (position)",
      z.string().includes("ab", { position: 2 }),
      "zz",
      ["code", "format", "includes", "message", "origin", "path"],
    ],
    [
      "startsWith",
      z.string().startsWith("ab"),
      "zz",
      ["code", "format", "message", "origin", "path", "prefix"],
    ],
    [
      "endsWith",
      z.string().endsWith("ab"),
      "zz",
      ["code", "format", "message", "origin", "path", "suffix"],
    ],
    [
      "startsWith (custom message)",
      z.string().startsWith("ab", "boom"),
      "zz",
      ["code", "format", "message", "origin", "path", "prefix"],
    ],
    // ── $ZodCustomStringFormat override: bare issue, neither field ──────────
    ["hex", z.hex(), "zz", ["code", "format", "message", "path"]],
    ["hostname", z.hostname(), "-bad-.com", ["code", "format", "message", "path"]],
    ["hash md5", z.hash("md5"), "zz", ["code", "format", "message", "path"]],
    ["hash sha256", z.hash("sha256"), "zz", ["code", "format", "message", "path"]],
    [
      "hash md5 (base64)",
      z.hash("md5", { enc: "base64" }),
      "zz",
      ["code", "format", "message", "path"],
    ],
    [
      "hash sha512 (base64url)",
      z.hash("sha512", { enc: "base64url" }),
      "zz",
      ["code", "format", "message", "path"],
    ],
    [
      "stringFormat (user-chosen name)",
      z.stringFormat("digits", /^\d+$/),
      "zz",
      ["code", "format", "message", "path"],
    ],
    [
      "stringFormat (custom message)",
      z.stringFormat("digits", /^\d+$/, "boom"),
      "zz",
      ["code", "format", "message", "path"],
    ],
    ["hex (custom message)", z.hex("boom"), "zz", ["code", "format", "message", "path"]],
    // ── $ZodURL override: no origin; pattern is regex.source on the notes ───
    ["url (unparseable)", z.url(), "not a url", ["code", "format", "message", "path"]],
    [
      "url (bad hostname)",
      z.url({ hostname: /^example\.com$/ }),
      "https://other.com",
      ["code", "format", "message", "note", "path", "pattern"],
    ],
    [
      "url (bad protocol)",
      z.url({ protocol: /^https$/ }),
      "ftp://example.com",
      ["code", "format", "message", "note", "path", "pattern"],
    ],
    // ── the `://` guard: an http(s) check without normalize rejects before the
    // parser and before the protocol probe, with a note and no pattern ───────
    [
      "httpUrl (bad protocol)",
      z.httpUrl(),
      "ftp://example.com",
      ["code", "format", "message", "note", "path"],
    ],
    [
      "httpUrl (bad format)",
      z.httpUrl(),
      "not a url",
      ["code", "format", "message", "note", "path"],
    ],
    [
      "httpUrl (bad protocol, normalize)",
      z.httpUrl({ normalize: true }),
      "ftp://example.com",
      ["code", "format", "message", "note", "path", "pattern"],
    ],
    [
      "httpUrl (unparseable, normalize)",
      z.httpUrl({ normalize: true }),
      "not a url",
      ["code", "format", "message", "path"],
    ],
  ];

  for (const [name, schema, input, zodKeys] of FIELD_CASES) {
    it(`${name} carries exactly ${zodKeys.join("+")}`, () => {
      const { compiled, zod } = bothSides(schema, input, `iff_${name.replace(/\W/g, "_")}`);
      // Pin zod first: an upstream reshuffle must fail as drift, not disappear
      // into a still-symmetric comparison.
      expect(Object.keys(zod), `${name}: zod's own field set`).toStrictEqual(zodKeys);
      // Then full equality — key set AND every value, so a pattern rendered as
      // `.source` where zod used `.toString()` fails too.
      expect(compiled, `${name}: compiled issue`).toStrictEqual(zod);
    });
  }

  // The formats whose pattern disagrees with their check delegate to zod (see
  // NON_AUTHORITATIVE_PATTERN_FORMATS), so their issue IS zod's — parity by
  // construction, not by the flag above. Asserted so a future attempt to
  // compile them cannot land without an explicit issue-shape decision.
  it.each([
    ["ipv6", z.ipv6(), "nope"],
    ["cidrv6", z.cidrv6(), "nope"],
    ["base64", z.base64(), "!!!"],
    ["base64url", z.base64url(), "!!!"],
    ["jwt", z.jwt(), "nope"],
    ["stringFormat (fn)", z.stringFormat("custom_fn", (v) => v.length === 3), "zz"],
  ])("delegated %s returns zod's own bare issue", (name, schema, input) => {
    expect(extractSchema(schema, []).type, `${name} must delegate`).toBe("fallback");
    const { compiled, zod } = bothSides(schema, input, `iff_del_${name.replace(/\W/g, "_")}`);
    expect(Object.keys(zod)).toStrictEqual(["code", "format", "message", "path"]);
    expect(compiled).toStrictEqual(zod);
  });

  // The IR flag is the whole mechanism, so assert it agrees with zod rather
  // than only that the emitted issue happens to. `url` is excluded: it is
  // emitted by slowUrlCheck, which reproduces $ZodURL's own three issues.
  it.each([
    ["ipv4", z.ipv4(), "nope", false],
    ["uuid", z.uuid(), "nope", false],
    ["regex", z.string().regex(/^[ab]+$/), "zz", false],
    ["lowercase", z.string().lowercase(), "ABC", false],
    ["hex", z.hex(), "zz", true],
    ["hostname", z.hostname(), "-bad-.com", true],
    ["hash sha256", z.hash("sha256"), "zz", true],
    ["stringFormat", z.stringFormat("digits", /^\d+$/), "zz", true],
  ])("%s carries bareIssue=%o in the IR, matching zod", (name, schema, input, bare) => {
    const ir = extractSchema(schema, []);
    expect(ir.type, `${name} must compile`).toBe("string");
    const check = (ir as { checks: { kind: string; bareIssue?: boolean }[] }).checks.find(
      (c) => c.kind === "string_format",
    );
    expect(check?.bareIssue ?? false, `${name}: IR flag`).toBe(bare);
    // ...and the flag is only right if zod really omits origin for exactly
    // these — `def.fn` is the discriminator, so check it lines up too.
    expect("origin" in zodIssueFor(schema, input, name), `${name}: zod's origin`).toBe(!bare);
    expect(typeof (schema._zod.def as { fn?: unknown }).fn === "function", `${name}: def.fn`).toBe(
      bare,
    );
  });
});

/**
 * A custom format's NAME is user-chosen, so it cannot identify which validator
 * Zod runs — `z.stringFormat("email", fn)` is a $ZodCustomStringFormat that
 * validates through `def.fn`, sharing nothing with `z.email()` but the label.
 *
 * Two name-keyed decisions read that label as proof of a built-in and inverted
 * the verdict in BOTH directions for a format merely named after one:
 *
 *   PATTERNLESS_FORMATS ({email, uuid, url}) lets a check with no `def.pattern`
 *   compile anyway, because codegen substitutes a known regex
 *   (EMAIL_REGEX_SOURCE / UUID_REGEX_SOURCE). A custom format built from a
 *   FUNCTION has no pattern and landed there, so `z.stringFormat("email",
 *   (v) => v.length === 3)` compiled to the EMAIL regex: it rejected "abc"
 *   (Zod accepts) and accepted "a@b.co" (Zod rejects).
 *
 *   `format === "url"` routes to slowUrlCheck (the URL-parser probe) in both
 *   the extractor and codegen, discarding `def.pattern` outright — so a custom
 *   format named "url" was mis-compiled in its REGEX form too, not just its
 *   function form.
 *
 * The fix keys on the structural `def.fn` marker (isCustomStringFormat), never
 * the name. Which way each form goes is decided by what is actually available
 * to compile: the function form has only `def.fn`, which lives in the user's
 * closure and cannot be emitted, so it delegates; the regex form carries the
 * user's OWN `def.pattern`, which is exactly what `def.fn` tests, so it keeps
 * its compiled path.
 *
 * Zod's verdicts are pinned literally, not just compared side-by-side: if an
 * upstream release ever made `z.stringFormat("email", fn)` consult the built-in
 * email check, this must fail loudly rather than quietly agree with it.
 */
describe("custom string format colliding with a built-in format name", () => {
  /** A built-in-VALID value per colliding name — Zod's custom fn rejects each. */
  const BUILTIN_VALID = {
    email: "a@b.co",
    url: "https://example.com",
    uuid: "550e8400-e29b-41d4-a716-446655440000",
  } as const;

  const COLLIDING = ["email", "uuid", "url"] as const;

  // The predicate is deliberately unrelated to every built-in it is named
  // after, so "compiled against the built-in" and "compiled against the user's
  // function" disagree on BOTH inputs below.
  const lengthIs3 = (value: string) => value.length === 3;

  for (const name of COLLIDING) {
    it(`z.stringFormat("${name}", fn) delegates instead of compiling the built-in`, () => {
      expect(extractSchema(z.stringFormat(name, lengthIs3), []).type).toBe("fallback");
    });

    it(`z.stringFormat("${name}", fn) matches Zod in both directions`, () => {
      const schema = z.stringFormat(name, lengthIs3);
      const builtinValid = BUILTIN_VALID[name];

      // Pin Zod: the custom predicate decides, and it is the built-in's inverse.
      expect(schema.safeParse("abc").success, `${name}: zod accepts "abc"`).toBe(true);
      expect(schema.safeParse(builtinValid).success, `${name}: zod rejects ${builtinValid}`).toBe(
        false,
      );

      expectParity(schema, ["abc", builtinValid, "", "ab", "abcd"], `collide_fn_${name}`);
    });

    // A custom format built from a REGEX carries the user's own `def.pattern`,
    // and that pattern IS what `def.fn` tests — so it stays compiled. Delegating
    // it too would be safe but would cost every such schema its fast path.
    it(`z.stringFormat("${name}", /^[ab]+$/) stays compiled and matches Zod`, () => {
      const make = () => z.stringFormat(name, /^[ab]+$/);
      const ir = extractSchema(make(), []);
      expect(ir.type, `${name}: regex form must stay compiled`).not.toBe("fallback");
      // ...and compiled against the USER's pattern, not a name-matched built-in.
      const check = (ir as { checks: { kind: string; pattern?: string }[] }).checks.find(
        (c) => c.kind === "string_format",
      );
      expect(check?.pattern, `${name}: the user's pattern is what compiles`).toBe("^[ab]+$");

      const schema = make();
      expect(schema.safeParse("aab").success, `${name}: zod accepts "aab"`).toBe(true);
      expect(schema.safeParse(BUILTIN_VALID[name]).success, `${name}: zod rejects builtin`).toBe(
        false,
      );

      expectParity(make(), ["aab", BUILTIN_VALID[name], "zzz", ""], `collide_re_${name}`);
    });
  }

  // Control: the genuine built-ins must keep their compiled path — the fix
  // narrows the name-keyed branches, and narrowing them too far would silently
  // delegate the three formats those branches exist to serve.
  it.each([
    ["email", () => z.email(), "a@b.co", "abc"],
    ["uuid", () => z.uuid(), "550e8400-e29b-41d4-a716-446655440000", "abc"],
    ["url", () => z.url(), "https://example.com", "abc"],
  ])("built-in z.%s() still compiles", (name, make, good, bad) => {
    expect(extractSchema(make(), []).type, `${name} must compile`).not.toBe("fallback");
    expect(typeof (make()._zod.def as { fn?: unknown }).fn, `${name} has no def.fn`).not.toBe(
      "function",
    );
    expectParity(make(), [good, bad], `builtin_${name}`);
  });
});
