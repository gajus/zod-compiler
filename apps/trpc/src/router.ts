import { initTRPC } from "@trpc/server";
import { CreateUserSchema, ListUsersSchema, UpdateUserSchema, UserIdSchema } from "./schemas.js";

const t = initTRPC.create();

// ============================================================
// In-memory store
// ============================================================

interface User {
  id: string;
  name: string;
  email: string;
  age: number;
  role: "admin" | "editor" | "viewer";
}

let nextId = 1;
const users = new Map<string, User>();

function resetStore() {
  nextId = 1;
  users.clear();
}

function createUser(input: Omit<User, "id">): User {
  const id = String(nextId++);
  const user: User = { id, ...input };
  users.set(id, user);
  return user;
}

function listUsers(opts: { page: number; limit: number; role?: string | undefined }) {
  let result = [...users.values()];
  if (opts.role) {
    result = result.filter((u) => u.role === opts.role);
  }
  const start = (opts.page - 1) * opts.limit;
  return {
    users: result.slice(start, start + opts.limit),
    total: result.length,
    page: opts.page,
    limit: opts.limit,
  };
}

// ============================================================
// tRPC router — plain Zod schemas, compiled by autoDiscover.
// No compile() import needed. The vite plugin detects and compiles
// exported Zod schemas automatically.
// ============================================================

export const appRouter = t.router({
  create: t.procedure.input(CreateUserSchema).mutation(({ input }) => {
    return createUser(input);
  }),

  list: t.procedure.input(ListUsersSchema).query(({ input }) => {
    return listUsers(input);
  }),

  getById: t.procedure.input(UserIdSchema).query(({ input }) => {
    return users.get(input.id) ?? null;
  }),

  update: t.procedure.input(UpdateUserSchema.and(UserIdSchema)).mutation(({ input }) => {
    const { id, ...data } = input;
    const user = users.get(id);
    if (!user) return null;
    Object.assign(user, data);
    return user;
  }),

  delete: t.procedure.input(UserIdSchema).mutation(({ input }) => {
    return users.delete(input.id);
  }),
});

export type AppRouter = typeof appRouter;

export const createCaller = t.createCallerFactory(appRouter);

export { resetStore };
