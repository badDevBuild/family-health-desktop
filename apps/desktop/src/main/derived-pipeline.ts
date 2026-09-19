import { z } from 'zod';
import {
  derivedSafetyReviewSchema,
  derivedSnapshotCandidateSchema,
  type DerivedSafetyReview,
  type DerivedSnapshotCandidate
} from '@contracts';
import type { AcceptedObservationSummary, JobExecutionGuard, WorkspaceStore } from '@storage';

interface StructuredRuntime {
  runStructuredTurn(input: {
    prompt: string;
    outputSchema: Record<string, unknown>;
    allowWebSearch?: boolean;
    timeoutMs?: number;
  }): Promise<{ threadId: string; turnId: string; output: unknown }>;
}

export type DerivedPipelineResult =
  | { status: 'published'; snapshotId: string; threadId: string; turnId: string }
  | { status: 'needs_review'; issueId: string; reason: string; threadId?: string; turnId?: string };

const candidateOutputSchema = z.toJSONSchema(derivedSnapshotCandidateSchema, { target: 'draft-7' }) as Record<string, unknown>;
const reviewOutputSchema = z.toJSONSchema(derivedSafetyReviewSchema, { target: 'draft-7' }) as Record<string, unknown>;
const prohibitedMedicalPattern = /(诊断为|患有|你有[^，。；]{0,12}(?:病|症)|必须服用|开始服用|停止服用|停药|加量|减量|换药|开药)/i;
const dosagePattern = /\d+(?:\.\d+)?\s*(?:mg|mcg|μg|iu|毫克|微克|国际单位)\b/i;

function containsProhibitedMedicalClaim(text: string): boolean {
  if (prohibitedMedicalPattern.test(text)) return true;
  const withoutNegatedDiagnosis = text.replace(
    /(?:不能|无法|不可|不足以|不作为|尚不能|尚无法|并非|不是|不等于)[^，。；]{0,12}确诊/g,
    ''
  );
  return /确诊/.test(withoutNegatedDiagnosis);
}

function buildFactPackage(
  personId: string,
  factRevision: number,
  observations: AcceptedObservationSummary[],
  context: ReturnType<WorkspaceStore['getDerivedContext']>
): string {
  return JSON.stringify({
    personId,
    factRevision,
    personContext: {
      birthYear: context.person.birthYear,
      genderContext: context.person.genderContext,
      clinicalContextRevision: context.person.clinicalContextRevision
    },
    userReportedNotes: context.notes.map((note) => ({
      noteId: note.id,
      kind: note.kind,
      text: note.immutableText,
      effectiveDate: note.effectiveDate,
      structuredFields: note.structuredFields
    })),
    observations: observations.map((observation) => ({
      observationId: observation.id,
      concept: observation.conceptKey,
      rawValue: observation.rawText,
      unit: observation.unit,
      referenceRange: observation.referenceRange,
      clinicalDate: observation.clinicalDate,
      reportedAbnormalFlag: observation.abnormalFlag,
      sourceQuote: observation.sourceQuote,
      specimen: observation.specimen,
      method: observation.method,
      bodySite: observation.bodySite
    }))
  });
}

function deterministicSafetyIssues(candidate: DerivedSnapshotCandidate, observations: AcceptedObservationSummary[]): string[] {
  const known = new Set(observations.map((observation) => observation.id));
  const issues: string[] = [];
  const allItems = [
    ...candidate.claims.map((claim) => ({ id: claim.id, text: `${claim.title}\n${claim.explanation}`, evidence: claim.evidenceObservationIds, boundaryRequired: claim.level === 'association' || claim.level === 'action', boundaryNote: claim.boundaryNote })),
    ...candidate.lifestyleGuidance.map((guidance) => ({ id: guidance.id, text: `${guidance.title}\n${guidance.detail}`, evidence: guidance.evidenceObservationIds, boundaryRequired: false, boundaryNote: null }))
  ];
  const ids = new Set<string>();
  for (const item of allItems) {
    if (ids.has(item.id)) issues.push(`duplicate_item_id:${item.id}`);
    ids.add(item.id);
    if (item.evidence.some((id) => !known.has(id))) issues.push(`evidence_mismatch:${item.id}`);
    if (item.boundaryRequired && !item.boundaryNote) issues.push(`boundary_note_required:${item.id}`);
    if (containsProhibitedMedicalClaim(item.text)) issues.push(`medical_boundary:${item.id}`);
    if (dosagePattern.test(item.text)) issues.push(`dosage_boundary:${item.id}`);
  }
  return issues;
}

function canRepairDerivedStructure(issues: string[]): boolean {
  return issues.length > 0 && issues.every((issue) => (
    issue.startsWith('evidence_mismatch:') || issue.startsWith('boundary_note_required:')
  ));
}

