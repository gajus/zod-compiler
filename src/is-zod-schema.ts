import type { ZodType } from "zod";

/**
 * Is this value a Zod schema? Zod schemas carry `_zod.def`, so that is the
 * probe — the same one auto-discovery uses at build time and `jitAll` uses at
 * runtime.
 *
 * The probe is applied to values the caller does not control: every own value
 * of a module namespace under `jitAll`, every export of a candidate file under
 * discovery. Some of those are not plain objects. A Proxy can trap `has` and
 * `get` and throw — an ORM model, a strict test double, an i18n catch-all — and
 * `"_zod" in value` fires the first trap while reading `_zod` fires the second.
 * Whatever such a value is, it is not a Zod schema, and asking must not take
 * down the caller: an uncaught throw here aborts the importing app at boot, or
 * the build, over an object that was never a candidate.
 *
 * Kept as a leaf module with no runtime imports: `jit`/`jitAll` reach it on the
 * startup path, where pulling in the build-time graph would be pure cost.
 */
export function isZodSchema(value: unknown): value is ZodType {
  if (typeof value !== "object" || value === null) return false;
  try {
    if (!("_zod" in value)) return false;
    const internal = (value as Record<string, unknown>)["_zod"];
    return typeof internal === "object" && internal !== null && "def" in internal;
  } catch {
    return false;
  }
}
