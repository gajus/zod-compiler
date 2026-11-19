/**
 * The value zod's own traversal is handed when a compiled schema answers its
 * `_zod.run` (see ZOD_RUN_DECL in iife.ts and zodRunSupport).
 *
 * That traversal belongs to callers who never asked for compiled output: an
 * uncompiled parent, a schema derived at a call site, `z.safeParse(schema, x)`.
 * They get zod's output, and zod builds every object, array, tuple, record,
 * set and map it parses. The compiled walks return a container that nothing
 * rewrites by reference. That difference is documented for direct calls, and
 * it rules out this route. Zod's wrappers act on a child's output in place
 * (`.readonly()` freezes it), so an aliased container would carry zod's edits
 * onto the caller's input.
 *
 * So the validator's result is followed by a copy of exactly the containers it
 * returned by reference, made as zod makes each one. That is a short pass over
 * the paths that lead to them, usually one `__zcAc(o.tags)`, rather than a
 * second build of the whole schema. A full build measured about 1.5 KB per
 * schema, 18% of the default output on a corpus of objects with an array
 * field each and 34% of the compact output.
 *
 * Where the copy cannot be made exactly, the route stays zod's: a container
 * under a plain union (the output does not show which option zod would have
 * chosen) or under a pipe the build rebuilt (`out` parsed a value not in hand
 * here), a record over a declared key set, a record under a transform, and a
 * default whose inner can turn a defined input into `undefined`. A record is
 * copied, and its symbol keys checked, wherever it sits. Zod's walk runs the
 * key schema on every own key, symbols included, so an input with one goes to
 * zod.
 */

import type { DiscriminatedUnionIR, SchemaIR } from "../types.js";
import type { CodeGenContext } from "./context.js";
import {
  emitRuntimeHelper,
  emitTemp,
  escapeString,
  keyMembershipTest,
  literalToJs,
  outputAlwaysDefined,
} from "./context.js";
import {
  assembleObject,
  children,
  emitFailSentinel,
  passesThroughWithScrub,
  rebuildSet,
  type OutputSlot,
} from "./build-path.js";
import { ZC_ARRAY_COPY_DECL, ZC_HOP_DECL } from "./issue-decls.js";
import { detectUnionDiscriminator } from "./schemas/discriminated-union.js";
import { parsedProperties } from "./schemas/object.js";
import { needsPostInnerDefault } from "./schemas/default.js";

interface RunGen {
  readonly ctx: CodeGenContext;
  readonly fail: string;
  /** Nodes the validator's build rebuilds (its own `rebuildSet`). */
  readonly rebuilds: ReadonlySet<SchemaIR>;
  /** `var`s the hosted function declares. */
  readonly temps: string[];
  /**
   * Planning only: decide whether a copy is needed and possible, emitting
   * nothing. Helper declarations and pooled constants cannot be taken back
   * once the file pipeline has seen them.
   */
  readonly dry: boolean;
}

/**
 * What answers zod's `_zod.run` for a schema whose validator may (see
 * zodRunSupport): a value-or-FAIL function and its FAIL sentinel, `"validator"`
 * when the validator's own result already is zod's shape, or null when no
 * copy can make it so.
 *
 * `build` is the validator's build function, when it has one. Otherwise the
 * validator checks the input in place (`predicate`, its exact fast check) and
 * returns it.
 */
export function zodRunAnswer(
  ir: SchemaIR,
  ctx: CodeGenContext,
  build: string | null,
  predicate: string | null,
): { build: string; fail: string } | "validator" | null {
  const rebuilds = rebuildSet(ir);
  const make = (g: RunGen, value: string): string | null =>
    build !== null ? freshen(ir, value, "input", g) : copy(ir, value, g);
  const planned = make({ ctx, fail: "", rebuilds, temps: [], dry: true }, "v");
  if (planned === null) return null;
  if (planned === "") {
    return build === null ? "validator" : { build, fail: emitFailSentinel(ctx) };
  }
  if (build === null && predicate === null) return null;

  const g: RunGen = { ctx, fail: emitFailSentinel(ctx), rebuilds, temps: [], dry: false };
  const v = local(g, "zr");
  const code = make(g, v) as string;
  const head =
    build !== null
      ? `${v}=${build}(input);if(${v}===${g.fail})return ${g.fail};`
      : `if(!${predicate}(input))return ${g.fail};${v}=input;`;
  const name = emitTemp(ctx, "vz");
  ctx.preamble.push(`function ${name}(input){var ${g.temps.join(",")};${head}${code}return ${v};}`);
  return { build: name, fail: g.fail };
}

