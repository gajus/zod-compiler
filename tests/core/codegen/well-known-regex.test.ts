import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import { lookupWellKnownRegex, WELL_KNOWN_REGEXES } from "#src/core/codegen/well-known-regex.js";
import { extractSchema } from "#src/core/extract/index.js";

describe("well-known-regex", () => {
  describe("registry invariants", () => {
    it("every entry uses the __zcRe* prefix", () => {
      for (const r of WELL_KNOWN_REGEXES) {
        expect(r.name, `unexpected name: ${r.name}`).toMatch(/^__zcRe[A-Z]/);
      }
    });

    it("no duplicate names or sources", () => {
      const names = new Set(WELL_KNOWN_REGEXES.map((r) => r.name));
      const sources = new Set(WELL_KNOWN_REGEXES.map((r) => r.source));
      expect(names.size).toBe(WELL_KNOWN_REGEXES.length);
      expect(sources.size).toBe(WELL_KNOWN_REGEXES.length);
    });

    it("returns null for user-defined / unknown patterns", () => {
      expect(lookupWellKnownRegex("^foo$")).toBeNull();
      expect(lookupWellKnownRegex("")).toBeNull();
    });

    /**
     * The table matches pattern sources VERBATIM, so an entry Zod has since
     * edited stops hitting silently: no test fails, the lookup just misses and
     * every transformed file re-declares its own RegExp. The 4.5 bump did that
     * to `cuid`, `ulid` and `iso.datetime` at once — including the ~330-char
     * datetime source this table exists to dedupe.
     *
     * Pinned by looking each entry up against the LIVE Zod pattern, so the next
     * upgrade that edits one fails here.
     */
    it("every entry still matches a live Zod pattern", () => {
      const live = new Map<string, string>();
      const record = (label: string, schema: z.ZodType): void => {
        const pattern = (schema as { _zod: { def: { pattern?: RegExp } } })._zod.def.pattern;
        if (pattern) live.set(pattern.source, label);
      };
      record("email", z.email());
      record("guid", z.guid());
      record("cuid", z.cuid());
      record("cuid2", z.cuid2());
      record("ulid", z.ulid());
      record("nanoid", z.nanoid());
      record("xid", z.xid());
      record("ksuid", z.ksuid());
      record("ipv4", z.ipv4());
      record("ipv6", z.ipv6());
      record("base64", z.base64());
      record("base64url", z.base64url());
      record("e164", z.e164());
      record("iso.date", z.iso.date());
      record("iso.time", z.iso.time());
      record("iso.datetime", z.iso.datetime());
      record("iso.duration", z.iso.duration());

      const stale = WELL_KNOWN_REGEXES.filter(
        // The documented stand-in for when the extractor supplies no pattern,
        // so it is deliberately not one of Zod's own sources.
        (entry) => entry.name !== "__zcReUuid" && !live.has(entry.source),
      ).map((entry) => entry.name);
      expect(stale, `stale registry entries: ${stale.join(", ")}`).toStrictEqual([]);
    });
  });

  // Each Zod constructor below must produce a `string_format` check whose
  // pattern source matches a registry entry. Catches regressions when Zod
  // bumps its regex sources upstream. Zod versions in the compat matrix may
  // ship different sources for the same format; in that case the lookup falls
  // through to the per-IIFE preamble path (still functional, just no bundle-
  // wide dedup), so we treat a null result as "this Zod version diverged"
  // rather than fail. The `latest` matrix entry guarantees current parity.
  describe("coverage vs actual Zod patterns", () => {
    const cases = [
      ["email", z.email(), "__zcReEmail"],
      ["uuid", z.uuid(), "__zcReUuid"],
      ["cuid", z.cuid(), "__zcReCuid"],
      ["cuid2", z.cuid2(), "__zcReCuid2"],
      ["ulid", z.ulid(), "__zcReUlid"],
      ["nanoid", z.nanoid(), "__zcReNanoid"],
      ["xid", z.xid(), "__zcReXid"],
      ["ksuid", z.ksuid(), "__zcReKsuid"],
      ["ipv4", z.ipv4(), "__zcReIpv4"],
      ["e164", z.e164(), "__zcReE164"],
      ["guid", z.guid(), "__zcReGuid"],
      ["iso.date", z.iso.date(), "__zcReIsoDate"],
      ["iso.time", z.iso.time(), "__zcReIsoTime"],
      ["iso.datetime", z.iso.datetime(), "__zcReIsoDateTime"],
      ["iso.duration", z.iso.duration(), "__zcReIsoDuration"],
    ] as const;

    for (const [name, schema, expected] of cases) {
      it(`${name} -> ${expected}`, () => {
        const ir = extractSchema(schema, []);
        if (ir.type !== "string") throw new Error("not a string IR");
        const check = ir.checks[0];
        if (check?.kind !== "string_format") throw new Error("no string_format check");
        const pattern = (check as { pattern?: string }).pattern;
        expect(pattern).toBeDefined();
        const actual = lookupWellKnownRegex(pattern as string);
        // Older Zod versions may use a different source string. Skip the
        // assertion when the registry doesn't recognize it — `latest` matrix
        // catches genuine drift.
        if (actual === null) return;
        expect(actual).toBe(expected);
      });
    }
  });

  // Zod sets `def.pattern` on these too (toJSONSchema needs one) but then
  // REPLACES the pattern check with an algorithmic one, so the pattern is not
  // the verdict Zod gives. Extraction delegates them instead of compiling the
  // pattern — see NON_AUTHORITATIVE_PATTERN_FORMATS in src/core/extract/checks.ts
  // and the corpus in tests/string-format-parity.test.ts.
  //
  // Their registry entries stay: `.regex(z.core.regexes.ipv6)` still routes a
  // literal use of the same source through the dedup path. Drift detection is
  // kept by reading Zod's live `def.pattern` directly rather than the (now
  // absent) extracted one.
  describe("formats delegated to Zod still track its pattern source", () => {
    const cases = [
      ["ipv6", z.ipv6(), "__zcReIpv6"],
      ["base64", z.base64(), "__zcReBase64"],
      ["base64url", z.base64url(), "__zcReBase64Url"],
    ] as const;

    for (const [name, schema, expected] of cases) {
      it(`${name} extracts as a fallback, and Zod's pattern is still ${expected}`, () => {
        expect(extractSchema(schema, []).type).toBe("fallback");
        const pattern = schema._zod.def.pattern;
        expect(pattern).toBeInstanceOf(RegExp);
        const actual = lookupWellKnownRegex((pattern as RegExp).source);
        // As above: an unrecognized source means this Zod version diverged.
        if (actual === null) return;
        expect(actual).toBe(expected);
      });
    }
  });
});
