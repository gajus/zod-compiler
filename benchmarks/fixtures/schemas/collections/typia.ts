import typia, { type tags } from "typia";

type Tuple = [string, number & tags.Type<"int32">, boolean];
type RecordType = Record<string, number>;

// ─── createValidate (with errors) ───────────────────────────────────────────

export const typiaValidateTuple = typia.createValidate<Tuple>();
export const typiaValidateRecord = typia.createValidate<RecordType>();

// set: typia.createIs<Set<T>> does not validate Set contents
// map: typia.createIs<Map<K,V>> does not validate Map contents
