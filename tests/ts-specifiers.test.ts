import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createJiti, type TransformOptions, type TransformResult } from "jiti";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { importSites, resolveTsSpecifiers, tsSibling } from "#src/ts-specifiers.js";

// Count the parses, leave them real: finding a transpile's imports takes one,
// and several tests below are about when it is — and is not — paid for.
const acornCalls = vi.hoisted(() => ({ parse: 0 }));
// What the loader's transform handed back to jiti. The rewrite is invisible in
// what a module evaluates to — that is the point of it — so the only place to
// see that the loader applies it is the text jiti was given to run.
const handedToJiti = vi.hoisted(() => ({ code: [] as string[] }));
vi.mock("#src/ts-specifiers.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("#src/ts-specifiers.js")>();
  return {
    ...original,
    resolveTsSpecifiers(...args: Parameters<typeof original.resolveTsSpecifiers>) {
      const code = original.resolveTsSpecifiers(...args);
      handedToJiti.code.push(code);
      return code;
    },
  };
});
vi.mock("acorn", async (importOriginal) => {
  const original = await importOriginal<typeof import("acorn")>();
  return {
    ...original,
    parse(...args: Parameters<typeof original.parse>) {
      acornCalls.parse++;
      return original.parse(...args);
    },
  };
});

/**
 * An untouched jiti: no transform of ours, no cache. Everything below is
 * measured against what THIS resolves, because the claim under test is that
 * the rewrite changes how fast an import resolves and never what it resolves
 * to.
 */
const reference = createJiti(import.meta.url, { fsCache: false, moduleCache: false });
const EXTENSIONS = reference.options.extensions as string[];
const babel = reference.options.transform as (options: TransformOptions) => TransformResult;

/** A module the way jiti hands it to our transform: through its own Babel. */
function transpile(source: string, filename = "/project/src/importer.ts"): string {
  return babel({ source, filename, ts: true, async: true, jsx: true, interopDefault: true }).code;
}

/** The specifiers at the sites `importSites` reports, quotes stripped. */
function sitesOf(code: string): string[] {
  const sites = importSites(code);
  const specifiers: string[] = [];
  for (let i = 0; i < sites.length; i += 2) {
    specifiers.push(code.slice((sites[i] as number) + 1, (sites[i + 1] as number) - 1));
  }
  return specifiers;
}

// Real paths throughout: jiti answers with them, and a macOS temp directory
// sits behind a symlink.
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "zc-specifiers-")));
let count = 0;

type Entry = string | { linkTo: string };

/**
 * A directory holding `files`, each exporting its own name as `which` so a
 * load says which one it reached. A trailing slash makes a directory.
 */
