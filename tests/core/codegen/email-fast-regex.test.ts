import { describe, expect, it } from "vitest";
import {
  EMAIL_FAST_REGEX_SOURCE,
  EMAIL_REGEX_SOURCE,
  lookupFastRegexSource,
} from "#src/core/codegen/well-known-regex.js";

/**
 * EMAIL_FAST_REGEX_SOURCE must accept/reject EXACTLY the same strings as zod's
 * email regex. The fast pattern is what generated validators execute; the
 * original pattern is what issues report. Any divergence is a parity bug.
 */
describe("EMAIL_FAST_REGEX_SOURCE equivalence", () => {
  const original = new RegExp(EMAIL_REGEX_SOURCE);
  const fast = new RegExp(EMAIL_FAST_REGEX_SOURCE);

  it("is registered as the email rewrite", () => {
    expect(lookupFastRegexSource(EMAIL_REGEX_SOURCE)).toBe(EMAIL_FAST_REGEX_SOURCE);
  });

  it("matches structured cases identically", () => {
    const cases = [
      "alice@example.com",
      "a@b.co",
      "a.b.c@sub.domain.org",
      "first.last+tag@mail.subdomain-host.example.travel",
      "a+b-c_d'e@my-host0.example.travel",
      "a@0start.co",
      "A_Z'9@X-1.Ab",
      // local-part dot rules
      "a..b@x.co",
      ".a@x.co",
      "a.@x.co",
      "..@x.co",
      // final local char must be [A-Za-z0-9_+-]
      "a'@x.co",
      "'a@x.co",
      "'@x.co",
      "-@x.co",
      "+@x.co",
      "_@x.co",
      // domain shape
      "a@x.c",
      "a@x.c0",
      "a@x.co0",
      "a@-x.co",
      "a@x-.co",
      "a@x..co",
      "a@.x.co",
      "a@x.co.",
      "a@x",
      "a@x.",
      "@x.co",
      "a@",
      "a@@x.co",
      "",
      "a",
      "a@x.co m",
      " a@x.co",
    ];
    for (const s of cases) {
      expect(fast.test(s), JSON.stringify(s)).toBe(original.test(s));
    }
  });

  it("matches exhaustively for all short strings over the email alphabet", () => {
    // Every string of length ≤ 4 over a covering alphabet (dot/quote/at/hyphen
    // edge chars + representatives of each character class).
    const alphabet = ["a", "Z", "0", ".", "'", "+", "-", "_", "@"];
    let stack = [""];
    let count = 0;
    while (stack.length > 0) {
      const next: string[] = [];
      for (const s of stack) {
        count++;
        expect(fast.test(s), JSON.stringify(s)).toBe(original.test(s));
        if (s.length < 4) {
          for (const ch of alphabet) next.push(s + ch);
        }
      }
      stack = next;
    }
    expect(count).toBeGreaterThan(7000);
  });

  it("matches on random fuzz", () => {
    const chars = "abcXYZ019.'+-_@!#~ /";
    let seed = 0x2f6e2b1;
    const rnd = () => {
      // xorshift — deterministic fuzz
      seed ^= seed << 13;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      return (seed >>> 0) / 0xffffffff;
    };
    for (let i = 0; i < 100_000; i++) {
      let s = "";
      const len = 1 + ((i * 7) % 48);
      for (let j = 0; j < len; j++) s += chars[(rnd() * chars.length) | 0];
      expect(fast.test(s), JSON.stringify(s)).toBe(original.test(s));
    }
  });
});
