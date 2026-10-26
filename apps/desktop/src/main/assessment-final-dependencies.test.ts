import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type {
  AssessmentRepairRequestV1, ClinicalFocusedReviewV1, ExtractionResult,
  MemberAssessmentCandidateV3, MemberAssessmentRepairV1
} from '@contracts';
import { buildMemberAssessmentInput } from './member-assessment-input.js';
import { MemberAssessmentPipeline } from './member-assessment-pipeline.js';
import { findChangedHabitPremiseReviewIds } from './assessment-independent-habit-repair.js';
import { prepareFinalAggregateRecovery, finalAggregateReplacementPreserved } from './assessment-aggregate-recovery.js';
import { DocumentExtractionPipeline } from './processing-pipeline.js';
import { LegacyTextFixtureWorkspaceService } from './legacy-text-source.fixture.js';

const fixtures: Array<{ service: LegacyTextFixtureWorkspaceService; root: string }> = [];
afterEach(() => {
  for (const { service, root } of fixtures.splice(0)) {
    service.close();
    rmSync(root, { recursive: true, force: true });
  }
});

/** 全程使用新建临时库和合成文字；只替换模型回执，不连接真实模型或家庭资料。 */
async function fixture(extraSource = '') {
  const root = mkdtempSync(join(tmpdir(), 'family-health-final-dependencies-synthetic-'));
  const service = new LegacyTextFixtureWorkspaceService(root, '合成依赖工作区', () => new Date('2026-09-22T00:00:00Z'));
  fixtures.push({ service, root });
  const personId = service.ensurePrimaryMember({ displayName: '合成依赖成员', relation: '本人' });
  const quote = `2026-09-21 LDL-C 4.2 mmol/L，参考范围 0-3.4。${extraSource}`;
  await service.importFiles([{ path: join(root, '合成依赖报告.txt'), bytes: Buffer.from(quote) }], personId);
  const documentId = service.getSnapshot(null).inbox[0]!.id;
  const sourceSpanId = service.store.getDocumentExtractionBundle(documentId).manifest.spans[0]!.id;
  const extraction: ExtractionResult = { schemaVersion: 1, documentId, coveredSourceSpanIds: [sourceSpanId],
    subject: { reportedName: null, confidence: 'absent', evidence: [] }, candidates: [{
      localKey: 'synthetic-ldl', originalName: 'LDL-C', standardNameCandidate: 'LDL-C',
      value: { kind: 'numeric', rawText: '4.2', decimal: '4.2', comparator: 'eq' }, unitRaw: 'mmol/L',
      referenceRangeRaw: '0-3.4', reportedAbnormalFlag: 'high', specimen: null, method: null, bodySite: null,
      clinicalDate: '2026-09-21', evidence: [{ sourceSpanId, quote }],
      clinicalContext: { version: 1, status: 'complete', conditions: [] }, issues: []
    }] };
  expect(await new DocumentExtractionPipeline(service.store, { runStructuredTurn: async () => ({
    threadId: 'synthetic-extract', turnId: 'synthetic-extract', output: extraction
  }) }).process(documentId)).toMatchObject({ status: 'published' });
  const built = buildMemberAssessmentInput(service.store, personId, { modelId: 'synthetic-model', reasoningEffort: 'medium',
    analysisReferenceDate: '2026-09-22', webSearchAllowed: false });
  const systemIds = built.request.requestedSystemIds;
  const evidenceIds = built.evidencePackage.facts[0]!.evidenceIds;
  const claim: MemberAssessmentCandidateV3['claims'][number] = {
    id: 'claim:premise', topicKey: 'synthetic-premise', systemIds, kind: 'interpretation',
    text: '这份血脂结果需要结合背景理解。', diseaseName: null, diagnosticStatus: null, temporalStatus: 'historical',
    evidenceIds, counterEvidenceIds: [], trendIds: [], knowledgeBasis: 'model_general', knowledgeSourceIds: [],
    criteriaBasis: null, rationale: '原报告中能看到这一项结果。', materialUncertainty: null, consequenceLevel: 'high',
    changeAssessment: { direction: 'first_record', basis: 'insufficient',
      summary: '目前只有这项检查的一次结果，不能判断前后变化。', reason: '没有对应的历史结果可比。',
      currentEvidenceIds: evidenceIds, previousEvidenceIds: [] }
  };
  const retained = { ...claim, id: 'claim:retained', topicKey: 'synthetic-retained',
    text: '仍有效的合成检查记录。', consequenceLevel: 'routine' as const };
  const marker = '遗留行动前提：继续此前的专用饮食安排。';
  const candidate: MemberAssessmentCandidateV3 = { schemaVersion: 3, personId, inputSignature: built.request.inputSignature,
    mode: 'full', requestedSystemIds: systemIds,
    overview: { id: 'overview', headline: '合成健康摘要', summary: marker,
      claimIds: [retained.id], actionIds: ['action:premise'], limitations: [] },
    systems: systemIds.map((systemId) => ({ id: `system:${systemId}`, systemId, status: 'attention', headline: '合成系统摘要',
      summary: marker, claimIds: [retained.id], actionIds: ['action:premise'], limitations: [] })),
    claims: [claim, retained], actions: [{ id: 'action:premise', dedupeKey: 'synthetic-diet', systemIds,
      claimIds: [claim.id], kind: 'habit', lifestyleDomain: 'diet', lifestyleBasis: 'personalized', title: '合成饮食安排',
      why: '根据原有检查解读安排日常饮食。', firstStep: '记录三餐并减少油炸食品。', timing: null, timingBasis: 'none',
      reviewPlan: null, caution: null, urgency: 'routine', evidenceIds, knowledgeSourceIds: [] }], questions: [], knowledgeSources: [] };
  return { service, personId, candidate, marker };
}

