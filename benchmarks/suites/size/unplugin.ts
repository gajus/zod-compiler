/**
 * Multi-file dedup verification + size report.
 *
 * Builds a 5-file fixture (10 schemas, all sharing z.email() and z.uuid())
 * with the unplugin in autoDiscover mode and measures the resulting bundle.
 *
 * The cross-file dedup objective: well-known regexes (`__zcReEmail`,
 * `__zcReUuid`) and shared helpers (`__zcMkv`, `__zcFin`, issue factories) must
 * appear exactly ONCE in the bundle no matter how many files reference them.
 *
 * Run: pnpm size:unplugin
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
  probes: { emailRegex: number; emailSrcString: number; uuidRegex: number; mkvFactory: number };
}

async function bundle(plugins: ZodCompilerPlugin[]): Promise<BundleResult> {
  const result = await build({
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
      // Distinctive substrings from each pattern; they survive minification.
      // __zcReEmail is built from the fast rewrite (structural local part, no
      // lookaheads); __zcReEmailSrc carries zod's original pattern for issues.
      emailRegex: count(code, "(?:[A-Za-z0-9_'+"),
      emailSrcString: count(code, "(?!.*"),
      uuidRegex: count(code, "[1-8][0-9a-fA-F]"),
      // property name inside __zcMkv — survives minification, unique to it
      // (zod is external, and generated schema code never references it)
      mkvFactory: count(code, "safeParseAsync"),
    },
  };
}

function count(haystack: string, needle: string): number {
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
    optimized.probes.emailRegex === 1 &&
    optimized.probes.emailSrcString === 1 &&
    optimized.probes.uuidRegex === 1 &&
    optimized.probes.mkvFactory === 1;

  // oxlint-disable-next-line no-console -- report output
  console.log("Cross-file dedup probes (each must appear exactly once):");
  // oxlint-disable-next-line no-console -- report output
  console.log(
    `  __zcReEmail    (fast regex):     ${optimized.probes.emailRegex}  ${optimized.probes.emailRegex === 1 ? "OK" : "FAIL"}`,
  );
  // oxlint-disable-next-line no-console -- report output
  console.log(
    `  __zcReEmailSrc (issue pattern):  ${optimized.probes.emailSrcString}  ${optimized.probes.emailSrcString === 1 ? "OK" : "FAIL"}`,
  );
  // oxlint-disable-next-line no-console -- report output
  console.log(
    `  __zcReUuid     (regex source):   ${optimized.probes.uuidRegex}  ${optimized.probes.uuidRegex === 1 ? "OK" : "FAIL"}`,
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
