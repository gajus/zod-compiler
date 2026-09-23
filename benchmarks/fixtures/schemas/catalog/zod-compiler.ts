import { compile } from "zod-compiler";
import {
  // compile() is identity-preserving: it installs the compiled methods on the
  // schema instance it receives. Clone so the plain-zod baseline rows keep
  // measuring pristine zod instead of the compiled validator.
  CatalogPageSchema,
  CatalogProductSchema,
} from "./zod.js";

// Compiled in one file so the plugin plans them together: the repeated shapes
// become shared walks, as they would in an application's schema module.
export const aotCatalogProduct = compile(CatalogProductSchema.clone());
export const aotCatalogPage = compile(CatalogPageSchema.clone());
