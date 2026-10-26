import { z } from 'zod';
import { calendarDateOccurrences } from './calendar-date.js';

const id = z.string().min(1).max(160);
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => {
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
});
const evidence = z.object({ pageSourceSpanId: id, quote: z.string().min(1).max(2000),
  clarity: z.enum(['clear', 'uncertain']) }).strict();

/** 只读取原件的日期与范围关联，不接收或重写任何医疗值、标题、部位或解释条件。 */
export const directOriginalDateReadingSchema = z.object({
  schemaVersion: z.literal(1), documentId: id,
  subject: z.object({ reportedName: z.string().min(1).max(200).nullable(),
    confidence: z.enum(['explicit', 'absent', 'uncertain']), evidence: z.array(evidence) }).strict(),
  dates: z.array(z.object({ localKey: id, value: day.nullable(),
    role: z.enum(['sampled', 'examined', 'encounter', 'report_issued', 'history_quoted', 'unknown']),
    pageSourceSpanId: id, quote: z.string().min(1).max(2000).nullable(),
    clarity: z.enum(['clear', 'uncertain']), factScopeIds: z.array(id) }).strict()),
  primaryClinicalDateKey: id.nullable()
}).strict();
export type DirectOriginalDateReading = z.infer<typeof directOriginalDateReadingSchema>;
export const DIRECT_ORIGINAL_DATE_READING_VERSION = 'direct-original-date-blind-v1';
const receiptSchema = z.object({ threadId: id, turnId: id }).strict();
export const directOriginalDateReviewCheckpointSchema = z.object({
  checkpointKind: z.literal('direct_original_date_blind'),
  dateBlindVersion: z.literal(DIRECT_ORIGINAL_DATE_READING_VERSION),
  scopeRevision: z.string().regex(/^[a-f0-9]{64}$/),
  originalSha256: z.string().regex(/^[a-f0-9]{64}$/), sourceObjectId: id,
  factScopesHash: z.string().regex(/^[a-f0-9]{64}$/),
  reads: z.array(z.object({ receipt: receiptSchema, transmissionId: id, reading: directOriginalDateReadingSchema.nullable(),
    outputHash: z.string().regex(/^[a-f0-9]{64}$/) }).strict()).max(2),
  failureCode: z.string().nullable()
}).strict();
export type DirectOriginalDateReviewCheckpoint = z.infer<typeof directOriginalDateReviewCheckpointSchema>;

export interface DirectOriginalDateConsensus {
  issues: string[];
  assignments: Array<{ factScopeId: string; value: string; role: 'sampled' | 'examined' | 'encounter'; firstKey: string; secondKey: string }>;
  primary: { value: string; role: 'sampled' | 'examined' | 'encounter'; firstKey: string; secondKey: string } | null;
  issued: { value: string; firstKey: string; secondKey: string } | null;
}

