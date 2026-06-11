import { z } from "zod";
// Path alias — resolved by webpack but not by jiti
import { RoleSchema } from "@/lib/auth/roles";

export const AdminSchema = z.object({
  role: RoleSchema,
  reason: z.string().min(1),
});
