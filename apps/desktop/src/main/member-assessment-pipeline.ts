import { z } from 'zod';
import {
  clinicalFocusedReviewV1Schema, memberAssessmentCandidateV3Schema, memberAssessmentRepairV1Schema,
  inspectDocumentedPlanEvidence, DOCUMENTED_PLAN_NEUTRAL_TITLE,
  type AssessmentRequestV3, type AssessmentRepairReplacement, type AssessmentRepairRequestV1,
  type ClinicalFocusedReviewV1, type MemberAssessmentCandidateV3,
  type MemberAssessmentSnapshotV3, type MemberEvidencePackageV3, type MemberEvidenceRef
} from '@contracts';
import { stableHash } from '@core';
import type { JobExecutionGuard, WorkspaceStore } from '@storage';
import { normalizeAssessmentRejectionCodes } from '@storage';
import {
  highConsequenceAssertionMentions, normalizeAssessmentStructuralFields, validateAssessmentCandidate, visibleAssessmentTextFields
} from './assessment-validation.js';
import { applyFocusedReview, routeFocusedReview } from './clinical-review-router.js';
import { buildIndependentHabitEvidencePermission, findIndependentHabitRepairCandidateIds, hasSubstantiveActionRewrite,
  isIndependentHabitRepairReplacement, findChangedHabitPremiseReviewIds } from './assessment-independent-habit-repair.js';
import { hasSurvivingSystemSupport, inspectAssessmentReviewBoundary, type AssessmentReviewBoundaryReason,
  type ActionDependencyRebinding, type RebuiltSystemStatusRestoration } from './assessment-review-boundary.js';
import { buildAssessmentEvidenceResolutions, sameAssessmentFactLocation,
  type AssessmentEvidenceResolution } from './assessment-evidence-resolution.js';
import { bindAssessmentSourceInstructions } from './assessment-source-instructions.js';
import { assessmentLimitationConsistencyTargets, assessmentLimitationPreparationIssues, assessmentReviewNodeHash, filterAssessmentReviewIssues, partitionAssessmentReviewIssues } from './assessment-semantic-review.js';
import { AssessmentReviewAuditCollector } from './assessment-review-audit.js';
import { buildAssessmentSourceInstructionReviewContext, buildMemberAssessmentInput } from './member-assessment-input.js';
import { assertAssessmentPromptFits, isAssessmentContextLimit, aliasMemberEvidenceReferences } from './member-evidence-transport.js';
import { buildMemberAnalysisPackage, createMemberAnalysisTransport } from './member-analysis-package.js';
import { prepareClinicalRecords } from './clinical-record-preparation.js';
import {
  applyKnowledgeAttributionReview, buildAssessmentKnowledgeVerifications, canonicalizeAssessmentKnowledge,
  pruneUnreferencedInvalidKnowledge, pruneUnusedCatalogKnowledge, routeKnowledgeAttributionReview
} from './assessment-knowledge.js';
import { ASSESSMENT_PRESENTATION_VERSION } from './assessment-presentation.js';
import { prepareFinalAggregateRecovery, finalAggregateReplacementPreserved } from './assessment-aggregate-recovery.js';
import { getCodexTurnFailureDetails } from './codex-turn-failure.js';
import { runCheckpointedAssessmentTurn } from './assessment-turn-checkpoint.js';
import { resolveAssessmentKnowledgeContent, type OfficialKnowledgeReceipt, type OfficialKnowledgeTransport } from './official-knowledge-retrieval.js';
import { buildP02Prompt, buildP03Prompt, buildP04Prompt } from './prompts/lean.js';
import { MEMBER_ASSESSMENT_PROMPT_VERSION, MEMBER_ASSESSMENT_RULES_VERSION } from './prompts/index.js';
import { assessmentComparisonCoverage, assessmentPriorityTopicKeys, findMissingAssessmentComparisons } from './assessment-comparisons.js';

export const TARGETED_REPAIR_PROMPT_VERSION = 'targeted-repair-v1';
export const FOCUSED_REVIEW_PROMPT_VERSION = 'focused-review-v2';

interface StructuredRuntime {
  runStructuredTurn(input: {
    prompt: string;
    outputSchema: Record<string, unknown>;
    allowWebSearch?: boolean;
    timeoutMs?: number;
  }): Promise<{ threadId: string; turnId: string; output: unknown }>;
}

/** 只记录局部修复的结构与门禁结果，不保存模型原始健康正文。 */
export interface AssessmentRepairSchemaIssue {
  path: Array<string | number>;
  code: string;
}

export interface AssessmentRepairDiagnostic {
  originalCandidateHash: string;
  targetIds: string[];
  schemaVerdict: 'accepted' | 'invalid';
  scopeVerdict: 'accepted' | 'invalid' | 'not_checked';
  initialIssues: string[];
  remainingIssues: string[];
  heldTargetIds: string[];
  failureReason: string | null;
  schemaIssues?: AssessmentRepairSchemaIssue[];
  schemaIssueCount?: number;
}

/** 固定结构的复核回执，不保存模型自由文本或私人报告正文。 */
export type FocusedReviewBoundaryReason = AssessmentReviewBoundaryReason
  | 'p04_scope_boundary_changed' | 'post_review_scope_boundary_changed'
  | 'reviewer_hold' | 'original_claim_dependency_held' | 'original_action_dependency_held'
  | 'dependency_replacement_missing' | 'dependency_rewrite_not_substantive'
  | 'held_claim_dependency_retained' | 'independent_support_empty'
  | 'post_review_local_validation_held'
  | 'post_review_independent_rewrite_unreviewed' | 'post_review_knowledge_attribution_unreviewed'
  | 'post_review_action_hash_changed' | 'post_review_action_node_changed' | 'post_review_action_premise_changed'
  | 'post_review_question_hash_changed' | 'post_review_question_node_changed' | 'post_review_question_premise_changed'
  | 'post_review_aggregate_hash_changed' | 'post_review_aggregate_node_changed' | 'post_review_aggregate_premise_changed'
  | 'final_dependency_not_reviewed' | 'review_receipt_missing';

export interface FocusedReviewDiagnostic {
  targetId: string;
  verdict: 'pass' | 'replace' | 'hold';
  reviewOrigin?: 'model' | 'local_dependency_guard';
  outcome: 'retained' | 'held' | 'dependency_repaired' | 'dependency_held';
  reasonCodes?: Array<'focused_scope_boundary_changed' | 'independent_habit_repair_failed' | 'final_dependency_not_reviewed'>;
  boundaryReasonCodes?: FocusedReviewBoundaryReason[];
}

/** 实际运行输入的绑定；可选仅用于兼容既有调用方的合成回执。 */
interface AssessmentExecutionBinding {
  inputSignature?: string;
  factRevision?: number;
  contextRevision?: number;
  reviewScopeSignature?: string;
}

export type MemberAssessmentPipelineResult = AssessmentExecutionBinding & (
  | { status: 'published'; snapshotId: string; threadId: string; turnId: string; idempotent: boolean; callCount: number;
    repairFailureReasons?: string[]; repairDiagnostics?: AssessmentRepairDiagnostic[]; focusedReviewDiagnostics?: FocusedReviewDiagnostic[] }
  | { status: 'skipped'; reason: 'no_accepted_facts' | 'signature_current'; callCount: 0; snapshotId?: string }
  | { status: 'rejected'; reason: string; threadId: string | null; turnId: string | null; callCount: number;
    repairDiagnostics?: AssessmentRepairDiagnostic[]; focusedReviewDiagnostics?: FocusedReviewDiagnostic[] });

/** 正常流程的实际回执总带输入绑定，兼容 mock 的可选字段不扩散到生产调用。 */
export type MemberAssessmentExecutionResult = MemberAssessmentPipelineResult & Required<AssessmentExecutionBinding>;

const candidateOutputSchema = z.toJSONSchema(memberAssessmentCandidateV3Schema, { target: 'draft-7' }) as Record<string, unknown>;
const reviewOutputSchema = z.toJSONSchema(clinicalFocusedReviewV1Schema, { target: 'draft-7' }) as Record<string, unknown>;
const repairOutputSchema = z.toJSONSchema(memberAssessmentRepairV1Schema, { target: 'draft-7' }) as Record<string, unknown>;

const repairSchemaFieldNames = new Set<string>();
function collectRepairSchemaFields(value: unknown): void {
  if (Array.isArray(value)) value.forEach(collectRepairSchemaFields);
  else if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    if (record.properties && typeof record.properties === 'object') {
      Object.keys(record.properties).forEach((field) => repairSchemaFieldNames.add(field));
    }
    Object.values(record).forEach(collectRepairSchemaFields);
  }
}
collectRepairSchemaFields(repairOutputSchema);

/** 不记录 Zod message/input/values/unknown keys；路径只允许契约字段名和数组位置。 */
function safeRepairSchemaIssues(error: z.ZodError): { schemaIssues: AssessmentRepairSchemaIssue[]; schemaIssueCount: number } {
  const leaves = (issue: z.core.$ZodIssue): z.core.$ZodIssue[] => issue.code === 'invalid_union' && issue.errors.length
    ? issue.errors.flatMap((branch) => branch.flatMap(leaves)) : [issue];
  const issues = error.issues.flatMap(leaves);
  const metadata = issues.map((issue) => ({ code: issue.code,
    path: issue.path.slice(0, 20).map((field) => typeof field === 'number' ? field
      : typeof field === 'string' && repairSchemaFieldNames.has(field) ? field : '$unknown') }));
  const unique = [...new Map(metadata.map((issue) => [JSON.stringify(issue), issue])).values()];
  return { schemaIssues: unique.slice(0, 30), schemaIssueCount: unique.length };
}

/** 仅处理本次新候选；正文与时间已证明时，标题单独降为中性名称，不恢复历史隔离节点。 */
function normalizeNewDocumentedPlanTitles(candidate: MemberAssessmentCandidateV3, catalog: readonly MemberEvidenceRef[]): MemberAssessmentCandidateV3 {
  return { ...candidate, actions: candidate.actions.map((action) => {
    if (action.sourceInstructionObservationId !== undefined) return action;
    const proof = inspectDocumentedPlanEvidence(action, catalog);
    return proof.required && proof.unsupportedField === null && !proof.titleSupported
      ? { ...action, title: DOCUMENTED_PLAN_NEUTRAL_TITLE } : action;
  }) };
}

function targetNode(candidate: MemberAssessmentCandidateV3, id: string): unknown {
  if (id === 'overview') return candidate.overview;
  return [...candidate.systems, ...candidate.claims, ...candidate.actions, ...candidate.questions, ...candidate.knowledgeSources]
    .find((item) => item.id === id);
}

/** 类型由程序的原节点确定，模型不能用相同 ID 换成另一种内容。 */
export function assessmentRepairNode(candidate: MemberAssessmentCandidateV3, id: string): AssessmentRepairReplacement | null {
  if (id === 'overview') return { nodeType: 'overview', value: candidate.overview };
  const claim = candidate.claims.find((node) => node.id === id);
  if (claim) return { nodeType: 'claim', value: claim };
  const action = candidate.actions.find((node) => node.id === id);
  if (action) return { nodeType: 'action', value: action };
  const system = candidate.systems.find((node) => node.id === id);
  if (system) return { nodeType: 'system', value: system };
  const question = candidate.questions.find((node) => node.id === id);
  if (question) return { nodeType: 'question', value: question };
  const source = candidate.knowledgeSources.find((node) => node.id === id);
  return source ? { nodeType: 'knowledge_source', value: source } : null;
}

function ambiguousRepairTargets(candidate: MemberAssessmentCandidateV3, targetIds: readonly string[]): string[] {
  const nodes = [candidate.overview, ...candidate.systems, ...candidate.claims, ...candidate.actions,
    ...candidate.questions, ...candidate.knowledgeSources];
  return targetIds.filter((id) => nodes.filter((node) => node.id === id).length > 1);
}

function assessmentNodeDependencies(node: AssessmentRepairReplacement): string[] {
  if (node.nodeType === 'claim') return node.value.knowledgeSourceIds;
  if (node.nodeType === 'action') return [...node.value.claimIds, ...node.value.knowledgeSourceIds];
  if (node.nodeType === 'question') return node.value.relatedClaimIds;
  if (node.nodeType === 'overview' || node.nodeType === 'system') return [...node.value.claimIds, ...node.value.actionIds];
  return [];
}

type ClinicalNode = MemberAssessmentCandidateV3['overview'] | MemberAssessmentCandidateV3['systems'][number]
  | MemberAssessmentCandidateV3['claims'][number] | MemberAssessmentCandidateV3['actions'][number]
  | MemberAssessmentCandidateV3['questions'][number];

function clinicalTargetNode(candidate: MemberAssessmentCandidateV3, id: string): ClinicalNode | undefined {
  return id === 'overview' ? candidate.overview
    : [...candidate.systems, ...candidate.claims, ...candidate.actions, ...candidate.questions].find((node) => node.id === id);
}

/** P04 只能在原授权范围内收窄；来源证明与最终依赖另由校验和本次回执负责。 */
export function focusedReviewBoundaryPreserved(
  original: MemberAssessmentCandidateV3,
  reviewed: MemberAssessmentCandidateV3,
  targetId: string,
  evidenceCatalog: MemberEvidenceRef[],
  referenceDate: string,
  suppliedKnowledgeIds: readonly string[] = [],
  rebuiltSystemStatusRestorations: readonly RebuiltSystemStatusRestoration[] = [],
  actionDependencyRebindings: readonly ActionDependencyRebinding[] = [],
  evidenceResolutions: readonly AssessmentEvidenceResolution[] = [],
  evidenceResolutionTargetIds: readonly string[] = []
): boolean {
  return inspectAssessmentReviewBoundary(original, reviewed, targetId, evidenceCatalog, referenceDate,
    suppliedKnowledgeIds, rebuiltSystemStatusRestorations, actionDependencyRebindings, evidenceResolutions,
    evidenceResolutionTargetIds).preserved;
}

/** 漏回执只生成本地隔离项；重复、未知目标及错输入仍整份拒绝，绝不伪造模型pass。 */
export function completeFocusedReviewCoverage(candidate: MemberAssessmentCandidateV3,
  review: ClinicalFocusedReviewV1, targetIds: readonly string[]): { review: ClinicalFocusedReviewV1; missingIds: string[] } {
  if (review.personId !== candidate.personId || review.inputSignature !== candidate.inputSignature) {
    throw new Error('FOCUSED_REVIEW_SCOPE_MISMATCH');
  }
  const ids = review.results.map((result) => result.targetId);
  if (new Set(targetIds).size !== targetIds.length || new Set(ids).size !== ids.length
    || ids.some((id) => !targetIds.includes(id))) throw new Error('FOCUSED_REVIEW_COVERAGE_MISMATCH');
  const missingIds = targetIds.filter((id) => !ids.includes(id));
  return { missingIds, review: { ...review, results: [...review.results, ...missingIds.map((targetId) => ({
    targetId, verdict: 'hold' as const, reason: 'review_receipt_missing', replacement: null
  }))] } };
}

/** 同一次复核包含可能被主张变更影响的全部可见依赖，不在复核后另猜一版建议。 */
export function focusedReviewDependencyClosure(candidate: MemberAssessmentCandidateV3, targetIds: readonly string[]): string[] {
  const targets = new Set(targetIds);
  // 聚合说明可能把原主张的错误限制带回来。先把被选中的聚合节点实际前提一起交给同次复核，
  // 再向下游扩散；不只修摘要而把旧主张当成不可修改的只读依据。
  for (const aggregate of [candidate.overview, ...candidate.systems]) if (targets.has(aggregate.id)) {
    for (const id of aggregate.claimIds) {
      const claim = candidate.claims.find((item) => item.id === id);
      // 对带实质不确定性的解释核对其前提；已记录事实和仅知识归属目标不因此扩大权限。
      if (claim?.kind === 'interpretation' && claim.materialUncertainty !== null) targets.add(id);
    }
  }
  const claims = new Set(candidate.claims.filter((claim) => targets.has(claim.id)).map((claim) => claim.id));
  for (const action of candidate.actions) if (action.claimIds.some((id) => claims.has(id))) targets.add(action.id);
  for (const question of candidate.questions) if (question.relatedClaimIds.some((id) => claims.has(id))) targets.add(question.id);
  for (const system of candidate.systems) {
    if (system.claimIds.some((id) => claims.has(id)) || system.actionIds.some((id) => targets.has(id))) targets.add(system.id);
  }
  if (candidate.overview.claimIds.some((id) => claims.has(id)) || candidate.overview.actionIds.some((id) => targets.has(id))) targets.add('overview');
  return [...targets];
}

