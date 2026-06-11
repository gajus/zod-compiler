import { z } from "zod";

// Bare primitives
export const SimpleString = z.string();
export const SimpleNumber = z.number();
export const SimpleBoolean = z.boolean();

// Primitives with checks
export const StringWithChecks = z.string().min(3).max(50);
export const NumberWithChecks = z.number().int().positive();

// Enum
export const SimpleEnum = z.enum(["admin", "user", "guest", "moderator"]);

// BigInt with checks
export const BigIntSchema = z.bigint().min(0n).max(1000000n);
