import { describe, expect, it } from "vitest";
import { mayExportSchemas } from "#src/static-filter.js";

const TS = "/project/src/file.ts";

describe("mayExportSchemas()", () => {
  describe("skips files whose exports provably cannot be schemas", () => {
    it("function declarations", async () => {
      const code = `import { z } from "zod";\nexport function parseUser(input: unknown) { return z.string().parse(input); }`;
      expect(await mayExportSchemas(code, TS)).toBe(false);
    });

    it("class declarations", async () => {
      const code = `export class UserService {}\nexport default class Repo {}`;
      expect(await mayExportSchemas(code, TS)).toBe(false);
    });

    it("annotated arrow functions", async () => {
      const code = `import { z } from "zod";\nexport const fmt = (a: string): string => a.trim();\nexport const check = async (v: unknown): Promise<boolean> => z.string().safeParse(v).success;`;
      expect(await mayExportSchemas(code, TS)).toBe(false);
    });

    it("literal and template constants", async () => {
      const code = `export const MAX = 5;\nexport const NAME = "user";\nexport const FLAG = true;\nexport const TPL = \`v\${1}\`;`;
      expect(await mayExportSchemas(code, TS)).toBe(false);
    });

    it("named object and array constants", async () => {
      const code = `export const config = { retries: 3 };\nexport const order = ["a", "b"];`;
      expect(await mayExportSchemas(code, TS)).toBe(false);
    });

    it("conditional of safe branches", async () => {
      const code = `declare const isDev: boolean;\nexport const env = isDev ? "dev" : "prod";`;
      expect(await mayExportSchemas(code, TS)).toBe(false);
    });

    it("type-only modules", async () => {
      const code = `import type { z } from "zod";\nexport type User = z.infer<never>;\nexport interface Props { name: string }`;
      expect(await mayExportSchemas(code, TS)).toBe(false);
    });

    it("files without exports", async () => {
      const code = `import "./side-effect";\nconst internal = 1;\nconsole.log(internal);`;
      expect(await mayExportSchemas(code, TS)).toBe(false);
    });

    it("default-exported functions and literals", async () => {
      expect(await mayExportSchemas(`export default function main() {}`, TS)).toBe(false);
      expect(await mayExportSchemas(`export default 42;`, TS)).toBe(false);
      expect(await mayExportSchemas(`export default () => 1;`, TS)).toBe(false);
    });

    it("export lists of safe locals", async () => {
      const code = `const fmt = (a: string) => a;\nfunction helper() {}\nexport { fmt, helper };`;
      expect(await mayExportSchemas(code, TS)).toBe(false);
    });

    it("tsx components", async () => {
      const code = `import { z } from "zod";\nconst S = z.object({ q: z.string() });\nexport const App = ({ q }: { q: string }) => <div>{S.parse({ q }).q}</div>;\nexport function Page() { return <App q="x" />; }`;
      expect(await mayExportSchemas(code, "/project/src/App.tsx")).toBe(false);
    });
  });

  describe("keeps schema-shaped exports as candidates", () => {
    it("z.object() exports", async () => {
      const code = `import { z } from "zod";\nexport const UserSchema = z.object({ name: z.string() });`;
      expect(await mayExportSchemas(code, TS)).toBe(true);
    });

    it("compile() exports", async () => {
      const code = `import { compile } from "zod-compiler";\nimport { UserSchema } from "./schemas";\nexport const validateUser = compile(UserSchema);`;
      expect(await mayExportSchemas(code, TS)).toBe(true);
    });

    it("generic call expressions", async () => {
      const code = `import { z } from "zod";\nexport const s = z.custom<{ a: 1 }>(() => true);`;
      expect(await mayExportSchemas(code, TS)).toBe(true);
    });

    it("re-exports from another module", async () => {
      const code = `export { UserSchema } from "./schemas";`;
      expect(await mayExportSchemas(code, TS)).toBe(true);
    });

    it("star re-exports", async () => {
      const code = `export * from "./schemas";`;
      expect(await mayExportSchemas(code, TS)).toBe(true);
    });

    it("export lists with call-initialized locals", async () => {
      const code = `import { makeSchema } from "./factory";\nconst s = makeSchema();\nexport { s };`;
      expect(await mayExportSchemas(code, TS)).toBe(true);
    });

    it("identifier exports of schema-ish locals", async () => {
      const code = `import { z } from "zod";\nconst Base = z.object({});\nexport const User = Base;`;
      expect(await mayExportSchemas(code, TS)).toBe(true);
    });

    it("member expression exports", async () => {
      const code = `import * as schemas from "./schemas";\nexport const User = schemas.User;`;
      expect(await mayExportSchemas(code, TS)).toBe(true);
    });

    it("default-exported objects (discovery unwraps them)", async () => {
      const code = `import { z } from "zod";\nconst S = z.string();\nexport default { S };`;
      expect(await mayExportSchemas(code, TS)).toBe(true);
    });

    it("default-exported arrays", async () => {
      const code = `import { z } from "zod";\nexport default [z.string()];`;
      expect(await mayExportSchemas(code, TS)).toBe(true);
    });

    it("live let bindings assigned later", async () => {
      const code = `import { z } from "zod";\nexport let lazySchema;\nlazySchema = z.string();`;
      expect(await mayExportSchemas(code, TS)).toBe(true);
    });

    it("top-level await initializers", async () => {
      const code = `export const S = await import("./schemas").then((m) => m.S);`;
      expect(await mayExportSchemas(code, TS)).toBe(true);
    });

    it("new expressions", async () => {
      const code = `import { Builder } from "./b";\nexport const v = new Builder();`;
      expect(await mayExportSchemas(code, TS)).toBe(true);
    });

    it("enum value exports (transpile to IIFE assignments)", async () => {
      const code = `export enum Status { Active = 1 }`;
      expect(await mayExportSchemas(code, TS)).toBe(true);
    });

    it("hand-written CommonJS module.exports objects", async () => {
      const code = `const { z } = require("zod");\nmodule.exports = { User: z.object({}) };`;
      expect(await mayExportSchemas(code, "/project/src/file.cjs")).toBe(true);
    });

    it("hand-written CommonJS named exports", async () => {
      const code = `const { z } = require("zod");\nexports.User = z.object({});`;
      expect(await mayExportSchemas(code, "/project/src/file.cjs")).toBe(true);
    });

    it("unparseable sources stay candidates", async () => {
      const code = `export const = ;;;~`;
      expect(await mayExportSchemas(code, TS)).toBe(true);
    });

    it("mixed files keep the schema candidate despite safe siblings", async () => {
      const code = [
        `import { z } from "zod";`,
        `export function helper() { return 1; }`,
        `export const LIMIT = 10;`,
        `export const ItemSchema = z.object({ id: z.number() });`,
      ].join("\n");
      expect(await mayExportSchemas(code, TS)).toBe(true);
    });
  });
});
