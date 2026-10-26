import { describe, expect, it } from 'vitest';
import { DIRECT_ORIGINAL_INPUT_KEY_MAP, DIRECT_ORIGINAL_INPUT_PROMPT_GUIDE, DIRECT_ORIGINAL_INPUT_SECTIONS,
  DIRECT_ORIGINAL_INPUT_VERSION, decodeDirectOriginalInput, encodeDirectOriginalInput,
  DIRECT_ORIGINAL_INPUT_V6_PROMPT_GUIDE, DIRECT_ORIGINAL_INPUT_V6_VERSION, encodeDirectOriginalInputV6,
  type DirectOriginalInputSection } from './direct-original-input.js';
import { buildDirectOriginalRepairPrompt } from './prompts/direct-original.js';
import { DIRECT_ORIGINAL_WIRE_PROMPT_GUIDE } from './direct-original-wire.js';

const ref = { sourceSpanId: 'e_1', quote: '左侧未见异常 <2.50E＋02', sourceRole: 'primary_finding', duplicateBasis: null };
function candidate(index = 1) {
  return { localKey: `c_${index}`, originalName: `合成项目-${index}`, standardNameCandidate: null,
    value: { kind: 'numeric', rawText: '<2.50E＋02', decimal: '250', comparator: 'lt' },
    unitRaw: 'U/L', referenceRangeRaw: null, reportedAbnormalFlag: 'unknown', specimen: null,
    method: '合成方法', bodySite: '左侧', clinicalDate: null,
    clinicalContext: { version: 1, status: 'complete', conditions: [{ sourceSpanId: 'e_date', quote: null }] },
    evidence: [ref, { ...ref, sourceRole: 'duplicate_source', duplicateBasis: 'same_finding' }],
    sourceBinding: { headingEvidence: [{ sourceSpanId: 'e_heading', quote: '合成栏目' }], findingEvidence: [ref] }, issues: [] };
}
function sections() {
  const source = { documentId: 'synthetic-document', sourceObjectId: 'synthetic-source', originalSha256: 'a'.repeat(64),
    totalUnits: 32, completeOriginal: true, nativeText: '合成完整原句\n否定：未见；左/右；<2.50E＋02；原输入字符串："localKey":"e_x"',
    units: Array.from({ length: 32 }, (_, index) => ({ sourceSpanId: `page-${index + 1}`, page: index + 1, inputKind: 'image' })),
    images: Array.from({ length: 32 }, (_, index) => ({ imageIndex: index, sourceSpanId: `page-${index + 1}`,
      page: index + 1, mediaType: 'image/png', sha256: 'b'.repeat(64), width: 1200, height: 1600 })),
    convertedViewSha256: null, conversionWarnings: [] };
  const request = { schemaVersion: 1, documentId: source.documentId, originalReadingHash: 'c'.repeat(64),
    allowedPageSourceSpanIds: source.units.map((unit) => unit.sourceSpanId),
    targets: [{ targetId: 'c_1', nodeType: 'candidate' }, { targetId: 'page-32', nodeType: 'page' }],
    issues: ['source_binding_requires_unique_mapping'], validationDiagnostics: [{ targetId: 'c_1',
      reasonCode: 'direct_original_evidence_role_mismatch', fieldPath: 'sourceBinding.headingEvidence[0]',
      sourceSpanId: 'e_1', actualRole: 'finding', allowedRoles: ['heading', 'context'],
      constraint: '标题与本候选结果必须满足同一来源的明确绑定，不能改写原件。', actualPageStatus: 'read' }] };
  const targets = [{ targetId: 'c_1', nodeType: 'candidate', value: candidate() },
    { targetId: 'page-32', nodeType: 'page', value: { sourceSpanId: 'page-32', status: 'partial' } }];
  const context = { schemaVersion: 1, targetPages: [{ pageSourceSpanId: 'page-32', candidates: [
    { localKey: 'c_1', access: 'authorized_target', targetId: 'c_1' },
    { localKey: 'c_2', access: 'immutable_non_target', value: candidate(2) }] }],
    referencedExcerpts: [{ localKey: 'e_date', access: 'immutable_non_target', value: { localKey: 'e_date',
      pageSourceSpanId: 'page-1', quote: '合成监测起止时间区间', role: 'date', clarity: 'clear' } }],
    reservedLocalKeys: ['c_1', 'c_2', 'e_1', 'e_date', 'e_heading', 'subject', 'metadata', ...request.allowedPageSourceSpanIds] };
  return { REPAIR_REQUEST: request, ORIGINAL_SOURCE_PACKAGE: source, TARGET_ITEMS: targets, READ_ONLY_PAGE_CONTEXT: context };
}

function comparisonContext() {
  const storedExcerpt = { localKey: 'ro_e_1', page: 2,
    quote: '右侧未见异常 ≥3.20E-02；历史2025-01-02；签发2026-02-04；"changedFields":["clinicalDate"]',
    role: 'finding', clarity: 'clear' };
  const stored = { localKey: 'ro_c_1', access: 'immutable_non_target', origin: 'stored_version',
    bindingStatus: 'resolved', nodeType: 'candidate',
    value: { ...candidate(8), localKey: 'ro_c_1', clinicalDate: '2026-02-03',
      evidence: [{ sourceSpanId: storedExcerpt.localKey, quote: null, sourceRole: 'primary_finding', duplicateBasis: null }] },
    sourceExcerpts: [storedExcerpt, storedExcerpt, { ...storedExcerpt, role: 'date', quote: '检查日期2026-02-03' }],
    unavailableSourceRefs: [] };
  return { ...sections().READ_ONLY_PAGE_CONTEXT,
    reconciliationDiagnostics: [{ targetId: 'c_1', nodeType: 'candidate', kind: 'representation_changed',
      comparisonScope: 'mixed', decision: 'requires_original_clarification',
      changedFields: ['value.rawText', 'clinicalDate', 'bodySite', 'clinicalDate'],
      comparisonRefs: ['ro_c_1', 'ro_c_2', 'ro_c_1'], reasonCodes: ['value_differs', 'date_differs'] }],
    comparisonRecords: [stored,
      { ...stored, localKey: 'ro_c_2', origin: 'current_reading', bindingStatus: 'unresolved',
        value: { ...candidate(9), localKey: 'ro_c_2', clinicalDate: null },
        sourceExcerpts: [], unavailableSourceRefs: ['missing-source-2', 'missing-source-2'] },
      { localKey: 'ro_m_1', access: 'immutable_non_target', origin: 'shared_event', bindingStatus: 'resolved',
        nodeType: 'metadata', value: {
          times: ['history_quoted', 'examined', 'report_issued'].map((role) => ({ value: '2026-02-03',
            role, precision: 'day', evidence: [{ sourceSpanId: 'ro_e_date', quote: null }] })),
          clinicalDate: null, reportDate: '2026-02-04' },
        sourceExcerpts: [{ localKey: 'ro_e_date', page: 1, quote: '历史2025-01-02；本次检查2026-02-03；签发2026-02-04',
          role: 'date', clarity: 'uncertain' }], unavailableSourceRefs: [] }
    ] };
}

