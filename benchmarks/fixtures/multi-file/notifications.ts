import { z } from "zod";

export const NotificationSchema = z.object({
  id: z.uuid(),
  recipientEmail: z.email(),
  subject: z.string().min(1).max(200),
  body: z.string().max(10000),
});

export const SubscriptionSchema = z.object({
  email: z.email(),
  topics: z.array(z.string().min(1)).min(1),
  frequency: z.enum(["daily", "weekly", "monthly"]),
});
