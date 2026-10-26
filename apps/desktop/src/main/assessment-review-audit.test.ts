import { describe, expect, it } from 'vitest';
import { assessmentReviewAuditAvailability, assessmentReviewAuditSchema, assessmentReviewAuditScopeValid,
  memberAssessmentCandidateV3Schema, memberAssessmentSnapshotV3Schema,
  type MemberAssessmentCandidateV3, type MemberAssessmentSnapshotV3, type MemberEvidenceRef } from '@contracts';
import { stableHash } from '@core';
import { AssessmentReviewAuditCollector } from './assessment-review-audit.js';

function fixture() {
  const candidate: MemberAssessmentCandidateV3 = {
    schemaVersion: 3, personId: 'synthetic-person', inputSignature: 'a'.repeat(64), mode: 'full', requestedSystemIds: [],
    overview: { id: 'overview', headline: '合成概览', summary: '有条件的合成结果。', claimIds: ['c'], actionIds: [], limitations: [] },
    systems: [], actions: [], questions: [], knowledgeSources: [], claims: [{
      id: 'c', topicKey: 'synthetic', systemIds: [], kind: 'interpretation', text: '合成原判断，仍不能确定原因。',
      diseaseName: null, diagnosticStatus: null, temporalStatus: 'historical', evidenceIds: ['e'], counterEvidenceIds: [],
      trendIds: [], knowledgeBasis: 'model_general', knowledgeSourceIds: [], criteriaBasis: null,
      rationale: '合成依据。', materialUncertainty: '条件不完整。', consequenceLevel: 'important'
    }]
  };
  const evidenceCatalog = [{ id: 'e', observationId: 'o' }] as MemberEvidenceRef[];
  const collector = new AssessmentReviewAuditCollector(candidate.personId, candidate.inputSignature, candidate,
    { stage: 'p02', threadId: 'p02-thread', turnId: 'p02-turn', output: candidate });
  const replacement = { nodeType: 'claim' as const, value: { ...candidate.claims[0]!, text: '合成替换，引入新的判断。' } };
  const review = { results: [{ targetId: 'c', verdict: 'replace' as const, reason: '合成模型理由。', replacement }] };
  collector.record(candidate, 'p04', { stage: 'p04', threadId: 'p04-thread', turnId: 'p04-turn', output: review }, review.results);
  collector.localReasons(['c'], ['p04_scope_boundary_changed', 'disease_changed']);
  const reviewAuditRecords = collector.finalize({ heldTargetIds: ['c'], rebuiltNodeIds: ['overview'], evidenceCatalog });
  const scope = { personId: candidate.personId, inputSignature: candidate.inputSignature, reviewAuditRecords,
    heldTargetIds: ['c'], presentation: { version: 'synthetic', rebuiltNodeIds: ['overview'] }, evidenceCatalog };
  return { candidate, collector, review, replacement, scope, evidenceCatalog, reviewAuditRecords };
}

