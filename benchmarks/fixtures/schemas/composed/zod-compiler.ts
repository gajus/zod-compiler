import { compile } from "zod-compiler";
// compile() is identity-preserving: it installs the compiled methods on the
// schema instance it receives. Clone so the plain-zod baseline rows keep
// measuring pristine zod instead of the compiled validator.
import { ComposedItemSchema, ComposedTaggedItemSchema, paginated } from "./zod.js";

export const aotComposedItem = compile(ComposedItemSchema.clone());

// NOT compiled, and not meant to be: the same factory call as the plain page,
// over the compiled item. Every row using it measures zod's own traversal
// arriving at a compiled child.
export const pageOverCompiledItem = paginated(aotComposedItem);

export const aotComposedTaggedItem = compile(ComposedTaggedItemSchema.clone());

export const pageOverCompiledTaggedItem = paginated(aotComposedTaggedItem);
