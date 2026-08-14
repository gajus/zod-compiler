const { UserSchema } = require("./cjs-schema.cjs");

const before = typeof Object.getOwnPropertyDescriptor(UserSchema, "safeParse")?.get;
UserSchema.safeParse({ name: "Arthur" });
const after = Object.getOwnPropertyDescriptor(UserSchema, "safeParse")?.value?.name;
process.stdout.write(JSON.stringify({ after, before }));
