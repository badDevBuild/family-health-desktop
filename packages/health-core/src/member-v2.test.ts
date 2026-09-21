import { describe, expect, it } from 'vitest';
import { cardiovascularLongitudinalFixture, thyroidAliasFixture } from '../../test-fixtures/src/member-v2.js';
import {
  bodySystemRegistry,
  buildMetricSeries,
  linkConceptToSystems,
  mapConcept,
  normalizeUnit,
  selectContextSystems,
  type TrendObservationInput
} from './member-v2.js';

function asTrendInput(value: unknown): TrendObservationInput {
  return value as TrendObservationInput;
}

describe('成员档案 v2 的术语与身体系统规则', () => {
  it('提供稳定、有顺序且不重复的 12 个身体系统', () => {
    expect(bodySystemRegistry).toHaveLength(12);
    expect(new Set(bodySystemRegistry.map((item) => item.id)).size).toBe(12);
    expect(bodySystemRegistry.map((item) => item.order)).toEqual([...bodySystemRegistry.map((item) => item.order)].sort((a, b) => a - b));
  });

  it('将经过验证的别名映射到同一概念，但不混淆游离 T4 与总 T4', () => {
    const tsh = ['TSH', '血清促甲状腺激素'].map((rawName) => mapConcept({ rawName, unit: 'mIU/L', specimen: '血清' }));
    expect(tsh.map((item) => item.conceptId)).toEqual(['thyroid-tsh', 'thyroid-tsh']);
    expect(mapConcept({ rawName: 'FT4', unit: 'pmol/L', specimen: '血清' }).conceptId).toBe('thyroid-ft4');
    expect(mapConcept({ rawName: 'T4', unit: 'ng/mL', specimen: '血清' }).conceptId).toBe('thyroid-total-t4');
  });

  it('用确定性规则只把本人补充送到相关系统', () => {
    expect(selectContextSystems({ kind: 'goal', text: '希望记录甲状腺复查准备', structuredFields: {} })).toMatchObject({
      systemIds: ['endocrine_metabolic'], basis: 'keyword'
    });
    expect(selectContextSystems({ kind: 'goal', text: '希望更有规律地生活', structuredFields: {} })).toEqual({ systemIds: [], basis: 'unscoped' });
    expect(selectContextSystems({ kind: 'constraint', text: '近期时间有限', structuredFields: {} }).systemIds).toHaveLength(12);
    expect(selectContextSystems({ kind: 'constraint', text: '膝关节不适，不能长时间走路', structuredFields: {} })).toMatchObject({
      basis: 'global_safety', systemIds: expect.arrayContaining(['cardiovascular', 'musculoskeletal'])
    });
    expect(selectContextSystems({ kind: 'free_text', text: '一条不能安全缩小范围的补充', structuredFields: { systemIds: 'renal_urinary;cardiovascular' } })).toEqual({
      systemIds: ['renal_urinary', 'cardiovascular'], basis: 'explicit'
    });
  });

  it('保留未知术语，不用模糊匹配自动改名', () => {
    expect(mapConcept({ rawName: '一个新的甲状腺复合指数' })).toMatchObject({ status: 'unmapped', conceptId: null });
  });

  it('同一事实可以直接归属一个系统并作为另一个系统的上下文', () => {
    const mapping = mapConcept({ rawName: '空腹葡萄糖测定', unit: 'mmol/L', specimen: '血清' });
    expect(linkConceptToSystems(mapping)).toEqual([
      { systemId: 'endocrine_metabolic', relation: 'direct' },
      { systemId: 'cardiovascular', relation: 'context' }
    ]);
  });

  it('规范等价单位写法但不做未经确认的数值换算', () => {
    expect(normalizeUnit(' mmol／L ')).toBe('mmol/l');
    expect(normalizeUnit('mg/dL')).toBe('mg/dl');
  });
});

