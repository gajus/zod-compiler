import { z } from "zod";

// ─── Tuple ───────────────────────────────────────────────────────────────────

export const TupleSchema = z.tuple([z.string(), z.number().int(), z.boolean()]);

// ─── Record ──────────────────────────────────────────────────────────────────

export const RecordSchema = z.record(z.string(), z.number());

// ─── Set ─────────────────────────────────────────────────────────────────────

export const SetSchema = z.set(z.string().min(1)).min(1).max(100);

// ─── Map ─────────────────────────────────────────────────────────────────────

export const MapSchema = z.map(z.string().min(1), z.number().int().nonnegative());

// ─── Pipe (non-transform) ───────────────────────────────────────────────────

export const PipeSchema = z.string().min(1).pipe(z.string().max(100));
