/**
 * Identifiers as the text-level passes meet them in user source.
 *
 * An export's name, a binding's, and so the name of the validator generated
 * for it, can hold a `$`, letters outside ASCII (`Schéma`) and characters past
 * the BMP (`𝒳`). `\w` and `\b` know ASCII letters, digits and `_` only: a
 * pattern built on them reads no `$Node` where the source has one, never finds
 * `Schéma` at all, and splits `éz` into an `é` and the `z` that zod is
 * imported as.
 *
 * The patterns here are sources for a regex with the `u` flag. An identifier
 * spelled with an escape (`\u0061`) is beyond them; what it names is left as
 * it was written.
 */

/** A character an identifier can continue with: ID_Continue, `$`, ZWNJ, ZWJ. */
export const IDENTIFIER_PART = String.raw`[\p{ID_Continue}$\u200C\u200D]`;

/** A character an identifier can begin with. */
export const IDENTIFIER_START = String.raw`[\p{ID_Start}$_]`;

/** An identifier name. */
export const IDENTIFIER = `${IDENTIFIER_START}${IDENTIFIER_PART}*`;

const IDENTIFIER_NAME = new RegExp(`^${IDENTIFIER}$`, "u");

const NOT_IDENTIFIER_PART = /[^\p{ID_Continue}$\u200C\u200D]/gu;

/**
 * Words a module cannot declare: the reserved words, strict mode's, the
 * module's own `await`, and `eval` and `arguments`, which strict code cannot
 * bind.
 */
const UNDECLARABLE = new Set([
  "arguments",
  "await",
  "break",
  "case",
  "catch",
  "class",
  "const",
  "continue",
  "debugger",
  "default",
  "delete",
  "do",
  "else",
  "enum",
  "eval",
  "export",
  "extends",
  "false",
  "finally",
  "for",
  "function",
  "if",
  "implements",
  "import",
  "in",
  "instanceof",
  "interface",
  "let",
  "new",
  "null",
  "package",
  "private",
  "protected",
  "public",
  "return",
  "static",
  "super",
  "switch",
  "this",
  "throw",
  "true",
  "try",
  "typeof",
  "var",
  "void",
  "while",
  "with",
  "yield",
]);

/** Is `text` an identifier name? A reserved word is one. */
export function isIdentifierName(text: string): boolean {
  return IDENTIFIER_NAME.test(text);
}

/** Can a module declare `name`, as in `export const <name> = …`? */
export function isDeclarableName(name: string): boolean {
  return isIdentifierName(name) && !UNDECLARABLE.has(name);
}

/** `name` matched whole: with no identifier character on either side of it. */
export function wholeIdentifier(name: string): string {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return `(?<!${IDENTIFIER_PART})${escaped}(?!${IDENTIFIER_PART})`;
}

/**
 * `name` as the end of an identifier: each character no identifier can
 * continue with becomes `_`. A module can export under any string
 * (`export { S as "user-schema" }`), and a validator is named after its export.
 */
export function asIdentifierPart(name: string): string {
  return name.replace(NOT_IDENTIFIER_PART, "_");
}
