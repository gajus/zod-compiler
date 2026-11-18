import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import { generateValidator } from "#src/core/codegen/index.js";
import {
  HTTP_URL_FAST_ACCEPT_SOURCE,
  URL_DOMAIN_SOURCE,
  URL_FAST_ACCEPT_SOURCE,
  urlFastAccept,
} from "#src/core/codegen/schemas/string.js";
import type { RefEntry } from "#src/core/extract/index.js";
import { extractSchema } from "#src/core/extract/index.js";
import type { CheckStringFormat } from "#src/core/types.js";
import { compileLikeProduction, expectLeanParity, expectParity } from "../../parity-harness.js";

/**
 * The URL fast-accept: a regex that settles `z.url()` / `z.httpUrl()` for an
 * ordinary http(s) URL without running the URL parser (see urlFastAccept).
 *
 * It is allowed to be narrow — whatever it does not match is parsed exactly as
 * before — but it is not allowed to be WRONG: a string it accepts must be one
 * zod accepts, and the value zod writes back for it must be the trimmed input,
 * because that is what the generated code yields without asking. Both halves
 * are checked here against zod itself, in the one direction that matters.
 */
const FAST_URL = new RegExp(URL_FAST_ACCEPT_SOURCE);
const FAST_HTTP = new RegExp(HTTP_URL_FAST_ACCEPT_SOURCE);
const zodUrl = z.url();
const zodHttpUrl = z.httpUrl();

/** Fail unless zod accepts `raw` and writes back its trimmed self. */
function expectZodAgrees(schema: z.ZodType, raw: string, label: string): void {
  const result = schema.safeParse(raw);
  if (!result.success || result.data !== raw.trim()) {
    expect.fail(
      `${label} accepts ${JSON.stringify(raw)} but zod ${
        result.success ? `yields ${JSON.stringify(result.data)}` : "rejects it"
      }`,
    );
  }
}

/** Run one candidate through both patterns, as generated code does: on the trimmed value. */
function check(raw: string): { url: boolean; http: boolean } {
  const trimmed = raw.trim();
  const url = FAST_URL.test(trimmed);
  const http = FAST_HTTP.test(trimmed);
  if (url) expectZodAgrees(zodUrl, raw, "URL_FAST_ACCEPT_SOURCE");
  if (http) expectZodAgrees(zodHttpUrl, raw, "HTTP_URL_FAST_ACCEPT_SOURCE");
  return { url, http };
}

describe("url fast-accept — pinned to the live zod", () => {
  it("knows the hostname and protocol patterns z.httpUrl() installs", () => {
    expect(z.regexes.domain.source).toBe(URL_DOMAIN_SOURCE);
    expect(z.regexes.domain.flags).toBe("");
    expect(z.regexes.httpProtocol.source).toBe("^https?$");
    expect(z.regexes.httpProtocol.flags).toBe("");
  });

  it("is offered exactly where the parsed URL is not needed", () => {
    const format = (extra: Partial<CheckStringFormat>): CheckStringFormat => ({
      kind: "string_format",
      format: "url",
      ...extra,
    });
    const http = { protocol: "^https?$", hostname: URL_DOMAIN_SOURCE };

    expect(urlFastAccept(format({}))).toBe(URL_FAST_ACCEPT_SOURCE);
    expect(urlFastAccept(format({ protocol: "^https?$" }))).toBe(URL_FAST_ACCEPT_SOURCE);
    expect(urlFastAccept(format(http))).toBe(HTTP_URL_FAST_ACCEPT_SOURCE);
    expect(urlFastAccept(format({ hostname: URL_DOMAIN_SOURCE }))).toBe(
      HTTP_URL_FAST_ACCEPT_SOURCE,
    );
    // `normalize` writes back url.href, which only the parser can produce.
    expect(urlFastAccept(format({ normalize: true }))).toBeNull();
    expect(urlFastAccept(format({ ...http, normalize: true }))).toBeNull();
    // A constraint that is not zod's own default has to see the parsed URL.
    expect(urlFastAccept(format({ protocol: "^ftp$" }))).toBeNull();
    expect(urlFastAccept(format({ hostname: "^example\\.com$" }))).toBeNull();
    expect(urlFastAccept(format({ ...http, hostnameFlags: "i" }))).toBeNull();
    expect(urlFastAccept(format({ ...http, protocolFlags: "i" }))).toBeNull();
  });

  it("extracts z.url() and z.httpUrl() into the shapes it recognizes", () => {
    const checkOf = (schema: unknown): CheckStringFormat =>
      (extractSchema(schema, []) as { checks: CheckStringFormat[] }).checks[0] as CheckStringFormat;

    expect(urlFastAccept(checkOf(z.url()))).toBe(URL_FAST_ACCEPT_SOURCE);
    expect(urlFastAccept(checkOf(z.httpUrl()))).toBe(HTTP_URL_FAST_ACCEPT_SOURCE);
    expect(urlFastAccept(checkOf(z.url({ normalize: true })))).toBeNull();
    expect(urlFastAccept(checkOf(z.url({ hostname: /^example\.com$/ })))).toBeNull();
  });
});

