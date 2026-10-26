import { describe, expect, it } from 'vitest';
import type { ObservationCandidate, SourceManifest, SourceSpan } from '@contracts';
import { diagnoseDirectOriginalObservationCandidate, directOriginalAlignedSourceFramesProveSameSlot,
  directOriginalContainedSourceProvesDuplicateSlot, directOriginalFieldsProvenComplementary, directOriginalFieldsProvenDistinct,
  evaluateDirectOriginalObservationCandidate, isVerifiedDirectOriginalSourceBinding,
  resolveDirectOriginalSourceBinding, sameDirectOriginalField } from './direct-original-validation.js';

function fixture(text = '合成测量表\n项目 本次 上次\n甲项 5.0 5.0\n乙项 9.0 8.0') {
  const page: SourceSpan = { id: 'slot-page', documentId: 'slot-document', spanKind: 'page', page: 1,
    blockId: 'direct-original-page:1', lineStart: null, lineEnd: null, quote: null, readability: 'clear' };
  const excerpt: SourceSpan = { ...page, id: 'slot-context', spanKind: 'block', quote: text,
    blockId: `model-original-excerpt:${page.id}`, modelEvidence: { version: 1, engine: 'codex-original-reading-v1',
      modelId: 'synthetic-model', threadId: 'synthetic-thread', turnId: 'synthetic-turn',
      originalSha256: 'a'.repeat(64), originalSourceObjectId: 'slot-object', parentSourceSpanId: page.id,
      inputKind: 'image', role: 'finding', clarity: 'clear' } };
  const manifest: SourceManifest = { id: 'slot-manifest', sourceObjectId: 'slot-object', sha256: 'a'.repeat(64),
    mediaType: 'application/pdf', originalDisplayName: 'synthetic.pdf', totalUnits: 1, coveredUnitIndexes: [0],
    spans: [page, excerpt], normalizerVersion: 'direct-original-v1', conversionWarnings: [], createdAt: '2026-01-01T00:00:00Z' };
  const ref = (quote: string | null) => ({ sourceSpanId: excerpt.id, quote });
  const candidate = (row = '甲项', column = '本次', rawText = '5.0'): ObservationCandidate => ({
    localKey: `candidate-${row}-${column}`, originalName: '合成项目', standardNameCandidate: null,
    value: { kind: 'numeric', rawText, decimal: rawText, comparator: 'eq' }, unitRaw: null, referenceRangeRaw: null,
    reportedAbnormalFlag: null, specimen: null, method: null, bodySite: null, clinicalDate: null,
    evidence: [ref(row === '甲项' ? '甲项 5.0 5.0' : '乙项 9.0 8.0')], sourceBinding: {
      headingEvidence: [], findingEvidence: [ref(row === '甲项' ? '甲项 5.0 5.0' : '乙项 9.0 8.0')],
      structuredSlot: { version: 1, kind: 'table_cell', contextEvidence: [ref(null)], rowEvidence: [ref(row)],
        columnEvidence: [ref(column)], axes: [], component: null }
    }, issues: [] });
  const binding = (value: ObservationCandidate) => {
    const result = resolveDirectOriginalSourceBinding(value, manifest);
    expect(result.status).toBe('resolved');
    if (result.status !== 'resolved') throw new Error('SYNTHETIC_SLOT_NOT_RESOLVED');
    return result.binding;
  };
  return { page, excerpt, manifest, ref, candidate, binding };
}

