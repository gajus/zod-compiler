import { z } from "zod";

export const OrderSchema = z.object({
  id: z.uuid(),
  userId: z.uuid(),
  buyerEmail: z.email(),
  status: z.enum(["pending", "paid", "shipped", "delivered", "cancelled"]),
  total: z.number().positive(),
});

export const InvoiceSchema = z.object({
  orderId: z.uuid(),
  email: z.email(),
  amount: z.number().positive(),
  currency: z.enum(["USD", "EUR", "JPY"]),
});
