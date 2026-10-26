import { describe, expect, it } from 'vitest';
import type { ObservationCandidate, SourceManifest } from '@contracts';
import { reconstructLocalVisualLayout } from '../../ingestion/src/local-visual-layout.js';
import { evaluateObservationCandidate } from './index.js';

function fixture(source: string, overrides: Partial<ObservationCandidate> = {}, quote = source) {
  const manifest: SourceManifest = {
    id: 'synthetic-manifest', sourceObjectId: 'synthetic-object', sha256: 'a'.repeat(64),
    mediaType: 'image/png', originalDisplayName: '合成表格.png', totalUnits: 1,
    coveredUnitIndexes: [0], normalizerVersion: 'synthetic+local-visual-layout-v2',
    conversionWarnings: [], createdAt: '2026-01-01T00:00:00Z',
    spans: [{
      id: 'synthetic-span', documentId: 'synthetic-document', spanKind: 'image',
      page: 1, blockId: null, lineStart: null, lineEnd: null, quote: source, readability: 'clear'
    }]
  };
  const candidate: ObservationCandidate = {
    localKey: 'synthetic-candidate', originalName: '合成检查', standardNameCandidate: null,
    value: { kind: 'text', rawText: '合成描述内容' }, unitRaw: null,
    referenceRangeRaw: null, reportedAbnormalFlag: null, specimen: null,
    method: null, bodySite: null, clinicalDate: null,
    evidence: [{ sourceSpanId: 'synthetic-span', quote }], issues: [], ...overrides
  };
  return { manifest, candidate };
}

function evaluate(source: string, overrides: Partial<ObservationCandidate> = {}, quote = source) {
  const { manifest, candidate } = fixture(source, overrides, quote);
  return evaluateObservationCandidate(candidate, manifest, {
    personConsistent: true, overwritesUserLockedValue: false
  });
}

function numeric(name: string, decimal: string, unit: string | null): Partial<ObservationCandidate> {
  return {
    originalName: name, value: { kind: 'numeric', rawText: decimal, decimal, comparator: 'eq' },
    unitRaw: unit
  };
}