describe('同页原件行列身份', () => {
  it('实际行已互斥时，另一条缺少附加轴不把不同结果重新判为同格', () => {
    const f = fixture('合成测量表\n项目 本次 上次 左侧\n甲项 5.0 5.0\n乙项 9.0 8.0');
    const first = f.candidate(); const second = f.candidate('乙项', '本次', '9.0');
    first.sourceBinding!.structuredSlot!.axes = [{ kind: 'laterality', evidence: [f.ref('左侧')] }];
    expect(directOriginalFieldsProvenDistinct(f.binding(first), f.binding(second))).toBe(true);
    expect(sameDirectOriginalField(f.binding(first), f.binding(second))).toBe(false);
    const unresolved = f.candidate();
    expect(directOriginalFieldsProvenDistinct(f.binding(first), f.binding(unresolved))).toBe(false);
    expect(sameDirectOriginalField(f.binding(first), f.binding(unresolved))).toBe(false);
  });

  it.each([false, true])('共同结果全文中的互斥位置不要求附带标题全文也嵌入；结果重叠=%s仍保护', (overlap) => {
    const f = fixture();
    const oldText = overlap ? '甲项 5.0 5.0' : '另一合成记录 未填写';
    const oldSource: SourceSpan = { ...structuredClone(f.excerpt), id: 'old-result', quote: oldText };
    const heading: SourceSpan = { ...structuredClone(f.excerpt), id: 'old-heading', quote: '独立章节' };
    heading.modelEvidence!.role = 'heading';
    const common: SourceSpan = { ...structuredClone(f.excerpt), id: 'shared-position',
      quote: `${f.excerpt.quote}${overlap ? '' : `\n${oldText}`}` };
    common.modelEvidence!.role = 'context';
    f.manifest.spans.push(oldSource, heading, common);
    const old = f.candidate(); old.sourceBinding = { headingEvidence: [{ sourceSpanId: heading.id, quote: null }],
      findingEvidence: [{ sourceSpanId: oldSource.id, quote: null }] }; old.evidence = [...old.sourceBinding.findingEvidence];
    expect(directOriginalFieldsProvenDistinct(f.binding(f.candidate()), f.binding(old))).toBe(!overlap);
    // 位置互斥仅许可保留不同字段，绝不签发旧字段覆盖或判重证明。
    expect(directOriginalContainedSourceProvesDuplicateSlot(f.binding(f.candidate()), f.binding(old))).toBe(false);
  });
  it.each(['unique', 'missing', 'repeated', 'untrusted', 'overlap'] as const)(
    '旧普通字段与新表格槽位只按真实共同全文位置分离：%s', (kind) => {
      const f = fixture();
      const oldQuote = kind === 'overlap' ? '甲项 5.0 5.0' : '合成背景记录 未记录';
      const oldSource = { ...structuredClone(f.excerpt), id: 'legacy-field', quote: oldQuote };
      f.manifest.spans.push(oldSource);
      if (kind !== 'missing') {
        const context: SourceSpan = { ...structuredClone(f.excerpt), id: 'actual-common-context',
          quote: `${f.excerpt.quote}\n${kind === 'overlap' ? '' : oldQuote}${kind === 'repeated' ? `\n${oldQuote}` : ''}` };
        context.modelEvidence!.role = 'context';
        if (kind === 'untrusted') context.modelEvidence!.originalSha256 = 'b'.repeat(64);
        f.manifest.spans.push(context);
      }
      const legacy = f.candidate();
      legacy.sourceBinding = { headingEvidence: [], findingEvidence: [{ sourceSpanId: oldSource.id, quote: null }] };
      legacy.evidence = [...legacy.sourceBinding.findingEvidence];
      const first = f.binding(f.candidate()); const second = f.binding(legacy);
      expect(directOriginalFieldsProvenDistinct(first, second)).toBe(kind === 'unique');
      expect(directOriginalFieldsProvenDistinct(second, first)).toBe(kind === 'unique');
      // 共同上下文证明只分位置，不把两个不同字段当作同一结果。
      if (kind === 'unique') expect(sameDirectOriginalField(first, second)).toBe(false);
    });

  it('同一整行、同名且相同数值的两列仍是两个有依据的字段', () => {
    const f = fixture(); const first = f.candidate(); const second = f.candidate('甲项', '上次');
    first.sourceBinding!.headingEvidence = [f.ref('合成测量表')]; second.sourceBinding!.headingEvidence = [f.ref('合成测量表')];
    const a = f.binding(first); const b = f.binding(second);
    expect(a.key).not.toBe(b.key);
    expect(sameDirectOriginalField(a, b)).toBe(false);
    expect(directOriginalFieldsProvenDistinct(a, b)).toBe(true);
    expect(directOriginalFieldsProvenComplementary(a, b)).toBe(false);
    expect(directOriginalAlignedSourceFramesProveSameSlot(a, b)).toBe(false);
  });

  it('中文短列头与长列头共享字串时按完整标签定位，两个真实列仍独立', () => {
    const f = fixture('合成测量表\n项目 轴位 调整轴位\n甲项 5.0 5.0');
    const short = f.candidate('甲项', '轴位'); short.sourceBinding!.headingEvidence = [f.ref('轴位')];
    const first = f.binding(short);
    const second = f.binding(f.candidate('甲项', '调整轴位'));
    expect(directOriginalFieldsProvenDistinct(first, second)).toBe(true);
    expect(sameDirectOriginalField(first, second)).toBe(false);
    const changed = f.candidate('甲项', '轴位', '6.0');
    expect(sameDirectOriginalField(first, f.binding(changed))).toBe(true);
  });

  it('选中的完整章节可将大摘录内重复行列标签限制到该章节，不能用结果值选位置', () => {
    const firstTable = '合成前次表\n项目 本次 上次\n甲项 5.0 5.0';
    const secondTable = '合成后次表\n项目 本次 上次\n甲项 5.0 5.0';
    const f = fixture(`${firstTable}\n${secondTable}`);
    const first = f.candidate(); first.sourceBinding!.structuredSlot!.contextEvidence = [f.ref(firstTable)];
    const second = f.candidate(); second.sourceBinding!.structuredSlot!.contextEvidence = [f.ref(secondTable)];
    // 完整 frame 无法相互唯一包含，不宣称两份同字表可按页内偏移任意合并。
    expect(f.binding(first).key).not.toBe(f.binding(second).key);
    expect(sameDirectOriginalField(f.binding(first), f.binding(second))).toBe(false);
  });

  it('独立锚点完整摘录唯一嵌入时可分辨重复标签，单独短标签仍不足', () => {
    const f = fixture('合成测量表\n前次区域 项目 本次\n甲项 5.0\n后次区域 项目 本次\n甲项 6.0');
    const anchor: SourceSpan = { ...structuredClone(f.excerpt), id: 'scoped-anchor', quote: '前次区域 项目 本次\n甲项 5.0' };
    f.manifest.spans.push(anchor);
    const candidate = f.candidate(); candidate.evidence = [f.ref('甲项 5.0')];
    candidate.sourceBinding!.findingEvidence = [...candidate.evidence];
    candidate.sourceBinding!.structuredSlot!.rowEvidence = [{ sourceSpanId: anchor.id, quote: '甲项' }];
    candidate.sourceBinding!.structuredSlot!.columnEvidence = [{ sourceSpanId: anchor.id, quote: '本次' }];
    expect(resolveDirectOriginalSourceBinding(candidate, f.manifest).status).toBe('resolved');
    anchor.quote = '甲项';
    expect(resolveDirectOriginalSourceBinding(candidate, f.manifest).status).toBe('unresolved');
  });

  it('已核验槽位的真实标签可复用为标题，不要求模型把独立标签再抄到结果摘录', () => {
    const f = fixture();
    const finding: SourceSpan = { ...structuredClone(f.excerpt), id: 'separate-finding', quote: '甲项 5.0 5.0' };
    f.manifest.spans.push(finding);
    const c = f.candidate(); c.evidence = [{ sourceSpanId: finding.id, quote: null }];
    c.sourceBinding!.findingEvidence = [...c.evidence]; c.sourceBinding!.headingEvidence = [f.ref('本次')];
    expect(resolveDirectOriginalSourceBinding(c, f.manifest).status).toBe('resolved');
    expect(diagnoseDirectOriginalObservationCandidate(c, f.manifest,
      { personConsistent: true, overwritesUserLockedValue: false })).toEqual([]);
    // 摘录中别的文字并非本字段锚点，不能获得同样许可。
    c.sourceBinding!.headingEvidence = [f.ref('乙项')];
    expect(resolveDirectOriginalSourceBinding(c, f.manifest).status).toBe('unresolved');
    c.sourceBinding!.headingEvidence = [f.ref('本次')];
    c.sourceBinding!.structuredSlot!.rowEvidence = [f.ref('不存在的行')];
    expect(resolveDirectOriginalSourceBinding(c, f.manifest).status).toBe('unresolved');
  });

  it.each(['项目 轴位 轴位', '项目 调整轴位'])(
    '真实重复或截短中文标签不取第一个匹配：%s', (header) => {
      const f = fixture(`合成测量表\n${header}\n甲项 5.0 5.0`);
      const c = f.candidate('甲项', '轴位');
      c.localKey = 'candidate-ambiguous-column';
      expect(resolveDirectOriginalSourceBinding(c, f.manifest).status).toBe('unresolved');
      const diagnostics = diagnoseDirectOriginalObservationCandidate(c, f.manifest,
        { personConsistent: true, overwritesUserLockedValue: false });
      expect(diagnostics).toContainEqual(expect.objectContaining({ reasonCode: 'direct_original_structured_slot_invalid',
        fieldPath: 'sourceBinding.structuredSlot.columnEvidence[0]', sourceSpanId: f.excerpt.id,
        allowedRoles: ['finding', 'instruction', 'context', 'heading', 'date'] }));
      expect(diagnostics.some((item) => item.constraint.includes('个完整引用位置'))).toBe(true);
      expect(JSON.stringify(diagnostics)).not.toContain('轴位');
    });

  it.each(['laterality', 'time', 'frequency'] as const)('真实%s轴保持独立，不按标签外的成员日期或数值猜同格', (kind) => {
    const f = fixture('合成测量表\n项目 结果 左侧 右侧\n甲项 5.0 5.0');
    const first = f.candidate('甲项', '结果'); const second = f.candidate('甲项', '结果');
    first.sourceBinding!.structuredSlot!.axes = [{ kind, evidence: [f.ref('左侧')] }];
    second.sourceBinding!.structuredSlot!.axes = [{ kind, evidence: [f.ref('右侧')] }];
    expect(directOriginalFieldsProvenDistinct(f.binding(first), f.binding(second))).toBe(true);
    second.sourceBinding!.structuredSlot!.axes[0]!.evidence = [f.ref('左侧')];
    expect(sameDirectOriginalField(f.binding(first), f.binding(second))).toBe(true);
  });

  it('角色诊断报告实际槽位约束和明确来源，不把日期角色当成共同表格背景', () => {
    const f = fixture(); const c = f.candidate(); f.excerpt.modelEvidence!.role = 'date';
    expect(diagnoseDirectOriginalObservationCandidate(c, f.manifest,
      { personConsistent: true, overwritesUserLockedValue: false })).toContainEqual(expect.objectContaining({
      reasonCode: 'direct_original_structured_slot_invalid', fieldPath: 'sourceBinding.structuredSlot.contextEvidence[0]',
      sourceSpanId: f.excerpt.id, actualRole: 'date', allowedRoles: ['finding', 'instruction', 'context']
    }));
  });

  it('裸数字重复时不制造字符位置，仍可由真实行列锚点消歧', () => {
    const f = fixture(); const a = f.candidate(); const b = f.candidate('甲项', '上次');
    for (const value of [a, b]) {
      value.evidence = [f.ref('5.0')]; value.sourceBinding!.findingEvidence = [f.ref('5.0')];
    }
    const first = f.binding(a); const second = f.binding(b);
    expect(first.units[0]!.segmentStart).toBe(0);
    expect(first.units[0]!.segmentEnd).toBe(f.excerpt.quote!.length);
    expect(directOriginalFieldsProvenDistinct(first, second)).toBe(true);
  });

  it('不同真实行或频率轴可以区分，不能仅用不同值、localKey或展示名拆同一格', () => {
    const f = fixture(); const first = f.binding(f.candidate());
    const otherRow = f.binding(f.candidate('乙项', '本次', '9.0'));
    expect(directOriginalFieldsProvenDistinct(first, otherRow)).toBe(true);
    const changed = f.candidate(); changed.localKey = 'another-id'; changed.originalName = '另一个展示名';
    changed.value = { kind: 'numeric', rawText: '6.0', decimal: '6.0', comparator: 'eq' };
    const sameCell = f.binding(changed);
    expect(sameDirectOriginalField(first, sameCell)).toBe(true);
    expect(directOriginalFieldsProvenDistinct(first, sameCell)).toBe(false);
  });

  it('共同上下文前后补全仍能对齐真实行列身份，不以全文哈希猜两个字段', () => {
    const f = fixture(); const old = f.binding(f.candidate());
    const expanded: SourceSpan = { ...structuredClone(f.excerpt), id: 'expanded-context', quote: `合成页首\n${f.excerpt.quote}\n合成页尾` };
    f.manifest.spans.push(expanded);
    const next = f.candidate();
    const remap = <T,>(value: T): T => JSON.parse(JSON.stringify(value).replaceAll('slot-context', expanded.id)) as T;
    const after = f.binding(remap(next));
    expect(sameDirectOriginalField(old, after)).toBe(true);
    expect(directOriginalFieldsProvenDistinct(old, after)).toBe(false);
  });

  it('同一项目及列头下的不同真实频率轴仍能区分，同频率的改名不能拆字段', () => {
    const f = fixture('合成分段表\n部位 阻抗 低频 高频\n右臂 3.0 4.0');
    const make = (frequency: string, value: string) => {
      const c = f.candidate(); c.value = { kind: 'numeric', rawText: value, decimal: value, comparator: 'eq' };
      c.evidence = [f.ref('右臂 3.0 4.0')]; c.sourceBinding!.findingEvidence = [...c.evidence];
      const slot = c.sourceBinding!.structuredSlot!; slot.rowEvidence = [f.ref('右臂')]; slot.columnEvidence = [f.ref('阻抗')];
      slot.axes = [{ kind: 'frequency', evidence: [f.ref(frequency)] }];
      return c;
    };
    const low = f.binding(make('低频', '3.0')); const high = f.binding(make('高频', '4.0'));
    expect(directOriginalFieldsProvenDistinct(low, high)).toBe(true);
    const changed = make('低频', '4.0'); changed.bodySite = '另一模型标签';
    expect(sameDirectOriginalField(low, f.binding(changed))).toBe(true);
  });

  it.each(['unknown-anchor', 'overlap', 'whole-context', 'duplicate-axis', 'wrong-page', 'unclear', 'no-column',
    'partial-source', 'duplicate-source-id', 'parent-with-model'] as const)(
    '坏槽位不能静默退回旧字段身份：%s', (kind) => {
      const f = fixture(); const c = f.candidate(); const slot = c.sourceBinding!.structuredSlot!;
      if (kind === 'unknown-anchor') slot.columnEvidence[0]!.quote = '模型自造列';
      if (kind === 'overlap') slot.columnEvidence = [f.ref('甲项')];
      if (kind === 'whole-context') slot.rowEvidence = [f.ref(null)];
      if (kind === 'duplicate-axis') slot.axes = [{ kind: 'time', evidence: [f.ref('本次')] }, { kind: 'time', evidence: [f.ref('上次')] }];
      if (kind === 'wrong-page') {
        const outside = { ...structuredClone(f.excerpt), id: 'other-page-anchor', page: 2 };
        f.manifest.spans.push(outside); slot.columnEvidence = [{ sourceSpanId: outside.id, quote: '本次' }];
      }
      if (kind === 'unclear') f.excerpt.modelEvidence!.clarity = 'uncertain';
      if (kind === 'no-column') slot.columnEvidence = [];
      if (kind === 'partial-source') f.excerpt.readability = 'partial';
      if (kind === 'duplicate-source-id') f.manifest.spans.push(structuredClone(f.excerpt));
      if (kind === 'parent-with-model') f.page.modelEvidence = structuredClone(f.excerpt.modelEvidence!);
      expect(resolveDirectOriginalSourceBinding(c, f.manifest)).toEqual({ status: 'unresolved', reason: 'direct_original_structured_slot_invalid' });
      expect(evaluateDirectOriginalObservationCandidate(c, f.manifest,
        { personConsistent: true, overwritesUserLockedValue: false })).toMatchObject({ decision: 'reject', reasons: expect.arrayContaining(['direct_original_structured_slot_invalid']) });
    });

  it('旧无槽位回执仍可读，但不能凭新增行列标签证明旧整行是另一个字段', () => {
    const f = fixture(); const old = f.candidate(); delete old.sourceBinding!.structuredSlot;
    const previous = f.binding(old); const next = f.binding(f.candidate('甲项', '上次'));
    expect(directOriginalFieldsProvenDistinct(previous, next)).toBe(false);
    expect(isVerifiedDirectOriginalSourceBinding(JSON.parse(JSON.stringify(next)))).toBe(false);
  });

  it('已保存描述符能用原始来源重新验证，但克隆JSON和被改列头本身没有权限', () => {
    const f = fixture(); const first = f.binding(f.candidate());
    const saved = JSON.parse(JSON.stringify(first));
    expect(saved.directOriginalField.structuredSlot).toEqual(f.candidate().sourceBinding!.structuredSlot);
    const restored = f.candidate(); restored.sourceBinding!.structuredSlot = saved.directOriginalField.structuredSlot;
    expect(sameDirectOriginalField(first, f.binding(restored))).toBe(true);
    expect(isVerifiedDirectOriginalSourceBinding(saved)).toBe(false);
    restored.sourceBinding!.structuredSlot!.columnEvidence[0]!.quote = '不存在的列';
    expect(resolveDirectOriginalSourceBinding(restored, f.manifest).status).toBe('unresolved');
  });
});

