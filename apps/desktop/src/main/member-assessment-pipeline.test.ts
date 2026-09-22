import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AssessmentRequestV3, ClinicalFocusedReviewV1, ExtractionResult, MemberAssessmentCandidateV3, MemberEvidencePackageV3 } from '@contracts';
import { DocumentExtractionPipeline } from './processing-pipeline.js';
import { MemberAssessmentPipeline } from './member-assessment-pipeline.js';
import { buildMemberAssessmentInput } from './member-assessment-input.js';
import { PersonalWorkspaceService } from './workspace-service.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'family-health-lean-assessment-'));
  roots.push(root);
  const service = new PersonalWorkspaceService(root, '合成工作区', () => new Date('2026-09-22T00:00:00Z'));
  const personId = service.ensurePrimaryMember({ displayName: '合成成员', relation: '本人' });
  await service.importFiles([{ path: '/tmp/合成血脂报告.txt', bytes: Buffer.from('2026-09-21 LDL-C 4.2 mmol/L, reference 0-3.4') }], personId);
  const documentId = service.getSnapshot(null).inbox[0]!.id;
  const sourceSpanId = service.store.getDocumentExtractionBundle(documentId).manifest.spans[0]!.id;
  const extraction: ExtractionResult = {
    schemaVersion: 1, documentId, coveredSourceSpanIds: [sourceSpanId],
    subject: { reportedName: null, evidence: [], confidence: 'absent' },
    candidates: [{
      localKey: 'ldl', originalName: 'LDL-C', standardNameCandidate: 'LDL-C',
      value: { kind: 'numeric', rawText: '4.2', decimal: '4.2', comparator: 'eq' },
      unitRaw: 'mmol/L', referenceRangeRaw: '0-3.4', reportedAbnormalFlag: 'high',
      specimen: null, method: null, bodySite: null, clinicalDate: '2026-09-21',
      evidence: [{ sourceSpanId, quote: '2026-09-21 LDL-C 4.2 mmol/L, reference 0-3.4' }], issues: []
    }]
  };
  let extractionCalls = 0;
  const extracted = await new DocumentExtractionPipeline(service.store, {
    runStructuredTurn: async () => {
      extractionCalls += 1;
      return { threadId: 'p01-thread', turnId: 'p01-turn', output: extraction };
    }
  }).process(documentId);
  expect(extracted.status).toBe('published');
  expect(extractionCalls).toBe(1);
  const built = buildMemberAssessmentInput(service.store, personId, {
    modelId: 'test-model', reasoningEffort: 'medium', analysisReferenceDate: '2026-09-22', webSearchAllowed: true
  });
  return { service, personId, documentId, built };
}

function candidateFor(request: AssessmentRequestV3, source: MemberEvidencePackageV3): MemberAssessmentCandidateV3 {
  const evidenceId = source.facts[0]!.evidenceIds[0]!;
  const systemIds = request.requestedSystemIds;
  return {
    schemaVersion: 3, personId: request.personId, inputSignature: request.inputSignature,
    mode: request.mode, requestedSystemIds: systemIds,
    overview: {
      id: 'overview', headline: '这次血脂检查有一项需要关注',
      summary: 'LDL-C 高于这份报告的参考上限；目前只有一次结果，下一步先补足整体风险背景。',
      claimIds: ['claim-ldl'], actionIds: ['action-review'], limitations: ['只有一次结果。']
    },
    systems: systemIds.map((systemId) => ({
      id: `system:${systemId}`, systemId, status: 'attention',
      headline: 'LDL-C 有原报告留意标记', summary: '这次结果高于报告参考上限。',
      claimIds: ['claim-ldl'], actionIds: ['action-review'], limitations: []
    })),
    claims: [{
      id: 'claim-ldl', topicKey: 'lipids', systemIds, kind: 'interpretation',
      text: 'LDL-C 4.2 mmol/L，高于该报告参考上限 3.4。',
      diseaseName: null, diagnosticStatus: null, temporalStatus: 'current',
      evidenceIds: [evidenceId], counterEvidenceIds: [], trendIds: [],
      knowledgeBasis: 'model_general', knowledgeSourceIds: [], criteriaBasis: null,
      rationale: '报告同时给出结果与参考范围。', materialUncertainty: null, consequenceLevel: 'routine'
    }],
    actions: [{
      id: 'action-review', dedupeKey: 'lipid-risk-context', systemIds, claimIds: ['claim-ldl'],
      kind: 'test_followup', title: '整理血脂及相关病史后复核',
      why: '单次结果不足以决定长期管理方向。', firstStep: '整理既往血脂报告和相关病史。',
      timing: '下次就诊时', timingBasis: 'none', reviewPlan: null, caution: null,
      urgency: 'routine', evidenceIds: [evidenceId], knowledgeSourceIds: []
    }],
    questions: [], knowledgeSources: []
  };
}

