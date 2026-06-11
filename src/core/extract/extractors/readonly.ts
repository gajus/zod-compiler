import type { Extractor } from "../types.js";

/**
 * z.readonly() freezes the parse OUTPUT in Zod. Compiled validators return
 * the caller's input object as-is, so emitting Object.freeze would freeze the
 * caller's own data — an observable side effect Zod never has. Delegate to
 * Zod, which freezes its rebuilt output instead.
 */
export const extractReadonly: Extractor = (_def, ctx) => ctx.fallback("unsupported");
