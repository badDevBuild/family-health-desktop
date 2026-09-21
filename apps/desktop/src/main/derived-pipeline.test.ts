import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import type { AccountState, DerivedSafetyReview, DerivedSnapshotCandidate, ExtractionResult, LifestyleGuidanceCandidate } from '@contracts';
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
  return { service, root, personId, documentId, observationId };
}

function guidanceFixture(input: Pick<LifestyleGuidanceCandidate, 'id' | 'title' | 'detail' | 'evidenceObservationIds'> & Partial<LifestyleGuidanceCandidate>): LifestyleGuidanceCandidate {
  return {
    dedupeKey: 'daily-activity',
    category: 'exercise',
    goal: '建立可持续的日常活动习惯',
    rationale: '用低负担方式开始，并根据身体感受调整。',
    steps: ['选择感觉舒适的日常步行'],
    startingOptions: ['先从一次短距离步行开始'],
    scheduleSuggestion: null,
    trackingSuggestion: '只记录是否完成和身体感受。',
    constraints: ['出现不适时停止并咨询专业人员'],
    uncertainties: [],
    generalKnowledgeEvidence: [{
      id: 'knowledge-test-1',
      sourceTitle: '合成测试用一般活动说明',
      sourceOrganization: '测试机构',
      sourceUrl: 'https://example.invalid/guidance',
      reviewedAt: '2026-09-18',
      supportedScope: '仅支持从可承受的低强度活动开始这一通用方向'
    }],
    sourceKind: 'ai_proposed',
    relatedSystemIds: ['cardiovascular'],
    consultProfessional: true,
    ...input
  };
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
      lifestyleGuidance: [guidanceFixture({
        id: 'guide-1', title: '保持规律活动',
        detail: '可以从身体感觉舒适的步行开始，如有不适应先咨询医生。',
        evidenceObservationIds: [observationId], consultProfessional: true
      }), guidanceFixture({
        id: 'guide-duplicate', title: '增加日常活动',
        detail: '从本人可以承受的活动开始。',
        steps: ['在方便的时间安排一次短距离活动'],
        relatedSystemIds: ['cardiovascular', 'endocrine_metabolic'],
        evidenceObservationIds: [observationId], consultProfessional: true
      })]
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
    const proposal = service.store.listLifestyleProposals(personId)[0]!;
    expect(proposal).toMatchObject({
      personId,
      title: '保持规律活动',
      status: 'proposed',
      evidenceObservationIds: [observationId],
      dedupeKey: 'daily-activity',
      steps: ['选择感觉舒适的日常步行', '在方便的时间安排一次短距离活动'],
      relatedSystemIds: ['cardiovascular', 'endocrine_metabolic']
    });
    const materialized = new Database(service.store.databasePath, { readonly: true });
    try {
      expect(materialized.prepare(`SELECT COUNT(*) AS count FROM knowledge_entries`).get()).toEqual({ count: 1 });
      const proposalRow = materialized.prepare(`SELECT structure_json FROM lifestyle_proposals_v2 WHERE id = ?`).get(proposal.id) as { structure_json: string };
      expect(JSON.parse(proposalRow.structure_json)).toMatchObject({
        goal: '建立可持续的日常活动习惯',
        relatedSystemIds: ['cardiovascular', 'endocrine_metabolic'],
        generalKnowledgeEvidence: [expect.objectContaining({ sourceOrganization: '测试机构' })]
      });
    } finally {
      materialized.close();
    }
    const adoptionInput = {
      personId,
      proposalId: proposal.id,
      userGoal: '建立能持续的日常活动习惯',
      selectedStartingOption: '餐后轻量步行',
      plannedTime: '工作日晚饭后',
      owner: '本人',
      progressNote: '先观察一周的身体感受',
      dueDate: '2026-10-01'
    };
    const dismissed = service.setLifestyleProposalDecision({ personId, proposalId: proposal.id, decision: 'dismiss' });
    expect(dismissed).toMatchObject({ proposalId: proposal.id, status: 'dismissed' });
    expect(() => service.adoptLifestyleProposal(adoptionInput)).toThrow('LIFESTYLE_PROPOSAL_NOT_AVAILABLE');
    const currentCandidate = service.store.listCurrentDerivedSnapshots()[0]!.payload;
    service.store.publishDerivedSnapshot({
      candidate: {
        ...currentCandidate,
        lifestyleGuidance: currentCandidate.lifestyleGuidance.map((item) => ({ ...item, title: '保持规律活动（更新）' }))
      },
      expectedFactRevision: service.store.getFactRevision(personId),
      expectedContextRevision: service.store.getClinicalContextRevision(personId),
      promptVersion: 'derived-v3',
      rulesVersion: 'derived-safety-v2',
      modelId: 'test-refresh-model'
    });
    const refreshedProposal = service.store.listLifestyleProposals(personId).find((item) => item.id !== proposal.id)!;
    expect(refreshedProposal).toMatchObject({ dedupeKey: proposal.dedupeKey, status: 'dismissed' });
    expect(service.store.listLifestyleProposals(personId)).toHaveLength(1);
    const refreshedAdoptionInput = { ...adoptionInput, proposalId: refreshedProposal.id };
    expect(service.setLifestyleProposalDecision({ personId, proposalId: refreshedProposal.id, decision: 'restore' })).toMatchObject({ status: 'proposed' });
    const adopted = service.adoptLifestyleProposal(refreshedAdoptionInput);
    expect(adopted).toMatchObject({
      proposalId: refreshedProposal.id,
      title: refreshedProposal.title,
      userGoal: adoptionInput.userGoal,
      selectedStartingOption: adoptionInput.selectedStartingOption,
      plannedTime: adoptionInput.plannedTime,
      owner: adoptionInput.owner,
      progressNote: adoptionInput.progressNote,
      dueDate: adoptionInput.dueDate,
      status: 'planned'
    });
    expect(service.adoptLifestyleProposal(refreshedAdoptionInput)).toEqual(adopted);
    expect(service.getLifestylePlan(personId)).toMatchObject({
      proposals: [expect.objectContaining({ id: refreshedProposal.id, status: 'adopted' })],
      adoptedActions: [expect.objectContaining({ id: adopted.id, proposalId: refreshedProposal.id, status: 'planned' })]
    });
    const postAdoptionCandidate = service.store.listCurrentDerivedSnapshots()[0]!.payload;
    service.store.publishDerivedSnapshot({
      candidate: {
        ...postAdoptionCandidate,
        lifestyleGuidance: postAdoptionCandidate.lifestyleGuidance.map((item) => ({
          ...item,
          title: '保持规律活动（新报告更新）',
          detail: '新报告已纳入分析，但同一行动方向无需再次确认。'
        }))
      },
      expectedFactRevision: service.store.getFactRevision(personId),
      expectedContextRevision: service.store.getClinicalContextRevision(personId),
      promptVersion: 'derived-v4',
      rulesVersion: 'derived-safety-v2',
      modelId: 'test-post-adoption-refresh-model'
    });
    expect(service.store.listCurrentDerivedSnapshots()[0]!.payload.lifestyleGuidance[0]).toMatchObject({
      dedupeKey: refreshedProposal.dedupeKey,
      title: '保持规律活动（新报告更新）'
    });
    expect(service.store.listLifestyleProposals(personId)).toEqual([
      expect.objectContaining({ id: refreshedProposal.id, status: 'adopted' })
    ]);
    expect(service.store.listActionAdoptions(personId)).toEqual([
      expect.objectContaining({ id: adopted.id, proposalId: refreshedProposal.id, status: 'planned' })
    ]);
    expect(service.getSnapshot(null)).toMatchObject({
      persons: [expect.objectContaining({ derivedStatus: 'current', assessmentSummary: candidate.claims[0]!.explanation })],
      guidance: [expect.objectContaining({ id: 'guide-1', personId })]
    });
    expect(prompts[0]).toContain('本人补充：近期作息不规律');
    expect(prompts[0]).toContain('userReportedNotes');
    expect(prompts[0]).toContain('搜索词必须去标识化');
    expect(webSearchFlags).toEqual([true, true]);
    const completedConsentId = service.store.createManualProcessingConsent({
      documentIds: [service.store.listAcceptedObservations(personId)[0]!.documentId],
      personIds: [personId],
      accountFingerprint: 'completed-account',
      version: 1
    });
    service.store.createWaitingAuthBatch({
      cutoff: '2026-09-18T00:00:00Z',
      initialStatus: 'queued',
      consentId: completedConsentId,
      groups: [{
        personId,
        documentIds: [service.store.listAcceptedObservations(personId)[0]!.documentId],
        inputSignature: 'completed-document-job'
      }]
    });
    const completedJob = service.store.claimNextQueuedJob('completed-runner', 'completed-account')!;
    service.store.finishJob(completedJob.id, 'succeeded');
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
    expect(service.store.listStoredJobs()).toContainEqual(expect.objectContaining({ stage: 'analyze', status: 'queued' }));
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

  it('自动修复派生说明的内部证据 ID 与边界备注后再进行独立安全复核', async () => {
    const { service, personId, observationId } = await setup();
    const malformed: DerivedSnapshotCandidate = {
      schemaVersion: 1, personId, factRevision: 1, dataQuality: 'partial',
      claims: [{
        id: 'claim-repair', organId: 'cardiovascular', level: 'association',
        title: '结合报告继续关注', explanation: '这项变化需要结合后续检查理解。',
        evidenceObservationIds: ['不存在的内部事实-id'], boundaryNote: null
      }],
      lifestyleGuidance: []
    };
    const repaired: DerivedSnapshotCandidate = {
      ...malformed,
      claims: [{
        ...malformed.claims[0]!,
        evidenceObservationIds: [observationId],
        boundaryNote: '仅供参考，不等于诊断。'
      }]
    };
    const review: DerivedSafetyReview = {
      schemaVersion: 1, personId, factRevision: 1, overallSafe: true,
      claimReviews: [{ claimId: 'claim-repair', supported: true, safe: true, issue: null }],
      guidanceReviews: []
    };
    const prompts: string[] = [];
    const webSearchFlags: Array<boolean | undefined> = [];
    let turn = 0;
    const result = await new DerivedHealthPipeline(service.store, {
      runStructuredTurn: async (input) => {
        prompts.push(input.prompt);
        webSearchFlags.push(input.allowWebSearch);
        const output = [malformed, repaired, review][turn++]!;
        return { threadId: 'repair-thread', turnId: `repair-turn-${turn}`, output };
      }
    }).process(personId);

    expect(result).toMatchObject({ status: 'published' });
    expect(prompts[1]).toContain('VALIDATION_ERRORS');
    expect(prompts[1]).toContain('不得使用网页搜索');
    expect(webSearchFlags).toEqual([true, false, true]);
    expect(service.store.listOpenExtractionReviewIssues()).toEqual([]);
    service.close();
  });

  it('独立复核拒绝单条说明时只省略该条，不把整份安全分析交给用户确认', async () => {
    const { service, personId, observationId } = await setup();
    const candidate: DerivedSnapshotCandidate = {
      schemaVersion: 1, personId, factRevision: 1, dataQuality: 'partial',
      claims: [{
        id: 'claim-safe', organId: 'cardiovascular', level: 'fact',
        title: '报告事实', explanation: 'LDL-C 4.2 mmol/L，原报告标记偏高。',
        evidenceObservationIds: [observationId], boundaryNote: null
      }],
      lifestyleGuidance: [guidanceFixture({
        id: 'guidance-unsupported', title: '饮水安排', detail: '按固定时段增加饮水。',
        dedupeKey: 'hydration', category: 'other', evidenceObservationIds: [observationId], consultProfessional: false
      })]
    };
    const review: DerivedSafetyReview = {
      schemaVersion: 1, personId, factRevision: 1, overallSafe: true,
      claimReviews: [{ claimId: 'claim-safe', supported: true, safe: true, issue: null }],
      guidanceReviews: [{ guidanceId: 'guidance-unsupported', supported: false, safe: true, issue: '现有事实不足以支持这条建议' }]
    };
    let turn = 0;
    const result = await new DerivedHealthPipeline(service.store, {
      runStructuredTurn: async () => ({
        threadId: 'omit-thread', turnId: `omit-turn-${++turn}`, output: turn === 1 ? candidate : review
      })
    }).process(personId);

    expect(result).toMatchObject({ status: 'published' });
    expect(service.store.listCurrentDerivedSnapshots()[0]?.payload).toMatchObject({
      claims: [expect.objectContaining({ id: 'claim-safe' })],
      lifestyleGuidance: []
    });
    expect(service.store.listOpenExtractionReviewIssues()).toEqual([]);
    service.close();
  });
});
