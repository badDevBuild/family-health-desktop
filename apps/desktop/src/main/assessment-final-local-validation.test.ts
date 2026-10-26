import { describe, expect, it } from 'vitest';
import type { MemberAssessmentCandidateV3, MemberEvidenceRef } from '@contracts';
import { finalizeAssessmentLocalIssues } from './member-assessment-pipeline.js';
import { applyFocusedReview } from './clinical-review-router.js';
import { validateAssessmentCandidate } from './assessment-validation.js';

function fixture() {
  const source: MemberEvidenceRef = { id: 'source', kind: 'source_span', documentId: 'doc',
    sourceSpanId: 'span', observationId: null, eventId: null, knowledgeId: null,
    label: '合成来源', locator: '第1页', quote: '合成检查记录。' };
  const safe: MemberAssessmentCandidateV3['claims'][number] = { id: 'safe', topicKey: 'safe',
    systemIds: ['cardiovascular'], kind: 'source_fact', text: '报告记录了既有测量结果。',
    diseaseName: null, diagnosticStatus: null, temporalStatus: 'historical', evidenceIds: ['source'],
    counterEvidenceIds: [], trendIds: [], knowledgeBasis: 'not_applicable', knowledgeSourceIds: [],
    criteriaBasis: null, rationale: '仅转述原有记录。', materialUncertainty: '保留本次检查条件限制。',
    consequenceLevel: 'routine' };
  const high = { ...safe, id: 'high', topicKey: 'high', kind: 'diagnostic_assessment' as const,
    text: '可能心肌梗死。', diseaseName: '心肌梗死', diagnosticStatus: 'possible' as const,
    consequenceLevel: 'high' as const };
  const original: MemberAssessmentCandidateV3 = { schemaVersion: 3, personId: 'synthetic',
    inputSignature: 'a'.repeat(64), mode: 'full', requestedSystemIds: ['cardiovascular'],
    overview: { id: 'overview', headline: '合成概览', summary: '查看现有结果。', claimIds: ['safe', 'high'],
      actionIds: [], limitations: ['本次未散瞳。', '尚不能排除心肌梗死。'] },
    systems: [{ id: 'system:cardiovascular', systemId: 'cardiovascular', status: 'monitor',
      headline: '合成系统', summary: '查看现有结果。', claimIds: ['safe', 'high'], actionIds: [],
      limitations: ['本次未散瞳。', '尚不能排除心肌梗死。'] }], claims: [safe, high], actions: [], questions: [], knowledgeSources: [] };
  const validate = (candidate: MemberAssessmentCandidateV3) => validateAssessmentCandidate(candidate, {
    personId: original.personId, inputSignature: original.inputSignature, mode: 'full',
    requestedSystemIds: original.requestedSystemIds, evidenceCatalog: [source],
    trendIds: [], catalogKnowledgeIds: [], criteriaSets: []
  }).issues;
  return { original, safe, validate };
}

