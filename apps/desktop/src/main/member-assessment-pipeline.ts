import { z } from 'zod';
import {
  clinicalFocusedReviewV1Schema, memberAssessmentCandidateV3Schema,
  type ClinicalFocusedReviewV1, type MemberAssessmentCandidateV3, type MemberAssessmentSnapshotV3
} from '@contracts';
import { stableHash } from '@core';
import type { JobExecutionGuard, WorkspaceStore } from '@storage';
import { validateAssessmentCandidate } from './assessment-validation.js';
import { applyFocusedReview, routeFocusedReview } from './clinical-review-router.js';
import { buildMemberAssessmentInput } from './member-assessment-input.js';
import { buildAssessmentKnowledgeVerifications, canonicalizeAssessmentKnowledge } from './assessment-knowledge.js';
import { buildP02Prompt, buildP03Prompt, buildP04Prompt } from './prompts/lean.js';
import { MEMBER_ASSESSMENT_PROMPT_VERSION, MEMBER_ASSESSMENT_RULES_VERSION } from './prompts/index.js';

export const TARGETED_REPAIR_PROMPT_VERSION = 'targeted-repair-v1';
export const FOCUSED_REVIEW_PROMPT_VERSION = 'focused-review-v1';

interface StructuredRuntime {
  runStructuredTurn(input: {
    prompt: string;
    outputSchema: Record<string, unknown>;
    allowWebSearch?: boolean;
    timeoutMs?: number;
  }): Promise<{ threadId: string; turnId: string; output: unknown }>;
}

export type MemberAssessmentPipelineResult =
  | { status: 'published'; snapshotId: string; threadId: string; turnId: string; idempotent: boolean; callCount: number }
  | { status: 'skipped'; reason: 'no_accepted_facts' | 'no_requested_systems' | 'signature_current'; callCount: 0 }
  | { status: 'rejected'; reason: string; threadId: string | null; turnId: string | null; callCount: number };

const candidateOutputSchema = z.toJSONSchema(memberAssessmentCandidateV3Schema, { target: 'draft-7' }) as Record<string, unknown>;
const reviewOutputSchema = z.toJSONSchema(clinicalFocusedReviewV1Schema, { target: 'draft-7' }) as Record<string, unknown>;

function targetNode(candidate: MemberAssessmentCandidateV3, id: string): unknown {
  if (id === 'overview') return candidate.overview;
  return [...candidate.systems, ...candidate.claims, ...candidate.actions, ...candidate.questions, ...candidate.knowledgeSources]
    .find((item) => item.id === id);
}

function repairTargets(candidate: MemberAssessmentCandidateV3, issues: string[]): string[] {
  const ids = new Set<string>();
  for (const issue of issues) {
    const parts = issue.split(':');
    const nodeId = parts[1];
    if (nodeId && targetNode(candidate, nodeId)) ids.add(nodeId);
    if (issue === 'overview_missing_claims' || issue.startsWith('unknown_claim:overview:')
      || issue.startsWith('unknown_action:overview:')) ids.add('overview');
  }
  return [...ids];
}

function repairChangedOnlyAllowed(
  original: MemberAssessmentCandidateV3,
  repaired: MemberAssessmentCandidateV3,
  allowedIds: string[]
): boolean {
  const allowed = new Set(allowedIds);
  for (const key of ['schemaVersion', 'personId', 'inputSignature', 'mode', 'requestedSystemIds'] as const) {
    if (JSON.stringify(original[key]) !== JSON.stringify(repaired[key])) return false;
  }
  if (!allowed.has('overview') && JSON.stringify(original.overview) !== JSON.stringify(repaired.overview)) return false;
  for (const key of ['systems', 'claims', 'actions', 'questions', 'knowledgeSources'] as const) {
    const before = new Map(original[key].map((node) => [node.id, node]));
    const after = new Map(repaired[key].map((node) => [node.id, node]));
    if (before.size !== after.size || [...before.keys()].some((id) => !after.has(id))) return false;
    for (const [id, node] of before) {
      if (!allowed.has(id) && JSON.stringify(node) !== JSON.stringify(after.get(id))) return false;
    }
  }
  return true;
}

