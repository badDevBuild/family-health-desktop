import { z } from 'zod';
import { directOriginalReadingResultSchema, directOriginalReadingRepairSchema,
  type DirectOriginalReadingResult, type DirectOriginalReadingRepair } from '@contracts';

type JsonSchema = Record<string, unknown>;
type Contract = 'reading' | 'repair';

/** 只保存固定结构分类；不包含回执正文、动态字段名、校验路径或原始异常消息。 */
export type DirectOriginalStructureFailureReason =
  | 'DIRECT_ORIGINAL_STRUCTURE_ENVELOPE_INVALID'
  | 'DIRECT_ORIGINAL_STRUCTURE_WIRE_VERSION_MISMATCH'
  | 'DIRECT_ORIGINAL_STRUCTURE_WIRE_CONTRACT_MISMATCH'
  | 'DIRECT_ORIGINAL_STRUCTURE_WIRE_PAYLOAD_INVALID'
  | 'DIRECT_ORIGINAL_STRUCTURE_CANONICAL_SCHEMA_INVALID'
  | 'DIRECT_ORIGINAL_STRUCTURE_DOCUMENT_MISMATCH'
  | 'DIRECT_ORIGINAL_STRUCTURE_DECODE_UNEXPECTED';

const structureFailureReasons = new Set<DirectOriginalStructureFailureReason>([
  'DIRECT_ORIGINAL_STRUCTURE_ENVELOPE_INVALID',
  'DIRECT_ORIGINAL_STRUCTURE_WIRE_VERSION_MISMATCH',
  'DIRECT_ORIGINAL_STRUCTURE_WIRE_CONTRACT_MISMATCH',
  'DIRECT_ORIGINAL_STRUCTURE_WIRE_PAYLOAD_INVALID',
  'DIRECT_ORIGINAL_STRUCTURE_CANONICAL_SCHEMA_INVALID',
  'DIRECT_ORIGINAL_STRUCTURE_DOCUMENT_MISMATCH',
  'DIRECT_ORIGINAL_STRUCTURE_DECODE_UNEXPECTED'
]);

type WireErrorCode = 'DIRECT_ORIGINAL_WIRE_INVALID' | 'DIRECT_ORIGINAL_WIRE_SCHEMA_UNSUPPORTED'
  | 'DIRECT_ORIGINAL_WIRE_AMBIGUOUS_UNION' | 'DIRECT_ORIGINAL_WIRE_CANONICAL_JSON_REQUIRED'
  | 'DIRECT_ORIGINAL_WIRE_VERSION_MISMATCH' | 'DIRECT_ORIGINAL_WIRE_CONTRACT_MISMATCH'
  | 'DIRECT_ORIGINAL_WIRE_CANONICAL_SCHEMA_INVALID';

class DirectOriginalWireError extends Error {
  readonly #structureReason: DirectOriginalStructureFailureReason;

  constructor(code: WireErrorCode, structureReason: DirectOriginalStructureFailureReason) {
    super(code);
    this.#structureReason = structureReason;
  }

  static structureReason(error: unknown): DirectOriginalStructureFailureReason {
    // 私有字段形成真实品牌检查；不读取可被自有属性遮蔽的 getter 或仿冒原型。
    if (typeof error === 'object' && error !== null && #structureReason in error) {
      const reason = error.#structureReason;
      if (structureFailureReasons.has(reason)) return reason;
    }
    return 'DIRECT_ORIGINAL_STRUCTURE_DECODE_UNEXPECTED';
  }
}

export function directOriginalStructureFailureReason(error: unknown): DirectOriginalStructureFailureReason {
  // 不按 Error.message、仿冒 code 属性或 Zod 内容猜原因，避免把私人内容带入持久记录。
  return DirectOriginalWireError.structureReason(error);
}

/** 只版本化传输表示；领域契约、检查点哈希和一次修复标记不因此变更。 */
export const DIRECT_ORIGINAL_WIRE_VERSION = 'direct-original-wire-v1' as const;

