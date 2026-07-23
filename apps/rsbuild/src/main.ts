import { strict as assert } from "node:assert";
import { UserSchema } from "./schemas.js";

assert.equal(UserSchema.safeParse({ name: "Nestor", email: "nestor@example.com" }).success, true);
assert.equal(UserSchema.safeParse({ name: "", email: "invalid" }).success, false);

// oxlint-disable-next-line no-console -- integration fixture output
console.log("Rsbuild integration passed.");
