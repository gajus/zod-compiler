import { beforeAll, describe, expect, it } from "vite-plus/test";
import { init } from "es-module-lexer";
import { instrumentModule } from "#src/register/transform.js";

const REGISTER = 'globalThis[Symbol.for("zod-compiler:register")]';

beforeAll(async () => {
  await init;
});

describe("Node register source instrumentation", () => {
  it("registers named ESM exports through their local bindings", () => {
    const source = `
import { z } from "zod";
const LocalSchema = z.string();
export { LocalSchema as PublicSchema };
export const OtherSchema: z.ZodType = z.number();
`;
    const output = instrumentModule(source, "/app/schemas.ts", "module-typescript", {
      hoist: false,
    });

    expect(output).toContain(`try{${REGISTER}(LocalSchema)}catch{}`);
    expect(output).toContain(`try{${REGISTER}(OtherSchema)}catch{}`);
    expect(output).not.toContain("(PublicSchema)");
  });

  it("does not turn type-only exports into runtime references", () => {
    const source = `
import { z } from "zod";
type Shape = { value: string };
const UserSchema = z.object({ value: z.string() });
export { type Shape, UserSchema };
`;
    const output = instrumentModule(source, "/app/schemas.ts", "module-typescript", {
      hoist: false,
    });

    expect(output).toContain(`try{${REGISTER}(UserSchema)}catch{}`);
    expect(output).not.toContain("(Shape)");
    expect(output).not.toContain("(type)");
  });

  it("registers the final CommonJS exports object", () => {
    const source = `const { z } = require("zod"); module.exports.UserSchema = z.string();`;
    const output = instrumentModule(source, "/app/schemas.cjs", "commonjs", { hoist: false });

    expect(output).toContain(`try{${REGISTER}(module.exports, true)}catch{}`);
  });

  it("honors include and exclude filters", () => {
    const source = `import { z } from "zod"; export const Schema = z.string();`;
    expect(
      instrumentModule(source, "/app/schemas.ts", "module-typescript", {
        exclude: ["schemas.ts"],
      }),
    ).toBeNull();
    expect(
      instrumentModule(source, "/app/schemas.ts", "module-typescript", {
        include: ["other/**"],
      }),
    ).toBeNull();
  });

  it("registers schemas introduced by hoisting", () => {
    const source = `
import { z } from "zod";
export function validate(value) {
  return z.object({ value: z.string() }).safeParse(value);
}
`;
    const output = instrumentModule(source, "/app/schemas.mjs", "module", {});

    expect(output).toMatch(/const (_zh_[0-9a-f]{8}) = z\.object/);
    const name = output?.match(/const (_zh_[0-9a-f]{8}) =/)?.[1];
    expect(output).toContain(`try{${REGISTER}(${name})}catch{}`);
  });

  /**
   * es-module-lexer reports byte offsets into TypeScript it only half-parses, so
   * the "local name" it hands back is not always a binding — and sometimes not
   * even an identifier. Emitting a reserved word is a SyntaxError that no
   * try/catch can contain, so those are filtered; everything else is emitted
   * inside a per-call catch, because registration is an optimization and must
   * never be able to take the importing module down.
   */
  it.each([
    ["const enum reports `enum`", "export const enum Level { A }", "enum"],
    ["default class reports `extends`", "export default class extends Error {}", "extends"],
  ])("never emits a reserved word — %s", (_name, decl, word) => {
    const source = `import { z } from "zod";\n${decl}\nexport const S = z.string();\n`;
    const output = instrumentModule(source, "/app/s.ts", "module-typescript", { hoist: false });
    expect(output).not.toContain(`(${word})`);
    expect(output).toContain(`try{${REGISTER}(S)}catch{}`);
  });

  it("contains a failing registration instead of letting it escape", () => {
    // `export declare function` is erased by type stripping, so the appended
    // read throws ReferenceError; a circular re-export throws from its TDZ.
    const source = [
      'import { z } from "zod";',
      "export declare function ghost(a: number): string;",
      "export const Good = z.string();",
      "",
    ].join("\n");
    const output = instrumentModule(source, "/app/s.ts", "module-typescript", { hoist: false });
    // Both are emitted, both guarded, and one failing cannot skip the other.
    expect(output).toContain(`try{${REGISTER}(ghost)}catch{}`);
    expect(output).toContain(`try{${REGISTER}(Good)}catch{}`);
    expect(output).not.toMatch(/[^{]globalThis\[Symbol/);
  });

  it("adds nothing when no name survives filtering", () => {
    const source = 'import { z } from "zod";\nexport default class extends Error {}\n';
    const output = instrumentModule(source, "/app/s.mjs", "module", { hoist: false });
    expect(output).not.toContain("zod-compiler:register");
  });
});
