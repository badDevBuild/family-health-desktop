type JsonSchema = Record<string, unknown>;
const supportedStringFormats = new Set(['date-time', 'time', 'date', 'duration', 'email', 'hostname', 'ipv4', 'ipv6', 'uuid']);

function isRecord(value: unknown): value is JsonSchema {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nullableWireProperty(schema: JsonSchema): JsonSchema {
  if (Array.isArray(schema.type) && schema.type.includes('null')) return schema;
  if (typeof schema.type === 'string' && schema.type !== 'null' && !('const' in schema)) {
    return { ...schema, type: [schema.type, 'null'],
      ...(Array.isArray(schema.enum) && !schema.enum.includes(null) ? { enum: [...schema.enum, null] } : {}) };
  }
  return { anyOf: [schema, { type: 'null' }] };
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
    // 传输层不支持 URI 格式；URL 的 HTTPS 与来源合法性仍由本地 Zod/语义校验负责。
    if (key === 'format' && typeof child === 'string' && !supportedStringFormats.has(child)) continue;
    // Codex 结构化输出支持嵌套 anyOf，但不接受 Zod draft-7 生成的 oneOf。
    const compatibleKey = key === 'oneOf' ? 'anyOf' : key;
    adapted[compatibleKey] = adaptNode(child, false);
  }
  if (isRecord(value.properties)) {
    const originallyRequired = new Set(Array.isArray(value.required) ? value.required : []);
    const properties = adapted.properties as JsonSchema;
    for (const [key, child] of Object.entries(properties)) {
      if (!originallyRequired.has(key) && isRecord(child)) properties[key] = nullableWireProperty(child);
    }
    // Codex 的 strict response_format 要求每个对象的 required 覆盖全部 properties。
    adapted.required = Object.keys(properties);
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

/** 线协议用 null 表示原 Zod 契约中的可选字段；入库前恢复为“未提供”。 */
export function restoreCodexOptionalFields(output: unknown, originalSchema: JsonSchema): unknown {
  if (Array.isArray(output)) {
    return isRecord(originalSchema.items)
      ? output.map((item) => restoreCodexOptionalFields(item, originalSchema.items as JsonSchema)) : output;
  }
  if (!isRecord(output)) return output;
  if (isRecord(originalSchema.properties)) {
    const required = new Set(Array.isArray(originalSchema.required) ? originalSchema.required : []);
    const restored: JsonSchema = { ...output };
    for (const [key, propertySchema] of Object.entries(originalSchema.properties)) {
      if (!(key in restored)) continue;
      if (!required.has(key) && restored[key] === null) {
        delete restored[key];
      } else if (isRecord(propertySchema)) {
        restored[key] = restoreCodexOptionalFields(restored[key], propertySchema);
      }
    }
    return restored;
  }
  const branches = originalSchema.oneOf ?? originalSchema.anyOf;
  if (Array.isArray(branches)) {
    const matching = branches.filter((branch) => isRecord(branch) && isRecord(branch.properties)
      && Object.entries(branch.properties).every(([key, field]) => !isRecord(field) || !('const' in field)
        || output[key] === field.const));
    if (matching.length === 1) return restoreCodexOptionalFields(output, matching[0] as JsonSchema);
  }
  return output;
}
