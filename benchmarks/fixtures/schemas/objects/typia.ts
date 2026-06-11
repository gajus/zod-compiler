import typia, { type tags } from "typia";

interface User {
  username: string & tags.MinLength<3> & tags.MaxLength<20>;
  email: string & tags.Format<"email">;
  password: string & tags.MinLength<8>;
  age: number & tags.Type<"int32"> & tags.ExclusiveMinimum<0>;
  role: "user" | "admin";
  newsletter: boolean;
  referral?: string | undefined;
}

interface ItemMetadata {
  createdAt: string;
  updatedAt: string;
  views: number & tags.Type<"int32"> & tags.Minimum<0>;
}

interface Item {
  id: number & tags.Type<"int32"> & tags.ExclusiveMinimum<0>;
  title: string & tags.MinLength<1> & tags.MaxLength<200>;
  description?: (string & tags.MaxLength<2000>) | undefined;
  tags: Array<string & tags.MinLength<1>> & tags.MaxItems<10>;
  published: boolean;
  category: "tech" | "science" | "art" | "music" | "sports";
  metadata: ItemMetadata;
}

interface DataPayload {
  items: Item[];
  total: number & tags.Type<"int32"> & tags.Minimum<0>;
  page: number & tags.Type<"int32"> & tags.ExclusiveMinimum<0>;
  pageSize: number & tags.Type<"int32"> & tags.ExclusiveMinimum<0>;
  hasMore: boolean;
}

interface ErrorPayload {
  code: string;
  message: string;
}

interface ApiResponse {
  status: "success" | "error";
  data?: DataPayload | undefined;
  error?: ErrorPayload | undefined;
}

// ─── createValidate (with errors) ───────────────────────────────────────────

export const typiaValidateUser = typia.createValidate<User>();
export const typiaValidateApiResponse = typia.createValidate<ApiResponse>();

// ─── createAssert (throwing, parse() analog) ────────────────────────────────

export const typiaAssertUser = typia.createAssert<User>();
export const typiaAssertApiResponse = typia.createAssert<ApiResponse>();
