import { z } from "zod";

// ─── Zero-capture transform (fully compiled by zod-compiler) ────────────────────

export const ZeroCaptureTransformStringSchema = z.string().transform((v) => v.trim().toLowerCase());

export const ZeroCaptureTransformObjectSchema = z.object({
  name: z.string().min(1).max(100),
  slug: z.string().transform((v) => v.toLowerCase().replace(/\s+/g, "-")),
  score: z.number().transform((v) => Math.round(v * 100) / 100),
});

// ─── Zero-capture refine (inlined as check by zod-compiler) ─────────────────────

export const ZeroCaptureRefineStringSchema = z
  .string()
  .refine((v) => v.length > 0 && v.length < 256, {
    message: "Must be 1-255 characters",
  });

export const ZeroCaptureRefineObjectSchema = z.object({
  email: z.string().refine((v) => v.includes("@") && v.includes("."), {
    message: "Must contain @ and .",
  }),
  age: z.number().refine((v) => v >= 0 && v <= 150, {
    message: "Must be 0-150",
  }),
});

// ─── Captured-variable transform (Zod fallback) ────────────────────────────

const prefix = "usr_";
export const CapturedTransformSchema = z.string().transform((v) => prefix + v.toLowerCase());

const multiplier = 2.5;
export const CapturedTransformObjectSchema = z.object({
  label: z.string().transform((v) => prefix + v),
  value: z.number().transform((v) => v * multiplier),
});

// ─── Captured-variable refine (Zod fallback) ───────────────────────────────

const allowedDomains = ["example.com", "test.com"];
export const CapturedRefineSchema = z
  .string()
  .refine((v) => allowedDomains.some((d) => v.endsWith(d)), {
    message: "Invalid domain",
  });
