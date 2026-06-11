// Entry that exercises every validator from every file so the bundler can't
// tree-shake the schemas away. The size delta therefore reflects real
// validation code, not zero-cost re-exports.

import { NotificationSchema, SubscriptionSchema } from "./notifications.js";
import { InvoiceSchema, OrderSchema } from "./orders.js";
import { ProductSchema, ReviewSchema } from "./products.js";
import { SessionSchema, TokenSchema } from "./sessions.js";
import { AdminSchema, UserSchema } from "./users.js";

export function validateAll(input: {
  user: unknown;
  admin: unknown;
  product: unknown;
  review: unknown;
  order: unknown;
  invoice: unknown;
  notification: unknown;
  subscription: unknown;
  session: unknown;
  token: unknown;
}) {
  return {
    user: UserSchema.safeParse(input.user),
    admin: AdminSchema.safeParse(input.admin),
    product: ProductSchema.safeParse(input.product),
    review: ReviewSchema.safeParse(input.review),
    order: OrderSchema.safeParse(input.order),
    invoice: InvoiceSchema.safeParse(input.invoice),
    notification: NotificationSchema.safeParse(input.notification),
    subscription: SubscriptionSchema.safeParse(input.subscription),
    session: SessionSchema.safeParse(input.session),
    token: TokenSchema.safeParse(input.token),
  };
}