describe('MemberAssessmentPipeline', () => {
  it('清晰资料只调用一次 P01、一次 P02，并发布一份成员快照', async () => {
    const { service, personId, built } = await fixture();
    let assessmentCalls = 0;
    const result = await new MemberAssessmentPipeline(service.store, {
      runStructuredTurn: async (input) => {
        assessmentCalls += 1;
        expect(input.prompt).toContain('ASSESSMENT_REQUEST=');
        expect(input.allowWebSearch).toBe(true);
        return { threadId: 'p02-thread', turnId: 'p02-turn', output: candidateFor(built.request, built.evidencePackage) };
      }
    }, undefined, undefined, undefined, 'test-model', 'medium', '2026-09-22').process(personId);
    expect(result).toMatchObject({ status: 'published', callCount: 1 });
    expect(assessmentCalls).toBe(1);
    expect(service.store.listMemberAssessmentSnapshots(personId, true)).toHaveLength(1);
    expect(service.getMemberOverview(personId).headline).toBe('这次血脂检查有一项需要关注');
    expect(service.getLifestylePlan(personId).adoptedActions).toEqual([]);
    expect(await new MemberAssessmentPipeline(service.store, { runStructuredTurn: async () => { throw new Error('SHOULD_NOT_RUN'); } },
      undefined, undefined, undefined, 'test-model', 'medium', '2026-09-22').process(personId))
      .toMatchObject({ status: 'skipped', reason: 'signature_current', callCount: 0 });
    service.close();
  });

  it('具体引用问题只做一次 P03，不重做全量综合', async () => {
    const { service, personId, built } = await fixture();
    const valid = candidateFor(built.request, built.evidencePackage);
    const wrong = structuredClone(valid);
    wrong.claims[0]!.evidenceIds = ['missing-evidence'];
    let calls = 0;
    const result = await new MemberAssessmentPipeline(service.store, {
      runStructuredTurn: async (input) => {
        calls += 1;
        if (calls === 1) return { threadId: 'p02', turnId: 'first', output: wrong };
        expect(input.prompt).toContain('REPAIR_REQUEST=');
        expect(input.allowWebSearch).toBe(false);
        return { threadId: 'p03', turnId: 'second', output: valid };
      }
    }, undefined, undefined, undefined, 'test-model', 'medium', '2026-09-22').process(personId);
    expect(result).toMatchObject({ status: 'published', callCount: 2 });
    expect(calls).toBe(2);
    service.close();
  });

  it('新提出的高后果疾病判断即使漏标高影响，也只触发一次重点复核', async () => {
    const { service, personId, built } = await fixture();
    const candidate = candidateFor(built.request, built.evidencePackage);
    candidate.claims[0] = {
      ...candidate.claims[0]!, kind: 'diagnostic_assessment', diseaseName: '恶性肿瘤',
      diagnosticStatus: 'possible', text: '这可能提示恶性肿瘤，需要核实。',
      consequenceLevel: 'routine', materialUncertainty: '目前只有一项非特异血脂结果。'
    };
    let calls = 0;
    const result = await new MemberAssessmentPipeline(service.store, {
      runStructuredTurn: async (input) => {
        calls += 1;
        if (calls === 1) return { threadId: 'p02', turnId: 'first', output: candidate };
        expect(input.prompt).toContain('REVIEW_REQUEST=');
        const targets = [...new Set(['claim-ldl', 'action-review', 'overview', ...built.request.requestedSystemIds.map((id) => `system:${id}`)])];
        const review: ClinicalFocusedReviewV1 = {
          schemaVersion: 1, personId, inputSignature: built.request.inputSignature,
          results: targets.map((targetId) => ({ targetId, verdict: targetId === 'claim-ldl' ? 'hold' : 'pass',
            reason: '单项非特异指标不能支持该高后果疾病判断。', replacement: null }))
        };
        return { threadId: 'p04', turnId: 'second', output: review };
      }
    }, undefined, undefined, undefined, 'test-model', 'medium', '2026-09-22').process(personId);
    expect(result).toMatchObject({ status: 'published', callCount: 2 });
    expect(calls).toBe(2);
    const published = service.store.listMemberAssessmentSnapshots(personId, true)[0]!;
    expect(published.claims).toEqual([]);
    expect(published.overview.headline).toBe('部分健康判断仍需核实');
    expect(published.actions).toEqual([]);
    expect(published.heldTargetIds).toContain('claim-ldl');
    service.close();
  });
});
