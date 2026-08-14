const { z } = require("zod");

module.exports.UserSchema = z.object({ name: z.string().min(1) });