function repairOutput(prompt: string, replacement?: MemberAssessmentCandidateV3['claims'][number]): MemberAssessmentRepairV1 {
  const request = JSON.parse(prompt.split('REPAIR_REQUEST=')[1]!.split('\nSOURCE_CONTEXT=')[0]!) as AssessmentRepairRequestV1;
  return { schemaVersion: 1, personId: request.personId, inputSignature: request.inputSignature,
    originalCandidateHash: request.originalCandidateHash,
    results: request.targets.map((targetId) => replacement?.id === targetId
      ? { targetId, verdict: 'replace' as const, reason: '修正合成文字。', replacement: { nodeType: 'claim' as const, value: replacement } }
      : { targetId, verdict: 'unchanged' as const, reason: '保留合成节点。', replacement: null }) };
}

function reviewOutput(prompt: string, replace: (node: ClinicalFocusedReviewV1['results'][number]['replacement']) =>
  ClinicalFocusedReviewV1['results'][number]['replacement']): ClinicalFocusedReviewV1 {
  const request = JSON.parse(prompt.split('REVIEW_REQUEST=')[1]!.split('\nSOURCE_CONTEXT=')[0]!) as {
    personId: string; inputSignature: string; targets: string[];
  };
  const targets = JSON.parse(prompt.split('TARGET_NODES=')[1]!) as Array<{ id: string; node: unknown }>;
  return { schemaVersion: 1, personId: request.personId, inputSignature: request.inputSignature,
    results: request.targets.map((targetId) => {
      const value = targets.find((item) => item.id === targetId)!.node as Record<string, unknown>;
      const nodeType = 'text' in value ? 'claim' : 'firstStep' in value ? 'action'
        : 'question' in value ? 'question' : 'systemId' in value ? 'system' : 'overview';
      const replacement = replace({ nodeType, value } as NonNullable<ClinicalFocusedReviewV1['results'][number]['replacement']>);
      return replacement ? { targetId, verdict: 'replace' as const, reason: '合成单次复核。', replacement }
        : { targetId, verdict: 'pass' as const, reason: '保留合成节点。', replacement: null };
    }) };
}

