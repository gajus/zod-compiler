/**
 * Plain Zod schemas — no compile() wrappers, no zod-compiler import.
 * With autoDiscover: true in vite.config.ts, zod-compiler detects these
 * exported Zod schemas and compiles them at build time automatically.
 */
import { z } from "zod";

export const CreateUserSchema = z.object({
  name: z.string().min(1).max(100),
  email: z.email(),
  age: z.number().int().min(0).max(150),
  role: z.enum(["admin", "editor", "viewer"]),
});

export const UpdateUserSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  email: z.email().optional(),
  age: z.number().int().min(0).max(150).optional(),
  role: z.enum(["admin", "editor", "viewer"]).optional(),
});

export const ListUsersSchema = z.object({
  page: z.number().int().min(1).optional().default(1),
  limit: z.number().int().min(1).max(100).optional().default(20),
  role: z.enum(["admin", "editor", "viewer"]).optional(),
});

export const UserIdSchema = z.object({
  id: z.string().min(1),
});
