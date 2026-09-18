import { createHash } from 'node:crypto';
import type { ObservationCandidate, SourceManifest } from '@contracts';

export type AcceptanceOutcome =
  | { decision: 'accept'; warnings: string[] }
  | { decision: 'accept_with_warnings'; warnings: string[] }
  | { decision: 'needs_review'; reasons: string[] }
  | { decision: 'reject'; reasons: string[] };

export function stableHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export function validateCoverage(manifest: SourceManifest): string[] {
  const covered = new Set(manifest.coveredUnitIndexes);
  const problems: string[] = [];

  for (let index = 0; index < manifest.totalUnits; index += 1) {
    if (!covered.has(index)) problems.push(`missing_unit:${index}`);
  }

  if (covered.size !== manifest.coveredUnitIndexes.length) problems.push('duplicate_unit');
  for (const index of covered) {
    if (index < 0 || index >= manifest.totalUnits) problems.push(`invalid_unit:${index}`);
  }
  return problems;
}

export function evaluateObservationCandidate(
  candidate: ObservationCandidate,
  manifest: SourceManifest,
  options: { personConsistent: boolean; overwritesUserLockedValue: boolean }
): AcceptanceOutcome {
  if (!options.personConsistent) {
    return { decision: 'needs_review', reasons: ['person_conflict'] };
  }
  if (options.overwritesUserLockedValue) {
    return { decision: 'needs_review', reasons: ['overwrite_protected'] };
  }

  const knownSpans = new Set(manifest.spans.map((span) => span.id));
  const invalidEvidence = candidate.evidence.filter((ref) => !knownSpans.has(ref.sourceSpanId));
  if (invalidEvidence.length > 0) {
    return { decision: 'reject', reasons: ['evidence_mismatch'] };
  }

  const coverageProblems = validateCoverage(manifest);
  if (coverageProblems.length > 0) {
    return { decision: 'needs_review', reasons: coverageProblems };
  }

  const blockingIssue = candidate.issues.find((issue) => issue.code.startsWith('blocking_'));
  if (blockingIssue) {
    return { decision: 'needs_review', reasons: [blockingIssue.code] };
  }

  const warnings: string[] = [];
  if (candidate.referenceRangeRaw === null) warnings.push('reference_range_not_provided');
  if (candidate.unitRaw === null && candidate.value.kind === 'numeric') warnings.push('unit_not_provided');
  if (candidate.value.kind === 'unknown') warnings.push('value_unknown');

  return warnings.length === 0
    ? { decision: 'accept', warnings }
    : { decision: 'accept_with_warnings', warnings };
}

export type JobStatus =
  | 'queued'
  | 'running'
  | 'waiting_auth'
  | 'waiting_quota'
  | 'waiting_user'
  | 'retry_wait'
  | 'succeeded'
  | 'failed'
  | 'cancelled';

const transitions: Record<JobStatus, readonly JobStatus[]> = {
  queued: ['running', 'waiting_auth', 'waiting_quota', 'waiting_user', 'cancelled'],
  running: ['retry_wait', 'succeeded', 'failed', 'cancelled', 'waiting_auth', 'waiting_quota', 'waiting_user'],
  waiting_auth: ['queued', 'cancelled'],
  waiting_quota: ['queued', 'cancelled'],
  waiting_user: ['queued', 'cancelled'],
  retry_wait: ['queued', 'failed', 'cancelled'],
  succeeded: [],
  failed: ['queued'],
  cancelled: []
};

export function canTransitionJob(from: JobStatus, to: JobStatus): boolean {
  return transitions[from].includes(to);
}

export function assertJobTransition(from: JobStatus, to: JobStatus): void {
  if (!canTransitionJob(from, to)) {
    throw new Error(`非法任务状态迁移：${from} → ${to}`);
  }
}

export type ChangeKind = 'display' | 'clinical_context' | 'new_report' | 'fact_revision' | 'model_update';

export function determineInvalidation(change: ChangeKind): {
  facts: boolean;
  trends: boolean;
  derived: boolean;
} {
  switch (change) {
    case 'display':
      return { facts: false, trends: false, derived: false };
    case 'clinical_context':
      return { facts: false, trends: false, derived: true };
    case 'new_report':
      return { facts: false, trends: true, derived: true };
    case 'fact_revision':
      return { facts: false, trends: true, derived: true };
    case 'model_update':
      return { facts: false, trends: false, derived: false };
  }
}

