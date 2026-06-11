import { z } from "zod3";

export const v3TreeNodeSchema: z.ZodType = z.object({
  value: z.string().min(1),
  children: z.array(z.lazy(() => v3TreeNodeSchema)),
});
