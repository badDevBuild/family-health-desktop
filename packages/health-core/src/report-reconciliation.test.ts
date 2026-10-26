import { describe, expect, it } from 'vitest';
import { observationCandidateSchema, type ObservationCandidate, type SourceManifest, type SourceSpan } from '@contracts';
import { candidateToReconciliationFact, reconcileReportFact, reportFactSemantics, resolveReportSourceBinding,
  createDirectOriginalSourceRefinementProof,
  type BoundReportFact, type ResolvedReportSourceBinding } from './report-reconciliation.js';
import { directOriginalFieldsProvenDistinct, directOriginalHeadingAdditionProvesDuplicateSlot,
  directOriginalExpandedFindingProvesSourceRefinement, directOriginalAlignedSourceFramesProveSameSlot, isVerifiedDirectOriginalSourceBinding,
  resolveDirectOriginalSourceBinding, sameDirectOriginalField } from './direct-original-validation.js';

function manifest(text: string, view = 'manifest-v1'): SourceManifest {
  return { id: view, sourceObjectId: 'original-object', sha256: 'a'.repeat(64), mediaType: 'application/pdf',
    originalDisplayName: 'synthetic-report.pdf', totalUnits: 1, coveredUnitIndexes: [0],
    normalizerVersion: 'synthetic-v1', conversionWarnings: [], createdAt: '2026-01-01T00:00:00Z',
    spans: [{ id: 'page-1', documentId: 'document-1', spanKind: 'page', page: 1, blockId: null,
      lineStart: null, lineEnd: null, quote: text, readability: 'clear' }] };
}

function candidate(rawText: string, quote: string | null = null, originalName = '检查所见'): ObservationCandidate {
  return { localKey: 'model-key', originalName, standardNameCandidate: null, value: { kind: 'text', rawText },
    unitRaw: null, referenceRangeRaw: null, reportedAbnormalFlag: null, specimen: null, method: null,
    bodySite: null, clinicalDate: null, evidence: [{ sourceSpanId: 'page-1', quote }], issues: [] };
}

function resolved(observation: ObservationCandidate, source: SourceManifest): ResolvedReportSourceBinding {
  const resolution = resolveReportSourceBinding(observation, source);
  expect(resolution.status).toBe('resolved');
  if (resolution.status !== 'resolved') throw new Error(resolution.reason);
  return resolution.binding;
}

function bound(observation: ObservationCandidate, source: SourceManifest, recordId = 'incoming'): BoundReportFact {
  return { recordId, fact: candidateToReconciliationFact(observation), binding: resolved(observation, source) };
}