function reviewIssues(candidate: DerivedSnapshotCandidate, review: DerivedSafetyReview): string[] {
  const expectedClaims = new Set(candidate.claims.map((claim) => claim.id));
  const expectedGuidance = new Set(candidate.lifestyleGuidance.map((guidance) => guidance.id));
  const actualClaims = new Set(review.claimReviews.map((item) => item.claimId));
  const actualGuidance = new Set(review.guidanceReviews.map((item) => item.guidanceId));
  const issues: string[] = [];
  if (!review.overallSafe) issues.push('review_not_safe');
  if (actualClaims.size !== review.claimReviews.length || actualClaims.size !== expectedClaims.size || [...expectedClaims].some((id) => !actualClaims.has(id))) issues.push('claim_review_coverage');
  if (actualGuidance.size !== review.guidanceReviews.length || actualGuidance.size !== expectedGuidance.size || [...expectedGuidance].some((id) => !actualGuidance.has(id))) issues.push('guidance_review_coverage');
  for (const item of review.claimReviews) if (!item.supported || !item.safe) issues.push(`claim_rejected:${item.claimId}`);
  for (const item of review.guidanceReviews) if (!item.supported || !item.safe) issues.push(`guidance_rejected:${item.guidanceId}`);
  return issues;
}

function canOmitRejectedDerivedItems(issues: string[]): boolean {
  return issues.length > 0 && issues.every((issue) => (
    issue.startsWith('claim_rejected:') || issue.startsWith('guidance_rejected:')
  ));
}

function omitRejectedDerivedItems(
  candidate: DerivedSnapshotCandidate,
  review: DerivedSafetyReview
): DerivedSnapshotCandidate {
  const approvedClaimIds = new Set(review.claimReviews
    .filter((item) => item.supported && item.safe)
    .map((item) => item.claimId));
  const approvedGuidanceIds = new Set(review.guidanceReviews
    .filter((item) => item.supported && item.safe)
    .map((item) => item.guidanceId));
  return {
    ...candidate,
    claims: candidate.claims.filter((item) => approvedClaimIds.has(item.id)),
    lifestyleGuidance: candidate.lifestyleGuidance.filter((item) => approvedGuidanceIds.has(item.id))
  };
}

export class DerivedHealthPipeline {
  constructor(
    private readonly store: WorkspaceStore,
    private readonly runtime: StructuredRuntime,
    private readonly onStage?: (stage: 'analyze' | 'review_derived' | 'publish') => void,
    private readonly executionGuard?: JobExecutionGuard,
    private readonly transmissionDocumentId?: string,
    private readonly modelId = 'codex-account-default'
  ) {}

  private async runTurn(stage: string, input: Parameters<StructuredRuntime['runStructuredTurn']>[0]) {
    if (!this.executionGuard || !this.transmissionDocumentId) return this.runtime.runStructuredTurn(input);
    this.store.assertJobExecutionActive(this.executionGuard, this.transmissionDocumentId);
    const transmissionId = this.store.beginAiTransmission({
      guard: this.executionGuard,
      documentId: this.transmissionDocumentId,
      stage
    });
    try {
      const result = await this.runtime.runStructuredTurn(input);
      this.store.assertJobExecutionActive(this.executionGuard, this.transmissionDocumentId);
      this.store.finishAiTransmission(transmissionId, 'completed');
      return result;
    } catch (error) {
      this.store.finishAiTransmission(transmissionId, 'unknown');
      throw error;
    }
  }

