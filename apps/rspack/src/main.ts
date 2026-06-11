import { validateAddress, validateNotification, validateUser } from "./schemas.js";

// oxlint-disable-next-line no-console -- sample app output
const log = console.log;

// Reproduce issue #143: require of JSON file should still work
const translations = require("./translations/api.json");
log(`translations loaded: ${JSON.stringify(translations)?.slice(0, 40)}`);

function test(label: string, fn: () => void): void {
  log(`\n--- ${label} ---`);
  try {
    fn();
  } catch (e) {
    log(`  ERROR: ${e instanceof Error ? e.message : String(e)}`);
  }
}

test("User: valid", () => {
  const result = validateUser.safeParse({
    name: "Alice",
    email: "alice@example.com",
    age: 30,
    role: "admin",
    isActive: true,
  });
  log(`  success: ${result.success}`);
  if (result.success) log(`  data.name: ${result.data.name}`);
});

test("User: invalid email", () => {
  const result = validateUser.safeParse({
    name: "Bob",
    email: "not-an-email",
    age: 25,
    role: "viewer",
    isActive: false,
  });
  log(`  success: ${result.success}`);
  if (!result.success) log(`  issues: ${result.error?.issues.length}`);
});

test("Address: valid zip", () => {
  const result = validateAddress.safeParse({
    street: "1-2-3 Shibuya",
    city: "Tokyo",
    zip: "150-0002",
  });
  log(`  success: ${result.success}`);
});

test("Address: invalid zip", () => {
  const result = validateAddress.safeParse({
    street: "4-5-6 Umeda",
    city: "Osaka",
    zip: "ABC-DEFG",
  });
  log(`  success: ${result.success}`);
  if (!result.success) log(`  issues: ${result.error?.issues.length}`);
});

test("Notification: email", () => {
  const result = validateNotification.safeParse({
    type: "email",
    to: "user@example.com",
    subject: "Hello",
  });
  log(`  success: ${result.success}`);
});

test("Notification: invalid type", () => {
  const result = validateNotification.safeParse({ type: "fax", number: "03-0000" });
  log(`  success: ${result.success}`);
  if (!result.success) log(`  issues: ${result.error?.issues.length}`);
});

log("\nAll tests completed.");
