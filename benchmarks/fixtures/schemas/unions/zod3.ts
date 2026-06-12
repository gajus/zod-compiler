import { z } from "zod3";

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

export const v3DiscriminatedUnionSchema = z.discriminatedUnion("type", [
  ClickEvent,
  ScrollEvent,
  KeypressEvent,
]);

export type V3UIEvent = z.infer<typeof v3DiscriminatedUnionSchema>;

export const v3LargeDiscriminatedUnionSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("click"),
    x: z.number().int(),
    y: z.number().int(),
    target: z.string().min(1),
  }),
  z.object({
    type: z.literal("scroll"),
    direction: z.enum(["up", "down"]),
    delta: z.number().positive(),
  }),
  z.object({ type: z.literal("keypress"), key: z.string().min(1), modifiers: z.array(z.string()) }),
  z.object({ type: z.literal("focus"), elementId: z.string().min(1), tabIndex: z.number().int() }),
  z.object({ type: z.literal("blur"), elementId: z.string().min(1) }),
  z.object({ type: z.literal("submit"), formId: z.string().min(1), fields: z.array(z.string()) }),
  z.object({
    type: z.literal("resize"),
    width: z.number().positive(),
    height: z.number().positive(),
  }),
  z.object({
    type: z.literal("drag"),
    fromX: z.number().int(),
    fromY: z.number().int(),
    toX: z.number().int(),
    toY: z.number().int(),
  }),
]);
