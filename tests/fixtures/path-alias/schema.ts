import { NameSchema } from "@lib/shared";
import { z } from "zod";

export const UserSchema = z.object({
  name: NameSchema,
  age: z.number().int().positive(),
});
