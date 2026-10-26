import { describe, expect, it } from 'vitest';
import type { ClinicalFocusedReviewV1, MemberAssessmentCandidateV3, MemberEvidencePackageV3 } from '@contracts';
import {
  applyKnowledgeAttributionReview, canonicalizeAssessmentKnowledge, pruneUnreferencedInvalidKnowledge,
  pruneUnusedCatalogKnowledge, routeKnowledgeAttributionReview, buildAssessmentKnowledgeVerifications
} from './assessment-knowledge.js';

const catalog: MemberEvidencePackageV3['knowledge'] = [
  { id: 'lab-context', version: 'synthetic-v1', title: '合成检验边界',
    content: '单次结果要结合方法、参考范围和个人背景理解。', applicability: '一般检验解释',
    sourceOrganization: '合成机构', sourceUrl: 'https://example.org/lab', reviewedAt: '2026-09-22',
    supportedScope: '仅支持通用检验边界，不支持 TSH 的生理解释。' },
  { id: 'activity-context', version: 'synthetic-v1', title: '合成活动起点',
    content: '根据身体限制从安全的少量活动开始。', applicability: '渐进活动',
    sourceOrganization: '合成机构', sourceUrl: 'https://example.org/activity', reviewedAt: '2026-09-22',
    supportedScope: '支持安全、渐进的活动起点。' }
];

function candidate(): MemberAssessmentCandidateV3 {
  return {
    schemaVersion: 3, personId: 'synthetic-member', inputSignature: 'a'.repeat(64), mode: 'full',
    requestedSystemIds: ['endocrine_metabolic'],
    overview: { id: 'overview', headline: '合成甲状腺检查', summary: 'TSH 需要结合其他结果理解。',
      claimIds: ['claim-tsh'], actionIds: ['action-followup'], limitations: ['检查时是否用药未知。'] },
    systems: [{ id: 'system:endocrine_metabolic', systemId: 'endocrine_metabolic', status: 'attention',
      headline: '合成甲状腺检查', summary: 'TSH 高于参考范围。', claimIds: ['claim-tsh'],
      actionIds: ['action-followup'], limitations: ['检查时是否用药未知。'] }],
    claims: [{ id: 'claim-tsh', topicKey: 'thyroid', systemIds: ['endocrine_metabolic'], kind: 'interpretation',
      text: 'TSH 是调节甲状腺的信号；这次 TSH 6.2 mIU/L，高于报告上限 4.2，单次结果不能确定原因。',
      diseaseName: null, diagnosticStatus: null, temporalStatus: 'current', evidenceIds: ['synthetic-tsh-result'],
      counterEvidenceIds: [], trendIds: [], knowledgeBasis: 'catalog', knowledgeSourceIds: ['lab-context'],
      criteriaBasis: null, rationale: '需结合 FT4 和检查条件理解。',
      materialUncertainty: '检查时是否用药未知。', consequenceLevel: 'routine' }],
    actions: [{ id: 'action-followup', dedupeKey: 'thyroid-followup', systemIds: ['endocrine_metabolic'],
      claimIds: ['claim-tsh'], kind: 'test_followup', title: '整理甲状腺检查资料', why: '便于结合更多条件理解。',
      firstStep: '保存本次报告，记录检查时是否用药。', timing: '下次就诊时', timingBasis: 'none',
      reviewPlan: null, caution: null, urgency: 'routine', evidenceIds: ['synthetic-tsh-result'], knowledgeSourceIds: [] }],
    questions: [], knowledgeSources: [{ id: 'lab-context', title: '合成检验边界', organization: '合成机构',
      url: 'https://example.org/lab', origin: 'catalog', supports: catalog[0]!.supportedScope }]
  };
}

function review(original: MemberAssessmentCandidateV3, results: ClinicalFocusedReviewV1['results']): ClinicalFocusedReviewV1 {
  return { schemaVersion: 1, personId: original.personId, inputSignature: original.inputSignature, results };
}