describe('先核对资料缺口，再基于最终内容形成总述', () => {
  it.each(['合成-B24法', '合成-23检测法'])('前置P03核对来源方法%s，P04看到完整纠正正文和仍未知的用药背景', async (method) => {
    const { service, personId, candidate } = await fixture(` 检查方法：${method}。`);
    const claim = candidate.claims[0]!;
    claim.text = '检查方法未提供，检测前用药情况未知。';
    let corrections = 0, sawReviewedCorrection = false;
    const result = await new MemberAssessmentPipeline(service.store, { runStructuredTurn: async ({ prompt }) => {
      let output: unknown;
      if (prompt.includes('ASSESSMENT_REQUEST=')) output = candidate;
      else if (prompt.includes('REPAIR_REQUEST=')) {
        const r = JSON.parse(prompt.split('REPAIR_REQUEST=')[1]!.split('\nSOURCE_CONTEXT=')[0]!) as AssessmentRepairRequestV1;
        if (r.issues.some((issue) => issue.startsWith('limitation_source_check_required:'))) {
          corrections += 1;
          expect(r.targetDetails.find((item) => item.targetId === claim.id)?.sourceQuotes?.[0]?.quote).toContain(method);
          output = repairOutput(prompt, { ...claim, text: `检查方法为${method}，检测前用药情况未知。` });
        } else output = repairOutput(prompt);
      } else output = reviewOutput(prompt, (node) => {
        if (node?.nodeType === 'claim' && node.value.id === claim.id) {
          expect(node.value.text).toBe(`检查方法为${method}，检测前用药情况未知。`);
          sawReviewedCorrection = true;
        }
        return null;
      });
      return { threadId: 'synthetic-method', turnId: 'synthetic-turn', output };
    } }, undefined, undefined, undefined, 'synthetic-model', 'medium', '2026-09-22', false).process(personId);
    expect(result.status).toBe('published');
    expect(corrections).toBe(1);
    expect(sawReviewedCorrection).toBe(true);
    expect(service.store.listMemberAssessmentSnapshots(personId, true)[0]!.claims.find((item) => item.id === claim.id)?.text)
      .toBe(`检查方法为${method}，检测前用药情况未知。`);
  });

  it.each(['pass', 'hold', 'wrong_member', 'wrong_input', 'missing_receipt', 'duplicate_receipt',
    'timeout', 'replace', 'new_number', 'restore_held'] as const)(
    '最后一次摘要重建严格绑定最终前提和真实复核：%s', async (mode) => {
      const { service, personId, candidate } = await fixture();
      candidate.actions = [];
      candidate.claims.push({ ...candidate.claims[1]!, id: 'claim:other-retained', topicKey: 'synthetic-other-retained',
        text: '另一项合成检查记录。' });
      candidate.overview = { ...candidate.overview, claimIds: candidate.claims.map((claim) => claim.id), actionIds: [] };
      candidate.systems.forEach((node) => { node.claimIds = [...candidate.overview.claimIds]; node.actionIds = []; });
      const originalFacts = service.store.listAcceptedObservations(personId);
      let repairCount = 0, finalReviewCount = 0, calls = 0;
      const result = await new MemberAssessmentPipeline(service.store, { runStructuredTurn: async ({ prompt }) => {
        calls += 1;
        let output: unknown;
        if (prompt.includes('ASSESSMENT_REQUEST=')) output = candidate;
        else if (prompt.includes('REPAIR_REQUEST=')) {
          const request = JSON.parse(prompt.split('REPAIR_REQUEST=')[1]!.split('\nSOURCE_CONTEXT=')[0]!) as AssessmentRepairRequestV1;
          if (!request.issues.some((issue) => issue.startsWith('final_aggregate_summary_required:'))) output = repairOutput(prompt);
          else {
            repairCount += 1;
            const items = JSON.parse(prompt.split('TARGET_NODES=')[1]!) as Array<{ targetId: string } & NonNullable<ClinicalFocusedReviewV1['results'][number]['replacement']>>;
            output = { schemaVersion: 1, personId, inputSignature: request.inputSignature, originalCandidateHash: request.originalCandidateHash,
              results: request.targets.map((targetId) => {
                const item = items.find((node) => node.targetId === targetId)!;
                return { targetId, verdict: 'replace', reason: '只概括保留的检查说明。', replacement: { nodeType: item.nodeType,
                  value: { ...item.value, headline: '已有检查的整体说明',
                    summary: mode === 'new_number' ? '合成值为999，需要结合背景理解。' : '仍有效的合成检查记录。',
                    claimIds: mode === 'restore_held' ? ['claim:premise'] : ['claim:retained'], actionIds: [] } } };
              }) };
          }
        } else {
          const final = prompt.includes('"recoveryMode":"final_aggregate_summary"');
          if (final) finalReviewCount += 1;
          if (final && mode === 'timeout') throw new Error('CODEX_TURN_TIMEOUT');
          const review = reviewOutput(prompt, () => null);
          for (const r of review.results) {
            if (!final && r.targetId === 'claim:premise' || final && mode === 'hold') r.verdict = 'hold';
            if (final && mode === 'replace') { r.verdict = 'replace'; r.replacement = { nodeType: 'overview', value: candidate.overview }; }
          }
          if (final && mode === 'wrong_member') review.personId = 'another-synthetic-member';
          if (final && mode === 'wrong_input') review.inputSignature = 'f'.repeat(64);
          if (final && mode === 'missing_receipt') review.results.pop();
          if (final && mode === 'duplicate_receipt') review.results.push(structuredClone(review.results[0]!));
          output = review;
        }
        return { threadId: 'synthetic-summary', turnId: `synthetic-turn-${calls}`, output };
      } }, undefined, undefined, undefined, 'synthetic-model', 'medium', '2026-09-22', false).process(personId);
      expect(result.status, JSON.stringify(result)).toBe('published');
      expect(repairCount).toBe(1);
      expect(finalReviewCount).toBe(['new_number', 'restore_held'].includes(mode) ? 0 : 1);
      const published = service.store.listMemberAssessmentSnapshots(personId, true)[0]!;
      expect(published.heldTargetIds).toContain('claim:premise');
      expect(published.claims.map((claim) => claim.id)).toEqual(['claim:retained', 'claim:other-retained']);
      expect(published.overview.headline === '已有检查的整体说明').toBe(mode === 'pass');
      expect(published.presentation?.rebuiltNodeIds.includes('overview') ?? false).toBe(mode !== 'pass');
      expect(service.store.listAcceptedObservations(personId)).toEqual(originalFacts);
    });

  it('摘要重建不能变更叶子、条件或加入原总述范围外的常规项目', async () => {
    const { service, personId, candidate } = await fixture();
    const original = structuredClone(candidate);
    original.overview.claimIds = ['claim:premise', 'claim:retained']; original.overview.actionIds = [];
    candidate.claims.push({ ...candidate.claims[1]!, id: 'claim:outside', topicKey: 'synthetic-outside' });
    candidate.overview.claimIds = candidate.claims.map((claim) => claim.id);
    const recovery = prepareFinalAggregateRecovery(candidate, original, ['overview']);
    expect(recovery.baseline.overview.claimIds).toEqual(['claim:premise', 'claim:retained']);
    const built = buildMemberAssessmentInput(service.store, personId, { modelId: 'synthetic-model', reasoningEffort: 'medium',
      analysisReferenceDate: '2026-09-22', webSearchAllowed: false });
    const changed = structuredClone(recovery.baseline);
    changed.claims[0]!.text = '被改写的合成主张。';
    expect(finalAggregateReplacementPreserved(recovery, changed, 'overview', built.evidencePackage.evidenceCatalog, '2026-09-22')).toBe(false);
    const removedLimit = structuredClone(recovery.baseline);
    recovery.baseline.overview.limitations = ['缺少后续记录。'];
    expect(finalAggregateReplacementPreserved(recovery, removedLimit, 'overview', built.evidencePackage.evidenceCatalog, '2026-09-22')).toBe(false);
  });

  it.each(['CODEX_AUTH_REQUIRED', 'CODEX_TURN_OUTCOME_UNKNOWN', 'JOB_EXECUTION_CANCELLED'])(
    '最终摘要阶段遇到 %s 仍停止发布，不能借可选修复吞掉执行边界', async (errorCode) => {
      const { service, personId, candidate } = await fixture();
      candidate.actions = [];
      candidate.claims.push({ ...candidate.claims[1]!, id: 'claim:other-retained', topicKey: 'synthetic-other-retained' });
      candidate.overview.claimIds = candidate.claims.map((claim) => claim.id);
      candidate.overview.actionIds = [];
      candidate.systems.forEach((system) => { system.claimIds = [...candidate.overview.claimIds]; system.actionIds = []; });
      let calls = 0;
      const pipeline = new MemberAssessmentPipeline(service.store, { runStructuredTurn: async ({ prompt }) => {
        calls += 1;
        if (prompt.includes('final_aggregate_summary_required:')) throw new Error(errorCode);
        const output = prompt.includes('ASSESSMENT_REQUEST=') ? candidate : reviewOutput(prompt, () => null);
        if ('results' in output) output.results.find((item) => item.targetId === 'claim:premise')!.verdict = 'hold';
        return { threadId: 'synthetic-execution-boundary', turnId: `synthetic-turn-${calls}`, output };
      } }, undefined, undefined, undefined, 'synthetic-model', 'medium', '2026-09-22', false);
      await expect(pipeline.process(personId)).rejects.toThrow(errorCode);
      expect(service.store.listMemberAssessmentSnapshots(personId, true)).toEqual([]);
      expect(service.store.listAcceptedObservations(personId)).toHaveLength(1);
    });
});

