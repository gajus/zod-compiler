import { NameSchema } from "@lib/shared";
import { LabelSchema } from "~shared";
import { z } from "zod";

export const UserSchema = z.object({
  name: NameSchema,
  label: LabelSchema,
  age: z.number().int().positive(),
});