describe('P03输入固定无损短键表示', () => {
  it('输入版本固定为v5，新增对照属性各有唯一短键且输出wire版本不变', () => {
    expect(DIRECT_ORIGINAL_INPUT_VERSION).toBe('direct-original-repair-input-v5');
    expect(DIRECT_ORIGINAL_INPUT_KEY_MAP).toMatchObject({ reconciliationDiagnostics: 'rd', comparisonRecords: 'cr',
      comparisonScope: 'cp', decision: 'dc', changedFields: 'ch', comparisonRefs: 'rf', origin: 'or',
      bindingStatus: 'bt', reasonCodes: 'rc', unavailableSourceRefs: 'ur', reportDate: 'rpd', comparisonSourceExcerpts: 'cx',
      validationConstraints: 'vct', constraintRef: 'ctr' });
    expect(DIRECT_ORIGINAL_INPUT_PROMPT_GUIDE).toContain('direct-original-repair-input-v5');
    expect(DIRECT_ORIGINAL_INPUT_PROMPT_GUIDE).toContain('只有输出sourceMappings[].comparisonRecordKey专槽');
    expect(DIRECT_ORIGINAL_INPUT_PROMPT_GUIDE).toContain('拒绝未知inputVersion或长短属性名混用');
    expect(DIRECT_ORIGINAL_WIRE_PROMPT_GUIDE).toContain('direct-original-wire-v1');
  });
  it('映射完整固定一对一，长短键互不重叠，不修改任何字段字符串', () => {
    const keys = Object.keys(DIRECT_ORIGINAL_INPUT_KEY_MAP); const aliases = Object.values(DIRECT_ORIGINAL_INPUT_KEY_MAP);
    expect(new Set(aliases).size).toBe(keys.length);
    expect(aliases.some((alias) => keys.includes(alias))).toBe(false);
    const all = Object.fromEntries(keys.filter((key) => !['validationConstraints', 'constraintRef'].includes(key))
      .map((key) => [key, `${key}: 原字符串 <2.50E＋02 左侧未见异常` ]));
    expect(decodeDirectOriginalInput('REPAIR_REQUEST', encodeDirectOriginalInput('REPAIR_REQUEST', all))).toEqual(all);
  });
  it.each(DIRECT_ORIGINAL_INPUT_SECTIONS)('%s经过JSON传输严格还原，所有原值、顺序、重复角色不变', (section) => {
    const data = sections()[section]; const before = JSON.stringify(data);
    const envelope = encodeDirectOriginalInput(section, data);
    expect(envelope.inputVersion).toBe(DIRECT_ORIGINAL_INPUT_VERSION);
    expect(envelope.section).toBe(section);
    expect(decodeDirectOriginalInput(section, JSON.parse(JSON.stringify(envelope)))).toStrictEqual(data);
    expect(JSON.stringify(data)).toBe(before);
  });
  it('absence/null/空数组/零/false互不转化，输入不添加presence或缺省槽', () => {
    const absent = { documentId: 'synthetic', times: [], completeOriginal: false, totalUnits: 0 };
    const explicitNull = { ...absent, primaryClinicalTimeIndex: null, nativeText: null };
    for (const data of [absent, explicitNull]) {
      const envelope = encodeDirectOriginalInput('REPAIR_REQUEST', data);
      expect(JSON.stringify(envelope)).not.toContain('"_p"');
      const decoded = decodeDirectOriginalInput('REPAIR_REQUEST', JSON.parse(JSON.stringify(envelope))) as typeof explicitNull;
      expect(decoded).toStrictEqual(data);
      expect(Object.hasOwn(decoded, 'primaryClinicalTimeIndex')).toBe(Object.hasOwn(data, 'primaryClinicalTimeIndex'));
      expect(Object.hasOwn(decoded, 'nativeText')).toBe(Object.hasOwn(data, 'nativeText'));
    }
  });
  it('科学计数边界、左右否定、历史/临床/签发角色及readonly权限原样保留', () => {
    const data = sections(); data.READ_ONLY_PAGE_CONTEXT.referencedExcerpts.push({ localKey: 'e_extra',
      access: 'immutable_non_target', value: { localKey: 'e_extra', pageSourceSpanId: 'page-2',
        quote: '右侧未见异常 >=3.20E-02；历史旧时间；签发时间不是检查时间', role: 'date', clarity: 'clear' } });
    const decoded = decodeDirectOriginalInput('READ_ONLY_PAGE_CONTEXT', encodeDirectOriginalInput('READ_ONLY_PAGE_CONTEXT', data.READ_ONLY_PAGE_CONTEXT));
    expect(decoded).toStrictEqual(data.READ_ONLY_PAGE_CONTEXT);
    const dates = { times: ['history_quoted', 'examined', 'report_issued'].map((role) => ({ value: '2026-02-03',
      role, precision: 'day', evidence: [{ sourceSpanId: 'e_date', quote: null }] })), primaryClinicalTimeIndex: 1 };
    expect(decodeDirectOriginalInput('REPAIR_REQUEST', encodeDirectOriginalInput('REPAIR_REQUEST', dates))).toStrictEqual(dates);
  });
  it('共享对象按原重复次数与顺序发送，不去重或删引用', () => {
    const input = [ref, ref, { ...ref, sourceRole: 'duplicate_source' }];
    const result = decodeDirectOriginalInput('TARGET_ITEMS', encodeDirectOriginalInput('TARGET_ITEMS', input));
    expect(result).toStrictEqual(input); expect(result).toHaveLength(3);
  });
  it('差异诊断与全部对照逐字段严格roundtrip，保留原句、空值、角色、顺序和重复', () => {
    const input = comparisonContext(); const before = JSON.stringify(input);
    const envelope = encodeDirectOriginalInput('READ_ONLY_PAGE_CONTEXT', input);
    const decoded = decodeDirectOriginalInput('READ_ONLY_PAGE_CONTEXT', JSON.parse(JSON.stringify(envelope))) as typeof input;
    expect(decoded).toStrictEqual(input);
    expect(JSON.stringify(input)).toBe(before);
    expect(decoded.comparisonRecords.map((item) => item.origin)).toEqual(['stored_version', 'current_reading', 'shared_event']);
    expect(decoded.comparisonRecords[0]!.sourceExcerpts).toHaveLength(3);
    expect(decoded.reconciliationDiagnostics[0]!.changedFields).toEqual(['value.rawText', 'clinicalDate', 'bodySite', 'clinicalDate']);
    expect(decoded.reconciliationDiagnostics[0]!.comparisonRefs).toEqual(['ro_c_1', 'ro_c_2', 'ro_c_1']);
    expect(decoded.comparisonRecords[1]!.unavailableSourceRefs).toEqual(['missing-source-2', 'missing-source-2']);
  });
  it.each(['none', 'current_reading', 'stored_version', 'mixed', 'shared_event'])('真实预检comparisonScope=%s不被原因改写', (comparisonScope) => {
    const input = { reconciliationDiagnostics: [{ targetId: 'metadata', nodeType: 'metadata', kind: 'date_changed',
      comparisonScope, decision: null, changedFields: [], comparisonRefs: [], reasonCodes: ['same_reason'] }],
      comparisonRecords: [], reportDate: null };
    expect(decodeDirectOriginalInput('READ_ONLY_PAGE_CONTEXT', encodeDirectOriginalInput('READ_ONLY_PAGE_CONTEXT', input)))
      .toStrictEqual(input);
  });
  it('全局共享对照原句只存一处，记录指针、evidence、日期条件和栏目绑定均原样保留', () => {
    const sharedRef = { sourceSpanId: 'ro_source_1', quote: null, sourceRole: 'primary_finding', duplicateBasis: null };
    const value = { ...candidate(), localKey: 'ro_c_1',
      evidence: [sharedRef, sharedRef],
      clinicalContext: { version: 1, status: 'complete', conditions: [{ sourceSpanId: 'ro_source_1', quote: null }] },
      sourceBinding: { headingEvidence: [{ sourceSpanId: 'ro_source_2', quote: null }], findingEvidence: [sharedRef] } };
    const record = { localKey: 'ro_c_1', access: 'immutable_non_target', origin: 'stored_version', bindingStatus: 'resolved',
      nodeType: 'candidate', value, sourceExcerpts: [{ localKey: 'ro_source_1' }, { localKey: 'ro_source_2' }], unavailableSourceRefs: [] };
    const input = { comparisonSourceExcerpts: [
      { localKey: 'ro_source_1', page: 2, quote: '唯一共享原句：2026-02-03检查；右侧未见异常 ≥3.20E-02', role: 'date', clarity: 'clear' },
      { localKey: 'ro_source_2', page: 2, quote: '合成栏目', role: 'heading', clarity: 'clear' }
    ], comparisonRecords: [record, { ...record, localKey: 'ro_c_2', value: { ...value, localKey: 'ro_c_2' } }] };
    const encoded = JSON.stringify(encodeDirectOriginalInput('READ_ONLY_PAGE_CONTEXT', input));
    expect(encoded.split('唯一共享原句').length - 1).toBe(1);
    expect(decodeDirectOriginalInput('READ_ONLY_PAGE_CONTEXT', JSON.parse(encoded))).toStrictEqual(input);
    expect(DIRECT_ORIGINAL_INPUT_PROMPT_GUIDE).toContain('comparisonSourceExcerpts是只读全局来源目录');
    expect(DIRECT_ORIGINAL_INPUT_PROMPT_GUIDE).toContain('sourceExcerpts仅保存localKey指针');
  });
  it('只读对照不扩张请求目标，也不把ro编号转换成当前摘录或候选', () => {
    const data = sections(); const context = comparisonContext();
    const prompt = buildDirectOriginalRepairPrompt(data.REPAIR_REQUEST, data.ORIGINAL_SOURCE_PACKAGE, data.TARGET_ITEMS, context);
    const block = (section: DirectOriginalInputSection) => JSON.parse(prompt.split('\n').find((line) => line.startsWith(`${section}=`))!.slice(section.length + 1));
    expect(decodeDirectOriginalInput('REPAIR_REQUEST', block('REPAIR_REQUEST'))).toStrictEqual(data.REPAIR_REQUEST);
    expect(decodeDirectOriginalInput('TARGET_ITEMS', block('TARGET_ITEMS'))).toStrictEqual(data.TARGET_ITEMS);
    expect(decodeDirectOriginalInput('READ_ONLY_PAGE_CONTEXT', block('READ_ONLY_PAGE_CONTEXT'))).toStrictEqual(context);
  });
  it('null目录明确保留，四块标签与版本一致且payload不含额外权限', () => {
    const empty = encodeDirectOriginalInput('READ_ONLY_PAGE_CONTEXT', null);
    expect(empty).toEqual({ inputVersion: DIRECT_ORIGINAL_INPUT_VERSION, section: 'READ_ONLY_PAGE_CONTEXT', payload: null });
    expect(decodeDirectOriginalInput('READ_ONLY_PAGE_CONTEXT', empty)).toBeNull();
    const readonly = encodeDirectOriginalInput('READ_ONLY_PAGE_CONTEXT', sections().READ_ONLY_PAGE_CONTEXT);
    expect(Object.keys(readonly).every((key) => ['inputVersion', 'section', 'payload', 'valueTable', 'objectShapes'].includes(key))).toBe(true);
    expect(decodeDirectOriginalInput('READ_ONLY_PAGE_CONTEXT', readonly)).toStrictEqual(sections().READ_ONLY_PAGE_CONTEXT);
  });
  it('完整packet含映射guide仍减少表示字节，全32原图及canonical修复hash不变', () => {
    const data = sections(); const large = Array.from({ length: 230 }, (_, index) => ({ targetId: `c_${index + 1}`, nodeType: 'candidate', value: candidate(index + 1) }));
    const prompt = buildDirectOriginalRepairPrompt(data.REPAIR_REQUEST, data.ORIGINAL_SOURCE_PACKAGE, large, data.READ_ONLY_PAGE_CONTEXT);
    const block = (section: DirectOriginalInputSection) => JSON.parse(prompt.split('\n').find((line) => line.startsWith(`${section}=`))!.slice(section.length + 1));
    expect(decodeDirectOriginalInput('TARGET_ITEMS', block('TARGET_ITEMS'))).toStrictEqual(large);
    expect(decodeDirectOriginalInput('ORIGINAL_SOURCE_PACKAGE', block('ORIGINAL_SOURCE_PACKAGE'))).toStrictEqual(data.ORIGINAL_SOURCE_PACKAGE);
    expect(decodeDirectOriginalInput('REPAIR_REQUEST', block('REPAIR_REQUEST'))).toStrictEqual(data.REPAIR_REQUEST);
    expect(prompt).toContain(DIRECT_ORIGINAL_WIRE_PROMPT_GUIDE);
    expect(prompt).toContain(DIRECT_ORIGINAL_INPUT_V6_PROMPT_GUIDE);
    const oldBody = JSON.stringify({ ...data, TARGET_ITEMS: large });
    const encodedBody = DIRECT_ORIGINAL_INPUT_SECTIONS.map((section) => `${section}=${JSON.stringify(block(section))}`).join('\n');
    expect(Buffer.byteLength(encodedBody + DIRECT_ORIGINAL_INPUT_V6_PROMPT_GUIDE)).toBeLessThan(Buffer.byteLength(oldBody));
    expect(data.ORIGINAL_SOURCE_PACKAGE.images).toHaveLength(32);
  });
});

