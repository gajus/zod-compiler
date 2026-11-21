/**
 * An input with a reference cycle, through a recursive schema.
 *
 * Zod 4.5 parses one: its memoizer hands a container still being built back to
 * the reference that closes the cycle, so `a.next = a` comes out as an output
 * whose `next` is that output. The compiled walks go one call deeper per level
 * of the input and keep no record of the values they are inside, so they used
 * to reach the stack limit and throw `RangeError: Maximum call stack size
 * exceeded`. Each synchronous entry point now answers that overflow with the
 * schema's own parse (see ZC_OVERFLOW_DECL), and the asynchronous ones retry
 * through zod on any throw, as they did. What the caller gets is zod's result.
 */
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import * as zm from "zod/mini";
import { compileSchemas } from "#src/core/pipeline.js";
import { generateIIFE } from "#src/core/iife.js";
import type { CodegenMode } from "#src/core/types.js";
import { installLikeProduction, installOnto } from "./parity-harness.js";

/** A value as text, a container met again written as a reference to where it was first seen. */
function render(value: unknown, seen = new Map<object, number>()): string {
  if (typeof value !== "object" || value === null) return `${typeof value}:${String(value)}`;
  const known = seen.get(value);
  if (known !== undefined) return `<ref ${known}>`;
  seen.set(value, seen.size);
  if (Array.isArray(value)) return `[${value.map((v) => render(v, seen)).join(",")}]`;
  const entries = Object.keys(value).map(
    (key) => `${key}=${render((value as Record<string, unknown>)[key], seen)}`,
  );
  return `{${entries.join(",")}}`;
}

interface Outcome {
  kind: "data" | "issues" | "throws";
  text: string;
}

function issuesOf(error: unknown): string {
  const issues = (error as { issues: { code: string; path: PropertyKey[]; message: string }[] })
    .issues;
  return JSON.stringify(issues.map(({ code, path, message }) => ({ code, path, message })));
}

function outcomeOf(result: { success: boolean; data?: unknown; error?: unknown }): Outcome {
  return result.success
    ? { kind: "data", text: render(result.data) }
    : {
        kind: "issues",
        text: `${(result.error as object).constructor.name} ${issuesOf(result.error)}`,
      };
}

function thrown(error: unknown): Outcome {
  return { kind: "throws", text: (error as Error).constructor.name };
}

function attempt(run: () => Outcome): Outcome {
  try {
    return run();
  } catch (error) {
    return thrown(error);
  }
}

async function settle(run: () => Promise<Outcome>): Promise<Outcome> {
  try {
    return await run();
  } catch (error) {
    return thrown(error);
  }
}

interface Shape {
  make: () => z.ZodType;
  /** Inputs whose references close a cycle; at least one valid and one not. */
  inputs: () => unknown[];
}

function chain(value: unknown, last: unknown): { value: unknown; next?: unknown } {
  const head: { value: unknown; next?: unknown } = { value: 1, next: { value, next: last } };
  return head;
}

