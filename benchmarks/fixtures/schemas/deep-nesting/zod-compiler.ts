import { compile } from "zod-compiler";
import { DeepLayoutSchema } from "./zod.js";
// Clone so the plain-zod baseline row keeps measuring pristine zod (compile()
// installs the compiled methods on the instance it receives). Non-recursive, so
// a shallow clone is sufficient here.

export const aotDeepLayout = compile(DeepLayoutSchema.clone());
