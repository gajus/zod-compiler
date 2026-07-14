import { z } from "zod";

export const NameSchema = z.string().min(1);
export const LabelSchema = z.string().min(1);
