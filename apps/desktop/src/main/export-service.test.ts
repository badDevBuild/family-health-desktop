import { describe, expect, it } from 'vitest';
import type { MemberAssessmentSnapshotV3 } from '@contracts';
import { createDemoSnapshot } from '../../../../packages/test-fixtures/src/index.js';
import { buildMemberSummaryData, renderMemberSummaryHtml, renderMemberSummaryJson } from './export-service.js';

const syntheticAssessment = {
  id: 'synthetic-v3-current', personId: 'person-lin-ming', status: 'current',
  overview: { headline: '关注合成血脂变化', summary: '主要关注合成血脂变化。', limitations: ['只有一次较旧的检查。'] },
  limitations: ['未提供当前用药信息。'], systems: [], claims: [], questions: [],
  actions: [{ kind: 'habit', title: '新版合成行动', why: '与合成检查结果有关',
    firstStep: '先记下自己可执行的一步', timing: '本周', reviewPlan: '下周回看',
    caution: '<仅供测试>' }]
} as unknown as MemberAssessmentSnapshotV3;

describe('成员摘要导出', () => {
  it('只包含选择的成员，并按临床日期范围筛选记录', () => {
    const snapshot = createDemoSnapshot();
    const summary = buildMemberSummaryData(snapshot, {
      personId: 'person-lin-ming',
      dateFrom: '2026-01-01',
      dateTo: '2026-12-31'
    }, '2026-09-18T00:00:00.000Z');
    expect(summary.member.displayName).toBe('林明');
    expect(summary.observations).toHaveLength(2);
    expect(summary.observations.every((item) => item.date.startsWith('2026-'))).toBe(true);
    expect(summary.actionItems.every((item) => !item.title.includes('甲状腺'))).toBe(true);
    expect(renderMemberSummaryJson(summary)).not.toContain('周岚');
  });

  it('HTML 转义用户文本，并明确原始报告不随摘要导出', () => {
    const snapshot = createDemoSnapshot();
    snapshot.notes[0] = { ...snapshot.notes[0]!, immutableText: '<script>alert(1)</script>' };
    const summary = buildMemberSummaryData(snapshot, {
      personId: 'person-lin-ming',
      dateFrom: null,
      dateTo: null
    });
    const html = renderMemberSummaryHtml(summary);
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('不附原始报告');
  });

  it('当前 V3 导出同一份总述和待采纳行动，不混入旧版生活建议', () => {
    const snapshot = createDemoSnapshot();
    const summary = buildMemberSummaryData(snapshot, {
      personId: 'person-lin-ming', dateFrom: null, dateTo: null
    }, '2026-09-22T00:00:00.000Z', syntheticAssessment);
    expect(summary.assessment.summary).toBe(syntheticAssessment.overview.summary);
    expect(summary.suggestedActions).toEqual([expect.objectContaining({
      title: '新版合成行动', firstStep: '先记下自己可执行的一步'
    })]);
    expect(summary.lifestyleGuidance).toEqual([]);
    const html = renderMemberSummaryHtml(summary);
    expect(html).toContain('接下来怎么做');
    expect(html).toContain('新版合成行动');
    expect(html).toContain('&lt;仅供测试&gt;');
    expect(html).not.toContain('保持规律步行');
    const json = renderMemberSummaryJson(summary);
    expect(json).toContain('新版合成行动');
    expect(json).not.toContain('保持规律步行');
  });

  it('私有未发布核查记录不进入 HTML/JSON 健康摘要', () => {
    const assessment = structuredClone(syntheticAssessment);
    // 故意放入显眼的私有审计哨兵，导出仍只使用正式健康字段白名单。
    assessment.reviewAuditRecords = { version: 1, personId: assessment.personId,
      inputSignature: 'a'.repeat(64), records: [{ original: { value: { text: 'PRIVATE_WITHHELD_AUDIT_TEXT' } },
        modelDecision: { reason: 'PRIVATE_MODEL_REVIEW_REASON' } }] } as unknown as NonNullable<MemberAssessmentSnapshotV3['reviewAuditRecords']>;
    const summary = buildMemberSummaryData(createDemoSnapshot(), {
      personId: 'person-lin-ming', dateFrom: null, dateTo: null
    }, '2026-10-16T00:00:00Z', assessment);
    for (const output of [renderMemberSummaryHtml(summary), renderMemberSummaryJson(summary)]) {
      expect(output).not.toContain('reviewAuditRecords');
      expect(output).not.toContain('PRIVATE_WITHHELD_AUDIT_TEXT');
      expect(output).not.toContain('PRIVATE_MODEL_REVIEW_REASON');
      expect(output).toContain('新版合成行动');
    }
  });

  it('旧快照和其他成员的 V3 内容不从失效、跨成员或日期筛选导出旁路出现', () => {
    const stale = createDemoSnapshot();
    stale.persons[0] = { ...stale.persons[0]!, derivedStatus: 'stale', assessmentSummary: '旧综合敏感正文' };
    const staleSummary = buildMemberSummaryData(stale, {
      personId: 'person-lin-ming', dateFrom: null, dateTo: null
    }, '2026-09-22T00:00:00.000Z', syntheticAssessment);
    expect(staleSummary.assessment.summary).toBeNull();
    expect(staleSummary.suggestedActions).toEqual([]);
    expect(staleSummary.lifestyleGuidance).toEqual([]);
    expect(renderMemberSummaryJson(staleSummary)).not.toContain('旧综合敏感正文');
    expect(renderMemberSummaryJson(staleSummary)).not.toContain('新版合成行动');

    const otherMember = buildMemberSummaryData(createDemoSnapshot(), {
      personId: 'person-zhou-lan', dateFrom: null, dateTo: null
    }, '2026-09-22T00:00:00.000Z', syntheticAssessment);
    expect(otherMember.suggestedActions).toEqual([]);
    expect(renderMemberSummaryJson(otherMember)).not.toContain('新版合成行动');

    const limited = buildMemberSummaryData(createDemoSnapshot(), {
      personId: 'person-lin-ming', dateFrom: '2026-01-01', dateTo: '2026-12-31'
    }, '2026-09-22T00:00:00.000Z', syntheticAssessment);
    expect(limited.assessment.summary).toBeNull();
    expect(limited.suggestedActions).toEqual([]);
    expect(limited.lifestyleGuidance).toEqual([]);
    expect(limited.warnings.some((warning) => warning.includes('跨期综合及建议未纳入'))).toBe(true);
  });

  it('短标题不代替完整结果，HTML/PDF共用正文与JSON保留各层医学条件', () => {
    const assessment = structuredClone(syntheticAssessment);
    assessment.overview = { id: 'overview', headline: '视力检查结果', summary: '这次双眼视力有差异。',
      claimIds: ['synthetic-claim'], actionIds: [], limitations: ['未散瞳，不能仅据此判断屈光状态。'] };
    assessment.limitations = ['尚未提供此前配镜情况。'];
    assessment.systems = [{ id: 'system:sensory_oral', systemId: 'sensory_oral', status: 'monitor',
      headline: '眼部检查结果', summary: '右眼和左眼的结果需分别理解。', claimIds: ['synthetic-claim'], actionIds: [],
      limitations: ['两眼的检查条件不同，不应直接合并。'] }];
    assessment.claims = [{ id: 'synthetic-claim', title: '双眼视力', topicKey: 'synthetic-vision',
      systemIds: ['sensory_oral'], kind: 'interpretation', text: '右眼矫正视力5.0，左眼矫正视力4.7。仅能说明2025年这次检查时的结果。',
      rationale: '左右眼分别记录，不能把右眼结果用于左眼。', materialUncertainty: '检查时佩戴旧眼镜，不能据此确定当前配镜需求。',
      diseaseName: null, diagnosticStatus: 'undetermined', temporalStatus: 'historical', evidenceIds: ['synthetic-evidence'],
      counterEvidenceIds: [], trendIds: [], knowledgeBasis: 'not_applicable', knowledgeSourceIds: [], criteriaBasis: null, consequenceLevel: 'routine' }];
    assessment.questions = [{ id: 'synthetic-question', question: '后来是否更换过眼镜？', whyItMatters: '这会影响对当前视力的理解。',
      relatedClaimIds: ['synthetic-claim'], evidenceIds: ['synthetic-evidence'] }];
    // 原始证据只用于界面溯源，不把内部地址或对象标识随健康摘要导出。
    assessment.evidenceCatalog = [{ id: 'synthetic-evidence', kind: 'observation', observationId: 'private-object-id', eventId: null,
      documentId: 'private-document-id', sourceSpanId: 'private-span-id', knowledgeId: null, label: '合成报告',
      locator: '/tmp/family-health-synthetic/private-report.pdf', quote: '不应附带的原件摘录' }];
    const summary = buildMemberSummaryData(createDemoSnapshot(), { personId: 'person-lin-ming', dateFrom: null, dateTo: null },
      '2026-10-10T00:00:00.000Z', assessment);
    const html = renderMemberSummaryHtml(summary);
    const json = renderMemberSummaryJson(summary);
    for (const text of [assessment.overview.summary, ...assessment.overview.limitations, ...assessment.limitations,
      assessment.systems[0]!.summary, ...assessment.systems[0]!.limitations, assessment.claims[0]!.text,
      assessment.claims[0]!.rationale, assessment.claims[0]!.materialUncertainty!, assessment.questions[0]!.question,
      assessment.questions[0]!.whyItMatters]) {
      expect(html).toContain(text);
      expect(json).toContain(text);
    }
    expect(html).toContain('目前还不能确定');
    expect(summary.assessment.findings?.[0]).toMatchObject({ title: '双眼视力', bodySystems: ['眼 / 五官 / 口腔'] });
    for (const output of [html, json]) {
      expect(output).not.toContain('/tmp/family-health-synthetic/');
      expect(output).not.toContain('private-object-id');
      expect(output).not.toContain('private-span-id');
      expect(output).not.toContain('不应附带的原件摘录');
    }
  });

  it('过期或其他成员的条件、结果、问题不通过导出旁路出现', () => {
    const snapshot = createDemoSnapshot();
    const wrongOrStale = [
      { ...syntheticAssessment, status: 'stale' as const },
      { ...syntheticAssessment, personId: 'person-other' }
    ];
    for (const assessment of wrongOrStale) {
      const summary = buildMemberSummaryData(snapshot, { personId: 'person-lin-ming', dateFrom: null, dateTo: null }, undefined, assessment);
      expect(summary.assessment.summary).toBeNull();
      expect(summary.assessment.limitations).toEqual([]);
      expect(summary.assessment.systems).toEqual([]);
      expect(summary.assessment.findings).toEqual([]);
      expect(summary.assessment.questions).toEqual([]);
      expect(summary.suggestedActions).toEqual([]);
    }
  });

  it('导出中的状态用中文，结果标题不再展示软件验证过程', () => {
    const snapshot = createDemoSnapshot();
    const summary = buildMemberSummaryData(snapshot, { personId: 'person-lin-ming', dateFrom: null, dateTo: null }, undefined, syntheticAssessment);
    summary.actionItems = [{ title: '合成计划', detail: '先记录自身情况', origin: 'ai_proposed', status: 'planned', dueDate: null, dueText: null }];
    summary.sourceDocuments = [{ displayName: '合成报告.pdf', format: 'PDF', status: 'completed' }];
    const html = renderMemberSummaryHtml(summary);
    expect(html).toContain('健康解读中的建议 · 已计划');
    expect(html).toContain('PDF · 已处理');
    expect(html).not.toMatch(/planned|completed|user_reported|已复核派生说明|本机固定模板导出|新版综合建议|已接纳/);
  });

  it('新增医学解释与限制均进行HTML转义，旧摘要字段仍可渲染', () => {
    const summary = buildMemberSummaryData(createDemoSnapshot(), { personId: 'person-lin-ming', dateFrom: null, dateTo: null }, undefined, syntheticAssessment);
    summary.assessment.limitations = ['<script>限制</script>'];
    expect(renderMemberSummaryHtml(summary)).toContain('&lt;script&gt;限制&lt;/script&gt;');
    const legacy = { ...summary, assessment: { status: 'current' as const, summary: '旧格式的完整健康说明。' } };
    expect(renderMemberSummaryHtml(legacy)).toContain('旧格式的完整健康说明。');
    expect(renderMemberSummaryJson(legacy)).toContain('旧格式的完整健康说明。');
  });
});
