import type { RecordIR, SchemaIR } from "../../types.js";
import type { FastGen, SlowGen } from "../context.js";
import { declareFastTemps, emitRuntimeHelper, extendPath, hasMutation } from "../context.js";
import { emit } from "../emit.js";
import { invalidType, unrecognizedKeys } from "../emit-issue.js";
import { ZC_FZ_DECL, ZC_HOP_DECL, ZC_PLAIN_DECL, ZC_PROTO_SCRUB_DECL } from "../issue-decls.js";

/**
 * `$ZodRecord` gates on `util.isPlainObject`, NOT the looser `util.isObject`
 * that `$ZodObject` uses — see {@link ZC_PLAIN_DECL} for why the two differ and
 * what accepting the wrong one lets through.
 */
function plainObjectTest(g: SlowGen | FastGen, input: string): string {
  return `${emitRuntimeHelper(g.ctx, "__zcPlain", ZC_PLAIN_DECL)}(${input})`;
}

/**
 * Zod's record walk opens with `if (key === "__proto__") continue`, so an own
 * `__proto__` data property (which `JSON.parse('{"__proto__":…}')` creates) is
 * neither key-validated nor value-validated nor copied. Without this the
 * compiled walk reported issues zod does not: `z.record(z.string(), z.number())`
 * over such an object raised a SECOND `invalid_type`, and a constrained key
 * schema a second `invalid_key`, for a key zod never looks at.
 */
const PROTO_SKIP = (keyVar: string): string => `if(${keyVar}==="__proto__")continue;`;

export function slowRecord(ir: SchemaIR & { type: "record" }, g: SlowGen): string {
  let code = emit`
    if(!${plainObjectTest(g, g.input)}){
      ${invalidType(g, "record")}
    }else{`;

  if (hasMutation(ir.valueType)) {
    code += `${g.output}={...${g.input}};`;
  }
  // PROTO_SKIP keeps `__proto__` out of the WALK; this keeps it out of the
  // OUTPUT, which zod also does — it copies into a fresh `{}` and skips the key
  // (see ZC_PROTO_SCRUB_DECL). Runs before the walk so the loop iterates the
  // same container the caller gets back.
  code += `${g.output}=${emitRuntimeHelper(g.ctx, "__zcPs", ZC_PROTO_SCRUB_DECL)}(${g.input});`;

  const keyVar = g.temp("rkey");
  const keyIssuesVar = g.temp("rki");
  const keyPath = extendPath(g.path, keyVar);
  const valExpr = `${g.input}[${keyVar}]`;
  // for-in + hasOwnProperty guard instead of Object.keys(): identical
  // own-enumerable string-key set and iteration order, no keys-array
  // allocation. When the value type mutates (coerce/default/.trim()) the clone
  // above has already replaced g.input, so this iterates the clone exactly as
  // the Object.keys form did — the key set is stable (values change, keys
  // don't). Records whose values mutate run this path eagerly, so they get the
  // same speedup the fast path does.
  const hop = emitRuntimeHelper(g.ctx, "__zcHop", ZC_HOP_DECL);

  // The key is validated at a RELATIVE path and its issues are finalized before
  // being nested, mirroring zod: `issues: keyResult.issues.map(finalizeIssue)`
  // over a payload zod ran fresh. Nested issues never reach the top-level
  // finalization loop (it walks only the outer array), so an unfinalized nest
  // leaked absolute paths and the raw `input` into the reported error.
  const fz = emitRuntimeHelper(g.ctx, "__zcFz", ZC_FZ_DECL);

  // A key the enumerable key schema rejects is unrecognized, not invalid: zod
  // collects those and pushes ONE `unrecognized_keys` after the walk, so it
  // trails every value issue (see RecordIR.enumerableKeys).
  const unrecognizedVar = ir.enumerableKeys ? g.temp("ruk") : null;
  const onKeyFailure =
    unrecognizedVar === null
      ? `${g.issues}.push({code:"invalid_key",origin:"record",issues:${fz}(${keyIssuesVar}),input:${keyVar},path:${keyPath}${g.typeMsg === undefined ? "" : `,message:${JSON.stringify(g.typeMsg)}`}});`
      : `(${unrecognizedVar}=${unrecognizedVar}||[]).push(${keyVar});`;

  code += emit`
    ${unrecognizedVar === null ? "" : `var ${unrecognizedVar}=null;`}
    for(var ${keyVar} in ${g.input}){
      if(!${hop}.call(${g.input},${keyVar}))continue;
      ${PROTO_SKIP(keyVar)}
      var ${keyIssuesVar}=[];
      ${g.visit(ir.keyType, { input: keyVar, output: keyVar, path: "[]", issues: keyIssuesVar })}
      if(${keyIssuesVar}.length>0){
        ${onKeyFailure}
      }else{
        ${g.visit(ir.valueType, { input: valExpr, output: valExpr, path: keyPath })}
      }
    }
    ${unrecognizedVar === null ? "" : `if(${unrecognizedVar}!==null){${unrecognizedKeys(g, unrecognizedVar)}}`}
  }`;
  return `${code}\n`;
}

export function fastRecord(ir: RecordIR, g: FastGen): string | null {
  const x = g.input;
  const parts: string[] = [plainObjectTest(g, x)];

  // Object.keys only yields strings — a plain unconstrained string key schema
  // is always satisfied, so skip generating its check entirely.
  const plainStringKey =
    ir.keyType.type === "string" && ir.keyType.checks.length === 0 && ir.keyType.coerce !== true;

  const kv = g.temp("rk");
  const vv = g.temp("rv");
  // Key + value checks share one fresh scope — they live in the same emitted
  // helper function, size-gated independently of the caller.
  const body = g.scoped(kv);
  const keyCheck = plainStringKey ? "true" : body.visit(ir.keyType, { input: kv });
  // Hoist o[k] into a loop variable: computed-key lookups don't get V8's load
  // elimination across check boundaries, so each repeated o[k] would re-walk
  // the (often dictionary-mode) object.
  const valCheck = body.visit(ir.valueType, { input: vv });
  if (keyCheck === null || valCheck === null) return null;

  const conditions: string[] = [];
  if (keyCheck !== "true") conditions.push(keyCheck);
  if (valCheck !== "true") conditions.push(valCheck);

  if (conditions.length > 0) {
    const helperName = g.temp("rf");
    const valAssign = valCheck !== "true" ? `${vv}=o[${kv}];` : "";
    // for-in (no Object.keys array allocation) + hasOwnProperty guard. The
    // guard restricts iteration to own enumerable string keys — the exact set
    // Object.keys/the slow path produce — so inherited enumerable props can't
    // make the fast check disagree with the deferred slow walk. Measured 2.9x
    // (5 keys) to 5.8x (20 keys) faster than the Object.keys form; the hoisted
    // __zcHop.call inlines, making the guard ~free vs an unguarded for-in.
    const hop = emitRuntimeHelper(g.ctx, "__zcHop", ZC_HOP_DECL);
    g.ctx.preamble.push(
      `function ${helperName}(o){${declareFastTemps(body.scope)}var ${kv},${vv};for(${kv} in o){${PROTO_SKIP(kv)}if(${hop}.call(o,${kv})){${valAssign}if(!(${conditions.join("&&")})){return false;}}}return true;}`,
    );
    parts.push(`${helperName}(${x})`);
  }

  return parts.join("&&");
}
