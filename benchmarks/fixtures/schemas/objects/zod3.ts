import { z } from "zod3";

// ─── Medium: User Registration ──────────────────────────────────────────────

export const v3UserSchema = z.object({
  username: z.string().min(3).max(20),
  email: z.string().email(),
  password: z.string().min(8),
  age: z.number().int().positive(),
  role: z.enum(["user", "admin"]),
  newsletter: z.boolean(),
  referral: z.string().optional(),
});

export type V3User = z.infer<typeof v3UserSchema>;

// ─── Large: API Response (nested objects + arrays) ──────────────────────────

const ItemSchema = z.object({
  id: z.number().int().positive(),
  title: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
  tags: z.array(z.string().min(1)).max(10),
  published: z.boolean(),
  category: z.enum(["tech", "science", "art", "music", "sports"]),
  metadata: z.object({
    createdAt: z.string(),
    updatedAt: z.string(),
    views: z.number().int().nonnegative(),
  }),
});

export const v3ApiResponseSchema = z.object({
  status: z.enum(["success", "error"]),
  data: z
    .object({
      items: z.array(ItemSchema),
      total: z.number().int().nonnegative(),
      page: z.number().int().positive(),
      pageSize: z.number().int().positive(),
      hasMore: z.boolean(),
    })
    .optional(),
  error: z
    .object({
      code: z.string(),
      message: z.string(),
    })
    .optional(),
});

export type V3ApiResponse = z.infer<typeof v3ApiResponseSchema>;

// ─── Strict: DB row (slonik-style, rejects unknown columns) ──────────────────

export const v3StrictRowSchema = z
  .object({
    id: z.string().uuid(),
    title: z.string().min(1).max(200),
    status: z.enum(["draft", "active", "archived"]),
    rate: z.number().nullable(),
    isDefault: z.boolean(),
    createdAt: z.date(),
  })
  .strict();
