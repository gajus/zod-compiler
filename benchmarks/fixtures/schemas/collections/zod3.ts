import { z } from "zod3";

// ─── Tuple ───────────────────────────────────────────────────────────────────

export const v3TupleSchema = z.tuple([z.string(), z.number().int(), z.boolean()]);

// ─── Record ──────────────────────────────────────────────────────────────────

export const v3RecordSchema = z.record(z.string(), z.number());

// ─── Set ─────────────────────────────────────────────────────────────────────

export const v3SetSchema = z.set(z.string().min(1)).min(1).max(100);

// ─── Map ─────────────────────────────────────────────────────────────────────

export const v3MapSchema = z.map(z.string().min(1), z.number().int().nonnegative());

// ─── Pipe (non-transform) ───────────────────────────────────────────────────

export const v3PipeSchema = z.string().min(1).pipe(z.string().max(100));