/** 固定的一对一领域键映射。枚举、字符串内容、来源 ID 与 JSON Schema 关键词从不改写。 */
export const DIRECT_ORIGINAL_WIRE_KEY_MAP = Object.freeze({
  schemaVersion: 'sv', documentId: 'd', pageReadings: 'pg', sourceExcerpts: 'sx', extraction: 'ex',
  sourceSpanId: 's', status: 'st', localKey: 'k', pageSourceSpanId: 'ps', quote: 'q', role: 'ro', clarity: 'cl',
  resultInventory: 'ri', candidateKeys: 'cks',
  pageRole: 'pgr', classification: 'clf', disposition: 'dsp', duplicateSourceSpanId: 'dss',
  subject: 'su', reportedName: 'pn', evidence: 'ev', confidence: 'cf', reportMetadata: 'md',
  coveredSourceSpanIds: 'cv', candidates: 'cs', originalName: 'n', standardNameCandidate: 'sn',
  value: 'va', kind: 'ty', rawText: 'rt', decimal: 'de', comparator: 'cm', unitRaw: 'u', referenceRangeRaw: 'rr',
  reportedAbnormalFlag: 'af', specimen: 'sp', method: 'me', bodySite: 'bs', clinicalDate: 'dt',
  clinicalContext: 'cc', version: 'v', conditions: 'co', sourceBinding: 'sb', headingEvidence: 'he',
  findingEvidence: 'fe', issues: 'is', code: 'cd', message: 'ms', sourceRole: 'sr', duplicateBasis: 'db',
  reportKind: 'rk', title: 'ti', organization: 'og', campus: 'ca', department: 'dp', reportNumber: 'rn',
  encounterIdentifier: 'ei', sampleIdentifiers: 'si', examItems: 'em', primaryClinicalTimeIndex: 'pt',
  times: 'ts', precision: 'pr', targetId: 'ta', originalReadingHash: 'oh', results: 'rs', action: 'ac',
  replacement: 'rp', nodeType: 'nt', newExcerpts: 'nx', newCandidates: 'nc', category: 'ct', reason: 're',
  sourceMappings: 'smp', candidateKey: 'ck', comparisonRecordKey: 'crk', relation: 'rel',
  structuredSlot: 'ss', contextEvidence: 'ce', rowEvidence: 'rwe', columnEvidence: 'cle', axes: 'axs', component: 'cmp'
} as const);

/** 与短键一起交给提示词的表示说明，不重新定义医学字段的含义。 */
export const DIRECT_ORIGINAL_WIRE_PROMPT_GUIDE = [
  `仅输出版本 ${DIRECT_ORIGINAL_WIRE_VERSION} 的对象：{wireVersion,contract,payload}。`,
  'contract 在整份读取时为 reading，在局部修复时为 repair；payload 使用以下固定短键。',
  '短键只替换属性名，不改变任何枚举、原句、数字字符串、比较符、日期角色、来源 ID、数组顺序或空数组。',
  '所有 schema 属性都必须输出。只有原领域对象有 optional 字段时才有 _p，内容是本对象真实存在的 optional 短键，不能重复。',
  'optional 字段缺省：槽输出 null，但不列入 _p。optional 字段显式为 null：槽输出 null，必须列入 _p，且原领域类型须允许 null。',
  'optional 字段是空数组：槽输出 []，必须列入 _p。required 字段不列入 _p。不要混用长键和短键，不要增加 schema 没有的属性。',
  `固定领域属性名→短键：${JSON.stringify(DIRECT_ORIGINAL_WIRE_KEY_MAP)}`
].join('\n');

export interface DirectOriginalWireEnvelope<T extends Contract = Contract> {
  wireVersion: typeof DIRECT_ORIGINAL_WIRE_VERSION;
  contract: T;
  payload: Record<string, unknown>;
}

interface Field {
  canonicalKey: string;
  wireKey: string;
  optional: boolean;
  node: Node;
}
type Node =
  | { kind: 'scalar'; schema: JsonSchema; wireSchema: JsonSchema }
  | { kind: 'object'; fields: Field[]; schema: JsonSchema; wireSchema: JsonSchema }
  | { kind: 'array'; item: Node; schema: JsonSchema; wireSchema: JsonSchema }
  | { kind: 'union'; mode: 'oneOf' | 'anyOf'; branches: Node[]; schema: JsonSchema; wireSchema: JsonSchema };

const scalarKeys = new Set(['type', 'const', 'enum', 'minLength', 'maxLength', 'minimum', 'maximum', 'pattern']);
const supportedKeys = new Set([...scalarKeys, '$schema', 'additionalProperties', 'properties', 'required',
  'items', 'minItems', 'maxItems', 'oneOf', 'anyOf']);
