import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { directOriginalReadingResultSchema, directOriginalReadingRepairSchema,
  type DirectOriginalReadingResult, type DirectOriginalReadingRepair, type ObservationCandidate,
  type ReportMetadataCandidate } from '@contracts';
import { stableHash } from '@core';
import { decodeDirectOriginalReading, decodeDirectOriginalRepair, encodeDirectOriginalReading,
  encodeDirectOriginalRepair, directOriginalReadingWireSchema, directOriginalRepairWireSchema,
  DIRECT_ORIGINAL_WIRE_KEY_MAP, DIRECT_ORIGINAL_WIRE_PROMPT_GUIDE, DIRECT_ORIGINAL_WIRE_VERSION,
  directOriginalStructureFailureReason, type DirectOriginalWireEnvelope } from './direct-original-wire.js';
import { restoreCodexOptionalFields, toCodexOutputSchema } from './structured-output-schema.js';

type JsonObject = Record<string, unknown>;
const pageKey = (index: number) => `synthetic-page-${index + 1}`;
const ref = (sourceSpanId: string, quote: string | null = null) => ({ sourceSpanId, quote });

function metadata(): ReportMetadataCandidate {
  const field = (value: string) => ({ value, evidence: [ref('e_meta', '合成标题与来源编号')] });
  return {
    reportKind: field('合成报告'), title: field('仅供测试的完整原件'), organization: null,
    campus: field('合成来源地点'), department: null, reportNumber: field('synthetic-source-id'),
    encounterIdentifier: null, sampleIdentifiers: [], examItems: [field('合成项目')], primaryClinicalTimeIndex: null,
    times: [
      { value: '2026-02-03', precision: 'day', role: 'examined', evidence: [ref('e_date')] },
      { value: '2026-02-04', precision: 'day', role: 'report_issued', evidence: [ref('e_date')] },
      { value: '2025-01', precision: 'month', role: 'history_quoted', evidence: [ref('e_date')] },
      { value: '2024', precision: 'year', role: 'unknown', evidence: [ref('e_date')] },
      { value: '2026-02-03', precision: 'day', role: 'sampled', evidence: [ref('e_date')] },
      { value: '2026-02-03', precision: 'day', role: 'encounter', evidence: [ref('e_date')] }
    ]
  };
}

function candidate(index: number): ObservationCandidate {
  const finding = ref(`e_${index}`, null);
  const value: ObservationCandidate['value'] = index % 4 === 0
    ? { kind: 'numeric', rawText: '<2.50E＋02', decimal: '250', comparator: 'lt' }
    : index % 4 === 1 ? { kind: 'qualitative', rawText: '阴性（原文）', category: null }
      : index % 4 === 2 ? { kind: 'text', rawText: '原句保留\n左侧和右侧描述不同；不是一项新的诊断。' }
        : { kind: 'unknown', rawText: null, reason: 'original_blank' };
  return {
    localKey: `c_${index}`, originalName: `合成项目 ${index + 1}`, standardNameCandidate: null, value,
    unitRaw: 'U/mL', referenceRangeRaw: '0–300（合成范围）', reportedAbnormalFlag: 'unknown',
    specimen: null, method: '合成检查方法', bodySite: '左侧', clinicalDate: index % 2 === 0 ? '2026-02-03' : null,
    evidence: [finding, { ...ref('e_duplicate', '保留第二处来源'), sourceRole: 'duplicate_source', duplicateBasis: 'report_structure' }],
    ...(index % 4 === 1 ? { clinicalContext: null }
      : index % 4 === 2 ? { clinicalContext: { version: 1 as const, status: 'complete' as const, conditions: [] } }
        : index % 4 === 3 ? { clinicalContext: { version: 1 as const, status: 'complete' as const,
          conditions: [{ sourceSpanId: 'e_condition', quote: '检查条件：未散瞳；监测区间另有明示。' }] } } : {}),
    ...(index % 3 === 0 ? { sourceBinding: { headingEvidence: [ref('e_heading', '合成栏目')], findingEvidence: [finding] } } : {}),
    issues: index % 5 === 0 ? [{ code: 'synthetic_issue', message: '原句包含 sourceSpanId 与 clinicalDate，内容不能被短键替换。' }] : []
  };
}