describe('应用管理的具体发现来源绑定', () => {
  it('旧契约兼容，并允许标题与具体发现分别引用', () => {
    const old = candidate('形态规则');
    expect(observationCandidateSchema.safeParse(old).success).toBe(true);
    expect(observationCandidateSchema.safeParse({ ...old, sourceBinding: {
      headingEvidence: [{ sourceSpanId: 'page-1', quote: '检查所见' }],
      findingEvidence: [{ sourceSpanId: 'page-1', quote: '形态规则' }]
    } }).success).toBe(true);
    expect(observationCandidateSchema.safeParse({ ...old, sourceBinding: { headingEvidence: [], findingEvidence: [] } }).success).toBe(false);
  });

  it('展示名、标准名及模型 localKey 改变都不改变来源身份', () => {
    const source = manifest('检查所见\n形态规则\n血流信号丰富');
    const old = candidate('形态规则');
    const renamed = { ...old, localKey: 'new-key', originalName: '形态观察', standardNameCandidate: '形态' };
    expect(resolved(old, source).key).toBe(resolved(renamed, source).key);
    expect(reconcileReportFact(bound(renamed, source), [bound(old, source, 'saved-1')]).decision).toBe('duplicate');
  });

  it('同栏目、同页且都无日期的不同发现可以并存', () => {
    const source = manifest('检查所见\n形态规则\n血流信号丰富');
    const first = bound(candidate('形态规则'), source, 'saved-1');
    const second = bound(candidate('血流信号丰富'), source);
    expect(first.binding!.key).not.toBe(second.binding!.key);
    expect(reconcileReportFact(second, [first]).decision).toBe('addition');
  });

  it('同段真实逗号分隔的子发现可以并存，不合并为栏目', () => {
    const source = manifest('检查所见\n形态规则，回声均匀，血流信号丰富。');
    const observations = ['形态规则', '回声均匀', '血流信号丰富'].map((value, index) => bound(candidate(value), source, `saved-${index}`));
    expect(new Set(observations.map((item) => item.binding!.key)).size).toBe(3);
    for (let index = 0; index < observations.length; index += 1) {
      expect(reconcileReportFact(observations[index]!, observations.slice(0, index)).decision).toBe('addition');
    }
  });

  it('重复栏目标题无需唯一，具体发现仍须唯一', () => {
    const source = manifest('检查所见\n形态规则\n检查所见\n血流信号丰富');
    const observation = { ...candidate('血流信号丰富'), evidence: [
      { sourceSpanId: 'page-1', quote: '检查所见' }, { sourceSpanId: 'page-1', quote: '血流信号丰富' }
    ], sourceBinding: {
      headingEvidence: [{ sourceSpanId: 'page-1', quote: '检查所见' }],
      findingEvidence: [{ sourceSpanId: 'page-1', quote: '血流信号丰富' }]
    } };
    expect(resolveReportSourceBinding(observation, source).status).toBe('resolved');
  });

  it('整页重复结果不能凭模型名称猜位置，紧引用可消除歧义', () => {
    const source = manifest('第一项 未见异常\n第二项 未见异常');
    expect(resolveReportSourceBinding(candidate('未见异常', null, '第二项'), source)).toEqual({ status: 'unresolved', reason: 'finding_result_not_unique' });
    const first = resolved(candidate('未见异常', '第一项 未见异常'), source);
    const second = resolved(candidate('未见异常', '第二项 未见异常'), source);
    expect(first.key).not.toBe(second.key);
  });

  it('未端/末端转写不同不能靠模糊匹配定位', () => {
    const source = manifest('未端观察清晰');
    expect(resolveReportSourceBinding(candidate('末端观察清晰'), source).status).toBe('unresolved');
  });

  it('候选和证据排序不影响绑定', () => {
    const source = manifest('检查所见\n形态规则，回声均匀');
    const original = { ...candidate('形态规则，回声均匀', '形态规则，回声均匀'), sourceBinding: {
      headingEvidence: [], findingEvidence: [
        { sourceSpanId: 'page-1', quote: '形态规则，回声均匀' },
        { sourceSpanId: 'page-1', quote: '形态规则，回声均匀' }
      ]
    } };
    expect(resolved(original, source).key).toBe(resolved({ ...original,
      sourceBinding: { ...original.sourceBinding, findingEvidence: [...original.sourceBinding.findingEvidence].reverse() }
    }, source).key);
  });

  it('数字千位分隔不会切成两个发现位置', () => {
    const source = manifest('项目值 1,000 单位');
    expect(resolved(candidate('1,000'), source).units).toHaveLength(1);
  });

  it('旧引用中的日期或栏目补证不参与具体发现身份', () => {
    const source = manifest('检查日期：2026-01-02\n检查所见\n形态规则');
    const observation = { ...candidate('形态规则', '形态规则'), evidence: [
      { sourceSpanId: 'page-1', quote: '检查日期：2026-01-02' },
      { sourceSpanId: 'page-1', quote: '检查所见' },
      { sourceSpanId: 'page-1', quote: '形态规则' }
    ] };
    expect(resolved(observation, source).key).toBe(resolved(candidate('形态规则', '形态规则'), source).key);
  });

  it('绑定证据未附着在接受校验引用中时不能用另一处同值偷换来源', () => {
    const source = manifest('第一项 7.2\n第二项 7.2');
    const observation = { ...candidate('7.2', '第一项 7.2'), sourceBinding: {
      headingEvidence: [], findingEvidence: [{ sourceSpanId: 'page-1', quote: '第二项 7.2' }]
    } };
    expect(resolveReportSourceBinding(observation, source)).toEqual({ status: 'unresolved', reason: 'source_binding_evidence_not_attached' });
  });

  it('同一已核验连续长引用包含标题短引用时无须重复附着', () => {
    const text = '合成比值 1.35';
    const source = manifest(text);
    const observation: ObservationCandidate = { ...candidate('1.35', text, '合成比值'),
      value: { kind: 'numeric', rawText: '1.35', decimal: '1.35', comparator: 'eq' },
      sourceBinding: { headingEvidence: [{ sourceSpanId: 'page-1', quote: '合成比值' }],
        findingEvidence: [{ sourceSpanId: 'page-1', quote: text }] }
    };
    const shortAttached = { ...observation, evidence: [...observation.evidence,
      { sourceSpanId: 'page-1', quote: '合成比值' }] };
    expect(resolved(observation, source).key).toBe(resolved(shortAttached, source).key);
  });

  it('标题或结果引用不能由其他 span 或跨摘录拼接提供附着', () => {
    const source = manifest('合成比值 1.35');
    source.spans.push({ ...source.spans[0]!, id: 'page-2', page: 2 });
    const base: ObservationCandidate = { ...candidate('1.35', '合成比值 1.35', '合成比值'),
      value: { kind: 'numeric', rawText: '1.35', decimal: '1.35', comparator: 'eq' },
      sourceBinding: { headingEvidence: [{ sourceSpanId: 'page-2', quote: '合成比值' }],
        findingEvidence: [{ sourceSpanId: 'page-1', quote: '合成比值 1.35' }] }
    };
    expect(resolveReportSourceBinding(base, source)).toEqual({ status: 'unresolved', reason: 'source_binding_evidence_not_attached' });
    const split = { ...base, evidence: [{ sourceSpanId: 'page-1', quote: '合成' }, { sourceSpanId: 'page-1', quote: '比值 1.35' }],
      sourceBinding: { headingEvidence: [], findingEvidence: [{ sourceSpanId: 'page-1', quote: '合成比值 1.35' }] } };
    expect(resolveReportSourceBinding(split, source)).toEqual({ status: 'unresolved', reason: 'source_binding_evidence_not_attached' });
  });

  it('伪造长引用不提供附着，重复结果仍需唯一实际位置', () => {
    const source = manifest('合成比值 1.35\n另一项目 1.35');
    const base: ObservationCandidate = { ...candidate('1.35', source.spans[0]!.quote!, '合成比值'),
      value: { kind: 'numeric', rawText: '1.35', decimal: '1.35', comparator: 'eq' },
      sourceBinding: { headingEvidence: [{ sourceSpanId: 'page-1', quote: '合成比值' }],
        findingEvidence: [{ sourceSpanId: 'page-1', quote: source.spans[0]!.quote! }] }
    };
    expect(resolveReportSourceBinding(base, source)).toEqual({ status: 'unresolved', reason: 'finding_result_not_unique' });
    const invented = { ...base, evidence: [{ sourceSpanId: 'page-1', quote: '伪造标题 合成比值 1.35' }] };
    expect(resolveReportSourceBinding(invented, source)).toEqual({ status: 'unresolved', reason: 'source_binding_evidence_not_attached' });
  });

  it('同一物理行中的独立数值按 token 位置分开，不需血压特殊身份规则', () => {
    const source = manifest('血压 120/80 mmHg\n身高 170 cm 体重 65 kg');
    const makeNumeric = (raw: string, quote: string, unitRaw: string) => ({ ...candidate(raw, quote),
      value: { kind: 'numeric' as const, rawText: raw, decimal: raw, comparator: 'eq' as const }, unitRaw });
    const observations = [makeNumeric('120', '血压 120/80 mmHg', 'mmHg'), makeNumeric('80', '血压 120/80 mmHg', 'mmHg'),
      makeNumeric('170', '身高 170 cm 体重 65 kg', 'cm'), makeNumeric('65', '身高 170 cm 体重 65 kg', 'kg')]
      .map((value, index) => bound(value, source, `saved-${index}`));
    expect(new Set(observations.map((item) => item.binding!.key)).size).toBe(4);
    for (let index = 0; index < observations.length; index += 1) {
      expect(reconcileReportFact(observations[index]!, observations.slice(0, index)).decision).toBe('addition');
    }
  });

  it('同排左右侧重复同值由紧原文引用定位，不用左右侧名称猜永久身份', () => {
    const source = manifest('右侧 5.0 左侧 5.0');
    const makeNumeric = (quote: string) => ({ ...candidate('5.0', quote, '显示名称可以改变'),
      value: { kind: 'numeric' as const, rawText: '5.0', decimal: '5.0', comparator: 'eq' as const } });
    const right = bound(makeNumeric('右侧 5.0'), source, 'saved-right');
    const left = bound(makeNumeric('左侧 5.0'), source);
    expect(right.binding!.key).not.toBe(left.binding!.key);
    expect(reconcileReportFact(left, [right]).decision).toBe('addition');
    expect(resolveReportSourceBinding(makeNumeric('右侧 5.0 左侧 5.0'), source).status).toBe('unresolved');
  });

  it('名称或编号中的数字不冒充结果 token，维生素 B12 无专用例外', () => {
    const source = manifest('虚构指标1 1 mmol/L\n维生素B12 12 ng/L\n另一项目 120 U/L');
    const makeNumeric = (name: string, value: string, quote: string) => ({ ...candidate(value, quote, name),
      value: { kind: 'numeric' as const, rawText: value, decimal: value, comparator: 'eq' as const } });
    expect(resolved(makeNumeric('虚构指标1', '1', '虚构指标1 1 mmol/L'), source).units[0]!.segmentStart).toBe(6);
    expect(resolved(makeNumeric('维生素B12', '12', '维生素B12 12 ng/L'), source).units[0]!.segmentStart).toBeGreaterThan(source.spans[0]!.quote!.indexOf('维生素B12') + 6);
    expect(resolveReportSourceBinding(makeNumeric('另一项目', '20', '另一项目 120 U/L'), source).status).toBe('unresolved');
  });

  it('显式绑定中的标题数字仅按真实 headingEvidence 排除，名称变化不影响来源身份', () => {
    const source = manifest('指标1 1 mmol/L');
    const observation: ObservationCandidate = { ...candidate('1', '指标1 1 mmol/L', '指标1'),
      value: { kind: 'numeric', rawText: '1', decimal: '1', comparator: 'eq' }, unitRaw: 'mmol/L',
      evidence: [{ sourceSpanId: 'page-1', quote: '指标1' }, { sourceSpanId: 'page-1', quote: '指标1 1 mmol/L' }],
      sourceBinding: {
        headingEvidence: [{ sourceSpanId: 'page-1', quote: '指标1' }],
        findingEvidence: [{ sourceSpanId: 'page-1', quote: '指标1 1 mmol/L' }]
      } };
    const saved = bound(observation, source, 'saved-item');
    for (const originalName of ['指标1', '项目结果', '检查所见—独立项目']) {
      const renamed = { ...observation, originalName, localKey: `different-${originalName}`, standardNameCandidate: '另一个展示名' };
      const incoming = bound(renamed, source);
      expect(incoming.binding!.key).toBe(saved.binding!.key);
      expect(reconcileReportFact(incoming, [saved]).decision).toBe('duplicate');
    }
  });

  it('不能把后方的实际结果声明为标题再把前方标签数字冒充结果', () => {
    const source = manifest('指标1 1 mmol/L');
    const observation: ObservationCandidate = { ...candidate('1', '指标1 1 mmol/L', '任意显示名'),
      value: { kind: 'numeric', rawText: '1', decimal: '1', comparator: 'eq' }, unitRaw: 'mmol/L',
      evidence: [{ sourceSpanId: 'page-1', quote: '1 mmol/L' }, { sourceSpanId: 'page-1', quote: '指标1 1 mmol/L' }],
      sourceBinding: {
        headingEvidence: [{ sourceSpanId: 'page-1', quote: '1 mmol/L' }],
        findingEvidence: [{ sourceSpanId: 'page-1', quote: '指标1 1 mmol/L' }]
      } };
    expect(resolveReportSourceBinding(observation, source)).toEqual({ status: 'unresolved', reason: 'finding_result_not_unique' });
  });

  it('引用开头的测量结果含完整单位时也不能被声明为标题移除', () => {
    const source = manifest('1 mmol/L 另一项 1 mmol/L');
    const observation: ObservationCandidate = { ...candidate('1', '1 mmol/L 另一项 1 mmol/L', '任意显示名'),
      value: { kind: 'numeric', rawText: '1', decimal: '1', comparator: 'eq' }, unitRaw: 'mmol/L',
      evidence: [{ sourceSpanId: 'page-1', quote: '1 mmol/L 另一项' }, { sourceSpanId: 'page-1', quote: '1 mmol/L 另一项 1 mmol/L' }],
      sourceBinding: {
        headingEvidence: [{ sourceSpanId: 'page-1', quote: '1 mmol/L 另一项' }],
        findingEvidence: [{ sourceSpanId: 'page-1', quote: '1 mmol/L 另一项 1 mmol/L' }]
      } };
    expect(resolveReportSourceBinding(observation, source)).toEqual({ status: 'unresolved', reason: 'finding_result_not_unique' });
  });

  it('列分隔不能被删除后拼成一个并不存在的结果', () => {
    const source = manifest('项目甲 91 | 项目乙 94');
    expect(resolveReportSourceBinding(candidate('91 项目乙 94'), source).status).toBe('unresolved');
    expect(resolveReportSourceBinding(candidate('91项目乙94'), source).status).toBe('unresolved');
  });

  it('数字的单位和比较符是否写入 rawText 不改变实际 token 位置', () => {
    const source = manifest('项目 <2.00E＋02 copies/mL');
    const makeNumeric = (rawText: string) => ({ ...candidate(rawText, '项目 <2.00E＋02 copies/mL', '项目'),
      value: { kind: 'numeric' as const, rawText, decimal: '200', comparator: 'lt' as const }, unitRaw: 'copies/mL' });
    expect(resolved(makeNumeric('<2.00E＋02 copies/mL'), source).key).toBe(resolved(makeNumeric('2.00E＋02'), source).key);
  });

  it.each([
    ['项目甲 25 kg/m2', '25 kg/m2', '25', 'kg/m2'],
    ['项目甲 25 kg/m²', '25 kg/m²', '25', 'kg/m2'],
    ['项目甲 3.5 x10^9/L', '3.5 x10^9/L', '3.5', 'x10^9/L'],
    ['项目甲 3.5 ×10^9/L', '3.5 ×10^9/L', '3.5', 'x10^9/L'],
    ['项目甲 <2.00E＋02 x10^9/L', '<2.00E＋02 x10^9/L', '200', 'x10^9/L']
  ])('已核验的完整单位内数字不冒充第二个结果 token：%s', (text, rawText, decimal, unitRaw) => {
    const source = manifest(text);
    const observation = { ...candidate(rawText, text, '项目甲'),
      value: { kind: 'numeric' as const, rawText, decimal, comparator: rawText.startsWith('<') ? 'lt' as const : 'eq' as const }, unitRaw };
    const actualBinding = resolved(observation, source);
    expect(actualBinding.units).toHaveLength(1);
    const numericLiteral = rawText.split(' ')[0]!;
    expect(actualBinding.key).toBe(resolved({ ...observation,
      value: { ...observation.value, rawText: numericLiteral }
    }, source).key);
  });

  it('排除单位指数后仍有两个实际结果时保持疑点，不吞掉第二个数值', () => {
    const source = manifest('项目甲 25 kg/m2 30 kg/m2');
    const observation = { ...candidate('25 kg/m2 30 kg/m2', null, '项目甲'),
      value: { kind: 'numeric' as const, rawText: '25 kg/m2 30 kg/m2', decimal: '25', comparator: 'eq' as const }, unitRaw: 'kg/m2' };
    expect(resolveReportSourceBinding(observation, source)).toEqual({ status: 'unresolved', reason: 'finding_numeric_token_ambiguous' });
  });

  it('不能借完整单位的片段或错误单位来隐藏第二个数字', () => {
    const source = manifest('项目甲 25 kg/m2');
    const observation = { ...candidate('25 kg/m2', null, '项目甲'),
      value: { kind: 'numeric' as const, rawText: '25 kg/m2', decimal: '25', comparator: 'eq' as const } };
    for (const unitRaw of [null, 'm2', 'kg/m', 'kg/m3']) {
      expect(resolveReportSourceBinding({ ...observation, unitRaw }, source).status).toBe('unresolved');
    }
  });

  it('两个数字不能通过删除空格拼成一个数值 token', () => {
    const source = manifest('项目 91 94 单位');
    const observation = { ...candidate('9194', '项目 91 94 单位', '项目'),
      value: { kind: 'numeric' as const, rawText: '9194', decimal: '9194', comparator: 'eq' as const } };
    expect(resolveReportSourceBinding(observation, source)).toEqual({ status: 'unresolved', reason: 'finding_numeric_token_ambiguous' });
  });

  it('数值 token 和整句范围重叠时不能把同一内容重复新增', () => {
    const source = manifest('检查所见\n测量值 7.2 mm');
    const whole = bound(candidate('测量值 7.2 mm'), source, 'saved-whole');
    const value = { ...candidate('7.2', '测量值 7.2 mm'),
      value: { kind: 'numeric' as const, rawText: '7.2', decimal: '7.2', comparator: 'eq' as const }, unitRaw: 'mm' };
    expect(reconcileReportFact(bound(value, source), [whole]).decision).toBe('unresolved');
  });

  it('栏目引用、无效片段和不可读来源不会产生永久身份', () => {
    const source = manifest('检查所见\n形态规则');
    const observation = { ...candidate('形态规则'), evidence: [
      { sourceSpanId: 'page-1', quote: '另一栏目' }, { sourceSpanId: 'page-1', quote: '形态规则' }
    ], sourceBinding: {
      headingEvidence: [{ sourceSpanId: 'page-1', quote: '另一栏目' }], findingEvidence: [{ sourceSpanId: 'page-1', quote: '形态规则' }]
    } };
    expect(resolveReportSourceBinding(observation, source)).toEqual({ status: 'unresolved', reason: 'heading_evidence_unverified' });
    source.spans[0]!.readability = 'unreadable';
    expect(resolveReportSourceBinding(candidate('形态规则'), source).status).toBe('unresolved');
  });
});