describe('受控来源的项目标题与排版等价', () => {
  it.each(['未见', '未见明显', '否认', '不排除', '考虑'])(
    '项目名前的限定词 %s 保留在完整原句中，不要求删除它才能通过', (qualifier) => {
      const source = `${qualifier}合成积液`;
      for (const kind of ['text', 'qualitative'] as const) {
        expect(evaluate(source, { originalName: '合成积液',
          value: kind === 'text' ? { kind, rawText: source } : { kind, rawText: source, category: null }
        })).toMatchObject({ decision: 'accept_with_warnings' });
        for (const rawText of ['合成积液', '积液']) {
          expect(evaluate(source, { originalName: '合成积液',
            value: kind === 'text' ? { kind, rawText } : { kind, rawText, category: null }
          })).toEqual({ decision: 'reject', reasons: ['reported_value_not_in_evidence'] });
        }
      }
    }
  );

  it.each(['\n', ' | ', '；', '，'])(
    '前置限定词不跨原始行、列或句子边界拼接：%s', (boundary) => {
      expect(evaluate(`未见${boundary}合成积液`, {
        originalName: '合成积液', value: { kind: 'text', rawText: '未见合成积液' }
      })).toEqual({ decision: 'reject', reasons: ['reported_value_not_in_evidence'] });
    }
  );

  it('完整否定句仍需同项目、同侧真实来源，不能借邻项或另一侧', () => {
    const source = '未见左侧合成积液 | 右侧合成积液明显';
    expect(evaluate(source, { originalName: '右侧合成积液', value: { kind: 'text', rawText: '未见左侧合成积液' } }))
      .toEqual({ decision: 'reject', reasons: ['reported_value_not_in_evidence'] });
    expect(evaluate(source, { originalName: '另一项目', value: { kind: 'text', rawText: '未见左侧合成积液' } }))
      .toEqual({ decision: 'reject', reasons: ['reported_value_not_in_evidence'] });
  });

  it('明确月日年临床日期可用于接纳，歧义日期不能按签发时间猜测', () => {
    expect(evaluate('检查日期：4/27/2026\n合成检查 合成描述内容', { clinicalDate: '2026-04-27' }))
      .toMatchObject({ decision: 'accept_with_warnings' });
    expect(evaluate('检查日期：4/7/2026\n合成检查 合成描述内容', { clinicalDate: '2026-04-07' }))
      .toEqual({ decision: 'reject', reasons: ['clinical_date_not_in_evidence'] });
  });
  it('文字结果不跨几何证明的列边界，后一列只能绑定自己的项目', () => {
    const source = '合成项目甲 正常 | 合成项目乙 未见异常';
    expect(evaluate(source, { originalName: '合成项目甲', value: { kind: 'text', rawText: '未见异常' } }))
      .toEqual({ decision: 'reject', reasons: ['reported_value_not_in_evidence'] });
    expect(evaluate(source, { originalName: '合成项目乙', value: { kind: 'text', rawText: '未见异常' } }))
      .toMatchObject({ decision: 'accept_with_warnings' });
    expect(evaluate('合成 | 检查 未见异常', { originalName: '合成检查', value: { kind: 'text', rawText: '未见异常' } }))
      .toEqual({ decision: 'reject', reasons: ['reported_value_not_in_evidence'] });
  });

  it.each(['合成项目甲', '合成项目甲检查结果', '合成项目乙'])(
    '定性结果也必须属于真实项目的结果列：%s', (name) => {
      const source = '项目 结果 单位 参考范围\n合成项目甲 | 未见异常';
      for (const quote of [source, '未见异常']) {
        expect(evaluate(source, {
          originalName: name,
          value: { kind: 'qualitative', rawText: '未见异常', category: 'normal' }
        }, quote)).toEqual({ decision: 'reject', reasons: ['reported_value_not_in_evidence'] });
      }
    }
  );

  it('真实结果正文摘录可由同一来源的项目行证明，不能借相邻结果', () => {
    const source = '合成项目甲 阴性 | 合成项目乙 阳性';
    expect(evaluate(source, {
      originalName: '合成项目甲', value: { kind: 'qualitative', rawText: '阴性', category: 'negative' }
    }, '阴性')).toMatchObject({ decision: 'accept_with_warnings' });
    expect(evaluate(source, {
      originalName: '合成项目甲', value: { kind: 'qualitative', rawText: '阳性', category: 'positive' }
    }, '阳性')).toEqual({ decision: 'reject', reasons: ['reported_value_not_in_evidence'] });
  });

  it('分科定性小结可绑定真实科室栏目，不借下一科室结果', () => {
    const internal = '内科 内科 检查日期：2026-01-02 心脏未见异常 小结 未见异常';
    const source = `${internal} 外科 外科 检查日期：2026-01-02 皮肤描述 小结 合成外科异常`;
    const partial = {
      originalName: '内科小结',
      value: { kind: 'qualitative' as const, rawText: '未见异常', category: 'no abnormality detected' }
    };
    expect(evaluate(source, partial, internal)).toMatchObject({ decision: 'accept_with_warnings' });
    expect(evaluate(source, { ...partial, value: { kind: 'qualitative', rawText: '合成外科异常', category: null } }))
      .toEqual({ decision: 'reject', reasons: ['reported_value_not_in_evidence'] });
    expect(evaluate(source, partial, '检查日期：2026-01-02'))
      .toEqual({ decision: 'reject', reasons: ['reported_value_not_in_evidence'] });
    expect(evaluate('内科\n小结 未见异常\n外科\n小结 合成外科异常', {
      ...partial, value: { kind: 'qualitative', rawText: '合成外科异常', category: null }
    })).toEqual({ decision: 'reject', reasons: ['reported_value_not_in_evidence'] });
  });

  it.each([' | ', '\n另一检查结论\n'])(
    '多个摘录不能在拼接时丢掉来源实际的列或项目边界：%s', (boundary) => {
      const { manifest, candidate } = fixture(`合成检查 正常${boundary}未见异常`, {
        value: { kind: 'text', rawText: '正常；未见异常' }
      }, '合成检查 正常');
      candidate.evidence.push({ sourceSpanId: 'synthetic-span', quote: '未见异常' });
      expect(evaluateObservationCandidate(candidate, manifest, {
        personConsistent: true, overwritesUserLockedValue: false
      })).toEqual({ decision: 'reject', reasons: ['reported_value_not_in_evidence'] });
    }
  );

  it('同一真实项目的不同摘录按来源位置保留原有顺序', () => {
    const { manifest, candidate } = fixture('合成检查\n形态正常\n未见异常', {
      value: { kind: 'text', rawText: '形态正常；未见异常' }
    }, '未见异常');
    candidate.evidence.push({ sourceSpanId: 'synthetic-span', quote: '合成检查\n形态正常' });
    expect(evaluateObservationCandidate(candidate, manifest, {
      personConsistent: true, overwritesUserLockedValue: false
    })).toMatchObject({ decision: 'accept_with_warnings' });
  });

  it.each(['检查结论\n合成描述内容', '检查结论：合成描述内容', '检查结论 合成描述内容'])(
    '显示命名空间只绑定来源中独立的真实字段标题：%s', (source) => {
      expect(evaluate(source, { originalName: '内镜检查-检查结论' }))
        .toMatchObject({ decision: 'accept_with_warnings' });
    }
  );

  it('不把任意临床项目名或内嵌提及当作真实字段标题', () => {
    expect(evaluate('肾脏检查\n检查结论\n合成描述内容', { originalName: '肝脏—检查结论' }))
      .toEqual({ decision: 'reject', reasons: ['reported_value_not_in_evidence'] });
    expect(evaluate('正文提到检查结论 合成描述内容', { originalName: '内镜检查-检查结论' }))
      .toEqual({ decision: 'reject', reasons: ['reported_value_not_in_evidence'] });
  });

  it('不借用下一字段的正文支持当前字段', () => {
    const source = '检查结论\n合成描述内容\n检查所见\n合成另一描述';
    expect(evaluate(source, {
      originalName: '内镜检查-检查结论', value: { kind: 'text', rawText: '合成另一描述' }
    }, '合成另一描述')).toEqual({ decision: 'reject', reasons: ['reported_value_not_in_evidence'] });
  });

  it('结果摘录省略标题时从同一受控来源补绑定，不修改原文', () => {
    const source = '心电图小结\n窦性心律 正常心电图\n外科小结\n合成描述内容';
    expect(evaluate(source, {
      originalName: '心电图小结', value: { kind: 'text', rawText: '窦性心律 正常心电图' }
    }, '窦性心律 正常心电图')).toMatchObject({ decision: 'accept_with_warnings' });
  });

  it('辅助日期引用不能借用同页另一项未被引用的结果', () => {
    const source = '检查日期 2026/1/2\n合成检查\n合成描述内容';
    expect(evaluate(source, {}, '检查日期 2026/1/2'))
      .toEqual({ decision: 'reject', reasons: ['reported_value_not_in_evidence'] });
  });

  it('补标题上下文后仍保留考虑、否定及左右侧限制', () => {
    expect(evaluate('合成检查\n考虑合成描述内容', {}, '合成描述内容'))
      .toEqual({ decision: 'reject', reasons: ['reported_value_not_in_evidence'] });
    expect(evaluate('左眼检查\n左眼未见异常\n右眼检查\n右眼正常', {
      originalName: '左眼检查', value: { kind: 'text', rawText: '正常' }
    }, '正常')).toEqual({ decision: 'reject', reasons: ['reported_value_not_in_evidence'] });
  });

  it('含数值文字允许换行与分号排版等价', () => {
    const source = '合成检查\n斜径 13.6 cm\n形态未见异常';
    expect(evaluate(source, { value: { kind: 'text', rawText: '斜径：13.6 cm；形态：未见异常' } }))
      .toMatchObject({ decision: 'accept_with_warnings' });
  });

  it.each([
    { source: '尺寸 13.6 cm', raw: '尺寸 136 cm' },
    { source: '尺寸 13 16 cm', raw: '尺寸 1316 cm' },
    { source: '尺寸 <13.6 cm', raw: '尺寸 13.6 cm' },
    { source: '尺寸 ≥13.6 cm', raw: '尺寸 >13.6 cm' },
    { source: '尺寸 1.36E+02 cm', raw: '尺寸 1.36 cm' },
    { source: '尺寸 13.6 cm；未见包块', raw: '尺寸 13.6 cm；见包块' }
  ])('排版等价不改变数值/比较符/否定：$raw', ({ source, raw }) => {
    expect(evaluate(`合成检查\n${source}`, { value: { kind: 'text', rawText: raw } }))
      .toEqual({ decision: 'reject', reasons: ['reported_value_not_in_evidence'] });
  });

  it('包含数值的文字不从不同来源引用拼装新结果', () => {
    const { manifest, candidate } = fixture('合成检查\n尺寸 13.6 cm', {
      value: { kind: 'text', rawText: '尺寸 13.6 cm；形态未见异常' }
    });
    manifest.spans.push({ ...manifest.spans[0]!, id: 'other-span', quote: '形态未见异常' });
    candidate.evidence.push({ sourceSpanId: 'other-span', quote: '形态未见异常' });
    expect(evaluateObservationCandidate(candidate, manifest, { personConsistent: true, overwritesUserLockedValue: false }))
      .toEqual({ decision: 'reject', reasons: ['reported_value_not_in_evidence'] });
  });
});