describe("url fast-accept — matches the URLs it is for", () => {
  const ORDINARY = [
    "https://example.com",
    "http://example.com/",
    "https://example.com/images/product-1.jpg",
    "https://cdn.shop.example.co.uk/a/b/c/image-0001@2x.webp?width=1200&fit=cover#top",
    "https://my-site.example.com:8443/path?q=a b&r=é#frag",
    "https://example.com?x=1",
    "https://example.com#top",
    "https://sub-domain.example.io/%7Euser/%zz",
    "https://example.com/a\\b",
  ];

  it("accepts ordinary http(s) URLs under both patterns", () => {
    for (const url of ORDINARY) {
      expect(check(url), url).toStrictEqual({ url: true, http: true });
    }
  });

  it("accepts a dotless host for z.url() only, as zod's domain pattern requires a TLD", () => {
    for (const url of ["http://localhost", "http://localhost:3000/api", "https://intranet/x"]) {
      expect(check(url), url).toStrictEqual({ url: true, http: false });
    }
  });

  it("is applied to the trimmed value, whose write-back is that value", () => {
    expect(check("  https://example.com/a  ")).toStrictEqual({ url: true, http: true });
    expect(check("\nhttps://example.com/a\t")).toStrictEqual({ url: true, http: true });
  });

  it("leaves everything unusual to the parser", () => {
    const UNUSUAL = [
      "HTTPS://example.com", // scheme case
      "https://Example.com", // host case
      "https://example.com.", // trailing dot
      "https://user:pass@example.com", // credentials
      "https://127.0.0.1", // an address, not a domain
      "https://[::1]/", // IPv6 literal
      "https://example.1", // last label is a number
      "https://example.0x10", // …in hexadecimal
      "https://xn--bcher-kva.example", // punycode
      "https://a.xn--p1ai", // punycode TLD
      "https://bücher.example", // IDN
      "https://example.com:65536", // port out of range
      "https://example.com:12345", // five digits: in range, but not proven here
      "https://example.com:", // empty port
      "https://exa_mple.com", // underscore
      "https://example..com", // empty label
      "https://.example.com",
      "https://example.com\\path", // backslash ends the authority
      "https://example.com/a\tb", // tab: zod deletes it from the value
      "https://example.com/a\nb",
      "https://exa\nmple.com/",
      "ftp://example.com",
      "https:/example.com",
      "https:example.com",
      "//example.com",
      "example.com",
      "",
    ];
    for (const url of UNUSUAL) {
      expect(FAST_URL.test(url), url).toBe(false);
      expect(FAST_HTTP.test(url), url).toBe(false);
    }
  });

  it("holds z.httpUrl() to zod's domain shape and its 63-character bounds", () => {
    const label = (length: number): string => "a".repeat(length);
    // Total host length is what the pattern counts; 63 is the widest it takes.
    expect(FAST_HTTP.test(`https://${label(59)}.com/`)).toBe(true);
    expect(FAST_HTTP.test(`https://${label(60)}.com/`)).toBe(false);
    for (const host of ["-a.com", "a-.com", "a.-b.com", "a.b-.com", "a.c", "a.c0m", "a.co-m"]) {
      expect(FAST_HTTP.test(`https://${host}/`), host).toBe(false);
    }
    // …all of which zod settles itself, either way.
    for (const host of [`${label(60)}.com`, `${label(63)}.com`, `${label(64)}.com`, "a-.com"]) {
      const raw = `https://${host}/`;
      expect(compileLikeProduction(z.httpUrl(), "bound")(raw).success, host).toBe(
        zodHttpUrl.safeParse(raw).success,
      );
    }
  });
});

