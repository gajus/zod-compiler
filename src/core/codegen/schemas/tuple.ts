import type { SchemaIR, TupleIR } from "../../types.js";
import type { FastGen, SlowGen } from "../context.js";
import {
  declareFastTemps,
  extendPath,
  extendStaticPathIndex,
  hasMutation,
  outputAlwaysDefined,
  tupleRewritesShortInput,
  visitMember,
} from "../context.js";
import { orderByRuntimeCost } from "../fast-size.js";
import { emit } from "../emit.js";
import { invalidType, tooBig, tooSmall } from "../emit-issue.js";

/**
 * What an ABSENT slot (index at or past the input's length) does to the output,
 * per zod's `handleTupleResults`:
 *
 *  - `present`: can never be absent — below `optStart` without a rest element,
 *    where a shorter input is already `too_small`.
 *  - `skip`: at or past `optoutStart` and on the "optional" rung of `optin`.
 *    The output ends here; the item is not consulted and nothing after it runs.
 *  - `tail`: at or past `optoutStart` on any other rung. The item runs on
 *    `undefined`; a failure ends the output here with its issues dropped, a
 *    success is written back and may be trimmed later if it is `undefined`.
 *  - `pad`: below `optoutStart`, so a later slot has to keep its index. The
 *    item runs on `undefined`, its issues count, and its result — an own
 *    `undefined` at the least — is written back.
 */
type SlotKind = "present" | "skip" | "tail" | "pad";

function slotKinds(ir: TupleIR): SlotKind[] {
  const len = ir.items.length;
  const optoutStart = ir.optoutStart ?? len;
  const optionalIn = new Set(ir.optionalIn ?? []);
  const absentFrom = ir.rest === null ? ir.optStart : 0;
  return ir.items.map((_, i) => {
    if (i < absentFrom) return "present";
    if (i < optoutStart) return "pad";
    return optionalIn.has(i) ? "skip" : "tail";
  });
}

/**
 * Mirrors $ZodTuple. Without rest, an input shorter than `optStart` is a single
 * `too_small` (`minimum: optStart`, `inclusive: true`) that skips item
 * validation, and a longer one a single `too_big` that does NOT — zod pushes it
 * and runs the items anyway, so their issues follow it. Both are created by
 * the tuple node (schema error applies) and both share the `code, minimum |
 * maximum, inclusive, origin` key order that check-created size issues do not.
 *
 * Every item then runs, absent slots included, and the output is shaped by
 * {@link slotKinds}. The generated code keeps zod's invariant that the output
 * grows one slot at a time from the input's length: a slot that is about to be
 * handled as absent is exactly the output's current length, and once a `skip`
 * or a failed `tail` ends the output, every later absent slot sees a shorter
 * array and falls through. Ending the output at slot `i` needs no truncation
 * beyond what the failed item may have written, because nothing past `i` was
 * ever assigned.
 */
