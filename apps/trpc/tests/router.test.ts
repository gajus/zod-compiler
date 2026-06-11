import { TRPCError } from "@trpc/server";
import { beforeEach, describe, expect, it } from "vitest";
import { createCaller, resetStore } from "../src/router.js";
import {
  CreateUserSchema,
  ListUsersSchema,
  UpdateUserSchema,
  UserIdSchema,
} from "../src/schemas.js";

const caller = createCaller({});

const validUser = {
  name: "Alice",
  email: "alice@example.com",
  age: 30,
  role: "admin" as const,
};

beforeEach(() => {
  resetStore();
});

// ============================================================
// Create
// ============================================================

describe("create", () => {
  it("creates a user with valid input", async () => {
    const user = await caller.create(validUser);
    expect(user).toEqual({ id: "1", ...validUser });
  });

  it("rejects empty name", async () => {
    await expect(caller.create({ ...validUser, name: "" })).rejects.toThrow(TRPCError);
  });

  it("rejects invalid email", async () => {
    await expect(caller.create({ ...validUser, email: "bad" })).rejects.toThrow(TRPCError);
  });

  it("rejects invalid role", async () => {
    await expect(caller.create({ ...validUser, role: "superadmin" as "admin" })).rejects.toThrow(
      TRPCError,
    );
  });

  it("rejects negative age", async () => {
    await expect(caller.create({ ...validUser, age: -1 })).rejects.toThrow(TRPCError);
  });

  it("rejects non-integer age", async () => {
    await expect(caller.create({ ...validUser, age: 3.14 })).rejects.toThrow(TRPCError);
  });
});

// ============================================================
// List
// ============================================================

describe("list", () => {
  it("returns empty list initially", async () => {
    const result = await caller.list({});
    expect(result.users).toEqual([]);
    expect(result.total).toBe(0);
  });

  it("returns created users", async () => {
    await caller.create(validUser);
    const result = await caller.list({});
    expect(result.users).toHaveLength(1);
    expect(result.total).toBe(1);
  });

  it("filters by role", async () => {
    await caller.create(validUser);
    await caller.create({ ...validUser, role: "viewer" });

    const admins = await caller.list({ role: "admin" });
    expect(admins.users).toHaveLength(1);
    expect(admins.users[0]?.role).toBe("admin");
  });

  it("applies defaults for page and limit", async () => {
    const result = await caller.list({});
    expect(result.page).toBe(1);
    expect(result.limit).toBe(20);
  });
});

// ============================================================
// Get by ID
// ============================================================

describe("getById", () => {
  it("returns user by id", async () => {
    const created = await caller.create(validUser);
    const found = await caller.getById({ id: created.id });
    expect(found).toEqual(created);
  });

  it("returns null for unknown id", async () => {
    const found = await caller.getById({ id: "999" });
    expect(found).toBeNull();
  });

  it("rejects empty id", async () => {
    await expect(caller.getById({ id: "" })).rejects.toThrow(TRPCError);
  });
});

// ============================================================
// Update
// ============================================================

describe("update", () => {
  it("updates user fields", async () => {
    const created = await caller.create(validUser);
    const updated = await caller.update({ id: created.id, name: "Updated" });
    expect(updated?.name).toBe("Updated");
    expect(updated?.email).toBe(validUser.email);
  });

  it("returns null for unknown id", async () => {
    const result = await caller.update({ id: "999", name: "X" });
    expect(result).toBeNull();
  });
});

// ============================================================
// Delete
// ============================================================

describe("delete", () => {
  it("deletes existing user", async () => {
    const created = await caller.create(validUser);
    const deleted = await caller.delete({ id: created.id });
    expect(deleted).toBe(true);
  });

  it("returns false for unknown id", async () => {
    const deleted = await caller.delete({ id: "999" });
    expect(deleted).toBe(false);
  });
});

// ============================================================
// autoDiscover compilation verification
// ============================================================

describe("autoDiscover compilation", () => {
  it("schemas use AOT-compiled safeParse (no compile() needed)", () => {
    const schemas = [
      { name: "CreateUserSchema", schema: CreateUserSchema },
      { name: "UpdateUserSchema", schema: UpdateUserSchema },
      { name: "ListUsersSchema", schema: ListUsersSchema },
      { name: "UserIdSchema", schema: UserIdSchema },
    ];

    for (const { name, schema } of schemas) {
      expect(schema.safeParse.name, `${name} should have AOT-compiled safeParse`).toBe(
        `safeParse_${name}`,
      );
    }
  });

  it("schemas preserve the full Zod API (Standard Schema compatibility)", () => {
    expect(CreateUserSchema).toHaveProperty("_zod");
    expect(CreateUserSchema).toHaveProperty("shape");
  });
});
