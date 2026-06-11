import { z } from "zod";

// --- User ---

export const CreateUserSchema = z.object({
  name: z.string().min(1).max(100),
  email: z.email(),
  age: z.number().int().min(0).max(150),
  role: z.enum(["admin", "editor", "viewer"]),
});

// --- Product ---

export const ProductSchema = z.object({
  id: z.uuid(),
  name: z.string().min(1),
  price: z.number().positive(),
  tags: z.array(z.string()),
  inStock: z.boolean(),
});