describe('成员档案 v2 的确定性趋势规则', () => {
  it('把跨年 LDL 别名合并成同一条真实时间序列', () => {
    const series = buildMetricSeries(cardiovascularLongitudinalFixture.map(asTrendInput));
    expect(series).toHaveLength(1);
    expect(series[0]).toMatchObject({
      conceptId: 'loinc-like-ldl-c',
      name: '低密度脂蛋白胆固醇',
      trendFacts: { usablePointCount: 3, direction: 'increasing', spanDays: 1675, referenceBoundaryCrossings: 1 }
    });
    expect(series[0]!.points.map((point) => point.time.value)).toEqual(['2022-02-10', '2024-08-18', '2026-09-12']);
  });

  it('两点只描述前后差异，不宣称长期趋势', () => {
    const two = cardiovascularLongitudinalFixture.slice(0, 2).map(asTrendInput);
    const facts = buildMetricSeries(two)[0]!.trendFacts;
    expect(facts.direction).toBe('insufficient');
    expect(facts.statement).toContain('不足以判断长期趋势');
  });

  it('先升后降不会被统一阈值误写为连续上升', () => {
    const base = asTrendInput(cardiovascularLongitudinalFixture[0]);
    const rows: TrendObservationInput[] = [100, 106, 104].map((value, index) => ({
      ...base,
      id: `non-monotonic-${index}`,
      rawText: String(value),
      numericValue: value,
      clinicalDate: `${2022 + index}-01-01`,
      abnormalFlag: 'unknown'
    }));
    const facts = buildMetricSeries(rows)[0]!.trendFacts;
    expect(facts).toMatchObject({
      direction: 'fluctuating', latestChange: -2,
      segmentDirections: ['up', 'down'], referenceBoundaryCrossings: 0
    });
    expect(facts.statement).toContain('有升有降');
  });

  it('量纲概念缺少单位时不标为无条件可比', () => {
    const rows = cardiovascularLongitudinalFixture.slice(0, 2).map((item, index) => ({
      ...asTrendInput(item), id: `missing-unit-${index}`, unit: null
    }));
    const result = buildMetricSeries(rows)[0]!;
    expect(result.trendFacts.status).toBe('not_comparable');
    expect(result.points[0]!.comparabilityReasons).toContain('unit_unknown_for_dimensional_concept');
  });

  it('报告标记从偏高变成未知不算参考边界跨越', () => {
    const base = asTrendInput(cardiovascularLongitudinalFixture[0]);
    const rows: TrendObservationInput[] = [
      { ...base, id: 'flag-high', rawText: '4', numericValue: 4, abnormalFlag: 'high', clinicalDate: '2025-01-01', referenceLow: null, referenceHigh: null },
      { ...base, id: 'flag-unknown', rawText: '4', numericValue: 4, abnormalFlag: 'unknown', clinicalDate: '2026-01-01', referenceLow: null, referenceHigh: null }
    ];
    expect(buildMetricSeries(rows)[0]!.trendFacts).toMatchObject({
      referenceBoundaryCrossings: 0,
      reportedFlagChanges: 0
    });
  });

  it('未验证概念候选不使用标准 conceptId 合并趋势', () => {
    const proposed = mapConcept({ rawName: 'LDL', standardName: 'LDL-C', unit: 'g/L', specimen: '血清' });
    expect(proposed.status).toBe('proposed');
    const row = { ...asTrendInput(cardiovascularLongitudinalFixture[0]), rawName: 'LDL', standardName: 'LDL-C', unit: 'g/L', resolvedMapping: proposed };
    expect(buildMetricSeries([row])[0]).toMatchObject({ conceptId: null, name: 'LDL', mappingStatus: 'proposed' });
  });

  it('仅模型候选名命中词典时仍需核实，不当成已验证概念', () => {
    const proposed = mapConcept({
      rawName: '原项目名待核实（旧记录）',
      standardName: '空腹血糖',
      unit: 'mmol/L',
      specimen: '血清'
    });
    expect(proposed).toMatchObject({ conceptId: 'metabolic-fasting-glucose', status: 'proposed' });
    expect(linkConceptToSystems(proposed)).toEqual([]);
  });

  it('不把带比较符的边界值当成精确点', () => {
    const bounded: TrendObservationInput[] = cardiovascularLongitudinalFixture.slice(0, 2).map(asTrendInput);
    bounded[1] = { ...bounded[1]!, comparator: 'lt', rawText: '<3.6' };
    const result = buildMetricSeries(bounded)[0]!;
    expect(result.points[1]).toMatchObject({ numericValue: null, comparable: false });
    expect(result.points[1]!.comparabilityReasons).toContain('bounded_value_not_exact');
  });

  it('同名概念在单位、标本、方法或部位不一致时不会被强行连线', () => {
    const mixed: TrendObservationInput[] = [
      asTrendInput(cardiovascularLongitudinalFixture[0]),
      { ...asTrendInput(cardiovascularLongitudinalFixture[1]), unit: 'mg/dL' },
      { ...asTrendInput(cardiovascularLongitudinalFixture[2]), specimen: '血浆' }
    ];
    expect(buildMetricSeries(mixed)).toHaveLength(3);
  });

  it('甲状腺别名合并，但 TSH、FT4、总 T4 各自成列', () => {
    const series = buildMetricSeries(thyroidAliasFixture.map(asTrendInput));
    expect(series.map((item) => item.conceptId).sort()).toEqual(['thyroid-ft4', 'thyroid-total-t4', 'thyroid-tsh']);
    expect(series.find((item) => item.conceptId === 'thyroid-tsh')?.points).toHaveLength(2);
  });

  it('日期缺失不补零，也不进入可比较点计数', () => {
    const missingDate: TrendObservationInput = { ...asTrendInput(cardiovascularLongitudinalFixture[0]), clinicalDate: null };
    const result = buildMetricSeries([missingDate])[0]!;
    expect(result.points[0]).toMatchObject({ timestamp: null, comparable: false });
    expect(result.trendFacts.usablePointCount).toBe(0);
  });

  it('同次检查的重复来源不增加趋势点，但保留全部依据', () => {
    const input: TrendObservationInput = {
      ...asTrendInput(cardiovascularLongitudinalFixture[0]),
      evidenceSources: [
        {
          id: 'evidence-detail', kind: 'observation', observationId: 'ldl-2022', eventId: null,
          documentId: 'document-2022', sourceSpanId: 'detail-span', knowledgeId: null,
          label: '检验明细', locator: '第 2 页', quote: 'LDL-C 3.2'
        },
        {
          id: 'evidence-summary', kind: 'observation', observationId: 'ldl-2022', eventId: null,
          documentId: 'document-2022', sourceSpanId: 'summary-span', knowledgeId: null,
          label: '报告摘要', locator: '第 1 页', quote: '摘要 LDL-C 3.2'
        }
      ],
      duplicateSourceCount: 1
    };
    const result = buildMetricSeries([input])[0]!;
    expect(result.points).toHaveLength(1);
    expect(result.points[0]).toMatchObject({ duplicateSourceCount: 1 });
    expect(result.points[0]!.evidenceSources).toHaveLength(2);
  });

  it('用户确认的概念映射优先于原始名称，但原始值仍保留在趋势点', () => {
    const input: TrendObservationInput = {
      ...asTrendInput(cardiovascularLongitudinalFixture[0]),
      rawName: '尚未收录的本地简称',
      standardName: '尚未收录的本地简称',
      rawText: '3.2',
      resolvedMapping: {
        rawName: '尚未收录的本地简称',
        normalizedName: '低密度脂蛋白胆固醇',
        conceptId: 'loinc-like-ldl-c',
        canonicalName: '低密度脂蛋白胆固醇',
        status: 'verified',
        confidence: 1,
        reasons: ['用户确认；原始名称保持不变。']
      }
    };
    const result = buildMetricSeries([input])[0]!;
    expect(result).toMatchObject({ conceptId: 'loinc-like-ldl-c', name: '低密度脂蛋白胆固醇' });
    expect(result.points[0]).toMatchObject({ displayValue: '3.2' });
  });
});
