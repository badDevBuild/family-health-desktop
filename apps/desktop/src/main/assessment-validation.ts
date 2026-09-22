import type {
  BodySystemId, HealthClaim, MemberAssessmentCandidateV3, MemberEvidenceRef
} from '@contracts';

export const ASSESSMENT_VALIDATION_RULES_VERSION = 'assessment-validation-v6';

export interface AssessmentValidationInput {
  personId: string;
  inputSignature: string;
  mode: MemberAssessmentCandidateV3['mode'];
  requestedSystemIds: BodySystemId[];
  evidenceCatalog: MemberEvidenceRef[];
  trendIds: string[];
  catalogKnowledgeIds: string[];
  criteriaSets: Array<{
    id: string;
    sourceId: string;
    applicability: string;
    requiredCriterionIds: string[];
    verifiedRequirements: Array<{ criterionId: string; evidenceIds: string[] }>;
  }>;
}

export interface AssessmentValidationResult {
  issues: string[];
  focusedReviewReasons: string[];
}

// 仅识别面向本人直接执行的药物改变；来源事实中的剂量、检验单位及治疗讨论不据字面拒绝。
const medicationChange = '(?:停药|停用|换药|加量|减量|开始服用|改用|调整剂量)';
const negatedMedicationChange = new RegExp(`(?:不要|不得|切勿|勿|避免|禁止|不应|无需|不必|停止)[^。；，,]{0,14}(?:自行|擅自)?${medicationChange}`, 'gi');
const directMedicationInstruction = new RegExp(`(?:马上|立即|现在|请|应(?:当|该)?|必须|建议你)[^。；，,]{0,24}${medicationChange}|${medicationChange}[^。；，,]{0,12}(?:即可|就行)`, 'i');
const selfDirectedMedicationChange = new RegExp(`自行[^。；，,]{0,12}${medicationChange}`, 'i');
const unsourcedProbability = /(?:患病|发病|罹患|诊断|得[^。；，]{0,8}病|患[^。；，]{0,12}风险|癌症风险)[^。；，]{0,24}\d+(?:\.\d+)?\s*%/i;
const explicitDiagnosis = /(?:明确诊断|临床诊断|病理诊断|出院诊断|诊断[:：]|确诊|诊断意见[:：])/i;
const negatedOrTentative = /(?:排除|待排|考虑|疑似|可能|家族史|病史自述|未确诊|不能诊断|尚不能诊断)/i;
const historicalDiagnosis = /(?:既往|既往史|既往诊断|曾诊断|病史)/i;

function hasOwnDocumentedDiagnosis(evidence: MemberEvidenceRef, diseaseName: string, temporalStatus: HealthClaim['temporalStatus']): boolean {
  const quote = evidence.quote ?? '';
  if (!['observation', 'clinical_finding', 'source_span'].includes(evidence.kind)) return false;
  const relevantClauses = quote.split(/[。；;\n]/).filter((clause) => clause.includes(diseaseName));
  return relevantClauses.some((clause) => explicitDiagnosis.test(clause)
    && !negatedOrTentative.test(clause)
    && (!historicalDiagnosis.test(clause) || temporalStatus === 'historical'));
}

function hasDirectMedicationChange(action: MemberAssessmentCandidateV3['actions'][number]): boolean {
  const fields = [action.title, action.why, action.firstStep, action.timing, action.reviewPlan, action.caution]
    .filter((value): value is string => value !== null);
  return fields.some((field, index) => field.split(/[。；，,]/).some((clause) => {
    const actionable = clause.replace(negatedMedicationChange, '');
    return directMedicationInstruction.test(actionable)
      || (index === 0 || index === 2) && selfDirectedMedicationChange.test(actionable);
  }));
}

/** 仅归一化可由同一候选字段确定的结构信息，不推断病名、证据或医学确定性。 */
export function normalizeAssessmentStructuralFields(candidate: MemberAssessmentCandidateV3): MemberAssessmentCandidateV3 {
  return {
    ...candidate,
    systems: candidate.systems.map((system) => ({ ...system, id: `system:${system.systemId}` })),
    claims: candidate.claims.map((claim) => claim.diagnosticStatus !== null && claim.diseaseName !== null
      && claim.kind === 'interpretation' ? { ...claim, kind: 'diagnostic_assessment' } : claim)
  };
}