/**
 * Soundness sweeps. The host is where the parser can fail, so it gets an
 * EXHAUSTIVE pass over every short string of an alphabet chosen to hit each
 * rule the pattern relies on (label structure, `xn--`, a numeric or hex last
 * label, dots), then a random pass over longer structured candidates with the
 * rest of the URL around them.
 */
describe("url fast-accept — never accepts what zod does not", () => {
  it("exhaustively, over short hosts", () => {
    const alphabet = ["a", "x", "n", "0", "1", "-", "."];
    let accepted = 0;
    let candidates = 0;
    const visit = (host: string, depth: number): void => {
      if (host !== "") {
        // A port out of range and a tab ride along, so a pattern that let
        // either through would be caught on every host it accepts.
        for (const tail of ["", "/p", ":80", "?q", ":65536", "/a\tb"]) {
          candidates++;
          const result = check(`http://${host}${tail}`);
          if (result.url || result.http) accepted++;
        }
      }
      if (depth === 6) return;
      for (const char of alphabet) visit(host + char, depth + 1);
    };
    visit("", 0);
    // The same rules in hosts longer than six characters can spell.
    for (const host of [
      "xn--a",
      "xn--a.aa",
      "a.xn--a",
      "0x1a.aa",
      "aa.0x1a",
      "aa.0xaa",
      "a.b.c.d.ee",
    ]) {
      check(`https://${host}/`);
    }
    expect(candidates).toBeGreaterThan(800_000);
    expect(accepted).toBeGreaterThan(10_000);
  });

  it("over random structured candidates", () => {
    let seed = 0x2f6e2b1;
    const random = (): number => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 4294967296;
    };
    const pick = <T>(values: readonly T[]): T => values[Math.floor(random() * values.length)] as T;
    const schemes = [
      "http://",
      "https://",
      "HTTP://",
      "hTtPs://",
      "http:/",
      "http:",
      "ftp://",
      "https:///",
      "http://@",
      "http://u:p@",
      "",
      "https://[::1]",
      "http://%41",
      " http://",
      "\thttps://",
    ];
    const hostAtoms = [
      "a",
      "b",
      "x",
      "n",
      "-",
      "--",
      ".",
      "..",
      "0",
      "1",
      "9",
      "xn--",
      "xn",
      "com",
      "example",
      "0x",
      "0x1f",
      "f",
      "A",
      "Z",
      "localhost",
      "_",
      "%",
      "é",
      " ",
      "127",
      "256",
      "www",
      "co",
      "uk",
      "xn--nxasmq6b",
      "xn--a",
      "XN--",
      "xN--",
      "e",
      "0X",
      "1e3",
    ];
    const tailAtoms = [
      "",
      "/",
      "/a",
      "?q=1",
      "#f",
      ":80",
      ":8080",
      ":99999",
      ":65535",
      ":",
      ":0",
      ":abc",
      "/a b",
      "/%zz",
      "/\t",
      "/\n",
      "\\x",
      "/é",
      "/..//./x",
      "@",
      "/a@b",
      "?",
      "#",
      "/[",
      "/]",
      "/{}",
      "/ ",
      ":1/",
      ":12345/",
      "\r",
      "\t",
      " ",
      " ",
      "/\u0000",
      "/\u007f",
      "/\ud800",
    ];
    const ends = ["", "", "", "", "", "", "", "", " ", "\n", "\t "];

    let accepted = 0;
    for (let index = 0; index < 150_000; index++) {
      let host = "";
      for (let count = 1 + Math.floor(random() * 6); count > 0; count--) host += pick(hostAtoms);
      let tail = "";
      for (let count = Math.floor(random() * 3); count > 0; count--) tail += pick(tailAtoms);
      const result = check(pick(schemes) + host + tail + pick(ends));
      if (result.url || result.http) accepted++;
    }
    expect(accepted).toBeGreaterThan(1_000);
  });
});

