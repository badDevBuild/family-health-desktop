import { z } from 'zod';

/** 拒绝路径不保存节点、自由错误或原文；未知类别只归为 unknown_validation_issue。 */
const codes = [
  'assessment_schema_invalid', 'focused_review_schema_invalid', 'assessment_validation_failed',
  'FOCUSED_REVIEW_SCOPE_MISMATCH', 'FOCUSED_REVIEW_COVERAGE_MISMATCH', 'FOCUSED_REVIEW_TARGET_UNKNOWN',
  'FOCUSED_REVIEW_UNEXPECTED_REPLACEMENT', 'FOCUSED_REVIEW_REPLACEMENT_SCOPE_MISMATCH',
  'scope_mismatch', 'system_scope_mismatch', 'reserved_system_id_mismatch', 'duplicate_node_id',
  'duplicate_knowledge_id', 'unknown_catalog_source', 'retrieved_source_unverifiable', 'unknown_evidence',
  'unknown_claim', 'unknown_action', 'unknown_trend', 'unknown_knowledge', 'overview_missing_claims',
  'personal_evidence_required', 'personal_diagnostic_evidence_required', 'claim_system_outside_scope',
  'diagnostic_fields_without_status', 'diagnostic_fields_incomplete', 'high_impact_claim_untyped',
  'documented_source_not_proven', 'diagnostic_title_contradiction', 'criteria_not_proven', 'criteria_wrong_status',
  'unsupported_system_status', 'unsupported_high_impact_text', 'unsourced_probability',
  'action_system_outside_scope', 'lifestyle_metadata_incomplete', 'general_lifestyle_not_low_risk',
  'action_personal_evidence_required', 'direct_medication_change', 'duplicate_action_key',
  'documented_plan_source_not_proven', 'documented_plan_instruction_not_proven',
  'documented_plan_timing_not_proven', 'documented_plan_title_not_supported',
  'support_expanded', 'uncertainty_removed', 'evidence_resolution_unproven', 'source_fact_numeric_changed', 'numeric_fact_added',
  'date_scope_or_precision_changed', 'medication_instruction_changed', 'final_dependency_not_reviewed',
  'review_receipt_missing', 'unknown_validation_issue',
  'MEMBER_ASSESSMENT_SCHEMA_INVALID', 'MEMBER_ASSESSMENT_REVIEW_AUDIT_INVALID',
  'MEMBER_ASSESSMENT_HELD_OR_DUPLICATE_NODE', 'MEMBER_ASSESSMENT_REFERENCE_INVALID',
  'MEMBER_ASSESSMENT_REVIEW_AUDIT_EVIDENCE_MISMATCH'
] as const;
const allowed = new Set<string>(codes);

export function normalizeAssessmentRejectionCodes(reasons: readonly string[]): Array<typeof codes[number]> {
  const result = new Set<typeof codes[number]>();
  for (const reason of reasons) {
    for (const item of reason.split(',')) {
      const code = item.split(':', 1)[0]!;
      result.add(allowed.has(code) ? code as typeof codes[number] : 'unknown_validation_issue');
      if (result.size === 64) return [...result];
    }
  }
  return result.size ? [...result] : ['unknown_validation_issue'];
}

export const assessmentRejectionDiagnosticSchema = z.object({
  version: z.literal(1),
  inputSignature: z.string().regex(/^[a-f0-9]{64}$/),
  reasonCodes: z.array(z.enum(codes)).min(1).max(64),
  actualModelCalls: z.number().int().min(0).max(100),
  repairAttemptCount: z.number().int().min(0).max(10),
  focusedTargetCount: z.number().int().min(0).max(10000)
}).strict();
export type AssessmentRejectionDiagnostic = z.infer<typeof assessmentRejectionDiagnosticSchema>;
