import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import { jit } from "#src/jit.js";

/**
 * `$ZodCheckNumberFormat` reports an integer format in a fixed ORDER: a
 * non-integer is an aborting `invalid_type`; an integer outside the SAFE range
 * is reported against the safe bounds (origin "int", zod's note) whatever the
 * format's own range is, and the check returns there; only a safe integer is
 * measured against the format range (origin "number"). The compiled slow path
 * once skipped the middle rung for int32/uint32, so `z.int32()` on 1e21 reported
 * `maximum: 2147483647` with origin "number" where zod reports 2^53-1 with
 * origin "int" and the note.
 *
 * Every case is compared by verdict, by the full issue list and by
 * `error.message` — the JSON of the issues, so key order is part of it.
 */
const formats: Record<string, () => z.ZodType> = {
  "z.float32()": () => z.float32(),
  "z.float64()": () => z.float64(),
  "z.int()": () => z.int(),
  "z.int32()": () => z.int32(),
  "z.int32({ error })": () => z.int32({ error: "not an int32" }),
  "z.int32().max(10)": () => z.int32().max(10),
  "z.int32().min(5)": () => z.int32().min(5),
  "z.int32().multipleOf(2)": () => z.int32().multipleOf(2),
  "z.number().int()": () => z.number().int(),
  "z.object({ n: z.int32() })": () => z.object({ n: z.int32() }),
  "z.object({ n: z.uint32() }).strict()": () => z.strictObject({ n: z.uint32() }),
  "z.uint32()": () => z.uint32(),
  "z.union([z.int32(), z.string()])": () => z.union([z.int32(), z.string()]),
  "z.union([z.uint32(), z.boolean()])": () => z.union([z.uint32(), z.boolean()]),
};

const values: number[] = [
  1e21,
  -1e21,
  2 ** 53,
  -(2 ** 53),
  2 ** 53 - 1,
  -(2 ** 53 - 1),
  2 ** 40,
  -(2 ** 40),
  2 ** 31,
  2 ** 31 - 1,
  -(2 ** 31),
  -(2 ** 31) - 1,
  2 ** 32 - 1,
  2 ** 32,
  1.5,
  -0.5,
  Number.NaN,
  Number.POSITIVE_INFINITY,
  7,
  0,
  -1,
];

const wrap = (name: string, value: number): unknown =>
  name.startsWith("z.object") ? { n: value } : value;

const outcome = (result: z.ZodSafeParseResult<unknown>) =>
  result.success
    ? { data: result.data, success: true }
    : { issues: result.error.issues, message: result.error.message, success: false };

describe("number formats outside the safe-integer range", () => {
  for (const [name, make] of Object.entries(formats)) {
    it(`${name} matches zod on every probe value`, () => {
      const plain = make();
      const compiled = jit(make(), { eager: true });
      for (const value of values) {
        const input = wrap(name, value);
        expect(outcome(compiled.safeParse(input)), `${name} on ${String(value)}`).toStrictEqual(
          outcome(plain.safeParse(input)),
        );
        expect(compiled.is(input), `${name}.is() on ${String(value)}`).toBe(
          plain.safeParse(input).success,
        );
      }
    });
  }

  it("reports the safe range, not the format range, for z.int32() on 1e21", () => {
    const result = jit(z.int32(), { eager: true }).safeParse(1e21);
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues).toStrictEqual([
      {
        code: "too_big",
        inclusive: true,
        maximum: Number.MAX_SAFE_INTEGER,
        message: "Too big: expected int to be <=9007199254740991",
        note: "Integers must be within the safe integer range.",
        origin: "int",
        path: [],
      },
    ]);
    // The JSON rendering pins the key order zod pushes with.
    expect(Object.keys(result.error.issues[0] as object)).toStrictEqual([
      "code",
      "maximum",
      "note",
      "origin",
      "inclusive",
      "path",
      "message",
    ]);
  });

  it("keeps running later checks after the safe-range issue, as zod does", () => {
    const schema = z.int32().max(10);
    const compiled = jit(z.int32().max(10), { eager: true });
    const plain = schema.safeParse(1e21);
    const ours = compiled.safeParse(1e21);
    expect(ours.success).toBe(false);
    expect(plain.success).toBe(false);
    if (ours.success || plain.success) return;
    expect(ours.error.issues.map((issue) => issue.code)).toStrictEqual(["too_big", "too_big"]);
    expect(ours.error.message).toBe(plain.error.message);
  });
});
