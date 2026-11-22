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
  compileLeanLikeProduction,
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

  it("hands the callback a plain object, as zod does", () => {
    // The payload comes from a constructor (see ZC_SR_PAYLOAD_DECL), whose
    // prototype is `Object.prototype` so a callback cannot tell it from zod's
    // literal. The inputs reach each helper that builds one: the build (valid),
    // a walk after a member's issue (`__zcSrP`) and a walk without one (`__zcSr`).
    const make = (seen: string[]) => {
      const record = (ctx: object) => {
        const issues = (ctx as { issues: unknown }).issues;
        seen.push(
          `${Object.getPrototypeOf(ctx) === Object.prototype} ${ctx.constructor === Object} ` +
            `${Array.isArray(issues)} ${Object.keys(ctx).join()}`,
        );
      };
      return z
        .object({
          age: z.number(),
          name: z
            .string()
            .min(3)
            .superRefine((_v, ctx) => record(ctx)),
        })
        .superRefine((_v, ctx) => record(ctx));
    };
    for (const compile of [compileLikeProduction, compileLeanLikeProduction]) {
      for (const input of [
        { age: 36, name: "Ada" },
        { age: 36, name: "Al" },
        { age: "x", name: "Ada" },
      ]) {
        const zodSaw: string[] = [];
        const compiledSaw: string[] = [];
        make(zodSaw).safeParse(input);
        const result = compile(make(compiledSaw), "srPlain")(input);
        if (!result.success) void result.error.issues;
        const label = JSON.stringify(input);
        expect(zodSaw.length, label).toBeGreaterThan(0);
        expect(compiledSaw.length, label).toBeGreaterThanOrEqual(zodSaw.length);
        for (const seen of compiledSaw) expect(zodSaw, label).toContain(seen);
      }
    }
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
   * Build the schema twice, each recording what its callback is shown, and
   * hold the compiled one to zod's view as well as to zod's results. The
   * compiled callback may run twice where zod runs it once — in the build,
   * then in the walk the issues are read from — and sees zod's view each
   * time: the build reaches the check only where zod's payload holds no
   * issues, and the walk hands over the node's own.
   */
  function expectZodsView(make: (record: (ctx: Ctx) => void) => z.ZodType, inputs: unknown[]) {
    let zodSaw: string[] = [];
    let compiledSaw: string[] = [];
    const reference = make((ctx) => zodSaw.push(view(ctx)));
    const compiled = compileLikeProduction(
      make((ctx) => compiledSaw.push(view(ctx))),
      "srView",
    );
    for (const input of inputs) {
      zodSaw = [];
      compiledSaw = [];
      reference.safeParse(input);
      const result = compiled(input);
      if (!result.success) void result.error.issues;
      const label = JSON.stringify(input);
      for (const seen of compiledSaw) expect(zodSaw, label).toContain(seen);
      expect(compiledSaw.length, label).toBeGreaterThanOrEqual(zodSaw.length);
      expect(compiledSaw.length, label).toBeLessThanOrEqual(2 * zodSaw.length);
    }
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

describe("superRefine — how often the callback runs", () => {
  // A node carrying one has no fast check (see hasSuperRefine): a verdict there
  // could only come from calling the callback, and the walk called it again.
  // On the build path, a superRefine on the ROOT runs exactly as often as zod's,
  // whatever the input: nothing is left to validate after it, so what it raises
  // is the whole error, built from that one call (see ZC_SR_BUILD_DECL), and a
  // build that failed before reaching it is settled on the walk, which calls it
  // once. One further down runs as zod's does on valid input; on rejected input
  // the walk calls it again after the build did, as with `.refine()`: at most
  // twice zod's count.
  let calls = 0;
  const reject = (v: unknown, ctx: z.core.$RefinementCtx<unknown>) => {
    calls++;
    if (v === 13 || (Array.isArray(v) && v.length > 2)) ctx.addIssue("rejected");
  };
  const rejectObject = (v: { n: unknown }, ctx: z.core.$RefinementCtx<{ n: unknown }>) => {
    calls++;
    if (v.n === 13) ctx.addIssue("rejected");
  };
  const ROOT: [string, () => z.ZodType, unknown[]][] = [
    ["a number", () => z.number().min(5).superRefine(reject), [7, 13, 1, "x"]],
    [
      "a number whose callback rewrites ctx.value",
      () =>
        z.number().superRefine((v, ctx) => {
          calls++;
          ctx.value = v + 1;
        }),
      [1, "x"],
    ],
    ["a string", () => z.string().min(1).superRefine(reject), ["ok", "", 1]],
    ["an array", () => z.array(z.number()).superRefine(reject), [[1], [1, 2, 3], ["x"]]],
    [
      "an object",
      () => z.object({ n: z.number(), s: z.string() }).superRefine(rejectObject),
      [{ n: 1, s: "a" }, { n: 13, s: "a" }, { n: 1, s: 2 }, null],
    ],
    [
      "a strict object",
      () => z.strictObject({ n: z.number() }).superRefine(rejectObject),
      [{ n: 1 }, { n: 13 }, { n: 1, extra: true }],
    ],
  ];
  const NESTED: [string, () => z.ZodType, valid: unknown[], rejected: unknown[]][] = [
    ["an optional number", () => z.number().superRefine(reject).optional(), [7, undefined], [13]],
    [
      "a nullable number",
      () => z.number().min(1).superRefine(reject).nullable(),
      [7, null],
      [13, 0],
    ],
    ["array elements", () => z.array(z.number().superRefine(reject)), [[1, 2]], [[1, 13, 2], [13]]],
    [
      "a tuple item",
      () => z.tuple([z.number().superRefine(reject), z.string()]),
      [[1, "a"]],
      [
        [13, "a"],
        [1, 2],
      ],
    ],
    [
      "a strict object member",
      () => z.strictObject({ n: z.number().superRefine(reject) }),
      [{ n: 1 }],
      [{ n: 13 }],
    ],
    [
      "an object member",
      () =>
        z.object({ id: z.string(), inner: z.object({ n: z.number() }).superRefine(rejectObject) }),
      [{ id: "1", inner: { n: 1 } }],
      [
        { id: "1", inner: { n: 13 } },
        { id: 1, inner: { n: 13 } },
      ],
    ],
    ["a union option", () => z.union([z.number().superRefine(reject), z.string()]), [1, "a"], [13]],
  ];
  const ENTRY_POINTS: [string, (schema: z.ZodType, input: unknown) => unknown][] = [
    [
      "safeParse",
      (schema, input) => {
        const result = schema.safeParse(input);
        return result.success ? result.data : result.error.issues;
      },
    ],
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
    [
      ".is()",
      (schema, input) =>
        // zod's own verdict costs a safeParse; `.is()` is the compiled schema's.
        "is" in schema
          ? (schema as unknown as { is(x: unknown): boolean }).is(input)
          : schema.safeParse(input).success,
    ],
  ];

  /** Calls the callback made through `run`, zod's first and the compiled schema's second. */
  function count(
    make: () => z.ZodType,
    run: (s: z.ZodType, x: unknown) => unknown,
    input: unknown,
  ) {
    calls = 0;
    run(make(), input);
    const zod = calls;
    calls = 0;
    run(installOnto(make()), input);
    return [zod, calls] as const;
  }

  for (const [label, make, inputs] of ROOT) {
    it(`on the root, as often as zod's: ${label}`, () => {
      for (const [entry, run] of ENTRY_POINTS) {
        for (const input of inputs) {
          const [zod, compiled] = count(make, run, input);
          expect(compiled, `${entry}(${JSON.stringify(input)})`).toBe(zod);
        }
      }
      expectParity(make(), inputs);
    });
  }

  for (const [label, make, valid, rejected] of NESTED) {
    it(`further down, as zod's on valid input and at most twice on rejected: ${label}`, () => {
      for (const [entry, run] of ENTRY_POINTS) {
        for (const input of valid) {
          const [zod, compiled] = count(make, run, input);
          expect(compiled, `${entry}(${JSON.stringify(input)})`).toBe(zod);
        }
        for (const input of rejected) {
          const [zod, compiled] = count(make, run, input);
          expect(compiled, `${entry}(${JSON.stringify(input)})`).toBeLessThanOrEqual(2 * zod);
        }
      }
      expectParity(make(), [...valid, ...rejected]);
    });
  }

  it("accepts what a callback that takes its node's issues back accepts", () => {
    // A failed build is no rejection here: the callback runs on the walk, sees
    // the issue the short `a` raised, and clears it, as zod's does.
    const clear = (_v: unknown, ctx: z.core.$RefinementCtx<unknown>) => {
      ctx.issues.length = 0;
    };
    const SCHEMAS: [string, () => z.ZodType, unknown[]][] = [
      [
        "on the root",
        () => z.object({ a: z.string().min(3) }).superRefine(clear),
        [{ a: "x" }, { a: 1 }],
      ],
      [
        "on a member",
        () =>
          z.object({
            id: z.number(),
            inner: z.object({ a: z.string().min(3) }).superRefine(clear),
          }),
        [
          { id: 1, inner: { a: "x" } },
          { id: "x", inner: { a: "x" } },
        ],
      ],
      [
        "on array elements",
        () => z.array(z.string().min(3).superRefine(clear)),
        [["x", "yyy"], [1]],
      ],
    ];
    for (const [label, make, inputs] of SCHEMAS) {
      expect(make().safeParse(inputs[0]).success, label).toBe(true);
      expectParity(make(), inputs, label);
      expectLeanParity(make(), inputs, label);
      expectParity(make(), inputs, label, undefined, { compact: true });
    }
  });

  it("runs the callbacks of an object's members in zod's order", () => {
    // The build validates the cheapest members first; a superRefine is pinned
    // to its place, as a transform is, since its callback may watch the order.
    let order: string[] = [];
    const make = () =>
      z.object({
        tags: z.array(z.string()).superRefine(() => {
          order.push("tags");
        }),
        n: z.number(),
        name: z.string().superRefine(() => {
          order.push("name");
        }),
        flag: z.boolean(),
      });
    const input = { tags: ["a"], n: 1, name: "x", flag: true };
    make().safeParse(input);
    const zodOrder = order;
    order = [];
    installOnto(make()).safeParse(input);
    expect(order).toEqual(zodOrder);
  });

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
