import type { HealthAction, HealthClaim, MemberAssessmentCandidateV3, MemberEvidenceRef } from '@contracts';
import { stableHash } from '@core';
import { assessmentReviewNodeHash } from './assessment-semantic-review.js';
import {
  hasDirectMedicationChange, hasHighConsequenceNodeAssertion, hasNumericSupplementDose,
  isLocatedPersonalHabitEvidence, isReviewablePersonalizedHabit, visibleAssessmentTextFields
} from './assessment-validation.js';

export interface IndependentHabitRepairCandidateInput {
  candidate: Pick<MemberAssessmentCandidateV3, 'claims' | 'actions'>;
  heldClaimIds: readonly string[];
  // 这里只接收 P04 显式隔离的行动，不能用依赖传播后的行动集合覆盖它。
  heldActionIds: readonly string[];
  evidenceCatalog: readonly MemberEvidenceRef[];
}

function isRoutineHabit(action: HealthAction): boolean {
  return action.kind === 'habit' && action.urgency === 'routine'
    && !hasDirectMedicationChange(action) && !hasHighConsequenceNodeAssertion(action)
    && !hasNumericSupplementDose(action);
}

/** 正文未变而存活前提变动时，只选可重新核对的日常建议，不复用旧通过凭据。 */
export function findChangedHabitPremiseReviewIds(before: MemberAssessmentCandidateV3,
  after: MemberAssessmentCandidateV3, passedIds: readonly string[], evidenceCatalog: readonly MemberEvidenceRef[]): string[] {
  if (before.personId !== after.personId || before.inputSignature !== after.inputSignature) return [];
  const personal = new Set(evidenceCatalog.filter(isLocatedPersonalHabitEvidence).map((item) => item.id));
  return after.actions.filter((action) => {
    const originals = before.actions.filter((item) => item.id === action.id);
    if (!passedIds.includes(action.id) || originals.length !== 1 || stableHash(originals[0]) !== stableHash(action)
      || action.sourceInstructionObservationId !== undefined
      || !isRoutineHabit(action) || !isReviewablePersonalizedHabit(action, action.caution)) return false;
    const currentHash = assessmentReviewNodeHash(after, action.id), priorHash = assessmentReviewNodeHash(before, action.id);
    if (!currentHash || !priorHash || currentHash === priorHash) return false;
    const claims = action.claimIds.map((id) => after.claims.filter((item) => item.id === id));
    if (claims.some((matches) => matches.length !== 1)) return false;
    return [...action.evidenceIds, ...claims.flatMap(([claim]) => claim!.evidenceIds)].some((id) => personal.has(id));
  }).map((action) => action.id);
}

/**
 * 只挑选因关联主张被隔离而需要补救的既有日常行动，不删除引用或放行正文。
 * 这里检查依据是否仍可定位；行动与依据是否实际相符仍由完整校验和 P04 核对。
 */
export function findIndependentHabitRepairCandidateIds(input: IndependentHabitRepairCandidateInput): string[] {
  const heldClaims = new Set(input.heldClaimIds);
  const heldActions = new Set(input.heldActionIds);
  const personalEvidenceIds = new Set(input.evidenceCatalog.filter(isLocatedPersonalHabitEvidence).map((item) => item.id));
  const survivingClaimIds = new Set(input.candidate.claims.filter((claim) => !heldClaims.has(claim.id)
    && claim.evidenceIds.some((id) => personalEvidenceIds.has(id))).map((claim) => claim.id));
  return [...new Set(input.candidate.actions.filter((action) => !heldActions.has(action.id) && isRoutineHabit(action)
    && action.sourceInstructionObservationId === undefined
    && action.claimIds.some((id) => heldClaims.has(id))
    && (action.evidenceIds.some((id) => personalEvidenceIds.has(id))
      || action.claimIds.some((id) => survivingClaimIds.has(id)))).map((action) => action.id))];
}

