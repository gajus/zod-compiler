import { createTRPCClient, httpBatchLink } from "@trpc/client";
import type { AppRouter } from "./router.js";

const trpc = createTRPCClient<AppRouter>({
  links: [httpBatchLink({ url: "http://localhost:3001" })],
});

async function main() {
  // oxlint-disable-next-line no-console -- demo output
  const log = console.log;

  log("=== tRPC + zod-compiler autoDiscover demo ===\n");

  // Create user
  const user = await trpc.create.mutate({
    name: "Alice",
    email: "alice@example.com",
    age: 30,
    role: "admin",
  });
  log("Created:", user);

  // List users
  const list = await trpc.list.query({});
  log("List:", list);

  // Get by ID
  const found = await trpc.getById.query({ id: user.id });
  log("Get:", found);

  // Update
  const updated = await trpc.update.mutate({ id: user.id, name: "Alice Updated" });
  log("Updated:", updated);

  // Validation error
  log("\n--- Validation error demo ---");
  try {
    await trpc.create.mutate({
      name: "",
      email: "invalid",
      age: -1,
      role: "superadmin" as "admin",
    });
  } catch (e) {
    log("Expected error:", (e as Error).message);
  }

  // Delete
  const deleted = await trpc.delete.mutate({ id: user.id });
  log("Deleted:", deleted);
}

main().catch((e) => {
  // oxlint-disable-next-line no-console -- error output
  console.error(e);
  process.exit(1);
});
