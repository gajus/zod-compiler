import { z } from "zod";
import { DiscriminatedUnionSchema } from "../unions/zod.js";

// ─── Event Log (multi-feature realistic scenario) ───────────────────────────

export const EventLogSchema = z.object({
  sessionId: z.uuid(),
  events: z.array(DiscriminatedUnionSchema).min(1),
  dimensions: z.tuple([z.number().int().positive(), z.number().int().positive()]),
  tags: z.record(z.string(), z.string()),
  startedAt: z.date(),
  config: z.object({
    sampleRate: z.number().positive().default(1.0),
    debug: z.boolean().default(false),
  }),
});

export type EventLog = z.infer<typeof EventLogSchema>;

// ─── Object with zero-capture transform (fully compiled since v0.16.0) ──────
// ajv/typia excluded: transform() is a Zod-specific feature

export const PartialFallbackObjectSchema = z.object({
  id: z.number().int().positive(),
  name: z.string().min(1).max(100),
  email: z.email(),
  slug: z.string().transform((v) => v.toLowerCase().replace(/\s+/g, "-")),
  role: z.enum(["admin", "user", "guest"]),
  isActive: z.boolean(),
});

export type PartialFallbackObject = z.infer<typeof PartialFallbackObjectSchema>;

// ─── Array with zero-capture transform (fully compiled since v0.16.0) ───────

const FallbackItemSchema = z.object({
  id: z.number().int().positive(),
  title: z.string().min(1).max(200),
  normalizedTitle: z.string().transform((v) => v.trim().toLowerCase()),
  tags: z.array(z.string().min(1)).max(10),
  score: z.number().positive(),
});

export const FallbackArraySchema = z.array(FallbackItemSchema);