function local(g: RunGen, prefix: string): string {
  const name = g.dry ? `__${prefix}` : emitTemp(g.ctx, prefix);
  g.temps.push(name);
  return name;
}

function helper(g: RunGen, name: string, decl: string): string {
  return g.dry ? name : emitRuntimeHelper(g.ctx, name, decl);
}

function membership(g: RunGen, keys: readonly string[], keyVar: string): string {
  return g.dry ? "false" : keyMembershipTest(g.ctx, keys, keyVar);
}

type ContainerType = "object" | "array" | "tuple" | "record" | "set" | "map";

function isContainer(ir: SchemaIR): ir is Extract<SchemaIR, { type: ContainerType }> {
  switch (ir.type) {
    case "object":
    case "array":
    case "tuple":
    case "record":
    case "set":
    case "map":
      return true;
    default:
      return false;
  }
}

/**
 * Can this subtree's value hold a container zod builds? A leaf that passes a
 * reference through (`z.any()`, `z.custom()`, a `Date`) does not count: zod
 * passes the same reference. A recursive member does, since its target is not
 * visible from here.
 */
function holdsContainer(root: SchemaIR): boolean {
  const seen = new Set<SchemaIR>();
  const walk = (node: SchemaIR): boolean => {
    if (seen.has(node)) return false;
    seen.add(node);
    if (isContainer(node) || node.type === "recursiveRef") return true;
    return children(node).some(walk);
  };
  return walk(root);
}

/** Did the validator's build hand this node's input back rather than build it? */
function passedThrough(node: SchemaIR, g: RunGen): boolean {
  return !g.rebuilds.has(node) || passesThroughWithScrub(node, g.rebuilds);
}

/**
 * Does the build's output for this subtree hold anything zod's would not: a
 * container it returned by reference, or a record, whose symbol keys it did
 * not look at? A container the build built is zod's shape already.
 */
function needsWork(root: SchemaIR, g: RunGen): boolean {
  const seen = new Set<SchemaIR>();
  const walk = (node: SchemaIR): boolean => {
    if (seen.has(node)) return false;
    seen.add(node);
    if (node.type === "recursiveRef" || node.type === "record") return true;
    if (isContainer(node) && passedThrough(node, g)) return true;
    return children(node).some(walk);
  };
  return walk(root);
}

/**
 * Statements that make the member at `slot` (an assignable expression into the
 * build's own output) zod's. A member returned by reference whose copy is one
 * call is replaced in place. Anything else goes through a local.
 */
function freshenMember(node: SchemaIR, slot: string, input: string, g: RunGen): string | null {
  if (passedThrough(node, g)) {
    const expr = copyExpr(node, slot, g);
    if (expr !== null) return `${slot}=${expr};`;
  }
  const v = local(g, "zv");
  const inner = freshen(node, v, input, g);
  if (inner === null) return null;
  return `${v}=${slot};${inner}${slot}=${v};`;
}

/**
 * zod's copy of `value` as one expression, where a container of members it
 * hands back as they are needs no more than that, or null.
 */
function copyExpr(node: SchemaIR, value: string, g: RunGen): string | null {
  switch (node.type) {
    case "array":
      return holdsContainer(node.element)
        ? null
        : `${helper(g, "__zcAc", ZC_ARRAY_COPY_DECL)}(${value})`;
    case "tuple":
      return node.items.some(holdsContainer) || (node.rest !== null && holdsContainer(node.rest))
        ? null
        : `${helper(g, "__zcAc", ZC_ARRAY_COPY_DECL)}(${value})`;
    case "set":
      return holdsContainer(node.valueType) ? null : `new Set(${value})`;
    case "map":
      return holdsContainer(node.keyType) || holdsContainer(node.valueType)
        ? null
        : `new Map(${value})`;
    case "zodDelegate":
      return copyExpr(node.inner, value, g);
    default:
      return null;
  }
}

/**
 * Statements that turn `value` (a local holding the build's output for
 * `node`, parsed from `input`) into zod's output. The output's own containers
 * are the build's and are edited in place. Each one it returned by reference
 * is replaced with a copy. Returns "" when there is nothing to do, and null
 * when the output cannot be made exact.
 */
