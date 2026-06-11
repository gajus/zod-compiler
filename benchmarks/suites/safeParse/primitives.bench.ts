import { bench, describe } from "vitest";
import {
  ajvNumberWithChecks,
  ajvSimpleEnum,
  ajvSimpleString,
  ajvStringWithChecks,
  aotBigInt,
  aotEnum,
  aotNumberChecks,
  aotSimpleString,
  aotStringChecks,
  BigIntSchema,
  NumberWithChecks,
  SimpleEnum,
  SimpleString,
  StringWithChecks,
  typiaValidateNumberWithChecks,
  typiaValidateSimpleEnum,
  typiaValidateSimpleString,
  typiaValidateStringWithChecks,
  v3BigIntSchema,
  v3NumberWithChecks,
  v3SimpleEnum,
  v3SimpleString,
  v3StringWithChecks,
  validBigInt,
  validNumberWithChecks,
  validSimpleEnum,
  validSimpleString,
  validStringWithChecks,
} from "../../fixtures/schemas/index.js";

describe("safeParse: simple string", () => {
  bench("zod", () => {
    SimpleString.safeParse(validSimpleString);
  });
  bench("zod v3", () => {
    v3SimpleString.safeParse(validSimpleString);
  });
  bench("zod-compiler", () => {
    aotSimpleString.safeParse(validSimpleString);
  });
  bench("typia", () => {
    typiaValidateSimpleString(validSimpleString);
  });
  bench("ajv", () => {
    ajvSimpleString(validSimpleString);
  });
});

describe("safeParse: string with checks (min/max)", () => {
  bench("zod", () => {
    StringWithChecks.safeParse(validStringWithChecks);
  });
  bench("zod v3", () => {
    v3StringWithChecks.safeParse(validStringWithChecks);
  });
  bench("zod-compiler", () => {
    aotStringChecks.safeParse(validStringWithChecks);
  });
  bench("typia", () => {
    typiaValidateStringWithChecks(validStringWithChecks);
  });
  bench("ajv", () => {
    ajvStringWithChecks(validStringWithChecks);
  });
});

describe("safeParse: number with checks (int + positive)", () => {
  bench("zod", () => {
    NumberWithChecks.safeParse(validNumberWithChecks);
  });
  bench("zod v3", () => {
    v3NumberWithChecks.safeParse(validNumberWithChecks);
  });
  bench("zod-compiler", () => {
    aotNumberChecks.safeParse(validNumberWithChecks);
  });
  bench("typia", () => {
    typiaValidateNumberWithChecks(validNumberWithChecks);
  });
  bench("ajv", () => {
    ajvNumberWithChecks(validNumberWithChecks);
  });
});

describe("safeParse: enum", () => {
  bench("zod", () => {
    SimpleEnum.safeParse(validSimpleEnum);
  });
  bench("zod v3", () => {
    v3SimpleEnum.safeParse(validSimpleEnum);
  });
  bench("zod-compiler", () => {
    aotEnum.safeParse(validSimpleEnum);
  });
  bench("typia", () => {
    typiaValidateSimpleEnum(validSimpleEnum);
  });
  bench("ajv", () => {
    ajvSimpleEnum(validSimpleEnum);
  });
});

describe("safeParse: bigint with checks (min/max)", () => {
  bench("zod", () => {
    BigIntSchema.safeParse(validBigInt);
  });
  bench("zod v3", () => {
    v3BigIntSchema.safeParse(validBigInt);
  });
  bench("zod-compiler", () => {
    aotBigInt.safeParse(validBigInt);
  });
  // typia: tags (Minimum/Maximum) don't target bigint
  // ajv: no bigint support in JSON Schema
});
