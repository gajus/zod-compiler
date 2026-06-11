import type { Extractor } from "../types.js";

export const extractBoolean: Extractor = (def) => ({
  type: "boolean",
  ...(def.coerce ? { coerce: true } : {}),
});
