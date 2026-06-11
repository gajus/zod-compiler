import { z } from "zod";
import { compile } from "#src/core/compile.js";

const UserSchema = z.object({
  name: z.string().min(1),
  age: z.number().int().positive(),
});

export const validateUser = compile(UserSchema);
