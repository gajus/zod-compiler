/**
 * E2E test for zod-compiler + Next.js webpack integration.
 *
 * 1. Builds the Next.js app (verifies webpack plugin works)
 * 2. Starts the production server
 * 3. Tests API routes with valid/invalid data
 * 4. Exits with 0 on success, 1 on failure
 */

import { type ChildProcess, execSync, spawn } from "node:child_process";
import path from "node:path";

const BASE_URL = "http://localhost:3456";
const APP_DIR = path.resolve(import.meta.dirname, "..");

function log(msg: string) {
  // oxlint-disable-next-line no-console -- E2E test runner output
  console.log(`[e2e] ${msg}`);
}

async function waitForServer(url: string, maxRetries = 30): Promise<void> {
  for (let i = 0; i < maxRetries; i++) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      // server not ready yet
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`Server did not start within ${maxRetries}s`);
}

async function testValidUser(): Promise<void> {
  const res = await fetch(`${BASE_URL}/api/validate?type=user`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: "Alice",
      email: "alice@example.com",
      age: 30,
      role: "admin",
    }),
  });
  const data = await res.json();
  assert(res.status === 200, `Expected 200, got ${res.status}`);
  assert(data.success === true, "Expected success");
  assert(data.data.name === "Alice", "Expected name Alice");
  log("PASS: valid user");
}

async function testInvalidUser(): Promise<void> {
  const res = await fetch(`${BASE_URL}/api/validate?type=user`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: "",
      email: "not-an-email",
      age: -1,
      role: "unknown",
    }),
  });
  const data = await res.json();
  assert(res.status === 400, `Expected 400, got ${res.status}`);
  assert(data.success === false, "Expected failure");
  assert(Array.isArray(data.errors), "Expected errors array");
  assert(data.errors.length > 0, "Expected at least one error");
  log("PASS: invalid user");
}

async function testValidProduct(): Promise<void> {
  const res = await fetch(`${BASE_URL}/api/validate?type=product`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      id: "550e8400-e29b-41d4-a716-446655440000",
      name: "Widget",
      price: 9.99,
      tags: ["electronics"],
      inStock: true,
    }),
  });
  const data = await res.json();
  assert(res.status === 200, `Expected 200, got ${res.status}`);
  assert(data.success === true, "Expected success");
  log("PASS: valid product");
}

async function testInvalidProduct(): Promise<void> {
  const res = await fetch(`${BASE_URL}/api/validate?type=product`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      id: "not-a-uuid",
      name: "",
      price: -5,
      tags: "not-an-array",
      inStock: "yes",
    }),
  });
  const data = await res.json();
  assert(res.status === 400, `Expected 400, got ${res.status}`);
  assert(data.success === false, "Expected failure");
  assert(data.errors.length > 0, "Expected validation errors");
  log("PASS: invalid product");
}

async function testHomePage(): Promise<void> {
  const res = await fetch(BASE_URL);
  assert(res.status === 200, `Expected 200, got ${res.status}`);
  const html = await res.text();
  assert(html.includes("zod-compiler"), "Expected page to contain zod-compiler");
  log("PASS: home page renders");
}

function assert(condition: boolean, msg: string): void {
  if (!condition) throw new Error(`Assertion failed: ${msg}`);
}

async function main() {
  let server: ChildProcess | null = null;

  try {
    // Step 1: Build
    log("Building Next.js app...");
    execSync("pnpm build", {
      cwd: APP_DIR,
      stdio: "inherit",
      env: { ...process.env, NODE_ENV: "production" },
    });
    log("Build succeeded!");

    // Step 2: Start server
    log("Starting production server on port 3456...");
    server = spawn("pnpm", ["start", "-p", "3456"], {
      cwd: APP_DIR,
      stdio: "pipe",
      env: { ...process.env, NODE_ENV: "production" },
    });

    await waitForServer(BASE_URL);
    log("Server is ready.");

    // Step 3: Run tests
    await testHomePage();
    await testValidUser();
    await testInvalidUser();
    await testValidProduct();
    await testInvalidProduct();

    log("All tests passed!");
    process.exit(0);
  } catch (err) {
    // oxlint-disable-next-line no-console -- E2E test runner output
    console.error("[e2e] FAILED:", err);
    process.exit(1);
  } finally {
    if (server) {
      server.kill("SIGTERM");
    }
  }
}

void main();
