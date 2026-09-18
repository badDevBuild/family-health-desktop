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

function normalizeEvidenceText(value: string): string {
  return value.normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();
}

function evidenceContentProblems(candidate: ObservationCandidate, manifest: SourceManifest): string[] {
  const spans = new Map(manifest.spans.map((span) => [span.id, span]));
  const problems: string[] = [];
  const supportedText: string[] = [];
  for (const reference of candidate.evidence) {
    const span = spans.get(reference.sourceSpanId);
    if (!span) continue;
    if (span.quote && span.readability === 'clear') {
      if (!reference.quote) {
        problems.push(`evidence_quote_required:${reference.sourceSpanId}`);
        continue;
      }
      const source = normalizeEvidenceText(span.quote);
      const cited = normalizeEvidenceText(reference.quote);
      if (!cited || !source.includes(cited)) {
        problems.push(`evidence_quote_mismatch:${reference.sourceSpanId}`);
        continue;
      }
      supportedText.push(cited);
    }
  }
  if (candidate.value.kind === 'numeric' && supportedText.length > 0) {
    const expected = Number(candidate.value.decimal);
    const numericEvidence = supportedText.flatMap((text) => text.match(/-?(?:\d+(?:\.\d+)?|\.\d+)/g) ?? []).map(Number);
    if (!numericEvidence.some((value) => Number.isFinite(value) && value === expected)) {
      problems.push('numeric_value_not_in_evidence');
    }
    const comparatorTokens: Record<typeof candidate.value.comparator, string[]> = {
      eq: [], lt: ['<', '小于'], lte: ['<=', '≤', '不高于'], gt: ['>', '大于'], gte: ['>=', '≥', '不低于']
    };
    const requiredComparator = comparatorTokens[candidate.value.comparator];
    if (requiredComparator.length > 0 && !supportedText.some((text) => requiredComparator.some((token) => text.includes(token)))) {
      problems.push('numeric_comparator_not_in_evidence');
    }
  }
  if ((candidate.value.kind === 'qualitative' || candidate.value.kind === 'text') && supportedText.length > 0) {
    const raw = normalizeEvidenceText(candidate.value.rawText);
    if (raw && !supportedText.some((text) => text.includes(raw))) problems.push('reported_value_not_in_evidence');
  }
  if (candidate.clinicalDate && supportedText.length > 0) {
    const [year, month, day] = candidate.clinicalDate.split('-').map(Number);
    const dateForms = [
      candidate.clinicalDate,
      `${year}/${String(month).padStart(2, '0')}/${String(day).padStart(2, '0')}`,
      `${year}.${String(month).padStart(2, '0')}.${String(day).padStart(2, '0')}`,
      `${year}年${month}月${day}日`
    ].map(normalizeEvidenceText);
    if (!supportedText.some((text) => dateForms.some((form) => text.includes(form)))) {
      problems.push('clinical_date_not_in_evidence');
    }
  }
  return [...new Set(problems)];
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

  const contentProblems = evidenceContentProblems(candidate, manifest);
  if (contentProblems.length > 0) {
    return { decision: 'reject', reasons: contentProblems };
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