const SHAPES: Record<string, Shape> = {
  "a getter object": {
    make: () => {
      const Node = z.object({
        value: z.number(),
        get next() {
          return Node.optional();
        },
      });
      return Node;
    },
    inputs: () => {
      const self: Record<string, unknown> = { value: 1 };
      self["next"] = self;
      const two = chain(2, undefined);
      (two.next as Record<string, unknown>)["next"] = two;
      const bad = chain("x", undefined);
      (bad.next as Record<string, unknown>)["next"] = bad;
      return [self, two, bad];
    },
  },
  "a strict getter object": {
    make: () => {
      const Node = z.strictObject({
        value: z.number(),
        get next() {
          return Node.optional();
        },
      });
      return Node;
    },
    inputs: () => {
      const self: Record<string, unknown> = { value: 1 };
      self["next"] = self;
      const extra: Record<string, unknown> = { value: 1, extra: true };
      extra["next"] = extra;
      return [self, extra];
    },
  },
  "a lazy tree": {
    make: () => {
      const Tree: z.ZodType = z.lazy(() => z.object({ name: z.string(), children: z.array(Tree) }));
      return Tree;
    },
    inputs: () => {
      const root = { name: "root", children: [] as unknown[] };
      const leaf = { name: "leaf", children: [root] };
      root.children.push(leaf, root);
      const bad = { name: 1, children: [] as unknown[] };
      bad.children.push(bad);
      return [root, bad];
    },
  },
  "a recursive schema inside an object": {
    make: () => {
      const Node = z.object({
        value: z.number(),
        get next() {
          return Node.optional();
        },
      });
      return z.object({ head: Node, label: z.string() });
    },
    inputs: () => {
      const self: Record<string, unknown> = { value: 1 };
      self["next"] = self;
      return [
        { head: self, label: "a" },
        { head: self, label: 2 },
      ];
    },
  },
  "mutual recursion": {
    make: () => {
      const A: z.ZodType = z.object({ b: z.lazy(() => B).optional(), n: z.number() });
      const B: z.ZodType = z.object({ a: A.optional() });
      return A;
    },
    inputs: () => {
      const a: Record<string, unknown> = { n: 1 };
      a["b"] = { a };
      const bad: Record<string, unknown> = { n: "x" };
      bad["b"] = { a: bad };
      return [a, bad];
    },
  },
  "a record of nodes": {
    make: () => {
      const Node = z.object({
        get links() {
          return z.record(z.string(), Node);
        },
      });
      return Node;
    },
    inputs: () => {
      const self: Record<string, unknown> = {};
      self["links"] = { self };
      const bad: Record<string, unknown> = {};
      bad["links"] = { self: bad, other: 1 };
      return [self, bad];
    },
  },
  "a node with a refine": {
    make: () => {
      const Node = z
        .object({
          value: z.number(),
          get next() {
            return Node.optional();
          },
        })
        .refine((node) => node.value >= 0, "negative");
      return Node;
    },
    inputs: () => {
      const self: Record<string, unknown> = { value: 1 };
      self["next"] = self;
      const negative: Record<string, unknown> = { value: -1 };
      negative["next"] = negative;
      return [self, negative];
    },
  },
};

type Compiled = {
  safeParse: (x: unknown) => { success: boolean; data?: unknown; error?: unknown };
  parse: (x: unknown) => unknown;
  is: (x: unknown) => boolean;
  safeParseAsync: (x: unknown) => Promise<{ success: boolean; data?: unknown; error?: unknown }>;
  parseAsync: (x: unknown) => Promise<unknown>;
  "~standard": { validate: (x: unknown) => unknown };
};

async function expectZodsAnswers(reference: z.ZodType, compiled: Compiled, input: unknown) {
  const zod = outcomeOf(reference.safeParse(input));
  expect(attempt(() => outcomeOf(compiled.safeParse(input)))).toEqual(zod);
  expect(attempt(() => ({ kind: "data", text: render(compiled.parse(input)) }))).toEqual(
    zod.kind === "data" ? zod : { kind: "throws", text: "ZodError" },
  );
  expect(attempt(() => ({ kind: "data", text: String(compiled.is(input)) }))).toEqual({
    kind: "data",
    text: String(zod.kind === "data"),
  });
  expect(await settle(async () => outcomeOf(await compiled.safeParseAsync(input)))).toEqual(zod);
  expect(
    await settle(async () => ({ kind: "data", text: render(await compiled.parseAsync(input)) })),
  ).toEqual(zod.kind === "data" ? zod : { kind: "throws", text: "ZodError" });
  // Zod's own validate answers this synchronously, so the compiled one has to.
  const validated = compiled["~standard"].validate(input);
  expect(validated).not.toBeInstanceOf(Promise);
  const { value, issues } = validated as { value?: unknown; issues?: unknown };
  expect(issues === undefined ? render(value) : "issues").toBe(
    zod.kind === "data" ? zod.text : "issues",
  );
}

