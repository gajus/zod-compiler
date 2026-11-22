/**
 * `.superRefine()` — the issue-collecting refinement protocol.
 *
 * A `.refine()` predicate returns a verdict, so compiled code can call it and
 * read the boolean. A `superRefine` callback instead receives zod's PAYLOAD
 * (`{ value, issues }`) and pushes onto it, so there is no verdict to read — and
 * because zod stores it on the check instance (`_zod.check`) rather than
 * `def.fn`, it used to cost the schema its compiled path entirely.
 *
 * It is now called through an `__rf[N]` reference to zod's own wrapper with a
 * synthesized payload. The wrapper installs `addIssue` and normalizes what the
 * user adds, so issue shapes are zod's by construction; the generated helpers
 * only reproject paths and drop the bookkeeping zod deletes (`inst`/`continue`).
 *
 * Two semantics constrain when this is legal, both covered below: an issue that
 * ABORTS truncates zod's remaining check chain (so only a LAST check compiles),
 * and `payload.value` is writable public API (so the value is written back, by
 * the walk: a node carrying a superRefine has no fast check, see the last
 * block below).
 */
import { describe, expect, it } from "vite-plus/test";
import { core, z } from "zod";
import { extractSchema, type RefEntry } from "#src/core/extract/index.js";
import type { ArrayIR, ObjectIR, SchemaIR, StringIR } from "#src/core/types.js";
import {
  compileLikeProduction,
  expectLeanParity,
  expectParity,
  installOnto,
} from "./parity-harness.js";

const irOf = (schema: unknown): { ir: SchemaIR; refs: RefEntry[] } => {
  const refs: RefEntry[] = [];
  return { ir: extractSchema(schema, refs), refs };
};

const LIMIT = 10;

