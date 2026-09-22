import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import type { AccountState, AssessmentRequestV3, ClinicalFocusedReviewV1, ExtractionResult, MemberAssessmentCandidateV3, MemberEvidencePackageV3 } from '@contracts';
import type { CodexRuntimeManager } from './codex-runtime.js';
import { ProcessingJobRunner } from './job-runner.js';
import { DocumentExtractionPipeline } from './processing-pipeline.js';
import { MemberAssessmentPipeline, repairTargets } from './member-assessment-pipeline.js';
import { buildMemberAssessmentInput } from './member-assessment-input.js';
import { buildMemberAggregatePackage, buildMemberSystemPartitions, splitMemberPartition } from './member-assessment-partition.js';
import { validateAssessmentCandidate } from './assessment-validation.js';
import { buildAssessmentKnowledgeVerifications, canonicalizeAssessmentKnowledge } from './assessment-knowledge.js';
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

async function fixtureTwoSystems() {
  const { service, personId } = await fixture();
  await service.importFiles([{ path: '/tmp/合成肝功报告.txt', bytes: Buffer.from('2026-09-21 谷丙转氨酶 42 U/L') }], personId);
  const documentId = service.getSnapshot(null).inbox.find((item) => item.displayName === '合成肝功报告.txt')!.id;
  const span = service.store.getDocumentExtractionBundle(documentId).manifest.spans[0]!;
  const result: ExtractionResult = {
    schemaVersion: 1, documentId, coveredSourceSpanIds: [span.id],
    subject: { reportedName: null, evidence: [], confidence: 'absent' },
    candidates: [{
      localKey: 'alt', originalName: '谷丙转氨酶', standardNameCandidate: 'ALT',
      value: { kind: 'numeric', rawText: '42', decimal: '42', comparator: 'eq' },
      unitRaw: 'U/L', referenceRangeRaw: null, reportedAbnormalFlag: null,
      specimen: null, method: null, bodySite: null, clinicalDate: '2026-09-21',
      evidence: [{ sourceSpanId: span.id, quote: '2026-09-21 谷丙转氨酶 42 U/L' }], issues: []
    }]
  };
  const extracted = await new DocumentExtractionPipeline(service.store, {
    runStructuredTurn: async () => ({ threadId: 'alt-thread', turnId: 'alt-turn', output: result })
  }).process(documentId);
  expect(extracted.status).toBe('published');
  const built = buildMemberAssessmentInput(service.store, personId, {
    modelId: 'test-model', reasoningEffort: 'medium', analysisReferenceDate: '2026-09-22', webSearchAllowed: true
  });
  expect(built.request.requestedSystemIds.length).toBeGreaterThanOrEqual(2);
  return { service, personId, built };
}