describe('最终局部门禁不升级为整份失败', () => {
  it.each([
    '现有资料未提供心肌梗死的诊断记录。',
    '不能单独诊断心肌梗死。',
    '不能仅凭本次血液检查和现有症状记录诊断心肌梗死。',
    '无法单独诊断心肌梗死。'
  ])('诊断范围说明完整保留，不将独立主张和汇总一起隔离：%s', (limitation) => {
    const f = fixture();
    f.original.claims = [{ ...f.safe, materialUncertainty: limitation }];
    f.original.overview.claimIds = ['safe'];
    f.original.overview.summary = `查看既有测量结果。${limitation}`;
    f.original.overview.limitations = ['本次未散瞳。', limitation];
    f.original.systems[0]!.claimIds = ['safe'];
    f.original.systems[0]!.summary = `仅说明已有检查范围。${limitation}`;
    f.original.systems[0]!.limitations = ['本次未散瞳。', limitation];
    const before = structuredClone(f.original);
    expect(f.validate(f.original)).toEqual([]);
    const result = finalizeAssessmentLocalIssues(f.original, f.validate);
    expect(result.issues).toEqual([]);
    expect(result.steps).toEqual([]);
    expect(result.candidate).toEqual(before);
    expect(f.original).toEqual(before);
  });

  it.each(['报告明确诊断心肌梗死。', '现有资料不能排除心肌梗死。',
    '不能仅凭本次血液检查的正常结果排除心肌梗死。',
    '资料未提供既往记录，但现在明确诊断心肌梗死。',
    '不能仅凭本次检查诊断心肌梗死，但其他记录已明确诊断心肌梗死。'])(
    '真实肯定或疑似判断不能借缺资料语境跳过分型和支持检查：%s', (text) => {
      const f = fixture();
      f.original.claims = [{ ...f.safe, text }];
      f.original.overview.claimIds = ['safe'];
      f.original.overview.summary = text;
      f.original.overview.limitations = ['本次未散瞳。'];
      f.original.systems[0]!.claimIds = ['safe'];
      f.original.systems[0]!.summary = text;
      f.original.systems[0]!.limitations = ['本次未散瞳。'];
      const issues = f.validate(f.original);
      expect(issues).toContain('high_impact_claim_untyped:safe');
      expect(issues).toContain('unsupported_high_impact_text:overview');
      expect(issues).toContain('unsupported_high_impact_text:system:cardiovascular');
    }
  );

  it('后置主张隔离使旧汇总失去前提时，只隔离整个旧汇总并保留独立主张及其真实条件', () => {
    const f = fixture();
    expect(f.validate(f.original)).toEqual([]);
    const late = applyFocusedReview(f.original, { schemaVersion: 1, personId: f.original.personId,
      inputSignature: f.original.inputSignature, results: [{ targetId: 'high', verdict: 'hold',
        reason: '合成后置边界隔离。', replacement: null }] }, ['high']);
    expect(f.validate(late.candidate)).toEqual(['unsupported_high_impact_text:overview',
      'unsupported_high_impact_text:system:cardiovascular']);
    const result = finalizeAssessmentLocalIssues(late.candidate, f.validate);
    expect(result.issues).toEqual([]);
    expect(result.candidate?.claims).toEqual([f.safe]);
    expect(result.candidate?.overview.summary).toContain(f.safe.materialUncertainty);
    expect(result.candidate?.systems[0]?.summary).toContain(f.safe.materialUncertainty);
    expect(result.steps[0]?.before.overview.limitations).toEqual(['本次未散瞳。', '尚不能排除心肌梗死。']);
    expect(result.candidate?.overview.limitations).toEqual(['本次未散瞳。']);
    expect(result.candidate?.systems[0]?.limitations).toEqual(['本次未散瞳。']);
    expect(result.candidate?.overview.summary).not.toContain('心肌梗死');
    expect(f.original.claims).toHaveLength(2);
  });

  it.each([
    '本次未散瞳，尚不能排除心肌梗死。', '已经确诊恶性肿瘤，需要立刻处理。'
  ])('混合检查条件或操作指令时不拆句、不得靠删除限制发布：%s', (limitation) => {
    const f = fixture();
    f.original.claims = [f.safe];
    f.original.overview.claimIds = ['safe'];
    f.original.systems[0]!.claimIds = ['safe'];
    f.original.overview.limitations = [limitation];
    const result = finalizeAssessmentLocalIssues(f.original, f.validate);
    expect(result.candidate).toBeNull();
    expect(result.steps.every((step) => step.before.overview.limitations.includes(limitation))).toBe(true);
    expect(result.issues).toContain('unsupported_high_impact_text:overview');
  });

  it.each(['scope_mismatch', 'system_scope_mismatch', 'duplicate_node_id',
    'unknown_evidence:safe:foreign-source', 'unknown_claim:overview:foreign-claim',
    'unknown_knowledge:safe:foreign-knowledge'])('%s仍是整份拒绝，不能借局部隔离授予新范围', (issue) => {
    const f = fixture();
    const result = finalizeAssessmentLocalIssues(f.original, () => [issue]);
    expect(result).toEqual({ candidate: null, issues: [issue], steps: [] });
  });

  it('不收敛的局部问题最多检查固定次数，不发模型调用也不假称发布成功', () => {
    const f = fixture();
    let checks = 0;
    const result = finalizeAssessmentLocalIssues(f.original, () => {
      checks += 1;
      return ['unsupported_high_impact_text:overview'];
    });
    expect(result.candidate).toBeNull();
    expect(checks).toBeLessThanOrEqual(7);
    expect(result.issues).toEqual(['unsupported_high_impact_text:overview']);
  });
});