const presenceKey = '_p';
const aliasByCanonical: Readonly<Record<string, string>> = DIRECT_ORIGINAL_WIRE_KEY_MAP;

function isRecord(value: unknown): value is JsonSchema {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return (prototype === Object.prototype || prototype === null) && Object.getOwnPropertySymbols(value).length === 0;
}

function fail(code: WireErrorCode,
  structureReason: DirectOriginalStructureFailureReason = 'DIRECT_ORIGINAL_STRUCTURE_DECODE_UNEXPECTED'): never {
  // 仅固定错误码；不把私人值、原句或路径写入错误信息。
  throw new DirectOriginalWireError(code, structureReason);
}

function compileNode(schema: JsonSchema): Node {
  if (Object.keys(schema).some((key) => !supportedKeys.has(key))) fail('DIRECT_ORIGINAL_WIRE_SCHEMA_UNSUPPORTED');
  const copy = { ...schema };
  delete copy.$schema;
  if (Array.isArray(schema.oneOf) || Array.isArray(schema.anyOf)) {
    if (schema.oneOf && schema.anyOf || Object.keys(copy).length !== 1) fail('DIRECT_ORIGINAL_WIRE_SCHEMA_UNSUPPORTED');
    const mode = Array.isArray(schema.oneOf) ? 'oneOf' : 'anyOf';
    const children = schema[mode] as unknown[];
    if (children.length === 0 || children.some((child) => !isRecord(child))) fail('DIRECT_ORIGINAL_WIRE_SCHEMA_UNSUPPORTED');
    const branches = children.map((child) => compileNode(child as JsonSchema));
    return { kind: 'union', mode, branches, schema: copy, wireSchema: { [mode]: branches.map((branch) => branch.wireSchema) } };
  }
  if (schema.type === 'object') {
    if (!isRecord(schema.properties) || schema.additionalProperties !== false || !Array.isArray(schema.required)) {
      fail('DIRECT_ORIGINAL_WIRE_SCHEMA_UNSUPPORTED');
    }
    const required = new Set(schema.required);
    if (schema.required.some((key) => typeof key !== 'string' || !Object.hasOwn(schema.properties as JsonSchema, key))) {
      fail('DIRECT_ORIGINAL_WIRE_SCHEMA_UNSUPPORTED');
    }
    const fields = Object.entries(schema.properties).map(([canonicalKey, child]): Field => {
      const wireKey = aliasByCanonical[canonicalKey];
      if (!wireKey || wireKey === presenceKey || !isRecord(child)) fail('DIRECT_ORIGINAL_WIRE_SCHEMA_UNSUPPORTED');
      return { canonicalKey, wireKey, optional: !required.has(canonicalKey), node: compileNode(child) };
    });
    if (new Set(fields.map((field) => field.wireKey)).size !== fields.length) fail('DIRECT_ORIGINAL_WIRE_SCHEMA_UNSUPPORTED');
    const properties: JsonSchema = {};
    for (const field of fields) {
      properties[field.wireKey] = field.optional && !matchesNode(field.node, null, false)
        ? { anyOf: [field.node.wireSchema, { type: 'null' }] } : field.node.wireSchema;
    }
    const optionalKeys = fields.filter((field) => field.optional).map((field) => field.wireKey);
    if (optionalKeys.length > 0) properties[presenceKey] = {
      type: 'array', items: { type: 'string', enum: optionalKeys }, maxItems: optionalKeys.length
    };
    return { kind: 'object', fields, schema: copy, wireSchema: {
      type: 'object', properties, required: Object.keys(properties), additionalProperties: false
    } };
  }
  if (schema.type === 'array') {
    if (!isRecord(schema.items)) fail('DIRECT_ORIGINAL_WIRE_SCHEMA_UNSUPPORTED');
    const item = compileNode(schema.items);
    return { kind: 'array', item, schema: copy, wireSchema: { ...copy, items: item.wireSchema } };
  }
  if (!schema.type || Object.keys(copy).some((key) => !scalarKeys.has(key))) fail('DIRECT_ORIGINAL_WIRE_SCHEMA_UNSUPPORTED');
  return { kind: 'scalar', schema: copy, wireSchema: copy };
}

