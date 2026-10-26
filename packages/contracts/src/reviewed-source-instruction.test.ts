import { describe, expect, it } from 'vitest';
import type { HealthAction, MemberAssessmentSnapshotV3 } from './member-assessment-v3.js';
import type { MemberEvidenceRef } from './member-v2.js';
import { reviewedSourceInstructionEvidence } from './reviewed-source-instruction.js';

function fixture() {
  const firstStep = '医生安排：若合成不适持续，四周之后到合成门诊评估。没有新不适时无需自行提前检查。';
  const action: HealthAction = { id: 'synthetic-action', dedupeKey: 'synthetic-dedupe', systemIds: [], claimIds: [],
    kind: 'documented_plan', sourceInstructionObservationId: 'synthetic-observation', title: '报告中的医生建议',
    why: '合成报告原话。', firstStep, timing: null, timingBasis: 'none', reviewPlan: null, caution: null,
    urgency: 'routine', evidenceIds: ['synthetic-evidence'], knowledgeSourceIds: [] };
  const evidence: MemberEvidenceRef = { id: 'synthetic-evidence', kind: 'observation', observationId: 'synthetic-observation',
    eventId: 'synthetic-event', documentId: 'synthetic-document', sourceSpanId: 'synthetic-span', knowledgeId: null,
    label: '合成报告', locator: '第1页', quote: `合成栏目。${firstStep}合成报告末尾。` };
  const snapshot: MemberAssessmentSnapshotV3 = { schemaVersion: 3, id: 'synthetic-snapshot', status: 'current',
    personId: 'synthetic-person', inputSignature: 'a'.repeat(64), mode: 'full', requestedSystemIds: [],
    overview: { id: 'overview', headline: '合成总览', summary: '合成说明', claimIds: [], actionIds: [action.id], limitations: [] },
    claims: [], actions: [action], questions: [], systems: [], knowledgeSources: [], factRevision: 1, contextRevision: 0,
    reviewScopeSignature: 'b'.repeat(64), generatedAt: '2026-01-01T00:00:00Z', promptVersion: 'synthetic',
    rulesVersion: 'synthetic', modelId: 'synthetic', reasoningEffort: 'medium', validationMode: 'local_and_focused_review',
    reviewedTargetIds: [action.id], heldTargetIds: [], evidenceCatalog: [evidence], limitations: [],
    processingPlan: { strategy: 'full', trigger: 'none', partitionCount: 0 }, knowledgeVerifications: [] };
  return { action, evidence, snapshot };
}

describe('经重点复核的原句安排来源', () => {
  it('只依赖已发布原节点、有效复核和完整连续原句，不穷举医生措辞', () => {
    const f = fixture(); const before = JSON.stringify(f);
    expect(reviewedSourceInstructionEvidence(f.action, f.snapshot)).toEqual([f.evidence]);
    expect(JSON.stringify(f)).toBe(before);
    expect(reviewedSourceInstructionEvidence(structuredClone(f.action), f.snapshot)).toEqual([f.evidence]);
  });
  it.each(['no_snapshot', 'local_only', 'unreviewed', 'held', 'wrong_id', 'changed_body', 'changed_title', 'duplicate_id'] as const)(
    '%s不能仅凭source字段或documented标签认定医生安排', (mode) => {
      const f = fixture(); let snapshot: MemberAssessmentSnapshotV3 | null = f.snapshot;
      const action = structuredClone(f.action);
      if (mode === 'no_snapshot') snapshot = null;
      if (mode === 'local_only') f.snapshot.validationMode = 'local_only';
      if (mode === 'unreviewed') f.snapshot.reviewedTargetIds = [];
      if (mode === 'held') f.snapshot.heldTargetIds = [action.id];
      if (mode === 'wrong_id') action.id = 'unpublished-id';
      if (mode === 'changed_body') action.firstStep = action.firstStep.replace('无需', '需要');
      if (mode === 'changed_title') action.title = '发布后更换的标题';
      if (mode === 'duplicate_id') f.snapshot.actions.push(structuredClone(f.action));
      expect(reviewedSourceInstructionEvidence(action, snapshot)).toEqual([]);
    });
  it.each(['knowledge', 'other_observation', 'no_document', 'no_span', 'split_quote', 'no_source_id'] as const)(
    '%s不构成当前个人完整原句来源', (mode) => {
      const f = fixture();
      if (mode === 'knowledge') f.evidence.kind = 'knowledge';
      if (mode === 'other_observation') f.evidence.observationId = 'other-observation';
      if (mode === 'no_document') f.evidence.documentId = null;
      if (mode === 'no_span') f.evidence.sourceSpanId = null;
      if (mode === 'split_quote') f.evidence.quote = f.action.firstStep.replace('四周之后', '四周。之后');
      if (mode === 'no_source_id') delete f.action.sourceInstructionObservationId;
      expect(reviewedSourceInstructionEvidence(f.action, f.snapshot)).toEqual([]);
    });
});