describe('私有综合核查记录', () => {
  it('超过100条局部原因保留明确溢出计数和完整集合hash，不阻断其余可靠结果', () => {
    const f = fixture();
    const collector = new AssessmentReviewAuditCollector(f.candidate.personId, f.candidate.inputSignature, f.candidate,
      { stage: 'p02', threadId: 'synthetic', turnId: '1', output: f.candidate });
    const reasons = Array.from({ length: 101 }, (_, index) => `unknown_evidence:c:synthetic-${index}`);
    collector.localReasons(['c'], reasons);
    const audit = collector.finalize({ heldTargetIds: ['c'], rebuiltNodeIds: [], evidenceCatalog: f.evidenceCatalog });
    const record = audit.records[0]!;
    expect(record.localReasonCodes).toEqual(reasons.slice(0, 100));
    expect(record.localReasonOverflow).toEqual({ totalCount: 101, omittedCount: 1, fullHash: stableHash(reasons) });
    expect(assessmentReviewAuditSchema.safeParse(audit).success).toBe(true);
    const scope = { ...f.scope, presentation: undefined, reviewAuditRecords: audit };
    expect(assessmentReviewAuditScopeValid(scope)).toBe(true);
    const { recordHash, ...body } = record;
    expect(recordHash).toBe(stableHash(body));
    record.localReasonOverflow!.omittedCount = 2;
    expect(assessmentReviewAuditScopeValid(scope)).toBe(false);
  });

  it('保存完整原节点、真实替换和模型理由，绑定实际 P04 回执而非只留 ID', () => {
    const f = fixture();
    const record = f.reviewAuditRecords.records.find((item) => item.targetId === 'c')!;
    expect(record.original).toEqual({ nodeType: 'claim', value: f.candidate.claims[0] });
    expect(record.replacement).toEqual(f.replacement);
    expect(record).toMatchObject({ phase: 'p04', modelDecision: { verdict: 'replace', reason: '合成模型理由。' },
      receipt: { stage: 'p04', threadId: 'p04-thread', turnId: 'p04-turn', outputHash: stableHash(f.review) },
      origin: 'local_boundary_guard', outcome: 'held', boundEvidenceIds: ['e'], unboundEvidenceIds: [] });
    const { recordHash, ...body } = record;
    expect(recordHash).toBe(stableHash(body));
    expect(assessmentReviewAuditSchema.safeParse(f.reviewAuditRecords).success).toBe(true);
    expect(assessmentReviewAuditScopeValid(f.scope)).toBe(true);
    expect(f.reviewAuditRecords.records.find((item) => item.targetId === 'overview')).toMatchObject({
      phase: 'local_validation', modelDecision: null, outcome: 'rebuilt' });
  });

  it('记录只是克隆的私有数据，不能改变原结果或成为模型候选字段', () => {
    const f = fixture();
    f.replacement.value.text = '后来修改不应篡改审计';
    expect(f.reviewAuditRecords.records[0]!.replacement!.value).toHaveProperty('text', '合成替换，引入新的判断。');
    expect(f.candidate.claims[0]!.text).toBe('合成原判断，仍不能确定原因。');
    expect(memberAssessmentCandidateV3Schema.safeParse({ ...f.candidate, reviewAuditRecords: f.reviewAuditRecords }).success).toBe(false);
  });

  it('实际模型 hold 与本地门禁撤下 replacement 明确分开，不为依赖伪造模型判定', () => {
    const f = fixture();
    const collector = new AssessmentReviewAuditCollector(f.candidate.personId, f.candidate.inputSignature, f.candidate,
      { stage: 'p02', threadId: 'p02', turnId: '1', output: f.candidate });
    collector.record(f.candidate, 'p04', { stage: 'p04', threadId: 'p04', turnId: '2', output: { hold: true } },
      [{ targetId: 'c', verdict: 'hold', reason: '合成依据不足。', replacement: null }]);
    collector.localReasons(['overview'], ['original_claim_dependency_held']);
    const audit = collector.finalize({ heldTargetIds: ['c'], rebuiltNodeIds: ['overview'], evidenceCatalog: f.evidenceCatalog });
    expect(audit.records.find((item) => item.targetId === 'c')).toMatchObject({ origin: 'model', modelDecision: { verdict: 'hold' } });
    expect(audit.records.find((item) => item.targetId === 'overview')).toMatchObject({
      phase: 'local_dependency_guard', origin: 'local_dependency_guard', modelDecision: null, receipt: { stage: 'p02' } });
  });

  it('P03 替换已供 P04 使用后由模型 hold，不把最终原因倒贴成 P03 本地拦截', () => {
    const f = fixture();
    const collector = new AssessmentReviewAuditCollector(f.candidate.personId, f.candidate.inputSignature, f.candidate,
      { stage: 'p02', threadId: 'p02', turnId: '1', output: f.candidate });
    const repair = [{ targetId: 'c', verdict: 'replace' as const, reason: '只澄清原有条件。', replacement: f.replacement }];
    collector.record(f.candidate, 'p03_before_review', { stage: 'p03', threadId: 'p03', turnId: '2', output: repair }, repair);
    const repairedCandidate = { ...f.candidate, claims: [f.replacement.value] };
    const review = [{ targetId: 'c', verdict: 'hold' as const, reason: '原条件仍缺足够的项目上下文。', replacement: null }];
    collector.record(repairedCandidate, 'p04', { stage: 'p04', threadId: 'p04', turnId: '3', output: review }, review);
    collector.localReasons(['c'], ['reviewer_hold']);
    const audit = collector.finalize({ heldTargetIds: ['c'], rebuiltNodeIds: [], evidenceCatalog: f.evidenceCatalog });
    expect(audit.records).toHaveLength(2);
    expect(audit.records[0]).toMatchObject({ phase: 'p03_before_review', origin: 'local_validation', outcome: 'held',
      modelDecision: { verdict: 'replace', reason: repair[0]!.reason }, replacement: f.replacement,
      localReasonCodes: ['target_finally_held_by_later_model_review'],
      receipt: { stage: 'p03', threadId: 'p03', turnId: '2', outputHash: stableHash(repair) } });
    expect(audit.records[1]).toMatchObject({ phase: 'p04', origin: 'model', outcome: 'held',
      original: f.replacement, modelDecision: { verdict: 'hold', reason: review[0]!.reason },
      localReasonCodes: ['reviewer_hold'], receipt: { stage: 'p04', outputHash: stableHash(review) } });
    for (const { recordHash, ...body } of audit.records) expect(recordHash).toBe(stableHash(body));
    expect(assessmentReviewAuditScopeValid({ ...f.scope, presentation: undefined, reviewAuditRecords: audit })).toBe(true);
  });

  it('早期替换确被本地拒绝时保留其实际原因，不被后续模型 hold 洗掉', () => {
    const f = fixture();
    const collector = new AssessmentReviewAuditCollector(f.candidate.personId, f.candidate.inputSignature, f.candidate,
      { stage: 'p02', threadId: 'p02', turnId: '1', output: f.candidate });
    collector.record(f.candidate, 'p03_before_review', { stage: 'p03', threadId: 'p03', turnId: '2', output: f.replacement },
      [{ targetId: 'c', verdict: 'replace', reason: '合成的越界修复。', replacement: f.replacement }]);
    collector.localReasons(['c'], ['disease_changed']);
    collector.record(f.candidate, 'p04', { stage: 'p04', threadId: 'p04', turnId: '3', output: { hold: true } },
      [{ targetId: 'c', verdict: 'hold', reason: '合成模型最终隔离。', replacement: null }]);
    collector.localReasons(['c'], ['reviewer_hold']);
    const audit = collector.finalize({ heldTargetIds: ['c'], rebuiltNodeIds: [], evidenceCatalog: f.evidenceCatalog });
    expect(audit.records[0]).toMatchObject({ phase: 'p03_before_review', origin: 'local_boundary_guard',
      localReasonCodes: ['disease_changed', 'target_finally_held_by_later_model_review'] });
    expect(audit.records[1]).toMatchObject({ phase: 'p04', origin: 'model', localReasonCodes: ['reviewer_hold'] });
    expect(assessmentReviewAuditScopeValid({ ...f.scope, presentation: undefined, reviewAuditRecords: audit })).toBe(true);
  });

  it('P04 replace 后的依赖隔离仍归属于本地依赖门禁，不冒充模型 hold', () => {
    const f = fixture();
    const collector = new AssessmentReviewAuditCollector(f.candidate.personId, f.candidate.inputSignature, f.candidate,
      { stage: 'p02', threadId: 'p02', turnId: '1', output: f.candidate });
    collector.record(f.candidate, 'p04', { stage: 'p04', threadId: 'p04', turnId: '2', output: f.review }, f.review.results);
    collector.localReasons(['c'], ['original_claim_dependency_held', 'held_claim_dependency_retained']);
    const audit = collector.finalize({ heldTargetIds: ['c'], rebuiltNodeIds: [], evidenceCatalog: f.evidenceCatalog });
    expect(audit.records[0]).toMatchObject({ phase: 'p04', origin: 'local_dependency_guard', outcome: 'held',
      modelDecision: { verdict: 'replace' }, replacement: f.replacement,
      localReasonCodes: ['original_claim_dependency_held', 'held_claim_dependency_retained'] });
    expect(assessmentReviewAuditScopeValid({ ...f.scope, presentation: undefined, reviewAuditRecords: audit })).toBe(true);
  });

  it.each(['held', 'rebuilt'] as const)('后阶段本地%s不反向给早期已接纳替换补造校验失败', (outcome) => {
    const f = fixture();
    const collector = new AssessmentReviewAuditCollector(f.candidate.personId, f.candidate.inputSignature, f.candidate,
      { stage: 'p02', threadId: 'p02', turnId: '1', output: f.candidate });
    collector.record(f.candidate, 'p03_before_review', { stage: 'p03', threadId: 'p03', turnId: '2', output: f.replacement },
      [{ targetId: 'c', verdict: 'replace', reason: '合成的前置修复。', replacement: f.replacement }]);
    const repairedCandidate = { ...f.candidate, claims: [f.replacement.value] };
    collector.record(repairedCandidate, 'p04', { stage: 'p04', threadId: 'p04', turnId: '3', output: f.review }, f.review.results);
    collector.localReasons(['c'], outcome === 'held'
      ? ['p04_scope_boundary_changed', 'disease_changed'] : ['local_dependency_graph_rebuilt']);
    const audit = collector.finalize({ heldTargetIds: outcome === 'held' ? ['c'] : [],
      rebuiltNodeIds: outcome === 'rebuilt' ? ['c'] : [], evidenceCatalog: f.evidenceCatalog });
    expect(audit.records[0]).toMatchObject({ phase: 'p03_before_review', origin: 'local_validation', outcome,
      localReasonCodes: [outcome === 'held' ? 'target_finally_held_in_later_stage' : 'target_finally_rebuilt_in_later_stage'] });
    expect(audit.records[1]).toMatchObject({ phase: 'p04', outcome,
      origin: outcome === 'held' ? 'local_boundary_guard' : 'local_dependency_guard',
      localReasonCodes: outcome === 'held' ? ['p04_scope_boundary_changed', 'disease_changed'] : ['local_dependency_graph_rebuilt'] });
    expect(assessmentReviewAuditScopeValid({ ...f.scope, heldTargetIds: outcome === 'held' ? ['c'] : [],
      presentation: outcome === 'rebuilt' ? { version: 'synthetic', rebuiltNodeIds: ['c'] } : undefined,
      reviewAuditRecords: audit })).toBe(true);
  });

  it('真实的 P04 本地边界拦截仍保留本阶段原因和完整回执', () => {
    const f = fixture();
    const record = f.reviewAuditRecords.records.find((item) => item.targetId === 'c')!;
    expect(record).toMatchObject({ origin: 'local_boundary_guard', outcome: 'held',
      modelDecision: { verdict: 'replace' }, localReasonCodes: ['p04_scope_boundary_changed', 'disease_changed'],
      receipt: { stage: 'p04', outputHash: stableHash(f.review) } });
  });

  it('前置 P03 未能修复的目标保留真实阶段，不假装具有 P04 回执', () => {
    const f = fixture();
    const collector = new AssessmentReviewAuditCollector(f.candidate.personId, f.candidate.inputSignature, f.candidate,
      { stage: 'p02', threadId: 'p02', turnId: '1', output: f.candidate });
    collector.record(f.candidate, 'p03_before_review', { stage: 'p03', threadId: 'p03', turnId: '2', output: { unchanged: true } },
      [{ targetId: 'c', verdict: 'unchanged', reason: '合成来源仍不能支持。', replacement: null }]);
    collector.localReasons(['c'], ['documented_source_not_proven:c']);
    const audit = collector.finalize({ heldTargetIds: ['c'], rebuiltNodeIds: [], evidenceCatalog: f.evidenceCatalog });
    expect(audit.records).toHaveLength(1);
    expect(audit.records[0]).toMatchObject({ phase: 'p03_before_review', receipt: { stage: 'p03' },
      modelDecision: { verdict: 'unchanged', reason: '合成来源仍不能支持。' } });
  });

  it('只留下最终未发布和程序重建目标，不额外留存正常通过的健康正文', () => {
    const f = fixture();
    expect(f.collector.finalize({ heldTargetIds: [], rebuiltNodeIds: [], evidenceCatalog: f.evidenceCatalog }).records).toEqual([]);
  });

  it('前置修复无有效结果后才核对其他目标，不给旧隔离节点伪造 P04 记录', () => {
    const f = fixture();
    const collector = new AssessmentReviewAuditCollector(f.candidate.personId, f.candidate.inputSignature, f.candidate,
      { stage: 'p02', threadId: 'p02', turnId: '1', output: f.candidate });
    collector.record(f.candidate, 'p03_before_review', { stage: 'p03', threadId: 'p03', turnId: '2', output: { invalid: true } }, [], ['c']);
    collector.record(f.candidate, 'p04', { stage: 'p04', threadId: 'p04', turnId: '3', output: { pass: true } },
      [{ targetId: 'overview', verdict: 'pass', reason: '只核对这个摘要。', replacement: null }]);
    collector.localReasons(['c'], ['assessment_repair_invalid']);
    const audit = collector.finalize({ heldTargetIds: ['c'], rebuiltNodeIds: [], evidenceCatalog: f.evidenceCatalog });
    expect(audit.records).toHaveLength(1);
    expect(audit.records[0]).toMatchObject({ phase: 'local_validation', modelDecision: null,
      receipt: { stage: 'p03', threadId: 'p03', turnId: '2' } });
  });

  it.each(['person', 'signature', 'live_target', 'replacement_target', 'bound_source', 'missing_target', 'fake_p04', 'duplicate', 'fake_model_origin'])(
    '拒绝审计错绑：%s', (mode) => {
      const f = fixture(); const invalid = structuredClone(f.scope);
      const first = invalid.reviewAuditRecords.records[0]!;
      if (mode === 'person') invalid.reviewAuditRecords.personId = 'another-person';
      if (mode === 'signature') invalid.reviewAuditRecords.inputSignature = 'b'.repeat(64);
      if (mode === 'live_target') first.outcome = 'rebuilt';
      if (mode === 'replacement_target') first.replacement!.value.id = 'unrelated';
      if (mode === 'bound_source') first.boundEvidenceIds = ['foreign-source'];
      if (mode === 'missing_target') invalid.reviewAuditRecords.records = [];
      if (mode === 'fake_p04') first.receipt.stage = 'p03';
      if (mode === 'duplicate') invalid.reviewAuditRecords.records.push(structuredClone(first));
      if (mode === 'fake_model_origin') first.origin = 'model';
      expect(assessmentReviewAuditScopeValid(invalid)).toBe(false);
    });

  it('无效引用可作为未绑定的失败尝试保留，绝不变成本成员证据', () => {
    const f = fixture();
    const replacement = { ...f.replacement, value: { ...f.replacement.value, evidenceIds: ['unknown-source'] } };
    const collector = new AssessmentReviewAuditCollector(f.candidate.personId, f.candidate.inputSignature, f.candidate,
      { stage: 'p02', threadId: 'p02', turnId: '1', output: f.candidate });
    collector.record(f.candidate, 'p04', { stage: 'p04', threadId: 'p04', turnId: '2', output: replacement },
      [{ targetId: 'c', verdict: 'replace', reason: '合成错误引用。', replacement }]);
    const audit = collector.finalize({ heldTargetIds: ['c'], rebuiltNodeIds: [], evidenceCatalog: f.evidenceCatalog });
    expect(audit.records[0]).toMatchObject({ boundEvidenceIds: ['e'], unboundEvidenceIds: ['unknown-source'] });
    expect(assessmentReviewAuditScopeValid({ ...f.scope, presentation: undefined, reviewAuditRecords: audit })).toBe(true);
    audit.records[0]!.boundEvidenceIds.push('unknown-source');
    expect(assessmentReviewAuditScopeValid({ ...f.scope, presentation: undefined, reviewAuditRecords: audit })).toBe(false);
  });

  it('旧快照兼容但明确不可追溯，不根据旧的 held ID 编造正文或理由', () => {
    const f = fixture();
    const snapshot: MemberAssessmentSnapshotV3 = { ...f.candidate, id: 'snapshot', status: 'current',
      generatedAt: '2026-10-16T00:00:00Z', factRevision: 1, contextRevision: 0, reviewScopeSignature: 'b'.repeat(64),
      promptVersion: 'synthetic', rulesVersion: 'synthetic', modelId: 'synthetic', reasoningEffort: 'medium',
      validationMode: 'local_only', reviewedTargetIds: [], heldTargetIds: ['unavailable-old-id'], limitations: [], evidenceCatalog: [],
      processingPlan: { strategy: 'full', trigger: 'none', partitionCount: 0 }, knowledgeVerifications: [] };
    expect(memberAssessmentSnapshotV3Schema.safeParse(snapshot).success).toBe(true);
    expect(assessmentReviewAuditAvailability(snapshot)).toBe('unavailable_legacy');
    expect(snapshot).not.toHaveProperty('reviewAuditRecords');
  });
});
