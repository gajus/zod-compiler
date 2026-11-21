import MagicString from "magic-string";
import { describe, expect, it } from "vite-plus/test";
import { applyEdits, type Edit, EditIndex, type Insertion } from "#src/unplugin/edits.js";

/** What a pipeline stage makes of the same batch: the behavior applyEdits mirrors. */
function staged(code: string, edits: readonly Edit[], insert?: Insertion): string {
  const s = new MagicString(code);
  for (const edit of edits) {
    if (edit.start === edit.end) s.appendLeft(edit.start, edit.text);
    else s.overwrite(edit.start, edit.end, edit.text);
  }
  if (insert !== undefined) s.appendLeft(insert.offset, insert.text);
  return s.toString();
}

function random(seed: number): (n: number) => number {
  // mulberry32: an LCG's low bits cycle too fast for `% n` to be any use.
  let state = seed;
  return (n) => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) % n;
  };
}

/**
 * Disjoint edits over `length` characters, shuffled: replacements, and
 * zero-width edits between them, some starting where a replacement does. None
 * sits where a replacement ends: there MagicString keeps it or drops it by the
 * order of the two calls, and no stage makes zero-width edits at all.
 */
function disjointEdits(rand: (n: number) => number, length: number): Edit[] {
  const edits: Edit[] = [];
  let at = 0;
  let replacedTo = -1;
  while (true) {
    at += rand(4);
    if (at > length) break;
    if (at !== replacedTo && rand(3) === 0) {
      edits.push({ start: at, end: at, text: `<${rand(3)}>` });
      if (rand(2) === 0) {
        at++;
        continue;
      }
    }
    const width = 1 + rand(3);
    if (at + width > length) break;
    edits.push({ start: at, end: at + width, text: "#".repeat(rand(4)) });
    at += width;
    replacedTo = at;
  }
  for (let i = edits.length - 1; i > 0; i--) {
    const j = rand(i + 1);
    [edits[i], edits[j]] = [edits[j] as Edit, edits[i] as Edit];
  }
  return edits;
}

describe("applyEdits()", () => {
  it("puts an insertion at an edit's start before its replacement, and at its end after it", () => {
    const edit = { start: 2, end: 4, text: "[r]" };
    expect(applyEdits("abcdef", [edit], { offset: 2, text: "<i>" })).toBe("ab<i>[r]ef");
    expect(applyEdits("abcdef", [edit], { offset: 4, text: "<i>" })).toBe("ab[r]<i>ef");
  });

  it("puts an insertion after the text of zero-width edits at its offset, which keep their order", () => {
    const edits = [
      { start: 2, end: 2, text: "<1>" },
      { start: 2, end: 2, text: "<2>" },
    ];
    expect(applyEdits("abcd", edits, { offset: 2, text: "^" })).toBe("ab<1><2>^cd");
  });

  it("applies zero-width edits as insertions, in any order given", () => {
    const edits = [
      { start: 5, end: 6, text: "F" },
      { start: 0, end: 0, text: ">" },
      { start: 3, end: 3, text: "|" },
    ];
    expect(applyEdits("abcdef", edits)).toBe(">abc|deF");
  });

  it("returns the text unchanged for no edits", () => {
    expect(applyEdits("abc", [])).toBe("abc");
    expect(applyEdits("", [], { offset: 0, text: "x" })).toBe("x");
  });

  it("matches a stage's MagicString, on random batches", () => {
    const rand = random(7);
    for (let round = 0; round < 3000; round++) {
      const length = rand(40);
      const code = Array.from({ length }, (_, i) => String.fromCharCode(97 + (i % 26))).join("");
      const edits = disjointEdits(rand, length);
      // An insertion anywhere but strictly inside a replacement.
      const free = Array.from({ length: length + 1 }, (_, i) => i).filter(
        (offset) => !edits.some((e) => e.start < offset && offset < e.end),
      );
      const insert =
        rand(2) === 0 ? undefined : { offset: free[rand(free.length)] as number, text: "^" };
      expect(applyEdits(code, edits, insert)).toBe(staged(code, edits, insert));
    }
  });
});

describe("EditIndex", () => {
  it("answers as a walk over every edit does, on random batches", () => {
    const rand = random(11);
    for (let round = 0; round < 2000; round++) {
      const length = rand(40);
      const edits = disjointEdits(rand, length);
      const index = new EditIndex(edits);
      for (let at = 0; at <= length + 1; at++) {
        // StagedTransform.locate's walk: the length every edit wholly before
        // `at` adds, or -1 for an offset an edit replaced.
        let walked = 0;
        for (const edit of edits) {
          if (edit.end <= at) walked += edit.text.length - (edit.end - edit.start);
          else if (edit.start <= at) walked = Number.NaN;
        }
        const before = index.endingBy(at);
        const looked = index.startsBy(before, at) ? Number.NaN : index.added(before);
        expect(looked).toBe(walked);
        for (let end = at; end <= Math.min(length + 1, at + 5); end++) {
          const overlapping = edits.some((edit) => edit.start < end && at < edit.end);
          expect(index.overlaps(at, end)).toBe(overlapping);
        }
      }
    }
  });
});
