/**
 * The zod version guard (src/core/extract/zod-version.ts): compiled output
 * reproduces zod 4.5's semantics, so a schema built by an older zod is refused
 * at the root of extraction — loudly, since a lenient package manager installs
 * this release next to zod 4.3 with nothing but a peer-range warning — and
 * `jit()` leaves such a schema as plain Zod after warning once per process.
 *
 * The version is read off the schema instance (`_zod.version`), so a fake
 * shaped like a zod schema is enough to drive every branch without a second
 * zod installation.
 */
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { core, z } from "zod";
import { extractSchema } from "#src/core/extract/index.js";
import {
  assertSupportedZod,
  isSupportedZodVersion,
  isUnsupportedZodVersionError,
  MIN_ZOD_VERSION,
  UNSUPPORTED_ZOD_VERSION_ERROR,
  unsupportedZodVersionMessage,
  zodVersionOf,
} from "#src/core/extract/zod-version.js";
import { isZodSchema } from "#src/is-zod-schema.js";
import { jit, jitAll } from "#src/jit.js";

interface Version {
  major: number;
  minor: number;
  patch: number;
}

/**
 * The least a value needs to be taken for a zod schema (`_zod.def`, see
 * isZodSchema) plus the version stamp under test. `safeParse` is an own data
 * property so the test can tell whether `jit()` fronted it with an accessor.
 */
function fakeSchema(version?: Version): Record<string, unknown> {
  return {
    _zod: { def: { type: "string", checks: [] }, ...(version === undefined ? {} : { version }) },
    safeParse: () => ({ success: true, data: "plain zod" }),
  };
}

describe("zod version guard: detection", () => {
  it("reads the version zod stamps on every schema instance", () => {
    expect(zodVersionOf(z.string())).toEqual(core.version);
    expect(isSupportedZodVersion(zodVersionOf(z.object({ a: z.number() })))).toBe(true);
  });

  it("accepts the minimum minor and anything later in the same major", () => {
    expect(isSupportedZodVersion({ ...MIN_ZOD_VERSION, patch: 0 })).toBe(true);
    expect(isSupportedZodVersion({ major: 4, minor: MIN_ZOD_VERSION.minor + 1, patch: 0 })).toBe(
      true,
    );
  });

  it("refuses an older minor, another major, a malformed stamp and a missing one", () => {
    expect(isSupportedZodVersion({ major: 4, minor: 3, patch: 6 })).toBe(false);
    expect(isSupportedZodVersion({ major: 4, minor: 4, patch: 3 })).toBe(false);
    expect(isSupportedZodVersion({ major: 5, minor: 0, patch: 0 })).toBe(false);
    expect(isSupportedZodVersion({ major: 3, minor: 25, patch: 76 })).toBe(false);
    expect(isSupportedZodVersion(undefined)).toBe(false);
    expect(zodVersionOf(fakeSchema())).toBeUndefined();
    expect(zodVersionOf({ _zod: { version: { major: "4", minor: 5, patch: 2 } } })).toBeUndefined();
    expect(zodVersionOf(null)).toBeUndefined();
    expect(
      zodVersionOf(
        new Proxy(
          {},
          {
            get: () => {
              throw new Error("trap");
            },
          },
        ),
      ),
    ).toBeUndefined();
  });

  it("explains what was found, what is required, why, and both remedies", () => {
    const message = unsupportedZodVersionMessage({ major: 4, minor: 3, patch: 6 });
    expect(message).toContain("zod 4.3.6");
    expect(message).toContain("^4.5.0");
    expect(message).toContain('expected: "nonoptional"');
    expect(message).toContain("Upgrade zod to 4.5 or later");
    expect(message).toContain("zod-compiler 1.x");
    expect(unsupportedZodVersionMessage(undefined)).toContain("carries no _zod.version");
  });
});

