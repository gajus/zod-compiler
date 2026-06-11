/**
 * Tagged template literal that strips newlines and leading whitespace.
 * Allows writing generated code with readable indentation while producing minified output.
 *
 * Used exclusively by Slow Path generators (codegen/schemas/).
 */
export function emit(
  strings: TemplateStringsArray,
  ...values: (string | number | bigint | boolean)[]
): string {
  let result = "";
  for (let i = 0; i < strings.length; i++) {
    result += (strings[i] ?? "").replace(/\n\s*/g, "");
    if (i < values.length) result += String(values[i]);
  }
  return result;
}
