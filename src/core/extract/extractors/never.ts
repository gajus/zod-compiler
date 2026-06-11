import type { Extractor } from "../types.js";

export const extractNever: Extractor = () => ({ type: "never" });