export interface IndependentHabitEvidencePermission {
  readonly personId: string;
  readonly inputSignature: string;
  readonly actionId: string;
  readonly originalActionHash: string;
  readonly allowedEvidenceIds: readonly string[];
  readonly claimBindings: readonly Readonly<{ id: string; hash: string }>[];
  readonly evidenceBindings: readonly Readonly<{ id: string; hash: string }>[];
}

interface IndependentHabitEvidencePermissionInput {
  personId: string;
  inputSignature: string;
  originalAction: HealthAction;
  survivingClaims: readonly HealthClaim[];
  heldClaimIds: readonly string[];
  evidenceCatalog: readonly MemberEvidenceRef[];
  // 必须来自这次 P03 目标明示的剩余依据，不能把整成员目录当作授权。
  suppliedEvidenceIds: readonly string[];
}

export interface IndependentHabitRepairEvidenceScope {
  permission: IndependentHabitEvidencePermission;
  personId: string;
  inputSignature: string;
  survivingClaims: readonly HealthClaim[];
  heldClaimIds: readonly string[];
  evidenceCatalog: readonly MemberEvidenceRef[];
}

function uniqueById<T extends { id: string }>(values: readonly T[]): Map<string, T> {
  const duplicateIds = new Set<string>();
  const unique = new Map<string, T>();
  for (const value of values) {
    if (unique.has(value.id)) duplicateIds.add(value.id);
    unique.set(value.id, value);
  }
  for (const id of duplicateIds) unique.delete(id);
  return unique;
}

/**
 * 在 P03 前冻结原行动已有的支持闭包。只允许把同次输入已经明示的支持来源直引，
 * 不把反证、隔离主张、新关联或其他目录内容变成新的个人授权。
 */
export function buildIndependentHabitEvidencePermission(
  input: IndependentHabitEvidencePermissionInput
): IndependentHabitEvidencePermission | null {
  if (!input.personId || !input.inputSignature || !isRoutineHabit(input.originalAction)
    || input.originalAction.sourceInstructionObservationId !== undefined) return null;
  const held = new Set(input.heldClaimIds);
  const evidence = uniqueById(input.evidenceCatalog);
  const claims = uniqueById(input.survivingClaims);
  const personalEvidenceIds = new Set([...evidence.values()].filter(isLocatedPersonalHabitEvidence).map((item) => item.id));
  const eligibleClaims = [...new Set(input.originalAction.claimIds)].filter((id) => !held.has(id))
    .map((id) => claims.get(id)).filter((claim): claim is HealthClaim => claim !== undefined
      && claim.evidenceIds.some((id) => personalEvidenceIds.has(id)));
  const existingSupport = new Set([...input.originalAction.evidenceIds,
    ...eligibleClaims.flatMap((claim) => claim.evidenceIds)]);
  const allowedEvidenceIds = [...new Set(input.suppliedEvidenceIds)]
    .filter((id) => existingSupport.has(id) && personalEvidenceIds.has(id)).sort();
  if (allowedEvidenceIds.length === 0) return null;
  const claimBindings = eligibleClaims.map((claim) => Object.freeze({ id: claim.id, hash: stableHash(claim) }))
    .sort((left, right) => left.id.localeCompare(right.id));
  const evidenceBindings = allowedEvidenceIds.map((id) => Object.freeze({ id, hash: stableHash(evidence.get(id)) }));
  return Object.freeze({ personId: input.personId, inputSignature: input.inputSignature,
    actionId: input.originalAction.id, originalActionHash: stableHash(input.originalAction),
    allowedEvidenceIds: Object.freeze(allowedEvidenceIds), claimBindings: Object.freeze(claimBindings),
    evidenceBindings: Object.freeze(evidenceBindings) });
}

