import type { FallbackIR } from "../types.js";
import type { RefEntry } from "./types.js";

export function makeFallback(
  reason: FallbackIR["reason"],
  zodSchema: unknown,
  refs?: RefEntry[],
  accessPath?: string,
): FallbackIR {
  if (refs && accessPath !== undefined) {
    const refIndex = refs.length;
    refs.push({ schema: zodSchema, accessPath });
    return { type: "fallback", reason, refIndex };
  }
  return { type: "fallback", reason };
}
