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
 * Apply non-overlapping edits (any order) and an optional insertion to a
 * string. Mirrors MagicString.overwrite + appendLeft semantics: an insertion
 * at an edit boundary lands before the edit's replacement.
 */
export function applyEdits(code: string, edits: readonly Edit[], insert?: Insertion): string {
  const ops: Array<Edit | (Insertion & { insertion: true })> = [...edits];
  if (insert) ops.push({ ...insert, insertion: true });
  ops.sort((a, b) => {
    const aStart = "insertion" in a ? a.offset : a.start;
    const bStart = "insertion" in b ? b.offset : b.start;
    if (aStart !== bStart) return bStart - aStart;
    // Same position: apply the insertion last so it ends up BEFORE the
    // replacement text in the output (appendLeft semantics).
    return "insertion" in a ? -1 : 1;
  });
  let result = code;
  for (const op of ops) {
    if ("insertion" in op) {
      result = result.slice(0, op.offset) + op.text + result.slice(op.offset);
    } else {
      result = result.slice(0, op.start) + op.text + result.slice(op.end);
    }
  }
  return result;
}
