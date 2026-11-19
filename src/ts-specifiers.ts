/**
 * Relative `./x.js` specifiers that mean `x.ts`, settled before jiti is asked.
 *
 * TypeScript under `nodenext` writes the specifier of the file it will emit, so
 * a project's own imports all read `./x.js` while only `x.ts` is on disk. jiti
 * gets there, but last: it first walks its whole resolution ladder for the
 * name as written — the path, the path with each of nine extensions appended,
 * an `index` file under it with each of nine more, all of that from four base
 * URLs and under two condition sets, then Node's own resolution — and each of
 * those ~150 probes is a thrown error. It tries the TypeScript spelling only
 * once every one of them has failed: 1.9 ms per import, against 23 µs for the
 * same file imported as `./x.ts`. Nothing in jiti remembers the answer either,
 * so it is paid again for every importer and after every invalidation. On a
 * 400-file project that was 450 ms of a 1.7 s cold build; on one whose schema
 * files reach a 1,000-module barrel, re-transforming a single edited file took
 * 2.1 s, nine tenths of it this.
 *
 * jiti has no option that reorders the ladder and no hook into its resolver —
 * as of 2.7.0, the latest release, and of its main branch. What it does offer
 * is `transform`, so the fix is applied to what Babel returns: a static import
 * of `./x.js` has become `jitiImport("./x.js")`, and where the ladder would
 * have ended at `x.ts` that literal is rewritten to `"./x.ts"`, which jiti
 * resolves on its first probe.
 *
 * ## Why the answer cannot differ from jiti's
 *
 * The rewrite fires only when every step jiti takes BEFORE its `.js`→`.ts`
 * swap is known to fail and the swap is known to land on a regular file — the
 * ladder is reproduced, not approximated (see {@link tsSibling}). Whatever
 * falls outside that — a real `x.js`, an `x.js.json` beside it, a directory
 * called `x.ts`, a specifier with a query string — is left exactly as written
 * for jiti to resolve as it always has. `tests/ts-specifiers.test.ts` runs the
 * same layouts through an untouched jiti and pins the two against each other,
 * so a jiti that reorders its ladder fails the suite rather than a build.
 *
 * `.js` is never taken to `.tsx`: TypeScript allows it, jiti does not resolve
 * it, and this changes how fast an import resolves, not whether it does.
 *
 * ## Why nothing goes stale
 *
 * The rewrite is not stored. The transpile cache (transpile-cache.ts) keeps
 * what Babel produced, and this runs on the way out of it, on every execution
 * of a module — the moment jiti itself would have resolved the import. A
 * sibling that appears or disappears is therefore seen exactly when jiti would
 * have seen it: at the next execution, which is what a watch-mode change
 * triggers by evicting the module. Left to jiti's own cache the rewritten text
 * would have been persisted under the importer's source hash, and an `x.js`
 * created later would have gone unnoticed for as long as the importer did not
 * change.
 *
 * What IS stored, beside the transpile, is where its import literals are
 * ({@link importSites}): a fact about the output alone, and the one part of
 * this that costs anything — a parse, ~50 µs per KiB. Paid when Babel runs,
 * at a twenty-fifth of Babel's own price, it leaves each later execution a
 * handful of `stat` calls per import.
 */

import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import process from "node:process";
import { parse } from "acorn";

/** jiti's own `JS_EXT_RE`: the extensions its swap applies to. */
const JS_EXTENSION = /\.(c|m)?j(sx?)$/;

/**
 * A call Babel's ESM-to-jiti conversion could have written for a relative
 * import of a JS-extension file. Only a candidate: the same text can sit in a
 * string or a comment the source carried through, which is what
 * {@link importLiterals} rules out.
 *
 * The specifier takes no backslash, so the literal has no escape and its text
 * IS its value, and no `%`, `?` or `#`: jiti resolves through URLs, where
 * those do not mean what they mean in a path.
 */
