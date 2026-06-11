import { compile } from "zod-compiler";
import { DiscriminatedUnionSchema } from "./zod.js";
// compile() is identity-preserving: it installs the compiled methods on the
// schema instance it receives. Clone so the plain-zod baseline rows keep
// measuring pristine zod instead of the compiled validator.

export const aotDiscUnion = compile(DiscriminatedUnionSchema.clone());