describe('P03诊断约束只读目录无损去重', () => {
  const encode = (value: unknown) => encodeDirectOriginalInput('REPAIR_REQUEST', value);
  const decode = (value: unknown) => decodeDirectOriginalInput('REPAIR_REQUEST', value);
  const constraint = '合成完整约束：左侧未散瞳，不可按正常解释；保留<2.50E＋02及临床/签发角色；原字符串"constraintRef":null。\n';

  it('只按完整约束字符串去重，不按reasonCode合并；顺序、空值与原字段位置逐字还原', () => {
    const input = { schemaVersion: 1, validationDiagnostics: [
      { targetId: 'c_2', reasonCode: 'same_reason', constraint, actualRole: null, allowedRoles: [], actualPageStatus: null },
      { targetId: 'c_1', reasonCode: 'same_reason', constraint: `${constraint} `, fieldPath: 'evidence[0].quote' },
      { targetId: 'c_2', reasonCode: 'different_reason', constraint, fieldPath: 'originalName' },
      { targetId: 'c_3', reasonCode: 'same_reason', constraint: constraint.normalize('NFKC'), sourceSpanId: 'e_3' }
    ], issues: [] };
    const before = JSON.stringify(input);
    const envelope = encode(input);
    const payload = envelope.payload as { vd: Record<string, unknown>[]; vct: string[] };
    expect(payload.vct).toStrictEqual([constraint, `${constraint} `, constraint.normalize('NFKC')]);
    expect(payload.vd.map((item) => item.ctr)).toEqual([0, 1, 0, 2]);
    expect(payload.vd.every((item) => !Object.hasOwn(item, 'cst'))).toBe(true);
    const restored = decode(JSON.parse(JSON.stringify(envelope))) as typeof input;
    expect(restored).toStrictEqual(input);
    expect(JSON.stringify(restored)).toBe(before);
    expect(JSON.stringify(input)).toBe(before);
    expect(Object.hasOwn(restored, 'validationConstraints')).toBe(false);
    expect(restored.validationDiagnostics.every((item) => !Object.hasOwn(item, 'constraintRef'))).toBe(true);
    expect(DIRECT_ORIGINAL_INPUT_PROMPT_GUIDE).toContain('从0开始的整数下标');
    expect(DIRECT_ORIGINAL_INPUT_PROMPT_GUIDE).toContain('不能按reasonCode猜测约束');
  });

  it.each([43, 200])('%i条重复约束只传一份原句，显著减小字节且完整roundtrip', (count) => {
    const repeated = constraint.repeat(4);
    const input = { validationDiagnostics: Array.from({ length: count }, (_, index) => ({
      targetId: `c_${index}`, reasonCode: 'same_reason', fieldPath: 'sourceBinding.findingEvidence[0]', constraint: repeated
    })) };
    const envelope = encode(input);
    const payload = envelope.payload as { vd: Record<string, unknown>[]; vct: string[] };
    expect(payload.vct).toStrictEqual([repeated]);
    expect((decode(envelope) as typeof input).validationDiagnostics.every((item) => item.constraint === repeated)).toBe(true);
    const inline = { ...envelope, payload: { vd: input.validationDiagnostics.map((item) => ({
      ta: item.targetId, rcd: item.reasonCode, fp: item.fieldPath, cst: item.constraint
    })) } };
    const saved = Buffer.byteLength(JSON.stringify(inline)) - Buffer.byteLength(JSON.stringify(envelope));
    expect(saved).toBeGreaterThan((count - 1) * Buffer.byteLength(repeated) * .95);
    expect(saved).toBeGreaterThan(17 * 1024);
    expect(decode(JSON.parse(JSON.stringify(envelope)))).toStrictEqual(input);
  });

  it('单条超过256KiB的完整约束不截断、不规范化，重复目录还原后结尾仍完整', () => {
    const huge = `${'完整约束'.repeat(23_000)}\n末尾：右侧未见异常 ≥3.20E-02，签发不是检查时间。\u0000`;
    expect(Buffer.byteLength(huge)).toBeGreaterThan(256 * 1024);
    const input = { validationDiagnostics: [{ targetId: 'c_1', constraint: huge }, { constraint: huge, targetId: 'c_2' }] };
    const envelope = encode(input);
    expect((envelope.payload as { vct: string[] }).vct).toStrictEqual([huge]);
    const restored = decode(JSON.parse(JSON.stringify(envelope)));
    expect(restored).toStrictEqual(input);
    expect(JSON.stringify(restored)).toBe(JSON.stringify(input));
  });

  it.each([[], null, [{ targetId: 'c_1', constraint: null }], [{ targetId: 'c_1' }],
    [{ targetId: 'c_1', constraint }, { targetId: 'c_2', constraint: null }]])('空诊断和显式空值保留原表示，不凭缺省补约束 %#', (validationDiagnostics) => {
    const input = { validationDiagnostics, reportDate: null };
    const envelope = encode(input);
    expect(Object.hasOwn(envelope.payload as object, 'vct')).toBe(false);
    expect(decode(JSON.parse(JSON.stringify(envelope)))).toStrictEqual(input);
  });
});

