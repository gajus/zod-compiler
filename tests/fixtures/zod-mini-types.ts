/**
 * Type-level fixture for tests/zod-mini.test.ts (issue #22). Never executed:
 * the test compiles it under the repo's compiler options and requires zero
 * diagnostics, which makes each `@ts-expect-error` line an assertion that the
 * call is rejected.
 */
import { z } from "zod";
import * as zm from "zod/mini";
import type * as core from "zod/v4/core";
import { compile, type CompiledSchema } from "../../src/index.js";
import { jit, jitAll } from "../../src/jit.js";

type Equal<A, B> =
  (<X>() => X extends A ? 1 : 2) extends <X>() => X extends B ? 1 : 2 ? true : false;
declare function expectType<T extends true>(): void;
declare const input: unknown;

// The issue's own repro.
compile(zm.object({}));
jit(zm.object({}));

// Output inference survives, through every method the compiled type promises.
type User = { name: string; age?: number | undefined };
const MiniUser = compile(zm.object({ name: zm.string(), age: zm.optional(zm.number()) }));
const parsed = MiniUser.parse(input);
expectType<Equal<typeof parsed, User>>();
const result = MiniUser.safeParse(input);
if (result.success) expectType<Equal<typeof result.data, User>>();
expectType<Equal<Awaited<ReturnType<typeof MiniUser.parseAsync>>, User>>();
if (MiniUser.is(input)) expectType<Equal<typeof input, User>>();

// A transform's OUTPUT type, not its input.
const Length = jit(
  zm.pipe(
    zm.string(),
    zm.transform((s: string) => s.length),
  ),
);
expectType<Equal<ReturnType<typeof Length.parse>, number>>();

// The schema keeps Mini's own API and its own type.
const Name = compile(zm.string());
Name.check(zm.minLength(1));
export const asMini: zm.ZodMiniString<string> = Name;
export const asCompiled: CompiledSchema<User> = MiniUser;

// Classic schemas are unaffected.
const Classic = compile(z.object({ id: z.string() }).strict());
Classic.extend({ n: z.number() });
expectType<Equal<ReturnType<typeof Classic.parse>, { id: string }>>();

// jitAll() takes any object of schemas.
jitAll({ a: zm.string(), b: z.number() });

// Rejected: a schema built straight from zod/v4/core. It has no parse methods
// of its own, and both functions return it typed as having them.
declare const raw: core.$ZodString;
// @ts-expect-error -- no `parse`/`safeParse` until a build installs them
compile(raw);
// @ts-expect-error -- nor under jit() wherever runtime codegen is off
jit(raw);
// Rejected: anything that is not a zod schema at all.
// @ts-expect-error -- a duck-typed object is not a zod schema
compile({ parse: (value: unknown) => value });
