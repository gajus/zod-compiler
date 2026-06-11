import { z } from "zod3";

// Bare primitives
export const v3SimpleString = z.string();
export const v3SimpleNumber = z.number();
export const v3SimpleBoolean = z.boolean();

// Primitives with checks
export const v3StringWithChecks = z.string().min(3).max(50);
export const v3NumberWithChecks = z.number().int().positive();

// Enum
export const v3SimpleEnum = z.enum(["admin", "user", "guest", "moderator"]);

// BigInt with checks
export const v3BigIntSchema = z.bigint().min(0n).max(1000000n);
