// @ts-nocheck — intentionally uses extensionless import for loader test
import { z } from "zod";
import { compile } from "#src/core/compile.js";
import { NameSchema } from "./helper";

const UserSchema = z.object({
  name: NameSchema,
  age: z.number().int().positive(),
});

export const validateUser = compile(UserSchema);
