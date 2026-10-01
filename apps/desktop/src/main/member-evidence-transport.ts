import type { MemberEvidencePackageV3 } from '@contracts';

/** 只改变发送表示，不改本地事实、引用 ID 或任何医学字段。 */
export const MEMBER_EVIDENCE_TRANSPORT_VERSION = 'member-evidence-table-v1';
/** 接口文本上限为 1,048,576 字符；留出协议与规则余量，不截断医学资料。 */
export const MAX_ASSESSMENT_PROMPT_CHARS = 1_000_000;

export function assertAssessmentPromptFits(prompt: string): void {
  if (prompt.length > MAX_ASSESSMENT_PROMPT_CHARS) throw new Error('MEMBER_ASSESSMENT_INPUT_TOO_LARGE');
}

export function isAssessmentContextLimit(error: unknown): boolean {
  return error instanceof Error && (error.message === 'CODEX_CONTEXT_WINDOW_EXCEEDED'
    || /^CODEX_RPC_ERROR:-32602:Input exceeds the maximum length of \d+ characters\.?$/.test(error.message));
}

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type RecordJson = { [key: string]: Json };
export interface CompactMemberEvidence {
  format: typeof MEMBER_EVIDENCE_TRANSPORT_VERSION;
  columns: Record<string, string[]>;
  quotes: string[];
  data: RecordJson;
}

export interface MemberEvidenceTransport {
  packet: CompactMemberEvidence;
  /** 只留在本机；模型使用同一请求内稳定的短编号。 */
  referenceIds: Record<string, string>;
}

const isReferenceKey = (key: string) => key !== 'personId' && (key === 'id' || /Ids?$/.test(key));

function mapReferences<T>(value: T, mapping: ReadonlyMap<string, string>, key = ''): T {
  if (typeof value === 'string') return (isReferenceKey(key) ? mapping.get(value) ?? value : value) as T;
  if (Array.isArray(value)) return value.map((item) => mapReferences(item, mapping, key)) as T;
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([field, child]) =>
      [field, mapReferences(child, mapping, field)])) as T;
  }
  return value;
}

export function createMemberEvidenceTransport<T extends { evidenceCatalog: unknown[] }>(input: T): MemberEvidenceTransport {
  const ids = new Set<string>();
  const collect = (value: unknown, key = ''): void => {
    if (typeof value === 'string' && isReferenceKey(key)) ids.add(value);
    else if (Array.isArray(value)) value.forEach((item) => collect(item, key));
    else if (value !== null && typeof value === 'object') {
      for (const [field, child] of Object.entries(value)) collect(child, field);
    }
  };
  collect(input);
  // 不允许原始 ID 与生成的短编号相撞；部位、日期、原文等值从不参与替换。
  let prefix = 'ref:';
  for (let suffix = 2; [...ids].some((id) => id.startsWith(prefix)); suffix += 1) prefix = `ref${suffix}:`;
  const aliases = new Map([...ids].filter((id) => id.length >= 24).map((id, index) => [id, `${prefix}${index + 1}`]));
  return {
    packet: compactMemberEvidence(mapReferences(input, aliases)),
    referenceIds: Object.fromEntries([...aliases].map(([id, alias]) => [alias, id]))
  };
}

/** 只转换 ID 字段，不把正文中偶然出现的相同字符串替换为内部编号。 */
export function restoreMemberEvidenceReferences<T>(value: T, referenceIds: Record<string, string>): T {
  return mapReferences(value, new Map(Object.entries(referenceIds)));
}

export function aliasMemberEvidenceReferences<T>(value: T, referenceIds: Record<string, string>): T {
  return mapReferences(value, new Map(Object.entries(referenceIds).map(([alias, id]) => [id, alias])));
}

const markers = new Set(['$table', '$rows', '$row', '$quote', '$evidence', '$object']);
const record = (value: Json): value is RecordJson => value !== null && typeof value === 'object' && !Array.isArray(value);

