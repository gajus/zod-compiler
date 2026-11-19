import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { mayExportSchemas } from "#src/static-filter.js";
import { transformCode } from "#src/unplugin/transform.js";

// Record what the transform hands the static filter; the verdict stays the
// real one, so the rest of the pipeline runs exactly as it does in a build.
vi.mock("#src/static-filter.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("#src/static-filter.js")>();
  return {
    ...original,
    mayExportSchemas: vi.fn().mockImplementation(original.mayExportSchemas),
  };
});

const mockMayExportSchemas = vi.mocked(mayExportSchemas);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_ID = path.join(__dirname, "..", "fixtures", "hoist-compile", "get-user.ts");

const ZOD_IMPORT = `import { z } from "zod";`;

describe("transformCode() — what the static filter is shown", () => {
  beforeEach(() => {
    mockMayExportSchemas.mockClear();
  });

  it("classifies the file as written, not the compiled hoist it became", async () => {
    // A handler module: its only schema lives inside a function, so it hoists
    // and compiles, and its exports are functions the filter can rule out.
    const code = [
      ZOD_IMPORT,
      `export function handler(input: unknown) {`,
      `  return z.object({ id: z.number(), name: z.string() }).safeParse(input);`,
      `}`,
    ].join("\n");

    const result = await transformCode(code, FIXTURE_ID, { mode: "lean", autoDiscover: true });

    // The schema did compile, so the text the later stages work on is several
    // times the size of the source and full of generated code...
    expect(result).toContain("__zcMkv(");
    // ...while the filter saw none of it: the exports are the same in both, and
    // transpiling a validator only to reach the same verdict is pure cost.
    expect(mockMayExportSchemas).toHaveBeenCalledTimes(1);
    expect(mockMayExportSchemas).toHaveBeenCalledWith(code, FIXTURE_ID);
    await expect(mockMayExportSchemas.mock.results[0]?.value).resolves.toBe(false);
  });

  it("classifies a plainly hoisted file as written too", async () => {
    // `new Date()` keeps the schema from compiling, so it is only hoisted: the
    // staged text still differs from the source by the `_zh_*` declaration.
    const code = [
      ZOD_IMPORT,
      `export function getSchema() { return z.date().min(new Date()); }`,
    ].join("\n");

    const result = await transformCode(code, FIXTURE_ID, { mode: "lean", autoDiscover: true });

    expect(result).toMatch(/const _zh_[0-9a-f]{8} = /);
    expect(mockMayExportSchemas).toHaveBeenCalledWith(code, FIXTURE_ID);
  });

  it("still calls a file with an exported schema a candidate", async () => {
    // The verdict depends on the exports alone, and hoisting leaves those as
    // they were — so a schema export beside a compiled hoist keeps the file a
    // candidate for discovery.
    const code = [
      ZOD_IMPORT,
      `export const Row = z.object({ id: z.number() });`,
      `export function handler(input: unknown) {`,
      `  return z.object({ name: z.string() }).safeParse(input);`,
      `}`,
    ].join("\n");

    await transformCode(code, FIXTURE_ID, { mode: "lean", autoDiscover: true });

    expect(mockMayExportSchemas).toHaveBeenCalledWith(code, FIXTURE_ID);
    await expect(mockMayExportSchemas.mock.results[0]?.value).resolves.toBe(true);
  });
});