/** 诊断标准与指南制定的时间直接影响个人行动，不能只撤引用而留下无依据的医疗结论。 */
export function knowledgeDependentClinicalTargets(candidate: MemberAssessmentCandidateV3): string[] {
  const claims = new Set(candidate.claims.filter((claim) => claim.diagnosticStatus === 'criteria_met').map((claim) => claim.id));
  const actions = new Set(candidate.actions.filter((action) => action.timingBasis === 'guideline'
    || action.claimIds.some((id) => claims.has(id))).map((action) => action.id));
  const targets = new Set([...claims, ...actions]);
  for (const system of candidate.systems) {
    if (system.claimIds.some((id) => claims.has(id)) || system.actionIds.some((id) => actions.has(id))) targets.add(system.id);
  }
  if (candidate.overview.claimIds.some((id) => claims.has(id)) || candidate.overview.actionIds.some((id) => actions.has(id))) {
    targets.add('overview');
  }
  return [...targets];
}

/** 问题串的节点 ID 可以含冒号，不能用 split(':')[1] 截断。 */
function issueOwnerId(issue: string, nodeIds: string[]): string | null {
  const separator = issue.indexOf(':');
  if (separator < 0) return null;
  const detail = issue.slice(separator + 1);
  return [...nodeIds]
    .sort((left, right) => right.length - left.length)
    .find((id) => detail === id || detail.startsWith(`${id}:`)) ?? null;
}

export function repairTargets(candidate: MemberAssessmentCandidateV3, issues: string[]): string[] {
  const ids = new Set<string>();
  const nodeIds = ['overview', ...candidate.systems, ...candidate.claims, ...candidate.actions,
    ...candidate.questions, ...candidate.knowledgeSources].map((node) => typeof node === 'string' ? node : node.id);
  for (const issue of issues) {
    const nodeId = issueOwnerId(issue, nodeIds);
    if (nodeId && targetNode(candidate, nodeId)) ids.add(nodeId);
    if (issue.startsWith('duplicate_action_key:')) {
      const key = issue.slice('duplicate_action_key:'.length);
      for (const action of candidate.actions) if (action.dedupeKey === key) ids.add(action.id);
    }
    if (issue === 'overview_missing_claims' || issue.startsWith('unknown_claim:overview:')
      || issue.startsWith('unknown_action:overview:')) ids.add('overview');
  }
  // 一条主张或行动的修正可能改变引用它的可见摘要；只放开有明确 ID 依赖的节点。
  const affectedClaims = new Set(candidate.claims.filter((claim) => ids.has(claim.id)).map((claim) => claim.id));
  const affectedKnowledge = new Set(candidate.knowledgeSources.filter((source) => ids.has(source.id)).map((source) => source.id));
  for (const claim of candidate.claims) {
    if (claim.knowledgeSourceIds.some((id) => affectedKnowledge.has(id))) {
      ids.add(claim.id);
      affectedClaims.add(claim.id);
    }
  }
  for (const action of candidate.actions) {
    if (action.claimIds.some((id) => affectedClaims.has(id))
      || action.knowledgeSourceIds.some((id) => affectedKnowledge.has(id))) ids.add(action.id);
  }
  for (const question of candidate.questions) {
    if (question.relatedClaimIds.some((id) => affectedClaims.has(id))) ids.add(question.id);
  }
  for (const system of candidate.systems) {
    if (system.claimIds.some((id) => affectedClaims.has(id))
      || system.actionIds.some((id) => ids.has(id))) ids.add(system.id);
  }
  if (candidate.overview.claimIds.some((id) => affectedClaims.has(id))
    || candidate.overview.actionIds.some((id) => ids.has(id))) ids.add('overview');
  return [...ids];
}

/** 权限与修复义务分开：依赖节点不能只出现在权限表而没有具体要核对的问题。 */
export function buildAssessmentRepairRequest(candidate: MemberAssessmentCandidateV3, issues: string[],
  evidenceCatalog: readonly MemberEvidenceRef[],
  facts: readonly Pick<MemberEvidencePackageV3['facts'][number], 'observationId' | 'clinicalDate'>[] = []): AssessmentRepairRequestV1 {
  const targets = repairTargets(candidate, issues);
  if (ambiguousRepairTargets(candidate, targets).length > 0) throw new Error('assessment_repair_ambiguous_target');
  const targetSet = new Set(targets);
  const nodes = new Map(targets.map((id) => [id, assessmentRepairNode(candidate, id)!]));
  const ownIssues = new Map(targets.map((id) => [id, issues.filter((issue) => {
    if (issue.startsWith('duplicate_action_key:')) return nodes.get(id)?.nodeType === 'action'
      && (nodes.get(id) as Extract<AssessmentRepairReplacement, { nodeType: 'action' }>).value.dedupeKey
        === issue.slice('duplicate_action_key:'.length);
    return issueOwnerId(issue, targets) === id || id === 'overview' && issue === 'overview_missing_claims';
  })]));
  const triggerIssues = (id: string, seen = new Set<string>()): string[] => {
    if (seen.has(id)) return [];
    const next = new Set([...seen, id]);
    return [...new Set([...(ownIssues.get(id) ?? []), ...assessmentNodeDependencies(nodes.get(id)!)
      .filter((dependency) => targetSet.has(dependency)).flatMap((dependency) => triggerIssues(dependency, next))])];
  };
  const personalEvidence = new Set(evidenceCatalog.filter((ref) => ref.kind === 'observation' || ref.kind === 'user_note'
    || ref.kind === 'clinical_finding' || ref.kind === 'source_span').map((ref) => ref.id));
  return { schemaVersion: 1, stage: 'assessment', personId: candidate.personId,
    inputSignature: candidate.inputSignature, originalCandidateHash: stableHash(candidate), targets,
    allowedPaths: targets.map((id) => id === 'overview' ? 'overview' : `node:${id}`), issues,
    targetDetails: targets.map((id) => {
      const node = nodes.get(id)!;
      const remainingClaimIds = assessmentNodeDependencies(node)
        .filter((dependency) => !targetSet.has(dependency) && candidate.claims.some((claim) => claim.id === dependency));
      const remainingClaims = candidate.claims.filter((claim) => remainingClaimIds.includes(claim.id));
      const refs = 'evidenceIds' in node.value ? node.value.evidenceIds : [];
      const needsSourceQuote = ownIssues.get(id)!.some((issue) => issue.startsWith('documented_source_not_proven:')
        || issue.startsWith('documented_plan_') || issue.startsWith('limitation_source_check_required:'));
      // complete 缓存可省略原页，但原报告安排校验仍需要完整主题、否定、条件和期限。
      const sourceQuotes = needsSourceQuote ? evidenceCatalog.filter((ref) => refs.includes(ref.id)
        && ['observation', 'clinical_finding', 'source_span'].includes(ref.kind)
        && ref.documentId !== null && ref.sourceSpanId !== null && Boolean(ref.quote?.trim()))
        .map((ref) => ({ evidenceId: ref.id, quote: ref.quote!,
          clinicalDate: facts.find((fact) => fact.observationId === ref.observationId)?.clinicalDate ?? null })) : [];
      return { targetId: id, nodeType: node.nodeType,
        role: ownIssues.get(id)!.length ? 'issue_owner' : 'dependent', ownIssues: ownIssues.get(id)!,
        dependsOnIds: assessmentNodeDependencies(node).filter((dependency) => targetSet.has(dependency)),
        triggerIssues: triggerIssues(id), remainingClaimIds,
        remainingEvidenceIds: [...new Set([...refs, ...remainingClaims.flatMap((claim) => claim.evidenceIds)])]
          .filter((ref) => personalEvidence.has(ref)), ...(sourceQuotes.length ? { sourceQuotes } : {}) };
    }) };
}

export type AssessmentRepairMergeResult = { candidate: MemberAssessmentCandidateV3; reason: null }
  | { candidate: null; reason: string; schemaIssues?: AssessmentRepairSchemaIssue[]; schemaIssueCount?: number };

/** 只合并完整覆盖的授权替换；不让 P03 承担复制非目标内容或做 P04 隔离的职责。 */
export function mergeAssessmentRepair(candidate: MemberAssessmentCandidateV3, request: AssessmentRepairRequestV1,
  output: unknown): AssessmentRepairMergeResult {
  const parsed = memberAssessmentRepairV1Schema.safeParse(output);
  if (!parsed.success) return { candidate: null, reason: 'assessment_repair_schema_invalid', ...safeRepairSchemaIssues(parsed.error) };
  const repaired = parsed.data;
  if (ambiguousRepairTargets(candidate, request.targets).length > 0) {
    return { candidate: null, reason: 'assessment_repair_ambiguous_target' };
  }
  if (request.personId !== candidate.personId || request.inputSignature !== candidate.inputSignature
    || repaired.personId !== candidate.personId || repaired.inputSignature !== candidate.inputSignature
    || repaired.originalCandidateHash !== stableHash(candidate) || repaired.originalCandidateHash !== request.originalCandidateHash) {
    return { candidate: null, reason: 'assessment_repair_binding_mismatch' };
  }
  const allowed = new Set(request.targets);
  const resultIds = repaired.results.map((result) => result.targetId);
  if (allowed.size !== request.targets.length || new Set(resultIds).size !== resultIds.length
    || resultIds.length !== allowed.size || resultIds.some((id) => !allowed.has(id))) {
    return { candidate: null, reason: 'assessment_repair_target_coverage_mismatch' };
  }
  const replacements = new Map<string, AssessmentRepairReplacement>();
  for (const result of repaired.results) {
    const original = assessmentRepairNode(candidate, result.targetId);
    if (!original) return { candidate: null, reason: 'assessment_repair_target_unknown' };
    if (result.verdict === 'unchanged') {
      if (result.replacement !== null) return { candidate: null, reason: 'assessment_repair_unexpected_replacement' };
      continue;
    }
    if (!result.replacement || result.replacement.nodeType !== original.nodeType
      || result.replacement.value.id !== result.targetId) {
      return { candidate: null, reason: 'assessment_repair_replacement_scope_mismatch' };
    }
    replacements.set(result.targetId, result.replacement);
  }
  const merged = { ...candidate,
    overview: (replacements.get('overview')?.value ?? candidate.overview) as MemberAssessmentCandidateV3['overview'] };
  const nodeTypes = { systems: 'system', claims: 'claim', actions: 'action', questions: 'question',
    knowledgeSources: 'knowledge_source' } as const;
  for (const key of ['systems', 'claims', 'actions', 'questions', 'knowledgeSources'] as const) {
    // 节点类型和 ID 已逐一核对；数组顺序、未授权字段和未授权原节点原样保留。
    Object.assign(merged, { [key]: candidate[key].map((node) => {
      const replacement = replacements.get(node.id);
      return replacement?.nodeType === nodeTypes[key] ? replacement.value : node;
    }) });
  }
  return { candidate: merged, reason: null };
}

