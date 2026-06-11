import type { Extractor } from "../types.js";

export const extractNull: Extractor = () => ({ type: "null" });