describe('来源身份与结果语义的通用对账', () => {
  const source = manifest('项目值 1.20 mg/L\n另一项 4.5 mg/L');
  const numeric: ObservationCandidate = { ...candidate('1.20', '项目值 1.20 mg/L', '项目'),
    value: { kind: 'numeric', rawText: '1.20', decimal: '1.20', comparator: 'eq' }, unitRaw: 'mg/L' };
  const existing = bound(numeric, source, 'saved-value');

  it('同真实来源项不同数值是内容冲突而不是新增', () => {
    const incoming = { ...existing, recordId: 'candidate', fact: { ...existing.fact, decimalValue: '2.4', rawText: '2.4' } };
    expect(reconcileReportFact(incoming, [existing])).toMatchObject({ decision: 'conflict', existingRecordIds: ['saved-value'], changedFields: ['value'] });
  });

  it.each(['lt', 'lte', 'gt', 'gte'])('比较符 %s 不能与相等混为一条', (qualifier) => {
    expect(reconcileReportFact({ ...existing, fact: { ...existing.fact, qualifier } }, [existing]).decision).toBe('conflict');
  });

  it.each([
    { unit: 'cm/s' }, { specimen: '血清' }, { method: '方法 B' }, { bodySite: '左叶' },
    { valueKind: 'text' as const, rawText: '未见异常' }, { rawText: '约1.20' }
  ])('单位、标本、方法、部位、否定或近似限定不同不能静默合并 %j', (change) => {
    expect(reconcileReportFact({ ...existing, fact: { ...existing.fact, ...change } }, [existing]).decision).toBe('conflict');
  });

  it('数字相等只消除尾零，不通过浮点数丢失精度', () => {
    expect(reconcileReportFact({ ...existing, fact: { ...existing.fact, decimalValue: '1.2' } }, [existing]).decision).toBe('duplicate');
    expect(reportFactSemantics({ ...existing.fact, decimalValue: '9007199254740993' }).value)
      .not.toBe(reportFactSemantics({ ...existing.fact, decimalValue: '9007199254740992' }).value);
  });

  it('已知异常标记仅作明确词形等价，方向和未知仍不合并', () => {
    const flagged = { ...existing, fact: { ...existing.fact, abnormalFlag: 'high' } };
    expect(reconcileReportFact({ ...flagged, fact: { ...flagged.fact, abnormalFlag: '↑' } }, [flagged]).decision).toBe('duplicate');
    expect(reconcileReportFact({ ...flagged, fact: { ...flagged.fact, abnormalFlag: 'low' } }, [flagged]).decision).toBe('conflict');
    expect(reconcileReportFact({ ...flagged, fact: { ...flagged.fact, abnormalFlag: null } }, [flagged]).decision).toBe('conflict');
  });

  it('同项两个未知日期不会形成日期冲突', () => {
    expect(reconcileReportFact(existing, [existing]).decision).toBe('duplicate');
  });

  it('未知日期只有取得明确检查依据后才能版本化补充', () => {
    const incoming = { ...existing, fact: { ...existing.fact, clinicalDate: '2026-01-02' } };
    expect(reconcileReportFact(incoming, [existing]).decision).toBe('unresolved');
    expect(reconcileReportFact(incoming, [existing], { canRefineClinicalDate: () => true }))
      .toMatchObject({ decision: 'enrichment', existingRecordIds: ['saved-value'], changedFields: ['clinicalDate'] });
  });

  it.each([null, undefined,
    { version: 1 as const, status: 'complete' as const, conditions: [] },
    { version: 1 as const, status: 'unresolved' as const, conditions: [] }
  ])('旧缺失条件 %j 默认不从新候选静默补回，必须明确调用方来源证明', (clinicalContext) => {
    const fact = { ...existing.fact };
    if (clinicalContext === undefined) delete fact.clinicalContext;
    else fact.clinicalContext = clinicalContext;
    const previous: BoundReportFact = { ...existing, fact };
    const incoming = { ...previous, recordId: 'incoming-with-context', fact: { ...previous.fact, clinicalContext: {
      version: 1 as const, status: 'complete' as const, conditions: [{ sourceSpanId: 'trusted-condition', quote: '合成监测区间原句' }]
    } } };
    expect(reconcileReportFact(incoming, [previous])).toMatchObject({ decision: 'unresolved',
      existingRecordIds: ['saved-value'], changedFields: ['clinicalContext'], reasonCodes: ['clinical_context_enrichment_unproven'] });
    expect(reconcileReportFact(incoming, [previous], { canRefineClinicalContext: () => false }).decision).toBe('unresolved');
    expect(reconcileReportFact(incoming, [previous], { canRefineClinicalContext: () => true }).decision).toBe('enrichment');
  });

  it('同可信槽的旧null条件只有证明成立时独立补充，结果日期及来源身份均保持原样', () => {
    const context = { version: 1 as const, status: 'complete' as const,
      conditions: [{ sourceSpanId: 'trusted-condition', quote: '合成监测区间原句' }] };
    const previous = { ...existing, fact: { ...existing.fact, clinicalContext: null } };
    const incoming = { ...previous, recordId: 'incoming-with-context', fact: { ...previous.fact, clinicalContext: context } };
    const snapshot = structuredClone({ previous, incoming });
    let seen: BoundReportFact[] | null = null;
    expect(reconcileReportFact(incoming, [previous], { canRefineClinicalContext: (next, old) => {
      seen = [next, old]; return true;
    } })).toEqual({ decision: 'enrichment', existingRecordIds: ['saved-value'], changedFields: ['clinicalContext'], reasonCodes: [] });
    expect(seen).toEqual([incoming, previous]);
    expect({ previous, incoming }).toEqual(snapshot);
  });

  it.each([
    { version: 1 as const, status: 'unresolved' as const, conditions: [{ sourceSpanId: 'condition', quote: '合成条件' }] },
    { version: 1 as const, status: 'complete' as const, conditions: [] },
    { version: 1 as const, status: 'complete' as const, conditions: [{ sourceSpanId: 'condition', quote: '   ' }] }
  ])('不完整或空的新条件 %j 不进入enrichment，即使回调声称true', (clinicalContext) => {
    const previous = { ...existing, fact: { ...existing.fact, clinicalContext: null } };
    const incoming = { ...previous, fact: { ...previous.fact, clinicalContext } };
    let called = false;
    expect(reconcileReportFact(incoming, [previous], { canRefineClinicalContext: () => { called = true; return true; } }).decision)
      .toBe('conflict');
    expect(called).toBe(false);
  });

  it.each([
    { version: 1 as const, status: 'complete' as const, conditions: [{ sourceSpanId: 'new', quote: '已散瞳，右眼' }] },
    { version: 1 as const, status: 'complete' as const, conditions: [{ sourceSpanId: 'old', quote: '未散瞳，左眼' },
      { sourceSpanId: 'new', quote: '新增条件' }] },
    { version: 1 as const, status: 'complete' as const, conditions: [] }
  ])('已有非空条件不能被改写、追加或清除 %j，补充回调不会授权覆盖', (clinicalContext) => {
    const previous = { ...existing, fact: { ...existing.fact, clinicalContext: {
      version: 1 as const, status: 'complete' as const, conditions: [{ sourceSpanId: 'old', quote: '未散瞳，左眼' }]
    } } };
    let called = false;
    expect(reconcileReportFact({ ...previous, fact: { ...previous.fact, clinicalContext } }, [previous], {
      canRefineClinicalContext: () => { called = true; return true; }
    }).decision).toBe('conflict');
    expect(called).toBe(false);
  });

  it.each([
    { decimalValue: '2.4', rawText: '2.4' }, { qualifier: 'lt' }, { unit: 'cm/s' }, { referenceRange: '0–3' },
    { abnormalFlag: 'high' }, { specimen: '另一合成标本' }, { method: '另一合成方法' }, { bodySite: '另一侧' },
    { valueKind: 'text' as const, rawText: '未见异常' }, { rawText: '约1.20' }, { clinicalDate: '2026-01-02' }
  ])('条件补充不能掩盖其他事实语义变化 %j，即使两个proof都声称true', (change) => {
    const previous = { ...existing, fact: { ...existing.fact, clinicalContext: null } };
    const incoming = { ...previous, fact: { ...previous.fact, ...change, clinicalContext: {
      version: 1 as const, status: 'complete' as const, conditions: [{ sourceSpanId: 'condition', quote: '合成条件' }]
    } } };
    let contextCalled = false; let dateCalled = false;
    expect(reconcileReportFact(incoming, [previous], {
      canRefineClinicalContext: () => { contextCalled = true; return true; },
      canRefineClinicalDate: () => { dateCalled = true; return true; }
    }).decision).toBe('conflict');
    expect(contextCalled).toBe(false); expect(dateCalled).toBe(false);
  });

  it('仅日期变化仍须日期proof，条件proof不能为日期变化提供授权', () => {
    const incoming = { ...existing, fact: { ...existing.fact, clinicalDate: '2026-01-02' } };
    let called = false;
    expect(reconcileReportFact(incoming, [existing], { canRefineClinicalContext: () => { called = true; return true; } }))
      .toMatchObject({ decision: 'unresolved', changedFields: ['clinicalDate'], reasonCodes: ['clinical_date_enrichment_unproven'] });
    expect(called).toBe(false);
  });

  it('条件proof不能绕过旧事实无绑定或匹配多个槽位，来源不明确时不调用补充回调', () => {
    const incoming = { ...existing, fact: { ...existing.fact, clinicalContext: {
      version: 1 as const, status: 'complete' as const, conditions: [{ sourceSpanId: 'condition', quote: '合成条件' }]
    } } };
    for (const records of [[{ ...existing, binding: null }], [existing, { ...existing, recordId: 'second-old-record' }]]) {
      let called = false;
      expect(reconcileReportFact(incoming, records, { canRefineClinicalContext: () => { called = true; return true; } }).decision)
        .toBe('unresolved');
      expect(called).toBe(false);
    }
  });

  it('旧日期不因新候选缺日期而回退，两个明确日期不同则冲突', () => {
    const dated = { ...existing, fact: { ...existing.fact, clinicalDate: '2026-01-02' } };
    expect(reconcileReportFact(existing, [dated]).decision).toBe('duplicate');
    expect(reconcileReportFact({ ...dated, fact: { ...dated.fact, clinicalDate: '2026-01-03' } }, [dated]).decision).toBe('conflict');
  });

  it('跨 OCR 视图不根据同页猜测，唯一可信映射后才能判重', () => {
    const next = bound(numeric, { ...source, id: 'manifest-v2', normalizerVersion: 'synthetic-v2' });
    expect(reconcileReportFact(next, [existing]).decision).toBe('unresolved');
    expect(reconcileReportFact(next, [existing], { sameSourceUnit: () => true }).decision).toBe('duplicate');
  });

  it('同原件跨视图的不同槽位只有受控位置证明分离后才可新增', () => {
    const regionSource = { ...source, id: 'independent-region-view', normalizerVersion: 'synthetic-region-v1' };
    const other: ObservationCandidate = { ...candidate('4.5', '另一项 4.5 mg/L', '另一项'),
      value: { kind: 'numeric', rawText: '4.5', decimal: '4.5', comparator: 'eq' }, unitRaw: 'mg/L' };
    const incoming = bound(other, regionSource);
    expect(reconcileReportFact(incoming, [existing])).toMatchObject({ decision: 'unresolved', reasonCodes: ['source_binding_requires_unique_mapping'] });
    expect(reconcileReportFact(incoming, [existing], { sourcePositionsProvenDisjoint: () => false }).decision).toBe('unresolved');
    let observed: Array<ResolvedReportSourceBinding> | null = null;
    expect(reconcileReportFact(incoming, [existing], { sourcePositionsProvenDisjoint: (left, right) => {
      observed = [left, right];
      return true;
    } })).toMatchObject({ decision: 'addition', existingRecordIds: [] });
    expect(observed).toEqual([incoming.binding, existing.binding]);
  });

  it('位置分离回调不绕过无绑定旧事实、同视图重叠或真实同槽位冲突', () => {
    const regionSource = { ...source, id: 'independent-region-view', normalizerVersion: 'synthetic-region-v1' };
    const next = bound(numeric, regionSource);
    expect(reconcileReportFact(next, [{ ...existing, binding: null }], { sourcePositionsProvenDisjoint: () => true }).decision)
      .toBe('unresolved');
    const paragraph = manifest('形态规则，回声均匀。');
    const whole = bound(candidate('形态规则，回声均匀'), paragraph, 'saved-whole');
    const part = bound(candidate('回声均匀'), paragraph);
    expect(reconcileReportFact(part, [whole], { sourcePositionsProvenDisjoint: () => true }).decision).toBe('unresolved');
    const changed = { ...next, fact: { ...next.fact, decimalValue: '2.4', rawText: '2.4' } };
    expect(reconcileReportFact(changed, [existing], {
      sameSourceUnit: () => true, sourcePositionsProvenDisjoint: () => true
    })).toMatchObject({ decision: 'conflict', existingRecordIds: ['saved-value'] });
  });

  it('同页旧事实仍有一个无法证明分离时，不把局部证明扩大到全部旧记录', () => {
    const next = bound(numeric, { ...source, id: 'independent-region-view', normalizerVersion: 'synthetic-region-v1' });
    const otherSaved = { ...existing, recordId: 'unmapped-old-slot', binding: { ...existing.binding! } };
    expect(reconcileReportFact(next, [existing, otherSaved], {
      sourcePositionsProvenDisjoint: (_incoming, old) => old === existing.binding
    })).toMatchObject({ decision: 'unresolved', existingRecordIds: ['unmapped-old-slot'],
      reasonCodes: ['source_binding_requires_unique_mapping'] });
  });

  it('旧绑定无法唯一定位或者同一来源匹配多条记录时不猜新增/合并', () => {
    expect(reconcileReportFact(existing, [{ ...existing, binding: null }]).decision).toBe('unresolved');
    expect(reconcileReportFact(existing, [existing, { ...existing, recordId: 'saved-2' }])).toMatchObject({ decision: 'unresolved', existingRecordIds: ['saved-value', 'saved-2'] });
  });

  it('较大原文范围与其子发现重叠时保留歧义，不重复新增', () => {
    const paragraph = manifest('形态规则，回声均匀。');
    const whole = bound(candidate('形态规则，回声均匀'), paragraph, 'saved-paragraph');
    const part = bound(candidate('回声均匀'), paragraph);
    expect(reconcileReportFact(part, [whole]).decision).toBe('unresolved');
  });

  it('临床条件换定位但原句相同保持一致，否定和左右侧仍保留', () => {
    const context = { version: 1 as const, status: 'complete' as const, conditions: [{ sourceSpanId: 'old', quote: '未散瞳，左眼' }] };
    const withContext = { ...existing, fact: { ...existing.fact, clinicalContext: context } };
    expect(reconcileReportFact({ ...withContext, fact: { ...withContext.fact, clinicalContext: {
      ...context, conditions: [{ sourceSpanId: 'new', quote: '未散瞳，左眼' }]
    } } }, [withContext]).decision).toBe('duplicate');
    expect(reconcileReportFact({ ...withContext, fact: { ...withContext.fact, clinicalContext: {
      ...context, conditions: [{ sourceSpanId: 'new', quote: '已散瞳，右眼' }]
    } } }, [withContext]).decision).toBe('conflict');
  });
});