describe('数值和完整单位仍按可靠来源行绑定', () => {
  it.each(['61.2', '63.4'])(
    '一个项目的纯数值对比列共享末列单位，而非只准最后一个值：%s', (value) => {
      expect(evaluate('合成体重 61.2 63.4 ▲ --- kg', numeric('合成体重', value, 'kg')))
        .toMatchObject({ decision: 'accept_with_warnings' });
    }
  );

  it('对比列不得跨下一项目或参考范围共享单位', () => {
    for (const source of ['合成体重 61.2 另一体重 63.4 kg', '合成体重 61.2 参考范围 63.4 kg']) {
      expect(evaluate(source, numeric('合成体重', '61.2', 'kg')))
        .toEqual({ decision: 'reject', reasons: ['unit_not_bound_to_measurement'] });
    }
  });

  it('数值对比列共用的指数计数单位完整保留，不把指数当结果', () => {
    expect(evaluate('合成计数 3.8 4.2 x10^9/L', numeric('合成计数', '3.8', 'x10^9/L')))
      .toMatchObject({ decision: 'accept_with_warnings' });
    expect(evaluate('合成计数 3.8 4.2 x10^9/L', numeric('合成计数', '3.8', 'x10^8/L')))
      .toEqual({ decision: 'reject', reasons: ['unit_not_bound_to_measurement'] });
  });

  it('数值同侧来源可用标准简名，左右侧冲突或借另一侧结果仍拒绝', () => {
    const source = '左侧合成测量 8.6 mm | 右侧合成测量 9.3 mm';
    expect(evaluate(source, { ...numeric('左侧合成测量', '8.6', 'mm'), standardNameCandidate: '合成测量' }))
      .toMatchObject({ decision: 'accept_with_warnings' });
    expect(evaluate(source, { ...numeric('左侧合成测量', '9.3', 'mm'), standardNameCandidate: '合成测量' }))
      .toEqual({ decision: 'reject', reasons: ['numeric_value_not_in_evidence'] });
    expect(evaluate(source, { ...numeric('左侧合成测量', '8.6', 'mm'), standardNameCandidate: '右侧合成测量' }))
      .toEqual({ decision: 'reject', reasons: ['laterality_name_conflict'] });
  });
  it.each(['cm/s', 'AU/mL', 'kg/m²', 'x10^9/L'])(
    '标题后、结果前的明确完整单位字段可以绑定：%s', (unit) => {
      expect(evaluate(`合成项目 (${unit}) 19.6`, numeric('合成项目', '19.6', unit)))
        .toMatchObject({ decision: 'accept_with_warnings' });
    }
  );

  it.each(['另一项目 U/L', '解释文字 U/L', '\nU/L', ' | U/L'])(
    '结果后的相邻项目或其他区域单位不能被借用：%s', (suffix) => {
      expect(evaluate(`合成项目 19.6 ${suffix}`, numeric('合成项目', '19.6', 'U/L')))
        .toEqual({ decision: 'reject', reasons: ['unit_not_bound_to_measurement'] });
    }
  );

  it('前置单位不能跨项目，也不能覆盖紧邻结果的冲突单位', () => {
    for (const source of ['合成项目 另一项目 U/L 19.6', '合成项目 U/L 19.6 AU/mL']) {
      expect(evaluate(source, numeric('合成项目', '19.6', 'U/L')))
        .toEqual({ decision: 'reject', reasons: ['unit_not_bound_to_measurement'] });
    }
  });
  it('copies/mL 与科学计数法保持完整，不能换成另一单位', () => {
    const source = '合成核酸 <2.30E+02 copies/mL';
    const partial = {
      ...numeric('合成核酸', '230', 'copies/mL'),
      value: { kind: 'numeric' as const, rawText: '<2.30E+02', decimal: '230', comparator: 'lt' as const }
    };
    expect(evaluate(source, partial)).toMatchObject({ decision: 'accept_with_warnings' });
    for (const wrong of ['IU/mL', 'cm/s']) {
      expect(evaluate(source, { ...partial, unitRaw: wrong }))
        .toEqual({ decision: 'reject', reasons: ['unit_not_bound_to_measurement'] });
    }
  });

  it.each(['AU/mL', 'S/CO', 'AU'])(
    '未收录单位 %s 只比较完整字面，不靠常识替换', (unit) => {
      const source = `合成项目 21.7 ${unit}`;
      expect(evaluate(source, numeric('合成项目', '21.7', unit)))
        .toMatchObject({ decision: 'accept_with_warnings' });
      expect(evaluate(source, numeric('合成项目', '21.7', 'IU/mL')))
        .toEqual({ decision: 'reject', reasons: ['unit_not_bound_to_measurement'] });
    }
  );

  it.each([
    { sourceUnit: 'LongAU/mL', reportedUnit: 'AU/mL' },
    { sourceUnit: 'Longcopies/mL', reportedUnit: 'copies/mL' },
    { sourceUnit: 'arbitrary.units/mL', reportedUnit: 'units/mL' }
  ])('不取长单位的子串：$sourceUnit', ({ sourceUnit, reportedUnit }) => {
    expect(evaluate(`合成项目 21.7 ${sourceUnit}`, numeric('合成项目', '21.7', reportedUnit)))
      .toEqual({ decision: 'reject', reasons: ['unit_not_bound_to_measurement'] });
  });

  it('计数单位中的 10 指数不是下一项数值', () => {
    expect(evaluate('合成细胞 5.8 x10^9/L', numeric('合成细胞', '5.8', 'x10^9/L')))
      .toMatchObject({ decision: 'accept_with_warnings' });
  });

  it('来源无单位时保留 null，不接受模型补充单位', () => {
    expect(evaluate('合成项目 21.7', numeric('合成项目', '21.7', null)))
      .toMatchObject({ decision: 'accept_with_warnings' });
    expect(evaluate('合成项目 21.7', numeric('合成项目', '21.7', 'mmol/L')))
      .toEqual({ decision: 'reject', reasons: ['unit_not_bound_to_measurement'] });
  });

  it('摘录刚好在结果结束时，仅从同一真实行补其紧邻单位', () => {
    expect(evaluate('合成项目 21.7 AU/mL', numeric('合成项目', '21.7', 'AU/mL'), '合成项目 21.7'))
      .toMatchObject({ decision: 'accept_with_warnings' });
    for (const source of ['合成项目 21.7\n另一项目 21.7 AU/mL', '合成项目 21.7 | AU/mL']) {
      expect(evaluate(source, numeric('合成项目', '21.7', 'AU/mL'), '合成项目 21.7'))
        .toEqual({ decision: 'reject', reasons: ['unit_not_bound_to_measurement'] });
    }
    expect(evaluate('合成项目 21.7 AU/mL\n合成项目 21.7 IU/mL',
      numeric('合成项目', '21.7', 'AU/mL'), '合成项目 21.7'))
      .toEqual({ decision: 'reject', reasons: ['unit_not_bound_to_measurement'] });
  });

  it.each(['μmol/L', 'µmol/L', 'μmol／L', 'umol/L'])(
    '识别完整微摩尔单位，不截掉前缀：%s', (unit) => {
      expect(evaluate(`合成项目 21.7 ${unit}`, numeric('合成项目', '21.7', 'μmol/L')))
        .toMatchObject({ decision: 'accept_with_warnings' });
      expect(evaluate(`合成项目 21.7 ${unit}`, numeric('合成项目', '21.7', 'mmol/L')))
        .toEqual({ decision: 'reject', reasons: ['unit_not_bound_to_measurement'] });
    }
  );

  it.each(['cm/s', 'mm/s', 'm/s'])(
    '整单位比较，不将复合单位 %s 截成长度单位', (unit) => {
      expect(evaluate(`合成峰值 18.2 ${unit}`, numeric('合成峰值', '18.2', unit)))
        .toMatchObject({ decision: 'accept_with_warnings' });
      expect(evaluate(`合成峰值 18.2 ${unit}`, numeric('合成峰值', '18.2', unit.split('/')[0]!)))
        .toEqual({ decision: 'reject', reasons: ['unit_not_bound_to_measurement'] });
    }
  );

  it('未经布局证明的 OCR 换行不盲目跨行借值', () => {
    expect(evaluate('合成项目甲\n合成项目乙\n18.2\n7.1 U/L', numeric('合成项目甲', '7.1', 'U/L')))
      .toEqual({ decision: 'reject', reasons: ['measurement_name_not_in_evidence', 'numeric_value_not_in_evidence'] });
  });

  it('共用部位前缀不能越过列边界补成相邻项目，原有同列尺寸仍可用', () => {
    expect(evaluate('合成左侧叶前后径 12.8 mm，左右径 13.7 mm',
      numeric('合成左侧叶左右径', '13.7', 'mm'))).toMatchObject({ decision: 'accept_with_warnings' });
    expect(evaluate('合成左侧叶前后径 12.8 mm | 合成右侧叶左右径 13.7 mm',
      numeric('合成左侧叶左右径', '13.7', 'mm')))
      .toEqual({ decision: 'reject', reasons: ['measurement_name_not_in_evidence', 'numeric_value_not_in_evidence'] });
  });

  it('独立几何布局复原真实行后接纳，不借相邻行或参考区间', () => {
    const layout = reconstructLocalVisualLayout([
      { text: '合成项目乙', confidence: 0.95, bounds: [0.08, 0.6, 0.25, 0.03] },
      { text: '7.1', confidence: 0.95, bounds: [0.5, 0.6, 0.1, 0.03] },
      { text: 'U/L', confidence: 0.95, bounds: [0.65, 0.6, 0.1, 0.03] },
      { text: '合成项目甲', confidence: 0.95, bounds: [0.08, 0.7, 0.25, 0.03] },
      { text: '18.2', confidence: 0.95, bounds: [0.5, 0.7, 0.1, 0.03] },
      { text: 'U/L', confidence: 0.95, bounds: [0.65, 0.7, 0.1, 0.03] },
      { text: '参考范围 3.0-9.0', confidence: 0.95, bounds: [0.8, 0.7, 0.18, 0.03] }
    ]);
    expect(evaluate(layout.quote, numeric('合成项目甲', '18.2', 'U/L')))
      .toMatchObject({ decision: 'accept_with_warnings' });
    for (const wrong of ['7.1', '3.0']) {
      expect(evaluate(layout.quote, numeric('合成项目甲', wrong, 'U/L')))
        .toEqual({ decision: 'reject', reasons: ['numeric_value_not_in_evidence'] });
    }
  });

  it('几何确认的同列换行名称拼回原行，比较符和单位仍独立校验', () => {
    const layout = reconstructLocalVisualLayout([
      { text: '合成受体', confidence: 0.95, bounds: [0.08, 0.72, 0.22, 0.025] },
      { text: '抗体', confidence: 0.95, bounds: [0.08, 0.684, 0.08, 0.025] },
      { text: '<0.72', confidence: 0.95, bounds: [0.5, 0.705, 0.12, 0.028] },
      { text: 'IU/L', confidence: 0.95, bounds: [0.65, 0.705, 0.1, 0.028] }
    ]);
    const partial = numeric('合成受体抗体', '0.72', 'IU/L');
    expect(evaluate(layout.quote, {
      ...partial, value: { kind: 'numeric', rawText: '<0.72', decimal: '0.72', comparator: 'lt' }
    })).toMatchObject({ decision: 'accept_with_warnings' });
    expect(evaluate(layout.quote, partial))
      .toEqual({ decision: 'reject', reasons: ['numeric_comparator_not_in_evidence'] });
  });

  it('顶部参考范围表头和空结果行不会把下限接纳为本人结果', () => {
    const layout = reconstructLocalVisualLayout([
      { text: '项目', confidence: 0.95, bounds: [0.08, 0.8, 0.15, 0.025] },
      { text: '结果', confidence: 0.95, bounds: [0.4, 0.8, 0.1, 0.025] },
      { text: '单位', confidence: 0.95, bounds: [0.6, 0.8, 0.1, 0.025] },
      { text: '参考范围', confidence: 0.95, bounds: [0.78, 0.8, 0.18, 0.025] },
      { text: '合成项目甲', confidence: 0.95, bounds: [0.08, 0.7, 0.2, 0.025] },
      { text: '3.0-9.0', confidence: 0.95, bounds: [0.78, 0.7, 0.18, 0.025] }
    ]);
    expect(layout.quote).toContain('合成项目甲 | 3.0-9.0');
    expect(evaluate(layout.quote, numeric('合成项目甲', '3.0', null)))
      .toMatchObject({ decision: 'reject', reasons: expect.arrayContaining(['numeric_value_not_in_evidence']) });
  });

  it('阈值图例与前方图表百分比不能凭出现顺序绑为同一测量', () => {
    const source = '高 8.3% (2h00min) 正常90.2% (22h00min) 低 1.5% (20min)\n高 (>8.1mmol/L) ≥8.1mmol/L 参考值（<18%）';
    expect(evaluate(source, numeric('高 (>8.1mmol/L)', '8.3', '%')))
      .toEqual({ decision: 'reject', reasons: ['numeric_value_not_in_evidence'] });
  });
});

