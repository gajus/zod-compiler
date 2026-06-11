import type { Extractor } from "../types.js";

export const extractLiteral: Extractor = (def) => ({ type: "literal", values: def.values });
