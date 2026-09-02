/**
 * The zod release a schema was built by, and whether this compiler can stand
 * in for it.
 *
 * Compiled validators reproduce zod 4.5's semantics byte-for-byte: the
 * absent-key `expected: "nonoptional"` rule that 4.4 introduced, the
 * code-point string lengths and tuple issue order of 4.5, the 4.5 format
 * regexes. That fidelity is the contract, and it cuts both ways — a validator
 * compiled here but installed on a schema from zod 4.3 accepts and rejects
 * differently from the zod the application actually calls everywhere else,
 * with nothing to say so. The peer range (`^4.5.0`) is meant to prevent that
 * pairing, but only npm treats a violated peer range as an error; pnpm, yarn
 * and bun warn and install anyway. This guard is the second line: one check at
 * the root of extraction, which every entry point (CLI, build plugin, register
 * hook, `jit()`) passes through, so an unsupported zod is refused with an
 * explanation instead of compiled into subtly different validators.
 *
 * The version is read off the SCHEMA INSTANCE — `_zod.version`, which
 * `$ZodType.init` stamps on every schema, classic and mini alike, since 4.0 —
 * rather than off an imported zod module. A project can hold two zod copies
 * (a hoisted one and a nested one, or a build-time and a runtime one), and the
 * copy that built the schema is the one whose semantics its validator must
 * match. A schema with no version at all is refused too: every zod 4 stamps
 * one, so its absence means a zod older than this compiler has ever targeted.
 * A value that is not a zod schema in the first place (no `_zod.def`) is not
 * this guard's to judge — extraction reports it the way it always has, and
 * calling it a version problem would send the user chasing the wrong fix.
 */

import { isZodSchema } from "../../is-zod-schema.js";

/** Lowest zod release whose semantics the emitted validators reproduce. */
export const MIN_ZOD_VERSION = { major: 4, minor: 5 } as const;

export interface ZodVersion {
  major: number;
  minor: number;
  patch: number;
}

/**
 * `name` of the error {@link assertSupportedZod} throws. Matched by name, not
 * by identity, so a second copy of this module in the graph still recognises it.
 */
export const UNSUPPORTED_ZOD_VERSION_ERROR = "UnsupportedZodVersionError";

/** The `_zod.version` a schema carries, or `undefined` when it has none (or is not a schema). */
export function zodVersionOf(schema: unknown): ZodVersion | undefined {
  if (typeof schema !== "object" || schema === null) return undefined;
  try {
    const internal = (schema as { _zod?: unknown })._zod;
    if (typeof internal !== "object" || internal === null) return undefined;
    const version = (internal as { version?: unknown }).version;
    if (typeof version !== "object" || version === null) return undefined;
    const { major, minor, patch } = version as Record<string, unknown>;
    if (typeof major !== "number" || typeof minor !== "number" || typeof patch !== "number") {
      return undefined;
    }
    return { major, minor, patch };
  } catch {
    // A Proxy trapping `get` — not a zod schema, and not one this can compile.
    return undefined;
  }
}

/**
 * Within the peer range: the same major, at or past the minimum minor. A
 * hypothetical zod 5 is refused as well — its semantics are unknown here, and
 * the promise is exactness, not best effort.
 */
export function isSupportedZodVersion(version: ZodVersion | undefined): boolean {
  return (
    version !== undefined &&
    version.major === MIN_ZOD_VERSION.major &&
    version.minor >= MIN_ZOD_VERSION.minor
  );
}

export function unsupportedZodVersionMessage(version: ZodVersion | undefined): string {
  const found =
    version === undefined
      ? "a zod that carries no _zod.version (older than 4.0, or not a zod schema)"
      : `zod ${version.major}.${version.minor}.${version.patch}`;
  const required = `^${MIN_ZOD_VERSION.major}.${MIN_ZOD_VERSION.minor}.0`;
  return (
    `Unsupported zod version: this schema was built by ${found}, and this zod-compiler release requires zod ${required}. ` +
    `Compiled validators reproduce zod ${MIN_ZOD_VERSION.major}.${MIN_ZOD_VERSION.minor}'s semantics exactly ` +
    '(the absent-key `expected: "nonoptional"` rule, code-point string lengths, tuple issue order), ' +
    "so an older zod would accept and reject differently from the validator compiled for it. " +
    `Upgrade zod to ${MIN_ZOD_VERSION.major}.${MIN_ZOD_VERSION.minor} or later, or stay on zod-compiler 1.x.`
  );
}

/**
 * Throw a recognisable error (see {@link isUnsupportedZodVersionError}) when
 * `schema` is a zod schema from an unsupported zod. Anything that is not a zod
 * schema at all passes through untouched, for the caller's own error path.
 */
export function assertSupportedZod(schema: unknown): void {
  if (!isZodSchema(schema)) return;
  const version = zodVersionOf(schema);
  if (isSupportedZodVersion(version)) return;
  const error = new Error(unsupportedZodVersionMessage(version));
  error.name = UNSUPPORTED_ZOD_VERSION_ERROR;
  throw error;
}

/**
 * The predicate's target is deliberately narrower than `Error`: a caller that
 * already holds an `Error` keeps it on the negative branch (a bare `error is
 * Error` would leave `never` there).
 */
export function isUnsupportedZodVersionError(
  error: unknown,
): error is Error & { name: typeof UNSUPPORTED_ZOD_VERSION_ERROR } {
  return error instanceof Error && error.name === UNSUPPORTED_ZOD_VERSION_ERROR;
}

/** Messages already printed by {@link warnUnsupportedZodOnce}, per process. */
const warned = new Set<string>();

/**
 * Print the refusal once per process. Every schema in an application fails the
 * guard the same way, so one explanation is the useful amount — and the paths
 * that call this (`jit()` at module scope, the plugin's per-export failure
 * hook, the hoist compiler's catch-all) would otherwise either say nothing or
 * say it once per export.
 */
export function warnUnsupportedZodOnce(message: string): void {
  if (warned.has(message)) return;
  warned.add(message);
  // oxlint-disable-next-line no-console -- being heard is the point
  console.warn(`[zod-compiler] ${message}`);
}