function freshen(node: SchemaIR, value: string, input: string, g: RunGen): string | null {
  if (!needsWork(node, g)) return "";
  if (passedThrough(node, g)) return copy(node, value, g);
  switch (node.type) {
    case "object": {
      let code = "";
      for (const [key, prop] of parsedProperties(node)) {
        if (!needsWork(prop, g)) continue;
        const keyStr = escapeString(key);
        const edit = freshenMember(prop, `${value}[${keyStr}]`, `${input}[${keyStr}]`, g);
        if (edit === null) return null;
        // A key the output may lack is tested as an OWN key: the output is a
        // plain object, so a read would also find what it inherits
        // (`toString`, `constructor`), and the write-back would add the key.
        code += outputAlwaysDefined(prop)
          ? edit
          : `if(${helper(g, "__zcHop", ZC_HOP_DECL)}.call(${value},${keyStr})){${edit}}`;
      }
      return code;
    }
    case "array": {
      if (!needsWork(node.element, g)) return "";
      const i = local(g, "zi");
      const edit = freshenMember(node.element, `${value}[${i}]`, `${input}[${i}]`, g);
      if (edit === null) return null;
      return `for(${i}=0;${i}<${value}.length;${i}++){${edit}}`;
    }
    case "tuple": {
      // The build pass rebuilds only a fixed-length tuple (see buildTuple).
      if (node.rest !== null) return null;
      let code = "";
      for (const [index, item] of node.items.entries()) {
        if (!needsWork(item, g)) continue;
        const edit = freshenMember(item, `${value}[${index}]`, `${input}[${index}]`, g);
        if (edit === null) return null;
        code += edit;
      }
      return code;
    }
    case "record": {
      if (!plainRecord(node)) return null;
      if (!needsWork(node.valueType, g)) return symbolGuard(input, g);
      const hop = helper(g, "__zcHop", ZC_HOP_DECL);
      const k = local(g, "zk");
      const edit = freshenMember(node.valueType, `${value}[${k}]`, `${input}[${k}]`, g);
      if (edit === null) return null;
      return (
        symbolGuard(input, g) + `for(${k} in ${value}){if(${hop}.call(${value},${k})){${edit}}}`
      );
    }
    case "optional": {
      const inner = freshen(node.inner, value, input, g);
      return inner === null || inner === "" ? inner : `if(${value}!==undefined){${inner}}`;
    }
    case "nullable": {
      const inner = freshen(node.inner, value, input, g);
      return inner === null || inner === "" ? inner : `if(${value}!==null){${inner}}`;
    }
    case "default": {
      // The output is the default value when the input was undefined, which
      // zod returns as is. Zod also substitutes it for an inner that made
      // `undefined` of a defined input, and nothing here could tell that
      // output from a parsed one.
      if (needsPostInnerDefault(node)) return null;
      const inner = freshen(node.inner, value, input, g);
      return inner === null || inner === "" ? inner : `if(${input}!==undefined){${inner}}`;
    }
    case "zodDelegate":
      return freshen(node.inner, value, input, g);
    case "readonly": {
      if (node.freeze !== true) return freshen(node.inner, value, input, g);
      // The output is frozen, so the copy is made on an unfrozen one and frozen
      // in turn, as zod freezes the value it built. A pass-through inner is
      // the input itself, frozen as a `slice()` (see ReadonlyIR.copy), which
      // keeps a sparse array's holes where zod's copy has `undefined`.
      const t = local(g, "zt");
      if (passedThrough(node.inner, g)) {
        const inner = copy(node.inner, t, g);
        if (inner === null || inner === "") return inner;
        return `${t}=${input};${inner}${value}=Object.freeze(${t});`;
      }
      const inner = freshen(node.inner, t, input, g);
      if (inner === null || inner === "") return inner;
      const shallow =
        node.inner.type === "object"
          ? `{...${value}}`
          : node.inner.type === "array" || node.inner.type === "tuple"
            ? `${helper(g, "__zcAc", ZC_ARRAY_COPY_DECL)}(${value})`
            : null;
      return shallow === null ? null : `${t}=${shallow};${inner}${value}=Object.freeze(${t});`;
    }
    case "effect":
      if (node.effectKind === "transform") {
        // The callback's result is the output, as it is zod's. It ran on the
        // inner's fresh output (see the `fresh` flag), but a record in there
        // ignored symbol keys that zod would have rejected before the callback
        // ever ran, and there is no undoing a callback.
        return null;
      }
      // A preprocess result is the inner's input, which is not in hand here.
      // It is only needed where the inner rebuilt.
      return passedThrough(node.inner, g) ? copy(node.inner, value, g) : null;
    case "union": {
      const discriminated = detectUnionDiscriminator(node.options, 2);
      if (discriminated === null) return null;
      return dispatch(
        discriminated.discriminator,
        discriminated.cases,
        node.options,
        input,
        (option) => freshen(option, value, input, g),
      );
    }
    case "discriminatedUnion":
      return dispatch(node.discriminator, node.cases, node.options, input, (option) =>
        freshen(option, value, input, g),
      );
    default:
      // A frozen `.readonly()` cannot be edited in place, and a pipe's `out`
      // parsed a value that is not in hand. A rebuilding set, map or
      // intersection never reaches a successful build.
      return null;
  }
}

