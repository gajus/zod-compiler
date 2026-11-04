/**
 * Virtual module "virtual:zod-compiler/runtime".
 *
 * Hosts shared helpers and well-known regexes so that lean-mode generated code
 * (emitted by the unplugin transform) can `import { __zcMkv, __zcTS, __zcReEmail }`
 * instead of inlining these declarations per IIFE.
 *
 * Bundlers tree-shake unused exports during minification, so the virtual module
 * never bloats the final bundle with helpers that no schema actually references.
 *
 * The virtual module is rebuilt on each plugin instantiation but its content is
 * static (no per-build state), so caching the source string is safe.
 */

import { ISSUE_DECLS, RUNTIME_HELPER_DECLS, ZC_SR_RUN_DECL } from "../core/codegen/issue-decls.js";
import { fastTestSource, WELL_KNOWN_REGEXES } from "../core/codegen/well-known-regex.js";
import {
  FAIL_CLASS_DECL,
  FAIL_CORE_CLASS_DECL,
  FAILZ_CLASS_DECL,
  FIN_CORE_DECL,
  FIN_DECL,
  FIN_DEFERRED_CORE_DECL,
  FIN_DEFERRED_DECL,
  FINZ_DECL,
  MK_VALIDATOR_DECL,
  ZOD_CONFIG_IMPORT,
  ZOD_MSG_DECLARATION,
} from "../core/iife.js";

/** Public virtual module ID used by Vite / Rollup / esbuild and other `virtual:`-compatible bundlers. */
export const VIRTUAL_RUNTIME_ID = "virtual:zod-compiler/runtime";
/** Bare-specifier alias for webpack/rspack, which reject the `virtual:` URI scheme. */
export const WP_RUNTIME_ID = "__zod-compiler-runtime__";
/**
 * Real package subpath, shipped as `dist/runtime.js` (emitted at build time from
 * RUNTIME_SOURCE — see the `emit-runtime` plugin in vite.config.ts).
 *
 * The ids above only resolve inside a host that runs zod-compiler's resolveId
 * hook. A webpack loader has none, so lean mode was unavailable to it: the
 * specifier would survive into the output unresolved. This one needs no hook —
 * plain node resolution finds it — which is what lets a loader host dedup
 * helpers across files.
 *
 * Deliberately NOT intercepted by resolveVirtualId, unlike the two ids above.
 * They resolve to nothing without the hook, so answering them is free. This one
 * already resolves, and to a SPECIFIC copy: intercepting would override a
 * nested or newer zod-compiler whose runtime exports helpers this version has
 * never heard of, turning a working build into an unresolvable-import error
 * naming an id the user never wrote. A build that ends up with both this file
 * and the virtual module carries two copies of the helpers, which is wasteful
 * but correct — every result crosses module boundaries structurally, never by
 * identity.
 */
export const RUNTIME_PACKAGE_ID = "zod-compiler/runtime";
/** Resolved id (Rollup convention: leading null byte hides the module from other plugins). */
export const RESOLVED_RUNTIME_ID = "\0zod-compiler-runtime";

