import type { SchemaIR, UnionIR } from "../../types.js";
import type { FastGen, SlowGen } from "../context.js";
import { emitRuntimeHelper, hasMutation } from "../context.js";
import { emit } from "../emit.js";
import { orderByRuntimeCost } from "../fast-size.js";
import { abortingCodeTest, ZC_FZ_DECL } from "../issue-decls.js";
import { detectUnionDiscriminator, emitFastDiscriminatedSwitch } from "./discriminated-union.js";

export function slowUnion(ir: SchemaIR & { type: "union" }, g: SlowGen): string {
  const resultVar = g.temp("u");
  const errorsVar = g.temp("ue");
  // Parallel to errorsVar: zod's `payload.aborted` for each failed option. Set
  // by a pipe/codec option whose `in` failed (see slowPipe); read during pruning
  // alongside the per-issue code check.
  const abortedVar = g.temp("uea");
  let code = `var ${resultVar}=false;var ${errorsVar}=[];var ${abortedVar}=[];`;

  // Options run at a path RELATIVE to the union, not at the union's own path.
  //
  // $ZodUnion hands each option a FRESH payload — `{ value: payload.value,
  // issues: [] }` — so every issue an option raises is numbered from the union's
  // position, and handleUnionResults copies those relative paths into the
  // `invalid_union` groups unchanged. Walking options at the union's absolute
  // path instead leaked it into all of them: `{a: z.union([...])}` reported the
  // nested errors at `["a"]` where zod reports `[]`. Same model record/map
  // already use for their key and value schemas.
  //
  // The union's own path is re-applied in exactly one place, mirroring the one
  // place zod re-applies it: handleUnionResults' shortcut for a single
  // non-aborted option returns THAT OPTION'S payload, whose issues are still
  // relative, and the PARENT (an object's handlePropertyResult, say) prefixes
  // them exactly once. Compiled parents bake their path into each issue at
  // creation, so the union has to do that prefixing itself.
  //
  // That path expression is read ONCE, into `pathVar`, rather than at each issue
  // below — it may allocate a fresh array per evaluation (`["items",__i_7]`).
  // The binding is emitted inside the failure block further down, not here: both
  // readers live there, so a union that matches an option never evaluates it at
  // all, and the whole of this generator's output is one contiguous block at the
  // union's site, so any enclosing loop variable the expression names is equally
  // in scope there. A union already at `[]` prefixes nothing (concat would only
  // copy the array), so it skips the binding entirely.
  const atPathRoot = g.path === "[]";
  const pathVar = atPathRoot ? null : g.temp("up");
  const unionPath = pathVar ?? "[]";

  // If any option can mutate output (default, catch, coerce, effect),
  // each branch gets its own temp output to prevent cross-branch leaks.
  const needsOutputIsolation = ir.options.some(hasMutation);

  for (const option of ir.options) {
    const tmpIssues = g.temp("ui");
    // This option's abort flag, forwarded into the option so a pipe `in` failure
    // can raise it (zod's handlePipeResult). Stays false for every other shape.
    const optAborted = g.temp("uoa");
    const tmpOutput = g.temp("uo");

    if (needsOutputIsolation) {
      code += emit`
        if(!${resultVar}){
          var ${tmpIssues}=[];
          var ${optAborted}=false;
          var ${tmpOutput}=${g.input};
          ${g.visit(option, { issues: tmpIssues, input: tmpOutput, output: tmpOutput, path: "[]", aborted: optAborted })}
          if(${tmpIssues}.length===0){
            ${resultVar}=true;
            ${g.output}=${tmpOutput};
          }else{
            ${errorsVar}.push(${tmpIssues});
            ${abortedVar}.push(${optAborted});
          }
        }`;
    } else {
      // An option that rewrites nothing still writes its output — a loose object
      // hands back its input, or a copy an own `__proto__` was scrubbed from —
      // and zod's result is the output of the option that SUCCEEDED. Written
      // straight to the union's output, a failed option's copy stayed there
      // whenever the option that did succeed wrote nothing (`z.any()`), so an
      // option that names its output gets a local of its own, taken only on
      // success. Its input stays the union's: an option that rewrites nothing
      // does not need its input and output to be one expression (see
      // visitMember).
      const optionCode = g.visit(option, {
        issues: tmpIssues,
        output: tmpOutput,
        path: "[]",
        aborted: optAborted,
      });
      const writes = optionCode.includes(tmpOutput);
      code += emit`
        if(!${resultVar}){
          var ${tmpIssues}=[];
          var ${optAborted}=false;
          ${writes ? `var ${tmpOutput}=${g.input};` : ""}
          ${optionCode}
          if(${tmpIssues}.length===0){
            ${resultVar}=true;
            ${writes ? `${g.output}=${tmpOutput};` : ""}
          }else{
            ${errorsVar}.push(${tmpIssues});
            ${abortedVar}.push(${optAborted});
          }
        }`;
    }
  }

  // Mirrors zod's handleUnionResults pruning (`util.aborted`): an option is
  // "aborted" when its result carries `payload.aborted` (a pipe whose `in`
  // failed — tracked in abortedVar) OR it produced a parse-level issue
  // (continue !== true in zod — invalid_type and friends). Check-level issues
  // (too_small, invalid_format, custom, ...) alone don't abort. If exactly ONE
  // option is non-aborted, its issues are surfaced directly instead of an
  // invalid_union wrapper.
  const msgProp = g.typeMsg === undefined ? "" : `,message:${JSON.stringify(g.typeMsg)}`;
  const fz = emitRuntimeHelper(g.ctx, "__zcFz", ZC_FZ_DECL);
  const naVar = g.temp("una");
  const oiVar = g.temp("uoi");
  const ojVar = g.temp("uoj");
  const abVar = g.temp("uab");
  const ocVar = g.temp("uoc");
  // zod prunes with `util.aborted`, i.e. `continue !== true` on ANY issue — a
  // superset of the code test below, and the only thing that catches a tuple's
  // length issue (schema-created, same code a continuable check uses). See
  // `abortsProp` in emit-issue.ts.
  const oiIssue = g.temp("uoq");
  const okVar = g.temp("uok");
  const ofVar = g.temp("uof");
  const surfaced = `${naVar}[0][${okVar}]`;
  // Which branch fires decides where an option's issues are finalized, because
  // the two branches finalize at DIFFERENT paths — so neither can be done up
  // front, in the option loop, without being wrong for the other half:
  //
  // - invalid_union: zod maps each group through `finalizeIssue` while the paths
  //   are still relative, so an error map reading `issue.path` sees `[]`.
  //   __zcFz is that same locale-fill + input-strip, and is what record/map
  //   already use for the issues they nest.
  // - sole non-aborted: zod surfaces the option's own issues, which reach the
  //   top-level finalizer with the FULL path, so the message is computed from
  //   the absolute path. Prefix here and leave them unfinalized — they land in
  //   the parent's issue array, which is finalized at the top exactly once.
  code += emit`
    if(!${resultVar}){
      ${pathVar === null ? "" : `var ${pathVar}=${g.path};`}
      var ${naVar}=[];
      for(var ${oiVar}=0;${oiVar}<${errorsVar}.length;${oiVar}++){
        var ${abVar}=${abortedVar}[${oiVar}]===true;
        if(!${abVar}){
          for(var ${ojVar}=0;${ojVar}<${errorsVar}[${oiVar}].length;${ojVar}++){
            var ${oiIssue}=${errorsVar}[${oiVar}][${ojVar}];
            if(${oiIssue}.continue===false){${abVar}=true;break;}
            var ${ocVar}=${oiIssue}.code;
            if(${abortingCodeTest(ocVar)}){${abVar}=true;break;}
          }
        }
        if(!${abVar}){${naVar}.push(${errorsVar}[${oiVar}]);}
      }
      if(${naVar}.length===1){
        for(var ${okVar}=0;${okVar}<${naVar}[0].length;${okVar}++){
          ${atPathRoot ? "" : `${surfaced}.path=${unionPath}.concat(${surfaced}.path);`}
          ${g.issues}.push(${surfaced});
        }
      }else{
        for(var ${ofVar}=0;${ofVar}<${errorsVar}.length;${ofVar}++){${fz}(${errorsVar}[${ofVar}]);}
        ${g.issues}.push({code:"invalid_union",errors:${errorsVar},input:${g.input},path:${unionPath}${msgProp}});
      }
    }`;
  return `${code}\n`;
}

