import { z } from "zod";

export const UserSchema = z.object({
  id: z.uuid(),
  email: z.email(),
  name: z.string().min(1).max(100),
  age: z.number().int().min(0).max(150),
});

export const AdminSchema = z.object({
  id: z.uuid(),
  email: z.email(),
  role: z.enum(["super", "regular"]),
});
