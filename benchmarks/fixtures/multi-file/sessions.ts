import { z } from "zod";

export const SessionSchema = z.object({
  id: z.uuid(),
  userId: z.uuid(),
  email: z.email(),
  expiresAt: z.number().int().positive(),
});

export const TokenSchema = z.object({
  jti: z.uuid(),
  email: z.email(),
  scope: z.array(z.string().min(1)).min(1),
});
