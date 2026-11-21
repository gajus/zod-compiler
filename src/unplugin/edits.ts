/**
 * Edit primitives shared by the transform pipeline stages.
 *
 * Every stage (hoist → hoisted-schema compile → rewrites → runtime inject)
 * describes its changes as non-overlapping `Edit` splices (plus at most one
 * insertion) against the STAGE INPUT. The same edit list is applied two
 * ways: `applyEdits()` produces the stage output string, and the pipeline
 * applies it to a MagicString to produce the stage's sourcemap — deriving
 * both from one list makes code/map divergence impossible.
 */

export interface Edit {
  /** Start offset in the stage-input string. */
  start: number;
  /** End offset (exclusive) in the stage-input string. */
  end: number;
  /** Replacement text. */
  text: string;
}

export interface Insertion {
  /** Offset in the stage-input string to insert at. */
  offset: number;
  text: string;
}

/**
 * Offset after the shebang and the directive prologue ("use strict",
 * "use client", "use server", ...) — where module-head insertions must go.
 *
 * A directive is only a directive while it is still part of the prologue, so
 * anything prepended at offset 0 demotes it to a plain string expression.
 * Bundlers that give directives meaning reject that outright: React Server
 * Components builds fail with `The "use client" directive must be placed
 * before other expressions`, which is how the generated runtime prologue used
 * to break every Next.js file that exported a schema.
 */
export function moduleHeadOffset(code: string): number {
  let i = 0;
  if (code.startsWith("#!")) {
    const nl = code.indexOf("\n");
    i = nl === -1 ? code.length : nl + 1;
  }
  while (true) {
    // Skip whitespace and comments between directives
    while (i < code.length) {
      const ch = code[i] as string;
      if (/\s/.test(ch)) {
        i++;
      } else if (ch === "/" && code[i + 1] === "/") {
        const nl = code.indexOf("\n", i);
        i = nl === -1 ? code.length : nl + 1;
      } else if (ch === "/" && code[i + 1] === "*") {
        const end = code.indexOf("*/", i + 2);
        i = end === -1 ? code.length : end + 2;
      } else {
        break;
      }
    }
    // The body excludes backslashes and the lookahead demands a statement
    // boundary, so the two shapes that merely START like a directive are left
    // alone: `"use \"strict\"";` (matching through the escape would land the
    // insertion mid-literal) and `"use " + mode;` (an expression statement,
    // where it would land on the `+`). Both would emit a syntax error.
    const directive = code
      .slice(i)
      .match(/^(["'])use [^"'\n\\]*\1(?=[^\S\n]*([;\n"']|$))\s*;?[^\S\n]*\n?/);
    if (!directive) return i;
    i += directive[0].length;
  }
}

/**
 * A batch of non-overlapping edits in position order, for asking where an
 * offset falls among them without walking them all. Disjoint edits sorted by
 * start are sorted by end as well, which is what makes each question a binary
 * search.
 */
export class EditIndex {
  private readonly starts: number[];
  private readonly ends: number[];
  /** `sums[i]`: how much longer the first `i` edits make the text. */
  private readonly sums: number[];

  constructor(edits: readonly Edit[]) {
    const sorted = [...edits].sort((a, b) => a.start - b.start || a.end - b.end);
    this.starts = sorted.map((edit) => edit.start);
    this.ends = sorted.map((edit) => edit.end);
    this.sums = [0];
    for (const edit of sorted) {
      this.sums.push((this.sums.at(-1) as number) + edit.text.length - (edit.end - edit.start));
    }
  }

  /** How many of the edits end at or before `offset`. */
  endingBy(offset: number): number {
    let low = 0;
    let high = this.ends.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if ((this.ends[mid] as number) <= offset) low = mid + 1;
      else high = mid;
    }
    return low;
  }

  /** Whether the edit at `position` in this order exists and starts at or before `offset`. */
  startsBy(position: number, offset: number): boolean {
    return position < this.starts.length && (this.starts[position] as number) <= offset;
  }

  /** How much longer the first `count` edits make the text. */
  added(count: number): number {
    return this.sums[count] as number;
  }

  /** Whether any of the edits overlaps `[start, end)`. */
  overlaps(start: number, end: number): boolean {
    const next = this.endingBy(start);
    return next < this.starts.length && (this.starts[next] as number) < end;
  }
}

/**
 * Apply non-overlapping edits (any order) and an optional insertion to a
 * string, exactly as a pipeline stage does to its MagicString: each edit an
 * `overwrite` (an `appendLeft` when it is zero-width), then the insertion an
 * `appendLeft`. So an insertion at a replacement's start lands before the
 * replacement, and one where zero-width edits are lands after their text.
 */
export function applyEdits(code: string, edits: readonly Edit[], insert?: Insertion): string {
  // Assembled front to back from slices of `code`. Splicing each edit into
  // the result of the last one re-copied the whole text per edit, which was
  // quadratic in the edits a large file gets.
  const parts: string[] = [];
  let at = 0;
  let pending = insert;
  for (const edit of [...edits].sort((a, b) => a.start - b.start || a.end - b.end)) {
    if (
      pending !== undefined &&
      (pending.offset < edit.start || (pending.offset === edit.start && edit.end > edit.start))
    ) {
      parts.push(code.slice(at, pending.offset), pending.text);
      at = pending.offset;
      pending = undefined;
    }
    parts.push(code.slice(at, edit.start), edit.text);
    at = edit.end;
  }
  if (pending !== undefined) {
    parts.push(code.slice(at, pending.offset), pending.text);
    at = pending.offset;
  }
  parts.push(code.slice(at));
  return parts.join("");
}