/** 合成原件模型回执，不调用OCR或模型，不使用真实报告或私人数据。 */
function directFixture(text = '合成字段甲：文字甲；合成字段乙：文字乙') {
  const primary: SourceSpan = { id: 'direct-page-1', documentId: 'document-1', spanKind: 'image', page: 1,
    blockId: 'direct-original-page:1', lineStart: null, lineEnd: null, quote: null, readability: 'clear' };
  const source: SourceManifest = { ...manifest('', 'direct-view'), normalizerVersion: 'direct-original-preparation-v1', spans: [primary] };
  const excerpt = (id: string, quote: string, role: NonNullable<SourceSpan['modelEvidence']>['role'] = 'finding'): SourceSpan => {
    const span: SourceSpan = { id, documentId: primary.documentId, spanKind: 'block', page: primary.page,
      blockId: `model-original-excerpt:${primary.id}`, lineStart: null, lineEnd: null, quote, readability: 'clear',
      modelEvidence: { version: 1, engine: 'codex-original-reading-v1', originalSha256: source.sha256,
        originalSourceObjectId: source.sourceObjectId, parentSourceSpanId: primary.id, inputKind: 'image', role,
        clarity: 'clear', modelId: 'gpt-6.1-sol', threadId: 'synthetic-thread', turnId: 'synthetic-turn' } };
    source.spans.push(span);
    return span;
  };
  const finding = excerpt('direct-finding', text);
  const make = (name: string, rawText: string, quote: string | null = finding.quote, heading?: SourceSpan): ObservationCandidate => {
    const ref = { sourceSpanId: finding.id, quote };
    return { ...candidate(rawText, null, name), evidence: [ref], sourceBinding: {
      headingEvidence: heading ? [{ sourceSpanId: heading.id, quote: heading.quote }] : [], findingEvidence: [ref]
    } };
  };
  const directBound = (observation: ObservationCandidate, recordId = 'incoming'): BoundReportFact => {
    const resolution = resolveDirectOriginalSourceBinding(observation, source);
    expect(resolution.status).toBe('resolved');
    if (resolution.status !== 'resolved') throw new Error(resolution.reason);
    return { recordId, fact: candidateToReconciliationFact(observation), binding: resolution.binding };
  };
  return { source, primary, excerpt, finding, make, directBound };
}