function layout(files: Record<string, Entry> | string[]): string {
  const dir = path.join(root, `case-${count++}`);
  fs.mkdirSync(dir, { recursive: true });
  const entries = Array.isArray(files)
    ? files.map((name) => [name, name] as const)
    : Object.entries(files);
  for (const [name, entry] of entries) {
    const file = path.join(dir, name);
    if (name.endsWith("/")) {
      fs.mkdirSync(file, { recursive: true });
      continue;
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (typeof entry !== "string") {
      fs.symlinkSync(path.join(dir, entry.linkTo), file);
    } else if (name.endsWith(".json")) {
      fs.writeFileSync(file, JSON.stringify({ which: entry }));
    } else if (/\.c[jt]s$/.test(name)) {
      fs.writeFileSync(file, `exports.which = ${JSON.stringify(entry)};\n`);
    } else {
      fs.writeFileSync(file, `export const which = ${JSON.stringify(entry)};\n`);
    }
  }
  return dir;
}

/** What an untouched jiti resolves `specifier` to from `dir`, as a path. */
function jitiResolves(dir: string, specifier: string): string | undefined {
  const importer = pathToFileURL(path.join(dir, "importer.ts")).href;
  const jiti = createJiti(importer, { fsCache: false, moduleCache: false });
  const resolved = jiti.esmResolve(specifier, { parentURL: importer, try: true });
  if (resolved === undefined) return undefined;
  return resolved.startsWith("file:") ? fileURLToPath(resolved) : resolved;
}

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("tsSibling() — the swap jiti's ladder ends on", () => {
  it("is the TypeScript file when that is all there is", () => {
    expect(tsSibling(layout(["x.ts"]), "./x.js", EXTENSIONS)).toBe("./x.ts");
    expect(tsSibling(layout(["x.mts"]), "./x.mjs", EXTENSIONS)).toBe("./x.mts");
    expect(tsSibling(layout(["x.cts"]), "./x.cjs", EXTENSIONS)).toBe("./x.cts");
    expect(tsSibling(layout(["x.tsx"]), "./x.jsx", EXTENSIONS)).toBe("./x.tsx");
  });

  it("keeps the directories and dots of the specifier as written", () => {
    expect(tsSibling(layout(["sub/x.ts"]), "./sub/x.js", EXTENSIONS)).toBe("./sub/x.ts");
    expect(tsSibling(layout(["x.config.ts"]), "./x.config.js", EXTENSIONS)).toBe("./x.config.ts");
    const parent = layout(["x.ts", "nested/"]);
    expect(tsSibling(path.join(parent, "nested"), "../x.js", EXTENSIONS)).toBe("../x.ts");
    expect(tsSibling(parent, "./nested/../x.js", EXTENSIONS)).toBe("./nested/../x.ts");
  });

  it("leaves a specifier whose JavaScript file really exists", () => {
    expect(tsSibling(layout(["x.js", "x.ts"]), "./x.js", EXTENSIONS)).toBeNull();
    expect(tsSibling(layout(["x.mjs", "x.mts"]), "./x.mjs", EXTENSIONS)).toBeNull();
    expect(tsSibling(layout(["x.cjs", "x.cts"]), "./x.cjs", EXTENSIONS)).toBeNull();
    expect(tsSibling(layout(["x.jsx", "x.tsx"]), "./x.jsx", EXTENSIONS)).toBeNull();
  });

  it("does not take .js to .tsx, which jiti does not resolve either", () => {
    // TypeScript would. But this changes how fast an import resolves, not
    // whether it does — a file jiti cannot load today stays one it cannot load.
    const dir = layout(["x.tsx"]);
    expect(jitiResolves(dir, "./x.js")).toBeUndefined();
    expect(tsSibling(dir, "./x.js", EXTENSIONS)).toBeNull();
    expect(tsSibling(layout(["x.ts"]), "./x.jsx", EXTENSIONS)).toBeNull();
  });

  it("leaves a specifier with nothing to swap to", () => {
    expect(tsSibling(layout([]), "./x.js", EXTENSIONS)).toBeNull();
    expect(tsSibling(layout(["x.d.ts"]), "./x.js", EXTENSIONS)).toBeNull();
    // A directory named like the sibling: jiti's swap goes on into it.
    expect(tsSibling(layout(["x.ts/index.js"]), "./x.js", EXTENSIONS)).toBeNull();
  });

  it("leaves a specifier an earlier rung of jiti's ladder would have answered", () => {
    // Each of these wins over x.ts in jiti: the path with an extension
    // appended, or a directory by that name with an index file.
    for (const earlier of [
      "x.js.js",
      "x.js.mjs",
      "x.js.cjs",
      "x.js.ts",
      "x.js.tsx",
      "x.js.mts",
      "x.js.cts",
      "x.js.json",
      "x.js/index.ts",
      "x.js/index.js",
    ]) {
      const dir = layout([earlier, "x.ts"]);
      expect(jitiResolves(dir, "./x.js"), earlier).toBe(path.join(dir, earlier));
      expect(tsSibling(dir, "./x.js", EXTENSIONS), earlier).toBeNull();
    }
  });

  it("leaves a specifier beside any name Node's own resolution would try first", () => {
    // jiti asks require.resolve before it swaps, and that appends Node's
    // extensions — to the path, and to the path with jiti's first extra one.
    for (const earlier of ["x.js.node", "x.js.mjs.js", "x.js.mjs.json", "x.js/"]) {
      expect(tsSibling(layout([earlier, "x.ts"]), "./x.js", EXTENSIONS), earlier).toBeNull();
    }
  });

  it("leaves everything that is not a plain relative path", () => {
    const dir = layout(["x.ts", "node_modules/pkg/x.ts", "a b.ts"]);
    for (const specifier of [
      "x.js",
      "@/x.js",
      "#lib/x.js",
      "pkg/x.js",
      path.join(dir, "x.js"),
      pathToFileURL(path.join(dir, "x.js")).href,
      // jiti hands a native module's specifier straight to Node.
      "./node_modules/pkg/x.js",
      // Where a URL and a path read the same text differently.
      "./x.js?raw",
      "./x.js#hash",
      "./a%20b.js",
      ".\\x.js",
      "./x\t.js",
      // Not a JS extension at all.
      "./x.ts",
      "./x.json",
      "./x",
    ]) {
      expect(tsSibling(dir, specifier, EXTENSIONS), specifier).toBeNull();
    }
    // A space is the same file either way.
    expect(tsSibling(dir, "./a b.js", EXTENSIONS)).toBe("./a b.ts");
  });
});

describe("tsSibling() — pinned against jiti itself", () => {
  /**
   * Every layout above and a few more, each resolved twice by an untouched
   * jiti: as written, and as we would have rewritten it. The two must name the
   * same file (or both fail). jiti reordering its ladder in some later release
   * fails here, in the suite, rather than in somebody's build.
   */
  const LAYOUTS: [name: string, specifier: string, files: Record<string, Entry> | string[]][] = [
    ["ts sibling", "./x.js", ["x.ts"]],
    ["mts sibling", "./x.mjs", ["x.mts"]],
    ["cts sibling", "./x.cjs", ["x.cts"]],
    ["tsx sibling of .jsx", "./x.jsx", ["x.tsx"]],
    ["real js", "./x.js", ["x.js", "x.ts"]],
    ["real mjs", "./x.mjs", ["x.mjs", "x.mts"]],
    ["real cjs", "./x.cjs", ["x.cjs", "x.cts"]],
    ["real jsx", "./x.jsx", ["x.jsx", "x.tsx"]],
    ["tsx only", "./x.js", ["x.tsx"]],
    ["ts and tsx", "./x.js", ["x.ts", "x.tsx"]],
    ["ts for .jsx", "./x.jsx", ["x.ts"]],
    ["nothing", "./x.js", []],
    ["declaration only", "./x.js", ["x.d.ts"]],
    ["x.js.ts", "./x.js", ["x.js.ts", "x.ts"]],
    ["x.js.json", "./x.js", ["x.js.json", "x.ts"]],
    ["x.js.mjs", "./x.js", ["x.js.mjs", "x.ts"]],
    ["x.js.cjs", "./x.js", ["x.js.cjs", "x.ts"]],
    ["x.js.node", "./x.js", ["x.js.node", "x.ts"]],
    ["x.js.mjs.js", "./x.js", ["x.js.mjs.js", "x.ts"]],
    ["x.js.mjs.json", "./x.js", ["x.js.mjs.json", "x.ts"]],
    ["directory x.js with index.ts", "./x.js", ["x.js/index.ts", "x.ts"]],
    ["directory x.js with index.js", "./x.js", ["x.js/index.js", "x.ts"]],
    ["empty directory x.js", "./x.js", ["x.js/", "x.ts"]],
    ["directory x.ts with index.js", "./x.js", ["x.ts/index.js"]],
    ["directory x.ts with index.ts", "./x.js", ["x.ts/index.ts"]],
    ["directory x.js.mjs with index.js", "./x.js", ["x.js.mjs/index.js", "x.ts"]],
    ["subdirectory", "./sub/x.js", ["sub/x.ts"]],
    ["dotted name", "./x.config.js", ["x.config.ts"]],
    ["dot segments", "./sub/../x.js", ["x.ts", "sub/"]],
    ["space in the name", "./a b.js", ["a b.ts"]],
    ["symlinked sibling", "./x.js", { "real/y.ts": "real/y.ts", "x.ts": { linkTo: "real/y.ts" } }],
    [
      "dangling symlink at the js name",
      "./x.js",
      { "x.ts": "x.ts", "x.js": { linkTo: "gone.js" } },
    ],
    ["query string", "./x.js?raw", ["x.ts"]],
    ["percent escape", "./a%20b.js", ["a b.ts"]],
    ["into node_modules", "./node_modules/pkg/x.js", ["node_modules/pkg/x.ts"]],
  ];

  it.each(LAYOUTS)("%s: %s resolves as it did", (_name, specifier, files) => {
    const dir = layout(files);
    const asWritten = jitiResolves(dir, specifier);
    const rewritten = tsSibling(dir, specifier, EXTENSIONS);
    expect(jitiResolves(dir, rewritten ?? specifier)).toBe(asWritten);
  });

  it("fires for the layouts it is there for", () => {
    // The other half of the pin. Harmless is not enough: a layout that drops
    // out of this list resolves correctly and 80 times slower, which nothing
    // else in the suite would notice.
    const fired: string[] = [];
    for (const [name, specifier, files] of LAYOUTS) {
      const dir = layout(files);
      if (tsSibling(dir, specifier, EXTENSIONS) !== null) fired.push(name);
    }
    expect(fired).toEqual([
      "ts sibling",
      "mts sibling",
      "cts sibling",
      "tsx sibling of .jsx",
      "ts and tsx",
      "subdirectory",
      "dotted name",
      "dot segments",
      "space in the name",
      "symlinked sibling",
      "dangling symlink at the js name",
    ]);
  });

  it("walks the ladder this was written against", () => {
    // The emulation reads jiti's extension list off the instance, and assumes
    // the first one past `.js` is where its fallback loop starts.
    expect(EXTENSIONS).toEqual([
      ".js",
      ".mjs",
      ".cjs",
      ".ts",
      ".tsx",
      ".mts",
      ".cts",
      ".mtsx",
      ".ctsx",
    ]);
  });
});

describe("importSites()", () => {
  it("finds every form of relative import Babel turns into a jitiImport call", () => {
    const code = transpile(
      [
        `import def, * as ns from "./default.js";`,
        `import { named } from "./named.js";`,
        `import "./side-effect.js";`,
        `export * from "./star.js";`,
        `export * as grouped from "./star-as.js";`,
        `export { a as b } from "./re-export.js";`,
        `const lazy = () => import("./dynamic.js");`,
        `import up from "../up.mjs";`,
        `import cjs from './single-quoted.cjs';`,
        `import view from "./view.jsx";`,
        `void def; void ns; void named; void lazy; void up; void cjs; void view;`,
      ].join("\n"),
    );

    expect(sitesOf(code).sort()).toEqual(
      [
        "./default.js",
        "./named.js",
        "./side-effect.js",
        "./star.js",
        "./star-as.js",
        "./re-export.js",
        "./dynamic.js",
        "../up.mjs",
        "./single-quoted.cjs",
        "./view.jsx",
      ].sort(),
    );
  });

  it("reports nothing for imports that are not relative JS-extension paths", () => {
    const code = transpile(
      [
        `import { z } from "zod";`,
        `import a from "@/alias.js";`,
        `import b from "#internal/b.js";`,
        `import c from "pkg/sub.js";`,
        `import d from "./typescript.ts";`,
        `import e from "./extensionless";`,
        `import f from "./data.json";`,
        `import g from "./query.js?raw";`,
        `void z; void a; void b; void c; void d; void e; void f; void g;`,
      ].join("\n"),
    );
    expect(sitesOf(code)).toEqual([]);
  });

  it("reports nothing for an import TypeScript erases", () => {
    const code = transpile(
      [
        `import type { T } from "./types.js";`,
        `export type { U } from "./more-types.js";`,
        `import { type V } from "./only-types.js";`,
        `export const x: T | V | null = null;`,
      ].join("\n"),
    );
    expect(sitesOf(code)).toEqual([]);
  });

  it("reports nothing for a dynamic import whose specifier is computed", () => {
    const code = transpile(
      [
        "export const a = (n: string) => import(`./page-${n}.js`);",
        `export const b = (n: string) => import("./page-" + n + ".js");`,
        `const name = "./fixed.js";`,
        `export const c = () => import(name);`,
      ].join("\n"),
    );
    expect(sitesOf(code)).toEqual([]);
  });

  it("does not mistake text for an import", () => {
    // Babel carries comments and string contents through untouched, so each
    // of these reaches us reading exactly like the call it describes.
    const code = transpile(
      [
        `// jitiImport("./comment.js")`,
        `/* await jitiImport("./block-comment.js") */`,
        `export const single = 'jitiImport("./string.js")';`,
        `export const double = "jitiImport('./string.js')";`,
        'export const template = `jitiImport("./template.js") ${1} jitiImport("./template-tail.js")`;',
        `export const pattern = /jitiImport\\("\\.\\/regex\\.js"\\)/;`,
        `export const documented = { import: 'import "./documented.js"' };`,
      ].join("\n"),
    );
    // The text is all still there...
    for (const name of ["comment", "block-comment", "string", "template", "template-tail"]) {
      expect(code).toContain(`./${name}.js`);
    }
    // ...and none of it is a site.
    expect(sitesOf(code)).toEqual([]);
  });

  it("only takes a call of the function jiti passes in", () => {
    const code = [
      `const loader = { jitiImport(id) { return id; } };`,
      `loader.jitiImport("./method.js");`,
      `loader?.jitiImport("./optional.js");`,
      `new jitiImport("./constructed.js");`,
      `myjitiImport("./prefixed.js");`,
      `jitiImport("./extra.js", {});`,
      `jitiImport("./escap\\u0065d.js");`,
      `await jitiImport("./real.js");`,
    ].join("\n");
    expect(sitesOf(code)).toEqual(["./real.js"]);
  });

  it("reports nothing for output it cannot parse", () => {
    expect(importSites(`await jitiImport("./x.js"); const = ;`)).toEqual([]);
  });

  it("does not parse at all when there is nothing to look for", () => {
    // Most modules import packages only; they must not pay for a parse.
    const before = acornCalls.parse;
    expect(importSites(transpile(`import { z } from "zod"; export const s = z.string();`))).toEqual(
      [],
    );
    expect(importSites(`exports.a = 1;`)).toEqual([]);
    expect(acornCalls.parse).toBe(before);

    importSites(transpile(`import a from "./x.js"; void a;`));
    expect(acornCalls.parse).toBe(before + 1);
  });
});

describe("resolveTsSpecifiers()", () => {
  it("spells each import as the sibling jiti would have reached", () => {
    const dir = layout(["only.ts", "both.js", "both.ts", "module.mts", "view.tsx"]);
    const code = transpile(
      [
        `import a from "./only.js";`,
        `import b from "./both.js";`,
        `import c from './module.mjs';`,
        `import d from "./view.jsx";`,
        `import e from "./missing.js";`,
        `void a; void b; void c; void d; void e;`,
      ].join("\n"),
      path.join(dir, "importer.ts"),
    );

    const out = resolveTsSpecifiers(
      code,
      importSites(code),
      path.join(dir, "importer.ts"),
      EXTENSIONS,
    );

    expect(out).toContain(`jitiImport("./only.ts")`);
    expect(out).toContain(`jitiImport("./both.js")`);
    expect(out).toContain(`jitiImport("./module.mts")`);
    expect(out).toContain(`jitiImport("./view.tsx")`);
    expect(out).toContain(`jitiImport("./missing.js")`);
    // Nothing else moved: undo the three swaps and it is Babel's output again.
    expect(
      out
        .replace("./only.ts", "./only.js")
        .replace("./module.mts", "./module.mjs")
        .replace("./view.tsx", "./view.jsx"),
    ).toBe(code);
  });

  it("hands back the very same string when nothing applies", () => {
    const dir = layout(["x.js"]);
    const code = transpile(`import a from "./x.js"; void a;`, path.join(dir, "importer.ts"));
    expect(
      resolveTsSpecifiers(code, importSites(code), path.join(dir, "importer.ts"), EXTENSIONS),
    ).toBe(code);
    expect(resolveTsSpecifiers(code, [], path.join(dir, "importer.ts"), EXTENSIONS)).toBe(code);
  });

  it("leaves text that only reads like an import, even beside a real sibling", () => {
    const dir = layout(["x.ts"]);
    const importer = path.join(dir, "importer.ts");
    const code = transpile(
      [
        `import real from "./x.js";`,
        `// see jitiImport("./x.js")`,
        `export const note = 'jitiImport("./x.js")';`,
        `void real;`,
      ].join("\n"),
      importer,
    );

    const out = resolveTsSpecifiers(code, importSites(code), importer, EXTENSIONS);

    expect(out).toContain(`await jitiImport("./x.ts")`);
    expect(out).toContain(`// see jitiImport("./x.js")`);
    expect(out).toContain(`'jitiImport("./x.js")'`);
  });

  it("steps aside under settings where jiti's two resolvers disagree on a file's name", () => {
    const dir = layout(["x.ts"]);
    const importer = path.join(dir, "importer.ts");
    const code = transpile(`import a from "./x.js"; void a;`, importer);
    const sites = importSites(code);
    expect(resolveTsSpecifiers(code, sites, importer, EXTENSIONS)).not.toBe(code);

    // The resolver jiti tries first always follows symlinks; Node's, which the
    // swap goes through, stops following them under this flag.
    vi.stubEnv("NODE_PRESERVE_SYMLINKS", "1");
    expect(resolveTsSpecifiers(code, sites, importer, EXTENSIONS)).toBe(code);
    vi.unstubAllEnvs();
    vi.stubEnv("NODE_OPTIONS", "--preserve-symlinks");
    expect(resolveTsSpecifiers(code, sites, importer, EXTENSIONS)).toBe(code);
    vi.unstubAllEnvs();
    // An alias map is applied to the specifier before either resolver sees it.
    vi.stubEnv("JITI_ALIAS", JSON.stringify({ "./x.js": "./elsewhere.js" }));
    expect(resolveTsSpecifiers(code, sites, importer, EXTENSIONS)).toBe(code);
  });
});

describe("the loader, resolving through the rewrite", () => {
  let cacheRoot: string;

  async function freshLoader(): Promise<{
    loadSourceFile: (file: string) => Promise<Record<string, unknown>>;
    invalidateModuleCache: () => void;
  }> {
    vi.resetModules();
    const cache = await import("#src/transpile-cache.js");
    cache.useTranspileCache(cacheRoot);
    return import("#src/loader.js");
  }

  /** An importer that says which file its import reached. */
  function importer(dir: string, specifier: string, name = "importer.ts"): string {
    const file = path.join(dir, name);
    fs.writeFileSync(
      file,
      `import * as m from ${JSON.stringify(specifier)};\nexport const which: unknown = (m as any).which ?? (m as any).default?.which;\n`,
    );
    return file;
  }

  beforeEach(() => {
    cacheRoot = path.join(root, `cache-${count++}`);
  });

  it("loads the same file an untouched jiti loads, layout by layout", async () => {
    const { loadSourceFile } = await freshLoader();
    for (const [specifier, files] of [
      ["./x.js", ["x.ts"]],
      ["./x.js", ["x.js", "x.ts"]],
      ["./x.mjs", ["x.mts"]],
      ["./x.cjs", ["x.cts"]],
      ["./x.jsx", ["x.tsx"]],
      ["./x.js", ["x.js.json", "x.ts"]],
      ["./x.js", ["x.js/index.ts", "x.ts"]],
      ["./sub/x.js", ["sub/x.ts"]],
    ] as [string, string[]][]) {
      const dir = layout(files);
      const file = importer(dir, specifier);
      const expected = (await createJiti(pathToFileURL(file).href, {
        fsCache: false,
        moduleCache: false,
      }).import(file)) as {
        which: unknown;
      };
      expect((await loadSourceFile(file))["which"], `${specifier} among ${files.join(", ")}`).toBe(
        expected.which,
      );
    }
  });

  it("hands jiti the sibling's name, so its ladder is never walked", async () => {
    const { loadSourceFile } = await freshLoader();
    const dir = layout(["x.ts"]);
    handedToJiti.code.length = 0;

    expect((await loadSourceFile(importer(dir, "./x.js")))["which"]).toBe("x.ts");

    // Same module either way; 1.9 ms sooner this way.
    expect(handedToJiti.code.some((code) => code.includes(`jitiImport("./x.ts")`))).toBe(true);
    expect(handedToJiti.code.some((code) => code.includes(`jitiImport("./x.js")`))).toBe(false);
  });

  it("leaves a tsconfig alias that ends in .js to jiti, which still finds its file", async () => {
    const { loadSourceFile } = await freshLoader();
    const dir = layout(["src/x.ts"]);
    fs.writeFileSync(
      path.join(dir, "tsconfig.json"),
      JSON.stringify({ compilerOptions: { paths: { "@/*": ["./src/*"] } } }),
    );
    handedToJiti.code.length = 0;

    // Which candidates an alias expands to is the paths matcher's business,
    // and each one walks the ladder separately; only a relative specifier has
    // a ladder short enough to reproduce exactly.
    expect((await loadSourceFile(importer(dir, "@/x.js")))["which"]).toBe("src/x.ts");
    expect(handedToJiti.code.join("\n")).not.toContain("x.ts");
  });

  it("fails the way jiti fails where there is nothing to import", async () => {
    const { loadSourceFile } = await freshLoader();
    const dir = layout(["x.tsx"]);
    await expect(loadSourceFile(importer(dir, "./x.js"))).rejects.toThrow(/Cannot find module/);
  });

  it("follows re-exports, side-effect imports and literal dynamic imports", async () => {
    const { loadSourceFile } = await freshLoader();
    const dir = layout(["leaf.ts"]);
    fs.writeFileSync(
      path.join(dir, "effect.ts"),
      `(globalThis as any).__zcSpecifierEffect = "ran";\n`,
    );
    fs.writeFileSync(
      path.join(dir, "barrel.ts"),
      `export * from "./leaf.js";\nexport { which as again } from "./leaf.js";\n`,
    );
    const file = path.join(dir, "importer.ts");
    fs.writeFileSync(
      file,
      [
        `import "./effect.js";`,
        `export * from "./barrel.js";`,
        `export const lazy = () => import("./leaf.js");`,
      ].join("\n"),
    );

    const mod = await loadSourceFile(file);

    expect(mod["which"]).toBe("leaf.ts");
    expect(mod["again"]).toBe("leaf.ts");
    expect((globalThis as Record<string, unknown>)["__zcSpecifierEffect"]).toBe("ran");
    expect(
      ((await (mod["lazy"] as () => Promise<{ which: string }>)()) as { which: string }).which,
    ).toBe("leaf.ts");
  });

  it("sees a JavaScript file that appears beside the sibling, and one that goes away", async () => {
    const { invalidateModuleCache, loadSourceFile } = await freshLoader();
    const dir = layout(["x.ts"]);
    const file = importer(dir, "./x.js");
    expect((await loadSourceFile(file))["which"]).toBe("x.ts");

    // The importer has not changed, so its transpile is a cache hit. Were the
    // rewrite part of what is cached, this load would still reach x.ts.
    fs.writeFileSync(path.join(dir, "x.js"), `export const which = "x.js";\n`);
    invalidateModuleCache();
    expect((await loadSourceFile(file))["which"]).toBe("x.js");

    fs.rmSync(path.join(dir, "x.js"));
    invalidateModuleCache();
    expect((await loadSourceFile(file))["which"]).toBe("x.ts");
  });

  it("finds a transpile's imports once, when Babel runs, and reads them back ever after", async () => {
    const dir = layout(["x.ts"]);
    const request: TransformOptions = {
      source: `import a from "./x.js"; void a;`,
      filename: path.join(dir, "importer.ts"),
      ts: true,
      async: true,
    };
    const counted = vi.fn(babel);
    const jiti = (() => ({
      options: { transform: counted, extensions: EXTENSIONS },
    })) as unknown as typeof createJiti;
    const freshOptions = async () => {
      vi.resetModules();
      const cache = await import("#src/transpile-cache.js");
      cache.useTranspileCache(cacheRoot);
      return cache.transpileOptions(jiti, { tsSpecifiers: true });
    };

    const parses = acornCalls.parse;
    const cold = (await freshOptions()).transform?.(request);
    expect(cold?.code).toContain(`jitiImport("./x.ts")`);
    expect(acornCalls.parse).toBe(parses + 1);

    // A later process: Babel is not run again, and neither is the parse — a
    // module is executed far more often than its source changes, and a parse
    // per execution would hand a seventh of the saving back.
    const warm = (await freshOptions()).transform?.(request);
    expect(warm?.code).toBe(cold?.code);
    expect(counted).toHaveBeenCalledTimes(1);
    expect(acornCalls.parse).toBe(parses + 1);

    // What is kept is Babel's output as it was, and where its one import is.
    // Never the rewrite: that is a fact about the directory, not the source.
    const [name] = fs.readdirSync(path.join(cacheRoot, "jiti")).filter((n) => n.endsWith(".cjs"));
    const stored = fs.readFileSync(path.join(cacheRoot, "jiti", name as string), "utf8");
    expect(stored.split("\n")[0]).toMatch(
      /^\/\* zod-compiler transpile [0-9a-f]{40} \[\d+,\d+\] \*\/$/,
    );
    expect(stored).toContain(`jitiImport("./x.js")`);
    expect(stored).not.toContain("./x.ts");
  });

  it("leaves an instance that only analyses with Babel's output as it was", async () => {
    const dir = layout(["x.ts"]);
    const jiti = (() => ({
      options: { transform: babel, extensions: EXTENSIONS },
    })) as unknown as typeof createJiti;
    vi.resetModules();
    const cache = await import("#src/transpile-cache.js");
    cache.useTranspileCache(cacheRoot);

    // The static filter reads exports; what an import resolves to is nothing
    // to it, and it is not charged the `stat` calls.
    const result = cache.transpileOptions(jiti).transform?.({
      source: `import a from "./x.js"; void a;`,
      filename: path.join(dir, "importer.ts"),
      ts: true,
      async: true,
    });

    expect(result?.code).toContain(`jitiImport("./x.js")`);
  });
});