/** 纯合成 32 页，原句只用于表示往返；不连接 SQLite、OCR、模型或原件。 */
function reading(pages = 32, count = 16): DirectOriginalReadingResult {
  const pageIds = Array.from({ length: pages }, (_, index) => pageKey(index));
  const sourceExcerpts: DirectOriginalReadingResult['sourceExcerpts'] = Array.from({ length: count }, (_, index) => ({
    localKey: `e_${index}`, pageSourceSpanId: pageIds[index % pages]!,
    quote: `合成项目 ${index + 1} 原句：值、比较符、否定、左右侧均保留。\n这是一段用于来源定位的合成正文。`,
    role: index % 4 === 3 ? 'instruction' : 'finding', clarity: index % 7 === 0 ? 'uncertain' : 'clear'
  }));
  sourceExcerpts.push(
    { localKey: 'e_meta', pageSourceSpanId: pageIds[0]!, quote: '合成标题与来源编号', role: 'heading', clarity: 'clear' },
    { localKey: 'e_date', pageSourceSpanId: pageIds[0]!, quote: '合成日期原句：本次、签发、历史列分开保留。', role: 'date', clarity: 'clear' },
    { localKey: 'e_condition', pageSourceSpanId: pageIds[0]!, quote: '检查条件：未散瞳；监测区间另有明示。', role: 'context', clarity: 'clear' },
    { localKey: 'e_duplicate', pageSourceSpanId: pageIds.at(-1)!, quote: '保留第二处来源', role: 'finding', clarity: 'clear' },
    { localKey: 'e_heading', pageSourceSpanId: pageIds[0]!, quote: '合成栏目', role: 'heading', clarity: 'clear' },
    { localKey: 'e_identity', pageSourceSpanId: pageIds[0]!, quote: '仅供测试的合成受检者', role: 'identity', clarity: 'clear' });
  return {
    schemaVersion: 1, documentId: 'synthetic-whole-document',
    pageReadings: pageIds.map((sourceSpanId, index) => ({ sourceSpanId,
      status: (['read', 'partial', 'unreadable', 'no_medical_content'] as const)[index % 4]! })),
    sourceExcerpts,
    extraction: { schemaVersion: 1, documentId: 'synthetic-whole-document',
      subject: { reportedName: '合成受检者', evidence: [ref('e_identity')], confidence: 'explicit' },
      reportMetadata: metadata(), coveredSourceSpanIds: pageIds, candidates: Array.from({ length: count }, (_, index) => candidate(index)) }
  };
}

function repair(original: DirectOriginalReadingResult): DirectOriginalReadingRepair {
  return {
    schemaVersion: 1, documentId: original.documentId,
    originalReadingHash: stableHash(directOriginalReadingResultSchema.parse(original)),
    results: [
      { targetId: 'c_0', action: 'replace', replacement: { nodeType: 'candidate', value: candidate(0) } },
      { targetId: 'e_0', action: 'replace', replacement: { nodeType: 'excerpt', value: original.sourceExcerpts[0]! } },
      { targetId: 'metadata', action: 'replace', replacement: { nodeType: 'metadata', value: metadata() } },
      { targetId: 'subject', action: 'replace', replacement: { nodeType: 'subject', value: original.extraction.subject } },
      { targetId: pageKey(0), action: 'replace', replacement: { nodeType: 'page', value: {
        sourceSpanId: pageKey(0), status: 'partial', newExcerpts: [], newCandidates: []
      } } },
      { targetId: 'c_1', action: 'unchanged', replacement: null }
    ]
  };
}