function permittedEvidenceIds(original: HealthAction, scope?: IndependentHabitRepairEvidenceScope): readonly string[] | null {
  if (!scope) return original.evidenceIds;
  const { permission } = scope;
  if (permission.personId !== scope.personId || permission.inputSignature !== scope.inputSignature
    || permission.actionId !== original.id || permission.originalActionHash !== stableHash(original)) return null;
  const current = buildIndependentHabitEvidencePermission({ ...scope, originalAction: original,
    suppliedEvidenceIds: permission.allowedEvidenceIds });
  return current && stableHash(current) === stableHash(permission) ? permission.allowedEvidenceIds : null;
}

function sameIds(left: readonly string[], right: readonly string[]): boolean {
  const leftIds = new Set(left);
  const rightIds = new Set(right);
  return leftIds.size === rightIds.size && [...leftIds].every((id) => rightIds.has(id));
}

function preservesSystemScope(original: HealthAction, replacement: HealthAction,
  scope?: IndependentHabitRepairEvidenceScope): boolean {
  if (replacement.systemIds.length === 0 || new Set(replacement.systemIds).size !== replacement.systemIds.length
    || !onlyExistingIds(original.systemIds, replacement.systemIds)) return false;
  if (sameIds(original.systemIds, replacement.systemIds)) return true;
  if (!scope || replacement.claimIds.length === 0) return false;
  const claims = uniqueById(scope.survivingClaims);
  const held = new Set(scope.heldClaimIds);
  const retained = replacement.claimIds.map((id) => claims.get(id));
  // 每个剩余主张至少在仍展示的一个系统内，每个仍展示的系统也必须有剩余主张。
  // 跨系统主张本身不必被改写；去掉无关系统不是把它的医学内容移到新系统。
  return retained.every((claim) => claim && !held.has(claim.id)
    && claim.systemIds.some((id) => replacement.systemIds.includes(id)))
    && replacement.systemIds.every((id) => retained.some((claim) => claim?.systemIds.includes(id)));
}

function onlyExistingIds(original: readonly string[], replacement: readonly string[]): boolean {
  const originalIds = new Set(original);
  return replacement.every((id) => originalIds.has(id));
}

function visibleContent(action: HealthAction): string {
  // 纯空白、全半角、标点或排版变更不能伪装成已改写失效医学依据。
  return JSON.stringify(visibleAssessmentTextFields(action).map(({ field, text }) => [field,
    text.normalize('NFKC').toLowerCase().replace(/[\s\p{P}\p{S}\p{Cf}]+/gu, '')
  ]).filter(([, text]) => text !== ''));
}

/** 只证明不是删引用或换排版；医学独立性仍须由同次 P04 核实。 */
export function hasSubstantiveActionRewrite(original: HealthAction, replacement: HealthAction): boolean {
  return visibleContent(original) !== visibleContent(replacement);
}

/**
 * 这只是局部补救的替换权限门禁，不是发布授权。
 * 允许删除失效引用，但必须实际改写展示文字；不能改成一般建议绕过个人依据要求。
 * 所有剩余引用和正文依据仍须经过主流程及唯一一次 P04。
 */
export function isIndependentHabitRepairReplacement(original: HealthAction, replacement: HealthAction,
  scope?: IndependentHabitRepairEvidenceScope): boolean {
  const evidenceIds = permittedEvidenceIds(original, scope);
  return evidenceIds !== null && isRoutineHabit(original) && isRoutineHabit(replacement)
    && original.sourceInstructionObservationId === undefined
    && replacement.sourceInstructionObservationId === undefined
    && isReviewablePersonalizedHabit(replacement, original.caution)
    && original.id === replacement.id && original.kind === replacement.kind
    && original.dedupeKey === replacement.dedupeKey && preservesSystemScope(original, replacement, scope)
    && original.lifestyleDomain === replacement.lifestyleDomain
    && original.lifestyleBasis === replacement.lifestyleBasis
    && original.timingBasis === replacement.timingBasis
    && onlyExistingIds(original.claimIds, replacement.claimIds)
    && onlyExistingIds(evidenceIds, replacement.evidenceIds)
    && onlyExistingIds(original.knowledgeSourceIds, replacement.knowledgeSourceIds)
    && hasSubstantiveActionRewrite(original, replacement);
}
