import type { ZodCompilerPluginOptions } from "../unplugin/types.js";

type RegisterOutput = Extract<ZodCompilerPluginOptions["output"], "schema" | "compact">;
type SharedRegisterOptions = Pick<
  ZodCompilerPluginOptions,
  "include" | "exclude" | "schemas" | "hoist"
>;

/** Configuration loaded by `zod-compiler/register` from the current working directory. */
export interface ZodCompilerRegisterConfig extends SharedRegisterOptions {
  /** JSON Schema used by editors. @default "./node_modules/zod-compiler/schema.json" */
  $schema?: string | undefined;
  /** Compile immediately instead of when a validation method is first read. @default false */
  eager?: boolean | undefined;
  /**
   * Preserve the complete compiled validator, or delegate cold error production
   * to the retained Zod schema in compact mode.
   * @default "schema"
   */
  output?: RegisterOutput | undefined;
}