describe('P03输入非法表示固定错误码并fail closed', () => {
  const fail = (value: unknown) => expect(() => encodeDirectOriginalInput('REPAIR_REQUEST', value)).toThrowError('DIRECT_ORIGINAL_INPUT_INVALID');
  it.each([{ unknownField: '私密字符串不能出现在错误中' }, { d: 'alias' }, { documentId: 'x', d: 'mixed' },
    { _p: [] }, JSON.parse('{"__proto__":{"documentId":"x"}}'), JSON.parse('{"constructor":{}}')])('拒绝未知、长短混合或prototype属性 %#', (value) => fail(value));
  it.each([undefined, () => null, Symbol('synthetic'), 1n, NaN, Infinity, -Infinity, -0,
    new Date('2026-01-01'), new Map(), new Set(), new Uint8Array([1])])('拒绝无法无损JSON表示的值 %#', (value) => fail({ value }));
  it('拒绝循环、getter、symbol、非枚举属性以及自定义prototype', () => {
    const cyclic: Record<string, unknown> = {}; cyclic.value = cyclic;
    const getter = Object.defineProperty({}, 'value', { enumerable: true, get() { throw new Error('PRIVATE_GETTER'); } });
    for (const data of [cyclic, getter, { [Symbol('synthetic')]: 'x' }, Object.defineProperty({}, 'value', { value: 1 }),
      Object.assign(Object.create({ value: 1 }), { documentId: 'x' })]) fail(data);
  });
  it('拒绝代理且不执行代理或getter', () => {
    let calls = 0;
    const proxy = new Proxy({}, { getPrototypeOf() { calls++; throw new Error('PRIVATE_PROXY'); } });
    fail(proxy); expect(calls).toBe(0);
    const arrayProxy = new Proxy([], { get() { calls++; throw new Error('PRIVATE_PROXY'); } });
    fail({ value: arrayProxy }); expect(calls).toBe(0);
  });
  it('拒绝稀疏数组、隐藏属性、非索引属性、getter和数组子类', () => {
    class CustomArray extends Array<unknown> {}
    const getterArray = Object.defineProperty([1], '0', { enumerable: true, get() { throw new Error('PRIVATE_GETTER'); } });
    for (const array of [Array(2), Object.assign([1], { value: 2 }), Object.defineProperty([1], 'value', { value: 2 }),
      getterArray, new CustomArray(1)]) fail({ value: array });
  });
  it('过深嵌套固定拒绝，不输出内层私密值', () => {
    let value: unknown = 'PRIVATE'; for (let index = 0; index < 130; index++) value = { value };
    fail(value);
  });
  it('decoder不接受长领域JSON、输出wire、坏版本、错section或额外封装字段', () => {
    const good = encodeDirectOriginalInput('REPAIR_REQUEST', { documentId: 'x' });
    for (const data of [{ documentId: 'x' }, { wireVersion: 'direct-original-wire-v1', contract: 'repair', payload: {} },
      { ...good, inputVersion: 'direct-original-repair-input-v1' }, { ...good, inputVersion: 'future' },
      { ...good, section: 'TARGET_ITEMS' }, { ...good, contract: 'repair' },
      { ...good, payload: { documentId: 'long' } }, { ...good, payload: { d: 'short', documentId: 'long' } },
      { ...good, payload: { rd: [{ cp: 'stored_version', comparisonScope: 'mixed' }] } },
      { ...good, payload: { cr: [{ or: 'stored_version', unknownComparisonField: null }] } }]) {
      expect(() => decodeDirectOriginalInput('REPAIR_REQUEST', data)).toThrowError('DIRECT_ORIGINAL_INPUT_INVALID');
    }
  });
  it('错误section根类型或不支持标签都拒绝，不凭JSON形状猜版本', () => {
    for (const [section, value] of [['REPAIR_REQUEST', []], ['ORIGINAL_SOURCE_PACKAGE', null], ['TARGET_ITEMS', {}],
      ['READ_ONLY_PAGE_CONTEXT', []], ['OTHER', {}]] as const) {
      expect(() => encodeDirectOriginalInput(section as DirectOriginalInputSection, value)).toThrowError('DIRECT_ORIGINAL_INPUT_INVALID');
    }
    const targetEnvelope = { inputVersion: DIRECT_ORIGINAL_INPUT_VERSION, section: 'TARGET_ITEMS', payload: {} };
    expect(() => decodeDirectOriginalInput('TARGET_ITEMS', targetEnvelope)).toThrowError('DIRECT_ORIGINAL_INPUT_INVALID');
  });
  it('固定错误信息不包含未知属性、值或原件路径', () => {
    try { encodeDirectOriginalInput('REPAIR_REQUEST', { private_path_name: '/synthetic/private/path' }); }
    catch (error) { expect((error as Error).message).toBe('DIRECT_ORIGINAL_INPUT_INVALID'); }
  });

  it.each(['validationConstraints', 'constraintRef'])('canonical不能注入传输专用字段%s，也不能嵌套注入', (key) => {
    fail({ [key]: 'PRIVATE' });
    fail({ value: { [key]: null } });
  });

  it.each(['missing-directory', 'null-directory', 'string-directory', 'empty-directory', 'non-string-directory',
    'duplicate-directory', 'unused-directory', 'missing-diagnostics', 'empty-diagnostics', 'invalid-diagnostic',
    'missing-ref', 'null-ref', 'string-ref', 'negative-ref', 'fraction-ref', 'overflow-ref', 'unsafe-ref', 'negative-zero-ref',
    'inline-and-ref', 'inline-mixed', 'nested-ref', 'nested-directory', 'long-key', 'unknown-key'] as const)(
    '拒绝%s，不以猜测补全目录或引用', (kind) => {
      const envelope = encodeDirectOriginalInput('REPAIR_REQUEST', { validationDiagnostics: [
        { targetId: 'c_1', constraint: '约束甲' }, { targetId: 'c_2', constraint: '约束乙' }
      ] });
      const payload = envelope.payload as { vd?: Record<string, unknown>[]; vct?: unknown; [key: string]: unknown };
      if (kind === 'missing-directory') delete payload.vct;
      if (kind === 'null-directory') payload.vct = null;
      if (kind === 'string-directory') payload.vct = '约束甲';
      if (kind === 'empty-directory') payload.vct = [];
      if (kind === 'non-string-directory') payload.vct = ['约束甲', null];
      if (kind === 'duplicate-directory') payload.vct = ['约束甲', '约束甲'];
      if (kind === 'unused-directory') payload.vct = ['约束甲', '约束乙', '未被引用的约束'];
      if (kind === 'missing-diagnostics') delete payload.vd;
      if (kind === 'empty-diagnostics') payload.vd = [];
      if (kind === 'invalid-diagnostic') payload.vd = [null as unknown as Record<string, unknown>];
      if (kind === 'missing-ref') delete payload.vd![0]!.ctr;
      if (kind === 'null-ref') payload.vd![0]!.ctr = null;
      if (kind === 'string-ref') payload.vd![0]!.ctr = '0';
      if (kind === 'negative-ref') payload.vd![0]!.ctr = -1;
      if (kind === 'fraction-ref') payload.vd![0]!.ctr = .5;
      if (kind === 'overflow-ref') payload.vd![0]!.ctr = 2;
      if (kind === 'unsafe-ref') payload.vd![0]!.ctr = Number.MAX_SAFE_INTEGER + 1;
      if (kind === 'negative-zero-ref') payload.vd![0]!.ctr = -0;
      if (kind === 'inline-and-ref') payload.vd![0]!.cst = '约束甲';
      if (kind === 'inline-mixed') { delete payload.vd![0]!.ctr; payload.vd![0]!.cst = '约束甲'; }
      if (kind === 'nested-ref') payload.sb = { ctr: 0 };
      if (kind === 'nested-directory') payload.sb = { vct: ['约束甲'] };
      if (kind === 'long-key') payload.validationConstraints = ['约束甲'];
      if (kind === 'unknown-key') payload.vd![0]!.unknownConstraintReference = 0;
      expect(() => decodeDirectOriginalInput('REPAIR_REQUEST', envelope)).toThrowError('DIRECT_ORIGINAL_INPUT_INVALID');
    });

  it('目录仅限REPAIR_REQUEST，其他section及目录外悬空ref均严格拒绝', () => {
    const payload = { vct: ['约束甲'], vd: [{ ta: 'c_1', ctr: 0 }] };
    for (const section of ['READ_ONLY_PAGE_CONTEXT', 'ORIGINAL_SOURCE_PACKAGE'] as const) {
      expect(() => decodeDirectOriginalInput(section, { inputVersion: DIRECT_ORIGINAL_INPUT_VERSION, section, payload }))
        .toThrowError('DIRECT_ORIGINAL_INPUT_INVALID');
    }
    for (const payload of [{ ctr: 0 }, { vd: [{ ta: 'c_1', ctr: 0 }] }, { sb: { ctr: 0 } }]) {
      expect(() => decodeDirectOriginalInput('REPAIR_REQUEST', { inputVersion: DIRECT_ORIGINAL_INPUT_VERSION,
        section: 'REPAIR_REQUEST', payload })).toThrowError('DIRECT_ORIGINAL_INPUT_INVALID');
    }
  });

  it('恶意目录getter或代理在还原前被拒绝，绝不执行用户代码', () => {
    let calls = 0;
    const getter = Object.defineProperty({ vd: [{ ta: 'c_1', ctr: 0 }] }, 'vct', {
      enumerable: true, get() { calls++; throw new Error('PRIVATE_GETTER'); }
    });
    const directory = new Proxy(['约束甲'], { get() { calls++; throw new Error('PRIVATE_PROXY'); } });
    const refGetter = { vct: ['约束甲'], vd: [Object.defineProperty({ ta: 'c_1' }, 'ctr', {
      enumerable: true, get() { calls++; throw new Error('PRIVATE_GETTER'); }
    })] };
    for (const payload of [getter, { vct: directory, vd: [{ ta: 'c_1', ctr: 0 }] }, refGetter]) {
      expect(() => decodeDirectOriginalInput('REPAIR_REQUEST', { inputVersion: DIRECT_ORIGINAL_INPUT_VERSION,
        section: 'REPAIR_REQUEST', payload })).toThrowError('DIRECT_ORIGINAL_INPUT_INVALID');
    }
    expect(calls).toBe(0);
  });
});

