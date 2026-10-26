import type { HealthAction, HealthClaim, MemberAssessmentCandidateV3, MemberEvidenceRef,
  OverviewNode, QuestionNode, SystemNode } from '@contracts';
import { stableHash } from '@core';
import { hasDirectMedicationChange, hasHighConsequenceNodeAssertion,
  hasNumericSupplementDose, isLocatedPersonalHabitEvidence,
  isReviewablePersonalizedHabit, visibleAssessmentTextFields } from './assessment-validation.js';

type ReviewNode = { kind: 'claim'; value: HealthClaim } | { kind: 'action'; value: HealthAction }
  | { kind: 'overview'; value: OverviewNode } | { kind: 'system'; value: SystemNode }
  | { kind: 'question'; value: QuestionNode };

// 复合病名或标题缩写不一定能逐字相等；只交给同次 P04 核对，绝不在这里推断同义或来源已确诊。
const documentedClaimIssues = new Set(['documented_source_not_proven', 'diagnostic_title_contradiction']);
const documentedActionIssues = new Set(['documented_plan_source_not_proven', 'documented_plan_instruction_not_proven',
  'documented_plan_timing_not_proven', 'documented_plan_title_not_supported']);
const generalLifestyleIssues = new Set(['general_lifestyle_not_low_risk', 'action_personal_evidence_required']);

export interface AssessmentReviewIssuePartition {
  localIssues: string[];
  semanticIssues: string[];
  targetIds: string[];
}

function nodes(candidate: MemberAssessmentCandidateV3): ReviewNode[] {
  return [{ kind: 'overview', value: candidate.overview },
    ...candidate.systems.map((value): ReviewNode => ({ kind: 'system', value })),
    ...candidate.claims.map((value): ReviewNode => ({ kind: 'claim', value })),
    ...candidate.actions.map((value): ReviewNode => ({ kind: 'action', value })),
    ...candidate.questions.map((value): ReviewNode => ({ kind: 'question', value }))];
}

/**
 * “资料没有提供”本身也是需要来源核对的事实断言。这里只路由，不从词语猜检查方法
 * 或自动消除限制；同次 P04 必须读取实际引用并修正原主张，派生节点沿正常依赖闭包更新。
 */
export function assessmentLimitationConsistencyTargets(candidate: MemberAssessmentCandidateV3): string[] {
  const absence = /(?:未提供|未记录|未注明|未说明|不详|不明|未知|缺少|缺乏|尚不清楚|无法确认|不能确认|尚无)/u;
  return nodes(candidate).filter(({ value }) => visibleAssessmentTextFields(value).some(({ text }) => absence.test(text)))
    .map(({ value }) => value.id);
}

/** 缺资料断言先交给有界P03对照原文，之后P04复核完整纠正版本；路由本身不判定断言错误。 */
export function assessmentLimitationPreparationIssues(candidate: MemberAssessmentCandidateV3,
  evidenceCatalog: readonly MemberEvidenceRef[]): string[] {
  // 正文缺口先核正；其他解释字段已有P04逐字来源证明，避免因一条常规未知提示额外撰写整批。
  const absence = /(?:未提供|未记录|未注明|未说明|不详|不明|未知|缺少|缺乏|尚不清楚|无法确认|不能确认|尚无)/u;
  return candidate.claims.filter((claim) => claim.kind === 'interpretation' && absence.test(claim.text)
    && hasPersonalSource(claim.evidenceIds, evidenceCatalog))
    .map((claim) => `limitation_source_check_required:${claim.id}`);
}

function uniqueNode(candidate: MemberAssessmentCandidateV3, targetId: string): ReviewNode | null {
  const matches = nodes(candidate).filter((node) => node.value.id === targetId);
  return matches.length === 1 ? matches[0]! : null;
}

/** 节点ID可能含冒号；先匹配完整现存ID，不能用冒号分割后截短。 */
function issueOwner(issue: string, nodeIds: readonly string[]): { code: string; targetId: string | null; exact: boolean } {
  const separator = issue.indexOf(':');
  if (separator < 0) return { code: issue, targetId: null, exact: false };
  const detail = issue.slice(separator + 1);
  const targetId = [...nodeIds].sort((left, right) => right.length - left.length)
    .find((id) => detail === id || detail.startsWith(`${id}:`)) ?? null;
  return { code: issue.slice(0, separator), targetId, exact: detail === targetId };
}

