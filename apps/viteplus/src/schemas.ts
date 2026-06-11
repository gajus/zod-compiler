import { z } from "zod";
import { compile } from "zod-compiler";

// --- Tier 1 types ---

const UserSchema = z.object({
  name: z.string().min(1).max(100),
  email: z.email(),
  age: z.number().int().min(0).max(150),
  role: z.enum(["admin", "editor", "viewer"]),
  isActive: z.boolean(),
  tags: z.array(z.string().min(1)).max(10),
  nickname: z.optional(z.string()),
  bio: z.nullable(z.string()),
});

export const validateUser = compile(UserSchema);

// --- Tier 2 types ---

const AddressSchema = z.object({
  street: z.string(),
  city: z.string(),
  zip: z.string().regex(/^\d{3}-?\d{4}$/),
});

export const validateAddress = compile(AddressSchema);

const ContactSchema = z.intersection(
  z.object({ name: z.string() }),
  z.object({ phone: z.string() }),
);

export const validateContact = compile(ContactSchema);

const EventSchema = z.object({
  title: z.string(),
  date: z.date(),
  attendees: z.tuple([z.string(), z.number().int()]),
  metadata: z.object({ location: z.optional(z.string()), notes: z.optional(z.string()) }),
  status: z.literal("scheduled"),
  priority: z.number().default(0),
});

export const validateEvent = compile(EventSchema);

const NotificationSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("email"), to: z.email(), subject: z.string() }),
  z.object({ type: z.literal("sms"), phone: z.string(), body: z.string() }),
  z.object({ type: z.literal("push"), deviceId: z.string(), title: z.string() }),
]);

export const validateNotification = compile(NotificationSchema);

// --- Partial fallback (transform) ---

const OrderSchema = z.object({
  orderId: z.string().min(1),
  amount: z.number().positive(),
  currency: z.enum(["USD", "EUR", "JPY"]),
  slug: z.string().transform((v) => v.toLowerCase().replace(/\s+/g, "-")),
  createdAt: z.date(),
});

export const validateOrder = compile(OrderSchema);

// --- Tier 3 types ---

const WalletSchema = z.object({
  balance: z.bigint().nonnegative(),
  limit: z.bigint().max(1000000n),
});

export const validateWallet = compile(WalletSchema);

const TagSetSchema = z.set(z.string().min(1)).min(1).max(20);

export const validateTagSet = compile(TagSetSchema);

const HeadersSchema = z.map(z.string().min(1), z.string());

export const validateHeaders = compile(HeadersSchema);

const PositiveIntSchema = z.number().int().pipe(z.number().positive());

export const validatePositiveInt = compile(PositiveIntSchema);

// --- Lazy schemas ---

const CategorySchema = z.object({
  name: z.lazy(() => z.string().min(1).max(100)),
  description: z.lazy(() => z.nullable(z.string())),
});

export const validateCategory = compile(CategorySchema);

const TreeNodeSchema: z.ZodType = z.object({
  value: z.string().min(1),
  children: z.array(z.lazy(() => TreeNodeSchema)),
});

export const validateTreeNode = compile(TreeNodeSchema);

// --- Inline compile (no intermediate variable) ---

export const validateInline = compile(
  z.object({
    id: z.string().min(1),
    value: z.number().positive(),
  }),
);