describe("an input with a reference cycle gets zod's answer", () => {
  const modes: { name: string; mode: CodegenMode; compact?: boolean }[] = [
    { name: "inline", mode: "inline" },
    { name: "lean", mode: "lean" },
    { name: "compact", mode: "inline", compact: true },
  ];
  for (const { name, mode, compact } of modes) {
    describe(name, () => {
      for (const [shape, { make, inputs }] of Object.entries(SHAPES)) {
        it(shape, async () => {
          const reference = make();
          const compiled = installOnto(make(), { mode, compact }) as unknown as Compiled;
          for (const input of inputs()) await expectZodsAnswers(reference, compiled, input);
        });
      }
    });
  }

  it("keeps the cycle zod's output has", () => {
    const { make } = SHAPES["a getter object"] as Shape;
    const compiled = installOnto(make()) as unknown as Compiled;
    const self: Record<string, unknown> = { value: 1, extra: "stripped" };
    self["next"] = self;
    const result = compiled.safeParse(self) as { success: true; data: Record<string, unknown> };
    expect(result.success).toBe(true);
    expect(result.data["next"]).toBe(result.data);
    expect(result.data).not.toBe(self);
    expect(Object.keys(result.data)).toEqual(["value", "next"]);
  });

  it("in a method bag", () => {
    const { make, inputs } = SHAPES["a lazy tree"] as Shape;
    const reference = make();
    const [bag] = installLikeProduction([make()], { zodCompat: false }) as Compiled[];
    for (const input of inputs()) {
      expect(outcomeOf((bag as Compiled).safeParse(input))).toEqual(
        outcomeOf(reference.safeParse(input)),
      );
    }
  });

  it("for zod/mini, through core's safeParse", () => {
    const make = () => {
      const Node = zm.object({
        value: zm.number(),
        get next() {
          return zm.optional(Node);
        },
      });
      return Node;
    };
    const compiled = installOnto(make()) as unknown as Compiled;
    const self: Record<string, unknown> = { value: 1 };
    self["next"] = self;
    const bad: Record<string, unknown> = { value: "x" };
    bad["next"] = bad;
    for (const input of [self, bad]) {
      expect(outcomeOf(compiled.safeParse(input))).toEqual(outcomeOf(zm.safeParse(make(), input)));
    }
  });

  it("throws zod's error where the cycle closes through a transform", () => {
    const make = () => {
      const Node = z
        .object({
          value: z.number(),
          get next() {
            return Node.optional();
          },
        })
        .transform((node) => node);
      return Node;
    };
    const self: Record<string, unknown> = { value: 1 };
    self["next"] = self;
    const zod = attempt(() => outcomeOf(make().safeParse(self)));
    expect(zod.kind).toBe("throws");
    const compiled = installOnto(make()) as unknown as Compiled;
    expect(attempt(() => outcomeOf(compiled.safeParse(self)))).toEqual(zod);
  });
});

describe("what the guard leaves alone", () => {
  it("a chain deeper than the stack still overflows, as it does in zod", () => {
    const { make } = SHAPES["a getter object"] as Shape;
    let deep: Record<string, unknown> = { value: 0 };
    for (let i = 0; i < 200_000; i++) deep = { value: i, next: deep };
    expect(attempt(() => outcomeOf(make().safeParse(deep)))).toEqual({
      kind: "throws",
      text: "RangeError",
    });
    const compiled = installOnto(make()) as unknown as Compiled;
    expect(attempt(() => outcomeOf(compiled.safeParse(deep)))).toEqual({
      kind: "throws",
      text: "RangeError",
    });
  });

  it("a RangeError of a callback's own is the caller's, not a reason to ask zod", () => {
    let calls = 0;
    const make = () => {
      const Node = z.object({
        value: z.number().refine(() => {
          calls++;
          throw new RangeError("out of range");
        }),
        get next() {
          return Node.optional();
        },
      });
      return Node;
    };
    const compiled = installOnto(make()) as unknown as Compiled;
    expect(() => compiled.safeParse({ value: 1 })).toThrow("out of range");
    expect(calls).toBe(1);
  });

  it("a schema that does not recurse gets no guard", () => {
    const code = (schema: z.ZodType) => {
      const [info] = compileSchemas([{ exportName: "S", schema }], { mode: "lean" }).schemas;
      return generateIIFE("S", info as never);
    };
    expect(code(z.object({ a: z.array(z.string()) }))).not.toContain("__zcOvf");
    const { make } = SHAPES["a getter object"] as Shape;
    expect(code(make())).toContain("__zcOvf");
  });
});
