import { z } from "zod";

export const TreeNodeSchema: z.ZodType = z.object({
  value: z.string().min(1),
  children: z.array(z.lazy(() => TreeNodeSchema)),
});