function buildRuntimeSource(): string {
  // ISSUE_DECLS / RUNTIME_HELPER_DECLS registries are the single source of
  // truth — never enumerate individual decl constants here. A decl present in
  // the registry (and therefore in ALL_HELPER_NAMES and in codegen's
  // usedHelpers imports) but missing from this source is a build-breaking
  // MISSING_EXPORT in every consumer bundle (field incident: __zcUK).
  const parts: string[] = [
    ZOD_CONFIG_IMPORT,
    ZOD_MSG_DECLARATION,
    // Module-local (never imported by generated code) — __zcFin/__zcFinD below
    // construct it. Must precede them; both reference __ZcFail by closure.
    FAIL_CLASS_DECL,
    // Module-local likewise — the core-error twin __zcFinC/__zcFinDC construct,
    // for validators of zod/mini schemas. A bundle compiling none of those
    // tree-shakes it out with them.
    FAIL_CORE_CLASS_DECL,
    // Module-local (never imported by generated code) — __zcFinZ constructs it.
    FAILZ_CLASS_DECL,
    `export ${MK_VALIDATOR_DECL}`,
    `export ${FIN_DECL}`,
    `export ${FIN_DEFERRED_DECL}`,
    `export ${FIN_CORE_DECL}`,
    `export ${FIN_DEFERRED_CORE_DECL}`,
    `export ${FINZ_DECL}`,
    // Module-local (never imported by generated code) — __zcSr/__zcSrOk call it.
    ZC_SR_RUN_DECL,
    ...Object.values(ISSUE_DECLS).map((decl) => `export ${decl}`),
    ...Object.values(RUNTIME_HELPER_DECLS).map((decl) => `export ${decl}`),
  ];
  for (const r of WELL_KNOWN_REGEXES) {
    // fastTestSource is a behavior-equivalent faster pattern used for the
    // runtime regex (table rewrite and/or repeat unrolling); issue sites
    // reference the paired `<name>Src` string so reported patterns stay
    // byte-identical to zod's (single bundle-wide copy of each). It is the same
    // function emitRegex consults, so the virtual module and inline mode can
    // never disagree about which pattern a format actually runs.
    const testSource = fastTestSource(r.source);
    parts.push(`export const ${r.name}=new RegExp(${JSON.stringify(testSource ?? r.source)});`);
    if (testSource !== null) {
      parts.push(`export const ${r.name}Src=${JSON.stringify(`/${r.source}/`)};`);
    }
  }
  return parts.join("\n");
}

/**
 * The runtime module's ESM source. Exported because the package build writes it
 * to `dist/runtime.js` — the file and the virtual module must be the same bytes,
 * so there is exactly one producer.
 */
export const RUNTIME_SOURCE = buildRuntimeSource();

/**
 * Anchored, literal-safe pattern for an exact id match. Hook filters take
 * globs or regexes, and a bare string is treated as a glob resolved against
 * cwd — which never matches a `virtual:` specifier — so the ids are escaped
 * into patterns instead. NUL is written as `\x00` because the pattern is
 * recompiled outside JS by bundlers with native filters (Rolldown).
 */
function exactIdPattern(id: string): RegExp {
  const escaped = id.replace(/[$()*+.?[\\\]^{|}]/g, "\\$&").replaceAll("\0", "\\x00");
  return new RegExp(`^${escaped}$`);
}

/** `id` filter for the resolveId hook: the runtime module's public specifiers. */
export const RUNTIME_SPECIFIER_FILTER: RegExp[] = [
  exactIdPattern(VIRTUAL_RUNTIME_ID),
  exactIdPattern(WP_RUNTIME_ID),
];

/** `id` filter for the load hook: the resolved (`\0`-prefixed) runtime id. */
export const RESOLVED_RUNTIME_ID_FILTER: RegExp = exactIdPattern(RESOLVED_RUNTIME_ID);

export function resolveVirtualId(id: string): string | null {
  if (id === VIRTUAL_RUNTIME_ID || id === WP_RUNTIME_ID) return RESOLVED_RUNTIME_ID;
  return null;
}

export function loadVirtual(id: string): string | null {
  if (id === RESOLVED_RUNTIME_ID) return RUNTIME_SOURCE;
  return null;
}

/** Names of all helpers exported by the virtual module. */
export const ALL_HELPER_NAMES: readonly string[] = [
  "__zcMkv",
  "__zcFin",
  "__zcFinD",
  "__zcFinC",
  "__zcFinDC",
  "__zcFinZ",
  ...Object.keys(ISSUE_DECLS),
  ...Object.keys(RUNTIME_HELPER_DECLS),
  ...WELL_KNOWN_REGEXES.flatMap((r) =>
    fastTestSource(r.source) !== null ? [r.name, `${r.name}Src`] : [r.name],
  ),
];