const CANDIDATE = /\bjitiImport\(\s*(["'])(\.\.?\/[^"'\\%?#\n\r]*\.[cm]?jsx?)\1\s*\)/g;

const require = createRequire(import.meta.url);

/**
 * Process settings under which jiti's two routes to a file stop agreeing on
 * its name, so the specifier is better left for jiti: `--preserve-symlinks`
 * (Node's resolver honours it, the one jiti tries first never does), and an
 * alias map, which jiti applies to the specifier before either.
 */
function settingsAllowRewrite(): boolean {
  if (process.env["JITI_ALIAS"] !== undefined) return false;
  if (process.env["NODE_PRESERVE_SYMLINKS"] === "1") return false;
  if (process.execArgv.includes("--preserve-symlinks")) return false;
  return !(process.env["NODE_OPTIONS"] ?? "").includes("--preserve-symlinks");
}

/** Is anything at all at this path? Unreadable counts as present. */
function exists(file: string): boolean {
  try {
    return fs.statSync(file, { throwIfNoEntry: false }) !== undefined;
  } catch {
    return true;
  }
}

function isFile(file: string): boolean {
  try {
    return fs.statSync(file, { throwIfNoEntry: false })?.isFile() === true;
  } catch {
    return false;
  }
}

/**
 * The specifier jiti's `.js`→`.ts` swap would resolve `specifier` through, or
 * null when its ladder would not get that far or would not stop there.
 *
 * jiti (2.7.0, `jitiResolve`) resolves a relative specifier in this order, and
 * the first hit wins:
 *
 *  1. the path as written — a file, or a directory with an `index` file;
 *  2. the path with each of `extensions` appended;
 *  3. Node's `require.resolve` of it: the path with each extension Node itself
 *     loads appended (`.js`, `.json`, `.node`, and whatever a loader has
 *     registered);
 *  4. `require.resolve` of the path with its first non-`.js` extension
 *     appended, which again tries each of Node's on top;
 *  5. only then the path with its JS extension swapped for the TypeScript one.
 *
 * So the swap is what jiti ends on exactly when nothing exists at any name in
 * 1–4 and a regular file exists at 5. "Nothing" is deliberately stricter than
 * each step's own test (a directory named `x.js.mjs` would only matter if it
 * held an `index.js`): a layout that odd is cheaper to hand to jiti than to
 * reason about.
 */
export function tsSibling(
  directory: string,
  specifier: string,
  extensions: readonly string[],
): string | null {
  if (!specifier.startsWith("./") && !specifier.startsWith("../")) return null;
  // jiti returns a specifier that names one of its native modules untouched.
  if (specifier.includes("node_modules/")) return null;
  for (let i = 0; i < specifier.length; i++) {
    const code = specifier.charCodeAt(i);
    // jiti resolves through URLs first and paths second. Control characters,
    // a backslash, `%`, `?` and `#` are where the two read a specifier
    // differently, so a specifier holding one is jiti's to resolve.
    if (code < 32 || code === 92 || code === 37 || code === 63 || code === 35) return null;
  }
  const swapped = specifier.replace(JS_EXTENSION, ".$1t$2");
  if (swapped === specifier) return null;

  const written = path.resolve(directory, specifier);
  if (exists(written)) return null;
  if (!isFile(path.resolve(directory, swapped))) return null;

  const native = Object.keys(require.extensions);
  const first = extensions.find((extension) => extension !== ".js");
  for (const extension of new Set([...extensions, ...native])) {
    if (exists(written + extension)) return null;
  }
  if (first !== undefined) {
    for (const extension of native) {
      if (exists(written + first + extension)) return null;
    }
  }
  return swapped;
}

/**
 * Where each `jitiImport("…")` call's string literal sits in `code`, start to
 * end, or null for code that does not parse.
 *
 * A parse, because nothing less tells a call from text that reads like one: a
 * source's comments and string contents come through Babel as they were, and
 * a file that documents its own imports must not have its documentation
 * rewritten.
 */
function importLiterals(code: string): Map<number, number> | null {
  let program: unknown;
  try {
    // What jiti will wrap in an async function: top-level `await` and `return`
    // are both in order, and nothing says it is strict.
    program = parse(code, {
      allowAwaitOutsideFunction: true,
      allowHashBang: true,
      allowReturnOutsideFunction: true,
      ecmaVersion: "latest",
      sourceType: "script",
    });
  } catch {
    return null;
  }

  const literals = new Map<number, number>();
  const stack: unknown[] = [program];
  while (stack.length > 0) {
    const node = stack.pop();
    if (Array.isArray(node)) {
      for (const item of node) stack.push(item);
      continue;
    }
    if (typeof node !== "object" || node === null) continue;
    const record = node as Record<string, unknown>;
    if (typeof record["type"] !== "string") continue;
    if (record["type"] === "CallExpression") {
      const callee = record["callee"] as { type: string; name?: string };
      const args = record["arguments"] as {
        type: string;
        value?: unknown;
        start: number;
        end: number;
      }[];
      const [argument] = args;
      if (
        callee.type === "Identifier" &&
        callee.name === "jitiImport" &&
        args.length === 1 &&
        argument?.type === "Literal" &&
        typeof argument.value === "string"
      ) {
        literals.set(argument.start, argument.end);
      }
    }
    for (const value of Object.values(record)) {
      if (typeof value === "object" && value !== null) stack.push(value);
    }
  }
  return literals;
}

/**
 * Where `code` — a module as jiti's Babel transform returned it — imports a
 * relative JS-extension specifier: the string literals' offsets, flattened to
 * `[start, end, start, end, …]` in source order. These are the only places
 * {@link resolveTsSpecifiers} will ever write to.
 */
export function importSites(code: string): number[] {
  if (!code.includes("jitiImport(")) return [];
  const candidates: number[] = [];
  for (const match of code.matchAll(CANDIDATE)) {
    const [call, quote, specifier] = match as unknown as [string, string, string];
    const start = match.index + call.indexOf(quote);
    candidates.push(start, start + specifier.length + 2);
  }
  if (candidates.length === 0) return [];

  const literals = importLiterals(code);
  if (literals === null) return [];
  const sites: number[] = [];
  for (let i = 0; i < candidates.length; i += 2) {
    const start = candidates[i] as number;
    const end = candidates[i + 1] as number;
    if (literals.get(start) === end) sites.push(start, end);
  }
  return sites;
}

/**
 * `code` with each import at `sites` that jiti would resolve to a TypeScript
 * sibling spelled as that sibling. `extensions` is the jiti instance's own
 * list, the ladder being a function of it.
 */
export function resolveTsSpecifiers(
  code: string,
  sites: readonly number[],
  filename: string,
  extensions: readonly string[],
): string {
  if (sites.length === 0 || !settingsAllowRewrite()) return code;

  const directory = path.dirname(filename);
  let rewritten = "";
  let from = 0;
  for (let i = 0; i + 1 < sites.length; i += 2) {
    const start = sites[i] as number;
    const end = sites[i + 1] as number;
    // The quotes stay; what is between them is the specifier, verbatim.
    const swapped = tsSibling(directory, code.slice(start + 1, end - 1), extensions);
    if (swapped === null) continue;
    rewritten += code.slice(from, start + 1) + swapped;
    from = end - 1;
  }
  return from === 0 ? code : rewritten + code.slice(from);
}