function directHeadingDuplicateFixture() {
  const title = '合成栏目甲'; const resultQuote = '合成项目 7 U/L';
  const f = directFixture(`${title}\n${resultQuote}\n合成其他记录`);
  const heading = f.excerpt('next-heading', title, 'heading');
  const original: ObservationCandidate = { ...f.make('合成项目', '7', resultQuote),
    value: { kind: 'numeric', rawText: '7', decimal: '7', comparator: 'eq' }, unitRaw: 'U/L' };
  const old = f.directBound(original, 'saved-missing-heading');
  const nextSource = f.excerpt('next-finding', f.finding.quote!);
  nextSource.modelEvidence!.turnId = 'synthetic-new-turn';
  const ref = { sourceSpanId: nextSource.id, quote: resultQuote };
  const next: ObservationCandidate = { ...structuredClone(original), localKey: 'new-model-key', evidence: [ref],
    sourceBinding: { headingEvidence: [{ sourceSpanId: heading.id, quote: null }], findingEvidence: [ref] } };
  const incoming = f.directBound(next);
  return { ...f, title, resultQuote, original, old, next, incoming, heading, nextSource };
}

function expandedSourceMappingFixture(crossPage = false) {
  const originalText = '建议结合合成检查复核，暂不调整既有安排。';
  const f = directFixture(originalText);
  f.finding.modelEvidence!.role = 'instruction';
  const original = f.make('合成既有安排', originalText, originalText);
  const old = f.directBound(original, 'saved-source-short');
  const nextFinding = f.excerpt('mapped-expanded-finding', `合成段落起始\n${originalText}\n合成段落结束`, 'instruction');
  nextFinding.modelEvidence!.turnId = 'synthetic-mapping-turn';
  const heading = f.excerpt('mapped-explicit-heading', '合成检查相关安排', 'heading');
  if (crossPage) {
    f.source.totalUnits = 2; f.source.coveredUnitIndexes = [0, 1];
    const page = { ...f.primary, id: 'direct-page-2', page: 2, blockId: 'direct-original-page:2' };
    f.source.spans.push(page); heading.page = 2; heading.blockId = `model-original-excerpt:${page.id}`;
    heading.modelEvidence!.parentSourceSpanId = page.id;
  }
  const ref = { sourceSpanId: nextFinding.id, quote: originalText };
  const next: ObservationCandidate = { ...structuredClone(original), localKey: 'candidate-explicit-mapping', evidence: [ref],
    sourceBinding: { findingEvidence: [ref], headingEvidence: [{ sourceSpanId: heading.id, quote: heading.quote }] } };
  const incoming = f.directBound(next, 'incoming:mapping');
  return { ...f, originalText, original, old, next, incoming, nextFinding, heading };
}

function alignedDirectSourceFixture() {
  const frame = '合成左侧项目\n合成比较项 <7 U/L\n合成行结束';
  const f = directFixture(frame);
  const oldHeading = f.excerpt('aligned-saved-heading', '左侧项目', 'heading');
  const original: ObservationCandidate = { ...f.make('合成比较项', '<7', '<7 U/L', oldHeading),
    value: { kind: 'numeric', rawText: '<7', decimal: '7', comparator: 'lt' }, unitRaw: 'U/L' };
  const old = f.directBound(original, 'saved-aligned-row');
  const nextSource = f.excerpt('aligned-new-frame', `合成未散瞳条件\n${frame}\n合成页末`);
  const nextHeading = f.excerpt('aligned-new-heading', '合成左侧项目', 'heading');
  const ref = { sourceSpanId: nextSource.id, quote: '合成比较项 <7 U/L' };
  const next: ObservationCandidate = { ...structuredClone(original), localKey: 'new-aligned-key', evidence: [ref],
    sourceBinding: { headingEvidence: [{ sourceSpanId: nextHeading.id, quote: null }], findingEvidence: [ref] } };
  const incoming = f.directBound(next);
  return { ...f, frame, original, old, nextSource, nextHeading, next, incoming };
}

describe('不同长度连续frame在同一来源位置的对账', () => {
  it('唯一共同坐标位置且全部医疗语义相同只判重，不把标题长短变化变成新增', () => {
    const f = alignedDirectSourceFixture(); const before = structuredClone({ old: f.old, incoming: f.incoming });
    expect(directOriginalAlignedSourceFramesProveSameSlot(f.incoming.binding!, f.old.binding!)).toBe(true);
    expect(reconcileReportFact(f.incoming, [f.old])).toEqual({ decision: 'duplicate',
      existingRecordIds: [f.old.recordId], changedFields: [], reasonCodes: [] });
    expect({ old: f.old, incoming: f.incoming }).toEqual(before);
  });

  it('旧标题有独立完整frame且在短finding之前，完整来源可共同定位时不再要求重复映射', () => {
    const f = alignedDirectSourceFixture();
    f.finding.quote = '合成比较项 <7 U/L\n合成行结束';
    const oldHeading = f.source.spans.find((span) => span.id === 'aligned-saved-heading')!;
    oldHeading.quote = '合成独立栏目页眉\n合成左侧项目\n合成栏目说明';
    f.original.sourceBinding!.headingEvidence = [{ sourceSpanId: oldHeading.id, quote: '左侧项目' }];
    f.nextSource.quote = `合成页首\n${oldHeading.quote}\n${f.finding.quote}\n合成页末`;
    const old = f.directBound(f.original, f.old.recordId); const incoming = f.directBound(f.next);
    expect(directOriginalAlignedSourceFramesProveSameSlot(incoming.binding!, old.binding!)).toBe(true);
    expect(reconcileReportFact(incoming, [old])).toEqual({ decision: 'duplicate',
      existingRecordIds: [old.recordId], changedFields: [], reasonCodes: [] });
    const changed = { ...incoming, fact: { ...incoming.fact, qualifier: 'gt' as const, rawText: '>7' } };
    expect(reconcileReportFact(changed, [old])).toMatchObject({ decision: 'conflict',
      reasonCodes: ['same_source_finding_semantic_conflict'] });
  });

  it('相同来源位置只补旧缺失且另经许可的临床条件，不借位置证明自动批准或丢掉新条件', () => {
    const f = alignedDirectSourceFixture();
    f.next.clinicalContext = { version: 1, status: 'complete',
      conditions: [{ sourceSpanId: f.nextSource.id, quote: '未散瞳' }] };
    const incoming = f.directBound(f.next);
    expect(directOriginalAlignedSourceFramesProveSameSlot(incoming.binding!, f.old.binding!)).toBe(true);
    expect(reconcileReportFact(incoming, [f.old])).toMatchObject({ decision: 'unresolved',
      changedFields: ['clinicalContext'], reasonCodes: ['clinical_context_enrichment_unproven'] });
    expect(reconcileReportFact(incoming, [f.old], { canRefineClinicalContext: () => true })).toEqual({
      decision: 'enrichment', existingRecordIds: [f.old.recordId], changedFields: ['clinicalContext'], reasonCodes: [] });
    expect(f.old.fact.clinicalContext).toBeNull();
  });

  it.each([
    { rawText: '>7', qualifier: 'gt' }, { decimalValue: '8', rawText: '<8' }, { unit: 'cm/s' },
    { bodySite: '右侧' }, { referenceRange: '0–5' }, { abnormalFlag: 'high' }, { specimen: '合成标本' },
    { method: '合成其他方法' }, { clinicalDate: '2026-08-19' }, { valueKind: 'text' as const, rawText: '未见异常' }
  ])('同slot但医疗字段变化%j不另造新事实或判为重复', (change) => {
    const f = alignedDirectSourceFixture();
    const incoming = { ...f.incoming, fact: { ...f.incoming.fact, ...change } };
    const decision = reconcileReportFact(incoming, [f.old]);
    expect(decision.decision).not.toBe('addition'); expect(decision.decision).not.toBe('duplicate');
    expect(decision.changedFields.length).toBeGreaterThan(0);
  });

  it('已保存两条同槽旧行仍保留竞争，不任意选择一个recordId', () => {
    const f = alignedDirectSourceFixture();
    expect(reconcileReportFact(f.incoming, [f.old, { ...f.old, recordId: 'saved-competing-row' }])).toMatchObject({
      decision: 'unresolved', existingRecordIds: [f.old.recordId, 'saved-competing-row'], reasonCodes: ['source_binding_ambiguous'] });
  });

  it('新引用跨出旧项目到下一行时不直接新增，必须继续来源映射', () => {
    const f = alignedDirectSourceFixture();
    f.next.sourceBinding!.findingEvidence[0]!.quote += '\n合成行结束';
    const incoming = f.directBound(f.next);
    expect(directOriginalAlignedSourceFramesProveSameSlot(incoming.binding!, f.old.binding!)).toBe(false);
    expect(directOriginalFieldsProvenDistinct(incoming.binding!, f.old.binding!)).toBe(false);
    expect(reconcileReportFact(incoming, [f.old])).toMatchObject({ decision: 'unresolved',
      reasonCodes: ['source_binding_requires_unique_mapping'] });
  });
});