export function fastUnion(ir: UnionIR, g: FastGen): string | null {
  // A plain `z.union` of objects that all pin a shared key to disjoint literals
  // is structurally a discriminated union: dispatch on that key with an O(1)
  // switch instead of probing every arm in sequence. detectUnionDiscriminator
  // returns non-null only when the switch provably accepts exactly what the
  // ||-chain would (disjoint required literals). The slow path is untouched, so
  // error output stays identical to Zod's plain-union behavior.
  const discriminated = detectUnionDiscriminator(ir.options);
  if (discriminated !== null) {
    return emitFastDiscriminatedSwitch(
      g,
      discriminated.discriminator,
      discriminated.cases,
      ir.options,
    );
  }

  // Probe cheap options first: the ||-chain stops at the first match, and an
  // option that cannot match is rejected by its own cheapest-first conjunct
  // chain. Which option matches is unobservable here (the result is a single
  // boolean), and the slow path — where option order IS observable, through
  // zod's first-match output and invalid_union issue order — is untouched.
  //
  // That "unobservable" holds for the VERDICT this expression reports, which is
  // all a nested conjunct or a `.is()` guard consumes. It does NOT hold for the
  // by-reference shortcut a root schema takes on a passing check, where WHICH
  // option zod picked decides the output value — see `fastResultIsInput`, which
  // withholds that shortcut rather than costing every union its fast check.
  const optionChecks: string[] = [];
  for (const option of orderByRuntimeCost(ir.options, (o) => o, g.ctx)) {
    const check = g.visit(option);
    if (check === null) return null;
    optionChecks.push(`(${check})`);
  }
  // Wrap in parens — || has lower precedence than && in parent expressions
  return `(${optionChecks.join("||")})`;
}
