export type JsonObject = Record<string, unknown>;

export function isPlainObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Matches Dashboard V4.2 semantics exactly:
 * - plain objects merge recursively;
 * - arrays, scalars, null and other non-plain values replace the previous value.
 */
export function deepMerge(...objects: unknown[]): JsonObject {
  const result: JsonObject = {};

  for (const source of objects) {
    if (!isPlainObject(source)) continue;

    for (const [key, value] of Object.entries(source)) {
      if (isPlainObject(value) && isPlainObject(result[key])) {
        result[key] = deepMerge(result[key], value);
      } else if (isPlainObject(value)) {
        result[key] = deepMerge({}, value);
      } else {
        result[key] = value;
      }
    }
  }

  return result;
}
