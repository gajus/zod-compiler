import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import { generateValidator } from "#src/core/codegen/index.js";
import type { RefEntry } from "#src/core/extract/index.js";
import { extractSchema } from "#src/core/extract/index.js";
import { expectParity } from "../../parity-harness.js";

/**
 * The build path dispatches a plain `z.union` of tagged objects on its
 * discriminator instead of probing the options in order — the same detection
 * the fast path applies, with the same soundness argument: disjoint required
 * literals mean at most one option can accept an input, so "first option to
 * succeed" and "the option the tag selects" are the same option, and an
 * unlisted tag is rejected by every option and by the switch alike.
 *
 * Pinned here because the dispatch is a silent-slowdown regression if it
 * stops firing, and a parity bug if it fires where the argument does not hold.
 */
function buildSource(schema: unknown): string {
  const refEntries: RefEntry[] = [];
  const ir = extractSchema(schema, refEntries);
  const result = generateValidator(ir, "u", { refCount: refEntries.length });
  expect(result.functionDef, "schema should take the build path").toMatch(/=__vb_\d+\(input\)/);
  return result.code;
}

const click = z.object({ type: z.literal("click"), x: z.number().int() });
const scroll = z.object({ type: z.literal("scroll"), delta: z.number() });
const key = z.object({ type: z.literal("keypress"), key: z.string().min(1) });

describe("build path: plain tagged unions dispatch on their discriminator", () => {
  it("switches over the tag's literal labels instead of probing the options", () => {
    const source = buildSource(z.union([click, scroll, key]));
    expect(source).toContain('switch(input["type"]){case "click":__bd_');
    expect(source).toContain('case "keypress":__bd_');
    expect(source).not.toMatch(/if\(__bu_\d+===/);
  });

  it("does so from two options up", () => {
    const source = buildSource(z.union([click, scroll]));
    expect(source).toContain('switch(input["type"]){case "click":');
    expect(source).not.toMatch(/if\(__bu_\d+===/);
  });

  it("z.discriminatedUnion takes the same switch", () => {
    const source = buildSource(z.discriminatedUnion("type", [click, scroll, key]));
    expect(source).toContain('switch(input["type"]){case "click":__bd_');
  });

  it("keeps probing when the tags are not disjoint required literals", () => {
    // A shared value: both options accept `{type:"a"}`, and zod picks the first.
    const shared = buildSource(
      z.union([
        z.object({ type: z.literal("a"), n: z.number() }),
        z.object({ type: z.literal(["a", "b"]), s: z.string() }),
      ]),
    );
    expect(shared).toMatch(/if\(__bu_\d+===/);
    // An optional tag: the option accepts an input WITHOUT it, which no switch
    // case could select.
    const optional = buildSource(
      z.union([
        z.object({ type: z.literal("a").optional(), n: z.number() }),
        z.object({ type: z.literal("b"), s: z.string() }),
      ]),
    );
    expect(optional).toMatch(/if\(__bu_\d+===/);
    // A defaulted tag: `propValues` say "a", the parse also accepts its absence.
    const defaulted = buildSource(
      z.union([
        z.object({ type: z.literal("a").default("a"), n: z.number() }),
        z.object({ type: z.literal("b"), s: z.string() }),
      ]),
    );
    expect(defaulted).toMatch(/if\(__bu_\d+===/);
  });

  it("agrees with zod on every dispatch outcome", () => {
    const inputs = [
      { type: "click", x: 1 },
      { type: "scroll", delta: 2.5 },
      { type: "keypress", key: "k" },
      // The matched option still validates its own fields.
      { type: "click", x: 1.5 },
      { type: "keypress", key: "" },
      // Unlisted, missing, wrong-typed and prototype-shaped tags.
      { type: "resize" },
      { type: "" },
      {},
      { type: 1 },
      { type: null },
      { type: undefined, x: 1 },
      { type: ["click"], x: 1 },
      { type: "__proto__" },
      { type: "constructor" },
      { type: "toString" },
      // Non-objects reach `default` (or the guard) without reading the tag.
      null,
      undefined,
      "click",
      [],
      ["click"],
      7,
      // Extra keys are stripped by the option zod selects, and only that one.
      { type: "click", x: 1, delta: 9, key: "z" },
    ];
    expectParity(z.union([click, scroll, key]), inputs, "tagged3");
    expectParity(z.union([click, scroll]), inputs, "tagged2");
    expectParity(z.discriminatedUnion("type", [click, scroll, key]), inputs, "disc3");
  });

  it("dispatches a numeric-string tag strictly (no key coercion)", () => {
    // `{type: 1}` must not reach the case for "1": zod's literal is strict.
    const schema = z.union([
      z.object({ type: z.literal("1"), a: z.number() }),
      z.object({ type: z.literal("2"), b: z.number() }),
      z.object({ type: z.literal("3"), c: z.number() }),
    ]);
    expect(buildSource(schema)).toContain('case "1":');
    expectParity(
      schema,
      [
        { type: "1", a: 1 },
        { type: 1, a: 1 },
        { type: "2", b: 1 },
        { type: 3, c: 1 },
        { type: "3", c: 1 },
      ],
      "numericTags",
    );
  });

  it("handles multi-value literals and mixed literal types", () => {
    const multi = z.union([
      z.object({ type: z.literal(["a", "b"]), n: z.number() }),
      z.object({ type: z.literal("c"), s: z.string() }),
    ]);
    expectParity(
      multi,
      [
        { type: "a", n: 1 },
        { type: "b", n: 1 },
        { type: "c", s: "x" },
        { type: "b", s: "x" },
        { type: "d" },
      ],
      "multiValue",
    );
    // A boolean/number/null tag mix switches on those literals directly.
    const mixed = z.union([
      z.object({ type: z.literal(true), n: z.number() }),
      z.object({ type: z.literal(0), s: z.string() }),
      z.object({ type: z.literal(null), b: z.boolean() }),
    ]);
    expect(buildSource(mixed)).toContain("case true:");
    expectParity(
      mixed,
      [
        { type: true, n: 1 },
        { type: 0, s: "x" },
        { type: null, b: false },
        { type: "true", n: 1 },
        { type: false, n: 1 },
        { type: "0", s: "x" },
        { type: undefined, b: true },
      ],
      "mixedTags",
    );
  });

  it("keeps the deferred issue walk's invalid_union shape", () => {
    // The slow walk is untouched: a miss still reports zod's `invalid_union`
    // with one error group per option, not a discriminated union's issue.
    const schema = z.union([click, scroll, key]);
    const refEntries: RefEntry[] = [];
    const ir = extractSchema(schema, refEntries);
    const result = generateValidator(ir, "u", { refCount: refEntries.length });
    expect(result.code).toContain('code:"invalid_union",errors:');
    expect(result.code).not.toContain("No matching discriminator");
  });
});
