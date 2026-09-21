import { z } from 'zod';
import {
  systemAnalysisCandidateSchema,
  systemAnalysisReviewSchema,
  systemAnalysisSnapshotSchema,
  type BodySystemId,
  type MemberEvidenceRef,
  type SystemAnalysisCandidate,
  type SystemAnalysisReview,
  type SystemAnalysisSnapshot,
  type SystemEvidenceBundle
} from '@contracts';
import type { JobExecutionGuard, WorkspaceStore } from '@storage';
import {
  SYSTEM_ANALYSIS_PROMPT_VERSION,
  SYSTEM_ANALYSIS_RULES_VERSION,
  buildReviewSystemAnalysisPrompt,
  buildSystemAnalysisPrompt
} from './prompts/index.js';
import { buildSystemEvidenceBundle } from './system-evidence.js';

interface StructuredRuntime {
  runStructuredTurn(input: {
    prompt: string;
    outputSchema: Record<string, unknown>;
    allowWebSearch?: boolean;
    timeoutMs?: number;
  }): Promise<{ threadId: string; turnId: string; output: unknown }>;
}

export type SystemAnalysisPipelineResult =
  | { status: 'published'; snapshotId: string; systemId: BodySystemId; threadId: string; turnId: string; idempotent: boolean }
  | { status: 'skipped'; systemId: BodySystemId; reason: 'no_direct_facts' | 'signature_current' }
  | { status: 'rejected'; systemId: BodySystemId; reason: string; threadId?: string; turnId?: string };

const candidateOutputSchema = z.toJSONSchema(systemAnalysisCandidateSchema, { target: 'draft-7' }) as Record<string, unknown>;
const reviewOutputSchema = z.toJSONSchema(systemAnalysisReviewSchema, { target: 'draft-7' }) as Record<string, unknown>;
const prohibitedMedicalPattern = /(诊断为|患有|你有[^，。；]{0,12}(?:病|症)|必须服用|开始服用|停止服用|停药|加量|减量|换药|开药)/i;
const dosagePattern = /\d+(?:\.\d+)?\s*(?:mg|mcg|μg|iu|毫克|微克|国际单位)\b/i;

function allReviewItemIds(candidate: SystemAnalysisCandidate): string[] {
  return [
    ...candidate.keyPoints.map((item) => item.id),
    ...candidate.conflicts.map((_, index) => `conflict:${index}`),
    ...candidate.discussionPoints.map((_, index) => `discussion:${index}`)
  ];
}

function candidateIssues(candidate: SystemAnalysisCandidate, bundle: SystemEvidenceBundle): string[] {
  const issues: string[] = [];
  if (candidate.personId !== bundle.identity.personId
    || candidate.systemId !== bundle.identity.systemId
    || candidate.inputSignature !== bundle.scope.inputSignature) {
    issues.push('scope_mismatch');
  }
  const evidenceIds = new Set([
    ...bundle.directFacts.flatMap((fact) => [fact.evidence.id, ...fact.evidenceSources.map((item) => item.id)]),
    ...bundle.contextFacts.flatMap((fact) => [fact.evidence.id, ...fact.evidenceSources.map((item) => item.id)]),
    ...bundle.personalContext.map((context) => context.id)
  ]);
  const trendIds = new Set(bundle.trends.map((trend) => trend.id));
  const itemIds = allReviewItemIds(candidate);
  if (new Set(itemIds).size !== itemIds.length) issues.push('duplicate_item_id');
  const citedEvidence = [
    ...candidate.keyPoints.flatMap((item) => item.evidenceIds.map((id) => ({ itemId: item.id, id }))),
    ...candidate.conflicts.flatMap((item, index) => item.evidenceIds.map((id) => ({ itemId: `conflict:${index}`, id }))),
    ...candidate.discussionPoints.flatMap((item, index) => item.evidenceIds.map((id) => ({ itemId: `discussion:${index}`, id })))
  ];
  for (const citation of citedEvidence) {
    if (!evidenceIds.has(citation.id)) issues.push(`evidence_mismatch:${citation.itemId}`);
  }
  for (const point of candidate.keyPoints) {
    if (point.trendFactIds.some((id) => !trendIds.has(id))) issues.push(`trend_mismatch:${point.id}`);
    if (point.kind !== 'question' && point.evidenceIds.length === 0) issues.push(`evidence_required:${point.id}`);
  }
  const texts = [
    candidate.headline,
    ...candidate.keyPoints.map((item) => item.text),
    ...candidate.conflicts.map((item) => item.text),
    ...candidate.discussionPoints.map((item) => item.text)
  ];
  if (texts.some((text) => prohibitedMedicalPattern.test(text))) issues.push('medical_boundary');
  if (texts.some((text) => dosagePattern.test(text))) issues.push('dosage_boundary');
  const claimIds = new Set(candidate.keyPoints.map((item) => item.id));
  for (const section of candidate.topicSections) {
    if (section.claimIds.some((id) => !claimIds.has(id))) issues.push(`topic_claim_mismatch:${section.topicId}`);
    if (section.seriesIds.some((id) => !trendIds.has(id))) issues.push(`topic_series_mismatch:${section.topicId}`);
  }
  return [...new Set(issues)];
}

