import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AccountState, DerivedSafetyReview, DerivedSnapshotCandidate, ExtractionResult } from '@contracts';
import { DerivedHealthPipeline } from './derived-pipeline.js';
import { DocumentExtractionPipeline } from './processing-pipeline.js';
import { PersonalWorkspaceService } from './workspace-service.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function setup() {
  const root = mkdtempSync(join(tmpdir(), 'family-health-derived-'));
  roots.push(root);
  const service = new PersonalWorkspaceService(root, '测试工作区', () => new Date('2026-09-18T00:00:00Z'));
  const personId = service.ensurePrimaryMember({ displayName: '测试成员', relation: '本人' });
  await service.importFiles([{ path: '/tmp/虚构报告.txt', bytes: Buffer.from('2026-09-17 LDL-C 4.2 mmol/L，参考范围 0-3.4 mmol/L') }], personId);
  const documentId = service.getSnapshot(null).inbox[0]!.id;
  const spanId = service.store.getDocumentExtractionBundle(documentId).manifest.spans[0]!.id;
  const extraction: ExtractionResult = {
    schemaVersion: 1,
    documentId,
    subject: { reportedName: null, evidence: [], confidence: 'absent' },
    coveredSourceSpanIds: [spanId],
    candidates: [{
      localKey: 'ldl-1', originalName: 'LDL-C', standardNameCandidate: 'LDL-C',
      value: { kind: 'numeric', rawText: '4.2', decimal: '4.2', comparator: 'eq' },
      unitRaw: 'mmol/L', referenceRangeRaw: '0-3.4 mmol/L', reportedAbnormalFlag: '偏高',
      specimen: null, method: null, bodySite: null, clinicalDate: '2026-09-17',
      evidence: [{ sourceSpanId: spanId, quote: '2026-09-17 LDL-C 4.2 mmol/L' }], issues: []
    }]
  };
  await new DocumentExtractionPipeline(service.store, {
    runStructuredTurn: async () => ({ threadId: 'extract-thread', turnId: 'extract-turn', output: extraction })
  }).process(documentId);
  const observationId = service.store.listAcceptedObservations(personId)[0]!.id;
  return { service, personId, documentId, observationId };
}

