import type { Extractor } from "../types.js";

export const extractUndefined: Extractor = () => ({ type: "undefined" });