function reviewIssues(candidate: SystemAnalysisCandidate, review: SystemAnalysisReview): string[] {
  const expected = allReviewItemIds(candidate);
  const actual = review.itemReviews.map((item) => item.itemId);
  const issues: string[] = [];
  if (!review.overallSupported) issues.push('review_not_supported');
  if (new Set(actual).size !== actual.length
    || actual.length !== expected.length
    || expected.some((id) => !actual.includes(id))) issues.push('review_coverage');
  for (const item of review.itemReviews) {
    if (!item.supported || !item.safe || !item.trendConsistent) issues.push(`item_rejected:${item.itemId}`);
  }
  return [...new Set(issues)];
}

function evidenceResolver(bundle: SystemEvidenceBundle): Map<string, MemberEvidenceRef> {
  const entries: Array<[string, MemberEvidenceRef]> = [
    ...bundle.directFacts.flatMap((fact): Array<[string, MemberEvidenceRef]> => [fact.evidence, ...fact.evidenceSources].map((item) => [item.id, item])),
    ...bundle.contextFacts.flatMap((fact): Array<[string, MemberEvidenceRef]> => [fact.evidence, ...fact.evidenceSources].map((item) => [item.id, item])),
    ...bundle.personalContext.map((context): [string, MemberEvidenceRef] => [context.id, {
      id: context.id,
      kind: 'user_note',
      observationId: null,
      eventId: null,
      documentId: null,
      sourceSpanId: null,
      knowledgeId: null,
      label: '本人补充',
      locator: context.effectiveDate,
      quote: context.text
    }])
  ];
  const resolver = new Map<string, MemberEvidenceRef>();
  for (const [id, evidence] of entries) {
    const existing = resolver.get(id);
    if (existing && (existing.observationId !== evidence.observationId
      || existing.sourceSpanId !== evidence.sourceSpanId
      || existing.kind !== evidence.kind)) {
      throw new Error(`SYSTEM_EVIDENCE_ID_COLLISION:${id}`);
    }
    resolver.set(id, evidence);
  }
  return resolver;
}

function materializeSnapshot(
  candidate: SystemAnalysisCandidate,
  bundle: SystemEvidenceBundle,
  reviewerRunId: string
): Omit<SystemAnalysisSnapshot, 'id' | 'status' | 'generatedAt'> {
  const evidence = evidenceResolver(bundle);
  const resolve = (ids: string[]) => ids.map((id) => evidence.get(id)).filter((item): item is MemberEvidenceRef => Boolean(item));
  return systemAnalysisSnapshotSchema.omit({ id: true, status: true, generatedAt: true }).parse({
    schemaVersion: 2,
    personId: candidate.personId,
    systemId: candidate.systemId,
    inputSignature: candidate.inputSignature,
    scope: {
      from: bundle.scope.clinicalFrom,
      to: bundle.scope.clinicalAsOf,
      clinicalAsOf: bundle.scope.clinicalAsOf
    },
    factRevision: bundle.scope.factRevision,
    promptVersion: SYSTEM_ANALYSIS_PROMPT_VERSION,
    dataQuality: candidate.dataQuality,
    headline: candidate.headline,
    keyPoints: candidate.keyPoints.map((item) => ({
      id: item.id,
      kind: item.kind,
      text: item.text,
      evidence: resolve(item.evidenceIds),
      limitations: item.limitations,
      trendFactIds: item.trendFactIds
    })),
    topicSections: candidate.topicSections,
    conflicts: candidate.conflicts.map((item) => ({ text: item.text, evidence: resolve(item.evidenceIds) })),
    dataGaps: candidate.dataGaps,
    discussionPoints: candidate.discussionPoints.map((item) => ({
      text: item.text,
      evidence: resolve(item.evidenceIds),
      source: item.source
    })),
    coverage: {
      inputCount: bundle.coverage.selectedObservationIds.length + bundle.personalContext.length,
      linkedEventCount: bundle.events.length,
      excludedCount: bundle.coverage.excludedObservationIds.length,
      incompleteReasons: bundle.coverage.incompleteReasons
    },
    review: {
      status: 'passed',
      reviewerRunId,
      rulesVersion: SYSTEM_ANALYSIS_RULES_VERSION
    }
  });
}