describe('显式原件旧行映射仅补来源', () => {
  it.each([false, true])('扩大finding全文及跨页栏目=%s仅在进程内映射证明和写入许可均成立时补来源', (crossPage) => {
    const f = expandedSourceMappingFixture(crossPage); const before = structuredClone({ old: f.old, incoming: f.incoming });
    expect(reconcileReportFact(f.incoming, [f.old], { canRefineSourceBinding: () => true }))
      .toMatchObject({ decision: 'unresolved', reasonCodes: ['source_binding_requires_unique_mapping'] });
    const proof = createDirectOriginalSourceRefinementProof(f.incoming, f.old);
    expect(proof).toEqual({ incomingRecordId: f.incoming.recordId, existingRecordId: f.old.recordId });
    expect(reconcileReportFact(f.incoming, [f.old], { sourceRefinementProofs: [proof!], canRefineSourceBinding: () => true }))
      .toEqual({ decision: 'enrichment', existingRecordIds: [f.old.recordId], changedFields: ['sourceBinding'], reasonCodes: [] });
    expect(reconcileReportFact(f.incoming, [f.old], { sourceRefinementProofs: [proof!], canRefineSourceBinding: () => false }).decision)
      .not.toBe('enrichment');
    expect({ old: f.old, incoming: f.incoming }).toEqual(before);
  });

  it('克隆或JSON不能伪造映射，证明不能用于另一个新候选或旧行', () => {
    const f = expandedSourceMappingFixture(); const proof = createDirectOriginalSourceRefinementProof(f.incoming, f.old)!;
    for (const forged of [structuredClone(proof), JSON.parse(JSON.stringify(proof))]) {
      expect(reconcileReportFact(f.incoming, [f.old], { sourceRefinementProofs: [forged], canRefineSourceBinding: () => true }).decision)
        .toBe('unresolved');
    }
    expect(reconcileReportFact({ ...f.incoming, recordId: 'another-incoming' }, [f.old], {
      sourceRefinementProofs: [proof], canRefineSourceBinding: () => true }).decision).toBe('unresolved');
    expect(reconcileReportFact(f.incoming, [{ ...f.old, recordId: 'another-old-row' }], {
      sourceRefinementProofs: [proof], canRefineSourceBinding: () => true }).decision).toBe('unresolved');
  });

  it.each([
    { originalName: ' 合成既有安排 ' }, { rawText: '建议调整既有安排。' }, { valueKind: 'qualitative' as const },
    { decimalValue: '7' }, { qualifier: 'lt' }, { unit: 'cm/s' }, { referenceRange: '0–3' },
    { abnormalFlag: 'high' }, { specimen: '合成标本' }, { method: '合成方法' }, { bodySite: '右侧' },
    { clinicalDate: '2026-02-03' }, { clinicalContext: { version: 1 as const, status: 'complete' as const, conditions: [] } }
  ])('任何原始医疗字段变化%j都不能签发sourceBinding映射', (change) => {
    const f = expandedSourceMappingFixture();
    expect(createDirectOriginalSourceRefinementProof({ ...f.incoming, fact: { ...f.incoming.fact, ...change } }, f.old)).toBeNull();
    const proof = createDirectOriginalSourceRefinementProof(f.incoming, f.old)!;
    expect(reconcileReportFact({ ...f.incoming, fact: { ...f.incoming.fact, ...change } }, [f.old], {
      sourceRefinementProofs: [proof], canRefineSourceBinding: () => true }).decision).not.toBe('enrichment');
  });

  it('临床条件引用的编号、顺序和内容必须逐字不变，不借来源映射修正条件', () => {
    const f = expandedSourceMappingFixture();
    const context = { version: 1 as const, status: 'complete' as const,
      conditions: [{ sourceSpanId: 'condition-old', quote: '左侧未散瞳' }] };
    const old = { ...f.old, fact: { ...f.old.fact, clinicalContext: context } };
    const incoming = { ...f.incoming, fact: { ...f.incoming.fact, clinicalContext: structuredClone(context) } };
    expect(createDirectOriginalSourceRefinementProof(incoming, old)).not.toBeNull();
    incoming.fact.clinicalContext.conditions[0]!.sourceSpanId = 'condition-new';
    expect(createDirectOriginalSourceRefinementProof(incoming, old)).toBeNull();
  });

  it('签发后医疗字段或binding变更会使证明失效，不能按旧快照继续放行', () => {
    const f = expandedSourceMappingFixture(); const proof = createDirectOriginalSourceRefinementProof(f.incoming, f.old)!;
    f.old.fact.rawText += '已改变';
    expect(reconcileReportFact(f.incoming, [f.old], { sourceRefinementProofs: [proof], canRefineSourceBinding: () => true }).decision)
      .not.toBe('enrichment');
    const g = expandedSourceMappingFixture(); const bindingProof = createDirectOriginalSourceRefinementProof(g.incoming, g.old)!;
    g.incoming.binding!.directOriginalField!.headingKeys.push('forged-heading');
    expect(reconcileReportFact(g.incoming, [g.old], { sourceRefinementProofs: [bindingProof], canRefineSourceBinding: () => true }).decision)
      .toBe('unresolved');
  });

  it('两条旧行占同一原件槽时仍拒绝，不能靠选择其中一个recordId消掉歧义', () => {
    const f = expandedSourceMappingFixture(); const proof = createDirectOriginalSourceRefinementProof(f.incoming, f.old)!;
    expect(reconcileReportFact(f.incoming, [f.old, { ...f.old, recordId: 'competing-saved-row' }], {
      sourceRefinementProofs: [proof], canRefineSourceBinding: () => true }))
      .toMatchObject({ decision: 'unresolved', reasonCodes: ['source_binding_ambiguous'] });
  });

  it.each(['general-primary', 'different-frame'] as const)('其他旧行%s也能落入新槽时保留来源竞争，不按引用数组或展示名消歧', (mode) => {
    const f = expandedSourceMappingFixture();
    const ref = f.original.evidence[0]!;
    const otherCandidate = structuredClone(f.original);
    if (mode === 'general-primary') {
      otherCandidate.evidence.push({ ...ref, sourceRole: 'primary' });
      delete otherCandidate.sourceBinding;
    } else {
      const otherFrame = f.excerpt('other-old-short-frame', `合成旧页上下文\n${f.originalText}\n旧段落结束`, 'instruction');
      const otherRef = { sourceSpanId: otherFrame.id, quote: f.originalText };
      otherCandidate.evidence = [otherRef];
      otherCandidate.sourceBinding = { headingEvidence: [], findingEvidence: [otherRef] };
      otherCandidate.originalName = '另一个展示名称不能证明来源独立';
    }
    const other = f.directBound(otherCandidate, 'competing-saved-row');
    if (mode === 'different-frame') expect(sameDirectOriginalField(f.old.binding!, other.binding!)).toBe(false);
    expect(directOriginalExpandedFindingProvesSourceRefinement(f.incoming.binding!, other.binding!)).toBe(true);
    const proof = createDirectOriginalSourceRefinementProof(f.incoming, f.old)!;
    expect(reconcileReportFact(f.incoming, [f.old, other], { sourceRefinementProofs: [proof], canRefineSourceBinding: () => true }))
      .toMatchObject({ decision: 'unresolved', reasonCodes: ['source_binding_ambiguous'],
        existingRecordIds: [f.old.recordId, other.recordId] });
  });

  it('不同真实父页的同文旧行不竞争本页映射，不把全文字面相同当同槽', () => {
    const f = expandedSourceMappingFixture();
    const page = { ...f.primary, id: 'direct-other-page', page: 2, blockId: 'direct-original-page:2' };
    f.source.totalUnits = 2; f.source.coveredUnitIndexes = [0, 1]; f.source.spans.push(page);
    const otherFrame = f.excerpt('other-page-old-short', f.originalText, 'instruction');
    otherFrame.page = 2; otherFrame.blockId = `model-original-excerpt:${page.id}`;
    otherFrame.modelEvidence!.parentSourceSpanId = page.id;
    const otherRef = { sourceSpanId: otherFrame.id, quote: f.originalText };
    const other = f.directBound({ ...f.original, evidence: [otherRef],
      sourceBinding: { headingEvidence: [], findingEvidence: [otherRef] } }, 'other-page-saved-row');
    expect(directOriginalExpandedFindingProvesSourceRefinement(f.incoming.binding!, other.binding!)).toBe(false);
    const proof = createDirectOriginalSourceRefinementProof(f.incoming, f.old)!;
    expect(reconcileReportFact(f.incoming, [f.old, other], { sourceRefinementProofs: [proof], canRefineSourceBinding: () => true }))
      .toMatchObject({ decision: 'enrichment', existingRecordIds: [f.old.recordId], changedFields: ['sourceBinding'] });
  });

  it('批内位置矩阵能发现同一旧短句可落入两个不同新frame，供存储层整组拒绝', () => {
    const f = expandedSourceMappingFixture();
    const secondFrame = f.excerpt('second-new-expanded-frame', `合成另一栏目续文\n${f.originalText}\n另一段落结束`, 'instruction');
    const secondHeading = f.excerpt('second-new-heading', '合成另一栏目', 'heading');
    const ref = { sourceSpanId: secondFrame.id, quote: f.originalText };
    const second = f.directBound({ ...f.next, localKey: 'second-incoming', evidence: [ref],
      sourceBinding: { headingEvidence: [{ sourceSpanId: secondHeading.id, quote: secondHeading.quote }], findingEvidence: [ref] }
    }, 'incoming:second');
    const matchingNewBindings = [f.incoming.binding!, second.binding!]
      .filter((binding) => directOriginalExpandedFindingProvesSourceRefinement(binding, f.old.binding!));
    expect(matchingNewBindings).toHaveLength(2);
    expect(sameDirectOriginalField(matchingNewBindings[0]!, matchingNewBindings[1]!)).toBe(false);
  });

  it('显式映射与另一条自然匹配相撞时仍歧义，不能优先覆盖映射指定旧行', () => {
    const f = expandedSourceMappingFixture(); const proof = createDirectOriginalSourceRefinementProof(f.incoming, f.old)!;
    const naturallyMatched = { ...f.incoming, recordId: 'saved-already-complete' };
    expect(reconcileReportFact(f.incoming, [f.old, naturallyMatched], {
      sourceRefinementProofs: [proof], canRefineSourceBinding: () => true }))
      .toMatchObject({ decision: 'unresolved', reasonCodes: ['source_binding_ambiguous'],
        existingRecordIds: [f.old.recordId, naturallyMatched.recordId] });
  });
});