describe('P03逐块精确值目录与列头行表示', () => {
  const wrap = (payload: unknown, extra: Record<string, unknown> = {}) => ({
    inputVersion: DIRECT_ORIGINAL_INPUT_VERSION, section: 'TARGET_ITEMS', payload, ...extra
  });
  const decode = (envelope: unknown) => decodeDirectOriginalInput('TARGET_ITEMS', envelope);
  const fails = (envelope: unknown) => expect(() => decode(envelope)).toThrowError('DIRECT_ORIGINAL_INPUT_INVALID');
  const longText = '合成完整说明：右侧未见异常；保留原句及<2.50E＋02，不可改写为正常。';
  const shortKeys = (value: unknown): unknown => Array.isArray(value) ? value.map(shortKeys)
    : value !== null && typeof value === 'object' ? Object.fromEntries(Object.entries(value)
      .map(([key, child]) => [DIRECT_ORIGINAL_INPUT_KEY_MAP[key]!, shortKeys(child)])) : value;

  it('不同重复父对象共享长原句时选择子树优先平目录，不再各存一份相同原句', () => {
    const quote = longText.repeat(80);
    const make = (localKey: string) => ({ localKey, originalName: `合成项目-${localKey}`,
      value: { kind: 'text', rawText: quote }, issues: [] });
    const a = make('c_A'); const b = make('c_B'); const input = [a, b, a, b];
    const before = JSON.stringify(input);
    const parentFirst = wrap([{ _ref: 0 }, { _ref: 1 }, { _ref: 0 }, { _ref: 1 }], {
      valueTable: [shortKeys(a), shortKeys(b)] });
    const envelope = encodeDirectOriginalInput('TARGET_ITEMS', input);
    expect(JSON.stringify(envelope).split(quote).length - 1).toBe(1);
    expect(Buffer.byteLength(JSON.stringify(envelope))).toBeLessThan(Buffer.byteLength(JSON.stringify(parentFirst)) * .6);
    expect(JSON.stringify(envelope.valueTable)).not.toContain('"_ref"');
    expect(JSON.stringify(decode(parentFirst))).toBe(before);
    expect(JSON.stringify(decode(JSON.parse(JSON.stringify(envelope))))).toBe(before);
    expect(JSON.stringify(input)).toBe(before);
  });

  it('整父对象高度重复更省字节时保留父优先，子树优先不得使现有表示退化', () => {
    const parent = { originalName: '合成固定项目', value: { rawText: longText.repeat(20) } };
    const input = Array.from({ length: 100 }, () => parent);
    const parentFirst = wrap(input.map(() => ({ _ref: 0 })), { valueTable: [shortKeys(parent)] });
    const envelope = encodeDirectOriginalInput('TARGET_ITEMS', input);
    expect(envelope).toStrictEqual(parentFirst);
    expect(JSON.stringify(decode(JSON.parse(JSON.stringify(envelope))))).toBe(JSON.stringify(input));
  });

  it('子树优先保持宽行结构槽、多来源角色、日期与比较符及重复数组的逐字顺序', () => {
    const quote = `${longText.repeat(20)}历史2025-01-02；检查2026-02-03；签发2026-02-04；>=3.20E-02。`;
    const source = (sourceRole: string) => ({ sourceSpanId: 'e_shared', quote, sourceRole,
      duplicateBasis: sourceRole === 'duplicate_source' ? 'same_finding' : null });
    const make = (index: number) => ({ ...candidate(index),
      value: { kind: 'numeric', rawText: '<2.50E＋02', decimal: '250', comparator: 'lt' },
      evidence: [source('primary_finding'), source('duplicate_source'), source('primary_finding')],
      sourceBinding: { headingEvidence: [{ sourceSpanId: 'e_heading', quote }],
        findingEvidence: [source('primary_finding')] },
      clinicalDate: index % 2 ? null : '2026-02-03',
      clinicalContext: { version: 1, status: 'complete', conditions: [
        { sourceSpanId: 'e_date', quote: null }, { sourceSpanId: 'e_date', quote: null }] }, issues: [] });
    const parents = Array.from({ length: 20 }, (_, index) => make(index));
    const input = parents.flatMap((parent) => [parent, parent]); const before = JSON.stringify(input);
    const envelope = encodeDirectOriginalInput('TARGET_ITEMS', input);
    expect(envelope.objectShapes?.length).toBeGreaterThan(0);
    expect(JSON.stringify(envelope.valueTable)).not.toContain('"_ref"');
    expect(JSON.stringify(envelope).split(quote).length - 1).toBe(1);
    expect(JSON.stringify(decode(JSON.parse(JSON.stringify(envelope))))).toBe(before);
    expect(JSON.stringify(input)).toBe(before);
    const checkRows = (value: unknown): void => {
      if (Array.isArray(value)) { value.forEach(checkRows); return; }
      if (!value || typeof value !== 'object') return;
      if (Object.hasOwn(value, '_row')) expect(Array.isArray((value as { _row: unknown })._row)).toBe(true);
      Object.values(value).forEach(checkRows);
    };
    checkRows(envelope.payload); envelope.valueTable?.forEach(checkRows);
  });

  it('领域数组恰与生成行数组相同时，两种策略也不把_row结构槽替换为引用', () => {
    const input = Array.from({ length: 40 }, (_, index) => {
      const cells = [`k_${index}_synthetic_a`, `n_${index}_synthetic_b`, `u_${index}_synthetic_c`];
      return [{ localKey: cells[0], originalName: cells[1], unitRaw: cells[2] }, { value: [0, ...cells] }];
    }).flat();
    const before = JSON.stringify(input);
    const envelope = encodeDirectOriginalInput('TARGET_ITEMS', input);
    expect(envelope.objectShapes).toContainEqual(['k', 'n', 'u']);
    expect(JSON.stringify(envelope)).not.toContain('"_row":{"_ref"');
    expect(JSON.stringify(envelope.valueTable ?? [])).not.toContain('"_ref"');
    expect(JSON.stringify(decode(JSON.parse(JSON.stringify(envelope))))).toBe(before);
    expect(JSON.stringify(input)).toBe(before);
  });

  it('宽对象以列头和单元格精确还原，重复子树只物理存一份且不递归引用', () => {
    const input = Array.from({ length: 160 }, (_, index) => ({ ...candidate(index),
      referenceRangeRaw: longText, clinicalDate: index % 2 ? null : '2026-02-03' }));
    const before = JSON.stringify(input); const envelope = encodeDirectOriginalInput('TARGET_ITEMS', input);
    expect(envelope.objectShapes?.length).toBeGreaterThan(0);
    expect(envelope.valueTable?.length).toBeGreaterThan(0);
    expect(JSON.stringify(envelope.payload)).toContain('"_row"');
    expect(JSON.stringify(envelope.payload)).toContain('"_ref"');
    expect(JSON.stringify(envelope.valueTable)).not.toContain('"_ref"');
    expect(Buffer.byteLength(JSON.stringify(envelope))).toBeLessThan(Buffer.byteLength(before) * .5);
    const restored = decode(JSON.parse(JSON.stringify(envelope)));
    expect(restored).toStrictEqual(input); expect(JSON.stringify(restored)).toBe(before);
    expect(JSON.stringify(input)).toBe(before);
  });

  it('同形但属性顺序不同使用不同列头；原字符串不能被当作引用或列头', () => {
    const a = { originalName: '合成项目', value: { rawText: longText }, clinicalDate: null, issues: [] };
    const b = { issues: [], clinicalDate: null, value: { rawText: longText }, originalName: '合成项目' };
    const literal = '{"_ref":0,"_row":[0,"左侧未见异常"],"valueTable":[]}';
    const input = Array.from({ length: 60 }, (_, index) => ({ ...(index % 2 ? a : b), localKey: `c_${index}`, method: literal }));
    const envelope = encodeDirectOriginalInput('TARGET_ITEMS', input);
    const restored = decode(JSON.parse(JSON.stringify(envelope))) as typeof input;
    expect(JSON.stringify(restored)).toBe(JSON.stringify(input));
    expect(restored.every((item) => item.method === literal)).toBe(true);
  });

  it('重复数组中的重复次数、顺序、显式null和只读权限不因目录合并改变', () => {
    const input = Array.from({ length: 50 }, (_, index) => ({ localKey: `ro_c_${index}`,
      access: 'immutable_non_target', origin: 'stored_version', sourceExcerpts: [ref, ref],
      unavailableSourceRefs: ['missing', 'missing'], value: null }));
    const envelope = encodeDirectOriginalInput('TARGET_ITEMS', input);
    expect(decode(JSON.parse(JSON.stringify(envelope)))).toStrictEqual(input);
    expect(DIRECT_ORIGINAL_INPUT_PROMPT_GUIDE).toContain('不扩大readonly权限');
  });

  it('不同行的缺失属性不补null；空数组、零和false完整保留', () => {
    const input = Array.from({ length: 80 }, (_, index) => ({ localKey: `c_${index}`, originalName: longText,
      completeOriginal: false, totalUnits: 0, issues: [], ...(index % 2 ? { clinicalDate: null } : {}) }));
    const restored = decode(JSON.parse(JSON.stringify(encodeDirectOriginalInput('TARGET_ITEMS', input)))) as typeof input;
    expect(JSON.stringify(restored)).toBe(JSON.stringify(input));
    restored.forEach((item, index) => expect(Object.hasOwn(item, 'clinicalDate')).toBe(Boolean(index % 2)));
  });

  it.each([
    { payload: [{ _ref: 0 }] },
    { payload: [{ _ref: 0 }, { _ref: 0 }], valueTable: [] },
    { payload: [{ _ref: 0 }, { _ref: 0 }], valueTable: null },
    { payload: [{ _ref: 0 }, { _ref: 0 }], valueTable: [true] },
    { payload: [{ _ref: 0 }, { _ref: 0 }], valueTable: [longText, longText] },
    { payload: [{ _ref: 0 }], valueTable: [longText] },
    { payload: [{ _ref: 0 }, { _ref: 0 }], valueTable: [longText, `${longText} `] },
    { payload: [{ _ref: 0 }, { _ref: 0 }], valueTable: [{ _ref: 0 }] },
    { payload: [{ _ref: 0 }, { _ref: 0 }], valueTable: [{ value: longText }] },
    { payload: [{ _ref: 0, q: longText }, { _ref: 0 }], valueTable: [longText] },
    { payload: [{ _ref: -0 }, { _ref: 0 }], valueTable: [longText] },
    { payload: [{ _ref: .5 }, { _ref: 0 }], valueTable: [longText] },
    { payload: [{ _ref: -1 }, { _ref: 0 }], valueTable: [longText] },
    { payload: [{ _ref: '0' }, { _ref: 0 }], valueTable: [longText] },
    { payload: [{ _ref: Number.MAX_SAFE_INTEGER + 1 }, { _ref: 0 }], valueTable: [longText] },
    { payload: [{ _row: [0, 'a', 'b', null] }] },
    { payload: [{ _row: [0, 'a', 'b', null] }], objectShapes: [] },
    { payload: [{ _row: [0, 'a', 'b', null] }], objectShapes: [['k', 'n']] },
    { payload: [{ _row: [0, 'a', 'b', null] }], objectShapes: [['k', 'n', 'n']] },
    { payload: [{ _row: [0, 'a', 'b', null] }], objectShapes: [['k', 'n', 'privateField']] },
    { payload: [{ _row: [0, 'a', 'b', null] }], objectShapes: [['k', 'n', 'clinicalDate']] },
    { payload: [{ _row: [0, 'a', 'b', null] }], objectShapes: [['k', 'n', 'dt'], ['k', 'n', 'dt']] },
    { payload: [{ _row: [0, 'a', 'b'] }], objectShapes: [['k', 'n', 'dt']] },
    { payload: [{ _row: [0, 'a', 'b', null, 'extra'] }], objectShapes: [['k', 'n', 'dt']] },
    { payload: [{ _row: [0, 'a', 'b', null], k: 'mixed' }], objectShapes: [['k', 'n', 'dt']] },
    { payload: [{ k: 'not-row' }], objectShapes: [['k', 'n', 'dt']] },
    { payload: [{ _row: [0, 'a', 'b', null] }], objectShapes: [['k', 'n', 'dt'], ['n', 'k', 'dt']] }
  ])('坏目录、跨块引用、混合表示和坏列头固定拒绝 %#', ({ payload, ...extra }) => fails(wrap(payload, extra)));

  it('目录、列头、单元格或_ref中的getter/代理不执行', () => {
    let calls = 0;
    const getter = () => { calls++; throw new Error('PRIVATE_GETTER'); };
    const proxy = new Proxy([], { get() { calls++; throw new Error('PRIVATE_PROXY'); } });
    const tableGetter = Object.defineProperty([longText], '0', { enumerable: true, get: getter });
    const refGetter = Object.defineProperty({}, '_ref', { enumerable: true, get: getter });
    const rowGetter = Object.defineProperty([0, 'a', 'b', null], '1', { enumerable: true, get: getter });
    const shapeGetter = Object.defineProperty(['k', 'n', 'dt'], '0', { enumerable: true, get: getter });
    for (const envelope of [wrap([{ _ref: 0 }, { _ref: 0 }], { valueTable: tableGetter }),
      wrap([{ _ref: 0 }, { _ref: 0 }], { valueTable: proxy }), wrap([refGetter]),
      wrap([{ _row: rowGetter }], { objectShapes: [['k', 'n', 'dt']] }),
      wrap([{ _row: [0, 'a', 'b', null] }], { objectShapes: [shapeGetter] }),
      wrap([{ _row: proxy }], { objectShapes: [['k', 'n', 'dt']] }),
      Object.defineProperty(wrap([]), 'objectShapes', { enumerable: true, get: getter })]) fails(envelope);
    expect(calls).toBe(0);
  });

  it('稀疏目录/列头/单元格以及循环目录均不作为缺省值补齐', () => {
    const cyclic: unknown[] = []; cyclic.push(cyclic);
    for (const envelope of [wrap([{ _ref: 0 }, { _ref: 0 }], { valueTable: Array(2) }),
      wrap([{ _ref: 0 }, { _ref: 0 }], { valueTable: [cyclic] }),
      wrap([{ _row: [0, 'a', 'b', null] }], { objectShapes: [Array(3)] }),
      wrap([{ _row: Object.assign(Array(4), { 0: 0, 2: 'b', 3: null }) }], { objectShapes: [['k', 'n', 'dt']] })]) fails(envelope);
  });

  it('已撤销代理也返回固定错误，不暴露JavaScript内部异常', () => {
    const revoked = Proxy.revocable([], {}); revoked.revoke();
    for (const envelope of [wrap([{ _ref: 0 }, { _ref: 0 }], { valueTable: revoked.proxy }),
      wrap([{ _ref: 0 }, { _ref: 0 }], { valueTable: [revoked.proxy] }),
      wrap([{ _row: revoked.proxy }], { objectShapes: [['k', 'n', 'dt']] }),
      wrap([], { objectShapes: revoked.proxy })]) fails(envelope);
    expect(() => encodeDirectOriginalInput('TARGET_ITEMS', revoked.proxy)).toThrowError('DIRECT_ORIGINAL_INPUT_INVALID');
  });

  it('平目录仍限制恶意大量重复值展开，不泄露原文或路径', () => {
    const huge = 'x'.repeat(1024 * 1024);
    fails(wrap(Array.from({ length: 65 }, () => ({ _ref: 0 })), { valueTable: [huge] }));
    const payload = { vct: [huge], vd: Array.from({ length: 65 }, (_, index) => ({ ta: `c_${index}`, ctr: 0 })) };
    expect(() => decodeDirectOriginalInput('REPAIR_REQUEST', { inputVersion: DIRECT_ORIGINAL_INPUT_VERSION,
      section: 'REPAIR_REQUEST', payload })).toThrowError('DIRECT_ORIGINAL_INPUT_INVALID');
  });
});

