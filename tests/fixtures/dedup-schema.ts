import { z } from "zod";
import { compile } from "zod-compiler";

// A shared nested shape reused across two exported schemas — the dedup pass
// should hoist its slow walk into one shared __zcSw_N function.
const AddressSchema = z.object({
  street: z.string().min(1),
  city: z.string().min(1),
  zip: z.string().min(3),
});

const UserSchema = z.object({
  name: z.string(),
  home: AddressSchema,
  work: AddressSchema,
});

const CompanySchema = z.object({
  legalName: z.string(),
  hq: AddressSchema,
});

export const validateUser = compile(UserSchema);
export const validateCompany = compile(CompanySchema);
