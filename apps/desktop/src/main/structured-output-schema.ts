type JsonSchema = Record<string, unknown>;

function isRecord(value: unknown): value is JsonSchema {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function adaptNode(value: unknown, isRoot: boolean): unknown {
  if (Array.isArray(value)) return value.map((item) => adaptNode(item, false));
  if (!isRecord(value)) return value;

  if ('oneOf' in value && 'anyOf' in value) {
    throw new Error('CODEX_OUTPUT_SCHEMA_AMBIGUOUS_UNION');
  }
  if (isRoot && 'oneOf' in value) {
    throw new Error('CODEX_OUTPUT_SCHEMA_ROOT_UNION_UNSUPPORTED');
  }

  const adapted: JsonSchema = {};
  for (const [key, child] of Object.entries(value)) {
    // Codex 结构化输出支持嵌套 anyOf，但不接受 Zod draft-7 生成的 oneOf。
    const compatibleKey = key === 'oneOf' ? 'anyOf' : key;
    adapted[compatibleKey] = adaptNode(child, false);
  }
  return adapted;
}

/**
 * 将通用 JSON Schema 收窄为 Codex 结构化输出支持的形式。
 * 保留领域层 Zod 判别联合的严格校验，只在传输边界把嵌套 oneOf 改写为 anyOf。
 */
export function toCodexOutputSchema(schema: JsonSchema): JsonSchema {
  return adaptNode(schema, true) as JsonSchema;
}