describe('最终依赖必须回看实际P04输入图', () => {
  it.each([
    '现有资料未提供肺栓塞的诊断记录。',
    '不能单独诊断肺栓塞。',
    '这不是肺栓塞的诊断。',
    '不能仅凭本次血液检查的正常结果诊断肺栓塞。'
  ])('诊断范围说明经正式综合流程保留，关联建议不被误隔离且不改提取事实：%s', async (statement) => {
    const { service, personId, candidate } = await fixture();
    candidate.claims[0]!.text = statement;
    candidate.overview.summary = statement;
    candidate.overview.claimIds = candidate.claims.map((claim) => claim.id);
    for (const system of candidate.systems) {
      system.summary = statement;
      system.claimIds = [...candidate.overview.claimIds];
    }
    const factsBefore = service.store.listAcceptedObservations(personId);
    let repairs = 0;
    let calls = 0;
    const result = await new MemberAssessmentPipeline(service.store, { runStructuredTurn: async ({ prompt }) => {
      calls += 1;
      let output: unknown;
      if (prompt.includes('ASSESSMENT_REQUEST=')) output = candidate;
      else if (prompt.includes('REVIEW_REQUEST=')) output = reviewOutput(prompt, () => null);
      else { repairs += 1; output = repairOutput(prompt); }
      return { threadId: 'synthetic-missing-diagnosis', turnId: String(calls), output };
    } }, undefined, undefined, undefined, 'synthetic-model', 'medium', '2026-09-22', false).process(personId);
    expect(result).toMatchObject({ status: 'published' });
    // “未提供”交给一次来源核对，unchanged 不隔离合法的诊断范围说明。
    expect(repairs).toBe(statement.includes('未提供') ? 1 : 0);
    const published = service.store.listMemberAssessmentSnapshots(personId, true)[0]!;
    expect(published.claims).toEqual(candidate.claims);
    expect(published.actions).toEqual(candidate.actions);
    expect(published.heldTargetIds).not.toContain('claim:premise');
    expect(published.heldTargetIds).not.toContain('action:premise');
    expect(published.overview.summary).toBe(statement);
    expect(published.systems.every((system) => system.summary === statement)).toBe(true);
    expect(service.store.listAcceptedObservations(personId)).toEqual(factsBefore);
  });

  it('仅收窄检验背景时保留历史剂型与否定说明，不连带隔离独立补充剂建议', async () => {
    const { service, personId, candidate } = await fixture();
    const before = '标本中的单项合成营养结果偏低不等于整体缺乏，历史使用营养注射液不代表现在需要额外补充。';
    const after = '单项合成营养结果偏低不等于整体缺乏，历史使用营养注射液不代表现在需要额外补充。';
    const claim = candidate.claims[0]!;
    claim.text = before;
    claim.rationale = '单项记录不能概括整体营养情况。';
    candidate.overview.summary = '结合已有检查记录了解日常营养情况。';
    candidate.overview.claimIds = candidate.claims.map((item) => item.id);
    for (const system of candidate.systems) {
      system.summary = candidate.overview.summary;
      system.claimIds = [...candidate.overview.claimIds];
    }
    Object.assign(candidate.actions[0]!, { lifestyleDomain: 'supplements', title: '合成日常补充建议',
      why: '结合已有检查安排日常照顾。', firstStep: '记录饮食和当前补充品，不要自行加量。' });
    const factsBefore = service.store.listAcceptedObservations(personId);
    const repairIssues: string[][] = [];
    let calls = 0;
    const result = await new MemberAssessmentPipeline(service.store, { runStructuredTurn: async ({ prompt }) => {
      calls += 1;
      let output: unknown;
      if (prompt.includes('ASSESSMENT_REQUEST=')) output = candidate;
      else if (prompt.includes('REVIEW_REQUEST=')) output = reviewOutput(prompt, (node) =>
        node?.nodeType === 'claim' && node.value.id === claim.id
          ? { ...node, value: { ...node.value, text: after } } : null);
      else {
        const request = JSON.parse(prompt.split('REPAIR_REQUEST=')[1]!.split('\nSOURCE_CONTEXT=')[0]!) as AssessmentRepairRequestV1;
        repairIssues.push(request.issues);
        output = repairOutput(prompt);
      }
      return { threadId: 'synthetic-dosage-form-background', turnId: String(calls), output };
    } }, undefined, undefined, undefined, 'synthetic-model', 'medium', '2026-09-22', false).process(personId);
    expect(result).toMatchObject({ status: 'published' });
    expect(repairIssues).toEqual([['limitation_source_check_required:claim:premise']]);
    const published = service.store.listMemberAssessmentSnapshots(personId, true)[0]!;
    expect(published.claims.find((item) => item.id === claim.id)?.text).toBe(after);
    expect(published.actions).toEqual(candidate.actions);
    expect(published.heldTargetIds).not.toContain(claim.id);
    expect(published.heldTargetIds).not.toContain('action:premise');
    expect(service.store.listAcceptedObservations(personId)).toEqual(factsBefore);
  });

  it('后置P03越界主张被隔离后，遗留汇总限制只隔离该汇总，最终摘要机会不丢独立结果', async () => {
    const { service, personId, candidate } = await fixture();
    candidate.actions = [];
    Object.assign(candidate.claims[0]!, { kind: 'diagnostic_assessment', diseaseName: '心肌梗死',
      diagnosticStatus: 'possible', text: '可能心肌梗死。' });
    candidate.claims[1]!.materialUncertainty = '保留本次检查条件限制。';
    candidate.overview.claimIds = candidate.claims.map((claim) => claim.id);
    candidate.overview.actionIds = [];
    candidate.overview.limitations = ['尚不能排除心肌梗死。'];
    for (const node of candidate.systems) {
      node.claimIds = [...candidate.overview.claimIds];
      node.actionIds = [];
      node.limitations = ['尚不能排除心肌梗死。'];
    }
    let calls = 0;
    const result = await new MemberAssessmentPipeline(service.store, { runStructuredTurn: async ({ prompt }) => {
      calls += 1;
      const output = prompt.includes('ASSESSMENT_REQUEST=') ? candidate
        : prompt.includes('REVIEW_REQUEST=') ? reviewOutput(prompt, (node) =>
          node?.nodeType === 'claim' && node.value.id === 'claim:premise'
            ? { ...node, value: { ...node.value, rationale: '经模型复核，报告有对应结果。' } } : null)
          : repairOutput(prompt, { ...candidate.claims[0]!, text: '可能心肌梗死，指标为7。' });
      return { threadId: 'synthetic-late-aggregate', turnId: String(calls), output };
    } }, undefined, undefined, undefined, 'synthetic-model', 'medium', '2026-09-22', false).process(personId);
    expect(result).toMatchObject({ status: 'published', callCount: 3 });
    const snapshot = service.store.listMemberAssessmentSnapshots(personId, true)[0]!;
    expect(snapshot.claims).toEqual([candidate.claims[1]]);
    expect(snapshot.overview.summary).toContain('保留本次检查条件限制');
    expect(snapshot.overview.summary).not.toContain('心肌梗死');
    expect(snapshot.reviewAuditRecords?.records.some((record) => record.targetId === 'overview'
      && record.localReasonCodes.includes('final_local_validation_isolated'))).toBe(true);
  });

  it.each(['unchanged', 'action_changed', 'wrong_person', 'wrong_input', 'missing_claim', 'duplicate_claim',
    'missing_source', 'explicit_hold', 'doctor_plan', 'dose'] as const)(
  '最终日常前提复核不接纳 %s 范围', async (mutation) => {
    const { service, personId, candidate } = await fixture();
    const built = buildMemberAssessmentInput(service.store, personId, { modelId: 'synthetic-model', reasoningEffort: 'medium',
      analysisReferenceDate: '2026-09-22', webSearchAllowed: false });
    const original = structuredClone(candidate);
    if (mutation === 'doctor_plan') candidate.actions[0]!.sourceInstructionObservationId = original.actions[0]!.sourceInstructionObservationId = 'synthetic-doctor-plan';
    if (mutation === 'dose') candidate.actions[0]!.firstStep = original.actions[0]!.firstStep = '每日服用合成补充剂 800 IU。';
    if (mutation !== 'unchanged') candidate.claims[0]!.rationale = '当前存活前提的解释已修正。';
    if (mutation === 'action_changed') candidate.actions[0]!.firstStep = '增加新的饮食安排。';
    if (mutation === 'wrong_person') candidate.personId = 'synthetic-other';
    if (mutation === 'wrong_input') candidate.inputSignature = '8'.repeat(64);
    if (mutation === 'missing_claim') candidate.claims.shift();
    if (mutation === 'duplicate_claim') candidate.claims.push(structuredClone(candidate.claims[0]!));
    expect(findChangedHabitPremiseReviewIds(original, candidate, mutation === 'explicit_hold' ? [] : ['action:premise'],
      mutation === 'missing_source' ? [] : built.evidencePackage.evidenceCatalog)).toEqual([]);
  });

  it.each(['pass', 'hold', 'missing', 'wrong_input', 'replace'] as const)(
  '后置P03改变存活前提时，一次最终复核 %s 决定未改写日常行动的发布', async (verdict) => {
    const { service, personId, candidate, marker } = await fixture();
    const factsBefore = service.store.listAcceptedObservations(personId);
    let calls = 0;
    const result = await new MemberAssessmentPipeline(service.store, { runStructuredTurn: async ({ prompt }) => {
      calls += 1;
      let output: unknown;
      if (prompt.includes('ASSESSMENT_REQUEST=')) output = candidate;
      else if (prompt.includes('"recoveryMode":"final_habit_premises"')) {
        const fresh = reviewOutput(prompt, () => null);
        if (verdict === 'hold') fresh.results.forEach((item) => { item.verdict = 'hold'; });
        if (verdict === 'missing') fresh.results = [];
        if (verdict === 'wrong_input') fresh.inputSignature = '9'.repeat(64);
        if (verdict === 'replace') fresh.results.forEach((item) => {
          item.verdict = 'replace'; item.replacement = { nodeType: 'action', value: candidate.actions[0]! };
        });
        output = fresh;
      }
      else if (prompt.includes('REVIEW_REQUEST=')) output = reviewOutput(prompt, (node) => {
        if (node?.nodeType === 'claim' && node.value.id === 'claim:premise') return {
          ...node, value: { ...node.value, rationale: '经模型复核，报告有对应结果。' }
        };
        if (node?.nodeType === 'overview') return { nodeType: 'overview', value: { ...node.value, actionIds: [] } };
        if (node?.nodeType === 'system') return { nodeType: 'system', value: { ...node.value, actionIds: [] } };
        return null;
      });
      else if (prompt.includes('final_aggregate_summary_required:')) output = repairOutput(prompt);
      else {
        expect(prompt).toContain('process_narrative:claim:premise:rationale');
        output = repairOutput(prompt, { ...candidate.claims[0]!, rationale: '这一份报告同时提供结果和参考范围。' });
      }
      return { threadId: 'synthetic-final-dependency', turnId: String(calls), output };
    } }, undefined, undefined, undefined, 'synthetic-model', 'medium', '2026-09-22', false).process(personId);
    expect(result).toMatchObject({ status: 'published', callCount: 4 });
    expect(result).toHaveProperty('focusedReviewDiagnostics', expect.arrayContaining([
      expect.objectContaining({ targetId: 'action:premise', reviewOrigin: 'model', outcome: verdict === 'pass' ? 'retained' : 'held' })
    ]));
    expect(JSON.stringify('focusedReviewDiagnostics' in result ? result.focusedReviewDiagnostics : [])).not.toContain(marker);
    const published = service.store.listMemberAssessmentSnapshots(personId, true)[0]!;
    expect(published.claims.map((claim) => claim.id)).toContain('claim:premise');
    if (verdict === 'pass') {
      expect(published.heldTargetIds).not.toContain('action:premise');
      expect(published.actions).toEqual(candidate.actions);
    } else {
      expect(published.heldTargetIds).toContain('action:premise');
      expect(published.actions).toEqual([]);
      expect(published.overview.summary).not.toContain(marker);
      expect(published.systems.every((node) => !node.summary.includes(marker))).toBe(true);
      expect(published.overview.summary).toContain('这份血脂结果需要结合背景理解');
    }
    expect(service.store.listAcceptedObservations(personId)).toEqual(factsBefore);
  });

  it('前置P03曾重建摘要不构成豁免，P04删边后的旧正文仍随随后失效的主张撤下', async () => {
    const { service, personId, candidate } = await fixture();
    const marker = '遗留待隔离前提';
    candidate.actions = [];
    candidate.claims[0]!.text = `${marker}：这次结果需要结合背景理解。`;
    candidate.claims.push({ ...candidate.claims[1]!, id: 'claim:invalid-before-review', topicKey: 'synthetic-invalid', evidenceIds: ['missing-source'] });
    candidate.overview.claimIds = candidate.claims.map((claim) => claim.id);
    candidate.overview.actionIds = [];
    for (const node of candidate.systems) { node.claimIds = [...candidate.overview.claimIds]; node.actionIds = []; }
    let calls = 0;
    let sawRebuiltAggregate = false;
    const result = await new MemberAssessmentPipeline(service.store, { runStructuredTurn: async ({ prompt }) => {
      calls += 1;
      let output: unknown;
      if (prompt.includes('ASSESSMENT_REQUEST=')) output = candidate;
      else if (prompt.includes('REPAIR_REQUEST=')) {
        if (!prompt.includes('final_aggregate_summary_required:')) {
          expect(prompt).toContain('unknown_evidence:claim:invalid-before-review:missing-source');
        }
        output = repairOutput(prompt);
      } else output = reviewOutput(prompt, (node) => {
        if (node?.nodeType === 'claim' && node.value.id === 'claim:premise') return { ...node, value: { ...node.value,
          kind: 'diagnostic_assessment', diseaseName: '合成新增病名', diagnosticStatus: 'possible', text: '需要考虑合成新增病名。' } };
        if (node?.nodeType === 'overview' || node?.nodeType === 'system') {
          expect(node.value.summary).toContain(marker);
          if (node.nodeType === 'system') expect(node.value.status).toBe('insufficient');
          sawRebuiltAggregate = true;
          if (node.nodeType === 'overview') return { nodeType: 'overview', value: { ...node.value, claimIds: ['claim:retained'] } };
          return { nodeType: 'system', value: { ...node.value, claimIds: ['claim:retained'] } };
        }
        return null;
      });
      return { threadId: 'synthetic-historical-rebuild', turnId: String(calls), output };
    } }, undefined, undefined, undefined, 'synthetic-model', 'medium', '2026-09-22', false).process(personId);
    expect(sawRebuiltAggregate).toBe(true);
    expect(result).toMatchObject({ status: 'published', callCount: 3 });
    const published = service.store.listMemberAssessmentSnapshots(personId, true)[0]!;
    expect(published.heldTargetIds).toEqual(expect.arrayContaining(['claim:invalid-before-review', 'claim:premise']));
    expect(published.claims.map((claim) => claim.id)).toEqual(['claim:retained']);
    expect(published.overview.summary).not.toContain(marker);
    expect(published.systems.every((node) => !node.summary.includes(marker))).toBe(true);
    expect(published.overview.summary).toContain('仍有效的合成检查记录');
  });
});
