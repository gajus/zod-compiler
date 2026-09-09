import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import { generateValidator } from "#src/core/codegen/index.js";
import { extractSchema } from "#src/core/extract/index.js";
import { expectLeanParity, expectParity } from "../../parity-harness.js";

const containers = [
  {
    name: "record",
    schema: (node: z.ZodType) => z.record(z.string(), node),
    input: (node: unknown) => ({ k: node }),
  },
  {
    name: "array",
    schema: (node: z.ZodType) => z.array(node),
    input: (node: unknown) => [node],
  },
  {
    name: "direct property",
    schema: (node: z.ZodType) => node,
    input: (node: unknown) => node,
  },
];

/** Check every name, including references left in unused preamble helpers. */
function expectDeclaredFastTargets(schema: z.ZodType): void {
  const generated = generateValidator(extractSchema(schema, []), "recursiveBuild");
  const code = `${generated.code}\n${generated.functionDef}`;
  const declarations = new Set(
    [...code.matchAll(/function (__fcr_\d+)\(/g)].map((match) => match[1]),
  );
  for (const [name] of code.matchAll(/__fcr_\d+\b/g)) {
    expect(declarations.has(name), `${name} must be declared in this validator`).toBe(true);
  }
}

describe("build path — recursive passthrough after fast-path rollback (#20)", () => {
  for (const container of containers) {
    for (const transformFirst of [true, false]) {
      it(`${container.name}, transform ${transformFirst ? "first" : "last"}`, () => {
        const Node: z.ZodType = z.lazy(() => z.strictObject({ next: Node.nullable() }));
        const t = z.string().transform((s) => s.trim());
        const r = container.schema(Node);
        const Wrapper = z.strictObject(transformFirst ? { t, r } : { r, t });
        const samples = [
          ...[
            { next: null },
            { next: { next: { next: null } } },
            { next: { next: 42 } },
            { next: {} },
            { next: { next: null, extra: true } },
            null,
          ].map((node) => ({ t: " a ", r: container.input(node) })),
          { t: 42, r: container.input({ next: null }) },
          {},
        ];

        expectParity(Wrapper, samples);
        expectLeanParity(Wrapper, samples);
        expectParity(Wrapper, samples, "compactRecursiveBuild", undefined, { compact: true });
        expectDeclaredFastTargets(Wrapper);
      });
    }

    it(`${container.name} keeps its build and fast checks when the fast pass succeeds`, () => {
      const Node: z.ZodType = z.lazy(() => z.strictObject({ next: Node.nullable() }));
      const Wrapper = z.strictObject({
        t: z.string().default("default"),
        r: container.schema(Node),
      });
      const generated = generateValidator(extractSchema(Wrapper, []), "eligibleRecursiveBuild");
      expect(generated.isFnName).toEqual(expect.any(String));
      expectDeclaredFastTargets(Wrapper);
      const samples = [
        { r: container.input({ next: { next: null } }) },
        { r: container.input({ next: { next: 42 } }) },
      ];
      expectParity(Wrapper, samples);
      expectLeanParity(Wrapper, samples);
    });
  }

  it("handles multiple targets when a target body aborts the fast hosting pass", () => {
    const Node: z.ZodType = z.lazy(() => z.strictObject({ next: Node.nullable() }));
    const Rewritten: z.ZodType = z.lazy(() =>
      z.strictObject({
        next: Rewritten.nullable(),
        t: z.string().transform((s) => s.trim()),
      }),
    );
    const Wrapper = z.strictObject({ nodes: z.array(Node), rewritten: Rewritten });
    const samples = [
      { nodes: [{ next: null }], rewritten: { next: null, t: " a " } },
      {
        nodes: [{ next: { next: null } }],
        rewritten: { next: { next: null, t: " b " }, t: " a " },
      },
      { nodes: [{ next: 42 }], rewritten: { next: null, t: " a " } },
      { nodes: [{ next: null }], rewritten: { next: { next: null, t: 42 }, t: " a " } },
    ];
    expectParity(Wrapper, samples);
    expectLeanParity(Wrapper, samples);
    expectDeclaredFastTargets(Wrapper);
  });

  it("handles mutually recursive passthrough targets after rollback", () => {
    const A: z.ZodType = z.lazy(() => z.strictObject({ b: B.nullable() }));
    const B: z.ZodType = z.lazy(() => z.strictObject({ a: A.nullable() }));
    const Wrapper = z.strictObject({
      t: z.string().transform((s) => s.trim()),
      r: z.record(z.string(), A),
    });
    const samples = [
      { t: " a ", r: { k: { b: null } } },
      { t: " a ", r: { k: { b: { a: { b: null } } } } },
      { t: " a ", r: { k: { b: { a: { b: 42 } } } } },
    ];
    expectParity(Wrapper, samples);
    expectLeanParity(Wrapper, samples);
    expectDeclaredFastTargets(Wrapper);
  });
});
