import { z } from "zod";

export const UserSchema: z.ZodType = z.object({ name: z.string().min(1) });
