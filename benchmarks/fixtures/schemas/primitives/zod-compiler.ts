import { compile } from "zod-compiler";
import {
  // compile() is identity-preserving: it installs the compiled methods on the
  // schema instance it receives. Clone so the plain-zod baseline rows keep
  // measuring pristine zod instead of the compiled validator.
  BigIntSchema,
  NumberWithChecks,
  SimpleEnum,
  SimpleString,
  StringWithChecks,
} from "./zod.js";

export const aotSimpleString = compile(SimpleString.clone());
export const aotStringChecks = compile(StringWithChecks.clone());
export const aotNumberChecks = compile(NumberWithChecks.clone());
export const aotEnum = compile(SimpleEnum.clone());
export const aotBigInt = compile(BigIntSchema.clone());
