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

import { ISSUE_DECLS, RUNTIME_HELPER_DECLS } from "../core/codegen/issue-decls.js";
import { WELL_KNOWN_REGEXES } from "../core/codegen/well-known-regex.js";
import {
  FAIL_CLASS_DECL,
  FAILZ_CLASS_DECL,
  FIN_DECL,
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
    // Module-local (never imported by generated code) — __zcFinZ constructs it.
    FAILZ_CLASS_DECL,
    `export ${MK_VALIDATOR_DECL}`,
    `export ${FIN_DECL}`,
    `export ${FIN_DEFERRED_DECL}`,
    `export ${FINZ_DECL}`,
    ...Object.values(ISSUE_DECLS).map((decl) => `export ${decl}`),
    ...Object.values(RUNTIME_HELPER_DECLS).map((decl) => `export ${decl}`),
  ];
  for (const r of WELL_KNOWN_REGEXES) {
    // testSource is a behavior-equivalent faster pattern used for the runtime
    // regex; issue sites reference the paired `<name>Src` string so reported
    // patterns stay byte-identical to zod's (single bundle-wide copy of each).
    parts.push(`export const ${r.name}=new RegExp(${JSON.stringify(r.testSource ?? r.source)});`);
    if (r.testSource !== undefined) {
      parts.push(`export const ${r.name}Src=${JSON.stringify(`/${r.source}/`)};`);
    }
  }
  return parts.join("\n");
}

const RUNTIME_SOURCE = buildRuntimeSource();

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
  "__zcFinZ",
  ...Object.keys(ISSUE_DECLS),
  ...Object.keys(RUNTIME_HELPER_DECLS),
  ...WELL_KNOWN_REGEXES.flatMap((r) =>
    r.testSource !== undefined ? [r.name, `${r.name}Src`] : [r.name],
  ),
];