describe('部分视觉来源只接纳可靠独立引文', () => {
  function partialVisual() {
    const text = '合成检查 未见异常\n另一项目 仍需辨认';
    const { candidate, manifest } = fixture(text, { value: { kind: 'text', rawText: '未见异常' } }, '合成检查 未见异常');
    const span = manifest.spans[0]!;
    span.readability = 'partial';
    span.visualEvidence = {
      version: 1, engine: 'apple-vision-local-v1', layoutVersion: 'local-visual-layout-v2', coordinateSystem: 'normalized-bottom-left',
      reading: { mode: 'full_image', fallbackUsed: false },
      rows: [
        { line: 1, text: '合成检查 未见异常', bounds: [0.1, 0.8, 0.5, 0.04],
          boxes: [{ text: '合成检查 未见异常', confidence: 0.95, bounds: [0.1, 0.8, 0.5, 0.04] }] },
        { line: 2, text: '另一项目 仍需辨认', bounds: [0.1, 0.3, 0.5, 0.04],
          boxes: [{ text: '另一项目 仍需辨认', confidence: 0.92, bounds: [0.1, 0.3, 0.5, 0.04] }] }
      ], omittedBoxes: [{ text: '未辨认框', confidence: 0.1, bounds: [0.65, 0.3, 0.1, 0.04] }]
    };
    return { candidate, manifest, span };
  }

  it('低置信框在完全分离的另一行时不误拦可靠当前行', () => {
    const { candidate, manifest } = partialVisual();
    expect(evaluateObservationCandidate(candidate, manifest, { personConsistent: true, overwritesUserLockedValue: false }))
      .toMatchObject({ decision: 'accept_with_warnings' });
  });

  it('不可辨认框在当前行，即使另一列也不能假定它无关', () => {
    const { candidate, manifest, span } = partialVisual();
    span.visualEvidence!.omittedBoxes[0]!.bounds = [0.65, 0.8, 0.1, 0.04];
    expect(evaluateObservationCandidate(candidate, manifest, { personConsistent: true, overwritesUserLockedValue: false }))
      .toEqual({ decision: 'reject', reasons: ['image_evidence_unverified'] });
  });

  it.each(['legacy', 'repeated', 'mismatched', 'whole_page', 'low_confidence'])(
    '来源元数据不完整、引文不唯一或包含疑点行仍不接纳：%s', (variant) => {
      const { candidate, manifest, span } = partialVisual();
      if (variant === 'legacy') delete span.visualEvidence;
      if (variant === 'repeated') {
        span.visualEvidence!.rows[1]!.text = span.visualEvidence!.rows[0]!.text;
        span.quote = span.visualEvidence!.rows.map((row) => row.text).join('\n');
      }
      if (variant === 'mismatched') span.visualEvidence!.rows[0]!.text = '另一份来源';
      if (variant === 'whole_page') candidate.evidence[0]!.quote = span.quote;
      if (variant === 'low_confidence') span.visualEvidence!.rows[0]!.boxes[0]!.confidence = 0.1;
      expect(evaluateObservationCandidate(candidate, manifest, { personConsistent: true, overwritesUserLockedValue: false }))
        .toEqual({ decision: 'reject', reasons: ['image_evidence_unverified'] });
    }
  );
});