describe('补齐真实栏目仅在全部事实语义相等时判重', () => {
  it('同原件完整摘录和唯一窄finding不变，仅新增可定位heading时duplicate，旧记录及binding原样保留', () => {
    const f = directHeadingDuplicateFixture(); const before = structuredClone({ old: f.old, incoming: f.incoming });
    expect(sameDirectOriginalField(f.incoming.binding!, f.old.binding!)).toBe(false);
    expect(directOriginalHeadingAdditionProvesDuplicateSlot(f.incoming.binding!, f.old.binding!)).toBe(true);
    expect(reportFactSemantics(f.incoming.fact)).toEqual(reportFactSemantics(f.old.fact));
    expect(reconcileReportFact(f.incoming, [f.old])).toEqual({ decision: 'duplicate', existingRecordIds: ['saved-missing-heading'], changedFields: [], reasonCodes: [] });
    expect({ old: f.old, incoming: f.incoming }).toEqual(before);
  });

  it('只有明确来源增补权限才把旧缺失栏目版本化，核心充分证明仍不可由回调替代', () => {
    const f = directHeadingDuplicateFixture(); const before = structuredClone({ old: f.old, incoming: f.incoming });
    expect(reconcileReportFact(f.incoming, [f.old], { canRefineSourceBinding: () => true }))
      .toEqual({ decision: 'enrichment', existingRecordIds: ['saved-missing-heading'], changedFields: ['sourceBinding'], reasonCodes: [] });
    expect(reconcileReportFact(f.incoming, [f.old], { canRefineSourceBinding: () => false }).decision).toBe('duplicate');
    expect({ old: f.old, incoming: f.incoming }).toEqual(before);
    const alreadyComplete = { ...f.incoming, recordId: 'saved-complete' };
    expect(reconcileReportFact(f.incoming, [alreadyComplete], { canRefineSourceBinding: () => true }).decision).toBe('duplicate');
    const unbound = directFixture(); const unknown = unbound.directBound(unbound.make('未绑定旧栏目的项目', '文字甲'));
    expect(reconcileReportFact(unknown, [f.old], { canRefineSourceBinding: () => true }).decision).not.toBe('enrichment');
  });

  it.each([{ originalName: ' 合成项目 ' }, { rawText: '7.0' }, { unit: 'u/l' }, { qualifier: ' eq ' }])(
    '来源增补不借归一化更改已保存的原始字段 %j', (change) => {
      const f = directHeadingDuplicateFixture();
      const incoming = { ...f.incoming, fact: { ...f.incoming.fact, ...change } };
      expect(reconcileReportFact(incoming, [f.old], { canRefineSourceBinding: () => true }).decision).not.toBe('enrichment');
    });

  it('歧义旧槽、来源哈希不一致或未验证绑定不能由来源增补回调放行', () => {
    const f = directHeadingDuplicateFixture();
    expect(reconcileReportFact(f.incoming, [f.old, { ...f.old, recordId: 'saved-ambiguous' }],
      { canRefineSourceBinding: () => true }).decision).toBe('unresolved');
    const unverified = structuredClone(f.incoming);
    expect(reconcileReportFact(unverified, [f.old], { canRefineSourceBinding: () => true }).decision).toBe('unresolved');
    const other = directHeadingDuplicateFixture(); other.source.sha256 = 'b'.repeat(64);
    for (const span of other.source.spans) if (span.modelEvidence) span.modelEvidence.originalSha256 = other.source.sha256;
    const crossHash = other.directBound(other.next);
    expect(reconcileReportFact(crossHash, [f.old], { canRefineSourceBinding: () => true }).decision).not.toBe('enrichment');
  });

  it.each([
    { decimalValue: '8', rawText: '8' }, { qualifier: 'lt' }, { unit: 'cm/s' }, { referenceRange: '0–3' },
    { abnormalFlag: 'high' }, { specimen: '合成标本' }, { method: '合成方法' }, { bodySite: '合成右侧' },
    { valueKind: 'text' as const, rawText: '未见异常' }, { rawText: '约7' }, { clinicalDate: '2026-02-03' },
    { clinicalContext: { version: 1 as const, status: 'complete' as const, conditions: [] } },
    { clinicalContext: { version: 1 as const, status: 'complete' as const, conditions: [{ sourceSpanId: 'condition', quote: '合成条件' }] } }
  ])('任何事实语义变化 %j 都不能借新增栏目duplicate或enrichment', (change) => {
    const f = directHeadingDuplicateFixture();
    const changed = { ...f.incoming, fact: { ...f.incoming.fact, ...change } };
    let dateProofCalled = false; let contextProofCalled = false;
    expect(reconcileReportFact(changed, [f.old], {
      canRefineClinicalDate: () => { dateProofCalled = true; return true; },
      canRefineClinicalContext: () => { contextProofCalled = true; return true; }
    })).toMatchObject({ decision: 'unresolved', reasonCodes: ['source_binding_requires_unique_mapping'] });
    expect(dateProofCalled).toBe(false); expect(contextProofCalled).toBe(false);
  });

  it('新增栏目也不能借旧日期保留分支吞掉日期差异，或覆盖已有非空条件', () => {
    const f = directHeadingDuplicateFixture();
    const dated = { ...f.old, fact: { ...f.old.fact, clinicalDate: '2026-02-03' } };
    expect(reconcileReportFact(f.incoming, [dated]).decision).toBe('unresolved');
    const context = { version: 1 as const, status: 'complete' as const, conditions: [{ sourceSpanId: 'condition', quote: '左侧未散瞳' }] };
    const changed = { ...f.incoming, fact: { ...f.incoming.fact, clinicalContext: { ...context,
      conditions: [{ sourceSpanId: 'condition', quote: '右侧已散瞳' }] } } };
    expect(reconcileReportFact(changed, [{ ...f.old, fact: { ...f.old.fact, clinicalContext: context } }]).decision).toBe('unresolved');
  });

  it('必须唯一匹配：两条旧缺失栏目或一个已有普通匹配都不能被合并选择', () => {
    const f = directHeadingDuplicateFixture();
    for (const records of [[f.old, { ...f.old, recordId: 'saved-second-missing-heading' }],
      [f.old, { ...f.incoming, recordId: 'saved-already-has-heading' }]]) {
      expect(reconcileReportFact(f.incoming, records)).toMatchObject({ decision: 'unresolved', reasonCodes: ['source_binding_ambiguous'] });
    }
  });

  it('新标题虽在同页却不在共同finding全文时仍hold，不能依同名同值或外部标题猜定位', () => {
    const f = directHeadingDuplicateFixture(); f.heading.quote = '共同frame之外的标题';
    const next = f.directBound(f.next);
    expect(reconcileReportFact(next, [f.old])).toMatchObject({ decision: 'unresolved', reasonCodes: ['source_binding_requires_unique_mapping'] });
  });

  it('两个非空不同标题不走新增栏目兼容，也不由语义相等自动消解', () => {
    const f = directHeadingDuplicateFixture(); const otherHeading = f.excerpt('another-heading', '合成栏目乙', 'heading');
    const old = f.directBound({ ...f.original, sourceBinding: { findingEvidence: f.original.sourceBinding!.findingEvidence,
      headingEvidence: [{ sourceSpanId: otherHeading.id, quote: null }] } }, 'saved-other-heading');
    expect(reconcileReportFact(f.incoming, [old]).decision).toBe('unresolved');
  });

  it('full/null finding或重复finding仍不获得判重，克隆proof与任意改动binding均拒绝', () => {
    const f = directHeadingDuplicateFixture();
    for (const quote of [null, f.finding.quote]) {
      const old = f.directBound({ ...f.original, evidence: [{ sourceSpanId: f.finding.id, quote }],
        sourceBinding: { headingEvidence: [], findingEvidence: [{ sourceSpanId: f.finding.id, quote }] } });
      const next = f.directBound({ ...f.next, evidence: [{ sourceSpanId: f.nextSource.id, quote }],
        sourceBinding: { headingEvidence: f.next.sourceBinding!.headingEvidence, findingEvidence: [{ sourceSpanId: f.nextSource.id, quote }] } });
      expect(reconcileReportFact(next, [old]).decision).toBe('unresolved');
    }
    const duplicate = f.directBound({ ...f.next, sourceBinding: { ...f.next.sourceBinding!,
      findingEvidence: [...f.next.sourceBinding!.findingEvidence, ...f.next.sourceBinding!.findingEvidence] } });
    expect(reconcileReportFact(duplicate, [f.old]).decision).toBe('unresolved');
    expect(reconcileReportFact({ ...f.incoming, binding: structuredClone(f.incoming.binding!) }, [f.old]).reasonCodes)
      .toEqual(['direct_original_binding_unverified']);
    f.incoming.binding!.units[0]!.segmentStart += 1;
    expect(reconcileReportFact(f.incoming, [f.old]).reasonCodes).toEqual(['direct_original_binding_unverified']);
  });
});

