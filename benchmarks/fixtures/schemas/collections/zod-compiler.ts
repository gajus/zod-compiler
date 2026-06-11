import { compile } from "zod-compiler";
import { MapSchema, PipeSchema, RecordSchema, SetSchema, TupleSchema } from "./zod.js";
// compile() is identity-preserving: it installs the compiled methods on the
// schema instance it receives. Clone so the plain-zod baseline rows keep
// measuring pristine zod instead of the compiled validator.

export const aotTuple = compile(TupleSchema.clone());
export const aotRecord = compile(RecordSchema.clone());
export const aotSet = compile(SetSchema.clone());
export const aotMap = compile(MapSchema.clone());
export const aotPipe = compile(PipeSchema.clone());