function matchesScalar(schema: JsonSchema, value: unknown): boolean {
  const types = Array.isArray(schema.type) ? schema.type : [schema.type];
  const typeMatches = types.some((type) => type === 'null' ? value === null
    : type === 'string' ? typeof value === 'string'
      : type === 'number' ? typeof value === 'number' && Number.isFinite(value)
        : type === 'integer' ? typeof value === 'number' && Number.isSafeInteger(value)
          : type === 'boolean' ? typeof value === 'boolean' : false);
  if (!typeMatches || Object.hasOwn(schema, 'const') && value !== schema.const
    || Array.isArray(schema.enum) && !schema.enum.some((item) => item === value)) return false;
  if (typeof value === 'string') {
    const length = Array.from(value).length;
    if (typeof schema.minLength === 'number' && length < schema.minLength
      || typeof schema.maxLength === 'number' && length > schema.maxLength
      || typeof schema.pattern === 'string' && !new RegExp(schema.pattern).test(value)) return false;
  }
  return !(typeof value === 'number' && (typeof schema.minimum === 'number' && value < schema.minimum
    || typeof schema.maximum === 'number' && value > schema.maximum));
}

/** 校验 wire 与 canonical 都只核技术结构；不推断项目、数值或日期含义。 */
function matchesNode(node: Node, value: unknown, wire: boolean): boolean {
  if (node.kind === 'scalar') return matchesScalar(node.schema, value);
  if (node.kind === 'union') {
    const count = node.branches.filter((branch) => matchesNode(branch, value, wire)).length;
    return node.mode === 'oneOf' ? count === 1 : count > 0;
  }
  if (node.kind === 'array') {
    if (!Array.isArray(value) || Object.keys(value).length !== value.length
      || typeof node.schema.minItems === 'number' && value.length < node.schema.minItems
      || typeof node.schema.maxItems === 'number' && value.length > node.schema.maxItems) return false;
    return value.every((item) => matchesNode(node.item, item, wire));
  }
  if (!isRecord(value)) return false;
  const optional = node.fields.filter((field) => field.optional);
  const validKeys = new Set(node.fields.map((field) => wire ? field.wireKey : field.canonicalKey));
  if (wire && optional.length > 0) validKeys.add(presenceKey);
  if (Object.keys(value).some((key) => !validKeys.has(key))) return false;
  let present = new Set<string>();
  if (wire && optional.length > 0) {
    const keys = value[presenceKey];
    const optionalKeys = new Set(optional.map((field) => field.wireKey));
    if (!Array.isArray(keys) || new Set(keys).size !== keys.length
      || keys.some((key) => typeof key !== 'string' || !optionalKeys.has(key))) return false;
    present = new Set(keys as string[]);
  }
  return node.fields.every((field) => {
    const key = wire ? field.wireKey : field.canonicalKey;
    if (!Object.hasOwn(value, key)) return !wire && field.optional;
    if (wire && field.optional && !present.has(key)) return value[key] === null;
    return matchesNode(field.node, value[key], wire);
  });
}

function transformNode(node: Node, value: unknown, encode: boolean): unknown {
  if (node.kind === 'scalar') return value;
  if (node.kind === 'union') {
    const branches = node.branches.filter((branch) => matchesNode(branch, value, !encode));
    // 当前领域联合分支互斥；新增含糊分支必须明确升级 codec，不能猜测。
    if (branches.length !== 1) fail('DIRECT_ORIGINAL_WIRE_AMBIGUOUS_UNION', 'DIRECT_ORIGINAL_STRUCTURE_WIRE_PAYLOAD_INVALID');
    return transformNode(branches[0]!, value, encode);
  }
  if (node.kind === 'array') return (value as unknown[]).map((item) => transformNode(node.item, item, encode));
  const input = value as JsonSchema;
  const output: JsonSchema = {};
  const presence = new Set(encode ? node.fields.filter((field) => field.optional && Object.hasOwn(input, field.canonicalKey))
    .map((field) => field.wireKey) : input[presenceKey] as string[] | undefined);
  for (const field of node.fields) {
    if (field.optional && !presence.has(field.wireKey)) {
      if (encode) output[field.wireKey] = null;
      continue;
    }
    output[encode ? field.wireKey : field.canonicalKey] = transformNode(field.node,
      input[encode ? field.canonicalKey : field.wireKey], encode);
  }
  if (encode && node.fields.some((field) => field.optional)) output[presenceKey] = [...presence];
  return output;
}

