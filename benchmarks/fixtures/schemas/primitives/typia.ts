import typia, { type tags } from "typia";

type SimpleString = string;
type StringWithChecks = string & tags.MinLength<3> & tags.MaxLength<50>;
type NumberWithChecks = number & tags.Type<"int32"> & tags.ExclusiveMinimum<0>;
type SimpleEnum = "admin" | "user" | "guest" | "moderator";

// ─── createValidate (with errors) ───────────────────────────────────────────

export const typiaValidateSimpleString = typia.createValidate<SimpleString>();
export const typiaValidateStringWithChecks = typia.createValidate<StringWithChecks>();
export const typiaValidateNumberWithChecks = typia.createValidate<NumberWithChecks>();
export const typiaValidateSimpleEnum = typia.createValidate<SimpleEnum>();