export function slowTuple(ir: SchemaIR & { type: "tuple" }, g: SlowGen): string {
  const len = ir.items.length;
  const kinds = slotKinds(ir);
  const optoutStart = ir.optoutStart ?? len;

  // Every read and write goes through ONE binding, seeded from the input and
  // re-pointed by each copy, with the result written to `g.output` at the end.
  // Reading `g.input` and writing `g.output` directly only works while the two
  // are the same identifier — true at every `createSlowGen` root, but not where
  // a parent hands over a separate local for each (an object's pass-through
  // property, a container member that rewrites nothing: see visitMember). There
  // a copy lands in `g.output` while the writes go on hitting the original, so
  // the output keeps the pristine array and the caller's array collects the
  // changes instead.
  const x = g.temp("ta");

  // With a rest element the fixed items' issues are BUFFERED and flushed after
  // the rest loop, because that is the order zod reports them in: `$ZodTuple`
  // collects the fixed items into `itemResults` WITHOUT touching the payload,
  // runs the rest loop (which pushes through `handleTupleResult`), and only
  // then calls `handleTupleResults`, which pushes what it buffered. So
  // `z.tuple([z.string()]).rest(z.number())` on `[1,"b"]` reports the rest
  // element's issue first. `ZodError.message` is `JSON.stringify(issues)`, so
  // the order is user-visible, not just an array detail.
  const itemIssues = ir.rest === null ? g.issues : g.temp("tqi");

  let code = emit`
    if(!Array.isArray(${g.input})){
      ${invalidType(g, "tuple")}
    }else{
      var ${x}=${g.input};
      ${ir.rest === null ? "" : `var ${itemIssues}=[];`}`;

  let itemsCode = "";
  const mutates = ir.items.some(hasMutation) || (ir.rest !== null && hasMutation(ir.rest));
  if (mutates) {
    itemsCode += `${x}=${x}.slice();`;
  }

  // The input's length, read once: absent slots are written back and would
  // otherwise shift the presence test for the slots after them.
  const lenVar = kinds.some((k) => k !== "present") ? g.temp("tl") : "";
  if (lenVar) itemsCode += `var ${lenVar}=${x}.length;`;
  // A short input gains slots, so it is copied before the first write — the
  // caller's array must not grow. Guarded on the length so a well-formed input
  // never allocates; a mutating item has already paid for the copy.
  if (!mutates && tupleRewritesShortInput(ir)) {
    itemsCode += `if(${lenVar}<${len}){${x}=${x}.slice();}`;
  }

  for (let i = 0; i < len; i++) {
    const itemIR = ir.items[i] as SchemaIR;
    const elemExpr = `${x}[${i}]`;
    // Read into a local and handed back through visitMember, which lands a
    // replacement on a copy while `x` is still the caller's array.
    const itemCode = visitMember(g, itemIR, {
      container: x,
      original: g.input,
      copy: `${x}.slice()`,
      key: String(i),
      path: extendStaticPathIndex(g.ctx, g.path, i),
      issues: itemIssues,
    });
    // One copy of the item code per slot: an absent slot is materialized as an
    // own `undefined` first (`x[i] = undefined`, which is also what extends the
    // copied array), then validated exactly as a present one would be.
    const absent = `${i}>=${lenVar}`;
    switch (kinds[i]) {
      case "present":
        itemsCode += itemCode;
        break;
      case "skip":
        itemsCode += emit`if(${i}<${lenVar}){${itemCode}}`;
        break;
      case "tail": {
        const beforeVar = g.temp("tb");
        itemsCode += emit`
          if(${i}<${lenVar}||${x}.length===${i}){
            var ${beforeVar}=${itemIssues}.length;
            if(${absent}){${elemExpr}=undefined;}
            ${itemCode}
            if(${absent}&&${itemIssues}.length>${beforeVar}){${itemIssues}.length=${beforeVar};${x}.length=${i};}
          }`;
        break;
      }
      case "pad":
        itemsCode += emit`if(${absent}){${elemExpr}=undefined;}${itemCode}`;
        break;
    }
  }

  // zod's trailing trim: absent slots that produced `undefined` are dropped
  // from the end while the item is optional-out. Only a `tail` slot can leave
  // one behind (a `pad` slot sits below `optoutStart`, a `skip` slot writes
  // nothing), so the loop is emitted only when some tail item might.
  if (kinds.some((k, i) => k === "tail" && !outputAlwaysDefined(ir.items[i] as SchemaIR))) {
    const tVar = g.temp("tt");
    const floor = optoutStart > 0 ? `${tVar}>=${optoutStart}&&` : "";
    itemsCode += `for(var ${tVar}=${x}.length-1;${floor}${tVar}>=${lenVar}&&${x}[${tVar}]===undefined;${tVar}--){${x}.length=${tVar};}`;
  }

  if (ir.rest !== null) {
    const idxVar = g.temp("ti");
    const restCode = visitMember(g, ir.rest, {
      container: x,
      original: g.input,
      copy: `${x}.slice()`,
      key: idxVar,
      path: extendPath(g.ctx, g.path, idxVar),
      issues: g.issues,
    });
    itemsCode += emit`
      for(var ${idxVar}=${len};${idxVar}<${x}.length;${idxVar}++){
        ${restCode}
      }`;
    const flushVar = g.temp("tqj");
    itemsCode += `for(var ${flushVar}=0;${flushVar}<${itemIssues}.length;${flushVar}++){${g.issues}.push(${itemIssues}[${flushVar}]);}`;
    itemsCode += `${g.output}=${x};`;
    code += itemsCode;
  } else {
    const body = emit`
      if(${x}.length>${len}){
        ${tooBig(g, len, "array", true, { layout: "tuple", aborts: true })}
      }
      ${itemsCode}
      ${g.output}=${x};`;
    code +=
      ir.optStart > 0
        ? emit`
          if(${x}.length<${ir.optStart}){
            ${tooSmall(g, ir.optStart, "array", true, { layout: "tuple", aborts: true })}
          }else{
            ${body}
          }`
        : body;
  }

  code += `}\n`;
  return code;
}