/**
 * Statements that replace `value` (a local holding an input the validator
 * accepted and returned as it is) with zod's output for `node`, a new
 * container wherever zod builds one. Returns "" when the value holds none,
 * and null when the copy cannot be made exact.
 *
 * A node handed back as it is rewrites nothing, so zod's output is the input's
 * structure rebuilt: no strip object, default, transform or coercion can be in
 * here, since each of those puts its node in the rebuild set.
 */
function copy(node: SchemaIR, value: string, g: RunGen): string | null {
  if (!holdsContainer(node)) return "";
  const expr = copyExpr(node, value, g);
  if (expr !== null) return `${value}=${expr};`;
  switch (node.type) {
    case "array": {
      // An array of plain members was copied above (copyExpr).
      const ac = helper(g, "__zcAc", ZC_ARRAY_COPY_DECL);
      const e = local(g, "ze");
      const i = local(g, "zi");
      const inner = copy(node.element, e, g);
      if (inner === null) return null;
      return `${value}=${ac}(${value});for(${i}=0;${i}<${value}.length;${i}++){${e}=${value}[${i}];${inner}${value}[${i}]=${e};}`;
    }
    case "tuple": {
      // Handed back as it is, so no absent slot was filled in: zod's output has
      // the input's length, one slot per element.
      const ac = helper(g, "__zcAc", ZC_ARRAY_COPY_DECL);
      let code = `${value}=${ac}(${value});`;
      for (const [index, item] of node.items.entries()) {
        const e = local(g, "ze");
        const inner = copy(item, e, g);
        if (inner === null) return null;
        if (inner !== "") {
          code += `if(${index}<${value}.length){${e}=${value}[${index}];${inner}${value}[${index}]=${e};}`;
        }
      }
      if (node.rest !== null) {
        const e = local(g, "ze");
        const i = local(g, "zi");
        const inner = copy(node.rest, e, g);
        if (inner === null) return null;
        if (inner !== "") {
          code += `for(${i}=${node.items.length};${i}<${value}.length;${i}++){${e}=${value}[${i}];${inner}${value}[${i}]=${e};}`;
        }
      }
      return code;
    }
    case "object": {
      // zod's output for an object: the shape keys in shape order, each where
      // zod's presence rule keeps it, then a loose or catchall object's other
      // keys in the input's for-in order, inherited ones included and
      // `__proto__` skipped. (A stripping object always rebuilds.)
      if (node.stripUnknownKeys === true) return null;
      let code = "";
      const slots: OutputSlot[] = [];
      for (const [key, prop] of parsedProperties(node)) {
        const keyStr = escapeString(key);
        const always = outputAlwaysDefined(prop);
        // A member with nothing to copy, or a copy that is one call, is read
        // where the literal needs it. One the presence test reads too keeps a
        // local, so it is read once.
        if (always) {
          const read = `${value}[${keyStr}]`;
          const member = holdsContainer(prop) ? copyExpr(prop, read, g) : read;
          if (member !== null) {
            slots.push({ always, keyStr, value: member });
            continue;
          }
        }
        const v = local(g, "zp");
        const inner = copy(prop, v, g);
        if (inner === null) return null;
        code += `${v}=${value}[${keyStr}];${inner}`;
        slots.push({ always, keyStr, value: v });
      }
      const out = local(g, "zo");
      code += assembleObject(slots, out, value);
      if (node.strict !== true) {
        const k = local(g, "zk");
        const test = membership(g, Object.keys(node.properties), k);
        if (node.catchall === undefined) {
          code += `for(${k} in ${value}){if(!(${test})&&${k}!=="__proto__"){${out}[${k}]=${value}[${k}];}}`;
        } else {
          const v = local(g, "zcv");
          const inner = copy(node.catchall, v, g);
          if (inner === null) return null;
          code += `for(${k} in ${value}){if(!(${test})&&${k}!=="__proto__"){${v}=${value}[${k}];${inner}${out}[${k}]=${v};}}`;
        }
      }
      return `${code}${value}=${out};`;
    }
    case "record": {
      if (!plainRecord(node)) return null;
      const hop = helper(g, "__zcHop", ZC_HOP_DECL);
      const out = local(g, "zo");
      const k = local(g, "zk");
      const v = local(g, "zv");
      const inner = copy(node.valueType, v, g);
      if (inner === null) return null;
      return (
        symbolGuard(value, g) +
        `${out}={};for(${k} in ${value}){if(${k}!=="__proto__"&&${hop}.call(${value},${k})){${v}=${value}[${k}];${inner}${out}[${k}]=${v};}}${value}=${out};`
      );
    }
    case "set": {
      const out = local(g, "zo");
      const e = local(g, "ze");
      const inner = copy(node.valueType, e, g);
      if (inner === null) return null;
      return `${out}=new Set();for(${e} of ${value}){${inner}${out}.add(${e});}${value}=${out};`;
    }
    case "map": {
      const out = local(g, "zo");
      const entry = local(g, "zen");
      const k = local(g, "zk");
      const v = local(g, "zv");
      const keyCode = copy(node.keyType, k, g);
      const valueCode = copy(node.valueType, v, g);
      if (keyCode === null || valueCode === null) return null;
      return `${out}=new Map();for(${entry} of ${value}){${k}=${entry}[0];${v}=${entry}[1];${keyCode}${valueCode}${out}.set(${k},${v});}${value}=${out};`;
    }
    case "optional": {
      const inner = copy(node.inner, value, g);
      return inner === null || inner === "" ? inner : `if(${value}!==undefined){${inner}}`;
    }
    case "nullable": {
      const inner = copy(node.inner, value, g);
      return inner === null || inner === "" ? inner : `if(${value}!==null){${inner}}`;
    }
    case "zodDelegate":
      return copy(node.inner, value, g);
    case "pipe": {
      // `out` parses `in`'s output: zod builds `in`'s containers, then `out`'s
      // from those.
      const first = copy(node.in, value, g);
      const second = copy(node.out, value, g);
      return first === null || second === null ? null : first + second;
    }
    case "union": {
      const discriminated = detectUnionDiscriminator(node.options, 2);
      if (discriminated === null) return null;
      return dispatch(
        discriminated.discriminator,
        discriminated.cases,
        node.options,
        value,
        (option) => copy(option, value, g),
      );
    }
    case "discriminatedUnion":
      return dispatch(node.discriminator, node.cases, node.options, value, (option) =>
        copy(option, value, g),
      );
    default:
      // A readonly, intersection, recursive or delegated member: none of these
      // hands its input back while holding a container zod builds.
      return null;
  }
}

