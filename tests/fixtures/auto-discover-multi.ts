import { z } from "zod";

export const UserSchema = z.object({
  name: z.string(),
  email: z.email(),
});

export const ProductSchema = z.object({
  id: z.number().int(),
  title: z.string().min(1),
  price: z.number().positive(),
});
