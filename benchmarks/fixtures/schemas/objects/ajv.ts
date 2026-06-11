import { ajv } from "../ajv-instance.js";

export const ajvUser = ajv.compile({
  type: "object",
  properties: {
    username: { type: "string", minLength: 3, maxLength: 20 },
    email: { type: "string", format: "email" },
    password: { type: "string", minLength: 8 },
    age: { type: "integer", exclusiveMinimum: 0 },
    role: { enum: ["user", "admin"] },
    newsletter: { type: "boolean" },
    referral: { type: "string" },
  },
  required: ["username", "email", "password", "age", "role", "newsletter"],
  additionalProperties: false,
});

const itemSchema = {
  type: "object" as const,
  properties: {
    id: { type: "integer" as const, exclusiveMinimum: 0 },
    title: { type: "string" as const, minLength: 1, maxLength: 200 },
    description: { type: "string" as const, maxLength: 2000 },
    tags: {
      type: "array" as const,
      items: { type: "string" as const, minLength: 1 },
      maxItems: 10,
    },
    published: { type: "boolean" as const },
    category: { enum: ["tech", "science", "art", "music", "sports"] },
    metadata: {
      type: "object" as const,
      properties: {
        createdAt: { type: "string" as const },
        updatedAt: { type: "string" as const },
        views: { type: "integer" as const, minimum: 0 },
      },
      required: ["createdAt", "updatedAt", "views"],
      additionalProperties: false,
    },
  },
  required: ["id", "title", "tags", "published", "category", "metadata"],
  additionalProperties: false,
};

export const ajvApiResponse = ajv.compile({
  type: "object",
  properties: {
    status: { enum: ["success", "error"] },
    data: {
      type: "object",
      properties: {
        items: { type: "array", items: itemSchema },
        total: { type: "integer", minimum: 0 },
        page: { type: "integer", exclusiveMinimum: 0 },
        pageSize: { type: "integer", exclusiveMinimum: 0 },
        hasMore: { type: "boolean" },
      },
      required: ["items", "total", "page", "pageSize", "hasMore"],
      additionalProperties: false,
    },
    error: {
      type: "object",
      properties: {
        code: { type: "string" },
        message: { type: "string" },
      },
      required: ["code", "message"],
      additionalProperties: false,
    },
  },
  required: ["status"],
  additionalProperties: false,
});