/** 来源存在只允许进入语义核对，不证明其中的诊断或指示成立。 */
function hasPersonalSource(evidenceIds: readonly string[], evidenceCatalog: readonly MemberEvidenceRef[]): boolean {
  const references = evidenceIds.map((id) => evidenceCatalog.filter((reference) => reference.id === id));
  if (references.some((matches) => matches.length !== 1)) return false;
  return references.some(([reference]) => reference !== undefined
    && ['observation', 'clinical_finding', 'source_span'].includes(reference.kind)
    && reference.knowledgeId === null && Boolean(reference.documentId?.trim()
      && reference.sourceSpanId?.trim() && reference.quote?.trim()));
}

/** 只规定可交给一次P04的行动意图边界；不对白话内容作安全白名单。 */
function isGeneralReviewIntent(action: HealthAction): boolean {
  return action.kind === 'habit' && action.urgency === 'routine' && action.lifestyleBasis === 'general'
    && action.lifestyleDomain !== undefined && action.sourceInstructionObservationId === undefined
    && action.claimIds.length === 0 && action.evidenceIds.length === 0 && action.knowledgeSourceIds.length === 0
    && ['none', 'practical_trial'].includes(action.timingBasis)
    && !hasDirectMedicationChange(action) && !hasNumericSupplementDose(action)
    && !hasHighConsequenceNodeAssertion(action);
}

/** 只检查关联主张有真实、唯一且可阅读的个人来源；相关性仍必须由 P04 判断。 */
function hasLocatedSurvivingClaim(candidate: MemberAssessmentCandidateV3, action: HealthAction,
  evidenceCatalog: readonly MemberEvidenceRef[]): boolean {
  return action.claimIds.some((id) => {
    const matches = candidate.claims.filter((claim) => claim.id === id);
    if (matches.length !== 1) return false;
    const references = matches[0]!.evidenceIds.map((evidenceId) =>
      evidenceCatalog.filter((reference) => reference.id === evidenceId));
    return references.length > 0 && references.every((items) => items.length === 1)
      && references.some(([reference]) => reference !== undefined && isLocatedPersonalHabitEvidence(reference));
  });
}

/**
 * 保留所有原问题串。只把有可审查来源或严格一般生活意图的语义问题交给P04；
 * 同节点的其他问题及未归属的结构/权限问题仍由本地处理，不能借此屏蔽绑定失败。
 */
export function partitionAssessmentReviewIssues(
  candidate: MemberAssessmentCandidateV3,
  issues: readonly string[],
  evidenceCatalog: readonly MemberEvidenceRef[] = []
): AssessmentReviewIssuePartition {
  const nodeIds = nodes(candidate).map((node) => node.value.id);
  const parsed = issues.map((issue) => ({ issue, ...issueOwner(issue, nodeIds) }));
  const hasUnscopedIssue = parsed.some((issue) => issue.targetId === null);
  const eligible = (index: number): boolean => {
    const issue = parsed[index]!;
    if (hasUnscopedIssue || !issue.exact || issue.targetId === null) return false;
    const node = uniqueNode(candidate, issue.targetId);
    if (!node) return false;
    const own = parsed.filter((other) => other.targetId === issue.targetId);
    if (node.kind === 'claim' && documentedClaimIssues.has(issue.code)) {
      return node.value.kind === 'diagnostic_assessment' && node.value.diagnosticStatus === 'documented'
        && Boolean(node.value.diseaseName?.trim()) && hasPersonalSource(node.value.evidenceIds, evidenceCatalog)
        && own.every((other) => other.exact && documentedClaimIssues.has(other.code));
    }
    if (node.kind !== 'action') return false;
    if (documentedActionIssues.has(issue.code)) {
      return (node.value.kind === 'documented_plan' || node.value.timingBasis === 'documented')
        && hasPersonalSource(node.value.evidenceIds, evidenceCatalog)
        && own.every((other) => other.exact && documentedActionIssues.has(other.code));
    }
    if (issue.code === 'action_personal_evidence_required' && node.value.evidenceIds.length === 0
      && isReviewablePersonalizedHabit(node.value)
      && hasLocatedSurvivingClaim(candidate, node.value, evidenceCatalog)) {
      return own.every((other) => other.exact && other.code === 'action_personal_evidence_required');
    }
    return generalLifestyleIssues.has(issue.code) && isGeneralReviewIntent(node.value)
      && own.some((other) => other.code === 'general_lifestyle_not_low_risk')
      && own.every((other) => other.exact && generalLifestyleIssues.has(other.code));
  };
  const localIssues: string[] = [];
  const semanticIssues: string[] = [];
  const targetIds = new Set<string>();
  parsed.forEach((issue, index) => {
    if (!eligible(index)) localIssues.push(issue.issue);
    else {
      semanticIssues.push(issue.issue);
      targetIds.add(issue.targetId!);
    }
  });
  return { localIssues, semanticIssues, targetIds: [...targetIds] };
}

