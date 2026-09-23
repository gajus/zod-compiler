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

/** Every hosted build and recursive fast check the code names — used or not — is declared. */
function expectDeclaredHelpers(schema: z.ZodType): void {
  const generated = generateValidator(extractSchema(schema, []), "selfRecursiveRoot");
  const code = `${generated.code}\n${generated.functionDef}`;
  const declarations = new Set(
    [...code.matchAll(/function (__(?:fcr|vbr?)_\d+)\(/g)].map((match) => match[1]),
  );
  for (const [name] of code.matchAll(/__(?:fcr|vbr?)_\d+\b/g)) {
    expect(declarations.has(name), `${name} must be declared in this validator`).toBe(true);
  }
}

describe("build path — self-recursive roots", () => {
  const Tree: z.ZodType = z.object({
    value: z.string().min(1),
    children: z.array(z.lazy(() => Tree)),
  });
  const GetterTree = z.object({
    value: z.string().min(1),
    get children() {
      return z.array(GetterTree);
    },
  });
  const Json: z.ZodType = z.lazy(() =>
    z.union([
      z.string(),
      z.number(),
      z.boolean(),
      z.null(),
      z.array(Json),
      z.record(z.string(), Json),
    ]),
  );
  const tree = (depth: number): unknown =>
    depth === 0
      ? { value: "leaf", children: [], extra: true }
      : { value: `d${depth}`, children: [tree(depth - 1), tree(depth - 1)], extra: true };
  const trees = [
    tree(3),
    { value: "root", children: [{ value: "", children: [] }] },
    { value: "root", children: [{ value: "a", children: [{ value: "b", children: "none" }] }] },
    { value: "root", children: [null] },
    { value: 1, children: [] },
    "nope",
  ];

  // The root is its own recursion target, so the back-edge calls the root's
  // build; these used to decline the pass and run the eager walk on every parse.
  it.each<[string, z.ZodType, unknown[]]>([
    ["a z.lazy() tree", Tree, trees],
    ["a tree written with the getter idiom", GetterTree, trees],
    [
      "a JSON value",
      Json,
      [
        { a: 1, b: [1, "x", null, { c: true }] },
        JSON.parse('{"__proto__": {"x": 1}, "y": [1, {"__proto__": 2}]}'),
        { a: [1, { b: undefined }] },
        { a: { b: { c: Number.NaN } } },
        [1, [2, [3]]],
        "str",
        undefined,
      ],
    ],
  ])("builds %s in one pass and hands `.is()` its predicate", (_label, schema, samples) => {
    const generated = generateValidator(extractSchema(schema, []), "selfRecursiveRoot");
    expect(generated.functionDef).toMatch(/=__vb_\d+\(input\)/);
    expect(generated.isFnName).toEqual(expect.any(String));
    expectDeclaredHelpers(schema);
    expectParity(schema, samples);
    expectLeanParity(schema, samples);
    expectParity(schema, samples, "compactSelfRecursiveRoot", undefined, { compact: true });
  });
});
