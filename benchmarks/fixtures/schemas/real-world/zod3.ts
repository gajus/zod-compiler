import { z } from "zod3";
import { v3DiscriminatedUnionSchema } from "../unions/zod3.js";

// ─── Event Log (multi-feature realistic scenario) ───────────────────────────

export const v3EventLogSchema = z.object({
  sessionId: z.string().uuid(),
  events: z.array(v3DiscriminatedUnionSchema).min(1),
  dimensions: z.tuple([z.number().int().positive(), z.number().int().positive()]),
  tags: z.record(z.string(), z.string()),
  startedAt: z.date(),
  config: z.object({
    sampleRate: z.number().positive().default(1.0),
    debug: z.boolean().default(false),
  }),
});

export type V3EventLog = z.infer<typeof v3EventLogSchema>;

// ─── Object with zero-capture transform (fully compiled since v0.16.0) ──────
// ajv/typia excluded: transform() is a Zod-specific feature

export const v3PartialFallbackObjectSchema = z.object({
  id: z.number().int().positive(),
  name: z.string().min(1).max(100),
  email: z.string().email(),
  slug: z.string().transform((v) => v.toLowerCase().replace(/\s+/g, "-")),
  role: z.enum(["admin", "user", "guest"]),
  isActive: z.boolean(),
});

export type V3PartialFallbackObject = z.infer<typeof v3PartialFallbackObjectSchema>;

// ─── Array with zero-capture transform (fully compiled since v0.16.0) ───────

const FallbackItemSchema = z.object({
  id: z.number().int().positive(),
  title: z.string().min(1).max(200),
  normalizedTitle: z.string().transform((v) => v.trim().toLowerCase()),
  tags: z.array(z.string().min(1)).max(10),
  score: z.number().positive(),
});

export const v3FallbackArraySchema = z.array(FallbackItemSchema);