export function validateAssessmentCandidate(
  candidate: MemberAssessmentCandidateV3,
  input: AssessmentValidationInput
): AssessmentValidationResult {
  const issues: string[] = [];
  const focusedReviewReasons: string[] = [];
  if (candidate.personId !== input.personId || candidate.inputSignature !== input.inputSignature
    || candidate.mode !== input.mode) issues.push('scope_mismatch');
  const expectedSystems = new Set(input.requestedSystemIds);
  const actualSystems = candidate.systems.map((system) => system.systemId);
  if (new Set(actualSystems).size !== actualSystems.length
    || actualSystems.length !== expectedSystems.size
    || actualSystems.some((system) => !expectedSystems.has(system))
    || candidate.requestedSystemIds.length !== expectedSystems.size
    || candidate.requestedSystemIds.some((system) => !expectedSystems.has(system))) issues.push('system_scope_mismatch');
  if (candidate.systems.some((system) => system.id !== `system:${system.systemId}`)) issues.push('reserved_system_id_mismatch');

  const nodes = [candidate.overview, ...candidate.systems, ...candidate.claims, ...candidate.actions, ...candidate.questions];
  const nodeIds = nodes.map((node) => node.id);
  if (new Set(nodeIds).size !== nodeIds.length) issues.push('duplicate_node_id');
  const claimIds = new Set(candidate.claims.map((claim) => claim.id));
  const actionIds = new Set(candidate.actions.map((action) => action.id));
  const evidence = new Map(input.evidenceCatalog.map((item) => [item.id, item]));
  const knowledgeIds = new Set([...input.catalogKnowledgeIds, ...candidate.knowledgeSources.map((item) => item.id)]);
  const trendIds = new Set(input.trendIds);
  const candidateKnowledgeIds = candidate.knowledgeSources.map((source) => source.id);
  if (new Set(candidateKnowledgeIds).size !== candidateKnowledgeIds.length) issues.push('duplicate_knowledge_id');
  for (const source of candidate.knowledgeSources) {
    if (source.origin === 'catalog' && !input.catalogKnowledgeIds.includes(source.id)) issues.push(`unknown_catalog_source:${source.id}`);
    if (source.origin === 'retrieved' && (!source.url?.startsWith('https://') || !source.supports)) {
      issues.push(`retrieved_source_unverifiable:${source.id}`);
    }
  }
  const validateEvidence = (owner: string, ids: string[]) => {
    for (const id of ids) if (!evidence.has(id)) issues.push(`unknown_evidence:${owner}:${id}`);
  };
  const validateClaims = (owner: string, ids: string[]) => {
    for (const id of ids) if (!claimIds.has(id)) issues.push(`unknown_claim:${owner}:${id}`);
  };
  const validateActions = (owner: string, ids: string[]) => {
    for (const id of ids) if (!actionIds.has(id)) issues.push(`unknown_action:${owner}:${id}`);
  };
  validateClaims('overview', candidate.overview.claimIds);
  validateActions('overview', candidate.overview.actionIds);
  if (unsourcedProbability.test(`${candidate.overview.headline} ${candidate.overview.summary}`)) issues.push('unsourced_probability:overview');
  for (const system of candidate.systems) {
    validateClaims(system.id, system.claimIds);
    validateActions(system.id, system.actionIds);
    if (system.claimIds.length === 0 && system.status !== 'insufficient') issues.push(`unsupported_system_status:${system.id}`);
    if (unsourcedProbability.test(`${system.headline} ${system.summary}`)) issues.push(`unsourced_probability:${system.id}`);
  }
  if (candidate.overview.claimIds.length === 0 && candidate.claims.length > 0) issues.push('overview_missing_claims');

  for (const claim of candidate.claims) {
    if (claim.systemIds.some((id) => !expectedSystems.has(id))) issues.push(`claim_system_outside_scope:${claim.id}`);
    validateEvidence(claim.id, [...claim.evidenceIds, ...claim.counterEvidenceIds]);
    for (const id of claim.trendIds) if (!trendIds.has(id)) issues.push(`unknown_trend:${claim.id}:${id}`);
    for (const id of claim.knowledgeSourceIds) if (!knowledgeIds.has(id)) issues.push(`unknown_knowledge:${claim.id}:${id}`);
    if (claim.evidenceIds.length === 0) issues.push(`personal_evidence_required:${claim.id}`);
    if (claim.diagnosticStatus === null) {
      if (claim.diseaseName !== null || claim.criteriaBasis !== null) issues.push(`diagnostic_fields_without_status:${claim.id}`);
    } else if (!claim.diseaseName || claim.kind !== 'diagnostic_assessment') {
      issues.push(`diagnostic_fields_incomplete:${claim.id}`);
    }
    if (claim.diagnosticStatus === 'documented') {
      if (!claim.evidenceIds.some((id) => {
        const source = evidence.get(id);
        return source && hasOwnDocumentedDiagnosis(source, claim.diseaseName!, claim.temporalStatus);
      })) issues.push(`documented_source_not_proven:${claim.id}`);
    }
    if (claim.diagnosticStatus === 'criteria_met') {
      const criteria = claim.criteriaBasis;
      const supplied = input.criteriaSets.find((set) => set.id === criteria?.criteriaSetId);
      if (!criteria || !supplied || criteria.sourceId !== supplied.sourceId
        || criteria.applicability !== supplied.applicability
        || !input.catalogKnowledgeIds.includes(supplied.sourceId)
        || supplied.requiredCriterionIds.length === 0
        || !supplied.requiredCriterionIds.every((id) => criteria.requirements.some((requirement) => (
          requirement.criterionId === id && requirement.status === 'met'
          && requirement.evidenceIds.length > 0 && requirement.evidenceIds.every((evidenceId) => (
            evidence.has(evidenceId)
            && supplied.verifiedRequirements.some((verified) => verified.criterionId === id
              && verified.evidenceIds.includes(evidenceId))
          ))
        )))) {
        issues.push(`criteria_not_proven:${claim.id}`);
      }
    } else if (claim.criteriaBasis !== null) issues.push(`criteria_wrong_status:${claim.id}`);
    if ((claim.diagnosticStatus === 'likely' || claim.diagnosticStatus === 'possible')
      && claim.evidenceIds.every((id) => evidence.get(id)?.kind === 'knowledge')) {
      issues.push(`personal_diagnostic_evidence_required:${claim.id}`);
    }
    if (unsourcedProbability.test(claim.text)) issues.push(`unsourced_probability:${claim.id}`);
    if (claim.consequenceLevel === 'high') focusedReviewReasons.push(`high_consequence:${claim.id}`);
  }

  const dedupeKeys = new Set<string>();
  for (const action of candidate.actions) {
    validateClaims(action.id, action.claimIds);
    validateEvidence(action.id, action.evidenceIds);
    for (const id of action.knowledgeSourceIds) if (!knowledgeIds.has(id)) issues.push(`unknown_knowledge:${action.id}:${id}`);
    if (action.systemIds.some((id) => !expectedSystems.has(id))) issues.push(`action_system_outside_scope:${action.id}`);
    if (action.evidenceIds.length === 0) issues.push(`action_personal_evidence_required:${action.id}`);
    if (dedupeKeys.has(action.dedupeKey)) issues.push(`duplicate_action_key:${action.dedupeKey}`);
    dedupeKeys.add(action.dedupeKey);
    if (hasDirectMedicationChange(action)) {
      issues.push(`direct_medication_change:${action.id}`);
    }
    if (unsourcedProbability.test(`${action.title} ${action.why} ${action.firstStep}`)) issues.push(`unsourced_probability:${action.id}`);
    if (action.urgency === 'emergency') focusedReviewReasons.push(`emergency_action:${action.id}`);
  }
  for (const question of candidate.questions) {
    validateClaims(question.id, question.relatedClaimIds);
    validateEvidence(question.id, question.evidenceIds);
  }
  return {
    issues: [...new Set(issues)],
    focusedReviewReasons: [...new Set(focusedReviewReasons)]
  };
}