export function repairChangedOnlyAllowed(
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

/** 仅隔离明确归属的节点；撤下有问题的整条内容，不替临床断言放行，也不牵连独立节点。 */
function isolatableTargets(candidate: MemberAssessmentCandidateV3, issues: string[]): string[] | null {
  const allowed = new Set([
    'unknown_evidence', 'unknown_trend', 'unknown_knowledge', 'personal_evidence_required',
    'personal_diagnostic_evidence_required', 'documented_source_not_proven', 'documented_plan_source_not_proven',
    'documented_plan_instruction_not_proven', 'documented_plan_timing_not_proven', 'documented_plan_title_not_supported',
    'criteria_not_proven', 'criteria_wrong_status', 'diagnostic_fields_without_status', 'high_impact_claim_untyped',
    'diagnostic_fields_incomplete', 'claim_system_outside_scope', 'action_system_outside_scope',
    'action_personal_evidence_required', 'direct_medication_change', 'unsourced_probability',
    'unknown_claim', 'process_narrative', 'historical_current_contradiction', 'unknown_normal_contradiction',
    'diagnostic_title_contradiction', 'missing_exam_scope',
    'lifestyle_metadata_incomplete', 'general_lifestyle_not_low_risk', 'independent_habit_dependency_repair_required',
    'source_instruction', 'comparison_evidence_scope', 'comparison_same_record',
    'comparison_history_required', 'comparison_first_record_conflict'
  ]);
  const clinicalNodes = [...candidate.claims, ...candidate.actions, ...candidate.questions].map((item) => item.id);
  const aggregateNodes = ['overview', ...candidate.systems.map((item) => item.id)];
  const nodes = [...aggregateNodes, ...clinicalNodes];
  const targets = new Set<string>();
  for (const issue of issues) {
    const kind = issue.slice(0, issue.indexOf(':'));
    const owner = issueOwnerId(issue, nodes);
    const aggregateIssue = kind === 'process_narrative' || kind === 'historical_current_contradiction'
      || kind === 'unknown_normal_contradiction' || kind === 'diagnostic_title_contradiction'
      || kind === 'missing_exam_scope';
    if (kind === 'unsupported_high_impact_text' && owner && nodes.includes(owner)
      && issue === `unsupported_high_impact_text:${owner}`) {
      targets.add(owner);
      continue;
    }
    if (!allowed.has(kind) || !owner || !clinicalNodes.includes(owner) && !aggregateIssue) return null;
    targets.add(owner);
  }
  return targets.size > 0 ? [...targets] : null;
}

/** 只撤下一个完整且已明确无支持的高影响断言；不拆句、不删检查条件或混合限制。 */
function quarantineUnsupportedAggregateAssertions(candidate: MemberAssessmentCandidateV3, issues: readonly string[]): MemberAssessmentCandidateV3 {
  const quarantine = <T extends MemberAssessmentCandidateV3['overview'] | MemberAssessmentCandidateV3['systems'][number]>(node: T): T => {
    if (!issues.includes(`unsupported_high_impact_text:${node.id}`)) return node;
    const limitations = node.limitations.filter((value) => {
      const assertions = highConsequenceAssertionMentions(value);
      if (assertions.length !== 1) return true;
      const assertion = assertions[0]!;
      const disease = assertion.diseaseName.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
      // 只匹配完整单一语气+病名。任何原因、条件、症状、否定限定或并列文字均不能被裁掉。
      if (!new RegExp(`^(?:尚?不能排除|无法排除|未能排除|可能|考虑|疑似|提示)\\s*${disease}[。.!！]?$`, 'u').test(value.trim())) return true;
      const supported = candidate.claims.some((claim) => node.claimIds.includes(claim.id)
        && claim.kind === 'diagnostic_assessment' && claim.diagnosticStatus !== null && claim.diseaseName !== null
        && visibleAssessmentTextFields(claim).filter(({ field }) => field !== 'diseaseName')
          .some(({ text }) => highConsequenceAssertionMentions(text).some((direction) =>
            direction.diseaseName === assertion.diseaseName && (!assertion.definite || direction.definite
              && (claim.diagnosticStatus === 'documented' || claim.diagnosticStatus === 'criteria_met')))));
      return supported;
    });
    return limitations.length === node.limitations.length ? node : { ...node, limitations };
  };
  return { ...candidate, overview: quarantine(candidate.overview), systems: candidate.systems.map(quarantine) };
}

function isolateInvalidNodes(candidate: MemberAssessmentCandidateV3, issues: string[], deferIndependentHabitRepair = false) {
  const targets = isolatableTargets(candidate, issues);
  if (!targets) return null;
  // 原汇总完整保留在审计。只移走已确认无支持的独立断言，所有其他限制仍参与重建与校验。
  const rebuildSource = quarantineUnsupportedAggregateAssertions(candidate, issues);
  const review: ClinicalFocusedReviewV1 = {
    schemaVersion: 1, personId: candidate.personId, inputSignature: candidate.inputSignature,
    results: targets.map((targetId) => ({
      targetId, verdict: 'hold', reason: '局部修复后仍无法通过本地证据校验。', replacement: null
    }))
  };
  return applyFocusedReview(rebuildSource, review, targets, { deferIndependentHabitRepair });
}

/** 最后一轮依赖隔离可能使旧摘要失去前提；只作有界本地撤下，不再请求模型或改临床正文。 */
export function finalizeAssessmentLocalIssues(original: MemberAssessmentCandidateV3,
  validate: (candidate: MemberAssessmentCandidateV3) => string[]): {
    candidate: MemberAssessmentCandidateV3 | null; issues: string[];
    steps: Array<{ before: MemberAssessmentCandidateV3; issues: string[]; heldTargetIds: string[]; rebuiltNodeIds: string[] }>;
  } {
  let candidate = original;
  const steps: Array<{ before: MemberAssessmentCandidateV3; issues: string[]; heldTargetIds: string[]; rebuiltNodeIds: string[] }> = [];
  for (let pass = 0; pass < 6; pass += 1) {
    const issues = validate(candidate);
    if (!issues.length) return { candidate, issues, steps };
    // 来源/身份/引用存在性不是可猜测的局部内容缺口，最终防线仍拒绝外来或未知证据。
    if (issues.some((issue) => /^(?:unknown_evidence|unknown_knowledge|unknown_catalog_source|retrieved_source_unverifiable|unknown_claim|unknown_action|unknown_trend)(?::|$)/u.test(issue))) {
      return { candidate: null, issues, steps };
    }
    const targets = isolatableTargets(candidate, issues);
    if (!targets) return { candidate: null, issues, steps };
    // 与前置隔离共用逐条保护。无法证明可撤下的混合限制继续保留，不以删条件换取发布。
    const source = quarantineUnsupportedAggregateAssertions(candidate, issues);
    const isolated = applyFocusedReview(source, { schemaVersion: 1, personId: candidate.personId,
      inputSignature: candidate.inputSignature, results: targets.map((targetId) => ({
        targetId, verdict: 'hold', reason: '最终依赖校验隔离局部内容。', replacement: null
      })) }, targets, { finalDependencyGraph: true });
    steps.push({ before: candidate, issues, heldTargetIds: isolated.heldTargetIds, rebuiltNodeIds: isolated.rebuiltNodeIds });
    if (stableHash(candidate) === stableHash(isolated.candidate)) return { candidate: null, issues, steps };
    candidate = isolated.candidate;
  }
  const issues = validate(candidate);
  return { candidate: issues.length ? null : candidate, issues, steps };
}

/** 关联主张只用于核对问句前提，不增加 P04 对这些主张的替换权限。 */
export function focusedReviewSourceContext(candidate: MemberAssessmentCandidateV3, targetIds: readonly string[],
  evidencePackage: MemberEvidencePackageV3, analysisReferenceDate: string,
  retrievedKnowledge: readonly OfficialKnowledgeReceipt[] = []) {
  const targets = new Set(targetIds);
  const questions = candidate.questions.filter((question) => targets.has(question.id));
  const aggregates = [candidate.overview, ...candidate.systems].filter((node) => targets.has(node.id));
  const aggregateActionIds = new Set(aggregates.flatMap((node) => node.actionIds));
  const actions = candidate.actions.filter((action) => targets.has(action.id) || aggregateActionIds.has(action.id));
  const relatedClaimIds = new Set([...aggregates.flatMap((node) => node.claimIds),
    ...questions.flatMap((question) => question.relatedClaimIds), ...actions.flatMap((action) => action.claimIds)]);
  const relevantClaims = candidate.claims.filter((claim) => targets.has(claim.id) || relatedClaimIds.has(claim.id));
  const relevantEvidenceIds = new Set([
    ...relevantClaims.flatMap((claim) => [...claim.evidenceIds, ...claim.counterEvidenceIds]),
    ...actions.flatMap((action) => action.evidenceIds),
    ...questions.flatMap((question) => question.evidenceIds)
  ]);
  const anchors = evidencePackage.evidenceCatalog.filter((source) => relevantEvidenceIds.has(source.id));
  // 只补同一正式事实/原文位置的别名供模型核对，不能借同页或同值引入无关资料。
  for (const source of evidencePackage.evidenceCatalog) {
    if (anchors.some((anchor) => sameAssessmentFactLocation(anchor, source))) relevantEvidenceIds.add(source.id);
  }
  // 日期投影是逐项来源关系；仅传原句会让复核把空 clinicalDate 误当成整份报告无日期。
  // 只带本次实际引用事实的时间背景，不借同报告扩入其他项目或授予日期替换权限。
  const relevantObservationIds = new Set(evidencePackage.evidenceCatalog
    .filter((source) => relevantEvidenceIds.has(source.id) && source.observationId)
    .map((source) => source.observationId));
  const factTimes = evidencePackage.facts.filter((fact) => relevantObservationIds.has(fact.observationId))
    .map((fact) => ({ observationId: fact.observationId, documentId: fact.documentId,
      clinicalDate: fact.clinicalDate,
      ...(fact.effectiveTime ? { effectiveTime: fact.effectiveTime } : {}),
      ...(fact.sourceTime ? { sourceTime: fact.sourceTime } : {}) }));
  return {
    evidenceCatalog: evidencePackage.evidenceCatalog.filter((source) => relevantEvidenceIds.has(source.id)),
    factTimes,
    readOnlyClaims: relevantClaims.filter((claim) => !targets.has(claim.id)),
    readOnlyActions: actions.filter((action) => !targets.has(action.id)),
    knowledge: evidencePackage.knowledge,
    criteriaSets: evidencePackage.criteriaSets,
    sourceInstructions: buildAssessmentSourceInstructionReviewContext(candidate, [...targets], evidencePackage),
    ...(retrievedKnowledge.length ? { retrievedKnowledge: retrievedKnowledge.map((source) => ({
      sourceId: source.sourceId, url: source.url, finalUrl: source.finalUrl, content: source.content.slice(0, 24_000),
      contentFormat: source.contentFormat, contentScope: source.contentScope,
      contentRange: { start: 0, end: Math.min(source.content.length, 24_000), total: source.content.length,
        partial: source.content.length > 24_000 },
      providedContentHash: stableHash(source.content.slice(0, 24_000)),
      contentHash: source.contentHash, checkedAt: source.checkedAt, toolReceiptId: source.toolReceiptId
    })) } : {}),
    analysisReferenceDate
  };
}

/**
 * 只在主 P04 发出前冻结真实提供的前提与完整来源。新增依赖不是新增事实授权：
 * 后续仍须显式 replace、原行动固定字段不变、前提最终存活且获得同次合法复核凭据。
 * 不能以部分来源重合、同 ID、模型 pass 或后置日常补救冒充同次已核对输入。
 */
export function buildActionDependencyRebindings(
  candidate: MemberAssessmentCandidateV3, targetIds: readonly string[],
  sourceContext: Pick<ReturnType<typeof focusedReviewSourceContext>, 'readOnlyClaims' | 'evidenceCatalog'>,
  evidenceCatalog: readonly MemberEvidenceRef[]
): ActionDependencyRebinding[] {
  const visibleClaims = [...candidate.claims.filter((claim) => targetIds.includes(claim.id)), ...sourceContext.readOnlyClaims];
  const claims: ActionDependencyRebinding['claims'][number][] = [];
  for (const claim of visibleClaims) {
    const originals = candidate.claims.filter((node) => node.id === claim.id);
    if (originals.length !== 1 || ambiguousRepairTargets(candidate, [claim.id]).length > 0
      || visibleClaims.filter((node) => node.id === claim.id).length !== 1
      || stableHash(originals[0]) !== stableHash(claim) || claim.evidenceIds.length === 0) continue;
    const sourceHashes: Array<{ id: string; hash: string }> = [];
    for (const id of new Set([...claim.evidenceIds, ...claim.counterEvidenceIds])) {
      const supplied = sourceContext.evidenceCatalog.filter((source) => source.id === id);
      const actual = evidenceCatalog.filter((source) => source.id === id);
      const source = actual.length === 1 ? actual[0] : undefined;
      const traceable = source && source.knowledgeId === null && Boolean(source.quote?.trim())
        && (source.kind === 'user_note' || ['observation', 'clinical_finding', 'source_span'].includes(source.kind)
          && Boolean(source.documentId && source.sourceSpanId));
      if (!traceable || supplied.length !== 1 || stableHash(supplied[0]) !== stableHash(source)) break;
      sourceHashes.push({ id, hash: stableHash(source) });
    }
    if (sourceHashes.length !== new Set([...claim.evidenceIds, ...claim.counterEvidenceIds]).size) continue;
    claims.push({ id: claim.id, inputHash: stableHash(claim), reviewedHash: null, sourceHashes });
  }
  return candidate.actions.filter((action) => targetIds.includes(action.id)
    && ambiguousRepairTargets(candidate, [action.id]).length === 0).map((action) => ({
    targetId: action.id, personId: candidate.personId, inputSignature: candidate.inputSignature,
    originalActionHash: stableHash(action), claims
  }));
}

/**
 * 只在主 P04 合并后执行一次。只读/通过前提不得变化；显式替换前提须先独立通过原边界。
 * 合法日期收窄可与原建议一起被同次 P04 核对，但之后 P03 或隔离的任何变化都会使哈希失效。
 */
export function finalizeActionDependencyRebindings(
  original: MemberAssessmentCandidateV3, reviewed: MemberAssessmentCandidateV3,
  review: ClinicalFocusedReviewV1, clinicalTargetIds: readonly string[],
  offered: readonly ActionDependencyRebinding[], evidenceCatalog: readonly MemberEvidenceRef[],
  referenceDate: string, locallyInvalidTargetIds: readonly string[], suppliedKnowledgeIds: readonly string[] = []
): ActionDependencyRebinding[] {
  if (review.personId !== original.personId || review.inputSignature !== original.inputSignature
    || reviewed.personId !== original.personId || reviewed.inputSignature !== original.inputSignature) return [];
  return offered.filter((permission) => clinicalTargetIds.includes(permission.targetId)
    && review.results.some((result) => result.targetId === permission.targetId && result.verdict === 'replace'
      && result.replacement?.nodeType === 'action')).map((permission) => ({ ...permission,
    claims: permission.claims.flatMap((grant) => {
      const before = original.claims.filter((claim) => claim.id === grant.id);
      const after = reviewed.claims.filter((claim) => claim.id === grant.id);
      const results = review.results.filter((result) => result.targetId === grant.id);
      if (before.length !== 1 || after.length !== 1 || ambiguousRepairTargets(original, [grant.id]).length > 0
        || ambiguousRepairTargets(reviewed, [grant.id]).length > 0 || stableHash(before[0]) !== grant.inputHash
        || after[0]!.evidenceIds.length === 0 || locallyInvalidTargetIds.includes(grant.id)
        || grant.sourceHashes.some((frozen) => {
          const sources = evidenceCatalog.filter((source) => source.id === frozen.id);
          return sources.length !== 1 || stableHash(sources[0]) !== frozen.hash;
        })) return [];
      const claimReview = results.length === 1 ? results[0] : undefined;
      const unchanged = stableHash(after[0]) === grant.inputHash;
      const sameInput = clinicalTargetIds.includes(grant.id)
        ? claimReview?.verdict === 'pass' && unchanged
        : results.length === 0 && unchanged;
      const validReplacement = clinicalTargetIds.includes(grant.id) && claimReview?.verdict === 'replace'
        && claimReview.replacement?.nodeType === 'claim' && stableHash(claimReview.replacement.value) === stableHash(after[0])
        && inspectAssessmentReviewBoundary(original, reviewed, grant.id, evidenceCatalog, referenceDate,
          suppliedKnowledgeIds).preserved;
      if (!sameInput && !validReplacement) return [];
      return [{ ...grant, reviewedHash: stableHash(after[0]) }];
    })
  }));
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
    private readonly analysisReferenceDate = new Date().toISOString().slice(0, 10),
    private readonly webSearchAllowed = true,
    private readonly knowledgeTransport?: OfficialKnowledgeTransport
  ) {}

  private async runTurn(stage: string, input: Parameters<StructuredRuntime['runStructuredTurn']>[0], inputSignature: string,
    onActualSend: () => void) {
    if (!this.executionGuard || !this.transmissionDocumentId) { onActualSend(); return this.runtime.runStructuredTurn(input); }
    const guard = this.executionGuard;
    const documentId = this.transmissionDocumentId;
    const signature = stableHash({ version: 1, stage, inputSignature,
      consentId: guard.consentId, jobId: guard.jobId, modelId: this.modelId,
      reasoningEffort: this.reasoningEffort, promptVersion: MEMBER_ASSESSMENT_PROMPT_VERSION,
      rulesVersion: MEMBER_ASSESSMENT_RULES_VERSION, input });
    return runCheckpointedAssessmentTurn({ signature,
      assertActive: () => this.store.assertJobExecutionActive(guard, documentId),
      read: () => this.store.getAssessmentTurnCheckpoint(guard, documentId, signature),
      save: (output) => this.store.saveAssessmentTurnCheckpoint({ guard, documentId, signature, output }),
      run: () => { onActualSend(); return this.transmitTurn(stage, input); } });
  }

  private async transmitTurn(stage: string, input: Parameters<StructuredRuntime['runStructuredTurn']>[0]) {
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
      // 工作区可能已关闭或任务已撤权；清理失败不能制造迟到写入，也不覆盖真实传输异常。
      try {
        this.store.assertJobExecutionActive(this.executionGuard, this.transmissionDocumentId);
        this.store.finishAiTransmission(transmissionId, 'unknown');
      } catch { /* 仍保留既有 sending/未知回执，下一次恢复按终态未知处理。 */ }
      throw error;
    }
  }

  async process(personId: string): Promise<MemberAssessmentExecutionResult> {
    const built = buildMemberAssessmentInput(this.store, personId, {
      modelId: this.modelId, reasoningEffort: this.reasoningEffort,
      analysisReferenceDate: this.analysisReferenceDate, webSearchAllowed: this.webSearchAllowed
    });
    const { request, evidencePackage } = built;
    // request 会在临床条件准备完成后替换签名；结果必须绑定真正发送的最终输入。
    const executionBinding = () => ({ inputSignature: request.inputSignature, factRevision: built.factRevision,
      contextRevision: built.contextRevision, reviewScopeSignature: built.reviewScopeSignature });
    let analysisEvidenceCatalog = built.analysisEvidenceCatalog;
    if (evidencePackage.facts.length === 0 && evidencePackage.personalContext.length === 0) {
      return { status: 'skipped', reason: 'no_accepted_facts', callCount: 0, ...executionBinding() };
    }
    // 已接纳但尚未归入身体系统的事实仍可产生成员总览，不强行猜测器官归属。
    const assertInputStillAuthorized = () => {
      if (!this.store.isOpen()) throw new Error('WORKSPACE_CLOSED');
      if (this.store.getFactRevision(personId) !== built.factRevision) throw new Error('MEMBER_ASSESSMENT_FACT_REVISION_CONFLICT');
      if (this.store.getClinicalContextRevision(personId) !== built.contextRevision) throw new Error('MEMBER_ASSESSMENT_CONTEXT_REVISION_CONFLICT');
      if (this.store.getOpenReviewScopeSignature(personId) !== built.reviewScopeSignature) {
        throw new Error('MEMBER_ASSESSMENT_REVIEW_SCOPE_CONFLICT');
      }
      const current = new Map(this.store.listAcceptedObservations(personId)
        .map((observation) => [observation.id, observation.documentId]));
      const sentFacts = built.evidencePackage.facts.map((fact) => ({ id: fact.observationId, documentId: fact.documentId }));
      if (sentFacts.some((fact) => current.get(fact.id) !== fact.documentId)) {
        throw new Error('MEMBER_ASSESSMENT_EVIDENCE_MISMATCH');
      }
      if (this.executionGuard) this.store.assertObservationScopeActive(this.executionGuard, personId, sentFacts);
    };
    assertInputStillAuthorized();
    const current = this.store.listMemberAssessmentSnapshots(personId, true)
      .find((snapshot) => snapshot.inputSignature === request.inputSignature
        && snapshot.promptVersion === MEMBER_ASSESSMENT_PROMPT_VERSION
        && snapshot.rulesVersion === MEMBER_ASSESSMENT_RULES_VERSION
        && snapshot.factRevision === built.factRevision
        && snapshot.contextRevision === built.contextRevision);
    if (current) return { status: 'skipped', reason: 'signature_current', callCount: 0,
      snapshotId: current.id, ...executionBinding() };
    let calls = 0;
    // 两个阶段共享预算。前置依赖补救使用第二次机会后，P04 后不能再发第三次 P03。
    let repairTurns = 0;
    const maxRepairTurns = 2;
    const independentlyRepairedHabitIds = new Set<string>();
    const repairFailureReasons: string[] = [];
    const repairDiagnostics: AssessmentRepairDiagnostic[] = [];
    const focusedReviewDiagnostics: FocusedReviewDiagnostic[] = [];
    let reviewAudit: AssessmentReviewAuditCollector | null = null;
    // 只有经过本次有效 P04 的最终正文及依赖才能获得语义凭据；相同 ID 不是凭据。
    const semanticReviewReceipts = new Map<string, string>();
    let lastReceipt: { threadId: string; turnId: string } | null = null;
    const reject = (reason: string): MemberAssessmentExecutionResult => {
      if (this.executionGuard && this.transmissionDocumentId) this.store.saveAssessmentRejectionDiagnostic({
        guard: this.executionGuard, documentId: this.transmissionDocumentId, version: 1,
        inputSignature: request.inputSignature,
        reasonCodes: normalizeAssessmentRejectionCodes([reason, ...repairDiagnostics.flatMap((item) => item.remainingIssues),
          ...focusedReviewDiagnostics.flatMap((item) => item.boundaryReasonCodes ?? [])]),
        actualModelCalls: calls, repairAttemptCount: repairDiagnostics.length, focusedTargetCount: focusedReviewDiagnostics.length
      });
      return {
        status: 'rejected', reason, threadId: lastReceipt?.threadId ?? null,
        turnId: lastReceipt?.turnId ?? null, callCount: calls, ...executionBinding(),
        ...(repairDiagnostics.length ? { repairDiagnostics } : {}),
        ...(focusedReviewDiagnostics.length ? { focusedReviewDiagnostics } : {})
      };
    };
    const runCountedTurn = async (stage: string, input: Parameters<StructuredRuntime['runStructuredTurn']>[0]) => {
      // 构包后的事实/授权可能被撤销；每次真正发送前以原始发送范围重查，而非以当前列表替代旧包。
      assertInputStillAuthorized();
      assertAssessmentPromptFits(input.prompt);
      try {
        const result = await this.runTurn(stage, input, request.inputSignature, () => { calls += 1; });
        lastReceipt = result;
        return result;
      } catch (error) {
        if (isAssessmentContextLimit(error)) throw new Error('MEMBER_ASSESSMENT_INPUT_TOO_LARGE', { cause: error });
        throw error;
      }
    };
    const validationInputFor = (scopeRequest: AssessmentRequestV3, scopePackage: MemberEvidencePackageV3) => ({
      personId, inputSignature: scopeRequest.inputSignature, mode: scopeRequest.mode,
      requestedSystemIds: scopeRequest.requestedSystemIds,
      evidenceCatalog: scopePackage.evidenceCatalog,
      trendIds: buildMemberAnalysisPackage(scopePackage).trends.map((item) => item.id),
      catalogKnowledgeIds: scopePackage.knowledge.map((item) => item.id),
      criteriaSets: scopePackage.criteriaSets
    });
    const validateAndRepair = async (
      original: MemberAssessmentCandidateV3,
      scopeRequest: AssessmentRequestV3,
      scopePackage: MemberEvidencePackageV3,
      phase: 'before_review' | 'after_review' = 'before_review'
    ): Promise<{ candidate: MemberAssessmentCandidateV3 | null; heldTargetIds: string[]; rebuiltNodeIds: string[]; reason: string | null }> => {
      const validationInput = validationInputFor(scopeRequest, scopePackage);
      const initial = pruneUnreferencedInvalidKnowledge(
        canonicalizeAssessmentKnowledge(normalizeAssessmentStructuralFields(original), scopePackage), scopePackage.knowledge);
      let candidate = normalizeNewDocumentedPlanTitles(phase === 'before_review'
        ? bindAssessmentSourceInstructions(initial, scopePackage.facts, scopePackage.evidenceCatalog).candidate : initial,
      scopePackage.evidenceCatalog);
      let heldTargetIds: string[] = [];
      let rebuiltNodeIds: string[] = [];
      const pendingHabits = new Map<string, MemberAssessmentCandidateV3['actions'][number]>();
      const validateCandidate = () => {
        const validation = validateAssessmentCandidate(candidate, validationInput);
        const binding = bindAssessmentSourceInstructions(candidate, scopePackage.facts, scopePackage.evidenceCatalog);
        const bindingIssues = [...binding.issues, ...binding.boundActionIds.filter((id) =>
          candidate.actions.find((action) => action.id === id)?.firstStep
          !== binding.candidate.actions.find((action) => action.id === id)?.firstStep)
          .map((id) => `source_instruction:${id}:source_text_changed`)];
        const checked = filterAssessmentReviewIssues(candidate, [...validation.issues, ...bindingIssues],
          semanticReviewReceipts, scopePackage.evidenceCatalog);
        const issues = phase === 'before_review'
          ? partitionAssessmentReviewIssues(candidate, checked, scopePackage.evidenceCatalog).localIssues : checked;
        return { ...validation, issues: [...issues, ...[...pendingHabits.keys()]
          .filter((id) => candidate.actions.some((action) => action.id === id))
          .map((id) => `independent_habit_dependency_repair_required:${id}`)] };
      };
      const absorbIsolation = (isolated: NonNullable<ReturnType<typeof isolateInvalidNodes>>) => {
        reviewAudit?.localReasons(isolated.rebuiltNodeIds, ['local_dependency_graph_rebuilt']);
        candidate = isolated.candidate;
        heldTargetIds = [...new Set([...heldTargetIds, ...isolated.heldTargetIds])];
        rebuiltNodeIds = [...new Set([...rebuiltNodeIds, ...isolated.rebuiltNodeIds])];
      };
      const isolateIssues = (issues: string[], allowDependencyRepair: boolean) => {
        // 解释不完整不是证据失真。补写机会用尽后仍发布可靠内容，并保存未完成的主题清单。
        issues = issues.filter((issue) => !issue.startsWith('topic_comparison_missing:')
          && !issue.startsWith('limitation_source_check_required:'));
        if (issues.length === 0) return true;
        const before = candidate;
        const isolated = isolateInvalidNodes(before, issues, allowDependencyRepair);
        if (!isolated) return false;
        for (const id of [...isolated.heldTargetIds, ...isolated.rebuiltNodeIds]) {
          const ownIssues = issues.filter((issue) => repairTargets(before, [issue]).includes(id));
          reviewAudit?.localReasons([id], ownIssues.length ? ownIssues.map((issue) => issue.slice(0, 240))
            : ['local_validation_dependency_held']);
        }
        // Router 只负责暂存。修复资格另查真实个人依据；没有资格的行动不能因为非空 ID 获救。
        const originalActions = original.actions.filter((action) => before.actions.some((current) => current.id === action.id));
        const heldClaims = isolated.heldTargetIds.filter((id) => before.claims.some((claim) => claim.id === id));
        const explicitTargets = isolatableTargets(before, issues) ?? [];
        const eligible = new Set(findIndependentHabitRepairCandidateIds({ candidate: { claims: before.claims, actions: originalActions },
          heldClaimIds: heldClaims, heldActionIds: explicitTargets,
          evidenceCatalog: scopePackage.evidenceCatalog }));
        // 首次 P03 可能先删掉依赖边。必须从 P02 原图追踪受影响行动，不能以新图已断边冒充独立。
        const affectedIds = [...new Set([...isolated.dependentActionIds,
          ...originalActions.filter((action) => action.claimIds.some((id) => heldClaims.includes(id)))
            .map((action) => action.id)])].filter((id) => isolated.candidate.actions.some((action) => action.id === id));
        const ineligible: string[] = [];
        for (const id of affectedIds) {
          if (!eligible.has(id)) { ineligible.push(id); continue; }
          const baseline = originalActions.find((action) => action.id === id)!;
          const currentAction = isolated.candidate.actions.find((action) => action.id === id)!;
          if (phase === 'before_review' && !currentAction.claimIds.some((claimId) => heldClaims.includes(claimId))
            && isIndependentHabitRepairReplacement(baseline, currentAction)) {
            independentlyRepairedHabitIds.add(id);
            continue;
          }
          if (!allowDependencyRepair) { ineligible.push(id); continue; }
          // 资格和替换权限绑定 P02 的既有行动，不能先借普通 P03 换身份/补引用再获取救援权限。
          if (!pendingHabits.has(id)) pendingHabits.set(id, baseline);
        }
        absorbIsolation(isolated);
        if (ineligible.length > 0) absorbIsolation(applyFocusedReview(candidate, {
          schemaVersion: 1, personId, inputSignature: candidate.inputSignature,
          results: ineligible.map((targetId) => ({ targetId, verdict: 'hold',
            reason: '日常建议缺少独立个人依据。', replacement: null }))
        }, ineligible));
        return true;
      };
      // 有限循环只用于前置 P03 失败后的依赖补救，不重复 P02/P04，不按生活类别逐个调用。
      for (let pass = 0; pass <= maxRepairTurns; pass += 1) {
        let validation = validateCandidate();
        // 与现有局部修复合并，一次补齐本轮全部重点主题；不追加无上限的质量重试。
        if (phase === 'before_review' && pass === 0 && repairTurns === 0) {
          validation = { ...validation, issues: [...validation.issues, ...findMissingAssessmentComparisons(candidate),
            ...assessmentLimitationPreparationIssues(candidate, scopePackage.evidenceCatalog)] };
        }
        if (validation.issues.length === 0) return { candidate, heldTargetIds, rebuiltNodeIds, reason: null };
        // 身份、系统范围或重复 ID 不是可自由改写的局部错误。
        if (validation.issues.includes('scope_mismatch') || validation.issues.includes('system_scope_mismatch')
          || validation.issues.includes('duplicate_node_id')) {
          return { candidate: null, heldTargetIds, rebuiltNodeIds, reason: validation.issues.join(',') };
        }
        const targetIds = repairTargets(candidate, validation.issues);
        if (targetIds.length === 0) return { candidate: null, heldTargetIds, rebuiltNodeIds, reason: validation.issues.join(',') };
        if (ambiguousRepairTargets(candidate, targetIds).length > 0) {
          return { candidate: null, heldTargetIds, rebuiltNodeIds, reason: 'assessment_repair_ambiguous_target' };
        }
        if (repairTurns >= maxRepairTurns) {
          if (!isolateIssues(validation.issues, false)) {
            return { candidate: null, heldTargetIds, rebuiltNodeIds, reason: validation.issues.join(',') };
          }
          const remaining = validateCandidate().issues;
          return { candidate: remaining.length ? null : candidate, heldTargetIds, rebuiltNodeIds,
            reason: remaining.length ? remaining.join(',') : null };
        }
        const pendingHabitTargets = new Set(pendingHabits.keys());
        const repairRequest = buildAssessmentRepairRequest(candidate, validation.issues, scopePackage.evidenceCatalog, scopePackage.facts);
        // 与本轮实际明示的剩余来源绑定；存活主张的支持原文不是新的个人资料权限。
        const habitEvidenceScopes = new Map(repairRequest.targetDetails.flatMap((detail) => {
          const baseline = pendingHabits.get(detail.targetId);
          if (!baseline) return [];
          const permission = buildIndependentHabitEvidencePermission({ personId, inputSignature: scopeRequest.inputSignature,
            originalAction: baseline, survivingClaims: candidate.claims, heldClaimIds: heldTargetIds,
            evidenceCatalog: scopePackage.evidenceCatalog, suppliedEvidenceIds: detail.remainingEvidenceIds });
          return permission ? [[detail.targetId, { permission, personId, inputSignature: scopeRequest.inputSignature,
            survivingClaims: candidate.claims, heldClaimIds: heldTargetIds, evidenceCatalog: scopePackage.evidenceCatalog }] as const] : [];
        }));
        const repairTransport = createMemberAnalysisTransport(scopePackage, analysisEvidenceCatalog);
        const transportedRequest = repairTransport.aliasCandidate(repairRequest);
        // 独立可用依据也使用与目标 evidenceIds 相同的事实短编号，避免提示模型使用已省略的原引用。
        transportedRequest.targetDetails.forEach((detail, index) => {
          detail.remainingEvidenceIds = repairTransport.aliasCandidate({
            evidenceIds: repairRequest.targetDetails[index]!.remainingEvidenceIds
          }).evidenceIds;
          detail.sourceQuotes?.forEach((sourceQuote, sourceIndex) => {
            sourceQuote.evidenceId = repairTransport.aliasCandidate({
              evidenceIds: [repairRequest.targetDetails[index]!.sourceQuotes![sourceIndex]!.evidenceId]
            }).evidenceIds[0]!;
          });
        });
        repairTurns += 1;
        const repaired = await runCountedTurn('assessment_repair', {
          prompt: buildP03Prompt(transportedRequest, repairTransport.packet,
            repairTransport.aliasCandidate(targetIds.map((id) => ({ targetId: id, ...assessmentRepairNode(candidate, id)! })))),
          outputSchema: repairOutputSchema, allowWebSearch: false
        });
        const restoredRepair = repairTransport.restoreOutput(repaired.output);
        const repairMerged = mergeAssessmentRepair(candidate, repairRequest, restoredRepair);
        const parsedRepairAudit = memberAssessmentRepairV1Schema.safeParse(restoredRepair);
        // 合并失败仍保留可归属的本目标 before/after，不能再次只剩原因码。
        // 外来范围、重复目标或换 ID/类型的正文不绑定到本人的授权目标上。
        const repairAuditResults = parsedRepairAudit.success
          && parsedRepairAudit.data.personId === repairRequest.personId
          && parsedRepairAudit.data.inputSignature === repairRequest.inputSignature
          && parsedRepairAudit.data.originalCandidateHash === repairRequest.originalCandidateHash
          ? parsedRepairAudit.data.results.filter((result, _, all) => {
            const original = assessmentRepairNode(candidate, result.targetId);
            return targetIds.includes(result.targetId) && all.filter((item) => item.targetId === result.targetId).length === 1
              && original !== null && (result.verdict === 'unchanged' ? result.replacement === null
                : result.replacement?.nodeType === original.nodeType && result.replacement.value.id === result.targetId);
          }) : [];
        reviewAudit?.record(candidate, phase === 'before_review' ? 'p03_before_review' : 'p03_after_review',
          { ...repaired, stage: 'p03' }, repairAuditResults, targetIds);
        if (!repairMerged.candidate) reviewAudit?.localReasons(targetIds,
          [repairMerged.reason?.slice(0, 240) ?? 'assessment_repair_invalid']);
        const schemaAccepted = memberAssessmentRepairV1Schema.safeParse(restoredRepair).success;
        const diagnostic: AssessmentRepairDiagnostic = { originalCandidateHash: repairRequest.originalCandidateHash,
          targetIds: [...targetIds], schemaVerdict: schemaAccepted ? 'accepted' : 'invalid',
          scopeVerdict: !schemaAccepted ? 'not_checked' : repairMerged.candidate ? 'accepted' : 'invalid',
          initialIssues: [...validation.issues], remainingIssues: [], heldTargetIds: [], failureReason: repairMerged.reason,
          ...(!repairMerged.candidate && repairMerged.schemaIssues
            ? { schemaIssues: repairMerged.schemaIssues, schemaIssueCount: repairMerged.schemaIssueCount } : {}) };
        repairDiagnostics.push(diagnostic);
        const normalizedRepair = repairMerged.candidate
          ? canonicalizeAssessmentKnowledge(normalizeAssessmentStructuralFields(repairMerged.candidate), scopePackage) : null;
        const repairedCandidate = normalizedRepair && phase === 'before_review'
          ? bindAssessmentSourceInstructions(normalizedRepair, scopePackage.facts, scopePackage.evidenceCatalog).candidate : normalizedRepair;
        // 身份和整份范围错误不能通过丢弃局部节点掩盖，包括复核后的补救回执。
        const repairedScopeIssues = repairedCandidate
          ? validateAssessmentCandidate(repairedCandidate, validationInput).issues.filter((issue) =>
            ['scope_mismatch', 'system_scope_mismatch', 'duplicate_node_id'].includes(issue))
          : [];
        if (repairedScopeIssues.length > 0) {
          Object.assign(diagnostic, { scopeVerdict: 'invalid', remainingIssues: repairedScopeIssues,
            failureReason: repairedScopeIssues.join(',') });
          return { candidate: null, heldTargetIds, rebuiltNodeIds, reason: repairedScopeIssues.join(',') };
        }
        if (!repairedCandidate || !repairChangedOnlyAllowed(candidate, repairedCandidate, targetIds)) {
          const repairFailure = repairMerged.reason ?? 'assessment_repair_outside_scope';
          diagnostic.failureReason = repairFailure;
          if (repairedCandidate) diagnostic.scopeVerdict = 'invalid';
          diagnostic.remainingIssues = [...validation.issues];
          repairFailureReasons.push(repairFailure);
          if (!isolateIssues(validation.issues, phase === 'before_review' && repairTurns < maxRepairTurns)) {
            return { candidate: null, heldTargetIds, rebuiltNodeIds, reason: repairFailure };
          }
          diagnostic.heldTargetIds = [...heldTargetIds];
          // 失效主张已隔离；不要把刚暂存行动的 unknown_claim 再当成显式拒绝。
          if (pendingHabits.size > 0 && repairTurns < maxRepairTurns) continue;
        } else {
          // 先核对 P03 修改范围，再对允许修改的新候选标题归一，不能掩盖越权改写。
          candidate = normalizeNewDocumentedPlanTitles(repairedCandidate, scopePackage.evidenceCatalog);
        }
        // 独立改写必须实质撤去失效前提；只删引用/改标签不算修复。通过后仍交给唯一 P04。
        const invalidHabitRepairs: string[] = [];
        for (const [id, before] of pendingHabits) {
          if (!pendingHabitTargets.has(id) || !targetIds.includes(id)) continue;
          const after = candidate.actions.find((action) => action.id === id);
          const scope = habitEvidenceScopes.get(id);
          if (!after || !isIndependentHabitRepairReplacement(before, after, scope ? { ...scope,
            survivingClaims: candidate.claims, heldClaimIds: heldTargetIds } : undefined)) invalidHabitRepairs.push(id);
          else independentlyRepairedHabitIds.add(id);
          pendingHabits.delete(id);
        }
        if (invalidHabitRepairs.length > 0) {
          repairFailureReasons.push('independent_habit_repair_not_substantive');
          absorbIsolation(applyFocusedReview(candidate, {
            schemaVersion: 1, personId, inputSignature: candidate.inputSignature,
            results: invalidHabitRepairs.filter((id) => candidate.actions.some((action) => action.id === id))
              .map((targetId) => ({ targetId, verdict: 'hold', reason: '失效前提未得到独立改写。', replacement: null }))
          }, invalidHabitRepairs.filter((id) => candidate.actions.some((action) => action.id === id))));
        }
        validation = validateCandidate();
        if (!diagnostic.failureReason) diagnostic.remainingIssues = [...validation.issues];
        if (validation.issues.length > 0) {
          if (!isolateIssues(validation.issues, phase === 'before_review' && repairTurns < maxRepairTurns)) {
            return { candidate: null, heldTargetIds, rebuiltNodeIds, reason: validation.issues.join(',') };
          }
          diagnostic.heldTargetIds = [...heldTargetIds];
          validation = validateCandidate();
          if (validation.issues.length > 0) {
            if (pendingHabits.size > 0 && repairTurns < maxRepairTurns) continue;
            return { candidate: null, heldTargetIds, rebuiltNodeIds, reason: validation.issues.join(',') };
          }
        }
        diagnostic.heldTargetIds = [...heldTargetIds];
        return { candidate, heldTargetIds, rebuiltNodeIds, reason: null };
      }
      return { candidate: null, heldTargetIds, rebuiltNodeIds, reason: 'assessment_repair_budget_exhausted' };
    };

    this.onStage?.('analyze');
    await prepareClinicalRecords({ store: this.store, evidencePackage, personId,
      factRevision: built.factRevision, contextRevision: built.contextRevision,
      ...(this.executionGuard ? { executionGuard: this.executionGuard } : {}),
      assertActive: assertInputStillAuthorized,
      runTurn: (input) => runCountedTurn('prepare_clinical_context', input) });
    assertInputStillAuthorized();
    // 以实际落库的缓存重新构包并签名；并发写入时也不发布未持久化的另一份条件。
    const prepared = buildMemberAssessmentInput(this.store, personId, {
      modelId: this.modelId, reasoningEffort: this.reasoningEffort,
      analysisReferenceDate: this.analysisReferenceDate, webSearchAllowed: this.webSearchAllowed
    });
    assertInputStillAuthorized();
    Object.assign(request, prepared.request);
    Object.assign(evidencePackage, prepared.evidencePackage);
    analysisEvidenceCatalog = prepared.analysisEvidenceCatalog;
    const analysisRequest = request;
    const analysisPackage = evidencePackage;
    const transport = createMemberAnalysisTransport(evidencePackage, analysisEvidenceCatalog);
    const generated = await runCountedTurn('member_assessment', {
      prompt: buildP02Prompt(aliasMemberEvidenceReferences(request, transport.referenceIds), transport.packet), outputSchema: candidateOutputSchema,
      allowWebSearch: request.webSearchAllowed
    });
    const parsed = memberAssessmentCandidateV3Schema.safeParse(
      transport.restoreOutput(generated.output));
    if (!parsed.success) return reject('assessment_schema_invalid');
    const originalPriorityTopics = assessmentPriorityTopicKeys(parsed.data);
    reviewAudit = new AssessmentReviewAuditCollector(personId, request.inputSignature, parsed.data, { ...generated, stage: 'p02' });
    const validated = await validateAndRepair(parsed.data, analysisRequest, analysisPackage);
    if (!validated.candidate) return reject(validated.reason ?? 'assessment_validation_failed');
    let candidate = validated.candidate;
    // 只按本次已授权联网范围读取实际使用的官方公共知识页；不发送患者查询或报告原文。
    // 网页正文是外部待核对材料，不因 HTTP 成功就取得临床支持或发布权限。
    const retrievedKnowledge = this.executionGuard && this.transmissionDocumentId && request.webSearchAllowed
      ? (await resolveAssessmentKnowledgeContent(candidate, { assertActive: assertInputStillAuthorized,
        ...(this.knowledgeTransport ? { transport: this.knowledgeTransport } : {}),
        cacheRead: async (key) => this.store.getAssessmentTurnCheckpoint(this.executionGuard!, this.transmissionDocumentId!,
          stableHash({ kind: 'official_knowledge_content', key, inputSignature: request.inputSignature })) as OfficialKnowledgeReceipt | null,
        cacheSave: async (key, output) => this.store.saveAssessmentTurnCheckpoint({ guard: this.executionGuard!,
          documentId: this.transmissionDocumentId!,
          signature: stableHash({ kind: 'official_knowledge_content', key, inputSignature: request.inputSignature }), output }),
        onDiagnostic: (diagnostic) => this.store.saveAssessmentKnowledgeRetrievalDiagnostic({
          guard: this.executionGuard!, documentId: this.transmissionDocumentId!,
          inputSignature: request.inputSignature, ...diagnostic }) })).retrieved
      : [];
    let heldTargetIds = [...validated.heldTargetIds];
    let rebuiltNodeIds = [...validated.rebuiltNodeIds];
    let reviewedTargetIds: string[] = [];
    let validationMode: MemberAssessmentSnapshotV3['validationMode'] = 'local_only';
    // 只保留本批 P02 原已有的关注状态；来源隔离仍先回退中性，不能从历史快照或剩余条数猜状态。
    // 主 P04 可以基于最终存活支持明确恢复同一个状态，正常类状态不在此权限内。
    const rebuiltSystemStatusRestorations: RebuiltSystemStatusRestoration[] = candidate.systems.flatMap((system) => {
      const originals = parsed.data.systems.filter((node) => node.id === system.id && node.systemId === system.systemId);
      const original = originals.length === 1 ? originals[0] : undefined;
      return rebuiltNodeIds.includes(system.id) && system.status === 'insufficient'
        && original && (original.status === 'attention' || original.status === 'monitor')
        && hasSurvivingSystemSupport(candidate, system, evidencePackage.evidenceCatalog)
        ? [{ targetId: system.id, systemId: system.systemId, originalStatus: original.status }] : [];
    });
    const route = routeFocusedReview(candidate);
    const knowledgeRoute = routeKnowledgeAttributionReview(candidate, evidencePackage.knowledge);
    const knowledgeClinicalTargetIds = knowledgeDependentClinicalTargets(candidate);
    const independentHabitTargets = candidate.actions.filter((action) => independentlyRepairedHabitIds.has(action.id))
      .map((action) => action.id);
    const semanticRoute = partitionAssessmentReviewIssues(candidate,
      validateAssessmentCandidate(candidate, validationInputFor(analysisRequest, analysisPackage)).issues,
      evidencePackage.evidenceCatalog);
    const boundInstructionIds = bindAssessmentSourceInstructions(candidate, evidencePackage.facts,
      evidencePackage.evidenceCatalog).boundActionIds;
    // 文字规则认出“诊断”也不代表病史主体和限定已被证明；来源归因统一由同次模型复核。
    const documentedClaimIds = candidate.claims.filter((claim) => claim.diagnosticStatus === 'documented').map((claim) => claim.id);
    const limitationTargetIds = assessmentLimitationConsistencyTargets(candidate);
    // 无历史的范围说明沿既有风险路由；真正的变化判断并入同一次复核，不逐主题增开调用。
    const comparisonTargetIds = candidate.claims.filter((claim) => claim.changeAssessment
      && claim.changeAssessment.direction !== 'first_record').map((claim) => claim.id);
    const clinicalTargetIds = focusedReviewDependencyClosure(candidate,
      [...new Set([...route.targetIds, ...knowledgeClinicalTargetIds, ...independentHabitTargets,
        ...semanticRoute.targetIds, ...boundInstructionIds, ...documentedClaimIds, ...limitationTargetIds, ...comparisonTargetIds,
        ...rebuiltSystemStatusRestorations.map((item) => item.targetId)])]);
    const targetIds = [...new Set([...clinicalTargetIds, ...knowledgeRoute.targetIds])];
    const knowledgeOnlyTargetIds = knowledgeRoute.targetIds.filter((id) => !clinicalTargetIds.includes(id));
    if (targetIds.length > 0) {
      this.onStage?.('review_derived');
      const targetNodes = targetIds.map((id) => ({ id, node: targetNode(candidate, id) }));
      const sourceContext = focusedReviewSourceContext(candidate, targetIds, evidencePackage, request.analysisReferenceDate, retrievedKnowledge);
      const offeredActionDependencyRebindings = buildActionDependencyRebindings(candidate, clinicalTargetIds,
        sourceContext, evidencePackage.evidenceCatalog);
      const reviewed = await runCountedTurn('focused_review', {
        prompt: buildP04Prompt({ personId, inputSignature: request.inputSignature, targets: targetIds,
          knowledgeOnlyTargetIds, finalDependencyGraph: true, rebuiltSystemStatusRestorations,
          actionDependencyRebindings: offeredActionDependencyRebindings.map((permission) => ({ targetId: permission.targetId,
            allowedClaimIds: permission.claims.map((claim) => claim.id) })),
          reasons: [...route.reasons, ...knowledgeRoute.reasons,
            ...comparisonTargetIds.map((id) => `longitudinal_interpretation:${id}`),
            ...limitationTargetIds.map((id) => `limitation_source_consistency:${id}`),
            ...semanticRoute.semanticIssues.map((issue) => `semantic_review:${issue}`),
            ...documentedClaimIds.map((id) => `documented_attribution_review:${id}`),
            ...boundInstructionIds.map((id) => `source_instruction_role_review:${id}`),
            ...independentHabitTargets.map((id) => `independent_habit_basis_review:${id}`),
            ...knowledgeClinicalTargetIds.map((id) => `knowledge_dependent_clinical_review:${id}`)] }, sourceContext, targetNodes),
        outputSchema: reviewOutputSchema, allowWebSearch: false
      });
      const reviewParsed = clinicalFocusedReviewV1Schema.safeParse(reviewed.output);
      if (!reviewParsed.success) return reject('focused_review_schema_invalid');
      const receivedReviewResults = reviewParsed.data.results;
      const evidenceResolutionTargetIds = receivedReviewResults.filter((result) =>
        (result.evidenceResolutionProofs?.length ?? 0) > 0).map((result) => result.targetId);
      let missingReviewIds: string[];
      try {
        const coverage = completeFocusedReviewCoverage(candidate, reviewParsed.data, targetIds);
        missingReviewIds = coverage.missingIds;
        reviewParsed.data.results = coverage.review.results;
      } catch (error) { return reject(error instanceof Error ? error.message : 'focused_review_invalid'); }
      const originalCandidate = candidate;
      let actionDependencyRebindings: ActionDependencyRebinding[] = [];
      let evidenceResolutions: AssessmentEvidenceResolution[] = [];
      reviewAudit.record(originalCandidate, 'p04', { ...reviewed, stage: 'p04' }, receivedReviewResults, targetIds);
      reviewAudit.localReasons(missingReviewIds, ['review_receipt_missing']);
      // 仅追加固定技术类别；不保存模型解释、患者正文或具体前提内容，也不回填旧任务。
      const boundaryReasons = new Map<string, Set<FocusedReviewBoundaryReason>>();
      const recordBoundaryReasons = (id: string, ...reasons: FocusedReviewBoundaryReason[]) => {
        reviewAudit?.localReasons([id], reasons);
        const current = boundaryReasons.get(id) ?? new Set<FocusedReviewBoundaryReason>();
        reasons.forEach((reason) => current.add(reason));
        boundaryReasons.set(id, current);
      };
      const recordBoundaryInspection = (value: MemberAssessmentCandidateV3, id: string,
        phase?: 'p04_scope_boundary_changed' | 'post_review_scope_boundary_changed') => {
        recordBoundaryReasons(id, ...(phase ? [phase] : []), ...inspectAssessmentReviewBoundary(originalCandidate,
          value, id, evidencePackage.evidenceCatalog, request.analysisReferenceDate,
          evidencePackage.knowledge.map((source) => source.id), rebuiltSystemStatusRestorations, actionDependencyRebindings,
          evidenceResolutions, evidenceResolutionTargetIds).reasonCodes);
      };
      const boundaryDiagnostics = (id: string) => boundaryReasons.get(id)?.size
        ? { boundaryReasonCodes: [...boundaryReasons.get(id)!] } : {};
      const recordHeldDependencies = (value: MemberAssessmentCandidateV3, heldIds: readonly string[], rebuiltIds: readonly string[]) => {
        const held = new Set(heldIds);
        const claims = new Set(value.claims.filter((claim) => held.has(claim.id)).map((claim) => claim.id));
        for (const node of [...value.actions, ...value.questions]) {
          const dependencies = 'claimIds' in node ? node.claimIds : node.relatedClaimIds;
          if (held.has(node.id) && dependencies.some((id) => claims.has(id))) recordBoundaryReasons(node.id,
            'original_claim_dependency_held', 'held_claim_dependency_retained');
        }
        for (const node of [value.overview, ...value.systems].filter((node) => rebuiltIds.includes(node.id))) {
          if (node.claimIds.some((id) => claims.has(id))) recordBoundaryReasons(node.id, 'original_claim_dependency_held');
          if (node.actionIds.some((id) => held.has(id))) recordBoundaryReasons(node.id, 'original_action_dependency_held');
        }
      };
      let applied: ReturnType<typeof applyFocusedReview>;
      try {
        applied = applyFocusedReview(candidate, { ...reviewParsed.data,
          results: reviewParsed.data.results.filter((result) => clinicalTargetIds.includes(result.targetId)) }, clinicalTargetIds,
        { finalDependencyGraph: true });
        applied.candidate = applyKnowledgeAttributionReview(applied.candidate, { ...reviewParsed.data,
          results: reviewParsed.data.results.filter((result) => knowledgeOnlyTargetIds.includes(result.targetId)) },
        knowledgeOnlyTargetIds, evidencePackage.knowledge);
      }
      catch (error) { return reject(error instanceof Error ? error.message : 'focused_review_invalid'); }
      candidate = applied.candidate;
      evidenceResolutions = buildAssessmentEvidenceResolutions(originalCandidate, candidate,
        { ...reviewParsed.data, results: receivedReviewResults }, clinicalTargetIds, sourceContext.evidenceCatalog,
        evidencePackage.evidenceCatalog);
      const rebindingLocalIssues = partitionAssessmentReviewIssues(candidate,
        validateAssessmentCandidate(candidate, validationInputFor(analysisRequest, analysisPackage)).issues,
        evidencePackage.evidenceCatalog).localIssues;
      actionDependencyRebindings = finalizeActionDependencyRebindings(originalCandidate, candidate, reviewParsed.data,
        clinicalTargetIds, offeredActionDependencyRebindings, evidencePackage.evidenceCatalog,
        request.analysisReferenceDate, repairTargets(candidate, rebindingLocalIssues),
        evidencePackage.knowledge.map((source) => source.id));
      heldTargetIds = [...new Set([...heldTargetIds, ...applied.heldTargetIds])];
      rebuiltNodeIds = [...new Set([...rebuiltNodeIds, ...applied.rebuiltNodeIds])];
      for (const result of reviewParsed.data.results) if (result.verdict === 'hold') recordBoundaryReasons(result.targetId,
        missingReviewIds.includes(result.targetId) ? 'review_receipt_missing' : 'reviewer_hold');
      for (const id of applied.heldTargetIds) {
        const before = originalCandidate.actions.find((action) => action.id === id);
        const question = originalCandidate.questions.find((node) => node.id === id);
        const heldClaims = new Set(applied.heldTargetIds.filter((heldId) => originalCandidate.claims.some((claim) => claim.id === heldId)));
        const result = reviewParsed.data.results.find((item) => item.targetId === id);
        if (before?.claimIds.some((claimId) => heldClaims.has(claimId))) {
          const after = result?.replacement?.nodeType === 'action' ? result.replacement.value : before;
          recordBoundaryReasons(id, 'original_claim_dependency_held');
          if (result?.verdict !== 'hold') recordBoundaryReasons(id,
            ...(result?.verdict !== 'replace' ? ['dependency_replacement_missing' as const] : []),
            ...(!hasSubstantiveActionRewrite(before, after) ? ['dependency_rewrite_not_substantive' as const] : []),
            ...(after.claimIds.some((claimId) => heldClaims.has(claimId)) ? ['held_claim_dependency_retained' as const] : []),
            ...(after.claimIds.length + after.evidenceIds.length === 0 ? ['independent_support_empty' as const] : []));
        }
        if (question?.relatedClaimIds.some((claimId) => heldClaims.has(claimId))) {
          const after = result?.replacement?.nodeType === 'question' ? result.replacement.value : question;
          recordBoundaryReasons(id, 'original_claim_dependency_held',
            ...(after.relatedClaimIds.some((claimId) => heldClaims.has(claimId)) ? ['held_claim_dependency_retained' as const] : []));
        }
      }
      // 来源审查不能显示成临床重点复核，也不能把撤下引用记录成隔离个人内容。
      reviewedTargetIds = clinicalTargetIds.filter((id) => !missingReviewIds.includes(id));
      validationMode = clinicalTargetIds.length > 0 ? 'local_and_focused_review' : 'local_only';
      const priorReasons = new Set(route.reasons);
      const explicitlyHeldClaims = new Set(reviewParsed.data.results.filter((result) => result.verdict === 'hold'
        && originalCandidate.claims.some((claim) => claim.id === result.targetId)).map((result) => result.targetId));
      const personalEvidenceIds = new Set(evidencePackage.evidenceCatalog.filter((source) =>
        ['observation', 'user_note', 'clinical_finding', 'source_span'].includes(source.kind)).map((source) => source.id));
      // P04 已逐项通过的独立问题，仅清理同次明确 hold 的主张编号；不能借此改字、换依据，
      // 或替后置 P03/其他隔离产生的新问题背书。末尾仍核对问句和实际前提的完整回执范围。
      const passiveQuestionDependencyCleanup = (value: MemberAssessmentCandidateV3, id: string) => {
        if (!reviewParsed.data.results.some((result) => result.targetId === id && result.verdict === 'pass')) return false;
        const before = originalCandidate.questions.find((question) => question.id === id);
        const after = value.questions.find((question) => question.id === id);
        if (!before || !after || before.question !== after.question || before.whyItMatters !== after.whyItMatters
          || before.evidenceIds.length === 0 || !before.evidenceIds.every((ref) => personalEvidenceIds.has(ref))
          || stableHash([...before.evidenceIds].sort()) !== stableHash([...after.evidenceIds].sort())
          || after.relatedClaimIds.some((claimId) => !before.relatedClaimIds.includes(claimId))) return false;
        const removedIds = before.relatedClaimIds.filter((claimId) => !after.relatedClaimIds.includes(claimId));
        return removedIds.length > 0 && removedIds.every((claimId) => explicitlyHeldClaims.has(claimId));
      };
      const preservedBoundary = (value: MemberAssessmentCandidateV3, id: string) => clinicalTargetIds.includes(id)
        && (focusedReviewBoundaryPreserved(originalCandidate, value, id, evidencePackage.evidenceCatalog, request.analysisReferenceDate,
          evidencePackage.knowledge.map((source) => source.id), rebuiltSystemStatusRestorations, actionDependencyRebindings,
          evidenceResolutions, evidenceResolutionTargetIds)
          || passiveQuestionDependencyCleanup(value, id));
      const changedHighTargets = (value: MemberAssessmentCandidateV3): string[] => {
        const after = routeFocusedReview(value);
        const changed = clinicalTargetIds.filter((id) => clinicalTargetNode(value, id)
          && stableHash(targetNode(originalCandidate, id)) !== stableHash(targetNode(value, id))
          && !preservedBoundary(value, id));
        return [...new Set([...after.reasons.filter((reason) => !priorReasons.has(reason))
          .map((reason) => reason.slice(reason.indexOf(':') + 1))
          .filter((id) => !preservedBoundary(value, id)), ...changed])];
      };
      // 已经结构合法、但越过复核范围的替换先隔离，再给仍有独立事实依据的日常建议
      // 同一次 P03 修复机会。不能等最后一次 P03 用完后才发现失效依赖并整类删除。
      // 本身仍有可修复字段问题的节点留给原 P03；发布前仍检查其最终医学范围。
      const locallyInvalidTargets = new Set(repairTargets(candidate,
        partitionAssessmentReviewIssues(candidate,
          validateAssessmentCandidate(candidate, validationInputFor(analysisRequest, analysisPackage)).issues,
          evidencePackage.evidenceCatalog).localIssues));
      const preRepairHighTargets = changedHighTargets(candidate).filter((id) => !locallyInvalidTargets.has(id));
      const boundaryHeldIds = new Set<string>();
      const dependentActionIds = new Set([...applied.dependentActionIds, ...originalCandidate.actions
        .filter((action) => action.claimIds.some((id) => explicitlyHeldClaims.has(id))).map((action) => action.id)]);
      const isolateUnreviewedFinalDependencies = () => {
        const heldClaims = new Set(originalCandidate.claims.filter((claim) => heldTargetIds.includes(claim.id)).map((claim) => claim.id));
        const invalid: string[] = [];
        const textChanged = (before: unknown, after: unknown) => stableHash(JSON.stringify(before).normalize('NFKC')
          .replace(/[\s\p{P}\p{S}\p{Cf}]+/gu, '')) !== stableHash(JSON.stringify(after).normalize('NFKC')
          .replace(/[\s\p{P}\p{S}\p{Cf}]+/gu, ''));
        for (const before of originalCandidate.actions) {
          if (!before.claimIds.some((id) => heldClaims.has(id))) continue;
          dependentActionIds.add(before.id);
          const after = candidate.actions.find((action) => action.id === before.id);
          if (!after) continue;
          const replaced = reviewParsed.data.results.some((result) => result.targetId === before.id && result.verdict === 'replace');
          if (!replaced || !hasSubstantiveActionRewrite(before, after) || !preservedBoundary(candidate, before.id)
            || after.claimIds.some((id) => heldClaims.has(id)) || after.claimIds.length + after.evidenceIds.length === 0) {
            invalid.push(before.id);
            recordBoundaryReasons(before.id, 'original_claim_dependency_held',
              ...(!replaced ? ['dependency_replacement_missing' as const] : []),
              ...(!hasSubstantiveActionRewrite(before, after) ? ['dependency_rewrite_not_substantive' as const] : []),
              ...(after.claimIds.some((id) => heldClaims.has(id)) ? ['held_claim_dependency_retained' as const] : []),
              ...(after.claimIds.length + after.evidenceIds.length === 0 ? ['independent_support_empty' as const] : []));
            if (!preservedBoundary(candidate, before.id)) recordBoundaryInspection(candidate, before.id);
          }
        }
        for (const before of originalCandidate.questions) {
          if (!before.relatedClaimIds.some((id) => heldClaims.has(id))) continue;
          const after = candidate.questions.find((question) => question.id === before.id);
          if (!after) continue;
          const replaced = reviewParsed.data.results.some((result) => result.targetId === before.id && result.verdict === 'replace');
          if (!replaced || !textChanged([before.question, before.whyItMatters], [after.question, after.whyItMatters])
            || !preservedBoundary(candidate, before.id)
            || after.relatedClaimIds.some((id) => heldClaims.has(id))) {
            invalid.push(before.id);
            recordBoundaryReasons(before.id, 'original_claim_dependency_held',
              ...(!replaced ? ['dependency_replacement_missing' as const] : []),
              ...(!textChanged([before.question, before.whyItMatters], [after.question, after.whyItMatters])
                ? ['dependency_rewrite_not_substantive' as const] : []),
              ...(after.relatedClaimIds.some((id) => heldClaims.has(id)) ? ['held_claim_dependency_retained' as const] : []));
            if (!preservedBoundary(candidate, before.id)) recordBoundaryInspection(candidate, before.id);
          }
        }
        const unavailableActions = new Set([...heldTargetIds, ...invalid]);
        for (const before of [originalCandidate.overview, ...originalCandidate.systems]) {
          if (!before.claimIds.some((id) => heldClaims.has(id)) && !before.actionIds.some((id) => unavailableActions.has(id))) continue;
          const after = before.id === 'overview' ? candidate.overview : candidate.systems.find((node) => node.id === before.id);
          if (!after) continue;
          const replaced = reviewParsed.data.results.some((result) => result.targetId === before.id && result.verdict === 'replace');
          if (!replaced || !textChanged([before.headline, before.summary, before.limitations], [after.headline, after.summary, after.limitations])
            || !preservedBoundary(candidate, before.id)) {
            invalid.push(before.id);
            recordBoundaryReasons(before.id,
              ...(before.claimIds.some((id) => heldClaims.has(id)) ? ['original_claim_dependency_held' as const] : []),
              ...(before.actionIds.some((id) => unavailableActions.has(id)) ? ['original_action_dependency_held' as const] : []),
              ...(!replaced ? ['dependency_replacement_missing' as const] : []),
              ...(!textChanged([before.headline, before.summary, before.limitations], [after.headline, after.summary, after.limitations])
                ? ['dependency_rewrite_not_substantive' as const] : []));
            if (!preservedBoundary(candidate, before.id)) recordBoundaryInspection(candidate, before.id);
          }
        }
        if (invalid.length === 0) return;
        const isolated = applyFocusedReview(candidate, { schemaVersion: 1, personId, inputSignature: request.inputSignature,
          results: invalid.map((targetId) => ({ targetId, verdict: 'hold',
            reason: '原依赖已失效，完整独立内容没有同次有效复核。', replacement: null })) }, invalid, { finalDependencyGraph: true });
        recordHeldDependencies(candidate, isolated.heldTargetIds, isolated.rebuiltNodeIds);
        candidate = isolated.candidate;
        isolated.heldTargetIds.forEach((id) => boundaryHeldIds.add(id));
        heldTargetIds = [...new Set([...heldTargetIds, ...isolated.heldTargetIds])];
        rebuiltNodeIds = [...new Set([...rebuiltNodeIds, ...isolated.rebuiltNodeIds])];
      };
      if (preRepairHighTargets.length > 0) {
        preRepairHighTargets.forEach((id) => recordBoundaryInspection(candidate, id, 'p04_scope_boundary_changed'));
        const isolated = applyFocusedReview(candidate, {
          schemaVersion: 1, personId, inputSignature: request.inputSignature,
          results: preRepairHighTargets.map((targetId) => ({ targetId, verdict: 'hold',
            reason: '复核替换超出本次核对范围。', replacement: null }))
        }, preRepairHighTargets, { finalDependencyGraph: true });
        recordHeldDependencies(candidate, isolated.heldTargetIds, isolated.rebuiltNodeIds);
        candidate = isolated.candidate;
        isolated.heldTargetIds.forEach((id) => boundaryHeldIds.add(id));
        isolated.dependentActionIds.forEach((id) => dependentActionIds.add(id));
        heldTargetIds = [...new Set([...heldTargetIds, ...isolated.heldTargetIds])];
        rebuiltNodeIds = [...new Set([...rebuiltNodeIds, ...isolated.rebuiltNodeIds])];
      }
      // 即使模型先删了依赖边，仍从本次P04输入图追踪随后被范围门禁隔离的前提。
      isolateUnreviewedFinalDependencies();
      // P04 的替换也可能带来局部问题；只能使用共享预算剩余的 P03，不递归重跑 P04。
      const focusedCandidate = candidate;
      for (const result of reviewParsed.data.results) {
        if (result.verdict === 'hold' || !clinicalTargetIds.includes(result.targetId)
          || heldTargetIds.includes(result.targetId) || !preservedBoundary(candidate, result.targetId)) continue;
        const hash = assessmentReviewNodeHash(candidate, result.targetId);
        if (hash) semanticReviewReceipts.set(result.targetId, hash);
      }
      const postReviewValidated = await validateAndRepair(candidate, analysisRequest, analysisPackage, 'after_review');
      if (!postReviewValidated.candidate) return reject(postReviewValidated.reason ?? 'assessment_validation_failed');
      postReviewValidated.heldTargetIds.forEach((id) => recordBoundaryReasons(id, 'post_review_local_validation_held'));
      recordHeldDependencies(candidate, postReviewValidated.heldTargetIds, postReviewValidated.rebuiltNodeIds);
      candidate = postReviewValidated.candidate;
      heldTargetIds = [...new Set([...heldTargetIds, ...postReviewValidated.heldTargetIds])];
      rebuiltNodeIds = [...new Set([...rebuiltNodeIds, ...postReviewValidated.rebuiltNodeIds])];

      // P04 后才发生的独立改写没有新的全文复核回执，不能借原 action ID 或删依赖放行。
      const habitReceiptIds = new Set([...dependentActionIds, ...independentlyRepairedHabitIds]);
      const uncheckedHabitRepairs = candidate.actions.filter((action) => habitReceiptIds.has(action.id)
        && stableHash(focusedCandidate.actions.find((before) => before.id === action.id)) !== stableHash(action))
        .map((action) => action.id);
      if (uncheckedHabitRepairs.length > 0) {
        uncheckedHabitRepairs.forEach((id) => recordBoundaryReasons(id, 'post_review_independent_rewrite_unreviewed'));
        const isolated = applyFocusedReview(candidate, {
          schemaVersion: 1, personId, inputSignature: request.inputSignature,
          results: uncheckedHabitRepairs.map((targetId) => ({ targetId, verdict: 'hold',
            reason: '独立改写后的完整建议尚未通过复核。', replacement: null }))
        }, uncheckedHabitRepairs);
        recordHeldDependencies(candidate, isolated.heldTargetIds, isolated.rebuiltNodeIds);
        candidate = isolated.candidate;
        heldTargetIds = [...new Set([...heldTargetIds, ...isolated.heldTargetIds])];
        rebuiltNodeIds = [...new Set([...rebuiltNodeIds, ...isolated.rebuiltNodeIds])];
      }

      // P03 没有知识归属审查权限。正文或引用一旦改变，原 P04 的目录归属不能继续背书。
      const uncheckedKnowledgeTargets = routeKnowledgeAttributionReview(candidate, evidencePackage.knowledge).targetIds
        .filter((id) => !targetIds.includes(id)
          || stableHash(targetNode(focusedCandidate, id)) !== stableHash(targetNode(candidate, id)));
      if (uncheckedKnowledgeTargets.length > 0) {
        uncheckedKnowledgeTargets.forEach((id) => recordBoundaryReasons(id, 'post_review_knowledge_attribution_unreviewed'));
        const knowledgeDependent = new Set(knowledgeDependentClinicalTargets(candidate));
        const dependentTargets = uncheckedKnowledgeTargets.filter((id) => knowledgeDependent.has(id));
        const attributionTargets = uncheckedKnowledgeTargets.filter((id) => !knowledgeDependent.has(id));
        const holds = (ids: string[]): ClinicalFocusedReviewV1 => ({
          schemaVersion: 1, personId, inputSignature: request.inputSignature,
          results: ids.map((targetId) => ({ targetId, verdict: 'hold',
            reason: '局部修复后的知识归属尚未核对。', replacement: null }))
        });
        if (attributionTargets.length > 0) candidate = applyKnowledgeAttributionReview(candidate,
          holds(attributionTargets), attributionTargets, evidencePackage.knowledge);
        if (dependentTargets.length > 0) {
          const isolated = applyFocusedReview(candidate, holds(dependentTargets), dependentTargets);
          recordHeldDependencies(candidate, isolated.heldTargetIds, isolated.rebuiltNodeIds);
          candidate = isolated.candidate;
          heldTargetIds = [...new Set([...heldTargetIds, ...isolated.heldTargetIds])];
          rebuiltNodeIds = [...new Set([...rebuiltNodeIds, ...isolated.rebuiltNodeIds])];
        }
      }
      // 已复核目标可以作范围内更正，但不能因 ID 相同就放行新的医学方向或依据。
      // 同 ID、同路由 reason 不能遮住 P03/P04 引入的新依据、确定性、用药或诊断范围。
      const newlyHigh = changedHighTargets(candidate);
      if (newlyHigh.length > 0) {
        newlyHigh.forEach((id) => recordBoundaryInspection(candidate, id, 'post_review_scope_boundary_changed'));
        const holds: ClinicalFocusedReviewV1 = {
          schemaVersion: 1, personId, inputSignature: request.inputSignature,
          results: newlyHigh.map((targetId) => ({ targetId, verdict: 'hold', reason: '复核替换引入新的高影响判断，待另行核验。', replacement: null }))
        };
        const isolated = applyFocusedReview(candidate, holds, newlyHigh);
        recordHeldDependencies(candidate, isolated.heldTargetIds, isolated.rebuiltNodeIds);
        candidate = isolated.candidate;
        isolated.heldTargetIds.forEach((id) => boundaryHeldIds.add(id));
        heldTargetIds = [...new Set([...heldTargetIds, ...isolated.heldTargetIds])];
        rebuiltNodeIds = [...new Set([...rebuiltNodeIds, ...isolated.rebuiltNodeIds])];
      }
      isolateUnreviewedFinalDependencies();
      // 日常建议正文没改，但前提已被后置校验纠正时，取得一次绑定最终输入的新回执。
      // 只接受原正文的明确pass；replace/hold/缺回执都不能沿用旧通过，也不递归补核。
      const finalHabitResults = new Map<string, ClinicalFocusedReviewV1['results'][number]>();
      const finalHabitHashes = new Map<string, string>();
      const finalHabitTargets = findChangedHabitPremiseReviewIds(focusedCandidate, candidate,
        reviewParsed.data.results.filter((result) => result.verdict !== 'hold' && clinicalTargetIds.includes(result.targetId))
          .map((result) => result.targetId), evidencePackage.evidenceCatalog);
      if (finalHabitTargets.length > 0) {
        const finalHabitGraph = structuredClone(candidate);
        try {
          const supplement = await runCountedTurn('focused_review', {
            prompt: buildP04Prompt({ personId, inputSignature: request.inputSignature, targets: finalHabitTargets,
              finalDependencyGraph: true, recoveryMode: 'final_habit_premises',
              reasons: finalHabitTargets.map((id) => `final_habit_premise_review:${id}`) },
            focusedReviewSourceContext(finalHabitGraph, finalHabitTargets, evidencePackage, request.analysisReferenceDate, retrievedKnowledge),
            finalHabitTargets.map((id) => ({ id, node: targetNode(finalHabitGraph, id) }))),
            outputSchema: reviewOutputSchema, allowWebSearch: false
          });
          const fresh = clinicalFocusedReviewV1Schema.safeParse(supplement.output);
          if (fresh.success && fresh.data.personId === personId && fresh.data.inputSignature === request.inputSignature
            && fresh.data.results.length === finalHabitTargets.length
            && new Set(fresh.data.results.map((item) => item.targetId)).size === finalHabitTargets.length
            && fresh.data.results.every((item) => finalHabitTargets.includes(item.targetId))) {
            reviewAudit.record(finalHabitGraph, 'p04', { ...supplement, stage: 'p04' }, fresh.data.results);
            for (const result of fresh.data.results) {
              finalHabitResults.set(result.targetId, result);
              const hash = assessmentReviewNodeHash(finalHabitGraph, result.targetId);
              if (result.verdict === 'pass' && result.replacement === null && !result.evidenceResolutionProofs?.length
                && hash && hash === assessmentReviewNodeHash(candidate, result.targetId)) {
                finalHabitHashes.set(result.targetId, hash);
                semanticReviewReceipts.set(result.targetId, hash);
              }
            }
          } else repairFailureReasons.push('final_habit_review_invalid');
        } catch (error) {
          const code = getCodexTurnFailureDetails(error)?.code;
          if (code !== 'CODEX_MODEL_BUSY' && code !== 'CODEX_CONNECTION_FAILED'
            && !(error instanceof Error && error.message === 'CODEX_TURN_TIMEOUT')) throw error;
          assertInputStillAuthorized();
          repairFailureReasons.push('final_habit_review_temporarily_unavailable');
        }
      }
      const changedReviewedActions = candidate.actions.filter((action) => clinicalTargetIds.includes(action.id)
        && assessmentReviewNodeHash(focusedCandidate, action.id) !== assessmentReviewNodeHash(candidate, action.id)
        && finalHabitHashes.get(action.id) !== assessmentReviewNodeHash(candidate, action.id)).map((action) => action.id);
      if (changedReviewedActions.length > 0) {
        for (const id of changedReviewedActions) recordBoundaryReasons(id, 'post_review_action_hash_changed',
          stableHash(targetNode(focusedCandidate, id)) !== stableHash(targetNode(candidate, id))
            ? 'post_review_action_node_changed' : 'post_review_action_premise_changed');
        const isolated = applyFocusedReview(candidate, { schemaVersion: 1, personId, inputSignature: request.inputSignature,
          results: changedReviewedActions.map((targetId) => ({ targetId, verdict: 'hold',
            reason: '行动正文或实际前提在复核后变化，不能沿用原回执。', replacement: null })) }, changedReviewedActions);
        recordHeldDependencies(candidate, isolated.heldTargetIds, isolated.rebuiltNodeIds);
        candidate = isolated.candidate;
        isolated.heldTargetIds.forEach((id) => boundaryHeldIds.add(id));
        heldTargetIds = [...new Set([...heldTargetIds, ...isolated.heldTargetIds])];
        rebuiltNodeIds = [...new Set([...rebuiltNodeIds, ...isolated.rebuiltNodeIds])];
      }
      // 问句及其实际关联前提由本次 P04 核对。后置 P03、知识归属或范围隔离改变了
      // 问句/关联主张后，不能沿用旧回执。不新增 P04，也不靠同 ID 或引用存在判定支持。
      const questionPremiseHash = (graph: MemberAssessmentCandidateV3, question: MemberAssessmentCandidateV3['questions'][number]) => {
        const claims = new Map(graph.claims.map((claim) => [claim.id, claim]));
        return stableHash({ question: { ...question, relatedClaimIds: [...question.relatedClaimIds].sort(),
          evidenceIds: [...question.evidenceIds].sort() },
        relatedClaims: [...question.relatedClaimIds].sort().map((id) => ({ id, value: claims.get(id) ?? null })) });
      };
      const reviewedQuestions = new Map(focusedCandidate.questions.map((question) =>
        [question.id, questionPremiseHash(focusedCandidate, question)]));
      const changedQuestions = candidate.questions.filter((question) =>
        reviewedQuestions.get(question.id) !== questionPremiseHash(candidate, question)).map((question) => question.id);
      if (changedQuestions.length > 0) {
        for (const id of changedQuestions) recordBoundaryReasons(id, 'post_review_question_hash_changed',
          stableHash(targetNode(focusedCandidate, id)) !== stableHash(targetNode(candidate, id))
            ? 'post_review_question_node_changed' : 'post_review_question_premise_changed');
        const isolated = applyFocusedReview(candidate, {
          schemaVersion: 1, personId, inputSignature: request.inputSignature,
          results: changedQuestions.map((targetId) => ({ targetId, verdict: 'hold',
            reason: '问题的前提或表述在复核后变化，不能沿用原回执。', replacement: null }))
        }, changedQuestions);
        recordHeldDependencies(candidate, isolated.heldTargetIds, isolated.rebuiltNodeIds);
        candidate = isolated.candidate;
        isolated.heldTargetIds.forEach((id) => boundaryHeldIds.add(id));
        heldTargetIds = [...new Set([...heldTargetIds, ...isolated.heldTargetIds])];
        rebuiltNodeIds = [...new Set([...rebuiltNodeIds, ...isolated.rebuiltNodeIds])];
      }
      // 最后新增的行动/问题隔离也要回溯原图；当前摘要可能已先删边而正文未变。
      isolateUnreviewedFinalDependencies();
      const changedReviewedAggregates = [candidate.overview, ...candidate.systems].filter((node) => clinicalTargetIds.includes(node.id)
        && assessmentReviewNodeHash(focusedCandidate, node.id) !== assessmentReviewNodeHash(candidate, node.id)).map((node) => node.id);
      if (changedReviewedAggregates.length > 0) {
        for (const id of changedReviewedAggregates) recordBoundaryReasons(id, 'post_review_aggregate_hash_changed',
          stableHash(targetNode(focusedCandidate, id)) !== stableHash(targetNode(candidate, id))
            ? 'post_review_aggregate_node_changed' : 'post_review_aggregate_premise_changed');
        const isolated = applyFocusedReview(candidate, { schemaVersion: 1, personId, inputSignature: request.inputSignature,
          results: changedReviewedAggregates.map((targetId) => ({ targetId, verdict: 'hold',
            reason: '摘要或依赖在复核后变化，只按仍有效内容重新展示。', replacement: null })) }, changedReviewedAggregates);
        candidate = isolated.candidate;
        rebuiltNodeIds = [...new Set([...rebuiltNodeIds, ...isolated.rebuiltNodeIds])];
      }
      const finalized = finalizeAssessmentLocalIssues(candidate, (value) => filterAssessmentReviewIssues(value,
        validateAssessmentCandidate(value, validationInputFor(analysisRequest, analysisPackage)).issues,
        semanticReviewReceipts, evidencePackage.evidenceCatalog));
      for (const step of finalized.steps) {
        const affected = [...step.heldTargetIds, ...step.rebuiltNodeIds];
        reviewAudit.localReasons(affected, ['final_local_validation_isolated']);
        for (const id of affected) {
          reviewAudit.localReasons([id], step.issues.filter((issue) => repairTargets(step.before, [issue]).includes(id))
            .map((issue) => issue.slice(0, 240)));
        }
        recordHeldDependencies(step.before, step.heldTargetIds, step.rebuiltNodeIds);
        heldTargetIds = [...new Set([...heldTargetIds, ...step.heldTargetIds])];
        rebuiltNodeIds = [...new Set([...rebuiltNodeIds, ...step.rebuiltNodeIds])];
      }
      if (finalized.candidate) candidate = finalized.candidate;
      const remainingValidationIssues = finalized.issues;
      for (const mainResult of reviewParsed.data.results.filter((item) => clinicalTargetIds.includes(item.targetId))) {
        const result = finalHabitResults.get(mainResult.targetId) ?? mainResult;
        focusedReviewDiagnostics.push({ targetId: result.targetId, verdict: result.verdict,
          reviewOrigin: missingReviewIds.includes(result.targetId) ? 'local_dependency_guard' : 'model',
          outcome: heldTargetIds.includes(result.targetId) ? dependentActionIds.has(result.targetId) ? 'dependency_held' : 'held'
            : dependentActionIds.has(result.targetId) ? 'dependency_repaired' : 'retained',
          ...(boundaryHeldIds.has(result.targetId) ? { reasonCodes: ['focused_scope_boundary_changed'] }
            : dependentActionIds.has(result.targetId) && heldTargetIds.includes(result.targetId)
              ? { reasonCodes: ['independent_habit_repair_failed'] } : {}), ...boundaryDiagnostics(result.targetId) });
      }
      for (const id of [...dependentActionIds].filter((id) => !clinicalTargetIds.includes(id))) {
        focusedReviewDiagnostics.push({ targetId: id, verdict: 'hold', reviewOrigin: 'local_dependency_guard',
          outcome: candidate.actions.some((item) => item.id === id) ? 'dependency_repaired' : 'dependency_held',
          reasonCodes: ['final_dependency_not_reviewed'],
          boundaryReasonCodes: [...new Set<FocusedReviewBoundaryReason>(['final_dependency_not_reviewed', ...(boundaryReasons.get(id) ?? [])])] });
      }
      if (remainingValidationIssues.length > 0) return reject(remainingValidationIssues.join(','));

      // 只有本地后置门禁才发现失效前提时，首次 P04 不可能预先核对最终的独立版本。
      // 给这些既有低风险行动一次批量改写及一次全文复核机会；不重跑报告、P02 或整份 P04。
      // 模型直接拒绝的行动、行动自身有边界问题、以及已获救的行动都不进入此通道。
      const lateHeldClaims = originalCandidate.claims.filter((claim) => heldTargetIds.includes(claim.id)
        && !explicitlyHeldClaims.has(claim.id)).map((claim) => claim.id);
      const dependencyReasons = new Set<FocusedReviewBoundaryReason>([
        'original_claim_dependency_held', 'held_claim_dependency_retained', 'dependency_replacement_missing',
        'dependency_rewrite_not_substantive', 'independent_support_empty', 'post_review_local_validation_held',
        'final_dependency_not_reviewed'
      ]);
      const excludedRecoveryIds = originalCandidate.actions.filter((action) =>
        finalHabitTargets.includes(action.id)
        || reviewParsed.data.results.some((result) => result.targetId === action.id && result.verdict === 'hold')
        || [...boundaryReasons.get(action.id) ?? []].some((reason) => !dependencyReasons.has(reason)))
        .map((action) => action.id);
      const recoverableIds = findIndependentHabitRepairCandidateIds({
        candidate: { claims: candidate.claims, actions: originalCandidate.actions },
        heldClaimIds: heldTargetIds.filter((id) => originalCandidate.claims.some((claim) => claim.id === id)),
        heldActionIds: excludedRecoveryIds, evidenceCatalog: evidencePackage.evidenceCatalog
      }).filter((id) => heldTargetIds.includes(id) && !candidate.actions.some((action) => action.id === id)
        && originalCandidate.actions.find((action) => action.id === id)!.claimIds.some((claimId) => lateHeldClaims.includes(claimId)));
      if (recoverableIds.length > 0) {
        try {
        const recoveryBaseline: MemberAssessmentCandidateV3 = { ...candidate,
          actions: [...candidate.actions, ...originalCandidate.actions.filter((action) => recoverableIds.includes(action.id))] };
        const recoveryIssues = recoverableIds.map((id) => `independent_habit_dependency_repair_required:${id}`);
        const repairRequest = buildAssessmentRepairRequest(recoveryBaseline, recoveryIssues,
          evidencePackage.evidenceCatalog, evidencePackage.facts);
        const recoveryEvidenceScopes = new Map(repairRequest.targetDetails.flatMap((detail) => {
          const baseline = originalCandidate.actions.find((action) => action.id === detail.targetId);
          if (!baseline) return [];
          const permission = buildIndependentHabitEvidencePermission({ personId, inputSignature: request.inputSignature,
            originalAction: baseline, survivingClaims: candidate.claims, heldClaimIds: heldTargetIds,
            evidenceCatalog: evidencePackage.evidenceCatalog, suppliedEvidenceIds: detail.remainingEvidenceIds });
          return permission ? [[detail.targetId, { permission, personId, inputSignature: request.inputSignature,
            survivingClaims: candidate.claims, heldClaimIds: heldTargetIds, evidenceCatalog: evidencePackage.evidenceCatalog }] as const] : [];
        }));
        const recoveryTransport = createMemberAnalysisTransport(evidencePackage, analysisEvidenceCatalog);
        const transportedRequest = recoveryTransport.aliasCandidate(repairRequest);
        transportedRequest.targetDetails.forEach((detail, index) => {
          detail.remainingEvidenceIds = recoveryTransport.aliasCandidate({
            evidenceIds: repairRequest.targetDetails[index]!.remainingEvidenceIds
          }).evidenceIds;
        });
        const repaired = await runCountedTurn('assessment_repair', {
          prompt: buildP03Prompt({ ...transportedRequest, recoveryMode: 'late_independent_habits',
            unavailableClaimIds: heldTargetIds.filter((id) => originalCandidate.claims.some((claim) => claim.id === id)) },
          recoveryTransport.packet, recoveryTransport.aliasCandidate(recoverableIds.map((id) => ({
            targetId: id, ...assessmentRepairNode(recoveryBaseline, id)!
          })))), outputSchema: repairOutputSchema, allowWebSearch: false
        });
        const restoredRepair = recoveryTransport.restoreOutput(repaired.output);
        const merged = mergeAssessmentRepair(recoveryBaseline, repairRequest, restoredRepair);
        const repairParsed = memberAssessmentRepairV1Schema.safeParse(restoredRepair);
        const recoveryDiagnostic: AssessmentRepairDiagnostic = { originalCandidateHash: repairRequest.originalCandidateHash,
          targetIds: recoverableIds, schemaVerdict: repairParsed.success ? 'accepted' : 'invalid',
          scopeVerdict: !repairParsed.success ? 'not_checked' : merged.candidate ? 'accepted' : 'invalid',
          initialIssues: recoveryIssues, remainingIssues: [], heldTargetIds: [...recoverableIds], failureReason: merged.reason };
        repairDiagnostics.push(recoveryDiagnostic);
        if (merged.candidate && repairParsed.success && repairChangedOnlyAllowed(recoveryBaseline, merged.candidate, recoverableIds)) {
          reviewAudit.record(recoveryBaseline, 'p03_after_review', { ...repaired, stage: 'p03' }, repairParsed.data.results, recoverableIds);
          const eligibleRewrites = merged.candidate.actions.filter((action) => recoverableIds.includes(action.id)
            && isIndependentHabitRepairReplacement(originalCandidate.actions.find((before) => before.id === action.id)!, action,
              recoveryEvidenceScopes.get(action.id))
            && action.claimIds.every((id) => candidate.claims.some((claim) => claim.id === id))
            && (action.evidenceIds.length > 0 || action.claimIds.length > 0));
          const scopeRejectedIds = recoverableIds.filter((id) => !eligibleRewrites.some((action) => action.id === id));
          if (scopeRejectedIds.length > 0) {
            // 这里是本地替换权限拒绝，尚未进入新全文复核，不能记成模型认为内容不可靠。
            recoveryDiagnostic.failureReason = 'independent_habit_replacement_scope_not_preserved';
            reviewAudit.localReasons(scopeRejectedIds, ['independent_habit_replacement_scope_not_preserved']);
          }
          // 前段局部隔离可能已清掉目录书目；重写后先按本次输入闭合引用，再走原证据与出处核对。
          let recoveryCandidate = canonicalizeAssessmentKnowledge({ ...candidate,
            actions: [...candidate.actions, ...eligibleRewrites] }, evidencePackage);
          const localIssues = partitionAssessmentReviewIssues(recoveryCandidate,
            validateAssessmentCandidate(recoveryCandidate, validationInputFor(analysisRequest, analysisPackage)).issues,
            evidencePackage.evidenceCatalog).localIssues;
          const invalidIds = isolatableTargets(recoveryCandidate, localIssues) ?? (localIssues.length ? recoverableIds : []);
          recoveryDiagnostic.remainingIssues = localIssues;
          recoveryCandidate = { ...recoveryCandidate,
            actions: recoveryCandidate.actions.filter((action) => !invalidIds.includes(action.id)) };
          const recoveryTargets = eligibleRewrites.filter((action) => !invalidIds.includes(action.id)).map((action) => action.id);
          if (recoveryTargets.length > 0) {
            const recoveryKnowledgeReview = routeKnowledgeAttributionReview(recoveryCandidate, evidencePackage.knowledge);
            const supplement = await runCountedTurn('focused_review', {
              prompt: buildP04Prompt({ personId, inputSignature: request.inputSignature, targets: recoveryTargets,
                finalDependencyGraph: true, recoveryMode: 'late_independent_habits',
                reasons: [...recoveryTargets.map((id) => `independent_habit_basis_review:${id}`),
                  ...recoveryKnowledgeReview.reasons.filter((_reason, index) =>
                    recoveryTargets.includes(recoveryKnowledgeReview.targetIds[index]!))] },
              focusedReviewSourceContext(recoveryCandidate, recoveryTargets, evidencePackage, request.analysisReferenceDate, retrievedKnowledge),
              recoveryTargets.map((id) => ({ id, node: targetNode(recoveryCandidate, id) }))),
              outputSchema: reviewOutputSchema, allowWebSearch: false
            });
            const supplementalReview = clinicalFocusedReviewV1Schema.safeParse(supplement.output);
            if (supplementalReview.success && supplementalReview.data.personId === personId
              && supplementalReview.data.inputSignature === request.inputSignature
              && supplementalReview.data.results.length === recoveryTargets.length
              && new Set(supplementalReview.data.results.map((item) => item.targetId)).size === recoveryTargets.length
              && supplementalReview.data.results.every((item) => recoveryTargets.includes(item.targetId))) {
              let recoveryApplied: ReturnType<typeof applyFocusedReview> | null = null;
              try { recoveryApplied = applyFocusedReview(recoveryCandidate, supplementalReview.data, recoveryTargets, { finalDependencyGraph: true }); }
              catch { repairFailureReasons.push('late_independent_habit_review_invalid'); }
              if (recoveryApplied) {
                reviewAudit.record(recoveryCandidate, 'p04', { ...supplement, stage: 'p04' }, supplementalReview.data.results);
                const acceptedActions = recoveryApplied.candidate.actions.filter((action) => recoveryTargets.includes(action.id)
                  && isIndependentHabitRepairReplacement(originalCandidate.actions.find((before) => before.id === action.id)!, action,
                    recoveryEvidenceScopes.get(action.id))
                  && focusedReviewBoundaryPreserved(recoveryCandidate, recoveryApplied!.candidate, action.id,
                    evidencePackage.evidenceCatalog, request.analysisReferenceDate, evidencePackage.knowledge.map((source) => source.id)));
                const checkedCandidate = { ...candidate, actions: [...candidate.actions, ...acceptedActions] };
                const recoveryReceipts = new Map(semanticReviewReceipts);
                acceptedActions.forEach((action) => {
                  const hash = assessmentReviewNodeHash(checkedCandidate, action.id);
                  if (hash) recoveryReceipts.set(action.id, hash);
                });
                const finalIssues = filterAssessmentReviewIssues(checkedCandidate,
                  validateAssessmentCandidate(checkedCandidate, validationInputFor(analysisRequest, analysisPackage)).issues,
                  recoveryReceipts, evidencePackage.evidenceCatalog);
                const finalInvalidIds = isolatableTargets(checkedCandidate, finalIssues)
                  ?? (finalIssues.length ? recoveryTargets : []);
                const publishedActions = acceptedActions.filter((action) => !finalInvalidIds.includes(action.id));
                candidate = { ...candidate, actions: [...candidate.actions, ...publishedActions] };
                const recoveredIds = new Set(publishedActions.map((action) => action.id));
                heldTargetIds = heldTargetIds.filter((id) => !recoveredIds.has(id));
                recoveryDiagnostic.heldTargetIds = recoverableIds.filter((id) => !recoveredIds.has(id));
                recoveryDiagnostic.remainingIssues = finalIssues;
                reviewedTargetIds = [...new Set([...reviewedTargetIds, ...recoveryTargets])];
                publishedActions.forEach((action) => {
                  const hash = assessmentReviewNodeHash(candidate, action.id);
                  if (hash) semanticReviewReceipts.set(action.id, hash);
                });
                // 同 ID 的最终独立版本有新回执，诊断不能仍称该行动未发布。
                for (const diagnostic of focusedReviewDiagnostics) if (recoveredIds.has(diagnostic.targetId)) {
                  diagnostic.outcome = 'dependency_repaired';
                  delete diagnostic.reasonCodes;
                }
                recoveryTargets.filter((id) => !recoveredIds.has(id)).forEach((id) =>
                  reviewAudit?.localReasons([id], ['late_independent_habit_review_held']));
              }
            } else repairFailureReasons.push('late_independent_habit_review_invalid');
          }
        } else repairFailureReasons.push(merged.reason ?? 'late_independent_habit_repair_outside_scope');
        } catch (error) {
          // 可选补救遇到短时服务故障，只保留这些行动的缺口；取消、撤授权、版本冲突仍中止发布。
          const code = getCodexTurnFailureDetails(error)?.code;
          if (code !== 'CODEX_MODEL_BUSY' && code !== 'CODEX_CONNECTION_FAILED'
            && !(error instanceof Error && error.message === 'CODEX_TURN_TIMEOUT')) throw error;
          assertInputStillAuthorized();
          repairFailureReasons.push('late_independent_habit_temporarily_unavailable');
          reviewAudit.localReasons(recoverableIds, ['late_independent_habit_temporarily_unavailable']);
        }
      }
    }
    // 最终主张/行动已稳定，再给退化摘要一次有界撰写和独立复核；不重新生成叶子或循环补救。
    const aggregateRecovery = prepareFinalAggregateRecovery(candidate, parsed.data, rebuiltNodeIds);
    if (aggregateRecovery.targetIds.length > 0) {
      const ids = aggregateRecovery.targetIds;
      try {
        const issues = ids.map((id) => `final_aggregate_summary_required:${id}`);
        const repairRequest = buildAssessmentRepairRequest(aggregateRecovery.baseline, issues, evidencePackage.evidenceCatalog);
        const context = focusedReviewSourceContext(aggregateRecovery.baseline, ids, evidencePackage,
          request.analysisReferenceDate, retrievedKnowledge);
        const repaired = await runCountedTurn('assessment_repair', {
          prompt: buildP03Prompt(repairRequest, context,
            ids.map((id) => ({ targetId: id, ...assessmentRepairNode(aggregateRecovery.baseline, id)! }))),
          outputSchema: repairOutputSchema, allowWebSearch: false
        });
        const merged = mergeAssessmentRepair(aggregateRecovery.baseline, repairRequest, repaired.output);
        const repairParsed = memberAssessmentRepairV1Schema.safeParse(repaired.output);
        if (merged.candidate && repairParsed.success && repairChangedOnlyAllowed(aggregateRecovery.baseline, merged.candidate, ids)) {
          reviewAudit.record(aggregateRecovery.baseline, 'p03_after_review', { ...repaired, stage: 'p03' }, repairParsed.data.results, ids);
          const rewritten = merged.candidate;
          const targets = ids.filter((id) => repairParsed.data.results.some((result) => result.targetId === id && result.verdict === 'replace')
            && finalAggregateReplacementPreserved(aggregateRecovery, rewritten, id, evidencePackage.evidenceCatalog, request.analysisReferenceDate));
          if (targets.length > 0) {
            const reviewed = await runCountedTurn('focused_review', {
              prompt: buildP04Prompt({ personId, inputSignature: request.inputSignature, targets,
                finalDependencyGraph: true, recoveryMode: 'final_aggregate_summary',
                reasons: targets.map((id) => `final_aggregate_summary_review:${id}`) },
              focusedReviewSourceContext(rewritten, targets, evidencePackage, request.analysisReferenceDate, retrievedKnowledge),
              targets.map((id) => ({ id, node: targetNode(rewritten, id) }))),
              outputSchema: reviewOutputSchema, allowWebSearch: false
            });
            const checked = clinicalFocusedReviewV1Schema.safeParse(reviewed.output);
            if (checked.success && checked.data.personId === personId && checked.data.inputSignature === request.inputSignature
              && checked.data.results.length === targets.length && new Set(checked.data.results.map((result) => result.targetId)).size === targets.length
              && checked.data.results.every((result) => targets.includes(result.targetId)
                && (result.replacement === null || result.replacement.nodeType === assessmentRepairNode(rewritten, result.targetId)?.nodeType
                  && result.replacement.value.id === result.targetId))) {
              reviewAudit.record(rewritten, 'p04', { ...reviewed, stage: 'p04' }, checked.data.results);
              // 不接纳复核时再次重写的摘要，避免用旧回执证明一份新文本或变动后的前提。
              const passed = new Set(checked.data.results.filter((result) => result.verdict === 'pass' && result.replacement === null
                && !result.evidenceResolutionProofs?.length).map((result) => result.targetId));
              const proposed = { ...candidate,
                overview: passed.has('overview') ? rewritten.overview : candidate.overview,
                systems: candidate.systems.map((node) => passed.has(node.id) ? rewritten.systems.find((item) => item.id === node.id)! : node) };
              const receipts = new Map(semanticReviewReceipts);
              for (const id of passed) {
                const hash = assessmentReviewNodeHash(proposed, id);
                if (hash && hash === assessmentReviewNodeHash(rewritten, id)) receipts.set(id, hash);
                else passed.delete(id);
              }
              const localIssues = filterAssessmentReviewIssues(proposed,
                validateAssessmentCandidate(proposed, validationInputFor(analysisRequest, analysisPackage)).issues,
                receipts, evidencePackage.evidenceCatalog);
              const invalid = new Set(isolatableTargets(proposed, localIssues) ?? (localIssues.length ? [...passed] : []));
              const accepted = new Set([...passed].filter((id) => !invalid.has(id)));
              candidate = { ...candidate, overview: accepted.has('overview') ? rewritten.overview : candidate.overview,
                systems: candidate.systems.map((node) => accepted.has(node.id) ? rewritten.systems.find((item) => item.id === node.id)! : node) };
              rebuiltNodeIds = rebuiltNodeIds.filter((id) => !accepted.has(id));
              heldTargetIds = heldTargetIds.filter((id) => !accepted.has(id));
              reviewedTargetIds = [...new Set([...reviewedTargetIds, ...accepted])];
              reviewAudit.localReasons(ids.filter((id) => !accepted.has(id)), ['final_aggregate_summary_not_accepted']);
            } else repairFailureReasons.push('final_aggregate_review_invalid');
          } else reviewAudit.localReasons(ids, ['final_aggregate_repair_scope_not_preserved']);
        } else repairFailureReasons.push(merged.reason ?? 'final_aggregate_repair_invalid');
      } catch (error) {
        const code = getCodexTurnFailureDetails(error)?.code;
        if (code !== 'CODEX_MODEL_BUSY' && code !== 'CODEX_CONNECTION_FAILED'
          && !(error instanceof Error && error.message === 'CODEX_TURN_TIMEOUT')) throw error;
        assertInputStillAuthorized();
        repairFailureReasons.push('final_aggregate_temporarily_unavailable');
        reviewAudit.localReasons(ids, ['final_aggregate_temporarily_unavailable']);
      }
    }
    const publishCandidate = pruneUnusedCatalogKnowledge(canonicalizeAssessmentKnowledge(candidate, evidencePackage));
    const snapshot: Omit<MemberAssessmentSnapshotV3, 'id' | 'status' | 'generatedAt'> = {
      ...publishCandidate,
      factRevision: built.factRevision, contextRevision: built.contextRevision,
      reviewScopeSignature: built.reviewScopeSignature,
      promptVersion: MEMBER_ASSESSMENT_PROMPT_VERSION, rulesVersion: MEMBER_ASSESSMENT_RULES_VERSION,
      modelId: this.modelId, reasoningEffort: this.reasoningEffort, validationMode,
      reviewedTargetIds, heldTargetIds,
      comparisonCoverage: assessmentComparisonCoverage(publishCandidate, originalPriorityTopics),
      reviewAuditRecords: reviewAudit.finalize({ heldTargetIds, rebuiltNodeIds,
        evidenceCatalog: evidencePackage.evidenceCatalog }),
      ...(rebuiltNodeIds.length ? { presentation: {
        version: ASSESSMENT_PRESENTATION_VERSION, rebuiltNodeIds
      } } : {}),
      // 未归类状态保留在输入 unresolvedScope 和档案统计中；不能在校验后追加成医学局限。
      // 模型给出的真实医疗范围限制仍完整留在 overview/systems 的 limitations。
      limitations: [],
      evidenceCatalog: evidencePackage.evidenceCatalog,
      processingPlan: { strategy: 'full', trigger: 'none', partitionCount: 0, partitionHeldTargetCount: 0 },
      knowledgeVerifications: buildAssessmentKnowledgeVerifications(publishCandidate, evidencePackage, retrievedKnowledge)
    };
    let published: ReturnType<WorkspaceStore['publishMemberAssessmentSnapshot']>;
    try {
      published = this.store.publishMemberAssessmentSnapshot({
        snapshot, ...(this.executionGuard ? { executionGuard: this.executionGuard } : {})
      });
    } catch (error) {
      // 写入契约拒绝也保留固定诊断；授权、版本竞争、磁盘和未知错误仍按原中止路径处理。
      const code = error instanceof Error ? error.message : '';
      if (['MEMBER_ASSESSMENT_SCHEMA_INVALID', 'MEMBER_ASSESSMENT_REVIEW_AUDIT_INVALID',
        'MEMBER_ASSESSMENT_HELD_OR_DUPLICATE_NODE', 'MEMBER_ASSESSMENT_REFERENCE_INVALID',
        'MEMBER_ASSESSMENT_REVIEW_AUDIT_EVIDENCE_MISMATCH'].includes(code)) return reject(code);
      throw error;
    }
    return {
      status: 'published', snapshotId: published.snapshotId, idempotent: published.idempotent,
      threadId: lastReceipt!.threadId, turnId: lastReceipt!.turnId, callCount: calls, ...executionBinding(),
      ...(repairFailureReasons.length ? { repairFailureReasons: [...new Set(repairFailureReasons)] } : {}),
      ...(repairDiagnostics.length ? { repairDiagnostics } : {}),
      ...(focusedReviewDiagnostics.length ? { focusedReviewDiagnostics } : {})
    };
  }
}
