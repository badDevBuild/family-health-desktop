import { z } from 'zod';
import {
  derivedSafetyReviewSchema,
  derivedSnapshotCandidateSchema,
  type DerivedSafetyReview,
  type DerivedSnapshotCandidate
} from '@contracts';
import type { AcceptedObservationSummary, WorkspaceStore } from '@storage';

interface StructuredRuntime {
  runStructuredTurn(input: {
    prompt: string;
    outputSchema: Record<string, unknown>;
    timeoutMs?: number;
  }): Promise<{ threadId: string; turnId: string; output: unknown }>;
}

export type DerivedPipelineResult =
  | { status: 'published'; snapshotId: string; threadId: string; turnId: string }
  | { status: 'needs_review'; issueId: string; reason: string; threadId?: string; turnId?: string };

const candidateOutputSchema = z.toJSONSchema(derivedSnapshotCandidateSchema, { target: 'draft-7' }) as Record<string, unknown>;
const reviewOutputSchema = z.toJSONSchema(derivedSafetyReviewSchema, { target: 'draft-7' }) as Record<string, unknown>;
const prohibitedMedicalPattern = /(确诊|诊断为|患有|你有[^，。；]{0,12}(?:病|症)|必须服用|开始服用|停止服用|停药|加量|减量|换药|开药|处方)/i;
const dosagePattern = /\d+(?:\.\d+)?\s*(?:mg|mcg|μg|iu|毫克|微克|国际单位)\b/i;

function buildFactPackage(personId: string, factRevision: number, observations: AcceptedObservationSummary[]): string {
  return JSON.stringify({
    personId,
    factRevision,
    observations: observations.map((observation) => ({
      observationId: observation.id,
      concept: observation.conceptKey,
      rawValue: observation.rawText,
      unit: observation.unit,
      referenceRange: observation.referenceRange,
      clinicalDate: observation.clinicalDate,
      reportedAbnormalFlag: observation.abnormalFlag,
      sourceQuote: observation.sourceQuote
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
    if (prohibitedMedicalPattern.test(item.text)) issues.push(`medical_boundary:${item.id}`);
    if (dosagePattern.test(item.text)) issues.push(`dosage_boundary:${item.id}`);
  }
  return issues;
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

export class DerivedHealthPipeline {
  constructor(
    private readonly store: WorkspaceStore,
    private readonly runtime: StructuredRuntime,
    private readonly onStage?: (stage: 'analyze' | 'review_derived' | 'publish') => void
  ) {}

  async process(personId: string): Promise<DerivedPipelineResult> {
    const observations = this.store.listAcceptedObservations(personId);
    if (observations.length === 0) throw new Error('DERIVED_FACTS_REQUIRED');
    const factRevision = this.store.getFactRevision(personId);
    const contextRevision = this.store.getClinicalContextRevision(personId);
    const factPackage = buildFactPackage(personId, factRevision, observations);
    this.onStage?.('analyze');
    const generated = await this.runtime.runStructuredTurn({
      prompt: [
        '你是家庭健康资料解释器。只能使用 FACT_PACKAGE 中已经接纳的报告事实。',
        '事实层可复述数值；趋势层只在日期、单位和可比条件足够时描述；关联层必须明确写“仅供参考”；行动层止步于“建议就此咨询医生”。',
        '不得诊断疾病，不得建议开始、停止或调整药物，不得给出药物或补充剂剂量，不得编造指南、研究、URL 或证据。',
        '生活指南只能给低风险日常方向，必须引用 observationId；资料不足时宁可返回空数组。',
        `FACT_PACKAGE=${factPackage}`
      ].join('\n'),
      outputSchema: candidateOutputSchema
    });
    const candidate = derivedSnapshotCandidateSchema.parse(generated.output);
    if (candidate.personId !== personId || candidate.factRevision !== factRevision) throw new Error('DERIVED_SCOPE_MISMATCH');
    const localIssues = deterministicSafetyIssues(candidate, observations);
    if (localIssues.length > 0) return this.needsReview(observations, localIssues.join(','), generated.threadId, generated.turnId);

    this.onStage?.('review_derived');
    const reviewed = await this.runtime.runStructuredTurn({
      prompt: [
        '你是独立的健康内容安全复核器。根据原始已接纳事实逐项检查候选内容是否有证据、是否越过医疗边界。',
        '任何诊断、处方、药物调整、补充剂剂量、伪造来源或无证据因果都必须标为不安全。',
        '必须恰好覆盖候选中的每个 claimId 和 guidanceId，不得遗漏或新增。',
        `FACT_PACKAGE=${factPackage}`,
        `DERIVED_CANDIDATE=${JSON.stringify(candidate)}`
      ].join('\n'),
      outputSchema: reviewOutputSchema
    });
    const safetyReview = derivedSafetyReviewSchema.parse(reviewed.output);
    if (safetyReview.personId !== personId || safetyReview.factRevision !== factRevision) throw new Error('DERIVED_REVIEW_SCOPE_MISMATCH');
    const independentIssues = reviewIssues(candidate, safetyReview);
    if (independentIssues.length > 0) return this.needsReview(observations, independentIssues.join(','), reviewed.threadId, reviewed.turnId);

    this.onStage?.('publish');
    const published = this.store.publishDerivedSnapshot({
      candidate,
      expectedFactRevision: factRevision,
      expectedContextRevision: contextRevision,
      promptVersion: 'derived-v1',
      rulesVersion: 'derived-safety-v1',
      modelId: 'codex-account-default'
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
      preserveDocumentStatus: true
    });
    return {
      status: 'needs_review', issueId, reason,
      ...(threadId ? { threadId } : {}),
      ...(turnId ? { turnId } : {})
    };
  }
}
