import { z } from "zod";
import { compile } from "zod-compiler";

// compile() is identity-preserving (it installs the compiled methods on the
// schema instance it receives), so the aot schema must NOT share an instance
// with the plain-zod baseline. A .clone() is not enough here: the lazy
// self-reference inside a clone still points at the ORIGINAL instance, which
// breaks direct-self-recursion detection (root would differ from the ref
// target). Re-declare the recursive schema instead.
const AotTreeNodeSchema: z.ZodType = z.object({
  value: z.string().min(1),
  children: z.array(z.lazy(() => AotTreeNodeSchema)),
});

export const aotTree = compile(AotTreeNodeSchema);