/**
 * 凭据绑定完整节点、当前成员输入及其主张/知识依赖；同ID的新正文不能复用旧通过结果。
 * 缺失或多义的目标/主张/行动依赖无法获得可复用哈希。
 */
export function assessmentReviewNodeHash(candidate: MemberAssessmentCandidateV3, targetId: string): string | null {
  const node = uniqueNode(candidate, targetId);
  if (!node) return null;
  const referencedActionIds = node.kind === 'overview' || node.kind === 'system' ? node.value.actionIds : [];
  const relatedActions: HealthAction[] = [];
  for (const id of referencedActionIds) {
    const action = uniqueNode(candidate, id);
    if (action?.kind !== 'action') return null;
    relatedActions.push(action.value);
  }
  const ownClaimIds = node.kind === 'question' ? node.value.relatedClaimIds
    : 'claimIds' in node.value ? node.value.claimIds : [];
  const relatedClaims: HealthClaim[] = [];
  for (const id of [...new Set([...ownClaimIds, ...relatedActions.flatMap((action) => action.claimIds)])]) {
    const claim = uniqueNode(candidate, id);
    if (claim?.kind !== 'claim') return null;
    relatedClaims.push(claim.value);
  }
  const knowledgeUsers = [node.value, ...relatedActions, ...relatedClaims];
  const knowledgeIds = [...new Set(knowledgeUsers.flatMap((value) => [
    ...('knowledgeSourceIds' in value ? value.knowledgeSourceIds : []),
    ...('criteriaBasis' in value && value.criteriaBasis ? [value.criteriaBasis.sourceId] : [])
  ]))];
  const relatedKnowledge = [];
  for (const id of knowledgeIds) {
    const matches = candidate.knowledgeSources.filter((source) => source.id === id);
    if (matches.length > 1) return null;
    // 目录知识可能不在候选条目内；缺失状态同样入哈希，新增或变更条目会使凭据失效。
    relatedKnowledge.push({ id, value: matches[0] ?? null });
  }
  return stableHash({ version: 'assessment-review-node-v1', personId: candidate.personId,
    inputSignature: candidate.inputSignature, mode: candidate.mode, requestedSystemIds: candidate.requestedSystemIds,
    node, relatedActions, relatedClaims, relatedKnowledge });
}

/** 只能消费本轮P04明确通过后保存的哈希；没有通过凭据时原问题仍全部待处理。 */
export function filterAssessmentReviewIssues(
  candidate: MemberAssessmentCandidateV3,
  issues: readonly string[],
  receiptHashes: ReadonlyMap<string, string>,
  evidenceCatalog: readonly MemberEvidenceRef[] = []
): string[] {
  const partition = partitionAssessmentReviewIssues(candidate, issues, evidenceCatalog);
  const semantic = new Set(partition.semanticIssues);
  const nodeIds = nodes(candidate).map((node) => node.value.id);
  return issues.filter((issue) => {
    if (!semantic.has(issue)) return true;
    const targetId = issueOwner(issue, nodeIds).targetId;
    if (targetId === null) return true;
    const hash = assessmentReviewNodeHash(candidate, targetId);
    return hash === null || receiptHashes.get(targetId) !== hash;
  });
}
