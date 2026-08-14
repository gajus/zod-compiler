import type { SchemaIR } from "../../types.js";
import {
  isContextFreeUnaryCallback,
  isReferenceablePredicate,
  observesSecondArgument,
  tryCompileEffect,
} from "../effects.js";
import type { ExtractorContext, ZodDef } from "../types.js";
import { extractStringBool, isStringBoolCodec } from "./string-bool.js";

export function extractPipe(def: ZodDef, ctx: ExtractorContext): SchemaIR {
  // Detect stringbool Codec (string→boolean with transform + reverseTransform)
  if (isStringBoolCodec(def)) {
    const ir = extractStringBool(def, ctx);
    if (ir) return ir;
    // Probing failed — fall back to Zod
    return ctx.fallback("transform");
  }

  // Other Codecs (z.codec): the decode transform lives on the pipe def itself.
  // Compiling in/out as a plain pipe would validate the untransformed value
  // against the output schema — delegate to Zod.
  if (def.transform !== undefined) {
    return ctx.fallback("transform");
  }

  // z.preprocess(fn, schema) is represented as pipe(transform(fn), schema):
  // run the callback before validating the output schema. A synchronous
  // single-argument callback needs no Zod parse context, so it can use the
  // same inline-or-reference machinery as a regular transform.
  const inDef = def.in?._zod?.def;
  if (inDef && inDef.type === "transform" && isContextFreeUnaryCallback(inDef.transform)) {
    const source = tryCompileEffect(inDef.transform);
    if (source) {
      return {
        type: "effect",
        effectKind: "preprocess",
        source,
        inner: ctx.visit(def.out, "._zod.def.out"),
      };
    }
    if (ctx.refs) {
      const refIndex = ctx.refs.length;
      ctx.refs.push({
        schema: inDef.transform,
        accessPath: `${ctx.path}._zod.def.in._zod.def.transform`,
      });
      return {
        type: "effect",
        effectKind: "preprocess",
        refIndex,
        inner: ctx.visit(def.out, "._zod.def.out"),
      };
    }
  }

  const outDef = def.out?._zod?.def;
  if (outDef && outDef.type === "transform") {
    // Zod calls `transform(payload.value, payload)`; both compiled routes below
    // pass the value alone. A callback whose parameter list PROVES it reads that
    // second argument has to stay with zod — `fn.length` cannot see it, since it
    // stops at the first default and ignores a rest element, so
    // `(...args) => args.length` and `(v, ctx = null) => …` both slipped through
    // and silently computed a different result compiled than under zod.
    //
    // A signature that cannot be READ (a native, a bound function) is not
    // thereby suspect and keeps the reference route. That knowingly retains a
    // narrow pre-existing hole — a variadic native like `String.fromCharCode`,
    // or `((...args) => …).bind(null)`, reports length 0 and still sees only one
    // argument compiled — because closing it would make the far more common
    // `.transform(Number)` delegate, which measures slower than not compiling.
    if (!observesSecondArgument(outDef.transform)) {
      const source = tryCompileEffect(outDef.transform);
      if (source) {
        const inIR = ctx.visit(def.in, "._zod.def.in");
        return { type: "effect", effectKind: "transform", source, inner: inIR };
      }
      // Not inlineable (the callback captures, or its source is not an
      // expression). Call the user's own function through a schema reference
      // rather than delegating: falling back costs the schema its compiled path
      // AND adds the delegate wrapper on top, which measured SLOWER than plain
      // zod.
      if (ctx.refs && isReferenceablePredicate(outDef.transform)) {
        const refIndex = ctx.refs.length;
        ctx.refs.push({
          schema: outDef.transform,
          accessPath: `${ctx.path}._zod.def.out._zod.def.transform`,
        });
        const inIR = ctx.visit(def.in, "._zod.def.in");
        return { type: "effect", effectKind: "transform", refIndex, inner: inIR };
      }
    }
    // A ctx-taking transform is zod's issue-collection protocol and an async one
    // returns a promise, so both delegate.
    return ctx.fallback("transform");
  }
  const inIR = ctx.visit(def.in, "._zod.def.in");
  const outIR = ctx.visit(def.out, "._zod.def.out");
  return { type: "pipe", in: inIR, out: outIR };
}
