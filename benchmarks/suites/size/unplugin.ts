/**
 * Multi-file dedup verification + size report.
 *
 * Builds a 5-file fixture (10 schemas, all sharing z.email() and z.uuid())
 * with the unplugin in autoDiscover mode and measures the resulting bundle.
 *
 * The cross-file dedup objective: well-known regexes (`__zcReUuid`), the
 * `z.email()` scanner (`__zcEmail`) and shared helpers (`__zcMkv`, `__zcFin`,
 * issue factories) must appear exactly ONCE in the bundle no matter how many
 * files reference them.
 *
 * Run: vp run size:unplugin
 */
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { build } from "vite";
import zodCompiler from "zod-compiler/vite";

type ZodCompilerPlugin = ReturnType<typeof zodCompiler>;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_ENTRY = path.resolve(__dirname, "../../fixtures/multi-file/main.ts");

interface BundleResult {
  raw: number;
  gzip: number;
  /** Number of occurrences of each well-known dedup probe in the bundled chunk. */
  probes: {
    emailScanner: number;
    emailSrcString: number;
    mkvFactory: number;
    uuidRegex: number;
    uuidSrcString: number;
  };
}

async function bundle(plugins: ZodCompilerPlugin[]): Promise<BundleResult> {
  const result = await build({
    // This report supplies its own plugin. Loading benchmarks/vite.config.ts
    // would apply zod-compiler a second time and invalidate the dedup probes.
    configFile: false,
    logLevel: "silent",
    // Vite/Rollup type drift between hoisted versions; runtime shape is correct.
    // oxlint-disable-next-line typescript/no-explicit-any -- cross-version Plugin type incompatibility
    plugins: plugins as any,
    build: {
      lib: {
        entry: FIXTURE_ENTRY,
        formats: ["es"],
        fileName: () => "multi.js",
      },
      rollupOptions: { external: ["zod"] },
      write: false,
      minify: true,
    },
  });

  const output = Array.isArray(result) ? result[0] : result;
  if (!output || !("output" in output)) {
    throw new Error("Unexpected build output shape");
  }
  const chunk = output.output.find((o) => o.type === "chunk");
  if (chunk?.type !== "chunk") {
    throw new Error("No code chunk in bundle output");
  }

  const code = chunk.code;
  return {
    raw: Buffer.byteLength(code, "utf-8"),
    gzip: gzipSync(code).length,
    probes: {
      // Distinctive fragments of each shared artifact; they survive minification.
      // z.email() runs the `__zcEmail` scanner, not a RegExp (see ZC_EMAIL_DECL),
      // so its probe is a fragment of CODE rather than of a pattern string — see
      // EMAIL_SCANNER_PROBE. The fast email regex is no longer referenced by any
      // validator and is tree-shaken out, which is why probing for it reported a
      // dedup failure on a bundle that had none. __zcReEmailSrc still carries
      // zod's original pattern for issues.
      emailScanner: count(code, EMAIL_SCANNER_PROBE),
      emailSrcString: count(code, "(?!.*"),
      // __zcReUuid is built with counted repeats unrolled into explicit
      // repetition, so only it has a character class sitting directly before
      // `-[1-8]`; __zcReUuidSrc keeps zod's original `{8}` for issue reporting.
      // Each must still appear exactly once no matter how many files use uuid.
      uuidRegex: count(code, "]-[1-8]"),
      uuidSrcString: count(code, "[0-9a-fA-F]{8}"),
      // Standard Schema vendor property inside __zcMkv. It survives
      // minification and occurs once in the helper (zod is external).
      mkvFactory: count(code, "vendor:"),
    },
  };
}

/**
 * The one stretch of `__zcEmail` nothing else in a bundle spells: the local
 * part's punctuation test — `_`, `'`, `+`, `-` by character code, in that order
 * (`c===95||c===39||c===43||c===45`). A scanner has no string literal to look
 * for, so the probe has to tolerate what a minifier does to code: the variable
 * is renamed, a lib build keeps its whitespace, and `===` may be narrowed to
 * `==`.
 */
const EMAIL_SCANNER_PROBE =
  /={2,3}\s*95\s*\|\|\s*[\w$]+\s*={2,3}\s*39\s*\|\|\s*[\w$]+\s*={2,3}\s*43\s*\|\|\s*[\w$]+\s*={2,3}\s*45/g;

function count(haystack: string, needle: string | RegExp): number {
  if (typeof needle !== "string") return [...haystack.matchAll(needle)].length;
  let n = 0;
  let from = 0;
  for (;;) {
    const i = haystack.indexOf(needle, from);
    if (i === -1) return n;
    n++;
    from = i + needle.length;
  }
}

function fmt(n: number): string {
  return n.toString().padStart(8);
}

async function main() {
  // oxlint-disable-next-line no-console -- report output
  console.log("\nzod-compiler multi-file size + dedup report (5 files × 2 schemas)\n");

  const optimized = await bundle([zodCompiler({ schemas: "auto" })]);

  // oxlint-disable-next-line no-console -- report output
  console.log(`Bundle size:   raw ${fmt(optimized.raw)}   gzip ${fmt(optimized.gzip)}\n`);

  // Cross-file dedup is working iff each probe appears exactly once.
  const allDeduped =
    optimized.probes.emailScanner === 1 &&
    optimized.probes.emailSrcString === 1 &&
    optimized.probes.uuidRegex === 1 &&
    optimized.probes.uuidSrcString === 1 &&
    optimized.probes.mkvFactory === 1;

  // oxlint-disable-next-line no-console -- report output
  console.log("Cross-file dedup probes (each must appear exactly once):");
  // oxlint-disable-next-line no-console -- report output
  console.log(
    `  __zcEmail      (linear scan):    ${optimized.probes.emailScanner}  ${optimized.probes.emailScanner === 1 ? "OK" : "FAIL"}`,
  );
  // oxlint-disable-next-line no-console -- report output
  console.log(
    `  __zcReEmailSrc (issue pattern):  ${optimized.probes.emailSrcString}  ${optimized.probes.emailSrcString === 1 ? "OK" : "FAIL"}`,
  );
  // oxlint-disable-next-line no-console -- report output
  console.log(
    `  __zcReUuid     (fast regex):     ${optimized.probes.uuidRegex}  ${optimized.probes.uuidRegex === 1 ? "OK" : "FAIL"}`,
  );
  // oxlint-disable-next-line no-console -- report output
  console.log(
    `  __zcReUuidSrc  (issue pattern):  ${optimized.probes.uuidSrcString}  ${optimized.probes.uuidSrcString === 1 ? "OK" : "FAIL"}`,
  );
  // oxlint-disable-next-line no-console -- report output
  console.log(
    `  __zcMkv          (schema mutate):  ${optimized.probes.mkvFactory}  ${optimized.probes.mkvFactory === 1 ? "OK" : "FAIL"}`,
  );

  if (!allDeduped) {
    // oxlint-disable-next-line no-console -- report output
    console.error("\nFAIL: cross-file dedup did not produce a single bundle-wide copy.");
    process.exit(1);
  }
}

await main();
