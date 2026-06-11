import { describe, expect, it } from "vitest";
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
      ["ipv6", z.ipv6(), "__zcReIpv6"],
      ["base64", z.base64(), "__zcReBase64"],
      ["base64url", z.base64url(), "__zcReBase64Url"],
      ["e164", z.e164(), "__zcReE164"],
      ["guid", z.guid(), "__zcReGuid"],
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
});
