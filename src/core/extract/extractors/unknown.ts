import type { Extractor } from "../types.js";

export const extractUnknown: Extractor = () => ({ type: "unknown" });