/** 只有问题能精确归属于主张、行动或问题节点时，才允许局部隔离。 */
function isolatableTargets(candidate: MemberAssessmentCandidateV3, issues: string[]): string[] | null {
  const allowed = new Set([
    'unknown_evidence', 'unknown_trend', 'unknown_knowledge', 'personal_evidence_required',
    'personal_diagnostic_evidence_required', 'documented_source_not_proven',
    'criteria_not_proven', 'criteria_wrong_status', 'diagnostic_fields_without_status',
    'diagnostic_fields_incomplete', 'claim_system_outside_scope', 'action_system_outside_scope',
    'action_personal_evidence_required', 'direct_medication_change', 'unsourced_probability',
    'unknown_claim'
  ]);
  const nodes = new Set([...candidate.claims, ...candidate.actions, ...candidate.questions].map((item) => item.id));
  const targets = new Set<string>();
  for (const issue of issues) {
    const [kind, owner] = issue.split(':');
    if (!kind || !owner || !allowed.has(kind) || !nodes.has(owner)) return null;
    targets.add(owner);
  }
  return targets.size > 0 ? [...targets] : null;
}

function isolateInvalidNodes(candidate: MemberAssessmentCandidateV3, issues: string[]) {
  const targets = isolatableTargets(candidate, issues);
  if (!targets) return null;
  const review: ClinicalFocusedReviewV1 = {
    schemaVersion: 1, personId: candidate.personId, inputSignature: candidate.inputSignature,
    results: targets.map((targetId) => ({
      targetId, verdict: 'hold', reason: '局部修复后仍无法通过本地证据校验。', replacement: null
    }))
  };
  return applyFocusedReview(candidate, review, targets);
}

export class MemberAssessmentPipeline {
  constructor(
    private readonly store: WorkspaceStore,
    private readonly runtime: StructuredRuntime,
    private readonly onStage?: (stage: 'analyze' | 'review_derived') => void,
    private readonly executionGuard?: JobExecutionGuard,
    private readonly transmissionDocumentId?: string,
    private readonly modelId = 'codex-account-default',
    private readonly reasoningEffort = 'medium',
    private readonly analysisReferenceDate = new Date().toISOString().slice(0, 10)
  ) {}

