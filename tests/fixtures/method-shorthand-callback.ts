import { z } from "zod";

/** A callback whose `toString()` is not a standalone expression. */
const helpers = {
  normalize(this: void, value: unknown) {
    return typeof value === "string" ? value.trim() : value;
  },
};

export const TrimmedSchema = z.preprocess(helpers.normalize, z.string());