describe('原文明确的定量与定性分量', () => {
  function numericComponent(source: string, rawText: string, decimal: string, unitRaw: string,
    comparator: 'eq' | 'lt' = 'eq') {
    const f = fixture(`合成时程\n间期甲/间期乙：281/${source}`);
    const candidate = f.candidate();
    candidate.value = { kind: 'numeric', rawText, decimal, comparator }; candidate.unitRaw = unitRaw;
    candidate.evidence = [f.ref(`281/${source}`)];
    candidate.sourceBinding = { headingEvidence: [], findingEvidence: candidate.evidence,
      structuredSlot: { version: 1, kind: 'labeled_component', contextEvidence: [f.ref(null)],
        rowEvidence: [f.ref('间期甲/间期乙')], columnEvidence: [], axes: [],
        component: { kind: 'quantitative', evidence: [f.ref(source)] } } };
    return { ...f, candidate };
  }

  it.each([
    ['327ms', '327', '327', 'ms', 'eq'],
    ['327 ms', '327', '327', 'ms', 'eq'],
    ['- 2.8mV', '- 2.8', '-2.8', 'mV', 'eq'],
    ['<1.20E+03IU/mL', '<1.20E+03', '1200', 'IU/mL', 'lt']
  ] as const)('数值分量的明确完整单位相邻不误拦，原串仍保留：%s', (source, raw, decimal, unit, comparator) => {
    const f = numericComponent(source, raw, decimal, unit, comparator);
    const before = structuredClone(f.candidate);
    expect(resolveDirectOriginalSourceBinding(f.candidate, f.manifest).status).toBe('resolved');
    expect(f.candidate).toEqual(before);
  });

  it.each([
    ['1327ms', '327', '327', 'ms'], ['327msec', '327', '327', 'ms'],
    ['<327ms', '327', '327', 'ms'], ['-327ms', '327', '327', 'ms'],
    ['327ms', '327', '328', 'ms'], ['327ms', '327', '327', 's'],
    ['327E03', '327', '327', 'E03'], ['3272', '327', '327', '2'],
    ['327ms 未检出', '327', '327', 'ms 未检出']
  ])('只修已声明的完整单位边界，不截值、符号、指数或限定语：%s', (source, raw, decimal, unit) => {
    const f = numericComponent(source, raw, decimal, unit);
    expect(resolveDirectOriginalSourceBinding(f.candidate, f.manifest).status).toBe('unresolved');
  });

  function components() {
    const f = fixture('合成呼气检测\n项目 结果\n样本甲 - 4.8 DPM 阴性');
    const numeric = f.candidate(); numeric.value = { kind: 'numeric', rawText: '- 4.8', decimal: '-4.8', comparator: 'eq' };
    numeric.unitRaw = 'DPM'; numeric.evidence = [f.ref('样本甲 - 4.8 DPM 阴性')];
    numeric.sourceBinding = { headingEvidence: [], findingEvidence: numeric.evidence,
      structuredSlot: { version: 1, kind: 'labeled_component', contextEvidence: [f.ref(null)], rowEvidence: [f.ref('样本甲')],
        columnEvidence: [], axes: [], component: { kind: 'quantitative', evidence: [f.ref('- 4.8 DPM')] } } };
    const qualitative = structuredClone(numeric); qualitative.localKey = 'qualitative-result'; qualitative.unitRaw = null;
    qualitative.value = { kind: 'qualitative', rawText: '阴性', category: 'negative' };
    qualitative.sourceBinding!.structuredSlot!.component = { kind: 'qualitative', evidence: [f.ref('阴性')] };
    return { ...f, numeric, qualitative };
  }

  it('两个结果独立引用原件分量，不从阈值推导定性，也不整组判矛盾', () => {
    const f = components(); const a = f.binding(f.numeric); const b = f.binding(f.qualitative);
    expect(evaluateDirectOriginalObservationCandidate(f.numeric, f.manifest,
      { personConsistent: true, overwritesUserLockedValue: false }).decision).toBe('accept_with_warnings');
    expect(directOriginalFieldsProvenComplementary(a, b)).toBe(true);
    expect(directOriginalFieldsProvenDistinct(a, b)).toBe(true);
    expect(sameDirectOriginalField(a, b)).toBe(false);
  });

  it('分量引用的角色诊断不建议用 context 或 heading 代替结果', () => {
    const f = components();
    const bad = { ...structuredClone(f.excerpt), id: 'bad-component', quote: '阴性' };
    bad.modelEvidence!.role = 'heading'; f.manifest.spans.push(bad);
    f.qualitative.sourceBinding!.structuredSlot!.component!.evidence = [{ sourceSpanId: bad.id, quote: null }];
    expect(diagnoseDirectOriginalObservationCandidate(f.qualitative, f.manifest,
      { personConsistent: true, overwritesUserLockedValue: false })).toContainEqual(expect.objectContaining({
      reasonCode: 'direct_original_structured_slot_invalid', fieldPath: 'sourceBinding.structuredSlot.component.evidence[0]',
      sourceSpanId: bad.id, actualRole: 'heading', allowedRoles: ['finding', 'instruction']
    }));
  });

  it('多个项目有相同定性结果时，由唯一完整结果引用限定分量范围', () => {
    const f = components();
    f.excerpt.quote = '合成呼气检测\n项目 结果\n样本甲 - 4.8 DPM 阴性\n样本乙 - 3.6 DPM 阴性';
    expect(resolveDirectOriginalSourceBinding(f.qualitative, f.manifest).status).toBe('resolved');
    // 一个项目自己的整段中重复两次，不能用数组顺序或候选值任取其中一次。
    f.excerpt.quote = '合成呼气检测\n项目 结果\n样本甲 - 4.8 DPM 阴性 阴性';
    f.qualitative.evidence = [f.ref('样本甲 - 4.8 DPM 阴性 阴性')];
    f.qualitative.sourceBinding!.findingEvidence = [...f.qualitative.evidence];
    expect(resolveDirectOriginalSourceBinding(f.qualitative, f.manifest).status).toBe('unresolved');
  });

  it.each(['no-component', 'wrong-kind', 'not-original', 'overlap'] as const)('缺少独立分量依据不授予互补许可：%s', (kind) => {
    const f = components(); const slot = f.qualitative.sourceBinding!.structuredSlot!;
    if (kind === 'no-component') slot.component = null;
    if (kind === 'wrong-kind') slot.component!.kind = 'quantitative';
    if (kind === 'not-original') f.qualitative.value.rawText = '阳性';
    if (kind === 'overlap') slot.component!.evidence = [f.ref('样本甲 - 4.8 DPM 阴性')];
    expect(resolveDirectOriginalSourceBinding(f.qualitative, f.manifest).status).toBe('unresolved');
  });
});

