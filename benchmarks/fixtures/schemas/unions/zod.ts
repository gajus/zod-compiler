import { z } from "zod";

const ClickEvent = z.object({
  type: z.literal("click"),
  x: z.number().int(),
  y: z.number().int(),
  target: z.string().min(1),
});

const ScrollEvent = z.object({
  type: z.literal("scroll"),
  direction: z.enum(["up", "down"]),
  delta: z.number().positive(),
});

const KeypressEvent = z.object({
  type: z.literal("keypress"),
  key: z.string().min(1),
  modifiers: z.array(z.string()),
});

export const DiscriminatedUnionSchema = z.discriminatedUnion("type", [
  ClickEvent,
  ScrollEvent,
  KeypressEvent,
]);

export type UIEvent = z.infer<typeof DiscriminatedUnionSchema>;
