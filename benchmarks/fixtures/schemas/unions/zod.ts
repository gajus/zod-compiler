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

// ─── Large discriminated union (8 options) ───────────────────────────────────
// A discriminated union with enough options that the compiled switch-dispatch
// helper exceeds V8's inlining budget — the regime where the per-case object
// guard is NOT cleaned up by the optimizer and codegen has to avoid emitting it.

export const LargeDiscriminatedUnionSchema = z.discriminatedUnion("type", [
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

export type LargeUIEvent = z.infer<typeof LargeDiscriminatedUnionSchema>;

// ─── Plain union of tagged objects (8 options) ───────────────────────────────
// Same shapes as above but written as an UNTAGGED z.union — Zod validates it by
// trying each option in sequence. zod-compiler detects that every option pins a
// disjoint literal `type` and auto-lowers the fast path to O(1) switch dispatch,
// matching z.discriminatedUnion without the author opting in.

export const PlainTaggedUnionSchema = z.union([
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