export function fastTuple(ir: TupleIR, g: FastGen): string | null {
  const x = g.input;
  const parts: string[] = [`Array.isArray(${x})`];
  const kinds = slotKinds(ir);

  if (ir.rest === null) {
    if (ir.optStart === ir.items.length) {
      parts.push(`${x}.length===${ir.items.length}`);
    } else {
      if (ir.optStart > 0) parts.push(`${x}.length>=${ir.optStart}`);
      parts.push(`${x}.length<=${ir.items.length}`);
    }
  }

  // Per-index checks, cheapest-first: positions are independent, so the emitted
  // order only decides which one a reject stops on (see estimateRuntimeCost).
  // The Array.isArray + length conjuncts above stay in front — the element
  // reads are only meaningful once they hold.
  const indexed = ir.items.flatMap((itemIR, index) => (itemIR ? [{ index, itemIR }] : []));
  for (const { index, itemIR } of orderByRuntimeCost(indexed, (e) => e.itemIR, g.ctx)) {
    const itemCheck = g.visit(itemIR, { input: `${x}[${index}]` });
    if (itemCheck === null) return null;
    const kind = kinds[index];
    // The fast check answers true only where the output IS the input (see
    // fastResultIsInput), so a slot that would be written back when absent —
    // `pad` and `tail` alike — must be present here; the slow walk builds the
    // longer output. A `skip` slot is the reverse: absent, it is accepted
    // whatever its item says, since zod ends the output there without
    // consulting it.
    if (kind === "pad" || kind === "tail") {
      parts.push(
        itemCheck === "true" ? `${x}.length>${index}` : `${x}.length>${index}&&${itemCheck}`,
      );
    } else if (itemCheck === "true") {
      continue;
    } else {
      parts.push(kind === "skip" ? `(${x}.length<=${index}||${itemCheck})` : itemCheck);
    }
  }

  // Rest element validation via preamble helper (avoids .slice().every()
  // allocation). Fresh scope: the helper is its own function, size-gated
  // independently. (Fixed items above stay inline in the caller's && chain.)
  if (ir.rest !== null) {
    const rv = g.temp("tr");
    const restGen = g.scoped(rv);
    const restCheck = restGen.visit(ir.rest);
    if (restCheck === null) return null;
    if (restCheck !== "true") {
      const helperName = g.temp("te");
      g.ctx.preamble.push(
        `function ${helperName}(a,s){${declareFastTemps(restGen.scope)}for(var ${rv},i=s;i<a.length;i++){${rv}=a[i];if(!(${restCheck})){return false;}}return true;}`,
      );
      parts.push(`${helperName}(${x},${ir.items.length})`);
    }
  }

  return parts.join("&&");
}
