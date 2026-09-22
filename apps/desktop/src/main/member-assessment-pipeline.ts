import { z } from 'zod';
import {
  clinicalFocusedReviewV1Schema, memberAssessmentCandidateV3Schema,
  type AssessmentRequestV3, type ClinicalFocusedReviewV1, type MemberAssessmentCandidateV3,
  type MemberAssessmentSnapshotV3, type MemberEvidencePackageV3
} from '@contracts';
import { stableHash } from '@core';
import type { JobExecutionGuard, WorkspaceStore } from '@storage';
import { validateAssessmentCandidate } from './assessment-validation.js';
import { applyFocusedReview, routeFocusedReview } from './clinical-review-router.js';
import { buildMemberAssessmentInput } from './member-assessment-input.js';
import { buildMemberAggregatePackage, buildMemberSystemPartitions, splitMemberPartition } from './member-assessment-partition.js';
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
    const runCountedTurn = async (stage: string, input: Parameters<StructuredRuntime['runStructuredTurn']>[0]) => {
      calls += 1; // 失败的原始尝试也是真实请求，不能在分区模式中藏掉。
      const result = await this.runTurn(stage, input);
      lastReceipt = result;
      return result;
    };
    const validationInputFor = (scopeRequest: AssessmentRequestV3, scopePackage: MemberEvidencePackageV3) => ({
      personId, inputSignature: scopeRequest.inputSignature, mode: scopeRequest.mode,
      requestedSystemIds: scopeRequest.requestedSystemIds,
      evidenceCatalog: scopePackage.evidenceCatalog,
      trendIds: scopePackage.trends.map((item) => item.id),
      catalogKnowledgeIds: scopePackage.knowledge.map((item) => item.id),
      criteriaSets: scopePackage.criteriaSets
    });
    const validateAndRepair = async (
      original: MemberAssessmentCandidateV3,
      scopeRequest: AssessmentRequestV3,
      scopePackage: MemberEvidencePackageV3
    ): Promise<{ candidate: MemberAssessmentCandidateV3 | null; heldTargetIds: string[]; reason: string | null }> => {
      const validationInput = validationInputFor(scopeRequest, scopePackage);
      let candidate = original;
      let validation = validateAssessmentCandidate(candidate, validationInput);
      let heldTargetIds: string[] = [];
      if (validation.issues.length === 0) return { candidate, heldTargetIds, reason: null };
      // 身份、系统范围或重复 ID 不是可自由改写的局部错误。
      if (validation.issues.includes('scope_mismatch') || validation.issues.includes('system_scope_mismatch')
        || validation.issues.includes('duplicate_node_id')) {
        return { candidate: null, heldTargetIds, reason: validation.issues.join(',') };
      }
      const targetIds = repairTargets(candidate, validation.issues);
      if (targetIds.length === 0) return { candidate: null, heldTargetIds, reason: validation.issues.join(',') };
      const repairRequest = {
        stage: 'assessment', targets: targetIds,
        allowedPaths: targetIds.map((id) => id === 'overview' ? 'overview' : `node:${id}`),
        issues: validation.issues, originalCandidateHash: stableHash(candidate)
      };
      const repaired = await runCountedTurn('assessment_repair', {
        prompt: buildP03Prompt(repairRequest, scopePackage, candidate),
        outputSchema: candidateOutputSchema, allowWebSearch: false
      });
      const repairParsed = memberAssessmentCandidateV3Schema.safeParse(repaired.output);
      if (!repairParsed.success || !repairChangedOnlyAllowed(candidate, repairParsed.data, targetIds)) {
        const isolated = isolateInvalidNodes(candidate, validation.issues);
        if (!isolated) return { candidate: null, heldTargetIds, reason: 'assessment_repair_outside_scope' };
        candidate = isolated.candidate;
        heldTargetIds = isolated.heldTargetIds;
      } else {
        candidate = repairParsed.data;
      }
      validation = validateAssessmentCandidate(candidate, validationInput);
      if (validation.issues.length > 0) {
        const isolated = isolateInvalidNodes(candidate, validation.issues);
        if (!isolated) return { candidate: null, heldTargetIds, reason: validation.issues.join(',') };
        candidate = isolated.candidate;
        heldTargetIds = [...new Set([...heldTargetIds, ...isolated.heldTargetIds])];
        validation = validateAssessmentCandidate(candidate, validationInput);
        if (validation.issues.length > 0) return { candidate: null, heldTargetIds, reason: validation.issues.join(',') };
      }
      return { candidate, heldTargetIds, reason: null };
    };

    this.onStage?.('analyze');
    let analysisRequest = request;
    let analysisPackage = evidencePackage;
    let generated: Awaited<ReturnType<typeof runCountedTurn>>;
    let partitionCount = 0;
    const partitionHeldIds: string[] = [];
    const partitionHighImpact = new Map<string, Set<string>>();
    try {
      generated = await runCountedTurn('member_assessment', {
        prompt: buildP02Prompt(request, evidencePackage), outputSchema: candidateOutputSchema,
        allowWebSearch: request.webSearchAllowed
      });
    } catch (error) {
      if (!(error instanceof Error) || error.message !== 'CODEX_CONTEXT_WINDOW_EXCEEDED') throw error;
      const systemPartitions = buildMemberSystemPartitions(evidencePackage, request.requestedSystemIds);
      const initialPartitions = systemPartitions.length === 1
        ? splitMemberPartition(systemPartitions[0]!)
        : systemPartitions;
      if (!initialPartitions) return reject('single_fact_context_window_exceeded');
      const pendingPartitions = [...initialPartitions];
      const partitionResults: MemberAssessmentCandidateV3[] = [];
      while (pendingPartitions.length > 0) {
        const partition = pendingPartitions.shift()!;
        const partitionRequest: AssessmentRequestV3 = {
          ...request, mode: 'partition', requestedSystemIds: partition.systemIds,
          partitionScope: {
            basis: partition.basis, label: partition.label,
            selectedFactCount: partition.evidencePackage.facts.length,
            totalAcceptedFactCount: evidencePackage.facts.length,
            primaryObservationIds: partition.primaryObservationIds,
            contextObservationIds: partition.contextObservationIds
          }
        };
        let turn: Awaited<ReturnType<typeof runCountedTurn>>;
        try {
          turn = await runCountedTurn('member_assessment_partition', {
            prompt: buildP02Prompt(partitionRequest, partition.evidencePackage),
            outputSchema: candidateOutputSchema, allowWebSearch: request.webSearchAllowed
          });
        } catch (partitionError) {
          if (partitionError instanceof Error && partitionError.message === 'CODEX_CONTEXT_WINDOW_EXCEEDED') {
            const children = splitMemberPartition(partition);
            if (!children) return reject('single_fact_context_window_exceeded');
            pendingPartitions.unshift(...children);
            continue;
          }
          throw partitionError;
        }
        const parsedPartition = memberAssessmentCandidateV3Schema.safeParse(turn.output);
        if (!parsedPartition.success) return reject('partition_schema_invalid');
        const validatedPartition = await validateAndRepair(parsedPartition.data, partitionRequest, partition.evidencePackage);
        if (!validatedPartition.candidate) return reject(`partition_${validatedPartition.reason}`);
        partitionHeldIds.push(...validatedPartition.heldTargetIds);
        for (const reason of routeFocusedReview(validatedPartition.candidate).reasons) {
          const id = reason.slice(reason.indexOf(':') + 1);
          const node = targetNode(validatedPartition.candidate, id);
          if (!node) continue;
          const hashes = partitionHighImpact.get(id) ?? new Set<string>();
          hashes.add(stableHash(node));
          partitionHighImpact.set(id, hashes);
        }
        partitionResults.push(validatedPartition.candidate);
      }
      partitionCount = partitionResults.length;
      analysisRequest = { ...request, mode: 'aggregate' };
      analysisPackage = buildMemberAggregatePackage(evidencePackage, partitionResults);
      try {
        generated = await runCountedTurn('member_assessment_aggregate', {
          prompt: buildP02Prompt(analysisRequest, analysisPackage),
          outputSchema: candidateOutputSchema, allowWebSearch: request.webSearchAllowed
        });
      } catch (aggregateError) {
        if (aggregateError instanceof Error && aggregateError.message === 'CODEX_CONTEXT_WINDOW_EXCEEDED') {
          return reject('aggregate_context_window_exceeded');
        }
        throw aggregateError;
      }
    }
    const parsed = memberAssessmentCandidateV3Schema.safeParse(generated.output);
    if (!parsed.success) return reject('assessment_schema_invalid');
    const validated = await validateAndRepair(parsed.data, analysisRequest, analysisPackage);
    if (!validated.candidate) return reject(validated.reason ?? 'assessment_validation_failed');
    let candidate = validated.candidate;
    let heldTargetIds = [...new Set([...validated.heldTargetIds, ...partitionHeldIds])];
    let reviewedTargetIds: string[] = [];
    let validationMode: MemberAssessmentSnapshotV3['validationMode'] = 'local_only';
    const route = routeFocusedReview(candidate);
    const addTargetAndDependents = (id: string, reason: string) => {
      const linkedClaims = candidate.claims.some((item) => item.id === id) ? [id] : [];
      const linkedActions = candidate.actions.some((item) => item.id === id)
        ? [id]
        : candidate.actions.filter((item) => item.claimIds.includes(id)).map((item) => item.id);
      const dependents = [id, ...linkedActions,
        ...candidate.systems.filter((item) => item.claimIds.some((claimId) => linkedClaims.includes(claimId))
          || item.actionIds.some((actionId) => linkedActions.includes(actionId))).map((item) => item.id),
        ...(candidate.overview.claimIds.some((claimId) => linkedClaims.includes(claimId))
          || candidate.overview.actionIds.some((actionId) => linkedActions.includes(actionId)) ? ['overview'] : [])];
      route.targetIds = [...new Set([...route.targetIds, ...dependents])];
      route.reasons = [...new Set([...route.reasons, reason])];
    };
    for (const [id, reviewedHashes] of partitionHighImpact) {
      const node = targetNode(candidate, id);
      // 聚合不能悄悄丢掉分区中尚未隔离的高影响线索。
      if (!node) return reject(`aggregate_omitted_high_impact:${id}`);
      if (reviewedHashes.size === 1 && reviewedHashes.has(stableHash(node))) continue;
      addTargetAndDependents(id, `partition_high_impact_changed:${id}`);
    }
    for (const id of new Set(partitionHeldIds)) {
      // overview/system 是每个分区都会复用的保留 ID，不代表聚合重现同一判断。
      if (id === 'overview' || id.startsWith('system:') || !targetNode(candidate, id)) continue;
      // 局部修复隔离过的内容若被聚合带回，先重点复核该节点及其依赖，不能静默发布。
      addTargetAndDependents(id, `partition_held_reintroduced:${id}`);
    }
    if (route.targetIds.length > 0) {
      this.onStage?.('review_derived');
      const targetIds = route.targetIds;
      const targetNodes = targetIds.map((id) => ({ id, node: targetNode(candidate, id) }));
      const relevantEvidenceIds = new Set([
        ...candidate.claims.filter((item) => targetIds.includes(item.id))
          .flatMap((item) => [...item.evidenceIds, ...item.counterEvidenceIds]),
        ...candidate.actions.filter((item) => targetIds.includes(item.id)).flatMap((item) => item.evidenceIds),
        ...candidate.questions.filter((item) => targetIds.includes(item.id)).flatMap((item) => item.evidenceIds)
      ]);
      const sourceContext = {
        evidenceCatalog: evidencePackage.evidenceCatalog.filter((item) => relevantEvidenceIds.has(item.id)),
        knowledge: evidencePackage.knowledge,
        criteriaSets: evidencePackage.criteriaSets,
        analysisReferenceDate: request.analysisReferenceDate
      };
      const reviewed = await runCountedTurn('focused_review', {
        prompt: buildP04Prompt({ personId, inputSignature: request.inputSignature, targets: targetIds, reasons: route.reasons }, sourceContext, targetNodes),
        outputSchema: reviewOutputSchema, allowWebSearch: false
      });
      const reviewParsed = clinicalFocusedReviewV1Schema.safeParse(reviewed.output);
      if (!reviewParsed.success) return reject('focused_review_schema_invalid');
      let applied: ReturnType<typeof applyFocusedReview>;
      try { applied = applyFocusedReview(candidate, reviewParsed.data, targetIds); }
      catch (error) { return reject(error instanceof Error ? error.message : 'focused_review_invalid'); }
      candidate = applied.candidate;
      heldTargetIds = [...new Set([...heldTargetIds, ...applied.heldTargetIds])];
      for (const result of reviewParsed.data.results) {
        if (result.verdict === 'pass' || result.verdict === 'replace') {
          // 分区曾隔离，但本轮 P04 已确认可发布的节点不应继续标成“仍被隔离”。
          if (partitionHeldIds.includes(result.targetId) && !applied.heldTargetIds.includes(result.targetId)) {
            heldTargetIds = heldTargetIds.filter((id) => id !== result.targetId);
          }
        }
      }
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
      const validation = validateAssessmentCandidate(candidate, validationInputFor(analysisRequest, analysisPackage));
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
      processingPlan: {
        strategy: partitionCount > 0 ? 'partitioned' : 'full',
        trigger: partitionCount > 0 ? 'runtime_context_window_exceeded' : 'none',
        partitionCount, partitionHeldTargetCount: partitionHeldIds.length
      },
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