describe("superRefine — compiles by calling zod's payload wrapper", () => {
  it("references the wrapper on the check instance, not def.fn", () => {
    const schema = z.object({ a: z.number() }).superRefine((v, ctx) => {
      if (v.a > LIMIT) ctx.addIssue("too big");
    });
    const { ir, refs } = irOf(schema);
    expect(ir.type).toBe("object");
    expect((ir as ObjectIR).checks?.[0]).toEqual({ kind: "super_refine_effect", refIndex: 0 });
    expect(refs[0]?.accessPath).toBe("._zod.def.checks[0]._zod.check");
    expect(refs[0]?.schema).toBeTypeOf("function");
  });

  it.each([
    [
      "cross-field issue with a path",
      z.object({ a: z.number(), b: z.number() }).superRefine((v, ctx) => {
        if (v.a > v.b) ctx.addIssue({ code: "custom", message: "a>b", path: ["a"] });
      }),
      [{ a: 5, b: 1 }, { a: 1, b: 5 }, { a: "x", b: 1 }, null],
    ],
    [
      "string shorthand issue",
      z.object({ a: z.number() }).superRefine((v, ctx) => {
        if (v.a < 0) ctx.addIssue("negative");
      }),
      [{ a: -1 }, { a: 1 }],
    ],
    [
      "several issues from one callback",
      z.object({ a: z.number() }).superRefine((v, ctx) => {
        if (v.a < LIMIT) ctx.addIssue("small");
        if (v.a % 2) ctx.addIssue({ message: "odd", path: ["a"] });
      }),
      [{ a: 3 }, { a: 12 }, { a: 11 }],
    ],
    [
      "issue with no message (locale default)",
      z.object({ a: z.number() }).superRefine((v, ctx) => {
        if (v.a < LIMIT) ctx.addIssue({});
      }),
      [{ a: 1 }, { a: 50 }],
    ],
    [
      "non-custom issue code",
      z.object({ a: z.number() }).superRefine((v, ctx) => {
        if (v.a > 100) {
          ctx.addIssue({
            code: "too_big",
            maximum: 100,
            origin: "number",
            inclusive: true,
          } as never);
        }
      }),
      [{ a: 500 }, { a: 5 }],
    ],
    [
      "on a string",
      z
        .string()
        .min(2)
        .superRefine((v, ctx) => {
          if (!v.startsWith("z")) ctx.addIssue("must start with z");
        }),
      ["zed", "abc", "z", 1, null],
    ],
    [
      "on a number",
      z.number().superRefine((v, ctx) => {
        if (v > LIMIT) ctx.addIssue("too big");
      }),
      [5, 50, "x"],
    ],
    [
      "on an array",
      z.array(z.number()).superRefine((v, ctx) => {
        if (v.length < 2) ctx.addIssue("short");
      }),
      [[1, 2], [1], [1, "x"], "nope"],
    ],
    [
      "on a nested object field",
      z.object({
        inner: z.object({ a: z.number() }).superRefine((v, ctx) => {
          if (v.a < 0) ctx.addIssue({ message: "neg", path: ["a"] });
        }),
      }),
      [{ inner: { a: 1 } }, { inner: { a: -1 } }, { inner: { a: "x" } }],
    ],
    [
      "on each element of an array",
      z.array(
        z.object({ a: z.number() }).superRefine((v, ctx) => {
          if (v.a < 0) ctx.addIssue("neg");
        }),
      ),
      [[{ a: 1 }, { a: -1 }], []],
    ],
    [
      "after a refine on the same node",
      z
        .object({ a: z.number() })
        .refine((v) => v.a !== 42, "not 42")
        .superRefine((v, ctx) => {
          if (v.a < 0) ctx.addIssue("neg");
        }),
      [{ a: -1 }, { a: 42 }, { a: 1 }],
    ],
    [
      "on a strict object",
      z
        .object({ a: z.number() })
        .strict()
        .superRefine((v, ctx) => {
          if (v.a < 0) ctx.addIssue("neg");
        }),
      [{ a: 1 }, { a: -1 }, { a: 1, extra: true }],
    ],
  ])("matches zod (verdict, issues AND output) for %s", (_label, schema, inputs) => {
    expectParity(schema as never, inputs as unknown[]);
  });

  it("prunes a failing union option the way zod does", () => {
    // An issue with no `continue` aborts, which is how zod decides an option
    // failed — without that the option's issue surfaces outside invalid_union.
    const schema = z.union([
      z.object({ t: z.literal("a"), n: z.number() }).superRefine((v, ctx) => {
        if (v.n < 0) ctx.addIssue("neg");
      }),
      z.object({ t: z.literal("b") }),
    ]);
    expectParity(schema, [{ t: "a", n: 1 }, { t: "a", n: -1 }, { t: "b" }, { t: "c" }]);
  });

  it("propagates a value the callback rewrites through ctx.value", () => {
    // $RefinementCtx extends ParsePayload, so `value` is writable public API.
    const schema = z.string().superRefine((v, ctx) => {
      ctx.value = v.trim();
    });
    expect(compileLikeProduction(schema, "srMutate")("  hi  ")).toEqual({
      success: true,
      data: "hi",
    });
    expectParity(schema, ["  hi  ", "ok", 1]);
  });

  it("propagates a rewritten value together with an issue", () => {
    const schema = z.string().superRefine((v, ctx) => {
      ctx.value = v.trim();
      if (v.trim() === "") ctx.addIssue("empty");
    });
    expectParity(schema, ["  hi  ", "   ", ""]);
  });

  it("honors a callback that sets ctx.aborted or pushes issues directly", () => {
    const aborts = z.string().superRefine((v, ctx) => {
      if (v === "") {
        ctx.aborted = true;
        ctx.addIssue("empty");
      }
    });
    const pushes = z.string().superRefine((v, ctx) => {
      if (v === "") ctx.issues.push({ code: "custom", message: "raw", input: v } as never);
    });
    expectParity(aborts, ["", "ok"]);
    expectParity(pushes, ["", "ok"]);
  });

  it("keeps the node compiled on string, number and array too", () => {
    const s = irOf(z.string().superRefine(() => {})).ir as StringIR;
    const n = irOf(z.number().superRefine(() => {})).ir;
    const a = irOf(z.array(z.number()).superRefine(() => {})).ir as ArrayIR;
    expect(s.type).toBe("string");
    expect(n.type).toBe("number");
    expect(a.type).toBe("array");
    expect(s.checks).toContainEqual({ kind: "super_refine_effect", refIndex: 0 });
    expect(a.checks).toContainEqual({ kind: "super_refine_effect", refIndex: 0 });
  });

  describe("delegates the shapes a plain call cannot reproduce", () => {
    it("falls back when another check follows (an abort would truncate it)", () => {
      const schema = z
        .object({ a: z.number() })
        .superRefine((v, ctx) => {
          if (v.a < 0) ctx.addIssue({ fatal: true, message: "fatal" });
        })
        .refine((v) => v.a !== 42, "not 42");
      expect(irOf(schema).ir.type).toBe("fallback");
      expectParity(schema, [{ a: -1 }, { a: 42 }, { a: 1 }]);
    });

    it("falls back for a raw .check(), whose callback is the user's own", () => {
      // Shape-identical to superRefine but NOT zod's wrapper, so `addIssue` is
      // never installed and the callback may do anything with the payload.
      const schema = z.string().check((payload) => {
        payload.value = payload.value.trim();
      });
      expect(irOf(schema).ir.type).toBe("fallback");
      expectParity(schema, ["  hi  ", "ok"]);
    });

    it("raises zod's $ZodAsyncError for an async callback, as zod does", () => {
      // The ref points at zod's WRAPPER, so the user's callback being async is
      // invisible while extracting — the promise it returns is the only
      // evidence, and a synchronous parse must raise on it rather than accept.
      const schema = z.string().superRefine(async (v, ctx) => {
        if (v === "") ctx.addIssue("empty");
      });
      expect(irOf(schema).ir.type).toBe("string");
      expect(() => compileLikeProduction(schema, "srAsync")("ok")).toThrow(core.$ZodAsyncError);
      expectParity(schema, ["", "ok"]);
    });

    it("falls back for a check with a `when` predicate, which zod may skip", () => {
      const inner = z.string().superRefine((v, ctx) => {
        if (v === "") ctx.addIssue("empty");
      });
      const [check] = (
        inner as unknown as {
          _zod: { def: { checks: { _zod: { def: Record<string, unknown> } }[] } };
        }
      )._zod.def.checks;
      if (check === undefined) throw new Error("expected a check");
      check._zod.def["when"] = () => true;
      expect(irOf(inner).ir.type).toBe("fallback");
    });

    it("falls back when refs are not being collected", () => {
      // Without a ref table there is no way to reach the callback.
      const ir = extractSchema(z.string().superRefine(() => {}));
      expect(ir.type).toBe("fallback");
    });
  });
});