describe("url fast-accept — generated code", () => {
  function buildFunction(schema: unknown): string {
    const refEntries: RefEntry[] = [];
    const ir = extractSchema(schema, refEntries);
    const result = generateValidator(ir, "u", { refCount: refEntries.length });
    return result.code.split("\n").find((line) => line.startsWith("function __vb_")) ?? "";
  }

  it("tests the pattern first and parses only on a miss", () => {
    const build = buildFunction(z.url());
    expect(build).toMatch(
      /(__but_\d+)=(__bs_\d+)\.trim\(\);if\(__re_urlOk_\d+\.test\(\1\)\)\{\2=\1;\}else\{if\(!__zcUrl\(\1\)\)return /,
    );
  });

  it("keeps the parser, the guard and both tests behind the miss for z.httpUrl()", () => {
    const build = buildFunction(z.httpUrl());
    const fast = build.indexOf("__re_urlOk_");
    expect(fast).toBeGreaterThan(0);
    for (const later of ["__re_httpUrl_", "new URL(", ".hostname", ".protocol"]) {
      expect(build.indexOf(later), later).toBeGreaterThan(fast);
    }
  });

  it("emits no fast-accept where the parsed URL is the output", () => {
    expect(buildFunction(z.url({ normalize: true }))).not.toContain("__re_urlOk_");
    expect(buildFunction(z.url({ hostname: /^example\.com$/ }))).not.toContain("__re_urlOk_");
  });

  // Both sides of the branch, in the build pass and in the eager walk (the
  // `.catch()` sibling keeps a schema off the build pass), inline and lean.
  const INPUTS = [
    "https://example.com/a",
    "  https://example.com/a  ",
    "http://localhost:3000/x",
    "https://Example.com/a",
    "https://exa\nmple.com/a",
    "https://example.com/a\tb",
    "https://127.0.0.1/",
    "https://bücher.example/",
    "https://example.com:99999",
    "http:example.com",
    "ftp://example.com/",
    "not a url",
    "",
    42,
    null,
  ];
  const SCHEMAS: [string, () => z.ZodType][] = [
    ["z.url()", () => z.url()],
    ["z.httpUrl()", () => z.httpUrl()],
    ["z.url().max()", () => z.url().max(24)],
    ["a field", () => z.object({ u: z.url(), h: z.httpUrl().optional() })],
    ["on the eager walk", () => z.object({ u: z.url(), h: z.httpUrl(), c: z.number().catch(0) })],
    ["an array of urls", () => z.array(z.url())],
  ];

  for (const [label, make] of SCHEMAS) {
    it(`matches zod: ${label}`, () => {
      const wrap = (value: unknown): unknown => {
        if (label === "a field") return { u: value, h: value };
        if (label === "on the eager walk") return { u: value, h: value, c: "bad" };
        if (label === "an array of urls") return [value, "https://example.com/z"];
        return value;
      };
      const inputs = INPUTS.map(wrap);
      expectParity(make(), inputs);
      expectLeanParity(make(), inputs);
    });
  }
});
