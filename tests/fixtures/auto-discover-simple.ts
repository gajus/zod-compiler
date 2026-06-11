import { z } from "zod";

export const UserSchema = z.object({
  name: z.string().min(1),
  age: z.number().int().positive(),
});