describe("superRefine — the issues its node already has", () => {
  // zod hands the callback the node's own payload. When a member or an earlier
  // check failed without aborting (a `.min()`, a `.refine()`), the check still
  // runs, and `ctx.issues` holds those issues with paths relative to the node.
  // The compiled walk handed the callback an empty list, so one that skips its
  // cross-field rule while the fields are invalid reported an issue zod never
  // does.

  type Ctx = { issues: { code: string; path: PropertyKey[] }[] };
  const view = (ctx: Ctx): string =>
    JSON.stringify(ctx.issues.map(({ code, path }) => ({ code, path })));

  /**
   * Build the schema twice, each recording what its callback is shown, and hold
   * the compiled one to zod's view as well as to zod's results.
   */
  function expectZodsView(make: (record: (ctx: Ctx) => void) => z.ZodType, inputs: unknown[]) {
    const zodSaw: string[] = [];
    const compiledSaw: string[] = [];
    const reference = make((ctx) => zodSaw.push(view(ctx)));
    const compiled = compileLikeProduction(
      make((ctx) => compiledSaw.push(view(ctx))),
      "srView",
    );
    for (const input of inputs) {
      reference.safeParse(input);
      compiled(input);
    }
    expect(compiledSaw).toEqual(zodSaw);
    // Inline output declares the helpers in its own preamble; lean output
    // imports them from the runtime module, where `__zcSrP` stays module-local.
    expectParity(
      make(() => {}),
      inputs,
    );
    expectLeanParity(
      make(() => {}),
      inputs,
    );
  }

  /** A cross-field rule that waits until the fields themselves are valid. */
  const sameGuarded =
    (record: (ctx: Ctx) => void) =>
    (v: { a: string; b: string }, ctx: z.core.$RefinementCtx<{ a: string; b: string }>) => {
      record(ctx as unknown as Ctx);
      if (ctx.issues.length > 0) return;
      if (v.a === v.b) ctx.addIssue({ code: "custom", message: "same", path: ["b"] });
    };

  it("after a member failed a check that does not abort", () => {
    expectZodsView(
      (record) =>
        z.object({ a: z.string().min(3), b: z.string() }).superRefine(sameGuarded(record)),
      [
        { a: "x", b: "x" },
        { a: "xyz", b: "xyz" },
        { a: "xyz", b: "abc" },
        { a: 1, b: "x" },
      ],
    );
  });

  it("after an earlier refine on the same node", () => {
    expectZodsView(
      (record) =>
        z
          .object({ a: z.string(), b: z.string() })
          .refine((v) => v.a !== "bad", "bad a")
          .superRefine(sameGuarded(record)),
      [
        { a: "bad", b: "bad" },
        { a: "ok", b: "ok" },
      ],
    );
  });

  it("with paths relative to a nested node", () => {
    expectZodsView(
      (record) =>
        z.object({
          outer: z.string().min(2),
          inner: z.object({ a: z.string().min(3), b: z.string() }).superRefine(sameGuarded(record)),
        }),
      [
        { outer: "x", inner: { a: "x", b: "x" } },
        { outer: "xy", inner: { a: "xyz", b: "xyz" } },
      ],
    );
  });

  it("on a string, a number and an array", () => {
    // The callback adds an issue only where the node has one already. One that
    // rejected a value the checks before it accepted would run twice on a root
    // primitive: its fast check calls the callback too, and the walk calls it
    // again for the issues.
    const recordAndEcho =
      (record: (ctx: Ctx) => void) => (_v: unknown, ctx: z.core.$RefinementCtx<unknown>) => {
        record(ctx as unknown as Ctx);
        if (ctx.issues.length > 0) ctx.addIssue("echo");
      };
    expectZodsView(
      (record) => z.object({ s: z.string().min(3).superRefine(recordAndEcho(record)) }),
      [{ s: "x" }, { s: "xyz" }],
    );
    expectZodsView((record) => z.number().min(5).superRefine(recordAndEcho(record)), [1, 7]);
    expectZodsView(
      (record) => z.array(z.string().min(2)).min(3).superRefine(recordAndEcho(record)),
      [["a", "bb", "c"], ["aa", "bb", "cc"], ["a"]],
    );
  });

  it("that the callback clears or rewrites", () => {
    // The list is the node's: what the callback leaves in it is what the node
    // reports.
    expectZodsView(
      (record) =>
        z.object({ a: z.string().min(3), b: z.string().min(3) }).superRefine((_v, ctx) => {
          record(ctx as unknown as Ctx);
          ctx.issues.splice(0, 1);
        }),
      [
        { a: "x", b: "y" },
        { a: "x", b: "yyy" },
        { a: "xxx", b: "yyy" },
      ],
    );
    expectZodsView(
      (record) =>
        z.object({ a: z.string().min(3) }).superRefine((_v, ctx) => {
          record(ctx as unknown as Ctx);
          for (const issue of ctx.issues) issue.message = "rewritten";
        }),
      [{ a: "x" }, { a: "xxx" }],
    );
  });
});

