import { describe, expect, it } from "vitest";
import { app } from "../src/app.js";

// ============================================================
// Helpers
// ============================================================

interface JsonResponse {
  validator?: string;
  data?: Record<string, unknown>;
  query?: Record<string, unknown>;
  param?: Record<string, unknown>;
  ok?: boolean;
}

function postJson(path: string, body: unknown) {
  return app.request(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function get(path: string, headers: Record<string, string> = {}) {
  return app.request(path, { method: "GET", headers });
}

const validUser = {
  name: "Alice",
  email: "alice@example.com",
  age: 30,
  role: "admin",
};

// ============================================================
// JSON body validation: POST /zod/users vs POST /aot/users
// ============================================================

describe("JSON body validation", () => {
  const paths = ["/zod/users", "/aot/users"] as const;

  for (const path of paths) {
    describe(`POST ${path}`, () => {
      it("returns 200 with valid data", async () => {
        const res = await postJson(path, validUser);
        expect(res.status).toBe(200);
        const json = (await res.json()) as JsonResponse;
        expect(json.data).toEqual(validUser);
      });

      it("returns 400 with empty body", async () => {
        const res = await postJson(path, {});
        expect(res.status).toBe(400);
      });

      it("returns 400 when email is invalid", async () => {
        const res = await postJson(path, { ...validUser, email: "bad" });
        expect(res.status).toBe(400);
      });

      it("returns 400 when role is unknown", async () => {
        const res = await postJson(path, { ...validUser, role: "superadmin" });
        expect(res.status).toBe(400);
      });

      it("returns 400 when age is negative", async () => {
        const res = await postJson(path, { ...validUser, age: -1 });
        expect(res.status).toBe(400);
      });
    });
  }

  it("both return identical status for all inputs", async () => {
    const inputs = [
      validUser,
      {},
      { ...validUser, email: "bad" },
      { ...validUser, age: 3.14 },
      { ...validUser, name: "" },
      { ...validUser, extra: "field" },
    ];
    for (const body of inputs) {
      const [zod, aot] = await Promise.all([
        postJson("/zod/users", body),
        postJson("/aot/users", body),
      ]);
      expect(aot.status).toBe(zod.status);
    }
  });
});

// ============================================================
// Query validation: GET /zod/users vs GET /aot/users
// ============================================================

describe("Query validation", () => {
  const paths = ["/zod/users", "/aot/users"] as const;

  for (const path of paths) {
    describe(`GET ${path}`, () => {
      it("returns 200 with no query (defaults)", async () => {
        const res = await get(path);
        expect(res.status).toBe(200);
      });

      it("returns 200 with valid query", async () => {
        const res = await get(`${path}?page=2&limit=10&role=admin`);
        expect(res.status).toBe(200);
      });

      it("returns 400 with invalid role", async () => {
        const res = await get(`${path}?role=superadmin`);
        expect(res.status).toBe(400);
      });
    });
  }
});

// ============================================================
// Param validation: GET /zod/users/:id vs GET /aot/users/:id
// ============================================================

describe("Param validation", () => {
  const prefixes = ["/zod", "/aot"] as const;

  for (const prefix of prefixes) {
    describe(`GET ${prefix}/users/:id`, () => {
      it("returns 200 with valid id", async () => {
        const res = await get(`${prefix}/users/abc123`);
        expect(res.status).toBe(200);
        const json = (await res.json()) as JsonResponse;
        expect(json.param).toEqual({ id: "abc123" });
      });
    });
  }
});

// ============================================================
// Header validation: GET /zod/protected vs GET /aot/protected
// ============================================================

describe("Header validation", () => {
  const paths = ["/zod/protected", "/aot/protected"] as const;

  for (const path of paths) {
    describe(`GET ${path}`, () => {
      it("returns 200 with valid x-api-key header", async () => {
        const res = await get(path, { "x-api-key": "secret-key" });
        expect(res.status).toBe(200);
        const json = (await res.json()) as JsonResponse;
        expect(json.ok).toBe(true);
      });

      it("returns 400 without x-api-key header", async () => {
        const res = await get(path);
        expect(res.status).toBe(400);
      });
    });
  }

  it("both return identical status for headers", async () => {
    const headerSets: Record<string, string>[] = [
      { "x-api-key": "valid" },
      {},
      { "x-api-key": "" },
    ];
    for (const headers of headerSets) {
      const [zod, aot] = await Promise.all([
        get("/zod/protected", headers),
        get("/aot/protected", headers),
      ]);
      expect(aot.status).toBe(zod.status);
    }
  });
});
