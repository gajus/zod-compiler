import { z } from "zod";
import { compile } from "zod-compiler";

const UserSchema = z.object({
  name: z.string().min(1).max(100),
  email: z.email(),
  age: z.number().int().min(0).max(150),
  role: z.enum(["admin", "editor", "viewer"]),
  isActive: z.boolean(),
});

export const validateUser = compile(UserSchema);

const AddressSchema = z.object({
  street: z.string(),
  city: z.string(),
  zip: z.string().regex(/^\d{3}-?\d{4}$/),
});

export const validateAddress = compile(AddressSchema);

const NotificationSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("email"), to: z.email(), subject: z.string() }),
  z.object({ type: z.literal("sms"), phone: z.string(), body: z.string() }),
]);

export const validateNotification = compile(NotificationSchema);