/** 两次均从完整原件独立读取后才比对；不补猜日期，不用旧记录打破分歧。 */
export function inspectDirectOriginalDateConsensus(first: DirectOriginalDateReading, second: DirectOriginalDateReading,
  scope: { documentId: string; pageIds: string[]; factScopeIds: string[]; acceptedReportedNames: string[];
    subjectPolicy?: 'require_source_identity' | 'user_assigned' }): DirectOriginalDateConsensus {
  const issues = new Set<string>();
  const pages = new Set(scope.pageIds); const facts = new Set(scope.factScopeIds);
  const normalizeName = (value: string) => value.normalize('NFKC').replace(/\s+/gu, '').toLocaleLowerCase('zh-CN');
  const accepted = new Set(scope.acceptedReportedNames.map(normalizeName).filter(Boolean));
  const clinical = (role: string): role is 'sampled' | 'examined' | 'encounter' => ['sampled', 'examined', 'encounter'].includes(role);
  for (const reading of [first, second]) {
    if (reading.documentId !== scope.documentId) issues.add('date_blind_document_scope_invalid');
    // 上传时已明确选择成员的资料沿用用户归属。这里只免除姓名匹配与身份充分性，
    // 不改写两份原始读取，也不免除文档、页、日期和已冻结字段的范围证明。
    if (scope.subjectPolicy !== 'user_assigned' && (reading.subject.confidence !== 'explicit' || !reading.subject.reportedName
      || !accepted.has(normalizeName(reading.subject.reportedName)) || !reading.subject.evidence.length
      || !reading.subject.evidence.some((ref) => pages.has(ref.pageSourceSpanId) && ref.clarity === 'clear'
        && normalizeName(ref.quote).includes(normalizeName(reading.subject.reportedName!))))) {
      issues.add('date_blind_subject_unproven');
    }
    if (reading.subject.evidence.some((ref) => !pages.has(ref.pageSourceSpanId))) issues.add('date_blind_page_scope_invalid');
    if (new Set(reading.dates.map((date) => date.localKey)).size !== reading.dates.length) issues.add('date_blind_duplicate_date_key');
    if (reading.dates.some((date) => !pages.has(date.pageSourceSpanId))) issues.add('date_blind_page_scope_invalid');
    if (reading.dates.some((date) => date.clarity === 'clear' && date.value !== null
      && (!date.quote || !calendarDateOccurrences(date.quote).some((found) => found.date === date.value)))) {
      issues.add('date_blind_date_quote_inconsistent');
    }
    if (reading.dates.some((date) => date.factScopeIds.some((id) => !facts.has(id))
      || new Set(date.factScopeIds).size !== date.factScopeIds.length)) issues.add('date_blind_fact_scope_invalid');
    if (reading.dates.some((date) => date.factScopeIds.length > 0
      && (!clinical(date.role) || date.value === null || date.clarity !== 'clear' || !date.quote))) {
      issues.add('date_blind_clinical_date_unproven');
    }
  }
  const assignments: DirectOriginalDateConsensus['assignments'] = [];
  for (const id of scope.factScopeIds) {
    const a = first.dates.filter((date) => date.factScopeIds.includes(id));
    const b = second.dates.filter((date) => date.factScopeIds.includes(id));
    if (a.length !== 1 || b.length !== 1) { issues.add('date_blind_fact_date_missing_or_ambiguous'); continue; }
    const left = a[0]!; const right = b[0]!;
    if (!left.value || !right.value || left.clarity !== 'clear' || right.clarity !== 'clear' || !left.quote || !right.quote
      || !clinical(left.role) || !clinical(right.role)) { issues.add('date_blind_clinical_date_unproven'); continue; }
    if (left.value !== right.value || left.role !== right.role || left.pageSourceSpanId !== right.pageSourceSpanId) {
      issues.add('date_blind_readings_disagree'); continue;
    }
    assignments.push({ factScopeId: id, value: left.value, role: left.role, firstKey: left.localKey, secondKey: right.localKey });
  }
  const a = first.dates.find((date) => date.localKey === first.primaryClinicalDateKey);
  const b = second.dates.find((date) => date.localKey === second.primaryClinicalDateKey);
  const sameDateScope = (reading: DirectOriginalDateReading, date: DirectOriginalDateReading['dates'][number]) =>
    [...new Set(reading.dates.filter((item) => item.value === date.value && item.role === date.role
      && item.pageSourceSpanId === date.pageSourceSpanId).flatMap((item) => item.factScopeIds))].sort().join('\u0000');
  let primary: DirectOriginalDateConsensus['primary'] = null;
  if (!a || !b || !a.value || a.clarity !== 'clear' || b.clarity !== 'clear' || !a.quote || !b.quote
    || !clinical(a.role) || !clinical(b.role) || a.value !== b.value || a.role !== b.role
    || a.pageSourceSpanId !== b.pageSourceSpanId
    || !a.factScopeIds.length || !b.factScopeIds.length || sameDateScope(first, a) !== sameDateScope(second, b)
    || !assignments.some((assignment) => assignment.value === a.value && assignment.role === a.role)) {
    issues.add('date_blind_primary_date_unproven');
  } else primary = { value: a.value, role: a.role, firstKey: a.localKey, secondKey: b.localKey };
  const firstIssued = first.dates.filter((date) => date.role === 'report_issued');
  const secondIssued = second.dates.filter((date) => date.role === 'report_issued');
  let issued: DirectOriginalDateConsensus['issued'] = null;
  if (firstIssued.length || secondIssued.length) {
    const left = firstIssued[0]; const right = secondIssued[0];
    if (firstIssued.length !== 1 || secondIssued.length !== 1 || !left?.value || !right?.value
      || left.clarity !== 'clear' || right.clarity !== 'clear' || !left.quote || !right.quote || left.value !== right.value
      || left.pageSourceSpanId !== right.pageSourceSpanId) {
      issues.add('date_blind_issued_date_disagrees');
    } else issued = { value: left.value, firstKey: left.localKey, secondKey: right.localKey };
  }
  return { issues: [...issues], assignments, primary, issued };
}
