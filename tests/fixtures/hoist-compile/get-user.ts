import { z } from "zod";

const fakePool = { one: (q: unknown) => q };
const fakeSql = {
  type:
    (s: unknown) =>
    (_q: TemplateStringsArray, ..._v: unknown[]) =>
      s,
};

export const getUser = (id: number) => {
  return fakePool.one(
    fakeSql.type(
      z.object({
        id: z.number(),
        name: z.string(),
      }),
    )`SELECT id, name FROM users WHERE id = ${id}`,
  );
};