describe('P03 v6同块紧凑数组表示', () => {
  const wrap = (payload: unknown, extra: Record<string, unknown> = {}) => ({
    inputVersion: DIRECT_ORIGINAL_INPUT_V6_VERSION, section: 'TARGET_ITEMS', payload, ...extra
  });
  const decode = (envelope: unknown) => decodeDirectOriginalInput('TARGET_ITEMS', envelope);
  const fails = (envelope: unknown) => expect(() => decode(envelope)).toThrowError('DIRECT_ORIGINAL_INPUT_INVALID');
  const longText = '合成完整原句：右侧未见异常 ≥3.20E-02；检查2026-02-03，签发不等于检查；保留null与历史角色。';

  it('v5 API与版本保持，v6只更改输入表示且guide明确区分两版', () => {
    expect(DIRECT_ORIGINAL_INPUT_VERSION).toBe('direct-original-repair-input-v5');
    expect(DIRECT_ORIGINAL_INPUT_V6_VERSION).toBe('direct-original-repair-input-v6');
    expect(encodeDirectOriginalInput('TARGET_ITEMS', [])).toEqual({
      inputVersion: DIRECT_ORIGINAL_INPUT_VERSION, section: 'TARGET_ITEMS', payload: [] });
    expect(encodeDirectOriginalInputV6('TARGET_ITEMS', [])).toEqual(wrap([]));
    for (const rule of ['direct-original-repair-input-v5', 'direct-original-repair-input-v6',
      '["v",N]', '["r",N,...单元格]', '["a",...原数组项]', '不把恢复出的整个原数组重新解释成标记',
      'v6块内禁止v5的_ref/_row对象标记', 'valueTable内不得再引用目录', '不扩大readonly权限']) {
      expect(DIRECT_ORIGINAL_INPUT_V6_PROMPT_GUIDE).toContain(rule);
    }
  });

  it.each(DIRECT_ORIGINAL_INPUT_SECTIONS)('%s两版经JSON传输逐字相同，完整原件/角色/权限不变', (section) => {
    const input = section === 'READ_ONLY_PAGE_CONTEXT' ? comparisonContext() : sections()[section];
    const before = JSON.stringify(input);
    for (const encode of [encodeDirectOriginalInput, encodeDirectOriginalInputV6]) {
      const envelope = encode(section, input);
      expect(JSON.stringify(decodeDirectOriginalInput(section, JSON.parse(JSON.stringify(envelope))))).toBe(before);
    }
    expect(JSON.stringify(input)).toBe(before);
  });

  it('宽行和重复值仅改包装，保留原值/数组顺序/缺失/null且实际更省字节', () => {
    const input = Array.from({ length: 160 }, (_, index) => ({ ...candidate(index),
      referenceRangeRaw: longText, clinicalDate: index % 2 ? null : '2026-02-03',
      ...(index % 3 ? {} : { completeOriginal: false, totalUnits: 0 }) }));
    const before = JSON.stringify(input);
    const v5 = encodeDirectOriginalInput('TARGET_ITEMS', input);
    const v6 = encodeDirectOriginalInputV6('TARGET_ITEMS', input);
    expect(v6.objectShapes).toEqual(v5.objectShapes);
    expect(JSON.stringify(v6)).toContain('["r",'); expect(JSON.stringify(v6)).toContain('["v",');
    expect(JSON.stringify(v6)).not.toContain('"_row"'); expect(JSON.stringify(v6)).not.toContain('"_ref"');
    expect(Buffer.byteLength(JSON.stringify(v6))).toBeLessThan(Buffer.byteLength(JSON.stringify(v5)));
    const encoded = JSON.stringify(v6);
    expect(JSON.stringify(decode(JSON.parse(encoded)))).toBe(before);
    expect(JSON.stringify(v6)).toBe(encoded); expect(JSON.stringify(input)).toBe(before);
  });

  it.each([
    ['r'], ['v', 0], ['a'], ['a', 'r'], ['r', 0, 'literal'], ['v', 0, null],
    [['r', 0]], ['a', ['v', 0]], ['r', ['a'], ['v', 0]], ['a', 'a', 'r'],
    ['R', 'V', 'A'], [], [null, false, 0], ['["r",0]', '{"_ref":0}', '{"_row":[]}']
  ])('原始标签数组和字符串只转义一次，不把恢复值再次解释为标记 %#', (...items) => {
    // it.each 的行参数本身组成原始数组，允许空数组以及嵌套数组。
    const input = [items];
    const before = JSON.stringify(input);
    const v5 = encodeDirectOriginalInput('TARGET_ITEMS', input);
    const v6 = encodeDirectOriginalInputV6('TARGET_ITEMS', input);
    expect(JSON.stringify(decode(JSON.parse(JSON.stringify(v6))))).toBe(before);
    expect(JSON.stringify(decode(v5))).toBe(before);
    expect(JSON.stringify(input)).toBe(before);
  });

  it('目录头v是固定短键，目录顶层不当引用；目录条目的普通标签数组仍保真', () => {
    const row = wrap([['r', 0, 1, 'complete', []]], { objectShapes: [['v', 'st', 'co']] });
    expect(decode(row)).toEqual([{ version: 1, status: 'complete', conditions: [] }]);
    const literal = ['v', 'synthetic ordinary array, not a directory reference'];
    const envelope = wrap([['v', 0], ['v', 0]], { valueTable: [['a', ...literal]] });
    expect(decode(envelope)).toEqual([literal, literal]);
    expect(decode(wrap([['a', 'r', 0, 'literal']]))).toEqual([['r', 0, 'literal']]);
  });

  it.each([
    ['v'], ['v', 0, 1], ['v', -0], ['v', -1], ['v', .5], ['v', '0'], ['v', null],
    ['v', NaN], ['v', Infinity], ['v', Number.MAX_SAFE_INTEGER + 1], ['v', 1],
    ['r'], ['r', -0, 'a', 'b', null], ['r', -1, 'a', 'b', null], ['r', .5, 'a', 'b', null],
    ['r', '0', 'a', 'b', null], ['r', 1, 'a', 'b', null], ['r', 0, 'a', 'b'],
    ['r', 0, 'a', 'b', null, 'extra'], ['a'], ['a', 'x'], ['a', ['v', 0]]
  ])('坏标签/索引/行宽/转义不回退普通数组 %#', (...payload) => fails(wrap([
    ['v', 0], ['v', 0], ['r', 0, 'baseline', 'row', null], payload], {
    valueTable: [longText], objectShapes: [['k', 'n', 'dt']] })));

  it.each([
    { payload: [{ _ref: 0 }, ['v', 0]], valueTable: [longText] },
    { payload: [{ _ref: 0, k: 'mixed' }, ['v', 0]], valueTable: [longText] },
    { payload: [{ _row: [0, 'a', 'b', null] }], objectShapes: [['k', 'n', 'dt']] },
    { payload: [['v', 0], ['v', 0]], valueTable: [{ _row: [0, 'a', 'b', null] }], objectShapes: [['k', 'n', 'dt']] },
    { payload: [['v', 0], ['v', 0]], valueTable: [['v', 0]] },
    { payload: [['v', 0], ['v', 0]], valueTable: [['r', 0, ['v', 0], 'b', null]], objectShapes: [['k', 'n', 'dt']] },
    { payload: [['v', 0], ['v', 0]], valueTable: [longText, longText] },
    { payload: [['v', 0]], valueTable: [longText] },
    { payload: [['v', 0], ['v', 0]], valueTable: [longText, `${longText}unused`] },
    { payload: [['v', 0], ['v', 0]], valueTable: [] },
    { payload: [['r', 0, 'a', 'b', null]], objectShapes: [['k', 'n', 'dt'], ['k', 'n', 'dt']] },
    { payload: [['r', 0, 'a', 'b', null]], objectShapes: [['k', 'n', 'clinicalDate']] }
  ])('拒绝旧marker混形、递归目录、重复/未用目录及非法列头 %#', ({ payload, ...extra }) => fails(wrap(payload, extra)));

  it('v6不会绕过REPAIR_REQUEST独有约束校验，所有constraint逐字还原', () => {
    const input = { validationDiagnostics: Array.from({ length: 40 }, (_, index) => ({
      targetId: `c_${index}`, reasonCode: 'synthetic', constraint: longText })) };
    const envelope = encodeDirectOriginalInputV6('REPAIR_REQUEST', input);
    expect(decodeDirectOriginalInput('REPAIR_REQUEST', envelope)).toEqual(input);
    expect(() => decodeDirectOriginalInput('READ_ONLY_PAGE_CONTEXT', { ...envelope, section: 'READ_ONLY_PAGE_CONTEXT' }))
      .toThrowError('DIRECT_ORIGINAL_INPUT_INVALID');
  });

  it('转换前拒绝getter/代理/稀疏/隐藏属性/数组子类，零用户代码执行', () => {
    let calls = 0;
    const getter = () => { calls++; throw new Error('PRIVATE_GETTER'); };
    const proxy = new Proxy([], { get() { calls++; throw new Error('PRIVATE_PROXY'); } });
    const revoked = Proxy.revocable([], {}); revoked.revoke();
    const headGetter = Object.defineProperty(['v', 0], '0', { enumerable: true, get: getter });
    const indexGetter = Object.defineProperty(['v', 0], '1', { enumerable: true, get: getter });
    const cellGetter = Object.defineProperty(['r', 0, 'a', 'b', null], '2', { enumerable: true, get: getter });
    const fieldGetter = Object.defineProperty({}, 'va', { enumerable: true, get: getter });
    const tableGetter = Object.defineProperty([longText], '0', { enumerable: true, get: getter });
    const versionGetter = Object.defineProperty(wrap([]), 'inputVersion', { enumerable: true, get: getter });
    const payloadGetter = Object.defineProperty(wrap([]), 'payload', { enumerable: true, get: getter });
    class CustomArray extends Array<unknown> {}
    for (const payload of [headGetter, indexGetter, cellGetter, fieldGetter, proxy, revoked.proxy,
      Array(2), Object.assign([1], { extra: 2 }), Object.defineProperty([1], 'extra', { value: 2 }),
      new CustomArray(1), Object.assign(Object.create({ va: 1 }), { k: 'synthetic' })]) fails(wrap([payload]));
    for (const envelope of [versionGetter, payloadGetter, wrap([], { valueTable: tableGetter }),
      wrap([], { valueTable: proxy }), wrap([], { objectShapes: proxy }), wrap([], { valueTable: revoked.proxy })]) fails(envelope);
    expect(calls).toBe(0);
  });

  it('循环和过深数据固定拒绝，合法128深度边界与v5相同', () => {
    const cycle: unknown[] = ['ordinary']; cycle.push(cycle);
    fails(wrap(cycle));
    const object: Record<string, unknown> = {}; object.va = object; fails(wrap([object]));
    for (const depth of [125, 127]) {
      let value: unknown = null; for (let index = 0; index < depth; index++) value = { value };
      const input = [value]; const before = JSON.stringify(input);
      expect(JSON.stringify(decode(encodeDirectOriginalInput('TARGET_ITEMS', input)))).toBe(before);
      expect(JSON.stringify(decode(encodeDirectOriginalInputV6('TARGET_ITEMS', input)))).toBe(before);
    }
    let tooDeep: unknown = null; for (let index = 0; index < 128; index++) tooDeep = { va: tooDeep };
    fails(wrap([tooDeep]));
  });

  it('保留64MiB展开上限且不截断大于256KiB的合法原文', () => {
    const huge = '合成完整原句'.repeat(20_000) + '末尾：右侧未见异常 ≥3.20E-02。';
    expect(Buffer.byteLength(huge)).toBeGreaterThan(256 * 1024);
    const input = [{ nativeText: huge }];
    expect(decode(encodeDirectOriginalInputV6('TARGET_ITEMS', input))).toEqual(input);
    const repeated = 'x'.repeat(1024 * 1024);
    fails(wrap(Array.from({ length: 65 }, () => ['v', 0]), { valueTable: [repeated] }));
  });

  it('缺省/显式null/空数组保持，未知版本/长短键混合/额外封装字段仍拒绝', () => {
    for (const input of [{ value: null, issues: [] }, { issues: [] }, { value: ['a'], issues: [] }]) {
      const envelope = encodeDirectOriginalInputV6('REPAIR_REQUEST', input);
      expect(JSON.stringify(decodeDirectOriginalInput('REPAIR_REQUEST', envelope))).toBe(JSON.stringify(input));
    }
    for (const envelope of [wrap([], { inputVersion: 'future' }), wrap([], { section: 'REPAIR_REQUEST' }),
      wrap([], { unknownField: 'PRIVATE' }), wrap([{ localKey: 'long' }]), wrap([{ k: 'short', localKey: 'mixed' }])]) fails(envelope);
  });
});