/**
 * `switch` on the discriminator of `input`, running `each` for the option it
 * selects. Exact for a value the schema accepted: at most one option accepts
 * any input, so the option the discriminator names is the one zod's union
 * ran.
 */
function dispatch(
  discriminator: string,
  cases: DiscriminatedUnionIR["cases"],
  options: readonly SchemaIR[],
  input: string,
  each: (option: SchemaIR) => string | null,
): string | null {
  // One arm per option: a multi-value literal labels it once per value.
  const labels = new Map<number, string>();
  for (const { value, option } of cases) {
    labels.set(option, `${labels.get(option) ?? ""}case ${literalToJs(value)}:`);
  }
  let arms = "";
  for (const [option, label] of labels) {
    const ir = options[option];
    if (ir === undefined) return null;
    const code = each(ir);
    if (code === null) return null;
    if (code !== "") arms += `${label}${code}break;`;
  }
  return arms === "" ? "" : `switch(${input}[${escapeString(discriminator)}]){${arms}}`;
}

/**
 * A record whose output zod builds in the input's own key order: a plain
 * string key schema, which accepts every string key it is handed. A key set
 * declared up front is walked in its declared order instead, and a coercing
 * key schema rewrites the keys.
 */
function plainRecord(node: SchemaIR & { type: "record" }): boolean {
  return (
    node.enumerableKeys !== true && node.keyType.type === "string" && node.keyType.coerce !== true
  );
}

/**
 * Leave a record with an own symbol key to zod. Zod's walk runs the key schema
 * on it and a string key schema rejects it, while the compiled walks skip it
 * (the documented record difference).
 */
function symbolGuard(input: string, g: RunGen): string {
  return `if(Object.getOwnPropertySymbols(${input}).length!==0)return ${g.fail};`;
}
