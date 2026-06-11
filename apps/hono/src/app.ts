import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import {
  ApiHeaderSchema,
  CreateUserSchema,
  ListUsersQuerySchema,
  UserParamSchema,
} from "./schemas.js";

export const app = new Hono();

// ============================================================
// Zod native routes (baseline)
// ============================================================

app.post("/zod/users", zValidator("json", CreateUserSchema), (c) => {
  const data = c.req.valid("json");
  return c.json({ validator: "zod", data });
});

app.get("/zod/users", zValidator("query", ListUsersQuerySchema), (c) => {
  const query = c.req.valid("query");
  return c.json({ validator: "zod", query });
});

app.get("/zod/users/:id", zValidator("param", UserParamSchema), (c) => {
  const param = c.req.valid("param");
  return c.json({ validator: "zod", param });
});

app.get("/zod/protected", zValidator("header", ApiHeaderSchema), (c) => {
  return c.json({ validator: "zod", ok: true });
});

// ============================================================
// zod-compiler compiled routes (zodCompat=true)
// compile() returns T & CompiledSchema<output<T>>, so it's
// directly usable with @hono/zod-validator without casting.
// ============================================================

app.post("/aot/users", zValidator("json", CreateUserSchema), (c) => {
  const data = c.req.valid("json");
  return c.json({ validator: "zod-compiler", data });
});

app.get("/aot/users", zValidator("query", ListUsersQuerySchema), (c) => {
  const query = c.req.valid("query");
  return c.json({ validator: "zod-compiler", query });
});

app.get("/aot/users/:id", zValidator("param", UserParamSchema), (c) => {
  const param = c.req.valid("param");
  return c.json({ validator: "zod-compiler", param });
});

app.get("/aot/protected", zValidator("header", ApiHeaderSchema), (c) => {
  return c.json({ validator: "zod-compiler", ok: true });
});

export default app;
