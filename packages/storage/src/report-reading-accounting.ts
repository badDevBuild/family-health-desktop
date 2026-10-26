import { reportReadingAuditSchema, observationStructuredSlotEvidence,
  type ObservationCandidate, type ReportReadingAudit, type ReportReadingLedger } from '@contracts';

/** 只用于落库对账，不产生任何医学值或接纳权限。每次读取的编号只在本次生效。 */
export interface ReportReadingAccountingInput {
  candidates: ObservationCandidate[];
  emptyCandidateKeys: string[];
  failures: Array<{ localKey: string; reasons: string[] }>;
  unrepresentedSourceCount: number;
  pageGapCount: number;
  coverage?: Omit<ReportReadingLedger, 'candidates'>;
}

export function accountReportReading(input: ReportReadingAccountingInput,
  admittedKeys: readonly string[], held: readonly ObservationCandidate[], history: readonly ObservationCandidate[] = []): {
  audit: ReportReadingAudit; pendingCandidates: ObservationCandidate[];
} {
  const keys = new Set(input.candidates.map((candidate) => candidate.localKey));
  const admitted = new Set(admittedKeys);
  const empty = new Set(input.emptyCandidateKeys);
  if (keys.size !== input.candidates.length || [...admitted, ...empty].some((key) => !keys.has(key))
    || [...empty].some((key) => admitted.has(key))) throw new Error('REPORT_READING_ACCOUNTING_SCOPE_INVALID');
  const pendingCandidates = input.candidates.filter((candidate) => !admitted.has(candidate.localKey) && !empty.has(candidate.localKey));
  const currentVersions = new Set(pendingCandidates.map((candidate) => JSON.stringify(candidate)));
  const reasonsFor = (candidate: ObservationCandidate): string[] => {
    const reasons = [...new Set([...input.failures.filter((failure) => failure.localKey === candidate.localKey).flatMap((failure) => failure.reasons),
      ...held.filter((item) => item.localKey === candidate.localKey).flatMap((item) => item.issues.map((issue) => issue.code))])];
    return reasons.length ? reasons : ['reading_candidate_not_accounted'];
  };
  const audit = reportReadingAuditSchema.parse({ version: 1, totalCandidates: keys.size,
    savedCandidates: admitted.size, emptyCandidates: empty.size,
    pending: pendingCandidates.map((candidate) => {
      return { localKey: candidate.localKey, originalName: candidate.originalName,
        reasonCodes: reasonsFor(candidate) };
    }),
    // 历史版本没有稳定来源对应时宁可保留为待对账，不能按名称/数值折叠为独立漏项。
    historicalReadingCount: new Set(history.filter((candidate) => !currentVersions.has(JSON.stringify(candidate)))
      .map((candidate) => JSON.stringify(candidate))).size,
    unrepresentedSourceCount: input.unrepresentedSourceCount, pageGapCount: input.pageGapCount,
    ...(input.coverage ? { ledger: { ...input.coverage, candidates: input.candidates.map(candidate => ({
      localKey: candidate.localKey, originalName: candidate.originalName, value: candidate.value, unitRaw: candidate.unitRaw,
      disposition: admitted.has(candidate.localKey) ? 'saved_or_existing' : empty.has(candidate.localKey) ? 'original_no_result' : 'pending',
      evidence: [...new Map([...candidate.evidence, ...(candidate.sourceBinding?.headingEvidence ?? []),
        ...(candidate.sourceBinding?.findingEvidence ?? []), ...observationStructuredSlotEvidence(candidate),
        ...(candidate.clinicalContext?.conditions ?? [])].map(ref => [JSON.stringify(ref), ref])).values()],
      reasonCodes: admitted.has(candidate.localKey) || empty.has(candidate.localKey) ? [] : reasonsFor(candidate)
    })) } } : {}) });
  return { audit, pendingCandidates };
}