export class SystemAnalysisPipeline {
  constructor(
    private readonly store: WorkspaceStore,
    private readonly runtime: StructuredRuntime,
    private readonly onStage?: (stage: 'system_analysis' | 'system_review') => void,
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

  async process(personId: string, systemId: BodySystemId): Promise<SystemAnalysisPipelineResult> {
    const bundle = buildSystemEvidenceBundle(this.store, personId, systemId, { modelId: this.modelId });
    if (bundle.directFacts.length === 0) return { status: 'skipped', systemId, reason: 'no_direct_facts' };
    if (this.executionGuard) {
      const observations = this.store.listAcceptedObservations(personId)
        .filter((observation) => bundle.coverage.selectedObservationIds.includes(observation.id));
      this.store.assertObservationScopeActive(this.executionGuard, personId, observations);
    }
    const current = this.store.listSystemAnalysisSnapshots(personId, true)
      .find((snapshot) => snapshot.systemId === systemId && snapshot.inputSignature === bundle.scope.inputSignature);
    if (current) return { status: 'skipped', systemId, reason: 'signature_current' };
    const serializedBundle = JSON.stringify(bundle);
    this.onStage?.('system_analysis');
    const generated = await this.runTurn('system_analysis', {
      prompt: buildSystemAnalysisPrompt(serializedBundle),
      outputSchema: candidateOutputSchema,
      allowWebSearch: false
    });
    const candidate = systemAnalysisCandidateSchema.parse(generated.output);
    const localIssues = candidateIssues(candidate, bundle);
    if (localIssues.length > 0) {
      return { status: 'rejected', systemId, reason: localIssues.join(','), threadId: generated.threadId, turnId: generated.turnId };
    }
    this.onStage?.('system_review');
    const reviewed = await this.runTurn('system_review', {
      prompt: buildReviewSystemAnalysisPrompt({ evidenceBundle: serializedBundle, candidate: JSON.stringify(candidate) }),
      outputSchema: reviewOutputSchema,
      allowWebSearch: false
    });
    const review = systemAnalysisReviewSchema.parse(reviewed.output);
    if (review.personId !== personId || review.systemId !== systemId || review.inputSignature !== bundle.scope.inputSignature) {
      return { status: 'rejected', systemId, reason: 'review_scope_mismatch', threadId: reviewed.threadId, turnId: reviewed.turnId };
    }
    const independentIssues = reviewIssues(candidate, review);
    if (independentIssues.length > 0) {
      return { status: 'rejected', systemId, reason: independentIssues.join(','), threadId: reviewed.threadId, turnId: reviewed.turnId };
    }
    const snapshot = materializeSnapshot(candidate, bundle, reviewed.turnId);
    const published = this.store.publishSystemAnalysisSnapshot({
      snapshot,
      evidenceBundle: bundle,
      expectedContextRevision: bundle.scope.contextRevision,
      rulesVersion: SYSTEM_ANALYSIS_RULES_VERSION,
      modelId: this.modelId,
      ...(this.executionGuard ? { executionGuard: this.executionGuard } : {})
    });
    return {
      status: 'published',
      snapshotId: published.snapshotId,
      systemId,
      threadId: reviewed.threadId,
      turnId: reviewed.turnId,
      idempotent: published.idempotent
    };
  }
}
