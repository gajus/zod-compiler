import { z } from "zod";
import { compile } from "#src/core/compile.js";

enum Status {
  Active = "active",
  Inactive = "inactive",
}

const ItemSchema = z.object({
  name: z.string(),
  status: z.enum([Status.Active, Status.Inactive]),
});

export const validateItem = compile(ItemSchema);