function freezeSchema(schema: JsonSchema): JsonSchema {
  for (const value of Object.values(schema)) {
    if (Array.isArray(value)) {
      for (const item of value) if (isRecord(item)) freezeSchema(item);
      Object.freeze(value);
    } else if (isRecord(value)) freezeSchema(value);
  }
  return Object.freeze(schema);
}

function createCodec<T>(contract: Contract, canonicalSchema: z.ZodType<T>) {
  const canonicalJson = z.toJSONSchema(canonicalSchema, { target: 'draft-7' }) as JsonSchema;
  const node = compileNode(canonicalJson);
  const wireSchema = freezeSchema({ $schema: canonicalJson.$schema, type: 'object',
    properties: { wireVersion: { type: 'string', const: DIRECT_ORIGINAL_WIRE_VERSION },
      contract: { type: 'string', const: contract }, payload: node.wireSchema },
    required: ['wireVersion', 'contract', 'payload'], additionalProperties: false });
  return {
    wireSchema,
    encode(value: T): DirectOriginalWireEnvelope {
      const canonical = canonicalSchema.parse(value);
      if (!matchesNode(node, canonical, false)) fail('DIRECT_ORIGINAL_WIRE_CANONICAL_JSON_REQUIRED');
      return { wireVersion: DIRECT_ORIGINAL_WIRE_VERSION, contract,
        payload: transformNode(node, canonical, true) as JsonSchema };
    },
    decode(value: unknown): T {
      if (!isRecord(value) || Object.keys(value).length !== 3
        || !['wireVersion', 'contract', 'payload'].every((key) => Object.hasOwn(value, key))) {
        fail('DIRECT_ORIGINAL_WIRE_INVALID', 'DIRECT_ORIGINAL_STRUCTURE_ENVELOPE_INVALID');
      }
      if (value.wireVersion !== DIRECT_ORIGINAL_WIRE_VERSION) {
        fail('DIRECT_ORIGINAL_WIRE_VERSION_MISMATCH', 'DIRECT_ORIGINAL_STRUCTURE_WIRE_VERSION_MISMATCH');
      }
      if (value.contract !== contract) {
        fail('DIRECT_ORIGINAL_WIRE_CONTRACT_MISMATCH', 'DIRECT_ORIGINAL_STRUCTURE_WIRE_CONTRACT_MISMATCH');
      }
      if (!matchesNode(node, value.payload, true)) {
        fail('DIRECT_ORIGINAL_WIRE_INVALID', 'DIRECT_ORIGINAL_STRUCTURE_WIRE_PAYLOAD_INVALID');
      }
      // 原领域 Zod 契约继续负责其 refinements；哈希只能在此 canonical 结果上计算。
      const parsed = canonicalSchema.safeParse(transformNode(node, value.payload, false));
      if (!parsed.success) fail('DIRECT_ORIGINAL_WIRE_CANONICAL_SCHEMA_INVALID', 'DIRECT_ORIGINAL_STRUCTURE_CANONICAL_SCHEMA_INVALID');
      return parsed.data;
    }
  };
}

const readingCodec = createCodec('reading', directOriginalReadingResultSchema);
const repairCodec = createCodec('repair', directOriginalReadingRepairSchema);

export const directOriginalReadingWireSchema = readingCodec.wireSchema;
export const directOriginalRepairWireSchema = repairCodec.wireSchema;
export function encodeDirectOriginalReading(value: DirectOriginalReadingResult): DirectOriginalWireEnvelope<'reading'> {
  return readingCodec.encode(value) as DirectOriginalWireEnvelope<'reading'>;
}
export function encodeDirectOriginalRepair(value: DirectOriginalReadingRepair): DirectOriginalWireEnvelope<'repair'> {
  return repairCodec.encode(value) as DirectOriginalWireEnvelope<'repair'>;
}
export function decodeDirectOriginalReading(value: unknown): DirectOriginalReadingResult {
  return readingCodec.decode(value);
}
export function decodeDirectOriginalRepair(value: unknown): DirectOriginalReadingRepair {
  return repairCodec.decode(value);
}