async function fixtureUnclassified() {
  const root = mkdtempSync(join(tmpdir(), 'family-health-unclassified-assessment-'));
  roots.push(root);
  const service = new PersonalWorkspaceService(root, '合成工作区', () => new Date('2026-09-22T00:00:00Z'));
  const personId = service.ensurePrimaryMember({ displayName: '合成成员', relation: '本人' });
  await service.importFiles([{ path: '/tmp/合成未归类检查.txt', bytes: Buffer.from('2026-09-21 合成未归类检查：记录甲。') }], personId);
  const documentId = service.getSnapshot(null).inbox[0]!.id;
  const span = service.store.getDocumentExtractionBundle(documentId).manifest.spans[0]!;
  const extraction: ExtractionResult = {
    schemaVersion: 1, documentId, coveredSourceSpanIds: [span.id],
    subject: { reportedName: null, evidence: [], confidence: 'absent' },
    candidates: [{
      localKey: 'unclassified-result', originalName: '合成未归类检查', standardNameCandidate: null,
      value: { kind: 'text', rawText: '记录甲' }, unitRaw: null, referenceRangeRaw: null,
      reportedAbnormalFlag: null, specimen: null, method: null, bodySite: null,
      clinicalDate: '2026-09-21', evidence: [{ sourceSpanId: span.id, quote: span.quote }], issues: []
    }]
  };
  const result = await new DocumentExtractionPipeline(service.store, {
    runStructuredTurn: async () => ({ threadId: 'p01', turnId: 'p01', output: extraction })
  }).process(documentId);
  expect(result.status).toBe('published');
  const built = buildMemberAssessmentInput(service.store, personId, {
    modelId: 'test-model', reasoningEffort: 'medium', analysisReferenceDate: '2026-09-22', webSearchAllowed: true
  });
  return { service, personId, built };
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
  it('事实已接纳但尚未归入系统时仍一次 P02 发布成员总览，不猜系统或重提取', async () => {
    const { service, personId, built } = await fixtureUnclassified();
    expect(built.evidencePackage.facts).toHaveLength(1);
    expect(built.evidencePackage.facts[0]?.systemIds).toEqual([]);
    expect(built.request.requestedSystemIds).toEqual([]);
    expect(built.evidencePackage.unresolvedScope).toEqual([{
      documentId: built.evidencePackage.facts[0]!.documentId, reasonCodes: ['FACT_SYSTEM_UNMAPPED']
    }]);
    const candidate = candidateFor(built.request, built.evidencePackage);
    candidate.overview = { ...candidate.overview, headline: '已保存一条检查记录，尚待归类',
      summary: '报告记录了合成未归类检查的原文结果；目前不猜测它属于哪个身体系统。',
      limitations: ['该项目尚未完成系统归类。'] };
    candidate.claims[0] = { ...candidate.claims[0]!, topicKey: 'unclassified', kind: 'source_fact',
      text: '2026-09-21 报告记录合成未归类检查为“记录甲”。', knowledgeBasis: 'not_applicable' };
    candidate.actions[0] = { ...candidate.actions[0]!, title: '核对检查项目归类',
      firstStep: '查看原报告并核对该项目的检查名称。' };
    let calls = 0;
    const first = await new MemberAssessmentPipeline(service.store, {
      runStructuredTurn: async () => { calls += 1; return { threadId: 'p02', turnId: 'only', output: candidate }; }
    }, undefined, undefined, undefined, 'test-model', 'medium', '2026-09-22').process(personId);
    expect(first).toMatchObject({ status: 'published', callCount: 1 });
    expect(calls).toBe(1);
    const snapshot = service.getMemberAssessment(personId);
    expect(snapshot?.systems).toEqual([]);
    expect(snapshot?.claims[0]?.systemIds).toEqual([]);
    expect(snapshot?.limitations).toContain('部分来源事实尚未完成身体系统归类；成员总览包含这些资料，但身体系统视图可能不完整。');
    expect(service.getMemberOverview(personId)).toMatchObject({
      headline: '已保存一条检查记录，尚待归类', unclassifiedFactCount: 1, dataQuality: 'partial'
    });
    const again = await new MemberAssessmentPipeline(service.store, {
      runStructuredTurn: async () => { throw new Error('SHOULD_NOT_CALL'); }
    }, undefined, undefined, undefined, 'test-model', 'medium', '2026-09-22').process(personId);
    expect(again).toMatchObject({ status: 'skipped', reason: 'signature_current', callCount: 0 });
    service.close();
  });

  it('无系统可分时上下文超限仍可按来源事实分区，不丢掉已接纳项目', async () => {
    const { service, built } = await fixtureUnclassified();
    const source = structuredClone(built.evidencePackage);
    source.facts.push({ ...source.facts[0]!, observationId: 'synthetic-second-fact' });
    const partitions = buildMemberSystemPartitions(source, []);
    expect(partitions).toHaveLength(1);
    expect(partitions[0]?.systemIds).toEqual([]);
    const children = splitMemberPartition(partitions[0]!);
    expect(children).toHaveLength(2);
    expect(children?.flatMap((item) => item.primaryObservationIds)).toEqual(
      expect.arrayContaining(source.facts.map((fact) => fact.observationId))
    );
    service.close();
  });

  it('真实模型的系统 ID 与 undetermined 类型可本地归一化，正常路径仍只需一次 P02', async () => {
    const { service, personId, built } = await fixture();
    const candidate = candidateFor(built.request, built.evidencePackage);
    candidate.systems[0]!.id = `system-${candidate.systems[0]!.systemId}`;
    candidate.claims[0] = { ...candidate.claims[0]!, kind: 'interpretation',
      diseaseName: '血脂异常的具体病因', diagnosticStatus: 'undetermined',
      text: '目前不能仅凭一次 LDL-C 结果判断血脂异常的具体病因。' };
    let calls = 0;
    const result = await new MemberAssessmentPipeline(service.store, {
      runStructuredTurn: async () => { calls += 1; return { threadId: 'p02', turnId: 'turn', output: candidate }; }
    }, undefined, undefined, undefined, 'test-model', 'medium', '2026-09-22').process(personId);
    expect(result).toMatchObject({ status: 'published', callCount: 1 });
    expect(calls).toBe(1);
    expect(service.store.listMemberAssessmentSnapshots(personId, true)[0]?.systems[0]?.id)
      .toBe(`system:${candidate.systems[0]!.systemId}`);
    expect(service.store.listMemberAssessmentSnapshots(personId, true)[0]?.claims[0]?.kind)
      .toBe('diagnostic_assessment');
    service.close();
  });

  it('分区覆盖每条选入事实，共享线索复用原 ID，聚合保留分区结果与原子依据', async () => {
    const { service, built } = await fixtureTwoSystems();
    const source = structuredClone(built.evidencePackage);
    source.facts.push({ ...source.facts[0]!, observationId: 'unmapped-fact', originalName: '未映射项目',
      rawValue: '原文记录', valueKind: 'text', systemIds: [], evidenceIds: ['unmapped-evidence'],
      reportedAbnormalFlag: 'unknown' });
    source.evidenceCatalog.push({ ...source.evidenceCatalog[0]!, id: 'unmapped-evidence',
      observationId: 'unmapped-fact', quote: '未映射项目：原文记录' });
    source.criteriaSets.push({ id: 'synthetic-set', sourceId: 'synthetic-knowledge', applicability: '合成条件',
      requiredCriterionIds: ['required-measurement'],
      verifiedRequirements: [{ criterionId: 'required-measurement', evidenceIds: ['unmapped-evidence'] }] });
    const partitions = buildMemberSystemPartitions(source, built.request.requestedSystemIds);
    expect(new Set(partitions.flatMap((item) => item.evidencePackage.facts.map((fact) => fact.observationId))))
      .toEqual(new Set(source.facts.map((fact) => fact.observationId)));
    expect(partitions[0]!.evidencePackage.facts.some((fact) => fact.observationId === 'unmapped-fact')).toBe(true);
    for (const partition of partitions) {
      const catalogIds = new Set(partition.evidencePackage.evidenceCatalog.map((item) => item.id));
      expect(partition.evidencePackage.facts.every((fact) => fact.evidenceIds.every((id) => catalogIds.has(id)))).toBe(true);
    }
    const results = partitions.map((partition) => candidateFor({
      ...built.request, mode: 'partition', requestedSystemIds: partition.systemIds
    }, partition.evidencePackage));
    const aggregate = buildMemberAggregatePackage(source, results);
    expect(aggregate.partitionResults).toHaveLength(partitions.length);
    expect(aggregate.facts.some((fact) => fact.observationId === source.facts[0]!.observationId)).toBe(true);
    expect(aggregate.facts.some((fact) => fact.observationId === 'unmapped-fact')).toBe(true);
    expect(aggregate.criteriaSets).toHaveLength(1);
    expect(aggregate.trends).toEqual(source.trends);
    service.close();
  });

  it('真实上下文超限后按系统 P02 分区再聚合，记录失败尝试和 K+1 次成功调用', async () => {
    const { service, personId, built } = await fixtureTwoSystems();
    const modes: string[] = [];
    const aggregatePackages: MemberEvidencePackageV3[] = [];
    const result = await new MemberAssessmentPipeline(service.store, {
      runStructuredTurn: async (input) => {
        const request = JSON.parse(input.prompt.split('ASSESSMENT_REQUEST=')[1]!.split('\nMEMBER_EVIDENCE_PACKAGE=')[0]!) as AssessmentRequestV3;
        const evidence = JSON.parse(input.prompt.split('MEMBER_EVIDENCE_PACKAGE=')[1]!) as MemberEvidencePackageV3;
        modes.push(request.mode);
        if (request.mode === 'full') throw new Error('CODEX_CONTEXT_WINDOW_EXCEEDED');
        if (request.mode === 'aggregate') aggregatePackages.push(evidence);
        const candidate = candidateFor(request, evidence);
        const fact = evidence.facts[0]!;
        candidate.claims[0]!.text = `${fact.originalName} ${fact.rawValue} ${fact.unit ?? ''}，应结合报告日期理解。`;
        return { threadId: `p02-${modes.length}`, turnId: `p02-${modes.length}`, output: candidate };
      }
    }, undefined, undefined, undefined, 'test-model', 'medium', '2026-09-22').process(personId);
    const partitionCount = built.request.requestedSystemIds.length;
    expect(modes).toEqual(['full', ...Array.from({ length: partitionCount }, () => 'partition'), 'aggregate']);
    expect(result).toMatchObject({ status: 'published', callCount: partitionCount + 2 });
    expect(aggregatePackages[0]?.partitionResults).toHaveLength(partitionCount);
    const snapshot = service.store.listMemberAssessmentSnapshots(personId, true)[0]!;
    expect(snapshot.mode).toBe('aggregate');
    expect(snapshot.processingPlan).toEqual({
      strategy: 'partitioned', trigger: 'runtime_context_window_exceeded', partitionCount,
      partitionHeldTargetCount: 0
    });
    expect(snapshot.evidenceCatalog.length).toBe(built.evidencePackage.evidenceCatalog.length);
    service.close();
  });

  it('单条事实仍超限时明确失败，不伪装成完成了分区综合', async () => {
    const { service, personId, built } = await fixture();
    expect(built.request.requestedSystemIds).toHaveLength(1);
    const result = await new MemberAssessmentPipeline(service.store, {
      runStructuredTurn: async () => { throw new Error('CODEX_CONTEXT_WINDOW_EXCEEDED'); }
    }, undefined, undefined, undefined, 'test-model', 'medium', '2026-09-22').process(personId);
    expect(result).toMatchObject({ status: 'rejected', reason: 'single_fact_context_window_exceeded', callCount: 1 });
    expect(service.store.listMemberAssessmentSnapshots(personId, true)).toEqual([]);
    service.close();
  });

  it('同一个身体系统的两份历史报告超限后按报告分区，不丢任何一份', async () => {
    const { service, personId } = await fixture();
    await service.importFiles([{ path: '/tmp/合成第二次血脂报告.txt', bytes: Buffer.from('2024-09-21 LDL-C 3.8 mmol/L') }], personId);
    const documentId = service.getSnapshot(null).inbox.find((item) => item.displayName === '合成第二次血脂报告.txt')!.id;
    const span = service.store.getDocumentExtractionBundle(documentId).manifest.spans[0]!;
    const extraction: ExtractionResult = {
      schemaVersion: 1, documentId, coveredSourceSpanIds: [span.id],
      subject: { reportedName: null, evidence: [], confidence: 'absent' },
      candidates: [{ localKey: 'ldl-old', originalName: 'LDL-C', standardNameCandidate: 'LDL-C',
        value: { kind: 'numeric', rawText: '3.8', decimal: '3.8', comparator: 'eq' },
        unitRaw: 'mmol/L', referenceRangeRaw: null, reportedAbnormalFlag: null,
        specimen: null, method: null, bodySite: null, clinicalDate: '2024-09-21',
        evidence: [{ sourceSpanId: span.id, quote: '2024-09-21 LDL-C 3.8 mmol/L' }], issues: [] }]
    };
    await new DocumentExtractionPipeline(service.store, {
      runStructuredTurn: async () => ({ threadId: 'old', turnId: 'old', output: extraction })
    }).process(documentId);
    const modes: string[] = [];
    const partitionDocuments: string[] = [];
    const result = await new MemberAssessmentPipeline(service.store, {
      runStructuredTurn: async (input) => {
        const request = JSON.parse(input.prompt.split('ASSESSMENT_REQUEST=')[1]!.split('\nMEMBER_EVIDENCE_PACKAGE=')[0]!) as AssessmentRequestV3;
        const evidence = JSON.parse(input.prompt.split('MEMBER_EVIDENCE_PACKAGE=')[1]!) as MemberEvidencePackageV3;
        modes.push(request.mode);
        if (request.mode === 'full') throw new Error('CODEX_CONTEXT_WINDOW_EXCEEDED');
        if (request.mode === 'partition') {
          expect(request.partitionScope?.basis).toBe('document');
          expect(evidence.facts).toHaveLength(1);
          partitionDocuments.push(evidence.facts[0]!.documentId);
        }
        return { threadId: 'p02', turnId: `turn-${modes.length}`, output: candidateFor(request, evidence) };
      }
    }, undefined, undefined, undefined, 'test-model', 'medium', '2026-09-22').process(personId);
    expect(modes).toEqual(['full', 'partition', 'partition', 'aggregate']);
    expect(new Set(partitionDocuments).size).toBe(2);
    expect(result).toMatchObject({ status: 'published', callCount: 4 });
    expect(service.store.listMemberAssessmentSnapshots(personId, true)[0]!.processingPlan.partitionCount).toBe(2);
    service.close();
  });

  it('聚合不能悄悄丢掉分区里尚未隔离的高影响判断', async () => {
    const { service, personId } = await fixtureTwoSystems();
    let partitionIndex = 0;
    const result = await new MemberAssessmentPipeline(service.store, {
      runStructuredTurn: async (input) => {
        const request = JSON.parse(input.prompt.split('ASSESSMENT_REQUEST=')[1]!.split('\nMEMBER_EVIDENCE_PACKAGE=')[0]!) as AssessmentRequestV3;
        const evidence = JSON.parse(input.prompt.split('MEMBER_EVIDENCE_PACKAGE=')[1]!) as MemberEvidencePackageV3;
        if (request.mode === 'full') throw new Error('CODEX_CONTEXT_WINDOW_EXCEEDED');
        const candidate = candidateFor(request, evidence);
        if (request.mode === 'partition' && partitionIndex++ === 0) candidate.claims[0]!.consequenceLevel = 'high';
        if (request.mode === 'aggregate') {
          candidate.claims[0]!.id = 'claim-rewritten';
          candidate.overview.claimIds = ['claim-rewritten'];
          candidate.actions[0]!.claimIds = ['claim-rewritten'];
          for (const system of candidate.systems) system.claimIds = ['claim-rewritten'];
        }
        return { threadId: 'p02', turnId: 'p02', output: candidate };
      }
    }, undefined, undefined, undefined, 'test-model', 'medium', '2026-09-22').process(personId);
    expect(result).toMatchObject({ status: 'rejected', reason: 'aggregate_omitted_high_impact:claim-ldl' });
    expect(service.store.listMemberAssessmentSnapshots(personId, true)).toEqual([]);
    service.close();
  });

  it('聚合把分区高影响判断降级时仍强制一次 P04 核查改写及依赖', async () => {
    const { service, personId, built } = await fixtureTwoSystems();
    let partitionIndex = 0;
    let reviewCalls = 0;
    const result = await new MemberAssessmentPipeline(service.store, {
      runStructuredTurn: async (input) => {
        if (input.prompt.includes('REVIEW_REQUEST=')) {
          reviewCalls += 1;
          const reviewRequest = JSON.parse(input.prompt.split('REVIEW_REQUEST=')[1]!.split('\nSOURCE_CONTEXT=')[0]!) as {
            targets: string[]; personId: string; inputSignature: string
          };
          expect(reviewRequest.targets).toEqual(expect.arrayContaining(['claim-ldl', 'action-review', 'overview']));
          return { threadId: 'p04', turnId: 'review', output: {
            schemaVersion: 1, personId, inputSignature: reviewRequest.inputSignature,
            results: reviewRequest.targets.map((targetId) => ({
              targetId, verdict: 'pass', reason: '合成复核已核查改写', replacement: null
            }))
          } };
        }
        const request = JSON.parse(input.prompt.split('ASSESSMENT_REQUEST=')[1]!.split('\nMEMBER_EVIDENCE_PACKAGE=')[0]!) as AssessmentRequestV3;
        const evidence = JSON.parse(input.prompt.split('MEMBER_EVIDENCE_PACKAGE=')[1]!) as MemberEvidencePackageV3;
        if (request.mode === 'full') throw new Error('CODEX_CONTEXT_WINDOW_EXCEEDED');
        const candidate = candidateFor(request, evidence);
        if (request.mode === 'partition' && partitionIndex++ === 0) candidate.claims[0]!.consequenceLevel = 'high';
        return { threadId: 'p02', turnId: `assessment-${partitionIndex}`, output: candidate };
      }
    }, undefined, undefined, undefined, 'test-model', 'medium', '2026-09-22').process(personId);
    expect(result).toMatchObject({ status: 'published', callCount: built.request.requestedSystemIds.length + 3 });
    expect(reviewCalls).toBe(1);
    expect(service.store.listMemberAssessmentSnapshots(personId, true)[0]!.reviewedTargetIds).toContain('claim-ldl');
    service.close();
  });

  it('分区隔离过的节点被聚合带回时先复核，复核通过才可发布', async () => {
    const { service, personId, built } = await fixtureTwoSystems();
    let partitionIndex = 0;
    let repairCalls = 0;
    let reviewCalls = 0;
    const result = await new MemberAssessmentPipeline(service.store, {
      runStructuredTurn: async (input) => {
        if (input.prompt.includes('REPAIR_REQUEST=')) {
          repairCalls += 1;
          const candidate = JSON.parse(input.prompt.split('TARGET_CANDIDATE=')[1]!) as MemberAssessmentCandidateV3;
          return { threadId: 'p03', turnId: 'repair', output: candidate };
        }
        if (input.prompt.includes('REVIEW_REQUEST=')) {
          reviewCalls += 1;
          const reviewRequest = JSON.parse(input.prompt.split('REVIEW_REQUEST=')[1]!.split('\nSOURCE_CONTEXT=')[0]!) as {
            targets: string[]; personId: string; inputSignature: string
          };
          expect(reviewRequest.targets).toEqual(expect.arrayContaining(['claim-ldl', 'action-review', 'overview']));
          expect(input.prompt).toContain('partition_held_reintroduced:claim-ldl');
          return { threadId: 'p04', turnId: 'review', output: {
            schemaVersion: 1, personId, inputSignature: reviewRequest.inputSignature,
            results: reviewRequest.targets.map((targetId) => ({
              targetId, verdict: 'pass', reason: '已核对聚合重新出现的主张及依赖。', replacement: null
            }))
          } };
        }
        const request = JSON.parse(input.prompt.split('ASSESSMENT_REQUEST=')[1]!.split('\nMEMBER_EVIDENCE_PACKAGE=')[0]!) as AssessmentRequestV3;
        const evidence = JSON.parse(input.prompt.split('MEMBER_EVIDENCE_PACKAGE=')[1]!) as MemberEvidencePackageV3;
        if (request.mode === 'full') throw new Error('CODEX_CONTEXT_WINDOW_EXCEEDED');
        const candidate = candidateFor(request, evidence);
        if (request.mode === 'partition' && partitionIndex++ === 0) candidate.claims[0]!.evidenceIds = ['missing-evidence'];
        return { threadId: 'p02', turnId: `assessment-${partitionIndex}`, output: candidate };
      }
    }, undefined, undefined, undefined, 'test-model', 'medium', '2026-09-22').process(personId);
    expect(result).toMatchObject({ status: 'published', callCount: built.request.requestedSystemIds.length + 4 });
    expect(repairCalls).toBe(1);
    expect(reviewCalls).toBe(1);
    const snapshot = service.store.listMemberAssessmentSnapshots(personId, true)[0]!;
    expect(snapshot.claims.map((claim) => claim.id)).toContain('claim-ldl');
    expect(snapshot.heldTargetIds).not.toContain('claim-ldl');
    expect(snapshot.reviewedTargetIds).toContain('claim-ldl');
    expect(snapshot.processingPlan.partitionHeldTargetCount).toBeGreaterThan(0);
    service.close();
  });

  it('重点复核行动时把行动自己的个人证据也送给复核者', async () => {
    const { service, personId, built } = await fixtureTwoSystems();
    const actionEvidenceId = built.evidencePackage.facts.find((fact) => fact.originalName === '谷丙转氨酶')!.evidenceIds[0]!;
    const candidate = candidateFor(built.request, built.evidencePackage);
    candidate.actions[0]!.urgency = 'emergency';
    candidate.actions[0]!.evidenceIds = [actionEvidenceId];
    let reviewCalls = 0;
    const result = await new MemberAssessmentPipeline(service.store, {
      runStructuredTurn: async (input) => {
        if (!input.prompt.includes('REVIEW_REQUEST=')) {
          return { threadId: 'p02', turnId: 'assessment', output: candidate };
        }
        reviewCalls += 1;
        const sourceContext = JSON.parse(input.prompt.split('SOURCE_CONTEXT=')[1]!.split('\nTARGET_NODES=')[0]!) as {
          evidenceCatalog: Array<{ id: string }>
        };
        expect(sourceContext.evidenceCatalog.map((item) => item.id)).toContain(actionEvidenceId);
        const request = JSON.parse(input.prompt.split('REVIEW_REQUEST=')[1]!.split('\nSOURCE_CONTEXT=')[0]!) as {
          targets: string[]; personId: string; inputSignature: string
        };
        return { threadId: 'p04', turnId: 'review', output: {
          schemaVersion: 1, personId, inputSignature: request.inputSignature,
          results: request.targets.map((targetId) => ({ targetId, verdict: 'pass', reason: '合成复核已核对来源。', replacement: null }))
        } };
      }
    }, undefined, undefined, undefined, 'test-model', 'medium', '2026-09-22').process(personId);
    expect(result).toMatchObject({ status: 'published', callCount: 2 });
    expect(reviewCalls).toBe(1);
    service.close();
  });

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

  it('成员建议只有本人点击后成为行动，重复点击不重复创建，资料变化后拒绝旧快照', async () => {
    const { service, personId, built } = await fixture();
    const result = await new MemberAssessmentPipeline(service.store, {
      runStructuredTurn: async () => ({ threadId: 'p02', turnId: 'turn', output: candidateFor(built.request, built.evidencePackage) })
    }, undefined, undefined, undefined, 'test-model', 'medium', '2026-09-22').process(personId);
    expect(result.status).toBe('published');
    expect(service.getLifestylePlan(personId).adoptedActions).toEqual([]);
    const snapshot = service.getMemberAssessment(personId)!;
    const input = { personId, snapshotId: snapshot.id, actionId: snapshot.actions[0]!.id };
    const first = service.adoptMemberAssessmentAction(input);
    expect(first).toMatchObject({ origin: 'ai_proposed', status: 'planned' });
    expect(service.adoptMemberAssessmentAction(input).id).toBe(first.id);
    expect(service.getLifestylePlan(personId).adoptedActions).toMatchObject([{
      id: first.id, assessmentDedupeKey: snapshot.actions[0]!.dedupeKey
    }]);
    expect(service.store.listActionItems(personId).filter((item) => item.id === first.id)).toHaveLength(1);
    expect(() => service.adoptMemberAssessmentAction({ ...input, actionId: 'not-in-snapshot' })).toThrow('MEMBER_ASSESSMENT_ACTION_NOT_AVAILABLE');
    service.store.createManualNote({
      personId, kind: 'free_text', immutableText: '合成补充说明', effectiveDate: '2026-09-22',
      structuredFields: {}, expectedContextRevision: 0
    });
    expect(() => service.adoptMemberAssessmentAction(input)).toThrow('MEMBER_ASSESSMENT_ACTION_STALE');
    expect(service.store.listActionItems(personId).some((item) => item.id === first.id)).toBe(true);
    service.close();
  });

  it('隔离合成评测可显式关闭 P02 联网，输入签名和运行权限保持一致', async () => {
    const { service, personId } = await fixture();
    const built = buildMemberAssessmentInput(service.store, personId, {
      modelId: 'test-model', reasoningEffort: 'medium', analysisReferenceDate: '2026-09-22', webSearchAllowed: false
    });
    const result = await new MemberAssessmentPipeline(service.store, {
      runStructuredTurn: async (input) => {
        expect(input.allowWebSearch).toBe(false);
        const request = JSON.parse(input.prompt.split('ASSESSMENT_REQUEST=')[1]!.split('\nMEMBER_EVIDENCE_PACKAGE=')[0]!) as AssessmentRequestV3;
        expect(request.webSearchAllowed).toBe(false);
        return { threadId: 'offline', turnId: 'offline', output: candidateFor(built.request, built.evidencePackage) };
      }
    }, undefined, undefined, undefined, 'test-model', 'medium', '2026-09-22', false).process(personId);
    expect(result).toMatchObject({ status: 'published', callCount: 1 });
    service.close();
  });

  it('仅更新已采纳行动的完成进度不会使成员医学输入失效', async () => {
    const { service, personId } = await fixture();
    const action = service.store.createUserAction({
      personId, title: '整理既往报告', detail: '下次就诊携带', dueDate: null, dueText: null
    });
    const options = { modelId: 'test-model', reasoningEffort: 'medium', analysisReferenceDate: '2026-09-22', webSearchAllowed: true };
    const before = buildMemberAssessmentInput(service.store, personId, options);
    service.store.updateActionStatus({ actionId: action.id, status: 'completed', expectedRevision: action.userRevision });
    const after = buildMemberAssessmentInput(service.store, personId, options);
    expect(after.request.inputSignature).toBe(before.request.inputSignature);
    expect(after.evidencePackage.existingActions[0]!.status).toBe('existing');
    service.close();
  });

  it.each([
    { reason: '提示词版本变化', promptVersion: 'member-assessment-v2', rulesVersion: null },
    { reason: '重点复核路由规则升级', promptVersion: null, rulesVersion: 'lean-health-v3.4' }
  ])('$reason 时只重做 P02，已接纳报告事实不重新提取', async ({ promptVersion, rulesVersion }) => {
    const { service, personId, built } = await fixture();
    await new MemberAssessmentPipeline(service.store, {
      runStructuredTurn: async () => ({ threadId: 'original', turnId: 'original', output: candidateFor(built.request, built.evidencePackage) })
    }, undefined, undefined, undefined, 'test-model', 'medium', '2026-09-22').process(personId);
    const original = service.store.listMemberAssessmentSnapshots(personId, true)[0]!;
    const oldSignature = 'f'.repeat(64);
    const database = new Database(service.store.databasePath);
    database.prepare(`UPDATE member_assessment_snapshots_v3 SET input_signature = ?, prompt_version = ?, rules_version = ?,
      payload_json = json_set(payload_json, '$.inputSignature', ?, '$.promptVersion', ?, '$.rulesVersion', ?) WHERE id = ?`)
      .run(oldSignature, promptVersion ?? original.promptVersion, rulesVersion ?? original.rulesVersion,
        oldSignature, promptVersion ?? original.promptVersion, rulesVersion ?? original.rulesVersion, original.id);
    database.close();
    expect(service.getMemberAssessment(personId)).toBeNull();
    const state: AccountState = { status: 'connected', displayLabel: 'fixture@example.test',
      quota: { status: 'available', primaryUsedPercent: 10, secondaryUsedPercent: null, resetsAt: null },
      runtimeVersion: 'fixture', lastCheckedAt: '2026-09-22T00:00:00Z' };
    service.processNow({ accountState: state, consentVersion: 1 });
    expect(service.store.listStoredJobs()[0]).toMatchObject({ stage: 'analyze' });
    const factRevision = service.store.getFactRevision(personId);
    let calls = 0;
    const runtime = {
      getState: () => state,
      runStructuredTurn: async (input: { prompt: string }) => {
        calls += 1;
        expect(input.prompt).toContain('ASSESSMENT_REQUEST=');
        expect(input.prompt).not.toContain('SOURCE_PACKAGE=');
        const request = JSON.parse(input.prompt.split('ASSESSMENT_REQUEST=')[1]!.split('\nMEMBER_EVIDENCE_PACKAGE=')[0]!) as AssessmentRequestV3;
        const evidence = JSON.parse(input.prompt.split('MEMBER_EVIDENCE_PACKAGE=')[1]!) as MemberEvidencePackageV3;
        return { threadId: 'refresh', turnId: 'refresh', output: candidateFor(request, evidence) };
      }
    } as unknown as CodexRuntimeManager;
    await new ProcessingJobRunner(runtime).runAvailableJobs(service.store);
    expect(calls).toBe(1);
    expect(service.store.getFactRevision(personId)).toBe(factRevision);
    expect(service.store.listAcceptedObservations(personId)).toHaveLength(1);
    expect(service.store.listMemberAssessmentSnapshots(personId, true)).toHaveLength(1);
    expect(service.store.listMemberAssessmentSnapshots(personId, false)).toHaveLength(2);
    service.close();
  });

  it('具体引用问题只做一次 P03，不重做全量综合', async () => {
    const { service, personId, built } = await fixture();
    const valid = candidateFor(built.request, built.evidencePackage);
    const repaired = structuredClone(valid);
    repaired.overview.summary = '修正引用后，LDL-C 仍高于报告参考上限，下一步整理病史。';
    repaired.systems[0]!.summary = '已核对的 LDL-C 结果高于参考上限。';
    repaired.actions[0]!.why = '修正引用后，单次结果仍不足以决定长期管理方向。';
    const wrong = structuredClone(valid);
    wrong.claims[0]!.evidenceIds = ['missing-evidence'];
    let calls = 0;
    const result = await new MemberAssessmentPipeline(service.store, {
      runStructuredTurn: async (input) => {
        calls += 1;
        if (calls === 1) return { threadId: 'p02', turnId: 'first', output: wrong };
        expect(input.prompt).toContain('REPAIR_REQUEST=');
        expect(input.prompt).toContain('node:action-review');
        expect(input.prompt).toContain('node:system:cardiovascular');
        expect(input.prompt).toContain('"overview"');
        expect(input.allowWebSearch).toBe(false);
        return { threadId: 'p03', turnId: 'second', output: repaired };
      }
    }, undefined, undefined, undefined, 'test-model', 'medium', '2026-09-22').process(personId);
    expect(result).toMatchObject({ status: 'published', callCount: 2 });
    expect(calls).toBe(2);
    const snapshot = service.store.listMemberAssessmentSnapshots(personId, true)[0]!;
    expect(snapshot.overview.summary).toBe(repaired.overview.summary);
    expect(snapshot.systems[0]!.summary).toBe(repaired.systems[0]!.summary);
    expect(snapshot.actions[0]!.why).toBe(repaired.actions[0]!.why);
    service.close();
  });

  it('P03 只放开有明确引用的依赖节点，重复行动键也能定位到两个具体行动', async () => {
    const { service, built } = await fixture();
    const candidate = candidateFor(built.request, built.evidencePackage);
    candidate.claims.push({ ...candidate.claims[0]!, id: 'claim:other', topicKey: 'other' });
    candidate.actions.push({ ...candidate.actions[0]!, id: 'action:duplicate', claimIds: ['claim:other'] });
    candidate.questions.push({ id: 'question:related', question: '待核对？', whyItMatters: '影响下一步。',
      relatedClaimIds: ['claim-ldl'], evidenceIds: candidate.claims[0]!.evidenceIds });
    expect(new Set(repairTargets(candidate, ['unknown_evidence:claim-ldl:missing']))).toEqual(new Set([
      'claim-ldl', 'action-review', 'question:related', 'overview', ...candidate.systems.map((system) => system.id)
    ]));
    expect(new Set(repairTargets(candidate, ['duplicate_action_key:lipid-risk-context']))).toEqual(new Set([
      'action-review', 'action:duplicate', 'overview', ...candidate.systems.map((system) => system.id)
    ]));
    service.close();
  });

  it('含冒号的节点 ID 仍能精确进入 P03，且不会误选同前缀节点', async () => {
    const { service, built } = await fixture();
    const candidate = candidateFor(built.request, built.evidencePackage);
    candidate.claims.push({ ...candidate.claims[0]!, id: 'claim:thyroid-nodule-2022', topicKey: 'thyroid' });
    candidate.claims.push({ ...candidate.claims[0]!, id: 'claim:thyroid', topicKey: 'other' });
    expect(repairTargets(candidate, [
      'documented_source_not_proven:claim:thyroid-nodule-2022',
      'unknown_evidence:claim:thyroid-nodule-2022:missing-evidence'
    ])).toEqual(['claim:thyroid-nodule-2022']);
    expect(repairTargets(candidate, ['unknown_evidence:system:metabolic:missing-evidence'])).toEqual([]);
    service.close();
  });

  it('P03 仍未修好一条主张时只隔离该主张，其余有依据内容继续发布', async () => {
    const { service, personId, built } = await fixture();
    const candidate = candidateFor(built.request, built.evidencePackage);
    candidate.claims.push({
      ...candidate.claims[0]!, id: 'claim:unverified', topicKey: 'unverified',
      text: '这条判断的来源引用有误。', evidenceIds: ['nonexistent-evidence']
    });
    candidate.overview.claimIds.push('claim:unverified');
    for (const system of candidate.systems) system.claimIds.push('claim:unverified');
    let calls = 0;
    const result = await new MemberAssessmentPipeline(service.store, {
      runStructuredTurn: async (input) => {
        calls += 1;
        if (calls === 2) expect(input.prompt).toContain('REPAIR_REQUEST=');
        return { threadId: `turn-${calls}`, turnId: `turn-${calls}`, output: candidate };
      }
    }, undefined, undefined, undefined, 'test-model', 'medium', '2026-09-22').process(personId);
    expect(result).toMatchObject({ status: 'published', callCount: 2 });
    const snapshot = service.store.listMemberAssessmentSnapshots(personId, true)[0]!;
    expect(snapshot.claims.map((item) => item.id)).toEqual(['claim-ldl']);
    expect(snapshot.heldTargetIds).toContain('claim:unverified');
    expect(snapshot.overview.claimIds).toEqual(['claim-ldl']);
    expect(snapshot.actions.map((item) => item.id)).toEqual(['action-review']);
    expect(snapshot.overview.summary).not.toContain('已核实');
    service.close();
  });

  it('P03 越界改写时不接纳改写，只隔离原候选中可定位的问题节点', async () => {
    const { service, personId, built } = await fixture();
    const candidate = candidateFor(built.request, built.evidencePackage);
    candidate.claims.push({ ...candidate.claims[0]!, id: 'claim-unverified', topicKey: 'unverified',
      evidenceIds: ['nonexistent-evidence'] });
    candidate.overview.claimIds.push('claim-unverified');
    for (const system of candidate.systems) system.claimIds.push('claim-unverified');
    let calls = 0;
    const result = await new MemberAssessmentPipeline(service.store, {
      runStructuredTurn: async () => {
        calls += 1;
        if (calls === 1) return { threadId: 'p02', turnId: 'first', output: candidate };
        const outOfScope = structuredClone(candidate);
        outOfScope.claims[0]!.text = '模型越界改写了原本正确的主张。';
        return { threadId: 'p03', turnId: 'second', output: outOfScope };
      }
    }, undefined, undefined, undefined, 'test-model', 'medium', '2026-09-22').process(personId);
    expect(result).toMatchObject({ status: 'published', callCount: 2 });
    const snapshot = service.store.listMemberAssessmentSnapshots(personId, true)[0]!;
    expect(snapshot.claims).toHaveLength(1);
    expect(snapshot.claims[0]!.text).toBe(candidate.claims[0]!.text);
    expect(snapshot.heldTargetIds).toContain('claim-unverified');
    service.close();
  });

  it('模型自称网址已核验也只能得到应用的 model_cited 状态', async () => {
    const { service, personId, built } = await fixture();
    const candidate = candidateFor(built.request, built.evidencePackage);
    candidate.knowledgeSources.push({ id: 'model-source', title: '模型声称已核验的来源',
      organization: '合成机构', url: 'https://example.org/medical', origin: 'retrieved',
      supports: '模型自称已经打开并核验网页正文' });
    candidate.claims[0]!.knowledgeBasis = 'retrieved';
    candidate.claims[0]!.knowledgeSourceIds = ['model-source'];
    const result = await new MemberAssessmentPipeline(service.store, {
      runStructuredTurn: async () => ({ threadId: 'p02', turnId: 'first', output: candidate })
    }, undefined, undefined, undefined, 'test-model', 'medium', '2026-09-22').process(personId);
    expect(result).toMatchObject({ status: 'published', callCount: 1 });
    const snapshot = service.store.listMemberAssessmentSnapshots(personId, true)[0]!;
    expect(snapshot.knowledgeVerifications).toEqual([{
      sourceId: 'model-source', status: 'model_cited', checkedAt: null,
      contentHash: null, toolReceiptId: null
    }]);
    expect(service.getMemberAssessment(personId)?.knowledgeVerifications[0]?.status).toBe('model_cited');
    service.close();
  });

  it('模型冒用受控知识 ID 时，标题、网址和支持范围仍以应用目录为准', async () => {
    const { service, built } = await fixture();
    const evidencePackage = structuredClone(built.evidencePackage);
    evidencePackage.knowledge.push({
      id: 'controlled-source', version: 'v1', title: '应用收录的指南', content: '合成受控正文',
      applicability: '合成适用范围', sourceOrganization: '受控机构',
      sourceUrl: 'https://official.example.org/guide', reviewedAt: '2026-09-01',
      supportedScope: '只支持一般说明'
    });
    const candidate = candidateFor(built.request, evidencePackage);
    candidate.knowledgeSources.push({
      id: 'controlled-source', title: '冒名来源', organization: '假机构',
      url: 'https://attacker.example.org/', origin: 'catalog', supports: '已核验可确诊'
    });
    const normalized = canonicalizeAssessmentKnowledge(candidate, evidencePackage);
    expect(normalized.knowledgeSources[0]).toEqual({
      id: 'controlled-source', title: '应用收录的指南', organization: '受控机构',
      url: 'https://official.example.org/guide', origin: 'catalog', supports: '只支持一般说明'
    });
    expect(buildAssessmentKnowledgeVerifications(normalized, evidencePackage)[0]).toMatchObject({
      sourceId: 'controlled-source', status: 'catalog_curated', checkedAt: '2026-09-01', toolReceiptId: null
    });
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

  it('治疗讨论也不能夹带让本人直接停药的指令，概率不能藏在总览', async () => {
    const { service, personId, built } = await fixture();
    const candidate = candidateFor(built.request, built.evidencePackage);
    candidate.actions[0] = { ...candidate.actions[0]!, kind: 'treatment_discussion', firstStep: '请现在停药。' };
    candidate.overview.summary = '你患癌症风险约 73%。';
    const result = validateAssessmentCandidate(candidate, {
      personId, inputSignature: built.request.inputSignature, mode: built.request.mode,
      requestedSystemIds: built.request.requestedSystemIds,
      evidenceCatalog: built.evidencePackage.evidenceCatalog,
      trendIds: built.evidencePackage.trends.map((item) => item.id),
      catalogKnowledgeIds: built.evidencePackage.knowledge.map((item) => item.id),
      criteriaSets: built.evidencePackage.criteriaSets
    });
    expect(result.issues).toContain('direct_medication_change:action-review');
    expect(result.issues).toContain('unsourced_probability:overview');
    service.close();
  });

  it('禁止自行加量的安全提醒不是让本人加量的指令', async () => {
    const { service, personId, built } = await fixture();
    const candidate = candidateFor(built.request, built.evidencePackage);
    candidate.actions[0] = { ...candidate.actions[0]!, caution: '若活动时胸痛，应停止自行加量并尽快就医评估。' };
    const result = validateAssessmentCandidate(candidate, {
      personId, inputSignature: built.request.inputSignature, mode: built.request.mode,
      requestedSystemIds: built.request.requestedSystemIds,
      evidenceCatalog: built.evidencePackage.evidenceCatalog,
      trendIds: built.evidencePackage.trends.map((item) => item.id),
      catalogKnowledgeIds: built.evidencePackage.knowledge.map((item) => item.id),
      criteriaSets: built.evidencePackage.criteriaSets
    });
    expect(result.issues).not.toContain('direct_medication_change:action-review');
    service.close();
  });

  it('药物变更门禁区分直接指令和否定式安全提醒', async () => {
    const { service, personId, built } = await fixture();
    const input = {
      personId, inputSignature: built.request.inputSignature, mode: built.request.mode,
      requestedSystemIds: built.request.requestedSystemIds,
      evidenceCatalog: built.evidencePackage.evidenceCatalog,
      trendIds: built.evidencePackage.trends.map((item) => item.id),
      catalogKnowledgeIds: built.evidencePackage.knowledge.map((item) => item.id),
      criteriaSets: built.evidencePackage.criteriaSets
    };
    for (const [field, wording, blocked] of [
      ['firstStep', '自行停药即可。', true],
      ['firstStep', '应立即加量。', true],
      ['firstStep', '请勿自行加量，应及时咨询医生。', false],
      ['firstStep', '请整理目前实际用药，以及是否漏服或自行停药，带给医生核对。', false],
      ['caution', '自行停药有风险，请咨询医生。', false]
    ] as const) {
      const candidate = candidateFor(built.request, built.evidencePackage);
      candidate.actions[0] = { ...candidate.actions[0]!, [field]: wording };
      const result = validateAssessmentCandidate(candidate, input);
      expect(result.issues.includes('direct_medication_change:action-review'), wording).toBe(blocked);
    }
    service.close();
  });

  it('明确报告诊断可为 documented；考虑和既往语句不能升级成当前确诊', async () => {
    const { service, personId, built } = await fixture();
    const evidenceId = built.evidencePackage.facts[0]!.evidenceIds[0]!;
    const candidate = candidateFor(built.request, built.evidencePackage);
    candidate.claims[0] = { ...candidate.claims[0]!, kind: 'diagnostic_assessment', diseaseName: '脂肪肝',
      diagnosticStatus: 'documented', text: '2024 年报告明确诊断为脂肪肝。', temporalStatus: 'historical' };
    const input = (quote: string) => ({
      personId, inputSignature: built.request.inputSignature, mode: built.request.mode,
      requestedSystemIds: built.request.requestedSystemIds,
      evidenceCatalog: built.evidencePackage.evidenceCatalog.map((item) => item.id === evidenceId ? { ...item, quote } : item),
      trendIds: [], catalogKnowledgeIds: [], criteriaSets: []
    });
    expect(validateAssessmentCandidate(candidate, input('2024-10-22 诊断：脂肪肝')).issues).not.toContain('documented_source_not_proven:claim-ldl');
    expect(validateAssessmentCandidate(candidate, input('2024-10-22 诊断：考虑脂肪肝')).issues).toContain('documented_source_not_proven:claim-ldl');
    expect(validateAssessmentCandidate(candidate, input('2024-10-22 诊断：排除脂肪肝')).issues).toContain('documented_source_not_proven:claim-ldl');
    expect(validateAssessmentCandidate(candidate, input('2024-10-22 既往诊断：脂肪肝')).issues).not.toContain('documented_source_not_proven:claim-ldl');
    expect(validateAssessmentCandidate(candidate, input('2024-10-22 病史记载既往诊断脂肪肝')).issues).not.toContain('documented_source_not_proven:claim-ldl');
    expect(validateAssessmentCandidate(candidate, input('2024-10-22 既往诊断疑似脂肪肝')).issues).toContain('documented_source_not_proven:claim-ldl');
    candidate.claims[0]!.temporalStatus = 'current';
    expect(validateAssessmentCandidate(candidate, input('2024-10-22 既往诊断：脂肪肝')).issues).toContain('documented_source_not_proven:claim-ldl');
    service.close();
  });

  it('符合标准必须逐项命中应用核验的证据，不能靠模型自报 met', async () => {
    const { service, personId, built } = await fixture();
    const firstEvidence = built.evidencePackage.facts[0]!.evidenceIds[0]!;
    const secondEvidence = 'evidence-independent-confirmation';
    const candidate = candidateFor(built.request, built.evidencePackage);
    candidate.claims[0] = { ...candidate.claims[0]!, kind: 'diagnostic_assessment', diseaseName: '合成疾病X',
      diagnosticStatus: 'criteria_met', text: '现有资料符合合成疾病X的标准。',
      knowledgeBasis: 'catalog', knowledgeSourceIds: ['controlled-criteria'], evidenceIds: [firstEvidence, secondEvidence],
      criteriaBasis: { criteriaSetId: 'synthetic-criteria', sourceId: 'controlled-criteria', applicability: '合成测试适用范围',
        requirements: [
          { criterionId: 'first-result', status: 'met', evidenceIds: [firstEvidence] },
          { criterionId: 'independent-confirmation', status: 'met', evidenceIds: [secondEvidence] }
        ] } };
    const base = {
      personId, inputSignature: built.request.inputSignature, mode: built.request.mode,
      requestedSystemIds: built.request.requestedSystemIds,
      evidenceCatalog: [...built.evidencePackage.evidenceCatalog, {
        ...built.evidencePackage.evidenceCatalog[0]!, id: secondEvidence, quote: '独立复测结果'
      }], trendIds: [], catalogKnowledgeIds: ['controlled-criteria']
    };
    const completeSet = { id: 'synthetic-criteria', sourceId: 'controlled-criteria', applicability: '合成测试适用范围',
      requiredCriterionIds: ['first-result', 'independent-confirmation'],
      verifiedRequirements: [
        { criterionId: 'first-result', evidenceIds: [firstEvidence] },
        { criterionId: 'independent-confirmation', evidenceIds: [secondEvidence] }
      ] };
    expect(validateAssessmentCandidate(candidate, { ...base, criteriaSets: [completeSet] }).issues).not.toContain('criteria_not_proven:claim-ldl');
    expect(validateAssessmentCandidate(candidate, { ...base, criteriaSets: [{
      ...completeSet, verifiedRequirements: completeSet.verifiedRequirements.slice(0, 1)
    }] }).issues).toContain('criteria_not_proven:claim-ldl');
    service.close();
  });

  it('P04 替换关联行动时引入紧急行动，不再次调用模型而隔离新风险', async () => {
    const { service, personId, built } = await fixture();
    const candidate = candidateFor(built.request, built.evidencePackage);
    candidate.claims[0]!.consequenceLevel = 'high';
    let calls = 0;
    const result = await new MemberAssessmentPipeline(service.store, {
      runStructuredTurn: async () => {
        calls += 1;
        if (calls === 1) return { threadId: 'p02', turnId: 'first', output: candidate };
        const targets = ['claim-ldl', 'action-review', 'overview', ...built.request.requestedSystemIds.map((id) => `system:${id}`)];
        const review: ClinicalFocusedReviewV1 = {
          schemaVersion: 1, personId, inputSignature: built.request.inputSignature,
          results: targets.map((targetId) => targetId === 'action-review'
            ? { targetId, verdict: 'replace', reason: '合成测试替换', replacement: {
              nodeType: 'action', value: { ...candidate.actions[0]!, urgency: 'emergency', title: '立即急诊就医' }
            } }
            : { targetId, verdict: 'pass', reason: '无需改动', replacement: null })
        };
        return { threadId: 'p04', turnId: 'second', output: review };
      }
    }, undefined, undefined, undefined, 'test-model', 'medium', '2026-09-22').process(personId);
    expect(result).toMatchObject({ status: 'published', callCount: 2 });
    expect(calls).toBe(2);
    const published = service.store.listMemberAssessmentSnapshots(personId, true)[0]!;
    expect(published.heldTargetIds).toContain('action-review');
    expect(published.actions).toEqual([]);
    expect(published.overview.actionIds).toEqual([]);
    service.close();
  });

  it('高影响主张被 hold 后，保留另一条可用解释但不残留原状态和问题', async () => {
    const { service, personId, built } = await fixture();
    const candidate = candidateFor(built.request, built.evidencePackage);
    candidate.claims[0]!.consequenceLevel = 'high';
    candidate.claims.push({ ...candidate.claims[0]!, id: 'claim-other', text: '原报告记载 LDL-C 4.2 mmol/L。', consequenceLevel: 'routine' });
    candidate.overview.claimIds.push('claim-other');
    for (const system of candidate.systems) system.claimIds.push('claim-other');
    candidate.questions.push({ id: 'question-dependent', question: '是否需要立即处理这个高风险？',
      whyItMatters: '与被隔离主张相关', relatedClaimIds: ['claim-ldl'],
      evidenceIds: [built.evidencePackage.facts[0]!.evidenceIds[0]!] });
    let calls = 0;
    const result = await new MemberAssessmentPipeline(service.store, {
      runStructuredTurn: async () => {
        calls += 1;
        if (calls === 1) return { threadId: 'p02', turnId: 'first', output: candidate };
        const targets = ['claim-ldl', 'action-review', 'overview', ...built.request.requestedSystemIds.map((id) => `system:${id}`)];
        const review: ClinicalFocusedReviewV1 = { schemaVersion: 1, personId, inputSignature: built.request.inputSignature,
          results: targets.map((targetId) => ({ targetId, verdict: targetId === 'claim-ldl' ? 'hold' : 'pass',
            reason: '合成测试中只隔离一条主张', replacement: null })) };
        return { threadId: 'p04', turnId: 'second', output: review };
      }
    }, undefined, undefined, undefined, 'test-model', 'medium', '2026-09-22').process(personId);
    expect(result).toMatchObject({ status: 'published', callCount: 2 });
    const published = service.store.listMemberAssessmentSnapshots(personId, true)[0]!;
    expect(published.claims.map((item) => item.id)).toEqual(['claim-other']);
    expect(published.systems.every((system) => system.status === 'monitor')).toBe(true);
    expect(published.questions).toEqual([]);
    expect(published.actions).toEqual([]);
    service.close();
  });

  it('两条高影响主张共享来源和行动时只做一次 P04，并覆盖共同依赖', async () => {
    const { service, personId, built } = await fixture();
    const candidate = candidateFor(built.request, built.evidencePackage);
    candidate.claims[0]!.consequenceLevel = 'high';
    candidate.claims.push({ ...candidate.claims[0]!, id: 'claim-second', text: '另一条待重点复核的高影响判断。' });
    candidate.overview.claimIds.push('claim-second');
    candidate.actions[0]!.claimIds.push('claim-second');
    for (const system of candidate.systems) system.claimIds.push('claim-second');
    let calls = 0;
    const result = await new MemberAssessmentPipeline(service.store, {
      runStructuredTurn: async (input) => {
        calls += 1;
        if (calls === 1) return { threadId: 'p02', turnId: 'first', output: candidate };
        expect(input.prompt).toContain('claim-ldl');
        expect(input.prompt).toContain('claim-second');
        const targets = ['claim-ldl', 'claim-second', 'action-review', 'overview',
          ...built.request.requestedSystemIds.map((id) => `system:${id}`)];
        const review: ClinicalFocusedReviewV1 = { schemaVersion: 1, personId, inputSignature: built.request.inputSignature,
          results: targets.map((targetId) => ({ targetId, verdict: 'pass', reason: '合成测试中已检查', replacement: null })) };
        return { threadId: 'p04', turnId: 'second', output: review };
      }
    }, undefined, undefined, undefined, 'test-model', 'medium', '2026-09-22').process(personId);
    expect(result).toMatchObject({ status: 'published', callCount: 2 });
    expect(calls).toBe(2);
    const published = service.store.listMemberAssessmentSnapshots(personId, true)[0]!;
    expect(published.reviewedTargetIds).toEqual(expect.arrayContaining(['claim-ldl', 'claim-second', 'action-review', 'overview']));
    service.close();
  });
});