describe('仅供完整医疗字段相等后的整行包含判重证明', () => {
  function singleField() {
    const f = fixture('合成页首\nXY: 47mm\n合成页尾');
    const broadHeading: SourceSpan = { ...structuredClone(f.excerpt), id: 'legacy-heading', quote: 'XY: 47mm' };
    broadHeading.modelEvidence!.role = 'heading'; f.manifest.spans.push(broadHeading);
    const old = f.candidate(); delete old.sourceBinding!.structuredSlot;
    old.evidence = [f.ref('XY: 47mm')]; old.sourceBinding!.findingEvidence = [...old.evidence];
    old.sourceBinding!.headingEvidence = [{ sourceSpanId: broadHeading.id, quote: null }];
    const next = structuredClone(old); next.sourceBinding!.findingEvidence = [f.ref('47mm')];
    next.evidence = [...next.sourceBinding!.findingEvidence]; next.sourceBinding!.headingEvidence = [f.ref('XY:')];
    return { ...f, old, next, broadHeading };
  }
  it('旧整行标题、结果与新真实前缀及同尾结果严格包含时只签发判重证明', () => {
    const f = singleField(); const old = f.binding(f.old); const next = f.binding(f.next);
    expect(directOriginalContainedSourceProvesDuplicateSlot(next, old)).toBe(true);
    expect(directOriginalContainedSourceProvesDuplicateSlot(old, next)).toBe(false);
    expect(directOriginalAlignedSourceFramesProveSameSlot(next, old)).toBe(false);
    expect(directOriginalContainedSourceProvesDuplicateSlot(JSON.parse(JSON.stringify(next)), old)).toBe(false);
  });
  it('旧整段null引用可保守恢复同一真实单行，不要求补造非null窄引文', () => {
    const f = singleField();
    const line: SourceSpan = { ...structuredClone(f.excerpt), id: 'legacy-whole-line', quote: 'XY: 47mm' };
    f.manifest.spans.push(line);
    f.old.evidence = [{ sourceSpanId: line.id, quote: null }];
    f.old.sourceBinding!.findingEvidence = [...f.old.evidence];
    expect(directOriginalContainedSourceProvesDuplicateSlot(f.binding(f.next), f.binding(f.old))).toBe(true);
    line.quote = '其他字段 11\nXY: 47mm';
    expect(directOriginalContainedSourceProvesDuplicateSlot(f.binding(f.next), f.binding(f.old))).toBe(false);
  });
  it('独立旧章节与新字段前缀须先取得真实共同全文，证明只影响判重且不改旧绑定身份', () => {
    const f = singleField(); f.broadHeading.quote = '合成章节';
    const oldBefore = f.binding(f.old); const nextBefore = f.binding(f.next);
    expect(directOriginalContainedSourceProvesDuplicateSlot(nextBefore, oldBefore)).toBe(false);
    const context: SourceSpan = { ...structuredClone(f.excerpt), id: 'verified-common-context',
      quote: `合成章节\n${f.excerpt.quote}` };
    context.modelEvidence!.role = 'context'; f.manifest.spans.push(context);
    const oldAfter = f.binding(f.old); const nextAfter = f.binding(f.next);
    expect(oldAfter).toEqual(oldBefore); expect(nextAfter).toEqual(nextBefore);
    expect(directOriginalContainedSourceProvesDuplicateSlot(nextAfter, oldAfter)).toBe(true);
    expect(directOriginalContainedSourceProvesDuplicateSlot(nextBefore, oldBefore)).toBe(false);
    expect(directOriginalAlignedSourceFramesProveSameSlot(nextAfter, oldAfter)).toBe(false);
    // 重启后只有持久清单及原候选；JSON绑定自身不携带权限，须重新核验完整模型回执。
    const restoredManifest: SourceManifest = JSON.parse(JSON.stringify(f.manifest));
    const restoredOld = resolveDirectOriginalSourceBinding(JSON.parse(JSON.stringify(f.old)), restoredManifest);
    const restoredNext = resolveDirectOriginalSourceBinding(JSON.parse(JSON.stringify(f.next)), restoredManifest);
    expect(directOriginalContainedSourceProvesDuplicateSlot(JSON.parse(JSON.stringify(nextAfter)),
      JSON.parse(JSON.stringify(oldAfter)))).toBe(false);
    expect(restoredOld.status).toBe('resolved'); expect(restoredNext.status).toBe('resolved');
    if (restoredOld.status === 'resolved' && restoredNext.status === 'resolved') {
      expect(directOriginalContainedSourceProvesDuplicateSlot(restoredNext.binding, restoredOld.binding)).toBe(true);
    }
    restoredManifest.spans = restoredManifest.spans.filter((span) => span.id !== context.id);
    const missingOld = resolveDirectOriginalSourceBinding(f.old, restoredManifest);
    const missingNext = resolveDirectOriginalSourceBinding(f.next, restoredManifest);
    if (missingOld.status === 'resolved' && missingNext.status === 'resolved') {
      expect(directOriginalContainedSourceProvesDuplicateSlot(missingNext.binding, missingOld.binding)).toBe(false);
    } else throw new Error('SYNTHETIC_BINDING_WITHOUT_COMMON_CONTEXT_NOT_RESOLVED');
  });
  it.each(['wrong-page', 'wrong-original', 'unclear', 'wrong-role', 'repeated-line', 'repeated-section',
    'section-after-result', 'different-section', 'conflicting-contexts'] as const)(
    '共同全文不足以证明同一单字段时维持两条原记录：%s', (kind) => {
      const f = singleField(); f.broadHeading.quote = '左侧章节';
      const context: SourceSpan = { ...structuredClone(f.excerpt), id: 'verified-common-context',
        quote: `左侧章节\n${f.excerpt.quote}` };
      context.modelEvidence!.role = 'context'; f.manifest.spans.push(context);
      if (kind === 'wrong-page') context.page = 2;
      if (kind === 'wrong-original') context.modelEvidence!.originalSha256 = 'b'.repeat(64);
      if (kind === 'unclear') context.modelEvidence!.clarity = 'uncertain';
      if (kind === 'wrong-role') context.modelEvidence!.role = 'date';
      if (kind === 'repeated-line') context.quote += `\n${f.excerpt.quote}`;
      if (kind === 'repeated-section') context.quote = `左侧章节\n${context.quote}`;
      if (kind === 'section-after-result') context.quote = `${f.excerpt.quote}\n左侧章节`;
      if (kind === 'different-section') {
        context.quote = `左侧章节\n右侧章节\n${f.excerpt.quote}`;
        const otherSection: SourceSpan = { ...structuredClone(f.broadHeading), id: 'other-section', quote: '右侧章节' };
        f.manifest.spans.push(otherSection);
      }
      if (kind === 'conflicting-contexts') f.manifest.spans.push({ ...structuredClone(context),
        id: 'other-common-context', quote: `左侧章节\n不同栏目\n${f.excerpt.quote}` });
      expect(directOriginalContainedSourceProvesDuplicateSlot(f.binding(f.next), f.binding(f.old))).toBe(false);
    });
  it.each(['extra-field', 'not-prefix', 'wrong-end', 'multiple-headings', 'multiple-findings', 'newline'] as const)(
    '不将更大的表格段落或其他字段误作单字段整行：%s', (kind) => {
      const f = singleField();
      if (kind === 'extra-field') {
        f.excerpt.quote = '合成页首\nXY: 12 ZQ: 47mm\n合成页尾';
        f.broadHeading.quote = 'XY: 12 ZQ: 47mm'; f.old.evidence = [f.ref(f.broadHeading.quote)];
        f.old.sourceBinding!.findingEvidence = [...f.old.evidence];
      }
      if (kind === 'not-prefix') f.next.sourceBinding!.headingEvidence = [f.ref('合成页首')];
      if (kind === 'wrong-end') { f.next.sourceBinding!.findingEvidence = [f.ref('47')]; f.next.evidence = [f.ref('47')]; }
      if (kind === 'multiple-headings') f.next.sourceBinding!.headingEvidence.push({ sourceSpanId: f.broadHeading.id, quote: null });
      if (kind === 'multiple-findings') f.next.sourceBinding!.findingEvidence.push(f.ref('47mm'));
      if (kind === 'newline') {
        f.excerpt.quote = '合成页首\nXY:\n47mm\n合成页尾'; f.broadHeading.quote = 'XY:\n47mm';
        f.old.evidence = [f.ref(f.broadHeading.quote)]; f.old.sourceBinding!.findingEvidence = [...f.old.evidence];
      }
      const previous = resolveDirectOriginalSourceBinding(f.old, f.manifest);
      const next = resolveDirectOriginalSourceBinding(f.next, f.manifest);
      if (previous.status === 'resolved' && next.status === 'resolved') {
        expect(directOriginalContainedSourceProvesDuplicateSlot(next.binding, previous.binding)).toBe(false);
      } else expect([previous.status, next.status]).toContain('unresolved');
    });
  it('真实行列槽位永远不借整行兼容证明折叠', () => {
    const f = fixture();
    expect(directOriginalContainedSourceProvesDuplicateSlot(f.binding(f.candidate()), f.binding(f.candidate('甲项', '上次')))).toBe(false);
  });
});