describe('DerivedHealthPipeline', () => {
  it('只有证据完整且安全复核通过时发布派生快照', async () => {
    const { service, personId, observationId } = await setup();
    service.store.createManualNote({
      personId, kind: 'history', immutableText: '本人补充：近期作息不规律', effectiveDate: '2026-09-16',
      structuredFields: {}, expectedContextRevision: 0
    });
    const candidate: DerivedSnapshotCandidate = {
      schemaVersion: 1,
      personId,
      factRevision: 1,
      dataQuality: 'partial',
      claims: [{
        id: 'claim-1', organId: 'cardiovascular', level: 'action',
        title: '带着血脂报告咨询医生',
        explanation: 'LDL-C 4.2 mmol/L，原报告标记偏高；建议就此咨询医生。',
        evidenceObservationIds: [observationId],
        boundaryNote: '这不是诊断，需结合医生判断。'
      }],
      lifestyleGuidance: [{
        id: 'guide-1', title: '保持规律活动',
        detail: '可以从身体感觉舒适的步行开始，如有不适应先咨询医生。',
        evidenceObservationIds: [observationId], consultProfessional: true
      }]
    };
    const review: DerivedSafetyReview = {
      schemaVersion: 1, personId, factRevision: 1, overallSafe: true,
      claimReviews: [{ claimId: 'claim-1', supported: true, safe: true, issue: null }],
      guidanceReviews: [{ guidanceId: 'guide-1', supported: true, safe: true, issue: null }]
    };
    let turn = 0;
    const prompts: string[] = [];
    const webSearchFlags: Array<boolean | undefined> = [];
    const result = await new DerivedHealthPipeline(service.store, {
      runStructuredTurn: async (input) => {
        prompts.push(input.prompt);
        webSearchFlags.push(input.allowWebSearch);
        return { threadId: 'derived-thread', turnId: `derived-turn-${++turn}`, output: turn === 1 ? candidate : review };
      }
    }).process(personId);
    expect(result).toMatchObject({ status: 'published' });
    expect(service.store.listCurrentDerivedSnapshots()).toHaveLength(1);
    expect(service.getSnapshot(null)).toMatchObject({
      persons: [expect.objectContaining({ derivedStatus: 'current', assessmentSummary: candidate.claims[0]!.explanation })],
      guidance: [expect.objectContaining({ id: 'guide-1', personId })]
    });
    expect(prompts[0]).toContain('本人补充：近期作息不规律');
    expect(prompts[0]).toContain('userReportedNotes');
    expect(prompts[0]).toContain('搜索词必须去标识化');
    expect(webSearchFlags).toEqual([true, true]);
    service.store.createManualNote({
      personId, kind: 'free_text', immutableText: '新增背景需刷新派生说明', effectiveDate: null,
      structuredFields: {}, expectedContextRevision: 1
    });
    const account: AccountState = {
      status: 'connected', displayLabel: 'fixture@example.test',
      quota: { status: 'available', primaryUsedPercent: 10, secondaryUsedPercent: null, resetsAt: null },
      runtimeVersion: 'fixture-runtime', lastCheckedAt: '2026-09-18T00:00:00Z'
    };
    service.processNow({ accountState: account, consentVersion: 1 });
    expect(service.store.listStoredJobs()[0]).toMatchObject({ stage: 'analyze', status: 'queued' });
    service.close();
  });

  it('诊断或剂量越界内容在本地规则处停止且不污染已接纳事实', async () => {
    const { service, personId, documentId, observationId } = await setup();
    const unsafe: DerivedSnapshotCandidate = {
      schemaVersion: 1, personId, factRevision: 1, dataQuality: 'partial',
      claims: [{
        id: 'claim-unsafe', organId: 'cardiovascular', level: 'action',
        title: '开始服用药物', explanation: '你有高脂血症，开始服用某药 20 mg。',
        evidenceObservationIds: [observationId], boundaryNote: '请咨询医生。'
      }],
      lifestyleGuidance: []
    };
    const result = await new DerivedHealthPipeline(service.store, {
      runStructuredTurn: async () => ({ threadId: 'unsafe-thread', turnId: 'unsafe-turn', output: unsafe })
    }).process(personId);
    expect(result).toMatchObject({ status: 'needs_review', reason: expect.stringContaining('medical_boundary') });
    expect(service.store.listCurrentDerivedSnapshots()).toEqual([]);
    expect(service.getSnapshot(null).inbox.find((item) => item.id === documentId)).toMatchObject({ status: 'completed' });
    expect(service.store.getFactRevision(personId)).toBe(1);
    expect(service.store.listOpenExtractionReviewIssues()[0]?.reasonCodes).toEqual([
      'medical_boundary:claim-unsafe',
      'dosage_boundary:claim-unsafe'
    ]);
    service.close();
  });

  it('“不能仅凭报告确诊”这类安全边界说明不会被误判为诊断', async () => {
    const { service, personId, observationId } = await setup();
    const candidate: DerivedSnapshotCandidate = {
      schemaVersion: 1, personId, factRevision: 1, dataQuality: 'partial',
      claims: [{
        id: 'claim-boundary', organId: 'metabolic', level: 'association',
        title: '结合检查继续评估',
        explanation: '这项结果不能仅凭本次报告确诊，建议就此咨询医生。',
        evidenceObservationIds: [observationId], boundaryNote: '仅供参考，不等于诊断。'
      }],
      lifestyleGuidance: []
    };
    const review: DerivedSafetyReview = {
      schemaVersion: 1, personId, factRevision: 1, overallSafe: true,
      claimReviews: [{ claimId: 'claim-boundary', supported: true, safe: true, issue: null }],
      guidanceReviews: []
    };
    let turn = 0;
    const result = await new DerivedHealthPipeline(service.store, {
      runStructuredTurn: async () => ({
        threadId: 'boundary-thread', turnId: `boundary-turn-${++turn}`, output: turn === 1 ? candidate : review
      })
    }).process(personId);
    expect(result).toMatchObject({ status: 'published' });
    expect(service.store.listOpenExtractionReviewIssues()).toEqual([]);
    service.close();
  });
});