function payloadExtraction(wire: DirectOriginalWireEnvelope): JsonObject { return wire.payload.ex as JsonObject; }
function wireCandidate(wire: DirectOriginalWireEnvelope, index = 0): JsonObject {
  return (payloadExtraction(wire).cs as JsonObject[])[index]!;
}
function wireMetadata(wire: DirectOriginalWireEnvelope): JsonObject { return payloadExtraction(wire).md as JsonObject; }
function runtimeBoundary(wire: DirectOriginalWireEnvelope, schema: JsonObject): unknown {
  // 与 runtime 相同：先适配 strict schema，再从 JSON 回执按原 wire schema 恢复 optional。
  const adapted = toCodexOutputSchema(schema);
  expect(adapted.required).toEqual(['wireVersion', 'contract', 'payload']);
  const received: unknown = JSON.parse(JSON.stringify(wire));
  const restored = restoreCodexOptionalFields(received, schema);
  expect(restored).toEqual(wire);
  return restored;
}

function assertAllWireObjectsRequired(schema: JsonObject) {
  if (schema.type === 'object') {
    const properties = schema.properties as JsonObject;
    expect(schema.additionalProperties).toBe(false);
    expect(schema.required).toEqual(Object.keys(properties));
    Object.values(properties).forEach((field) => assertAllWireObjectsRequired(field as JsonObject));
  }
  if (schema.type === 'array') {
    expect(Array.isArray(schema.items)).toBe(false);
    assertAllWireObjectsRequired(schema.items as JsonObject);
  }
  for (const keyword of ['oneOf', 'anyOf']) {
    if (Array.isArray(schema[keyword])) (schema[keyword] as JsonObject[]).forEach(assertAllWireObjectsRequired);
  }
}