describe("zod version guard: extraction", () => {
  it("lets a schema from the installed zod through", () => {
    expect(() => assertSupportedZod(z.string())).not.toThrow();
    expect(extractSchema(z.object({ a: z.string().optional() }))).toMatchObject({ type: "object" });
  });

  it("throws a recognisable error for an older zod before anything is extracted", () => {
    const fake = fakeSchema({ major: 4, minor: 3, patch: 6 });
    expect(isZodSchema(fake)).toBe(true);
    let caught: unknown;
    try {
      extractSchema(fake);
    } catch (e) {
      caught = e;
    }
    expect(isUnsupportedZodVersionError(caught)).toBe(true);
    expect((caught as Error).name).toBe(UNSUPPORTED_ZOD_VERSION_ERROR);
    expect((caught as Error).message).toContain("zod 4.3.6");
  });

  it("treats a schema with no version stamp as unsupported", () => {
    expect(() => extractSchema(fakeSchema())).toThrow(/carries no _zod\.version/);
  });

  it("does not mistake a value that is no schema at all for a version problem", () => {
    // `null` and `{}` still fail extraction, the way they always have — as a
    // TypeError from reading `_zod.def`, reported per export by the plugin and
    // the CLI — rather than as the once-per-process version refusal.
    for (const value of [null, {}, { _zod: {} }]) {
      expect(() => assertSupportedZod(value)).not.toThrow();
      let caught: unknown;
      try {
        extractSchema(value);
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(Error);
      expect(isUnsupportedZodVersionError(caught)).toBe(false);
    }
  });

  it("recognises the error by name, not by identity", () => {
    const lookalike = new Error("same name, different module copy");
    lookalike.name = UNSUPPORTED_ZOD_VERSION_ERROR;
    expect(isUnsupportedZodVersionError(lookalike)).toBe(true);
    expect(isUnsupportedZodVersionError(new Error("anything else"))).toBe(false);
    expect(isUnsupportedZodVersionError("not an error")).toBe(false);
  });
});

describe("zod version guard: jit()", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("warns once per process and leaves every unsupported schema exactly as it was", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const eager = fakeSchema({ major: 4, minor: 3, patch: 6 });
    const lazy = fakeSchema({ major: 4, minor: 3, patch: 6 });
    const stampless = fakeSchema();
    const originals = [eager, lazy, stampless].map((s) => s["safeParse"]);

    expect(jit(eager as unknown as z.ZodType, { eager: true })).toBe(eager);
    expect(jit(lazy as unknown as z.ZodType)).toBe(lazy);
    jitAll({ stampless });

    // One message for the 4.3.6 schemas; the stampless one differs in wording,
    // so it is the second and last line. Neither repeats.
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn.mock.calls[0]?.[0]).toMatch(
      /^\[zod-compiler\] Unsupported zod version: .*zod 4\.3\.6/,
    );
    expect(warn.mock.calls[1]?.[0]).toMatch(
      /^\[zod-compiler\] Unsupported zod version: .*no _zod\.version/,
    );

    // Nothing installed: `safeParse` is still the schema's own data property
    // (not a compile-on-read accessor), and no compiled `is` or `parse` appeared.
    for (const [index, schema] of [eager, lazy, stampless].entries()) {
      const descriptor = Object.getOwnPropertyDescriptor(schema, "safeParse");
      expect(descriptor !== undefined && "get" in descriptor).toBe(false);
      expect(descriptor?.value).toBe(originals[index]);
      expect(Object.getOwnPropertyDescriptor(schema, "parse")).toBeUndefined();
      expect(Object.getOwnPropertyDescriptor(schema, "is")).toBeUndefined();
      expect(Object.getOwnPropertyDescriptor(schema, "~standard")).toBeUndefined();
    }

    // A second round says nothing new.
    jit(fakeSchema({ major: 4, minor: 3, patch: 6 }) as unknown as z.ZodType, { eager: true });
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it("still compiles a schema from the installed zod", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const schema = jit(z.object({ a: z.string() }), { eager: true });
    expect(schema.safeParse({ a: "x", extra: 1 })).toEqual({ success: true, data: { a: "x" } });
    expect(schema.is({ a: 1 })).toBe(false);
    expect(warn).not.toHaveBeenCalled();
  });
});
