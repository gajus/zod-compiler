import { z } from "zod";

// The three shapes `.readonly()` compiles to, each with a different profile.
//
// 1. Over a PRIMITIVE the freeze is unobservable (`Object.isFrozen("a")` is
//    already true), so the wrapper compiles away and the enclosing object keeps
//    its zero-allocation fast path.
export const ReadonlyFieldSchema = z.object({
  foo: z.string().readonly(),
  bar: z.array(z.number().int()),
});

// 2. Over a stripping object the freeze IS observable, and the value being
//    frozen is one the compiler allocated (a strip object rebuilds), so it is
//    emitted. Costs the rebuild plus the Object.freeze that zod also pays.
export const ReadonlyRootSchema = z
  .object({
    foo: z.string(),
    bar: z.array(z.number().int()),
  })
  .readonly();

// 3. Over an array — a container compiled validators hand back BY REFERENCE.
//    Freezing it would freeze the caller's own array, so the validator freezes a
//    shallow copy instead, which is what zod's own rebuild amounts to here. Costs
//    the copy plus the Object.freeze that zod also pays.
export const ReadonlyArraySchema = z.array(z.number().int()).readonly();