describe('direct original lossless wire codec', () => {
  it('行列/轴/分量引用无损往返，旧缺省槽位不被补成已验证对象', () => {
    const canonical = reading(1, 2);
    canonical.extraction.candidates[0]!.sourceBinding = { headingEvidence: [], findingEvidence: [ref('e_0')],
      structuredSlot: { version: 1, kind: 'table_cell', contextEvidence: [ref('e_0')], rowEvidence: [ref('e_0', '合成行')],
        columnEvidence: [ref('e_heading', '本次')], axes: [{ kind: 'laterality', evidence: [ref('e_heading', '左侧')] }],
        component: { kind: 'quantitative', evidence: [ref('e_0', '<2.50E＋02')] } } };
    canonical.extraction.candidates[1]!.sourceBinding = { headingEvidence: [], findingEvidence: [ref('e_1')] };
    const wire = encodeDirectOriginalReading(canonical);
    const decoded = decodeDirectOriginalReading(runtimeBoundary(wire, directOriginalReadingWireSchema));
    expect(decoded).toStrictEqual(canonical);
    expect(Object.hasOwn(decoded.extraction.candidates[1]!.sourceBinding!, 'structuredSlot')).toBe(false);
    expect((wireCandidate(wire, 0).sb as JsonObject)._p).toContain('ss');
    expect((wireCandidate(wire, 1).sb as JsonObject)._p).not.toContain('ss');
  });
  it.each(['absent', 'empty', 'same_original_field', 'uncertain'] as const)('P03来源映射%s仅按可选契约无损往返', (state) => {
    const canonical = repair(reading(1, 1));
    if (state !== 'absent') canonical.sourceMappings = state === 'empty' ? [] : [{ candidateKey: 'c_0',
      comparisonRecordKey: 'ro_record_1', relation: state }];
    const wire = encodeDirectOriginalRepair(canonical);
    expect(wire.payload._p).toEqual(expect.arrayContaining(state === 'absent' ? [] : ['smp']));
    expect((wire.payload._p as string[]).includes('smp')).toBe(state !== 'absent');
    expect(wire.payload.smp).toEqual(state === 'absent' ? null : state === 'empty' ? [] : [{ ck: 'c_0', crk: 'ro_record_1', rel: state }]);
    expect(decodeDirectOriginalRepair(runtimeBoundary(wire, directOriginalRepairWireSchema))).toStrictEqual(canonical);
    expect(stableHash(decodeDirectOriginalRepair(wire))).toBe(stableHash(canonical));
  });

  it('固定一对一映射，不改 schema 元关键词或枚举内容，所有 wire 对象全部 required', () => {
    const aliases = Object.values(DIRECT_ORIGINAL_WIRE_KEY_MAP);
    expect(new Set(aliases).size).toBe(aliases.length);
    expect(aliases).not.toContain('_p');
    expect(DIRECT_ORIGINAL_WIRE_VERSION).toBe('direct-original-wire-v1');
    expect(DIRECT_ORIGINAL_WIRE_PROMPT_GUIDE).toContain('primaryClinicalTimeIndex');
    expect(DIRECT_ORIGINAL_WIRE_PROMPT_GUIDE).toContain('clinicalContext');
    expect(DIRECT_ORIGINAL_WIRE_PROMPT_GUIDE).toContain('_p');
    for (const schema of [directOriginalReadingWireSchema, directOriginalRepairWireSchema]) {
      assertAllWireObjectsRequired(schema);
      assertAllWireObjectsRequired(toCodexOutputSchema(schema));
      expect(JSON.stringify(schema)).toContain('history_quoted');
      expect(JSON.stringify(schema)).toContain('duplicate_source');
      expect(JSON.stringify(schema)).toContain('"additionalProperties":false');
      expect(Object.isFrozen(schema)).toBe(true);
    }
  });

  it('完整读取往返保留原句、ID、日期角色、左右侧、条件、不等号与全部联合分支', () => {
    const canonical = directOriginalReadingResultSchema.parse(reading());
    const before = structuredClone(canonical);
    const wire = encodeDirectOriginalReading(canonical);
    const decoded = decodeDirectOriginalReading(runtimeBoundary(wire, directOriginalReadingWireSchema));
    expect(decoded).toEqual(canonical);
    expect(JSON.stringify(decoded)).toBe(JSON.stringify(canonical));
    expect(stableHash(decoded)).toBe(stableHash(canonical));
    expect(decoded.extraction.candidates[0]!.value).toEqual({ kind: 'numeric', rawText: '<2.50E＋02', decimal: '250', comparator: 'lt' });
    expect(decoded.extraction.candidates[0]!.issues[0]!.message).toContain('sourceSpanId');
    expect(decoded.pageReadings.map((page) => page.sourceSpanId)).toEqual(canonical.pageReadings.map((page) => page.sourceSpanId));
    expect(canonical).toEqual(before);
    expect((wireCandidate(wire).va as JsonObject).cm).toBe('lt');
  });

  it.each(['eq', 'lt', 'lte', 'gt', 'gte'] as const)('比较符 %s 只搬运，不据原句重新推算', (comparator) => {
    const canonical = reading(1, 1);
    canonical.extraction.candidates[0]!.value = { kind: 'numeric', rawText: '  <2.50E＋02\n', decimal: '250', comparator };
    expect(decodeDirectOriginalReading(encodeDirectOriginalReading(canonical)).extraction.candidates[0]!.value)
      .toEqual(canonical.extraction.candidates[0]!.value);
  });

  it('临床条件 absent、null、complete-empty、完整原句在 strict/restore 边界仍不同', () => {
    const canonical = reading(1, 4);
    const wire = encodeDirectOriginalReading(canonical);
    const decoded = decodeDirectOriginalReading(runtimeBoundary(wire, directOriginalReadingWireSchema));
    expect(Object.hasOwn(decoded.extraction.candidates[0]!, 'clinicalContext')).toBe(false);
    expect(Object.hasOwn(decoded.extraction.candidates[1]!, 'clinicalContext')).toBe(true);
    expect(decoded.extraction.candidates[1]!.clinicalContext).toBeNull();
    expect(decoded.extraction.candidates[2]!.clinicalContext).toEqual({ version: 1, status: 'complete', conditions: [] });
    expect(decoded.extraction.candidates[3]!.clinicalContext?.conditions[0]!.quote).toBe('检查条件：未散瞳；监测区间另有明示。');
    expect(wireCandidate(wire, 0)._p).not.toContain('cc');
    expect(wireCandidate(wire, 1)._p).toContain('cc');
    expect(wireCandidate(wire, 2)._p).toContain('cc');
  });

  it.each(['absent', 'null', 'object'] as const)('reportMetadata %s 不被旧 optional restore 合并', (state) => {
    const canonical = reading(1, 1);
    if (state === 'absent') delete canonical.extraction.reportMetadata;
    if (state === 'null') canonical.extraction.reportMetadata = null;
    const wire = encodeDirectOriginalReading(canonical);
    const decoded = decodeDirectOriginalReading(runtimeBoundary(wire, directOriginalReadingWireSchema));
    expect(Object.hasOwn(decoded.extraction, 'reportMetadata')).toBe(state !== 'absent');
    expect(decoded.extraction.reportMetadata).toEqual(canonical.extraction.reportMetadata);
  });

  it('metadata selector 的 absent、null、0，以及样本空数组均原样还原', () => {
    for (const selector of [undefined, null, 0]) {
      const canonical = reading(1, 1);
      if (selector === undefined) delete canonical.extraction.reportMetadata!.primaryClinicalTimeIndex;
      else canonical.extraction.reportMetadata!.primaryClinicalTimeIndex = selector;
      const wire = encodeDirectOriginalReading(canonical);
      const decoded = decodeDirectOriginalReading(runtimeBoundary(wire, directOriginalReadingWireSchema));
      expect(Object.hasOwn(decoded.extraction.reportMetadata!, 'primaryClinicalTimeIndex')).toBe(selector !== undefined);
      expect(decoded.extraction.reportMetadata!.primaryClinicalTimeIndex).toBe(selector);
      expect(decoded.extraction.reportMetadata!.sampleIdentifiers).toEqual([]);
      expect(Object.hasOwn(decoded.extraction.reportMetadata!, 'sampleIdentifiers')).toBe(true);
      expect(decoded.extraction.reportMetadata!.encounterIdentifier).toBeNull();
    }
  });

  it('引用中的 absent/null duplicateBasis、primary/duplicate 枚举与 quote null 均原样保留', () => {
    const canonical = reading(1, 1);
    const first = canonical.extraction.candidates[0]!;
    first.evidence.push({ ...ref('e_0'), sourceRole: 'primary', duplicateBasis: null });
    const wire = encodeDirectOriginalReading(canonical);
    const decoded = decodeDirectOriginalReading(runtimeBoundary(wire, directOriginalReadingWireSchema));
    expect(Object.hasOwn(decoded.extraction.candidates[0]!.evidence[0]!, 'sourceRole')).toBe(false);
    expect(Object.hasOwn(decoded.extraction.candidates[0]!.evidence[0]!, 'duplicateBasis')).toBe(false);
    expect(decoded.extraction.candidates[0]!.evidence[1]!.duplicateBasis).toBe('report_structure');
    expect(Object.hasOwn(decoded.extraction.candidates[0]!.evidence[2]!, 'duplicateBasis')).toBe(true);
    expect(decoded.extraction.candidates[0]!.evidence[2]!.duplicateBasis).toBeNull();
    expect(decoded.extraction.candidates[0]!.evidence[0]!.quote).toBeNull();
  });

  it('P03 所有 replacement 分支与 unchanged/null、hash、新增空数组均无损', () => {
    const canonical = directOriginalReadingRepairSchema.parse(repair(reading()));
    const wire = encodeDirectOriginalRepair(canonical);
    const decoded = decodeDirectOriginalRepair(runtimeBoundary(wire, directOriginalRepairWireSchema));
    expect(decoded).toEqual(canonical);
    expect(JSON.stringify(decoded)).toBe(JSON.stringify(canonical));
    expect(decoded.originalReadingHash).toBe(canonical.originalReadingHash);
    expect(decoded.results.at(-1)!.replacement).toBeNull();
    expect(stableHash(decoded)).toBe(stableHash(canonical));
  });

  it.each(['absent', 'empty', 'populated'] as const)('P03 page addon %s 区分缺省、空数组和完整新节点', (state) => {
    const canonical = repair(reading());
    const result = canonical.results[4]!.replacement!;
    if (result.nodeType !== 'page') throw new Error('SYNTHETIC_PAGE_REQUIRED');
    if (state === 'absent') { delete result.value.newExcerpts; delete result.value.newCandidates; }
    if (state === 'populated') {
      result.value.newExcerpts = [{ localKey: 'new-e', pageSourceSpanId: pageKey(0), quote: '合成遗漏的原句', role: 'finding', clarity: 'clear' }];
      result.value.newCandidates = [candidate(20)];
    }
    const wire = encodeDirectOriginalRepair(canonical);
    const decoded = decodeDirectOriginalRepair(runtimeBoundary(wire, directOriginalRepairWireSchema));
    expect(decoded).toEqual(canonical);
    const repairedPage = decoded.results[4]!.replacement!;
    if (repairedPage.nodeType !== 'page') throw new Error('SYNTHETIC_PAGE_REQUIRED');
    expect(Object.hasOwn(repairedPage.value, 'newCandidates')).toBe(state !== 'absent');
    expect(Object.hasOwn(repairedPage.value, 'newExcerpts')).toBe(state !== 'absent');
  });

  it.each([180, 350])('%s 个合成字段加完整32页回执：canonical 哈希稳定且只省重复属性名', (count) => {
    const canonical = directOriginalReadingResultSchema.parse(reading(32, count));
    const wire = encodeDirectOriginalReading(canonical);
    const decoded = decodeDirectOriginalReading(runtimeBoundary(wire, directOriginalReadingWireSchema));
    expect(JSON.stringify(decoded)).toBe(JSON.stringify(canonical));
    expect(decoded.pageReadings).toHaveLength(32);
    expect(decoded.sourceExcerpts).toHaveLength(count + 6);
    expect(decoded.extraction.candidates).toHaveLength(count);
    expect(stableHash(decoded)).toBe(createHash('sha256').update(JSON.stringify(canonical)).digest('hex'));
    expect(JSON.stringify(wire).length).toBeLessThan(JSON.stringify(canonical).length * 0.9);
  });

  it('不把 canonical 长键对象当作 wire fallback，也拒绝错版本与跨任务 contract', () => {
    expect(() => decodeDirectOriginalReading(reading())).toThrow('DIRECT_ORIGINAL_WIRE_INVALID');
    const wire = encodeDirectOriginalReading(reading());
    expect(() => decodeDirectOriginalReading({ ...wire, wireVersion: 'direct-original-wire-v0' })).toThrow('VERSION_MISMATCH');
    expect(() => decodeDirectOriginalRepair(wire)).toThrow('CONTRACT_MISMATCH');
    expect(() => decodeDirectOriginalReading({ ...wire, extra: 1 })).toThrow('DIRECT_ORIGINAL_WIRE_INVALID');
    expect(() => decodeDirectOriginalReading({ contract: wire.contract, payload: wire.payload })).toThrow('DIRECT_ORIGINAL_WIRE_INVALID');
  });

  it.each([
    ['envelope', 'DIRECT_ORIGINAL_STRUCTURE_ENVELOPE_INVALID'],
    ['version', 'DIRECT_ORIGINAL_STRUCTURE_WIRE_VERSION_MISMATCH'],
    ['contract', 'DIRECT_ORIGINAL_STRUCTURE_WIRE_CONTRACT_MISMATCH'],
    ['payload', 'DIRECT_ORIGINAL_STRUCTURE_WIRE_PAYLOAD_INVALID'],
    ['canonical', 'DIRECT_ORIGINAL_STRUCTURE_CANONICAL_SCHEMA_INVALID']
  ] as const)('%s失败只提供固定结构分类，不回显未知字段、私人值或Zod路径', (problem, reason) => {
    const wire = encodeDirectOriginalReading(reading(1, 2));
    const privateMarker = 'synthetic-private-value-and-field';
    if (problem === 'envelope') Object.assign(wire, { [privateMarker]: privateMarker });
    if (problem === 'version') Object.assign(wire, { wireVersion: privateMarker });
    if (problem === 'contract') Object.assign(wire, { contract: privateMarker });
    if (problem === 'payload') wireCandidate(wire)[privateMarker] = privateMarker;
    if (problem === 'canonical') wireCandidate(wire, 1).k = wireCandidate(wire, 0).k;
    let caught: unknown;
    try { decodeDirectOriginalReading(wire); } catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(Error);
    expect(directOriginalStructureFailureReason(caught)).toBe(reason);
    expect((caught as Error).message).toMatch(/^DIRECT_ORIGINAL_WIRE_[A-Z_]+$/u);
    expect((caught as Error).message).not.toContain(privateMarker);
    expect(caught).not.toHaveProperty('issues');
    expect(JSON.stringify(caught)).not.toContain(privateMarker);
  });

  it.each([
    new Error('synthetic-private-error-message'),
    { structureReason: 'DIRECT_ORIGINAL_STRUCTURE_WIRE_PAYLOAD_INVALID', message: 'synthetic-private-value' },
    new Proxy({}, { getPrototypeOf() { throw new Error('synthetic-private-prototype-error'); } }),
    null,
    'DIRECT_ORIGINAL_WIRE_INVALID'
  ])('未知或仿冒异常只归类为unexpected，不解析外部错误文本', (error) => {
    expect(directOriginalStructureFailureReason(error)).toBe('DIRECT_ORIGINAL_STRUCTURE_DECODE_UNEXPECTED');
  });

  it.each((['forged_prototype', 'shadowed_real_error'] as const).flatMap((problem) =>
    (['data', 'getter'] as const).map((shadow) => ({ problem, shadow }))))('$problem/$shadow不能用同名自有属性覆盖固定诊断码', ({ problem, shadow }) => {
    let realError: unknown;
    try { decodeDirectOriginalReading(null); } catch (error) { realError = error; }
    expect(realError).toBeInstanceOf(Error);
    const error = problem === 'forged_prototype' ? Object.create(Object.getPrototypeOf(realError)) : realError;
    Object.defineProperty(error, 'structureReason', shadow === 'data' ? { value: 'synthetic-private-marker' }
      : { get() { throw new Error('synthetic-private-marker'); } });
    const reason = directOriginalStructureFailureReason(error);
    expect(reason).toBe(problem === 'forged_prototype'
      ? 'DIRECT_ORIGINAL_STRUCTURE_DECODE_UNEXPECTED' : 'DIRECT_ORIGINAL_STRUCTURE_ENVELOPE_INVALID');
    expect(reason).not.toContain('synthetic-private-marker');
  });

  const invalidMutations: Array<[string, (wire: DirectOriginalWireEnvelope) => void]> = [
    ['mixed long/short keys', (wire) => { wireCandidate(wire).originalName = '不允许混键'; }],
    ['unknown nested key', (wire) => { (wireCandidate(wire).va as JsonObject).arbitrary = null; }],
    ['missing required field', (wire) => { delete wireCandidate(wire).u; }],
    ['missing optional null slot', (wire) => { delete wireCandidate(wire, 1).sb; }],
    ['missing presence metadata', (wire) => { delete wireCandidate(wire)._p; }],
    ['presence non-array', (wire) => { wireCandidate(wire)._p = null; }],
    ['presence non-string key', (wire) => { wireCandidate(wire)._p = [5]; }],
    ['presence duplicate', (wire) => { wireCandidate(wire)._p = ['sb', 'sb']; }],
    ['presence required key', (wire) => { wireCandidate(wire)._p = ['va']; }],
    ['presence unknown key', (wire) => { wireCandidate(wire)._p = ['zz']; }],
    ['absent slot is non-null', (wire) => { wireCandidate(wire, 0).cc = { v: 1, st: 'complete', co: [] }; }],
    ['present nonnullable slot is null', (wire) => { wireCandidate(wire).sb = null; }],
    ['present sample array is null', (wire) => { wireMetadata(wire).si = null; }],
    ['presence on object without optional', (wire) => { (wireCandidate(wire).va as JsonObject)._p = []; }],
    ['wrong array type', (wire) => { payloadExtraction(wire).cs = {}; }],
    ['wrong numeric representation', (wire) => { (wireCandidate(wire).va as JsonObject).de = 250; }],
    ['wrong decimal syntax', (wire) => { (wireCandidate(wire).va as JsonObject).de = '2E2'; }],
    ['wrong enum', (wire) => { (wireCandidate(wire).va as JsonObject).cm = 'greater'; }],
    ['mixed union properties', (wire) => { (wireCandidate(wire).va as JsonObject).ct = 'positive'; }],
    ['wrong union branch type', (wire) => { (wireCandidate(wire).va as JsonObject).ty = 'qualitative'; }],
    ['null required string', (wire) => { wireCandidate(wire).n = null; }],
    ['negative selector index', (wire) => { wireMetadata(wire).pt = -1; }],
    ['noninteger selector index', (wire) => { wireMetadata(wire).pt = 0.5; }],
    ['unsafe integer selector index', (wire) => { wireMetadata(wire).pt = Number.MAX_SAFE_INTEGER + 1; }],
    ['wrong role string', (wire) => { (wireMetadata(wire).ts as JsonObject[])[0]!.ro = 'first_date'; }]
  ];
  it.each(invalidMutations)('解码前拒绝 %s，不用原文值猜测修复', (_name, mutate) => {
    const wire = encodeDirectOriginalReading(reading());
    mutate(wire);
    expect(() => decodeDirectOriginalReading(wire)).toThrow('DIRECT_ORIGINAL_WIRE_INVALID');
  });

  it('结构通过后仍执行原 canonical 的日期、文档与 key 唯一性 refinements', () => {
    const badDate = encodeDirectOriginalReading(reading());
    (wireMetadata(badDate).ts as JsonObject[])[0]!.va = '2026-02-30';
    expect(() => decodeDirectOriginalReading(badDate)).toThrow();
    const badPrecision = encodeDirectOriginalReading(reading());
    (wireMetadata(badPrecision).ts as JsonObject[])[0]!.pr = 'year';
    expect(() => decodeDirectOriginalReading(badPrecision)).toThrow();
    const badDocument = encodeDirectOriginalReading(reading());
    payloadExtraction(badDocument).d = 'different-document';
    expect(() => decodeDirectOriginalReading(badDocument)).toThrow('DIRECT_ORIGINAL_WIRE_CANONICAL_SCHEMA_INVALID');
    const duplicateKey = encodeDirectOriginalReading(reading());
    wireCandidate(duplicateKey, 1).k = wireCandidate(duplicateKey, 0).k;
    expect(() => decodeDirectOriginalReading(duplicateKey)).toThrow('DIRECT_ORIGINAL_WIRE_CANONICAL_SCHEMA_INVALID');
  });

  it('P03 也严格拒绝未知/缺键/presence/联合类型和错误 canonical hash 格式', () => {
    const wire = encodeDirectOriginalRepair(repair(reading()));
    const result = (wire.payload.rs as JsonObject[])[0]!;
    result.replacement = result.rp;
    expect(() => decodeDirectOriginalRepair(wire)).toThrow('DIRECT_ORIGINAL_WIRE_INVALID');
    const missing = encodeDirectOriginalRepair(repair(reading()));
    delete (missing.payload.rs as JsonObject[])[0]!.rp;
    expect(() => decodeDirectOriginalRepair(missing)).toThrow('DIRECT_ORIGINAL_WIRE_INVALID');
    const union = encodeDirectOriginalRepair(repair(reading()));
    ((union.payload.rs as JsonObject[])[0]!.rp as JsonObject).nt = 'unknown';
    expect(() => decodeDirectOriginalRepair(union)).toThrow('DIRECT_ORIGINAL_WIRE_INVALID');
    const hash = encodeDirectOriginalRepair(repair(reading()));
    hash.payload.oh = 'not-a-canonical-hash';
    expect(() => decodeDirectOriginalRepair(hash)).toThrow('DIRECT_ORIGINAL_WIRE_INVALID');
  });

  it('encoder 不把 JSON 不支持的 undefined/稀疏数组自动变成缺省或 null', () => {
    const undefinedField = reading();
    Object.defineProperty(undefinedField.extraction.candidates[0]!, 'clinicalContext', { value: undefined, enumerable: true });
    expect(() => encodeDirectOriginalReading(undefinedField)).toThrow('DIRECT_ORIGINAL_WIRE_CANONICAL_JSON_REQUIRED');
    const sparse = encodeDirectOriginalReading(reading());
    delete (sparse.payload.pg as unknown[])[1];
    expect(() => decodeDirectOriginalReading(sparse)).toThrow('DIRECT_ORIGINAL_WIRE_INVALID');
  });
});