describe('医学知识归属局部核对', () => {
  it('早期清理书目后行动恢复引用，最终规范化只按实际引用补回本次确切目录元数据', () => {
    const original = candidate();
    original.claims[0]!.knowledgeSourceIds = [];
    original.claims[0]!.knowledgeBasis = 'model_general';
    original.actions[0]!.knowledgeSourceIds = ['activity-context'];
    original.knowledgeSources = [];
    const normalized = canonicalizeAssessmentKnowledge(original, { knowledge: catalog } as MemberEvidencePackageV3);
    expect(normalized.knowledgeSources).toEqual([{ id: catalog[1]!.id, origin: 'catalog', title: catalog[1]!.title,
      organization: catalog[1]!.sourceOrganization, url: catalog[1]!.sourceUrl, supports: catalog[1]!.supportedScope }]);
    expect(normalized.actions).toEqual(original.actions);
    expect(normalized.claims).toEqual(original.claims);
    expect(buildAssessmentKnowledgeVerifications(normalized, { knowledge: catalog } as MemberEvidencePackageV3))
      .toEqual([{ sourceId: catalog[1]!.id, status: 'catalog_curated', checkedAt: catalog[1]!.reviewedAt,
        contentHash: expect.any(String), toolReceiptId: null }]);
    expect(original.knowledgeSources).toEqual([]);
  });

  it('仅被诊断标准引用的确切目录同样补书目，不给未引用目录挂名', () => {
    const original = candidate();
    original.claims[0]!.knowledgeSourceIds = [];
    original.claims[0]!.criteriaBasis = { criteriaSetId: 'synthetic-criteria', sourceId: 'activity-context',
      applicability: '合成标准', requirements: [] };
    original.knowledgeSources = [];
    const normalized = canonicalizeAssessmentKnowledge(original, { knowledge: catalog } as MemberEvidencePackageV3);
    expect(normalized.knowledgeSources.map((source) => source.id)).toEqual(['activity-context']);
    expect(normalized.claims).toEqual(original.claims);
  });

  it.each(['missing', 'unknown', 'empty_content', 'conflicting_id', 'retrieved_missing'] as const)(
    '%s不能通过补书目伪造本次授权且完整的目录正文', (mode) => {
      const original = candidate();
      original.knowledgeSources = [];
      original.claims[0]!.knowledgeSourceIds = mode === 'unknown' ? ['unknown-id']
        : mode === 'retrieved_missing' ? ['retrieved-source'] : ['lab-context'];
      const entries = mode === 'missing' ? catalog.filter((entry) => entry.id !== 'lab-context')
        : mode === 'empty_content' ? catalog.map((entry) => entry.id === 'lab-context' ? { ...entry, content: '  ' } : entry)
          : mode === 'conflicting_id' ? [...catalog, { ...catalog[0]!, content: '同一ID的另一份合成正文。' }] : catalog;
      const normalized = canonicalizeAssessmentKnowledge(original, { knowledge: entries } as MemberEvidencePackageV3);
      expect(normalized.knowledgeSources).toEqual([]);
      expect(normalized.claims).toEqual(original.claims);
      expect(buildAssessmentKnowledgeVerifications(normalized, { knowledge: entries } as MemberEvidencePackageV3)).toEqual([]);
    }
  );

  it('归属审查已撤下的引用不会因目录可用而复活', () => {
    const original = candidate();
    const held = applyKnowledgeAttributionReview(original, review(original, [{ targetId: 'claim-tsh',
      verdict: 'hold', reason: '合成目录不支持该解释。', replacement: null }]), ['claim-tsh'], catalog);
    const normalized = canonicalizeAssessmentKnowledge(held, { knowledge: catalog } as MemberEvidencePackageV3);
    expect(normalized.knowledgeSources).toEqual([]);
    expect(normalized.claims[0]!.knowledgeSourceIds).toEqual([]);
    expect(normalized.claims[0]!.knowledgeBasis).toBe('model_general');
  });

  it('同ID不同检索书目不被规范化悄悄去重或转换为已读取目录', () => {
    const original = candidate();
    original.claims[0]!.knowledgeSourceIds = ['retrieved-source'];
    original.knowledgeSources = [
      { id: 'retrieved-source', origin: 'retrieved', title: '合成来源甲', organization: null,
        url: 'https://example.org/a', supports: '合成范围甲' },
      { id: 'retrieved-source', origin: 'retrieved', title: '合成来源乙', organization: null,
        url: 'https://example.org/b', supports: '合成范围乙' }
    ];
    const normalized = canonicalizeAssessmentKnowledge(original, { knowledge: catalog } as MemberEvidencePackageV3);
    expect(normalized.knowledgeSources).toEqual(original.knowledgeSources);
    expect(buildAssessmentKnowledgeVerifications(normalized, { knowledge: catalog } as MemberEvidencePackageV3))
      .toEqual(original.knowledgeSources.map((source) => ({ sourceId: source.id, status: 'model_cited',
        checkedAt: null, contentHash: null, toolReceiptId: null })));
  });

  it('无任何健康节点依赖的坏书目只移除元数据，保留全部个人正文和可靠来源', () => {
    const original = candidate();
    original.knowledgeSources.push(
      { id: 'unused-unknown', origin: 'catalog', title: '未使用的未知条目', organization: null, url: null, supports: '合成范围' },
      { id: 'unused-broken', origin: 'retrieved', title: '未使用的无效网址', organization: null, url: 'http://example.org', supports: '合成范围' },
      { id: 'unused-valid', origin: 'retrieved', title: '未使用的有效书目', organization: null,
        url: 'https://example.org/unused', supports: '合成解释范围' });
    const before = structuredClone(original);
    expect(pruneUnreferencedInvalidKnowledge(original, catalog)).toEqual({ ...original,
      knowledgeSources: [original.knowledgeSources[0], original.knowledgeSources[3]] });
    expect(original).toEqual(before);
  });

  it.each(['claim', 'action', 'criteria', 'duplicate'] as const)('%s 依赖或歧义的坏书目仍保留原门禁', (owner) => {
    const original = candidate();
    const source = { id: 'invalid-source', origin: 'catalog' as const, title: '有依赖的未知条目',
      organization: null, url: null, supports: '合成范围' };
    original.knowledgeSources.push(source);
    if (owner === 'claim') original.claims[0]!.knowledgeSourceIds.push(source.id);
    if (owner === 'action') original.actions[0]!.knowledgeSourceIds.push(source.id);
    if (owner === 'criteria') original.claims[0]!.criteriaBasis = { sourceId: source.id,
      criteriaSetId: 'synthetic-criteria', applicability: '合成条件', requirements: [] };
    if (owner === 'duplicate') original.knowledgeSources.push({ ...source });
    expect(pruneUnreferencedInvalidKnowledge(original, catalog)).toEqual(original);
  });

  it('只路由真实目录引用的主张和行动，普通知识与 retrieved 不增加核对', () => {
    const original = candidate();
    original.actions[0]!.knowledgeSourceIds = ['activity-context'];
    expect(routeKnowledgeAttributionReview(original, catalog)).toEqual({
      targetIds: ['claim-tsh', 'action-followup'],
      reasons: ['catalog_knowledge_attribution:claim-tsh', 'catalog_knowledge_attribution:action-followup']
    });
    original.claims[0]!.knowledgeBasis = 'model_general';
    original.claims[0]!.knowledgeSourceIds = [];
    original.actions[0]!.knowledgeSourceIds = ['retrieved-source'];
    expect(routeKnowledgeAttributionReview(original, catalog)).toEqual({ targetIds: [], reasons: [] });
    original.claims[0]!.knowledgeSourceIds = ['unknown-id'];
    expect(routeKnowledgeAttributionReview(original, catalog).targetIds).toEqual([]);
  });

  it('目录 ID 的直接引用必须核对，模型不能用 retrieved 冒充其真实目录归属', () => {
    const original = candidate();
    original.knowledgeSources = [];
    expect(routeKnowledgeAttributionReview(original, catalog).targetIds).toEqual(['claim-tsh']);
    original.knowledgeSources = [{ id: 'lab-context', title: '原检索来源', organization: null,
      url: 'https://example.org/retrieved', origin: 'retrieved', supports: '模型引用' }];
    expect(routeKnowledgeAttributionReview(original, catalog).targetIds).toEqual(['claim-tsh']);
    const normalized = canonicalizeAssessmentKnowledge(original, { knowledge: catalog } as MemberEvidencePackageV3);
    expect(normalized.knowledgeSources[0]).toMatchObject({ origin: 'catalog', title: catalog[0]!.title,
      url: catalog[0]!.sourceUrl, supports: catalog[0]!.supportedScope });
  });

  it('pass 保留有效归属和原健康内容', () => {
    const original = candidate();
    const result = applyKnowledgeAttributionReview(original, review(original, [{ targetId: 'claim-tsh',
      verdict: 'pass', reason: '条目支持整条解释。', replacement: null }]), ['claim-tsh'], catalog);
    expect(result).toEqual(original);
  });

  it('hold 只撤下目录引用，保留所有健康正文、个人证据、未知条件和行动', () => {
    const original = candidate();
    original.actions[0]!.knowledgeSourceIds = ['lab-context'];
    original.knowledgeSources.push({ id: 'retrieved-source', title: '原检索来源', organization: null,
      url: 'https://example.org/retrieved', origin: 'retrieved', supports: '模型引用' });
    const result = applyKnowledgeAttributionReview(original, review(original,
      ['claim-tsh', 'action-followup'].map((targetId) => ({ targetId, verdict: 'hold',
        reason: '条目不能支持全部医学解释。', replacement: null }))), ['claim-tsh', 'action-followup'], catalog);
    expect(result).toEqual({ ...original,
      claims: [{ ...original.claims[0]!, knowledgeBasis: 'model_general', knowledgeSourceIds: [] }],
      actions: [{ ...original.actions[0]!, knowledgeSourceIds: [] }],
      knowledgeSources: [original.knowledgeSources[1]!] });
    expect(original.claims[0]!.knowledgeSourceIds).toEqual(['lab-context']);
  });

  it('replace 仅可改变归属，真实的新目录来源由应用补齐并移除不再使用的旧来源', () => {
    const original = candidate();
    const replacement = { ...original.claims[0]!, knowledgeSourceIds: ['activity-context'] };
    const result = applyKnowledgeAttributionReview(original, review(original, [{ targetId: 'claim-tsh',
      verdict: 'replace', reason: '合成来源 ID 纠正。', replacement: { nodeType: 'claim', value: replacement } }]),
    ['claim-tsh'], catalog);
    expect(result.claims).toEqual([replacement]);
    expect(result.knowledgeSources).toEqual([{ id: 'activity-context', title: catalog[1]!.title,
      organization: catalog[1]!.sourceOrganization, url: catalog[1]!.sourceUrl, origin: 'catalog',
      supports: catalog[1]!.supportedScope }]);
  });

  it.each([
    { text: '这次 TSH 2.0 mIU/L，已正常。' },
    { materialUncertainty: null },
    { temporalStatus: 'historical' as const },
    { evidenceIds: ['another-result'] },
    { rationale: '可以立即自行治疗。' },
    { criteriaBasis: { criteriaSetId: 'new-criteria', sourceId: 'lab-context', applicability: '新标准', requirements: [] } }
  ])('来源核对越权改变主张字段 %j 时保留原文并撤下不能证明的引用', (changedFields) => {
    const original = candidate();
    const result = applyKnowledgeAttributionReview(original, review(original, [{ targetId: 'claim-tsh',
      verdict: 'replace', reason: '试图改写医学内容。', replacement: { nodeType: 'claim',
        value: { ...original.claims[0]!, ...changedFields } } }]), ['claim-tsh'], catalog);
    expect(result.claims).toEqual([{ ...original.claims[0]!, knowledgeBasis: 'model_general', knowledgeSourceIds: [] }]);
    expect(result.actions).toEqual(original.actions);
    expect(result.knowledgeSources).toEqual([]);
  });

  it('来源核对越权改变执行建议或日期时，不采纳行动改写', () => {
    const original = candidate();
    original.actions[0]!.knowledgeSourceIds = ['lab-context'];
    const result = applyKnowledgeAttributionReview(original, review(original, [{ targetId: 'action-followup',
      verdict: 'replace', reason: '试图改变执行建议。', replacement: { nodeType: 'action',
        value: { ...original.actions[0]!, firstStep: '今天立即自行停药。', timing: '现在', urgency: 'emergency' } } }]),
    ['action-followup'], catalog);
    expect(result.actions).toEqual([{ ...original.actions[0]!, knowledgeSourceIds: [] }]);
    expect(result.claims).toEqual(original.claims);
  });

  it('不能通过 replace 新挂未知来源或已有的其他 retrieved 来源', () => {
    const original = candidate();
    original.knowledgeSources.push({ id: 'retrieved-source', title: '原检索来源', organization: null,
      url: 'https://example.org/retrieved', origin: 'retrieved', supports: '模型引用' });
    for (const id of ['invented-catalog-id', 'retrieved-source']) {
      expect(() => applyKnowledgeAttributionReview(original, review(original, [{ targetId: 'claim-tsh',
        verdict: 'replace', reason: '不能证明来源。', replacement: { nodeType: 'claim',
          value: { ...original.claims[0]!, knowledgeSourceIds: [id] } } }]), ['claim-tsh'], catalog))
        .toThrow('FOCUSED_REVIEW_KNOWLEDGE_SOURCE_OUTSIDE_SCOPE');
    }
  });

  it('保留仍用于 criteria 的目录来源及所有 retrieved 来源', () => {
    const original = candidate();
    original.claims[0]!.knowledgeSourceIds = [];
    original.claims[0]!.criteriaBasis = { criteriaSetId: 'synthetic-criteria', sourceId: 'lab-context',
      applicability: '合成标准', requirements: [] };
    original.knowledgeSources.push({ id: 'retrieved-source', title: '未核验的原检索来源', organization: null,
      url: 'https://example.org/retrieved', origin: 'retrieved', supports: '模型引用' });
    expect(pruneUnusedCatalogKnowledge(original).knowledgeSources).toEqual(original.knowledgeSources);
    expect(routeKnowledgeAttributionReview(original, catalog).targetIds).toEqual(['claim-tsh']);
  });

  it('严格拒绝身份不匹配、重复或遗漏目标以及 pass 夹带 replacement', () => {
    const original = candidate();
    const passed: ClinicalFocusedReviewV1['results'][number] = { targetId: 'claim-tsh', verdict: 'pass',
      reason: '合成核对。', replacement: null };
    expect(() => applyKnowledgeAttributionReview(original, { ...review(original, [passed]), personId: 'other' },
      ['claim-tsh'], catalog)).toThrow('FOCUSED_REVIEW_SCOPE_MISMATCH');
    for (const results of [[], [passed, passed], [{ ...passed, targetId: 'action-followup' }]]) {
      expect(() => applyKnowledgeAttributionReview(original, review(original, results), ['claim-tsh'], catalog))
        .toThrow('FOCUSED_REVIEW_COVERAGE_MISMATCH');
    }
    expect(() => applyKnowledgeAttributionReview(original, review(original, [{ ...passed,
      replacement: { nodeType: 'claim', value: original.claims[0]! } }]), ['claim-tsh'], catalog))
      .toThrow('FOCUSED_REVIEW_UNEXPECTED_REPLACEMENT');
  });
});
