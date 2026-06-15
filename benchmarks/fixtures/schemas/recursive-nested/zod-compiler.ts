import { z } from "zod";
import { compile } from "zod-compiler";

// compile() is identity-preserving (it installs the compiled methods on the
// schema instance it receives), so the aot schema must NOT share an instance
// with the plain-zod baseline. The recursive child is re-declared too: a lazy
// self-reference inside a clone still points at the ORIGINAL instance, which
// would re-link the recursion to the baseline tree. Re-declare both.
const AotCommentSchema: z.ZodType = z.object({
  id: z.string(),
  author: z.string().min(1),
  body: z.string().min(1),
  replies: z.array(z.lazy(() => AotCommentSchema)),
});

const AotCommentThreadSchema = z.object({
  threadId: z.string(),
  locked: z.boolean(),
  root: AotCommentSchema,
});

export const aotThread = compile(AotCommentThreadSchema);