  async process(personId: string): Promise<DerivedPipelineResult> {
    const observations = this.store.listAcceptedObservations(personId);
    if (observations.length === 0) throw new Error('DERIVED_FACTS_REQUIRED');
    const factRevision = this.store.getFactRevision(personId);
    const contextRevision = this.store.getClinicalContextRevision(personId);
    const factPackage = buildFactPackage(personId, factRevision, observations, this.store.getDerivedContext(personId));
    this.onStage?.('analyze');
    const generated = await this.runTurn('analyze', {
      prompt: [
        '你是家庭健康资料解释器。只能使用 FACT_PACKAGE 中已经接纳的报告事实和用户主动填写的背景；必须区分报告事实与 user_reported 内容。',
        '事实层可复述数值；趋势层只在日期、单位和可比条件足够时描述；关联层必须明确写“仅供参考”；行动层止步于“建议就此咨询医生”。',
        '不得诊断疾病，不得建议开始、停止或调整药物，不得给出药物或补充剂剂量，不得编造指南、研究、URL 或证据。',
        '如需核对通用医学背景，可以使用 Web Search；搜索词必须去标识化，不得包含姓名、完整日期、报告原文、内部 ID 或可唯一识别个人的组合信息。网页资料只能帮助解释通用概念，不能替代或修改 FACT_PACKAGE 中的报告事实。',
        '生活指南只能给低风险日常方向，必须引用 observationId；资料不足时宁可返回空数组。',
        `FACT_PACKAGE=${factPackage}`
      ].join('\n'),
      allowWebSearch: true,
      outputSchema: candidateOutputSchema
    });
    let candidate = derivedSnapshotCandidateSchema.parse(generated.output);
    if (candidate.personId !== personId || candidate.factRevision !== factRevision) throw new Error('DERIVED_SCOPE_MISMATCH');
    let localIssues = deterministicSafetyIssues(candidate, observations);
    if (canRepairDerivedStructure(localIssues)) {
      const repaired = await this.runTurn('repair_derived', {
        prompt: [
          '你是健康说明的结构修复器。只修复下列机器校验错误，并返回完整的 DERIVED_CANDIDATE；不得新增报告事实、诊断、处方、药物调整或剂量。',
          'evidence_mismatch：只能改用 FACT_PACKAGE 中真实存在且确实支持该说明的 observationId；没有充分依据的条目必须删除，不得猜测或编造 ID。',
          'boundary_note_required：association 与 action 层必须补充明确的边界说明，例如“仅供参考，不等于诊断”或“建议就此咨询医生”。',
          '保持 personId、factRevision 和 schemaVersion 不变。不得使用网页搜索；只能依据 FACT_PACKAGE 修复。',
          `VALIDATION_ERRORS=${JSON.stringify(localIssues)}`,
          `FACT_PACKAGE=${factPackage}`,
          `DERIVED_CANDIDATE=${JSON.stringify(candidate)}`
        ].join('\n'),
        allowWebSearch: false,
        outputSchema: candidateOutputSchema
      });
      candidate = derivedSnapshotCandidateSchema.parse(repaired.output);
      if (candidate.personId !== personId || candidate.factRevision !== factRevision) throw new Error('DERIVED_REPAIR_SCOPE_MISMATCH');
      localIssues = deterministicSafetyIssues(candidate, observations);
    }
    if (localIssues.length > 0) return this.needsReview(observations, localIssues.join(','), generated.threadId, generated.turnId);

    this.onStage?.('review_derived');
    const reviewed = await this.runTurn('review_derived', {
      prompt: [
        '你是独立的健康内容安全复核器。根据原始已接纳事实逐项检查候选内容是否有证据、是否越过医疗边界。',
        '任何诊断、处方、药物调整、补充剂剂量、伪造来源或无证据因果都必须标为不安全。',
        '必要时可用 Web Search 核对去标识化的通用医学背景；不得在搜索词中包含姓名、完整日期、报告原文、内部 ID 或可唯一识别个人的组合信息，也不得用网页内容改写报告事实。',
        '必须恰好覆盖候选中的每个 claimId 和 guidanceId，不得遗漏或新增。',
        `FACT_PACKAGE=${factPackage}`,
        `DERIVED_CANDIDATE=${JSON.stringify(candidate)}`
      ].join('\n'),
      allowWebSearch: true,
      outputSchema: reviewOutputSchema
    });
    const safetyReview = derivedSafetyReviewSchema.parse(reviewed.output);
    if (safetyReview.personId !== personId || safetyReview.factRevision !== factRevision) throw new Error('DERIVED_REVIEW_SCOPE_MISMATCH');
    const independentIssues = reviewIssues(candidate, safetyReview);
    if (canOmitRejectedDerivedItems(independentIssues)) {
      candidate = omitRejectedDerivedItems(candidate, safetyReview);
    } else if (independentIssues.length > 0) {
      return this.needsReview(observations, independentIssues.join(','), reviewed.threadId, reviewed.turnId);
    }

    this.onStage?.('publish');
    const published = this.store.publishDerivedSnapshot({
      candidate,
      expectedFactRevision: factRevision,
      expectedContextRevision: contextRevision,
      promptVersion: 'derived-v1',
      rulesVersion: 'derived-safety-v1',
      modelId: this.modelId,
      ...(this.executionGuard ? { executionGuard: this.executionGuard } : {})
    });
    return { status: 'published', snapshotId: published.snapshotId, threadId: reviewed.threadId, turnId: reviewed.turnId };
  }

  private needsReview(
    observations: AcceptedObservationSummary[],
    reason: string,
    threadId?: string,
    turnId?: string
  ): DerivedPipelineResult {
    const first = observations[0];
    if (!first) throw new Error('DERIVED_FACTS_REQUIRED');
    const issueId = this.store.saveExtractionReviewIssue({
      documentId: first.documentId,
      kind: 'derived_safety',
      severity: 'blocking',
      evidenceRefs: observations.map((observation) => observation.sourceSpanId),
      reasonCodes: reason.split(',').filter(Boolean),
      preserveDocumentStatus: true
    });
    return {
      status: 'needs_review', issueId, reason,
      ...(threadId ? { threadId } : {}),
      ...(turnId ? { turnId } : {})
    };
  }
}