describe("superRefine — the callback runs as often as zod runs it", () => {
  // A node carrying one has no fast check (see hasSuperRefine). A verdict on it
  // could only come from calling the callback, and one that rejected the value,
  // or rewrote `ctx.value`, sent the parse on to the walk, which called it
  // again: twice through `safeParse` and `.is()`, three times through
  // `parse()`, and on every array element ahead of the one rejected.
  let calls = 0;
  const reject = (v: unknown, ctx: z.core.$RefinementCtx<unknown>) => {
    calls++;
    if (v === 13) ctx.addIssue("rejected");
  };
  const SHAPES: [string, () => z.ZodType, unknown[]][] = [
    ["a number", () => z.number().min(5).superRefine(reject), [7, 13]],
    [
      "a number whose callback rewrites ctx.value",
      () =>
        z.number().superRefine((v, ctx) => {
          calls++;
          ctx.value = v + 1;
        }),
      [1],
    ],
    ["an optional number", () => z.number().superRefine(reject).optional(), [7, 13, undefined]],
    ["a nullable number", () => z.number().min(1).superRefine(reject).nullable(), [7, 13, null]],
    [
      "an array of numbers",
      () => z.array(z.number().superRefine(reject)),
      [
        [1, 2],
        [1, 13, 2],
      ],
    ],
    [
      "a tuple",
      () => z.tuple([z.number().superRefine(reject), z.string()]),
      [
        [1, "a"],
        [13, "a"],
      ],
    ],
    [
      "a strict object",
      () => z.strictObject({ n: z.number().superRefine(reject) }),
      [{ n: 1 }, { n: 13 }],
    ],
  ];
  const ENTRY_POINTS: [string, (schema: z.ZodType, input: unknown) => unknown][] = [
    ["safeParse", (schema, input) => schema.safeParse(input)],
    [
      "parse",
      (schema, input) => {
        try {
          return schema.parse(input);
        } catch {
          return "threw";
        }
      },
    ],
    ["~standard.validate", (schema, input) => schema["~standard"].validate(input)],
  ];

  for (const [label, make, inputs] of SHAPES) {
    it(label, () => {
      for (const [entry, run] of ENTRY_POINTS) {
        for (const input of inputs) {
          calls = 0;
          run(make(), input);
          const zod = calls;
          calls = 0;
          run(installOnto(make()), input);
          expect(calls, `${entry}(${JSON.stringify(input)})`).toBe(zod);
        }
      }
      // `.is()` is the compiled schema's own; zod's verdict costs a safeParse.
      for (const input of inputs) {
        calls = 0;
        make().safeParse(input);
        const zod = calls;
        calls = 0;
        (installOnto(make()) as unknown as { is(x: unknown): boolean }).is(input);
        expect(calls, `is(${JSON.stringify(input)})`).toBe(zod);
      }
      expectParity(make(), inputs);
    });
  }

  it("returns the value a callback rewrote, from every entry point", () => {
    const compiled = installOnto(
      z.number().superRefine((v, ctx) => {
        ctx.value = v + 1;
      }),
    );
    expect(compiled.parse(1)).toBe(2);
    expect(compiled.safeParse(1)).toEqual({ success: true, data: 2 });
    expect(compiled["~standard"].validate(1)).toEqual({ value: 2 });
  });
});