/** 原文只按完整字符串相等去重；不做摘要、截断、名称归并或日期继承。 */
function compactMemberEvidence(input: { evidenceCatalog: unknown[] }): CompactMemberEvidence {
  const source = JSON.parse(JSON.stringify(input)) as RecordJson;
  const evidence = source.evidenceCatalog as RecordJson[];
  const evidenceKey = (value: RecordJson) => JSON.stringify(Object.fromEntries(
    Object.entries(value).sort(([left], [right]) => left.localeCompare(right))));
  const evidenceIndices = new Map(evidence.map((item, index) => [evidenceKey(item), index]));
  const quoteCounts = new Map<string, number>();
  const countQuotes = (value: Json): void => {
    if (Array.isArray(value)) value.forEach(countQuotes);
    else if (record(value)) for (const [key, child] of Object.entries(value)) {
      if (key === 'quote' && typeof child === 'string' && child.length >= 40) {
        quoteCounts.set(child, (quoteCounts.get(child) ?? 0) + 1);
      }
      countQuotes(child);
    }
  };
  countQuotes(source);
  const quotes = [...quoteCounts].filter(([, count]) => count > 1).map(([quote]) => quote);
  const quoteIndices = new Map(quotes.map((quote, index) => [quote, index]));
  const columns: Record<string, string[]> = {};
  const columnIds = new Map<string, string>();
  const tableFor = (keys: string[], name: string): string => {
    const signature = JSON.stringify(keys);
    const prior = columnIds.get(signature);
    if (prior) return prior;
    const base = name.replace(/[^a-zA-Z0-9]/g, '') || 'record';
    let id = base;
    for (let suffix = 2; Object.hasOwn(columns, id); suffix += 1) id = `${base}${suffix}`;
    columns[id] = keys;
    columnIds.set(signature, id);
    return id;
  };
  const canReferenceEvidence = (value: Json, inCatalog: boolean): number | undefined =>
    !inCatalog && record(value) && typeof value.id === 'string' && value.kind === 'observation'
      ? evidenceIndices.get(evidenceKey(value)) : undefined;
  const encode = (value: Json, name: string, inCatalog = false): Json => {
    if (name === 'quote' && typeof value === 'string') {
      const index = quoteIndices.get(value);
      if (index !== undefined) return { $quote: index };
    }
    const evidenceIndex = canReferenceEvidence(value, inCatalog);
    if (evidenceIndex !== undefined) return { $evidence: evidenceIndex };
    if (Array.isArray(value)) {
      const first = value[0];
      if (first && record(first) && !Object.keys(first).some((key) => markers.has(key))
        && value.every((row) => record(row) && JSON.stringify(Object.keys(row)) === JSON.stringify(Object.keys(first))
          && canReferenceEvidence(row, inCatalog) === undefined)) {
        const keys = Object.keys(first);
        return { $table: tableFor(keys, name), $rows: value.map((row) =>
          keys.map((key) => encode((row as RecordJson)[key]!, key, inCatalog))) };
      }
      return value.map((item) => encode(item, name, inCatalog));
    }
    if (!record(value)) return value;
    const keys = Object.keys(value);
    // 将趋势内反复出现的日期/计算对象也表格化，字段顺序只定义一次。
    if (['payload', 'time', 'trendFacts', 'evidence'].includes(name) && !keys.some((key) => markers.has(key))) {
      return { $table: tableFor(keys, name === 'payload' ? 'trendSeries' : name),
        $row: keys.map((key) => encode(value[key]!, key, inCatalog)) };
    }
    const entries = keys.map((key): [string, Json] => [key, encode(value[key]!, key, inCatalog || key === 'evidenceCatalog')]);
    // 防止未来扩展的未知 payload 中的同名字段被误认为传输标记。
    if (keys.some((key) => markers.has(key))) return { $object: entries };
    return Object.fromEntries(entries);
  };
  return { format: MEMBER_EVIDENCE_TRANSPORT_VERSION, columns, quotes, data: encode(source, 'package') as RecordJson };
}

/** 本机对账及测试使用；传入本地映射后恢复原始引用 ID。 */
export function expandMemberEvidence<T = MemberEvidencePackageV3>(input: CompactMemberEvidence, referenceIds: Record<string, string> = {}): T {
  if (input.format !== MEMBER_EVIDENCE_TRANSPORT_VERSION) throw new Error('MEMBER_EVIDENCE_FORMAT_INVALID');
  const catalog: { rows?: Json[] } = {};
  const at = (rows: Json[], index: Json | undefined): Json => {
    if (typeof index !== 'number' || !Number.isInteger(index) || index < 0 || index >= rows.length) {
      throw new Error('MEMBER_EVIDENCE_REFERENCE_INVALID');
    }
    return rows[index]!;
  };
  const decode = (value: Json): Json => {
    if (Array.isArray(value)) return value.map(decode);
    if (!record(value)) return value;
    if (Object.hasOwn(value, '$quote')) return at(input.quotes, value.$quote);
    if (Object.hasOwn(value, '$evidence')) {
      if (!catalog.rows) throw new Error('MEMBER_EVIDENCE_CATALOG_ORDER_INVALID');
      return structuredClone(at(catalog.rows, value.$evidence));
    }
    if (Object.hasOwn(value, '$object')) {
      return Object.fromEntries((value.$object as Array<[string, Json]>).map(([key, item]) => [key, decode(item)]));
    }
    if (typeof value.$table === 'string') {
      const keys = input.columns[value.$table];
      if (!keys) throw new Error('MEMBER_EVIDENCE_TABLE_INVALID');
      const row = (cells: Json): Json => {
        if (!Array.isArray(cells) || cells.length !== keys.length) throw new Error('MEMBER_EVIDENCE_ROW_INVALID');
        return Object.fromEntries(keys.map((key, index) => [key, decode(cells[index]!)]));
      };
      if (Array.isArray(value.$rows)) return value.$rows.map(row);
      return row(value.$row!);
    }
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, decode(child)]));
  };
  const decodedCatalog = decode(input.data.evidenceCatalog!);
  if (!Array.isArray(decodedCatalog)) throw new Error('MEMBER_EVIDENCE_CATALOG_INVALID');
  catalog.rows = decodedCatalog;
  return restoreMemberEvidenceReferences(Object.fromEntries(Object.entries(input.data).map(([key, value]) =>
    [key, key === 'evidenceCatalog' ? decodedCatalog : decode(value)])), referenceIds) as T;
}