describe('可信原件模型字段的通用对账，不沿用OCR区间互斥', () => {
  it('同一完整摘录的不同模型字段可并存，合理组合展示名无需逐字出现在原文', () => {
    const f = directFixture();
    const first = f.directBound(f.make('合成检查—甲项结果', '文字甲'), 'saved-a');
    const second = f.directBound(f.make('合成检查—乙项结果', '文字乙'));
    expect(first.binding!.units).toEqual(second.binding!.units);
    expect(directOriginalFieldsProvenDistinct(first.binding!, second.binding!)).toBe(true);
    expect(reconcileReportFact(second, [first], { sameSourceUnit: () => true })).toMatchObject({ decision: 'addition' });
  });

  it('同概念、同页、同栏目的两个真实唯一引用槽位可以并存；复读保持各自身份', () => {
    const f = directFixture('合成历史行甲：共同指标 7 U/L；合成历史行乙：共同指标 9 U/L');
    const heading = f.excerpt('direct-heading', '合成历史对比表', 'heading');
    const makeRow = (row: '甲' | '乙', value: string) => ({ ...f.make('共同指标', value, `合成历史行${row}：共同指标 ${value} U/L`, heading),
      value: { kind: 'numeric' as const, rawText: value, decimal: value, comparator: 'eq' as const }, unitRaw: 'U/L' });
    const first = f.directBound(makeRow('甲', '7'), 'saved-a');
    const second = f.directBound(makeRow('乙', '9'), 'saved-b');
    expect(first.binding!.directOriginalField!.fieldKey).toBe(second.binding!.directOriginalField!.fieldKey);
    expect(sameDirectOriginalField(first.binding!, second.binding!)).toBe(false);
    expect(directOriginalFieldsProvenDistinct(first.binding!, second.binding!)).toBe(true);
    expect(reconcileReportFact(second, [first], { sameSourceUnit: () => true }).decision).toBe('addition');
    // 新模型回执标识会改变，但完整同源摘录中的真实引用位置不变。
    const next = f.excerpt('direct-new-reading', f.finding.quote!);
    next.modelEvidence!.turnId = 'synthetic-new-turn';
    const firstRef = { sourceSpanId: next.id, quote: '合成历史行甲：共同指标 7 U/L' };
    const replay = f.directBound({ ...makeRow('甲', '7'), localKey: 'new-local-key', evidence: [firstRef],
      sourceBinding: { headingEvidence: [{ sourceSpanId: heading.id, quote: heading.quote }], findingEvidence: [firstRef] } });
    expect(reconcileReportFact(replay, [first, second])).toMatchObject({ decision: 'duplicate', existingRecordIds: ['saved-a'] });
  });

  it('同一唯一窄引用及栏目下，改写展示名不产生新增；真实结果矛盾仍冲突', () => {
    const f = directFixture('合成页说明；合成测量 7 U/L；另一个合成字段 9 U/L');
    const heading = f.excerpt('direct-heading', '合成检查栏目', 'heading');
    const base: ObservationCandidate = { ...f.make('合成测量', '7', '合成测量 7 U/L', heading),
      value: { kind: 'numeric', rawText: '7', decimal: '7', comparator: 'eq' }, unitRaw: 'U/L' };
    const first = f.directBound(base, 'saved-a');
    const renamed = f.directBound({ ...base, originalName: '合成检查—测量结果', localKey: 'renamed-local-key' });
    expect(first.binding!.directOriginalField!.fieldKey).not.toBe(renamed.binding!.directOriginalField!.fieldKey);
    expect(sameDirectOriginalField(first.binding!, renamed.binding!)).toBe(true);
    expect(directOriginalFieldsProvenDistinct(first.binding!, renamed.binding!)).toBe(false);
    expect(reconcileReportFact(renamed, [first])).toMatchObject({ decision: 'duplicate', existingRecordIds: ['saved-a'] });
    const conflict = f.directBound({ ...base, originalName: '合成检查—测量结果',
      value: { kind: 'numeric', rawText: '8', decimal: '8', comparator: 'eq' } });
    expect(reconcileReportFact(conflict, [first])).toMatchObject({ decision: 'conflict', existingRecordIds: ['saved-a'] });
  });

  it('同一唯一窄槽却给了不同栏目时无法证明另一个项目，不凭展示名新增或合并', () => {
    const f = directFixture('合成页说明；合成测量 7 U/L；另一个合成字段 9 U/L');
    const headings = [f.excerpt('heading-a', '合成栏目甲', 'heading'), f.excerpt('heading-b', '合成栏目乙', 'heading')];
    const first = f.directBound(f.make('合成测量', '7', '合成测量 7 U/L', headings[0]), 'saved-a');
    const second = f.directBound(f.make('另一个组合展示名', '7', '合成测量 7 U/L', headings[1]));
    expect(sameDirectOriginalField(first.binding!, second.binding!)).toBe(false);
    expect(directOriginalFieldsProvenDistinct(first.binding!, second.binding!)).toBe(false);
    expect(reconcileReportFact(second, [first]).decision).toBe('unresolved');
  });

  it.each([
    { value: { kind: 'numeric' as const, rawText: '8', decimal: '8', comparator: 'eq' as const } },
    { value: { kind: 'numeric' as const, rawText: '<7', decimal: '7', comparator: 'lt' as const } },
    { clinicalDate: '2026-02-02' }, { bodySite: '合成右侧' }, { method: '合成方法乙' },
    { value: { kind: 'text' as const, rawText: '未见合成结果' } }, { specimen: '合成标本乙' },
    { clinicalContext: { version: 1 as const, status: 'complete' as const, conditions: [] } }
  ])('同一真实槽的数值、日期、左右侧、否定、方法或条件变化仍冲突 %j', (change) => {
    const f = directFixture('合成历史行甲：共同指标 7 U/L；合成历史行乙：共同指标 9 U/L');
    const heading = f.excerpt('direct-heading', '合成历史对比表', 'heading');
    const firstCandidate: ObservationCandidate = { ...f.make('共同指标', '7', '合成历史行甲：共同指标 7 U/L', heading),
      value: { kind: 'numeric', rawText: '7', decimal: '7', comparator: 'eq' }, unitRaw: 'U/L',
      clinicalDate: '2026-01-01', bodySite: '合成左侧', method: '合成方法甲', specimen: '合成标本甲' };
    const first = f.directBound(firstCandidate, 'saved-a');
    const second = f.directBound({ ...firstCandidate, ...change, localKey: 'changed-local-key' });
    expect(sameDirectOriginalField(first.binding!, second.binding!)).toBe(true);
    expect(directOriginalFieldsProvenDistinct(first.binding!, second.binding!)).toBe(false);
    expect(reconcileReportFact(second, [first])).toMatchObject({ decision: 'conflict', existingRecordIds: ['saved-a'] });
  });

  it('两个独立摘录缺少可对齐位置时，同名同栏目的不同值不能靠新回执变成新增', () => {
    const f = directFixture('合成指标 7 U/L');
    const heading = f.excerpt('direct-heading', '合成共同栏目', 'heading');
    const first = f.directBound(f.make('合成指标', '7', null, heading), 'saved-a');
    const next = f.excerpt('direct-next', '合成指标 9 U/L');
    const ref = { sourceSpanId: next.id, quote: next.quote };
    const incoming = f.directBound({ ...f.make('合成指标', '9', null, heading), evidence: [ref],
      sourceBinding: { headingEvidence: [{ sourceSpanId: heading.id, quote: heading.quote }], findingEvidence: [ref] } });
    expect(sameDirectOriginalField(first.binding!, incoming.binding!)).toBe(true);
    expect(reconcileReportFact(incoming, [first]).decision).toBe('conflict');
  });

  it('同名同文字结果依真实不同栏目区分，general中的旧栏目可以恢复相同字段', () => {
    const f = directFixture('合成文字结果');
    const headings = [f.excerpt('heading-a', '合成栏目甲', 'heading'), f.excerpt('heading-b', '合成栏目乙', 'heading')];
    const firstCandidate = f.make('检查小结', '合成文字结果', null, headings[0]);
    const first = f.directBound(firstCandidate, 'saved-a');
    const second = f.directBound(f.make('检查小结', '合成文字结果', null, headings[1]));
    expect(reconcileReportFact(second, [first]).decision).toBe('addition');
    const historical = f.directBound({ ...firstCandidate, sourceBinding: undefined,
      evidence: [...firstCandidate.evidence, { sourceSpanId: headings[0]!.id, quote: headings[0]!.quote }] });
    expect(reconcileReportFact(historical, [first]).decision).toBe('duplicate');
  });

  it('同一真实栏目在合法heading/context间表示变化，不制造新的字段', () => {
    const f = directFixture('合成文字结果');
    const oldHeading = f.excerpt('old-context-heading', '合成固定栏目', 'context');
    const nextHeading = f.excerpt('new-heading', '合成固定栏目', 'heading');
    const first = f.directBound(f.make('合成小结', '合成文字结果', null, oldHeading), 'saved-a');
    const next = f.directBound(f.make('合成小结', '合成文字结果', null, nextHeading));
    expect(sameDirectOriginalField(first.binding!, next.binding!)).toBe(true);
    expect(directOriginalFieldsProvenDistinct(first.binding!, next.binding!)).toBe(false);
    expect(reconcileReportFact(next, [first]).decision).toBe('duplicate');
  });

  it('旧栏目引用缺失或新版只增加共同栏目引用，不证明是另一个字段', () => {
    const f = directFixture('合成文字结果');
    const heading = f.excerpt('heading-a', '合成栏目甲', 'heading');
    const sharedHeading = f.excerpt('heading-shared', '合成报告总栏目', 'heading');
    const noHeading = f.directBound(f.make('检查小结', '合成文字结果'), 'saved-missing-heading');
    const explicit = f.directBound(f.make('检查小结', '合成文字结果', null, heading));
    expect(directOriginalFieldsProvenDistinct(noHeading.binding!, explicit.binding!)).toBe(false);
    expect(reconcileReportFact(explicit, [noHeading]).decision).toBe('unresolved');
    const extra = f.directBound({ ...f.make('检查小结', '合成文字结果', null, heading), sourceBinding: {
      headingEvidence: [{ sourceSpanId: heading.id, quote: heading.quote }, { sourceSpanId: sharedHeading.id, quote: sharedHeading.quote }],
      findingEvidence: [{ sourceSpanId: f.finding.id, quote: null }]
    } });
    expect(directOriginalFieldsProvenDistinct(explicit.binding!, extra.binding!)).toBe(false);
    expect(reconcileReportFact(extra, [explicit]).decision).toBe('unresolved');
  });

  it('重复短引用仍 unresolved，不根据名称、数值或新localKey猜对应行', () => {
    const f = directFixture('合成行甲 未见异常；合成行乙 未见异常');
    expect(resolveDirectOriginalSourceBinding(f.make('合成行乙', '未见异常', '未见异常'), f.source))
      .toEqual({ status: 'unresolved', reason: 'direct_original_finding_quote_not_unique' });
  });

  it('克隆、持久化JSON或改动tag不授予字段分离权限，回调也不能绕过', () => {
    const f = directFixture();
    const saved = f.directBound(f.make('合成字段甲', '文字甲'), 'saved-a');
    const incoming = f.directBound(f.make('合成字段乙', '文字乙'));
    const forged = structuredClone(incoming.binding!);
    expect(isVerifiedDirectOriginalSourceBinding(forged)).toBe(false);
    expect(reconcileReportFact({ ...incoming, binding: forged }, [saved], {
      sameSourceUnit: () => true, sourcePositionsProvenDisjoint: () => true
    })).toMatchObject({ decision: 'unresolved', reasonCodes: ['direct_original_binding_unverified'] });
    expect(reconcileReportFact(incoming, [{ ...saved, binding: structuredClone(saved.binding!) }]).decision).toBe('unresolved');
    incoming.binding!.directOriginalField!.headingKeys.push('forged-heading-key');
    expect(reconcileReportFact(incoming, [saved]).decision).toBe('unresolved');
  });

  it('legacy/direct混合来源不凭同页同值合并，另一原件不受旧未可信tag阻塞', () => {
    const f = directFixture('合成指标 7 U/L');
    const direct = f.directBound(f.make('合成指标', '7'));
    const legacy = bound(candidate('7', '合成指标 7 U/L', '合成指标'), manifest('合成指标 7 U/L'), 'saved-legacy');
    expect(reconcileReportFact(direct, [legacy], { sameSourceUnit: () => true, sourcePositionsProvenDisjoint: () => true }).decision)
      .toBe('unresolved');
    const foreign = structuredClone(direct.binding!); foreign.sourceObjectId = 'another-original';
    expect(reconcileReportFact(direct, [{ ...direct, recordId: 'other-original', binding: foreign }]).decision).toBe('addition');
  });
});