  private async runTurn(stage: string, input: Parameters<StructuredRuntime['runStructuredTurn']>[0]) {
    if (!this.executionGuard || !this.transmissionDocumentId) return this.runtime.runStructuredTurn(input);
    this.store.assertJobExecutionActive(this.executionGuard, this.transmissionDocumentId);
    const transmissionId = this.store.beginAiTransmission({
      guard: this.executionGuard, documentId: this.transmissionDocumentId, stage
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

  async process(personId: string): Promise<MemberAssessmentPipelineResult> {
    const built = buildMemberAssessmentInput(this.store, personId, {
      modelId: this.modelId, reasoningEffort: this.reasoningEffort,
      analysisReferenceDate: this.analysisReferenceDate, webSearchAllowed: true
    });
    const { request, evidencePackage } = built;
    if (evidencePackage.facts.length === 0 && evidencePackage.personalContext.length === 0) {
      return { status: 'skipped', reason: 'no_accepted_facts', callCount: 0 };
    }
    if (request.requestedSystemIds.length === 0) return { status: 'skipped', reason: 'no_requested_systems', callCount: 0 };
    if (this.executionGuard) {
      this.store.assertObservationScopeActive(this.executionGuard, personId, this.store.listAcceptedObservations(personId));
    }
    const current = this.store.listMemberAssessmentSnapshots(personId, true)
      .find((snapshot) => snapshot.inputSignature === request.inputSignature
        && snapshot.promptVersion === MEMBER_ASSESSMENT_PROMPT_VERSION
        && snapshot.rulesVersion === MEMBER_ASSESSMENT_RULES_VERSION
        && snapshot.factRevision === built.factRevision
        && snapshot.contextRevision === built.contextRevision);
    if (current) return { status: 'skipped', reason: 'signature_current', callCount: 0 };
    let calls = 0;
    let lastReceipt: { threadId: string; turnId: string } | null = null;
    const reject = (reason: string): MemberAssessmentPipelineResult => ({
      status: 'rejected', reason, threadId: lastReceipt?.threadId ?? null,
      turnId: lastReceipt?.turnId ?? null, callCount: calls
    });
    const validationInput = {
      personId, inputSignature: request.inputSignature, mode: request.mode,
      requestedSystemIds: request.requestedSystemIds,
      evidenceCatalog: evidencePackage.evidenceCatalog,
      trendIds: evidencePackage.trends.map((item) => item.id),
      catalogKnowledgeIds: evidencePackage.knowledge.map((item) => item.id),
      criteriaSets: evidencePackage.criteriaSets
    };
    this.onStage?.('analyze');
    const generated = await this.runTurn('member_assessment', {
      prompt: buildP02Prompt(request, evidencePackage), outputSchema: candidateOutputSchema,
      allowWebSearch: request.webSearchAllowed
    });
    calls += 1;
    lastReceipt = generated;
    const parsed = memberAssessmentCandidateV3Schema.safeParse(generated.output);
    if (!parsed.success) return reject('assessment_schema_invalid');
    let candidate = parsed.data;
    let validation = validateAssessmentCandidate(candidate, validationInput);
    let heldTargetIds: string[] = [];
    if (validation.issues.length > 0) {
      // 仅具体节点可修，身份或系统范围冲突不能由自由改写“修正”。
      if (validation.issues.includes('scope_mismatch') || validation.issues.includes('system_scope_mismatch')
        || validation.issues.includes('duplicate_node_id')) return reject(validation.issues.join(','));
      const targetIds = repairTargets(candidate, validation.issues);
      if (targetIds.length === 0) return reject(validation.issues.join(','));
      const repairRequest = {
        stage: 'assessment', targets: targetIds,
        allowedPaths: targetIds.map((id) => id === 'overview' ? 'overview' : `node:${id}`),
        issues: validation.issues, originalCandidateHash: stableHash(candidate)
      };
      const repaired = await this.runTurn('assessment_repair', {
        prompt: buildP03Prompt(repairRequest, evidencePackage, candidate),
        outputSchema: candidateOutputSchema, allowWebSearch: false
      });
      calls += 1;
      lastReceipt = repaired;
      const repairParsed = memberAssessmentCandidateV3Schema.safeParse(repaired.output);
      if (!repairParsed.success || !repairChangedOnlyAllowed(candidate, repairParsed.data, targetIds)) {
        const isolated = isolateInvalidNodes(candidate, validation.issues);
        if (!isolated) return reject('assessment_repair_outside_scope');
        candidate = isolated.candidate;
        heldTargetIds = isolated.heldTargetIds;
      } else {
        candidate = repairParsed.data;
      }
      validation = validateAssessmentCandidate(candidate, validationInput);
      if (validation.issues.length > 0) {
        const isolated = isolateInvalidNodes(candidate, validation.issues);
        if (!isolated) return reject(validation.issues.join(','));
        candidate = isolated.candidate;
        heldTargetIds = [...new Set([...heldTargetIds, ...isolated.heldTargetIds])];
        validation = validateAssessmentCandidate(candidate, validationInput);
        if (validation.issues.length > 0) return reject(validation.issues.join(','));
      }
    }
    let reviewedTargetIds: string[] = [];
    let validationMode: MemberAssessmentSnapshotV3['validationMode'] = 'local_only';
    const route = routeFocusedReview(candidate);
    if (route.targetIds.length > 0) {
      this.onStage?.('review_derived');
      const targetIds = route.targetIds;
      const targetNodes = targetIds.map((id) => ({ id, node: targetNode(candidate, id) }));
      const relevantEvidenceIds = new Set(candidate.claims.filter((item) => targetIds.includes(item.id))
        .flatMap((item) => [...item.evidenceIds, ...item.counterEvidenceIds]));
      const sourceContext = {
        evidenceCatalog: evidencePackage.evidenceCatalog.filter((item) => relevantEvidenceIds.has(item.id)),
        knowledge: evidencePackage.knowledge,
        criteriaSets: evidencePackage.criteriaSets,
        analysisReferenceDate: request.analysisReferenceDate
      };
      const reviewed = await this.runTurn('focused_review', {
        prompt: buildP04Prompt({ personId, inputSignature: request.inputSignature, targets: targetIds, reasons: route.reasons }, sourceContext, targetNodes),
        outputSchema: reviewOutputSchema, allowWebSearch: false
      });
      calls += 1;
      lastReceipt = reviewed;
      const reviewParsed = clinicalFocusedReviewV1Schema.safeParse(reviewed.output);
      if (!reviewParsed.success) return reject('focused_review_schema_invalid');
      let applied: ReturnType<typeof applyFocusedReview>;
      try { applied = applyFocusedReview(candidate, reviewParsed.data, targetIds); }
      catch (error) { return reject(error instanceof Error ? error.message : 'focused_review_invalid'); }
      candidate = applied.candidate;
      heldTargetIds = [...new Set([...heldTargetIds, ...applied.heldTargetIds])];
      reviewedTargetIds = targetIds;
      validationMode = 'local_and_focused_review';
      const after = routeFocusedReview(candidate);
      // 同一个依赖节点原本在复核范围内，不代表复核者新写入的高影响内容已被独立审过。
      const priorReasons = new Set(route.reasons);
      const newlyHigh = [...new Set(after.reasons.filter((reason) => !priorReasons.has(reason))
        .map((reason) => reason.slice(reason.indexOf(':') + 1)))];
      if (newlyHigh.length > 0) {
        const holds: ClinicalFocusedReviewV1 = {
          schemaVersion: 1, personId, inputSignature: request.inputSignature,
          results: newlyHigh.map((targetId) => ({ targetId, verdict: 'hold', reason: '复核替换引入新的高影响判断，待另行核验。', replacement: null }))
        };
        const isolated = applyFocusedReview(candidate, holds, newlyHigh);
        candidate = isolated.candidate;
        heldTargetIds = [...new Set([...heldTargetIds, ...isolated.heldTargetIds])];
      }
      validation = validateAssessmentCandidate(candidate, validationInput);
      if (validation.issues.length > 0) return reject(validation.issues.join(','));
    }
    const publishCandidate = canonicalizeAssessmentKnowledge(candidate, evidencePackage);
    const snapshot: Omit<MemberAssessmentSnapshotV3, 'id' | 'status' | 'generatedAt'> = {
      ...publishCandidate,
      factRevision: built.factRevision, contextRevision: built.contextRevision,
      promptVersion: MEMBER_ASSESSMENT_PROMPT_VERSION, rulesVersion: MEMBER_ASSESSMENT_RULES_VERSION,
      modelId: this.modelId, reasoningEffort: this.reasoningEffort, validationMode,
      reviewedTargetIds, heldTargetIds,
      limitations: heldTargetIds.length ? ['部分判断因数据或依据问题暂未发布。'] : [],
      evidenceCatalog: evidencePackage.evidenceCatalog,
      knowledgeVerifications: buildAssessmentKnowledgeVerifications(publishCandidate, evidencePackage)
    };
    const published = this.store.publishMemberAssessmentSnapshot({
      snapshot, ...(this.executionGuard ? { executionGuard: this.executionGuard } : {})
    });
    return {
      status: 'published', snapshotId: published.snapshotId, idempotent: published.idempotent,
      threadId: lastReceipt!.threadId, turnId: lastReceipt!.turnId, callCount: calls
    };
  }
}
