import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import Database from 'better-sqlite3';
import { reportFindingPageScope } from './report-source-page-scope.js';
import { accountReportReading, type ReportReadingAccountingInput } from './report-reading-accounting.js';
export { accountReportReading, type ReportReadingAccountingInput } from './report-reading-accounting.js';
import { reportReadingAuditSchema, type ReportReadingAudit, runtimeTurnRecoverySchema, runtimeRecoveryDiagnosticSchema,
  type RuntimeTurnRecovery, type RuntimeRecoveryDiagnostic, reportSupplementScopeSchema, type ReportSupplementScope } from '@contracts';
import { AUTOMATIC_UPLOAD_INTENTS_SQL, AutomaticUploadIntentStore } from './automatic-upload-intents.js';
import { assessmentKnowledgeRetrievalDiagnosticSchema, type AssessmentKnowledgeRetrievalDiagnostic } from './assessment-knowledge-diagnostic.js';
import { assessmentRejectionDiagnosticSchema, type AssessmentRejectionDiagnostic } from './assessment-rejection-diagnostic.js';
export { normalizeAssessmentRejectionCodes } from './assessment-rejection-diagnostic.js';
export type { AssessmentKnowledgeRetrievalDiagnostic } from './assessment-knowledge-diagnostic.js';
export { AutomaticUploadIntentStore, AUTOMATIC_UPLOAD_INTENTS_SQL } from './automatic-upload-intents.js';
import { projectDirectOriginalLegacyWhitespaceBindingIdentity, resolveDirectOriginalSourceBindingFromStoredRoles } from '@core';
import { aiPreferencesSchema, jobAssessmentOutcomeSchema, memberAssessmentSnapshotV3Schema, assessmentReviewAuditScopeValid, memberEvidenceRefSchema, clinicalTimeSchema, documentedPlanEvidence, reviewedSourceInstructionEvidence,
  observationCandidateSchema, reportMetadataCandidateSchema, clinicalContextSchema, updateActionScheduleInputSchema,
  directOriginalDateReviewCheckpointSchema, inspectDirectOriginalDateConsensus, DIRECT_ORIGINAL_DATE_READING_VERSION,
  clinicalContextHasValidSources, reportClinicalContextSchema, sourceManifestSchema, sourceVisualEvidenceSchema,
  observationStructuredSlotEvidence,
  type ClinicalContext, type ReportClinicalContext } from '@contracts';
import type {
  ActionItem,
  AiPreferences,
  AdoptMemberAssessmentActionInput,
  ConceptMapping,
  ConceptMappingReceipt,
  CreateManualNoteInput,
  DerivedSnapshotCandidate,
  ManualNote,
  JobAssessmentOutcome,
  MemberAssessmentSnapshotV3,
  MemberEvidenceRef,
  HealthEventRelationReceipt,
  MergeHealthEventsInput,
  ObservationCandidate,
  Person,
  ReportMetadataCandidate,
  ReportMetadataCorrectionReceipt,
  ReviewCandidateDiff,
  SourceManifest,
  SourceSpan,
  SplitHealthEventInput,
  SystemAnalysisSnapshot,
  SystemEvidenceBundle,
  UndoReportMetadataInput,
  UndoHealthEventRelationInput,
  UpdateReportMetadataInput,
  UpdateActionScheduleInput
} from '@contracts';
import { BODY_SYSTEM_REGISTRY_VERSION, CONCEPT_DICTIONARY_VERSION, MEMBER_MODEL_VERSION, bodySystemRegistry, calendarDateOccurrences, conceptDictionary, linkConceptToSystems, mapConcept, sameAdoptedActionScope, selectContextSystems, resolveReportSourceBinding, resolveDirectOriginalSourceBinding, resolveDirectOriginalWholeExcerptQuote, isVerifiedDirectOriginalSourceBinding, isDirectOriginalConditionSourceRole, sameDirectOriginalField, directOriginalFieldsProvenDistinct, directOriginalExpandedFindingProvesSourceRefinement, directOriginalLegacyFieldCanUpgradeToGroundedSlot, directOriginalTimeEvidenceProblems, evaluateDirectOriginalObservationCandidate, reconcileReportFact, reportFactSemantics, candidateToReconciliationFact, stableHash, createDirectOriginalSourceRefinementProof, type DirectOriginalSourceRefinementProof, type ReportReconciliationFact, type ResolvedReportSourceBinding } from '@core';
import { DIRECT_ORIGINAL_SOURCE_REFINEMENT_VERSION, verifyDirectOriginalSourceRefinementReview,
  type DirectOriginalSourceRefinementReview, type DirectOriginalSourceRefinementReceipt } from './direct-original-source-refinement.js';
export { DIRECT_ORIGINAL_SOURCE_REFINEMENT_VERSION, directOriginalSourceRefinementReviewSignature,
  directOriginalSourceRefinementPartSignature, assembleDirectOriginalRefinementParts,
  type DirectOriginalSourceRefinementPlanPart, type DirectOriginalSourceRefinementPart,
  type DirectOriginalSourceRefinementReview, type DirectOriginalSourceRefinementContext,
  type DirectOriginalSourceRefinementTarget } from './direct-original-source-refinement.js';
import { selectCanonicalStoredObservations, type CanonicalStoredObservationSelection } from './canonical-observations.js';
import { projectDirectOriginalCandidateFields, projectDirectOriginalMetadataFields,
  normalizedDirectOriginalAbnormalFlag, type DirectOriginalFieldAdmissionReview, type ReportSourcePageScope } from '@core';
export { selectCanonicalStoredObservations, type CanonicalStoredObservation,
  type CanonicalStoredObservationSelection } from './canonical-observations.js';

export const WORKSPACE_SCHEMA_VERSION = 44;
const SCHEMA_VERSION = WORKSPACE_SCHEMA_VERSION;

const assessmentActionSourcePrefix = 'assessment-v3:';

/** 身份只做确定的书写规范化，不做近似姓名匹配。 */
function normalizedPersonName(value: string): string {
  return value.normalize('NFKC').replace(/\s+/g, '').toLocaleLowerCase('zh-CN');
}

interface OriginalSourceLocator {
  id: string;
  page: number | null;
  blockId: string | null;
  lineStart: number | null;
  lineEnd: number | null;
}

/** 只识别原件自身的定位，旧版 DOC 转换页面不是原件页码，不能借此复用编号。 */
function originalSourceLocatorKey(span: OriginalSourceLocator, mediaType: string): string | null {
  if (span.blockId?.startsWith('local-vision-region:') || span.blockId?.startsWith('model-original-excerpt:')) return null;
  if (mediaType === 'application/pdf' || mediaType.startsWith('image/')) {
    return span.page !== null && Number.isInteger(span.page) && span.page > 0 ? `page:${span.page}` : null;
  }
  if (mediaType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
    return span.blockId ? `block:${span.blockId}` : null;
  }
  if (mediaType.startsWith('text/')) {
    return span.lineStart !== null && span.lineEnd !== null && Number.isInteger(span.lineStart)
      && Number.isInteger(span.lineEnd) && span.lineStart > 0 && span.lineEnd >= span.lineStart
      ? `lines:${span.lineStart}:${span.lineEnd}` : null;
  }
  return null;
}

/** 原件及内容哈希已核验后，仅复用唯一对应的定位 ID；全部文字与可信度仍来自新规范化。 */
function reuseUniqueOriginalSourceLocators(
  previous: OriginalSourceLocator[], manifest: SourceManifest, sourceMediaType: string
): SourceManifest {
  const oldByKey = new Map<string, OriginalSourceLocator[]>();
  const newCounts = new Map<string, number>();
  for (const span of previous) {
    const key = originalSourceLocatorKey(span, sourceMediaType);
    if (key) oldByKey.set(key, [...(oldByKey.get(key) ?? []), span]);
  }
  for (const span of manifest.spans) {
    const key = originalSourceLocatorKey(span, sourceMediaType);
    if (key) newCounts.set(key, (newCounts.get(key) ?? 0) + 1);
  }
  return { ...manifest, spans: manifest.spans.map((span) => {
    const key = originalSourceLocatorKey(span, sourceMediaType);
    const previous = key ? oldByKey.get(key) : undefined;
    return key && newCounts.get(key) === 1 && previous?.length === 1
      ? { ...span, id: previous[0]!.id } : { ...span };
  }) };
}

interface AssessmentActionSource {
  snapshotId: string;
  actionId: string;
  dedupeKey: string;
  evidenceRefs: MemberEvidenceRef[];
  sourceDate: string | null;
}

const processingRebuildStateTables = [
  'workspaces', 'persons', 'person_context_revisions', 'person_revisions', 'person_name_aliases', 'user_notes',
  'documents', 'source_objects', 'source_occurrences', 'source_spans', 'source_manifests', 'source_manifest_spans', 'document_conversions',
  'observations', 'observation_revisions', 'clinical_statements', 'encounters', 'encounter_documents',
  'document_commits', 'publication_events', 'acceptance_decisions', 'jobs', 'job_attempts', 'review_issues',
  'derived_snapshots', 'snapshot_evidence', 'member_assessment_snapshots_v3', 'system_analysis_snapshots_v2',
  'health_events_v2', 'report_records', 'report_source_links', 'report_metadata_revisions', 'event_report_links',
  'event_relation_changes', 'action_items', 'action_events', 'action_adoptions_v2', 'lifestyle_proposals_v2',
  'consents', 'inbox_bindings', 'schedules', 'exclusions', 'report_clinical_contexts',
  'observation_concept_mappings', 'system_fact_links', 'concept_mapping_corrections', 'derivation_dependencies',
  'extraction_repair_diagnostics', 'ai_transmissions', 'ai_transmission_receipts', 'batches', 'notifications', 'audit_events',
  'knowledge_entries', 'deleted_document_tombstones', 'backup_manifests',
  'automatic_upload_intents', 'automatic_upload_intent_items'
] as const;

function processingRebuildStateSignature(database: Database.Database): string {
  // 旧恢复点没有新增诊断表；按它实际存在的表计算原签名，不伪造空表改变旧签名。
  const state = processingRebuildStateTables.filter((table) => Boolean(database.prepare(
    "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?"
  ).get(table))).map((table) => [table,
    database.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]);
  return createHash('sha256').update(JSON.stringify(state)).digest('hex');
}

export interface AdoptedMemberAssessmentAction {
  action: ActionItem;
  dedupeKey: string;
  sourceAssessmentId: string;
  sourceActionId: string;
  evidenceRefs: MemberEvidenceRef[];
  sourceDate: string | null;
}

function sourceClinicalDate(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const parsed = clinicalTimeSchema.shape.value.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function assessmentActionSource(sourceRef: string | null): AssessmentActionSource | null {
  if (!sourceRef?.startsWith(assessmentActionSourcePrefix)) return null;
  try {
    const parsed = JSON.parse(sourceRef.slice(assessmentActionSourcePrefix.length)) as Record<string, unknown>;
    const evidenceRefs = Array.isArray(parsed.evidenceRefs) ? parsed.evidenceRefs.flatMap((value) => {
      const evidence = memberEvidenceRefSchema.safeParse(value);
      return evidence.success ? [evidence.data] : [];
    }) : [];
    return typeof parsed.snapshotId === 'string' && typeof parsed.actionId === 'string'
      && typeof parsed.dedupeKey === 'string'
      ? { snapshotId: parsed.snapshotId, actionId: parsed.actionId, dedupeKey: parsed.dedupeKey,
        evidenceRefs, sourceDate: sourceClinicalDate(parsed.sourceDate) } : null;
  } catch {
    return null;
  }
}

function calendarDateMatchesInText(text: string): Array<{ date: string; index: number; length: number }> {
  const dates: Array<{ date: string; index: number; length: number }> = [];
  const pattern = /(?<!\d)(\d{4})\s*(?:([-/.])\s*(\d{1,2})\s*\2\s*(\d{1,2})|年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日?)(?!\d)/g;
  for (const match of text.matchAll(pattern)) {
    const year = Number(match[1]);
    const month = Number(match[3] ?? match[5]);
    const day = Number(match[4] ?? match[6]);
    const parsed = new Date(Date.UTC(year, month - 1, day));
    if (parsed.getUTCFullYear() !== year || parsed.getUTCMonth() !== month - 1 || parsed.getUTCDate() !== day) continue;
    dates.push({
      date: `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
      index: match.index,
      length: match[0].length
    });
  }
  return dates;
}

function calendarDatesInText(text: string): string[] {
  return [...new Set(calendarDateMatchesInText(text).map((match) => match.date))];
}

function labelledCalendarDateMatchesInText(text: string): Array<{ date: string; index: number; length: number }> {
  const dates: Array<{ date: string; index: number; length: number }> = [];
  const pattern = /(?:检查|检验|采样|采集|体检|就诊|临床|报告)\s*日期\s*[：:]?\s*((?<!\d)(\d{4})\s*(?:([-/.])\s*(\d{1,2})\s*\3\s*(\d{1,2})|年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日?)(?!\d))/g;
  for (const match of text.matchAll(pattern)) {
    const year = Number(match[2]);
    const month = Number(match[4] ?? match[6]);
    const day = Number(match[5] ?? match[7]);
    const parsed = new Date(Date.UTC(year, month - 1, day));
    if (parsed.getUTCFullYear() !== year || parsed.getUTCMonth() !== month - 1 || parsed.getUTCDate() !== day) continue;
    dates.push({
      date: `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
      index: match.index,
      length: match[0].length
    });
  }
  return dates;
}

function hasUnambiguousContextualDateEvidence(spanQuote: string, citedQuote: string, clinicalDate: string): boolean {
  const quoteIndex = spanQuote.indexOf(citedQuote);
  if (quoteIndex < 0 || spanQuote.indexOf(citedQuote, quoteIndex + 1) >= 0) return false;
  const nearestPrecedingDate = labelledCalendarDateMatchesInText(spanQuote)
    .filter((match) => match.index + match.length <= quoteIndex)
    .sort((left, right) => right.index - left.index)[0];
  return Boolean(nearestPrecedingDate
    && nearestPrecedingDate.date === clinicalDate
    && quoteIndex - (nearestPrecedingDate.index + nearestPrecedingDate.length) <= 2_000);
}

function isUltrasoundMethod(value: string | null | undefined): boolean {
  if (!value) return false;
  return /(?:彩超|超声|b\s*超|ultrasound|sonograph|doppler)/i.test(value.normalize('NFKC'));
}

function compactEvidenceText(value: string): string {
  return value.normalize('NFKC').replace(/\s+/g, '').toLocaleLowerCase('zh-CN');
}

function isOptionalNormalSummaryCandidate(candidate: ObservationCandidate): boolean {
  const name = candidate.originalName.normalize('NFKC').replace(/\s+/g, ' ').trim().toLocaleLowerCase('zh-CN');
  if (!/(?:小结|总结|结论|印象|summary|impression)$/.test(name)) return false;
  if (candidate.reportedAbnormalFlag !== null
    && !/^(?:正常|未见异常|无异常|normal|no abnormality)$/.test(candidate.reportedAbnormalFlag.normalize('NFKC').trim().toLocaleLowerCase('zh-CN'))) {
    return false;
  }
  if (candidate.value.kind !== 'qualitative' && candidate.value.kind !== 'text') return false;
  return /^(?:未见异常|无异常|正常|no abnormality detected|normal)$/.test(
    candidate.value.rawText.normalize('NFKC').trim().toLocaleLowerCase('zh-CN')
  );
}

function isOptionalEmptyUnknownCandidate(candidate: ObservationCandidate): boolean {
  return candidate.value.kind === 'unknown'
    && !(candidate.value.rawText ?? '').trim()
    && candidate.reportedAbnormalFlag === null
    && !candidate.issues.some((issue) => issue.code.startsWith('blocking_'));
}

function uniquelyExpandedAbbreviatedQuote(source: string, cited: string): string | null {
  const parts = cited.split(/(?:…|\.\.\.)/).map((part) => part.trim()).filter(Boolean);
  if (parts.length !== 2) return null;
  const [prefix, suffix] = parts as [string, string];
  const prefixIndex = source.indexOf(prefix);
  if (prefixIndex < 0 || source.indexOf(prefix, prefixIndex + 1) >= 0) return null;
  const suffixIndex = source.indexOf(suffix, prefixIndex + prefix.length);
  if (suffixIndex < 0) return null;
  const nextSectionDate = labelledCalendarDateMatchesInText(source)
    .find((match) => match.index > prefixIndex + prefix.length);
  const sectionEnd = nextSectionDate?.index ?? source.length;
  if (suffixIndex + suffix.length > sectionEnd) return null;
  const repeatedSuffixIndex = source.indexOf(suffix, suffixIndex + 1);
  if (repeatedSuffixIndex >= 0 && repeatedSuffixIndex < sectionEnd) return null;
  const expanded = source.slice(prefixIndex, suffixIndex + suffix.length);
  return expanded.length <= 2_000 ? expanded : null;
}

function extractReportedNameFromIdentityEvidence(quote: string): string | null {
  const match = quote.normalize('NFKC').match(/姓\s*名\s*[：:]\s*([^\s，,；;。]{1,20}?)(?=\s*性\s*别\s*[：:])/);
  return match?.[1]?.trim() || null;
}

export interface WorkspaceStoreOptions {
  rootDirectory: string;
  now?: () => Date;
  busyTimeoutMs?: number;
  failureInjector?: (point: 'after_source_object_insert' | 'during_schema_migration') => void;
}

export interface SourceObjectInput {
  bytes: Uint8Array;
  mediaType: string;
  displayName: string;
}

export interface SourceObjectReceipt {
  id: string;
  sha256: string;
  size: number;
  vaultRelativePath: string;
  duplicate: boolean;
}

export interface ImportedDocumentReceipt {
  documentId: string;
  status: 'queued' | 'needs_review' | 'duplicate';
  duplicate: boolean;
}

export interface ImportedDocumentSummary {
  id: string;
  displayName: string;
  mediaType: string;
  discoveredAt: string;
  personId: string | null;
  personLabel: string | null;
  personAssignmentBasis: DocumentExtractionBundle['personAssignmentBasis'];
  status: 'queued' | 'needs_review' | 'completed' | 'blocked' | 'ignored';
  sourceLabel: string;
  issue: string | null;
}

export interface DeletedDocumentSummary {
  sourceHash: string;
  displayName: string;
  personId: string | null;
  mediaType: string;
  deletedAt: string;
  rawObjectRetained: boolean;
}

export interface DeleteDocumentReceipt {
  sourceHash: string;
  currentWorkspaceRemoved: true;
  rawObjectDeleted: boolean;
  retainedByRecoveryPoint: boolean;
}

export interface ReadyDocument {
  id: string;
  personId: string;
}

export interface InboxBindingSummary {
  id: string;
  displayName: string;
  personId: string | null;
  personLabel: string | null;
  recursive: boolean;
  aiProcessingAuthorized: boolean;
  enabled: boolean;
  createdAt: string;
}

export interface ActiveInboxBinding extends InboxBindingSummary {
  canonicalPath: string;
  consentId: string;
}

export interface DocumentExtractionBundle {
  documentId: string;
  personId: string;
  personDisplayName: string;
  personAssignmentBasis: 'user_selected' | 'folder_binding' | 'identity_confirmed' | 'legacy';
  confirmedReportedName: string | null;
  confirmedPersonAliases: string[];
  sourcePath: string;
  manifest: SourceManifest;
}

export interface ProcessingRebuildBackup {
  id: string;
  databasePath: string;
  stateSignature: string;
  createdAt: string;
}

export interface ProcessingRebuildSource {
  documentId: string;
  personId: string;
  sourceObjectId: string;
  sha256: string;
  mediaType: string;
  displayName: string;
  sourcePath: string;
  convertedSourcePath: string | null;
  convertedMediaType: string | null;
}

export interface DocumentOriginalSource {
  documentId: string;
  personId: string | null;
  personArchived: boolean;
  sourceObjectId: string;
  sha256: string;
  mediaType: string;
  displayName: string;
  sourcePath: string;
  status: ImportedDocumentSummary['status'];
  excludedFromAnalysis: boolean;
}

export interface JobExecutionGuard {
  jobId: string;
  attemptId: string;
  consentId: string;
  accountFingerprint: string;
}

interface ExtractionChunkCheckpoint {
  consentId: string;
  documentId: string;
  signature: string;
  chunkIndex: number;
  output: unknown;
  threadId: string;
  turnId: string;
  extractionTurnId: string;
}

export interface DocumentConversionInput {
  documentId: string;
  convertedSourceObjectId: string;
  converterId: string;
  converterVersion: string;
  executableSha256: string;
  warnings: string[];
}

export interface OpenExtractionReviewIssue {
  id: string;
  documentId: string;
  personId: string | null;
  kind: 'person_conflict' | 'field_conflict' | 'coverage_gap' | 'overwrite_protected' | 'derived_safety';
  severity: 'blocking' | 'warning';
  evidenceRefs: string[];
  candidateOptions: ObservationCandidate[];
  readingAudit?: ReportReadingAudit;
  candidateDiffs: ReviewCandidateDiff[];
  reportedName: string | null;
  reasonCodes: string[];
  jobId: string | null;
  attemptId: string | null;
  stage: string | null;
  documentRun: {
    coverageComplete: boolean;
    coveredSourceSpanIds: string[];
    manifestSpanIds: string[];
    chunkCount: number;
  } | null;
}

/** 旧姓名门禁可被既有明确归属替代；其他身份、来源或医疗问题仍须走原保护。 */
function isUserAssignedIdentityRepairIssue(
  issue: OpenExtractionReviewIssue,
  assignmentBasis: string,
  personId: string
): boolean {
  return ['user_selected', 'identity_confirmed'].includes(assignmentBasis)
    && issue.personId === personId && issue.stage === 'extract'
    && ['person_conflict', 'coverage_gap'].includes(issue.kind) && issue.severity === 'blocking'
    && issue.candidateDiffs.length === 0
    && issue.reasonCodes.length > 0
    && issue.reasonCodes.every((code) => ['PERSON_IDENTITY_NOT_CONFIRMED', 'DIRECT_ORIGINAL_IDENTITY_UNPROVEN'].includes(code));
}

function isSourceExtractionRepairIssue(issue: OpenExtractionReviewIssue): boolean {
  return issue.stage === 'extract' && ['field_conflict', 'coverage_gap'].includes(issue.kind)
    && issue.candidateDiffs.length === 0
    && !issue.reasonCodes.some((code) => code.startsWith('PERSON_') || code === 'DIRECT_ORIGINAL_IDENTITY_UNPROVEN');
}

export interface StoredJobSummary {
  id: string;
  documentIds: string[];
  batchLabel: string;
  personLabel: string | null;
  stage: 'extract' | 'review_facts' | 'analyze' | 'guidance' | 'review_derived' | 'system_analysis' | 'system_review' | 'publish';
  status: 'queued' | 'running' | 'waiting_auth' | 'waiting_quota' | 'waiting_user' | 'retry_wait' | 'succeeded' | 'completed_with_issues' | 'failed' | 'cancelled';
  completedUnits: number;
  totalUnits: number;
  statusText: string;
  systemOutcomes: Array<{
    systemId: string;
    status: 'published' | 'rejected' | 'skipped_no_data' | 'skipped_cache' | 'out_of_scope';
    reason: string | null;
    inputSignature: string | null;
    updatedAt: string;
  }>;
  assessmentOutcome: JobAssessmentOutcome | null;
  updatedAt: string;
}

export interface JobExecution {
  id: string;
  personId: string;
  documentIds: string[];
  consentId: string;
  attemptCount: number;
  stage: StoredJobSummary['stage'];
  modelBusyRetry?: ModelBusyRetryState;
  phaseAnalysisAiPreferences?: AiPreferences;
}

export interface ModelBusyRetryState {
  retryCount: number;
  nextRetryAt: string | null;
  analysisAiPreferences: AiPreferences;
}

const modelBusyRetryDelaysMs = [30_000, 120_000] as const;

/** 重试状态不含报告或服务原文；损坏状态不得扩大自动调用预算。 */
function parseModelBusyRetryState(value: unknown): ModelBusyRetryState | null {
  if (!value || typeof value !== 'object') return null;
  const input = value as Record<string, unknown>;
  const preferences = aiPreferencesSchema.safeParse(input.analysisAiPreferences);
  if (!Number.isInteger(input.retryCount) || Number(input.retryCount) < 1
    || Number(input.retryCount) > modelBusyRetryDelaysMs.length || !preferences.success
    || (input.nextRetryAt !== null && (typeof input.nextRetryAt !== 'string'
      || !Number.isFinite(new Date(input.nextRetryAt).getTime())))) return null;
  return { retryCount: Number(input.retryCount), nextRetryAt: input.nextRetryAt as string | null,
    analysisAiPreferences: preferences.data };
}

export interface StoredSchedule {
  id: string;
  enabled: boolean;
  localTime: `${number}:${number}`;
  timeZone: string;
  lastSlot: string | null;
  nextRunUtc: string | null;
  revision: number;
}

export interface ScheduledReadyGroup {
  personId: string;
  consentId: string;
  accountFingerprint: string | null;
  documentIds: string[];
}

export interface PublishFactsInput {
  readingAccounting?: ReportReadingAccountingInput;
  personId: string;
  documentId: string;
  documentCommitKey: string;
  expectedRevision: number;
  changeSetHash: string;
  summary: string;
  reportMetadata?: ReportMetadataCandidate | null;
  observations: Array<{
    conceptKey: string;
    originalName?: string;
    modelStandardNameCandidate?: string | null;
    rawText: string;
    valueKind: 'numeric' | 'qualitative' | 'text' | 'unknown';
    decimalValue: string | null;
    qualifier: string | null;
    unit: string | null;
    referenceRange: string | null;
    clinicalDate: string | null;
    abnormalFlag: 'high' | 'low' | 'positive' | 'negative' | 'normal' | 'unknown';
    documentId: string;
    sourceSpanId: string;
    acceptanceId: string;
    specimen: string | null;
    method: string | null;
    bodySite: string | null;
    clinicalContext?: ClinicalContext | null;
    /** 原候选供来源槽位对账及局部保留使用；不是永久记录编号。 */
    candidate?: ObservationCandidate;
    sourceBinding?: ObservationCandidate['sourceBinding'];
    evidence: Array<{
      sourceSpanId: string;
      quote: string | null;
      sourceRole?: 'primary' | 'duplicate_source' | undefined;
      duplicateBasis?: 'report_structure' | 'exam_item_id' | 'sample_id' | null | undefined;
    }>;
  }>;
  executionGuard?: JobExecutionGuard;
  resolvedReviewIssueId?: string;
  /** 首次发布时仍无法核实的项目；与事实和 document commit 同一事务落库。 */
  unresolvedReview?: {
    kind: 'field_conflict' | 'coverage_gap';
    evidenceRefs: string[];
    candidateOptions?: ObservationCandidate[];
    reasonCodes?: string[];
    fieldReviews?: DirectOriginalFieldAdmissionReview[];
    documentRun?: NonNullable<OpenExtractionReviewIssue['documentRun']>;
  };
}

/** 已提交报告只能追加经重新接纳的新事实，不走首次提交的幂等捷径。 */
export interface AppendCommittedFactsInput {
  readingAccounting?: ReportReadingAccountingInput;
  personId: string;
  documentId: string;
  expectedRevision: number;
  summary: string;
  observations: PublishFactsInput['observations'];
  /** 重跑中来源已证明的元数据，仅用于补充尚未注明的报告日期。 */
  reportMetadata?: ReportMetadataCandidate | null;
  /** 本轮真实 P01/P03 及受限旧版本映射；仅能补来源，不能替换医疗字段。 */
  sourceRefinementReview?: DirectOriginalSourceRefinementReview;
  reviewUpdate: {
    /** 无旧疑点的显式维护可为空；仍须绑定当前有效的重核任务与授权。 */
    issueId: string | null;
    remainingCandidates: ObservationCandidate[];
    remainingReasonCodes: string[];
    remainingEvidenceRefs: string[];
    fieldReviews?: DirectOriginalFieldAdmissionReview[];
    /** 原件重读不能以漏列代替解决旧疑点；只以本轮正式接纳的同来源字段收窄。 */
    reconciliationMode?: 'source_proven';
  };
  executionGuard?: JobExecutionGuard;
}

export interface AppendCommittedFactsReceipt {
  reviewIssueId: string | null;
  publicationId: string | null;
  revision: number;
  appendedCount: number;
  duplicateCount: number;
  updatedCount: number;
  heldCount: number;
  heldCandidates: ObservationCandidate[];
  heldReasonCodes: string[];
  idempotent: boolean;
  reviewResolved: boolean;
}

export interface PublishFactsReceipt {
  publicationId: string;
  revision: number;
  idempotent: boolean;
  duplicateCount: number;
  heldCount: number;
  heldCandidates: ObservationCandidate[];
  heldReasonCodes: string[];
  reviewIssueId: string | null;
}

/** 在内存原件来源上预检，既不建立接纳决定，也不保存任何工作记录。 */
export interface DirectOriginalAdmissionPreviewInput {
  personId: string;
  documentId: string;
  manifest: SourceManifest;
  observations: PublishFactsInput['observations'];
  reportMetadata?: ReportMetadataCandidate | null;
  sourceRefinementReview?: DirectOriginalSourceRefinementReview;
  executionGuard?: JobExecutionGuard;
  fieldReviews?: DirectOriginalFieldAdmissionReview[];
}

export interface DirectOriginalAdmissionComparisonRecord {
  recordId: string;
  /** 只留在应用本机的旧行 CAS 版本，不进入模型输入。 */
  recordRevision?: number;
  recordHash?: string;
  origin: 'stored_version' | 'current_reading';
  bindingStatus: 'resolved' | 'unresolved';
  candidate: ObservationCandidate;
  sourceSpans: SourceSpan[];
}

export interface DirectOriginalAdmissionDiagnostic {
  kind: 'reconciliation' | 'batch_conflict';
  decision: ReturnType<typeof reconcileReportFact>['decision'];
  changedFields: string[];
  comparisonScope: 'none' | 'stored_version' | 'current_reading' | 'mixed';
  comparisons: DirectOriginalAdmissionComparisonRecord[];
}

export interface DirectOriginalReportAdmissionDiagnostic {
  scope: 'current_reading' | 'stored_version' | 'shared_event';
  reasonCodes: string[];
  current: ReportMetadataCandidate['times'];
  sourceSpans: SourceSpan[];
  comparisons: Array<{
    origin: 'stored_version' | 'shared_event';
    reportId: string;
    sourceDocumentId: string;
    sourceSha256: string | null;
    times: ReportMetadataCandidate['times'];
    sourceSpans: SourceSpan[];
    clinicalDate?: string | null;
    reportDate?: string | null;
  }>;
}

export interface DirectOriginalAdmissionPreview {
  mode: 'publish' | 'append';
  held: Array<{ candidate: ObservationCandidate; reasons: string[]; diagnostic?: DirectOriginalAdmissionDiagnostic }>;
  acceptedCount: number;
  duplicateCount: number;
  refinedCount: number;
  reportReasonCodes: string[];
  reportDiagnostics?: DirectOriginalReportAdmissionDiagnostic[];
}

type PublishedObservationInput = PublishFactsInput['observations'][number];

interface StoredReconciliationObservationRow {
  id: string; current_revision: number; acceptance_actor: string; user_locked: number;
  concept_key: string; original_name: string | null; value_kind: PublishedObservationInput['valueKind'];
  raw_text: string; decimal_value: string | null; qualifier: string | null;
  unit: string | null; reference_range: string | null;
  abnormal_flag: PublishedObservationInput['abnormalFlag']; specimen: string | null;
  method: string | null; body_site: string | null; source_span_id: string;
  clinical_date: string | null; evidence_json: string; clinical_context_json: string | null; source_binding_json: string | null;
}

interface CanonicalObservationRow extends StoredReconciliationObservationRow {
  person_id: string;
  document_id: string;
  created_at: string;
  display_clinical_date: string | null;
}

type CanonicalObservationRowSelection = CanonicalStoredObservationSelection<
  import('./canonical-observations.js').CanonicalStoredObservation & { row: CanonicalObservationRow }>;

interface ReportSourceAdmissionPlan {
  existingRows: StoredReconciliationObservationRow[];
  additions: PublishedObservationInput[];
  /** 排除所有后续被撤回/保留的输入，含最终判重与补强，供旧疑点逐项对账。 */
  admittedObservations: PublishedObservationInput[];
  bindings: Map<PublishedObservationInput, ResolvedReportSourceBinding | null>;
  refinements: Map<string, { observation: PublishedObservationInput; binding: ResolvedReportSourceBinding;
    field: 'clinicalDate' | 'clinicalContext' | 'sourceBinding'; dateEvidence: PublishedObservationInput['evidence']; contextJson?: string }>;
  held: DirectOriginalAdmissionPreview['held'];
  heldCandidates: ObservationCandidate[];
  heldReasonCodes: string[];
  duplicateCount: number;
}

interface DateCorrectionScope {
  purpose: 'date_correction'; documentId: string; personId: string;
  sourceObjectId: string; sha256: string; revision: string;
}

export interface DateCorrectionFactScope {
  scopeId: string; observationId: string; originalName: string; specimen: string | null; method: string | null; bodySite: string | null;
}

/** 兼容旧调用方，但 localKey 只供候选展示，不参与来源身份。 */
function publishedObservationCandidate(observation: PublishedObservationInput): ObservationCandidate {
  const value: ObservationCandidate['value'] = observation.valueKind === 'numeric' && observation.decimalValue !== null
    ? { kind: 'numeric', rawText: observation.rawText, decimal: observation.decimalValue,
        comparator: ['eq', 'lt', 'lte', 'gt', 'gte'].includes(observation.qualifier ?? '')
          ? observation.qualifier as 'eq' | 'lt' | 'lte' | 'gt' | 'gte' : 'eq' }
    : observation.valueKind === 'qualitative'
      ? { kind: 'qualitative', rawText: observation.rawText, category: observation.qualifier }
      : observation.valueKind === 'unknown'
        ? { kind: 'unknown', rawText: observation.rawText, reason: 'legacy_unknown' }
        : { kind: 'text', rawText: observation.rawText };
  return {
    ...(observation.candidate ?? {}),
    localKey: (observation.candidate?.localKey ?? observation.acceptanceId) || 'legacy-source-record',
    originalName: observation.originalName ?? observation.conceptKey,
    standardNameCandidate: observation.modelStandardNameCandidate ?? null, value,
    unitRaw: observation.unit, referenceRangeRaw: observation.referenceRange,
    reportedAbnormalFlag: observation.abnormalFlag === 'unknown' ? null : observation.abnormalFlag,
    specimen: observation.specimen, method: observation.method, bodySite: observation.bodySite,
    clinicalDate: observation.clinicalDate, clinicalContext: observation.clinicalContext ?? null,
    evidence: observation.evidence, issues: observation.candidate?.issues ?? [],
    ...(observation.sourceBinding ? { sourceBinding: observation.sourceBinding } : {})
  };
}

/** 只用数据库原来源段及其完整引用证明页范围；任一缺段/未知页都保留为未知竞争范围。 */
function observationSourcePageScope(observation: PublishedObservationInput, manifest: SourceManifest): ReportSourcePageScope | null {
  return reportFindingPageScope(observation, manifest);
}

/** 保存的绑定只提供待重证的结构；JSON 标签本身不授予来源权限。 */
function storedReportSourceBinding(value: string | null): ResolvedReportSourceBinding | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as Partial<ResolvedReportSourceBinding> | null;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || parsed.version !== 1
      || !['sourceObjectId', 'documentId', 'sourceSha256', 'normalizerVersion', 'sourceViewId', 'key']
        .every((field) => typeof parsed[field as keyof typeof parsed] === 'string')
      || !Array.isArray(parsed.units) || !parsed.units.length || parsed.units.some((unit) => !unit || typeof unit !== 'object'
        || typeof unit.sourceSpanId !== 'string' || !['page', 'block', 'line', 'image', 'table_cell'].includes(unit.spanKind)
        || unit.page !== null && (!Number.isInteger(unit.page) || unit.page < 1)
        || unit.blockId !== null && typeof unit.blockId !== 'string'
        || ![unit.lineStart, unit.lineEnd].every((line) => line === null || Number.isInteger(line) && line > 0)
        || !Number.isInteger(unit.segmentStart) || !Number.isInteger(unit.segmentEnd)
        || unit.segmentStart < 0 || unit.segmentEnd <= unit.segmentStart)) return null;
    if (parsed.directOriginalField && (parsed.directOriginalField.version !== 1
      || typeof parsed.directOriginalField.fieldKey !== 'string' || !Array.isArray(parsed.directOriginalField.headingKeys)
      || parsed.directOriginalField.headingKeys.some((key) => typeof key !== 'string'))) return null;
    return parsed as ResolvedReportSourceBinding;
  } catch { return null; }
}

function heldReconciliationCandidate(observation: PublishedObservationInput, reasons: string[]): ObservationCandidate {
  const candidate = publishedObservationCandidate(observation);
  return { ...candidate, issues: [...candidate.issues,
    ...reasons.filter((code) => !candidate.issues.some((issue) => issue.code === code))
      .map((code) => ({ code, message: '来源对应或既有结果存在差异，可靠内容继续保存，此项单独保留核对。' }))] };
}

function uniqueCandidates(candidates: ObservationCandidate[]): ObservationCandidate[] {
  return [...new Map(candidates.map((candidate) => [JSON.stringify(candidate), candidate])).values()];
}

function publishedReconciliationFact(observation: PublishedObservationInput): ReportReconciliationFact {
  return {
    originalName: observation.originalName ?? observation.conceptKey,
    rawText: observation.rawText, valueKind: observation.valueKind, decimalValue: observation.decimalValue,
    qualifier: observation.qualifier, unit: observation.unit, referenceRange: observation.referenceRange,
    abnormalFlag: observation.abnormalFlag, specimen: observation.specimen, method: observation.method,
    bodySite: observation.bodySite, clinicalDate: observation.clinicalDate,
    clinicalContext: observation.clinicalContext ?? null
  };
}

/** 先把同轮同来源的矛盾整组标记，不能让后出现的重复候选重新复活已撤回的补充。 */
function conflictingSourceBatchGroups(
  observations: PublishedObservationInput[], bindings: Map<PublishedObservationInput, ResolvedReportSourceBinding | null>
): Map<PublishedObservationInput, { observations: PublishedObservationInput[]; changedFields: string[] }> {
  const conflicted = new Map<PublishedObservationInput, { observations: PublishedObservationInput[]; changedFields: string[] }>();
  const groups: PublishedObservationInput[][] = [];
  for (const observation of observations) {
    const binding = bindings.get(observation);
    if (!binding) continue;
    // 同名字段可能处于不同历史列/行，是否同槽只信核心的已核验真实引用。
    // 相交/包含范围形成传递整组；不能让后出现的重复项复活已发现的矛盾。
    const matching = groups.filter((group) => group.some((previous) => {
      const old = bindings.get(previous);
      return old && !directOriginalFieldsProvenDistinct(binding, old)
        && (binding.key === old.key || sameDirectOriginalField(binding, old));
    }));
    const merged = [observation, ...matching.flat()];
    for (const group of matching) groups.splice(groups.indexOf(group), 1);
    groups.push(merged);
  }
  for (const group of groups) {
    const changedFields = new Set<string>();
    for (const [index, left] of group.entries()) {
      const leftSemantics = reportFactSemantics(publishedReconciliationFact(left));
      for (const right of group.slice(index + 1)) {
        const rightSemantics = reportFactSemantics(publishedReconciliationFact(right));
        for (const field of Object.keys(leftSemantics)) {
          // “未注明”与明确日期是可能补充，不代表两个已确定日期相冲突。
          if (field === 'clinicalDate' && (!left.clinicalDate || !right.clinicalDate)) continue;
          if (leftSemantics[field] !== rightSemantics[field]) changedFields.add(field);
        }
      }
    }
    if (changedFields.size) for (const observation of group) conflicted.set(observation,
      { observations: group, changedFields: [...changedFields] });
  }
  return conflicted;
}

/** 诊断只携带实际引用及其原页父项，不把同页其他项目扩成对照证据。 */
function admissionDiagnosticSourceSpans(manifest: SourceManifest | null, documentId: string,
  references: ObservationCandidate['evidence']): SourceSpan[] {
  if (!manifest) return [];
  const byId = new Map(manifest.spans.map((span) => [span.id, span]));
  const selected = new Map<string, SourceSpan>();
  const add = (id: string, parent = false) => {
    const span = byId.get(id);
    if (!span || selected.has(id) || span.documentId !== documentId
      || !parent && (span.readability !== 'clear' || !span.quote?.trim())
      || span.modelEvidence && (span.modelEvidence.originalSha256 !== manifest.sha256
        || span.modelEvidence.originalSourceObjectId !== manifest.sourceObjectId)) return;
    selected.set(id, span);
    if (span.modelEvidence) add(span.modelEvidence.parentSourceSpanId, true);
    if (span.blockId?.startsWith('local-vision-region:')) add(span.blockId.slice('local-vision-region:'.length), true);
  };
  for (const reference of references) add(reference.sourceSpanId);
  return [...selected.values()];
}

function admissionComparisonScope(comparisons: DirectOriginalAdmissionComparisonRecord[]): DirectOriginalAdmissionDiagnostic['comparisonScope'] {
  const origins = new Set(comparisons.map((record) => record.origin));
  return origins.size > 1 ? 'mixed' : comparisons[0]?.origin ?? 'none';
}

/** 日期角色依原文完整上下文核验，紧引用不能抹掉原文中的历史栏目。 */
function hasCurrentLabelledSourceDate(text: string, value: string, role: 'clinical' | 'report_issued', minimumIndex = 0): boolean {
  const compact = (part: string) => part.normalize('NFKC').replace(/\s+/gu, '');
  return calendarDateOccurrences(text).some((date) => {
    if (date.date !== value || date.index < minimumIndex) return false;
    const prefix = compact(text.slice(Math.max(0, date.index - 40), date.index));
    const before = text.slice(0, date.index).normalize('NFKC');
    const lastHeading = (pattern: RegExp) => [...before.matchAll(pattern)].at(-1)?.index ?? -1;
    const historical = lastHeading(/(?:^|\n)[ \t]*(?:历史(?:对比|检查|结果|记录)(?:结果)?|既往(?:检查|结果|记录)|历年(?:对比|检查|结果)(?:结果)?|往年(?:检查|结果)|前次(?:检查|结果))[ \t]*[：:]?[ \t]*(?=\n|$)/gu);
    const current = lastHeading(/(?:^|\n)[ \t]*(?:本次检查|本次结果|当前检查|当前结果|本年度检查)[ \t]*[：:]?[ \t]*(?=\n|$)/gu);
    if (historical >= 0 && historical > current) return false;
    if (/(?:历史|上次|既往|历年|往年|前次|此前)(?:的)?(?:检查|检验|采样|采集|采血|体检|复查|就诊|临床|报告|签发|出具|打印|审核)(?:日期|时间)?[：:]?$/.test(prefix)) return false;
    if (/(?:非|不是|并非|未(?:作|行|做)?|无)(?:本次|当前)?(?:检查|检验|采样|采集|采血|体检|复查|就诊|临床|报告|签发|出具|打印|审核)(?:日期|时间)?[：:]?$/.test(prefix)) return false;
    return (role === 'report_issued' ? /(?:报告|签发|出具|打印|审核)(?:日期|时间)?[：:]?$/
      : /(?:检查|检验|采样|采集|采血|体检|复查|就诊|临床)(?:日期|时间)?[：:]?$/).test(prefix);
  });
}

interface CommittedReportDateEnrichment {
  reportIds: string[];
  heldReasonCodes: string[];
  heldEvidenceRefs: string[];
}

interface CommittedReportDateRow {
  id: string; event_id: string; report_date: string | null; metadata_status: string; metadata_revision: number;
  clinical_date: string | null; end_date: string | null; date_precision: string; date_role: string; date_source: string;
  event_metadata_status: string; event_metadata_revision: number; payload_json: string; evidence_refs_json: string; actor: string;
}

interface CommittedReportDateEnrichmentPlan extends CommittedReportDateEnrichment {
  diagnostics?: DirectOriginalReportAdmissionDiagnostic[];
  change: {
    kind: 'enrich';
    row: CommittedReportDateRow;
    previousPayload: Record<string, unknown> & { extracted?: ReportMetadataCandidate | null };
    fillClinical: ReportMetadataCandidate['times'][number] | undefined;
    fillSigned: ReportMetadataCandidate['times'][number] | undefined;
    supplements: ReportMetadataCandidate['times'];
  } | {
    kind: 'reproject';
    row: CommittedReportDateRow;
    previousPayload: Record<string, unknown> & { extracted?: ReportMetadataCandidate | null };
    metadata: ReportMetadataCandidate;
    clinical: ReportMetadataCandidate['times'][number] | null;
    reportDate: string | null;
    eventChanged: boolean;
  } | null;
}

interface PrimaryClinicalTimeSelection {
  time: ReportMetadataCandidate['times'][number] | null;
  heldReasonCodes: string[];
  heldEvidenceRefs: string[];
  diagnostics?: DirectOriginalReportAdmissionDiagnostic[];
}

/** 日期投影只信直接原件模型回执的真实摘录和原页骨架，不信旧OCR或裸JSON标签。 */
function trustedDirectReportTime(time: ReportMetadataCandidate['times'][number], manifest: SourceManifest, documentId: string): boolean {
  return directOriginalTimeEvidenceProblems(time, manifest, documentId).length === 0;
}

/** 只按可证明的原件顺序接回前置栏目；无法排序时不猜测日期所属章节。 */
function orderedDateSourceContext(manifest: SourceManifest, targetId: string): { text: string; minimumIndex: number } | null {
  const requested = manifest.spans.find((span) => span.id === targetId);
  const parentId = requested?.blockId?.startsWith('local-vision-region:')
    ? requested.blockId.slice('local-vision-region:'.length) : targetId;
  // 辅助裁剪不是另一检查页，章节顺序只来自完整原页；原引用ID仍由调用方保留。
  manifest = { ...manifest, spans: manifest.spans.filter((span) => !span.blockId?.startsWith('local-vision-region:')) };
  targetId = parentId;
  const target = manifest.spans.find((span) => span.id === targetId);
  if (!target?.quote || target.readability !== 'clear') return null;
  if (manifest.spans.length === 1) return { text: target.quote, minimumIndex: 0 };
  const pageOrdered = manifest.spans.every((span) => span.page !== null && Number.isInteger(span.page) && span.page > 0)
    && new Set(manifest.spans.map((span) => span.page)).size === manifest.spans.length;
  const lineOrdered = manifest.spans.every((span) => span.lineStart !== null && span.lineEnd !== null
    && span.lineStart > 0 && span.lineEnd >= span.lineStart)
    && new Set(manifest.spans.map((span) => span.lineStart)).size === manifest.spans.length;
  const blockOrdered = manifest.spans.every((span) => /^block-\d+$/u.test(span.blockId ?? ''))
    && new Set(manifest.spans.map((span) => span.blockId)).size === manifest.spans.length;
  const tableOrdered = manifest.spans.every((span) => /^table-\d+-row-\d+-cell-\d+$/u.test(span.blockId ?? ''))
    && new Set(manifest.spans.map((span) => span.blockId)).size === manifest.spans.length;
  const rank = (span: SourceManifest['spans'][number]) => pageOrdered ? [span.page!]
    : lineOrdered ? [span.lineStart!] : [...(span.blockId ?? '').matchAll(/\d+/gu)].map((match) => Number(match[0]));
  if (!pageOrdered && !lineOrdered && !blockOrdered && !tableOrdered) return null;
  const ordered = [...manifest.spans].sort((left, right) => {
    const a = rank(left); const b = rank(right);
    for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
      const compared = (a[index] ?? 0) - (b[index] ?? 0);
      if (compared) return compared;
    }
    return 0;
  });
  if (lineOrdered && ordered.some((span, index) => index > 0 && span.lineStart! <= ordered[index - 1]!.lineEnd!)) return null;
  const before = ordered.slice(0, ordered.findIndex((span) => span.id === targetId));
  if (before.some((span) => span.readability !== 'clear' || span.quote === null)) return null;
  const prefix = before.map((span) => span.quote).join('\n');
  return { text: prefix ? `${prefix}\n${target.quote}` : target.quote, minimumIndex: prefix ? prefix.length + 1 : 0 };
}

function normalizedFactPart(value: string | null | undefined): string {
  return (value ?? '').normalize('NFKC').replace(/\s+/g, ' ').trim().toLocaleLowerCase('zh-CN');
}

/** 不用模型生成的 localKey 判重：它在重跑时可能变化。 */
function committedFactIdentity(observation: PublishedObservationInput): string {
  return JSON.stringify([
    normalizedFactPart(observation.originalName || observation.conceptKey),
    observation.clinicalDate ?? '', normalizedFactPart(observation.specimen),
    normalizedFactPart(observation.method), normalizedFactPart(observation.bodySite)
  ]);
}

function committedFactValue(observation: PublishedObservationInput): string {
  return JSON.stringify([
    normalizedFactPart(observation.conceptKey), observation.valueKind,
    observation.valueKind === 'numeric' && observation.decimalValue !== null
      ? String(Number(observation.decimalValue)) : normalizedFactPart(observation.rawText),
    normalizedFactPart(observation.qualifier), normalizedFactPart(observation.unit),
    normalizedFactPart(observation.referenceRange), observation.abnormalFlag
  ]);
}

export interface AcceptedObservationSummary {
  id: string;
  personId: string;
  conceptKey: string;
  originalName: string;
  originalNameStatus: 'recorded' | 'legacy_missing';
  modelStandardNameCandidate: string | null;
  rawText: string;
  valueKind: 'numeric' | 'qualitative' | 'text' | 'unknown';
  decimalValue: string | null;
  qualifier: string | null;
  unit: string | null;
  referenceRange: string | null;
  clinicalDate: string | null;
  abnormalFlag: 'high' | 'low' | 'positive' | 'negative' | 'normal' | 'unknown';
  sourceSpanId: string;
  sourceQuote: string | null;
  sourceLabel: string;
  documentId: string;
  eventId: string | null;
  specimen: string | null;
  method: string | null;
  bodySite: string | null;
  clinicalContext?: ClinicalContext | null;
  evidence: Array<{
    sourceSpanId: string;
    quote: string | null;
    sourceRole?: 'primary' | 'duplicate_source' | undefined;
    duplicateBasis?: 'report_structure' | 'exam_item_id' | 'sample_id' | null | undefined;
  }>;
  mapping: ConceptMapping;
  mappingVersion: string;
  mappingCorrectedAt: string | null;
  mappingCanUndo: boolean;
  createdAt: string;
}

export interface StoredReportMetadataSummary {
  documentId: string;
  reportId: string;
  eventId: string;
  title: string;
  reportKind: string;
  organization: string | null;
  reportDate: string | null;
  metadataStatus: 'confirmed' | 'inferred' | 'unknown' | 'corrected';
  metadataRevision: number;
  extracted: ReportMetadataCandidate | null;
  department: string | null;
  clinicalTime: { value: string | null; precision: 'year' | 'month' | 'day' | 'unknown' };
  canUndo: boolean;
}

export interface DirectOriginalReportDateProjectionUpgradeReceipt {
  upgradedReportIds: string[];
  affectedPersonIds: string[];
  skippedActive: boolean;
}

export interface ActiveEventRelationChange {
  id: string;
  action: 'merge' | 'split';
  fromEventId: string;
  toEventId: string;
  reportIds: string[];
  createdAt: string;
}

export interface PublishedDerivedSnapshot {
  id: string;
  personId: string;
  factRevision: number;
  contextRevision: number;
  promptVersion: string;
  rulesVersion: string;
  modelId: string;
  status: 'current' | 'stale' | 'building' | 'unavailable';
  payload: DerivedSnapshotCandidate;
  createdAt: string;
}

export type PublishedSystemAnalysisSnapshot = SystemAnalysisSnapshot;

export interface StoredLifestyleProposal {
  id: string;
  personId: string;
  category: 'exercise' | 'diet' | 'sleep' | 'monitoring' | 'review' | 'other';
  title: string;
  dedupeKey: string;
  goal: string;
  rationale: string;
  detail: string;
  steps: string[];
  startingOptions: string[];
  scheduleSuggestion: string | null;
  trackingSuggestion: string;
  constraints: string[];
  uncertainties: string[];
  consultProfessional: boolean;
  evidenceObservationIds: string[];
  generalKnowledgeEvidence: Array<{
    id: string;
    sourceTitle: string;
    sourceOrganization: string;
    sourceUrl: string;
    reviewedAt: string;
    supportedScope: string;
    verificationStatus: 'unverified_model_candidate' | 'controlled_source_verified';
  }>;
  sourceKind: 'ai_proposed' | 'clinician_reported' | 'care_preparation';
  relatedSystemIds: string[];
  status: 'proposed' | 'adopted' | 'dismissed' | 'superseded';
  sourceSnapshotId: string | null;
  version: number;
  updatedAt: string;
}

export interface StoredActionAdoption {
  id: string;
  personId: string;
  proposalId: string | null;
  title: string;
  userGoal: string;
  selectedStartingOption: string;
  plannedTime: string | null;
  owner: string;
  progressNote: string | null;
  status: 'proposed' | 'discussed' | 'planned' | 'in_progress' | 'paused' | 'completed' | 'dismissed';
  dueDate: string | null;
  userRevision: number;
  updatedAt: string;
}

export interface EvidenceAccess {
  sourceSpanId: string;
  documentId: string;
  displayName: string;
  mediaType: string;
  locator: string;
  quote: string | null;
  readability: 'clear' | 'partial' | 'unreadable';
  sourcePath: string;
  sourcePage: number | null;
  conversionView: boolean;
}

export class RevisionConflictError extends Error {
  constructor(public readonly expected: number, public readonly actual: number) {
    super(`REVISION_CONFLICT: expected ${expected}, actual ${actual}`);
  }
}

export class WorkspaceStore {
  private closed = false;
  readonly automaticUploadIntents: AutomaticUploadIntentStore;
  private canonicalObservationReadCache?: { databaseToken: string; scopes: Map<string, CanonicalObservationRowSelection> };
  private canonicalObservationDocumentCache?: Map<string, { fingerprint: string; selection: CanonicalObservationRowSelection }>;
  private restoredDirectSourceBindings?: WeakMap<PublishedObservationInput, ResolvedReportSourceBinding>;
  readonly rootDirectory: string;
  readonly databasePath: string;
  readonly vaultDirectory: string;
  readonly schemaBackupDirectory: string;
  private readonly db: Database.Database;
  private readonly now: () => Date;
  private readonly failureInjector?: WorkspaceStoreOptions['failureInjector'];

  constructor(options: WorkspaceStoreOptions) {
    this.rootDirectory = resolve(options.rootDirectory);
    this.databasePath = join(this.rootDirectory, 'health.db');
    this.vaultDirectory = join(this.rootDirectory, 'vault');
    this.schemaBackupDirectory = join(this.rootDirectory, 'recovery-points');
    this.now = options.now ?? (() => new Date());
    this.failureInjector = options.failureInjector;
    if (existsSync(this.databasePath)) {
      const probe = new Database(this.databasePath, { readonly: true, fileMustExist: true });
      try {
        const existingVersion = Number(probe.pragma('user_version', { simple: true }));
        if (existingVersion > SCHEMA_VERSION) throw new Error('WORKSPACE_SCHEMA_NEWER_THAN_APP');
      } finally {
        probe.close();
      }
    }
    mkdirSync(this.vaultDirectory, { recursive: true, mode: 0o700 });
    this.db = new Database(this.databasePath);
    try {
      this.db.pragma('foreign_keys = ON');
      this.db.pragma('journal_mode = WAL');
      this.db.pragma('synchronous = FULL');
      const busyTimeoutMs = options.busyTimeoutMs ?? 5_000;
      if (!Number.isInteger(busyTimeoutMs) || busyTimeoutMs < 0 || busyTimeoutMs > 60_000) throw new Error('SQLITE_BUSY_TIMEOUT_INVALID');
      this.db.pragma(`busy_timeout = ${busyTimeoutMs}`);
      this.migrate();
      this.ensureWorkspace();
      this.automaticUploadIntents = new AutomaticUploadIntentStore(this.db, this.now, {
        getAuthorizationEpoch: () => this.getAutomaticUploadAuthorizationEpoch(),
        createBatch: (input) => this.createAutomaticUploadBatch(input)
      });
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }

  isOpen(): boolean { return !this.closed; }

  createPerson(input: { displayName: string; relation?: string | null; birthYear?: number | null; genderContext?: string | null }): Person {
    const id = randomUUID();
    const person: Person = {
      id,
      displayName: input.displayName.trim(),
      relation: input.relation ?? null,
      birthYear: input.birthYear ?? null,
      genderContext: input.genderContext ?? null,
      displayRevision: 1,
      clinicalContextRevision: 0,
      archivedAt: null
    };
    if (!person.displayName) throw new Error('DISPLAY_NAME_REQUIRED');
    this.db.prepare(`
      INSERT INTO persons (
        id, display_name, relation, birth_year, gender_context,
        display_revision, clinical_context_revision, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      person.id, person.displayName, person.relation, person.birthYear,
      person.genderContext, person.displayRevision, person.clinicalContextRevision,
      this.now().toISOString()
    );
    return person;
  }

  listPersons(): Person[] {
    const rows = this.db.prepare(`
      SELECT id, display_name, relation, birth_year, gender_context,
             display_revision, clinical_context_revision, archived_at
      FROM persons ORDER BY created_at, id
    `).all() as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      id: String(row.id),
      displayName: String(row.display_name),
      relation: row.relation === null ? null : String(row.relation),
      birthYear: row.birth_year === null ? null : Number(row.birth_year),
      genderContext: row.gender_context === null ? null : String(row.gender_context),
      displayRevision: Number(row.display_revision),
      clinicalContextRevision: Number(row.clinical_context_revision),
      archivedAt: row.archived_at === null ? null : String(row.archived_at)
    }));
  }

  /** 用户明确确认的姓名可跨报告复用；不会将候选姓名写回成员显示名。 */
  confirmPersonNameAlias(input: { personId: string; reportedName: string; sourceDocumentId?: string }): void {
    this.db.transaction(() => {
      const person = this.db.prepare(`SELECT id FROM persons WHERE id = ? AND archived_at IS NULL`)
        .get(input.personId);
      if (!person) throw new Error('PERSON_NOT_FOUND');
      const reportedName = input.reportedName.trim();
      const normalizedName = normalizedPersonName(reportedName);
      if (!normalizedName || normalizedName.length > 80) throw new Error('REPORTED_NAME_INVALID');
      if (input.sourceDocumentId && !this.db.prepare(`SELECT 1 FROM documents WHERE id = ? AND person_id = ?`)
        .get(input.sourceDocumentId, input.personId)) throw new Error('DOCUMENT_IDENTITY_CONFLICT');
      const conflicts = this.db.prepare(`SELECT person_id FROM person_name_aliases
        WHERE normalized_name = ? AND revoked_at IS NULL AND person_id != ?`)
        .all(normalizedName, input.personId);
      const displayNameConflict = this.listPersons().some((item) => item.archivedAt === null
        && item.id !== input.personId && normalizedPersonName(item.displayName) === normalizedName);
      if (conflicts.length > 0 || displayNameConflict) throw new Error('PERSON_NAME_ALIAS_CONFLICT');
      const existing = this.db.prepare(`SELECT id FROM person_name_aliases
        WHERE person_id = ? AND normalized_name = ? AND revoked_at IS NULL`)
        .get(input.personId, normalizedName);
      if (existing) return;
      this.db.prepare(`INSERT INTO person_name_aliases (
        id, person_id, reported_name, normalized_name, source_document_id, confirmed_at, revoked_at
      ) VALUES (?, ?, ?, ?, ?, ?, NULL)`)
        .run(randomUUID(), input.personId, reportedName, normalizedName, input.sourceDocumentId ?? null,
          this.now().toISOString());
      this.db.prepare(`INSERT INTO audit_events (id, event_type, entity_id, summary, created_at)
        VALUES (?, 'person.name_alias_confirmed', ?, '用户明确确认了报告姓名，后续同一成员资料可复用该身份确认', ?)`)
        .run(randomUUID(), input.personId, this.now().toISOString());
    })();
  }

  revokePersonNameAlias(input: { personId: string; reportedName: string }): void {
    this.db.transaction(() => {
      const result = this.db.prepare(`UPDATE person_name_aliases SET revoked_at = ?
        WHERE person_id = ? AND normalized_name = ? AND revoked_at IS NULL`)
        .run(this.now().toISOString(), input.personId, normalizedPersonName(input.reportedName));
      if (result.changes === 0) throw new Error('PERSON_NAME_ALIAS_NOT_FOUND');
      this.db.prepare(`INSERT INTO audit_events (id, event_type, entity_id, summary, created_at)
        VALUES (?, 'person.name_alias_revoked', ?, '用户撤销了报告姓名的跨资料复用确认', ?)`)
        .run(randomUUID(), input.personId, this.now().toISOString());
    })();
  }

  listConfirmedPersonNameAliases(personId: string): string[] {
    const person = this.listPersons().find((item) => item.id === personId && item.archivedAt === null);
    if (!person) return [];
    const rows = this.db.prepare(`SELECT reported_name, normalized_name FROM person_name_aliases
      WHERE person_id = ? AND revoked_at IS NULL ORDER BY confirmed_at, id`)
      .all(personId) as Array<{ reported_name: string; normalized_name: string }>;
    return rows.filter((row) => !this.listPersons().some((item) => item.archivedAt === null
      && item.id !== personId && normalizedPersonName(item.displayName) === row.normalized_name))
      .map((row) => row.reported_name);
  }

  isConfirmedPersonName(personId: string, reportedName: string): boolean {
    const name = normalizedPersonName(reportedName);
    return Boolean(name && this.listConfirmedPersonNameAliases(personId)
      .some((alias) => normalizedPersonName(alias) === name));
  }

  updatePersonDisplay(input: {
    personId: string;
    displayName: string;
    relation: string;
    birthYear: number | null;
    expectedDisplayRevision: number;
  }): Person {
    const displayName = input.displayName.trim();
    const relation = input.relation.trim();
    if (!displayName) throw new Error('DISPLAY_NAME_REQUIRED');
    if (!relation) throw new Error('RELATION_REQUIRED');
    const changedAt = this.now().toISOString();
    const transaction = this.db.transaction(() => {
      const actual = this.getPersonRevision(input.personId, 'display_revision');
      if (actual !== input.expectedDisplayRevision) throw new RevisionConflictError(input.expectedDisplayRevision, actual);
      const current = this.db.prepare(`SELECT birth_year, clinical_context_revision FROM persons WHERE id = ? AND archived_at IS NULL`)
        .get(input.personId) as { birth_year: number | null; clinical_context_revision: number } | undefined;
      if (!current) throw new Error('PERSON_NOT_FOUND');
      const birthYearChanged = current.birth_year !== input.birthYear;
      const update = this.db.prepare(`
        UPDATE persons
        SET display_name = ?, relation = ?, birth_year = ?, display_revision = ?,
            clinical_context_revision = clinical_context_revision + ?
        WHERE id = ? AND display_revision = ? AND archived_at IS NULL
      `).run(displayName, relation, input.birthYear, actual + 1, birthYearChanged ? 1 : 0, input.personId, actual);
      if (update.changes !== 1) throw new RevisionConflictError(actual, this.getPersonRevision(input.personId, 'display_revision'));
      if (birthYearChanged) {
        const nextContextRevision = current.clinical_context_revision + 1;
        this.db.prepare(`
          INSERT INTO person_context_revisions (person_id, revision, payload_json, source_kind, changed_at)
          VALUES (?, ?, ?, 'user_reported', ?)
        `).run(input.personId, nextContextRevision, JSON.stringify({ operation: 'birth_year_changed', birthYear: input.birthYear }), changedAt);
        this.db.prepare(`UPDATE derived_snapshots SET status = 'stale' WHERE person_id = ? AND status = 'current'`).run(input.personId);
        this.db.prepare(`UPDATE system_analysis_snapshots_v2 SET status = 'stale' WHERE person_id = ? AND status = 'current'`).run(input.personId);
        this.invalidateMemberAssessmentSnapshots(input.personId);
      }
      this.db.prepare(`
        INSERT INTO audit_events (id, event_type, entity_id, summary, created_at)
        VALUES (?, 'person_display_updated', ?, 'Member display profile updated by user', ?)
      `).run(randomUUID(), input.personId, changedAt);
    });
    transaction();
    const person = this.listPersons().find((item) => item.id === input.personId);
    if (!person) throw new Error('PERSON_NOT_FOUND');
    return person;
  }

  archivePerson(input: { personId: string; expectedDisplayRevision: number }): Person {
    const archivedAt = this.now().toISOString();
    const transaction = this.db.transaction(() => {
      const actual = this.getPersonRevision(input.personId, 'display_revision');
      if (actual !== input.expectedDisplayRevision) throw new RevisionConflictError(input.expectedDisplayRevision, actual);
      const running = this.db.prepare(`
        SELECT id FROM jobs WHERE person_id = ? AND status = 'running' LIMIT 1
      `).get(input.personId);
      if (running) throw new Error('PERSON_HAS_RUNNING_JOB');

      const update = this.db.prepare(`
        UPDATE persons
        SET archived_at = ?, display_revision = display_revision + 1
        WHERE id = ? AND display_revision = ? AND archived_at IS NULL
      `).run(archivedAt, input.personId, actual);
      if (update.changes !== 1) throw new RevisionConflictError(actual, this.getPersonRevision(input.personId, 'display_revision'));

      const consentRows = this.db.prepare(`
        SELECT consent_id FROM inbox_bindings
        WHERE person_id = ? AND enabled = 1 AND consent_id IS NOT NULL
      `).all(input.personId) as Array<{ consent_id: string }>;
      this.db.prepare(`UPDATE inbox_bindings SET enabled = 0 WHERE person_id = ? AND enabled = 1`).run(input.personId);
      const revoke = this.db.prepare(`UPDATE consents SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL`);
      for (const row of consentRows) revoke.run(archivedAt, row.consent_id);

      this.db.prepare(`
        UPDATE jobs SET status = 'cancelled', lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
        WHERE person_id = ? AND status IN ('queued', 'waiting_auth', 'waiting_quota', 'waiting_user', 'retry_wait', 'failed')
      `).run(archivedAt, input.personId);
      const archivedJobs = this.db.prepare(`SELECT id FROM jobs WHERE person_id = ?`)
        .all(input.personId) as Array<{ id: string }>;
      for (const job of archivedJobs) {
        try { this.scrubExtractionChunksFromJob(job.id); } catch {
          // 损坏的任务记录不能阻止成员归档与授权撤回。
        }
      }
      this.invalidateMemberAssessmentSnapshots(input.personId);
      this.db.prepare(`
        UPDATE documents SET status = 'ignored', excluded_from_analysis = 1
        WHERE person_id = ? AND status IN ('queued', 'needs_review', 'blocked')
      `).run(input.personId);
      this.db.prepare(`
        UPDATE review_issues SET resolution_status = 'deferred', resolution_revision = 1
        WHERE resolution_status = 'open' AND field_ref IN (
          SELECT 'document:' || id FROM documents WHERE person_id = ?
        )
      `).run(input.personId);
      this.db.prepare(`
        INSERT INTO audit_events (id, event_type, entity_id, summary, created_at)
        VALUES (?, 'person.archived', ?, '成员已归档；目录授权已撤回，历史资料保留', ?)
      `).run(randomUUID(), input.personId, archivedAt);
    });
    transaction();
    const person = this.listPersons().find((item) => item.id === input.personId);
    if (!person) throw new Error('PERSON_NOT_FOUND');
    return person;
  }

  restorePerson(input: { personId: string; expectedDisplayRevision: number }): Person {
    const restoredAt = this.now().toISOString();
    const transaction = this.db.transaction(() => {
      const actual = this.getPersonRevision(input.personId, 'display_revision');
      if (actual !== input.expectedDisplayRevision) throw new RevisionConflictError(input.expectedDisplayRevision, actual);
      const update = this.db.prepare(`
        UPDATE persons
        SET archived_at = NULL, display_revision = display_revision + 1
        WHERE id = ? AND display_revision = ? AND archived_at IS NOT NULL
      `).run(input.personId, actual);
      if (update.changes !== 1) throw new Error('PERSON_NOT_ARCHIVED');
      this.db.prepare(`
        INSERT INTO audit_events (id, event_type, entity_id, summary, created_at)
        VALUES (?, 'person.restored', ?, '成员已恢复显示；目录授权保持撤回状态', ?)
      `).run(randomUUID(), input.personId, restoredAt);
    });
    transaction();
    const person = this.listPersons().find((item) => item.id === input.personId);
    if (!person) throw new Error('PERSON_NOT_FOUND');
    return person;
  }

  listManualNotes(personId?: string): ManualNote[] {
    const rows = this.db.prepare(`
      SELECT id, person_id, recorded_at, effective_date, immutable_text,
             structured_fields_json, revision
      FROM user_notes
      WHERE (? IS NULL OR person_id = ?)
      ORDER BY COALESCE(effective_date, recorded_at) DESC, recorded_at DESC, id
    `).all(personId ?? null, personId ?? null) as Array<Record<string, unknown>>;
    return rows.map((row) => {
      const stored = JSON.parse(String(row.structured_fields_json)) as Record<string, unknown>;
      const kind = ['history', 'allergy', 'medication', 'self_measurement', 'goal', 'constraint', 'free_text'].includes(String(stored.kind))
        ? String(stored.kind) as ManualNote['kind'] : 'free_text';
      const structuredFields = Object.fromEntries(Object.entries(stored)
        .filter(([key, value]) => key !== 'kind' && typeof value === 'string')) as Record<string, string>;
      return {
        id: String(row.id),
        personId: String(row.person_id),
        kind,
        immutableText: String(row.immutable_text),
        effectiveDate: row.effective_date === null ? null : String(row.effective_date),
        sourceKind: 'user_reported' as const,
        structuredFields,
        revision: Number(row.revision),
        recordedAt: String(row.recorded_at)
      };
    });
  }

  createManualNote(input: CreateManualNoteInput): ManualNote {
    const id = randomUUID();
    const recordedAt = this.now().toISOString();
    const affectedSystemIds = selectContextSystems({
      kind: input.kind,
      text: input.immutableText,
      structuredFields: input.structuredFields
    }).systemIds;
    const transaction = this.db.transaction(() => {
      const actual = this.getPersonRevision(input.personId, 'clinical_context_revision');
      if (actual !== input.expectedContextRevision) throw new RevisionConflictError(input.expectedContextRevision, actual);
      this.db.prepare(`
        INSERT INTO user_notes (
          id, person_id, recorded_at, effective_date, immutable_text,
          structured_fields_json, revision
        ) VALUES (?, ?, ?, ?, ?, ?, 1)
      `).run(
        id,
        input.personId,
        recordedAt,
        input.effectiveDate,
        input.immutableText.trim(),
        JSON.stringify({ kind: input.kind, ...input.structuredFields })
      );
      const next = actual + 1;
      this.db.prepare(`
        INSERT INTO person_context_revisions (person_id, revision, payload_json, source_kind, changed_at)
        VALUES (?, ?, ?, 'user_reported', ?)
      `).run(input.personId, next, JSON.stringify({ operation: 'manual_note_created', noteId: id, kind: input.kind }), recordedAt);
      const update = this.db.prepare(`
        UPDATE persons SET clinical_context_revision = ?
        WHERE id = ? AND clinical_context_revision = ? AND archived_at IS NULL
      `).run(next, input.personId, actual);
      if (update.changes !== 1) throw new RevisionConflictError(actual, this.getPersonRevision(input.personId, 'clinical_context_revision'));
      this.db.prepare(`UPDATE derived_snapshots SET status = 'stale' WHERE person_id = ? AND status = 'current'`).run(input.personId);
      this.invalidateMemberAssessmentSnapshots(input.personId);
      if (affectedSystemIds.length > 0) {
        this.db.prepare(`
          UPDATE system_analysis_snapshots_v2 SET status = 'stale'
          WHERE person_id = ? AND status = 'current'
            AND system_id IN (${affectedSystemIds.map(() => '?').join(',')})
        `).run(input.personId, ...affectedSystemIds);
      }
    });
    transaction();
    return this.listManualNotes(input.personId).find((note) => note.id === id)!;
  }

  listActionItems(personId?: string): ActionItem[] {
    const rows = this.db.prepare(`
      SELECT id, person_id, origin, source_ref, status, title, detail,
             due_date, due_text, user_schedule_text, user_revision, updated_at,
             (SELECT aa.details_json FROM action_adoptions_v2 aa
              WHERE aa.id = action_items.id AND aa.person_id = action_items.person_id
                AND aa.proposal_id IS NOT NULL) AS adoption_details,
             (SELECT aa.proposal_id FROM action_adoptions_v2 aa
              WHERE aa.id = action_items.id AND aa.person_id = action_items.person_id) AS adoption_proposal_id,
             (SELECT MAX(ae.created_at) FROM action_events ae
              WHERE ae.action_id = action_items.id AND ae.next_status = 'completed'
                AND (ae.previous_status IS NULL OR ae.previous_status != 'completed')) AS completed_at
      FROM action_items
      WHERE (? IS NULL OR person_id = ?)
      ORDER BY CASE status WHEN 'completed' THEN 1 WHEN 'dismissed' THEN 2 ELSE 0 END,
               COALESCE(due_date, '9999-12-31'), updated_at DESC, id
    `).all(personId ?? null, personId ?? null) as Array<Record<string, unknown>>;
    return rows.map((row) => {
      const source = assessmentActionSource(row.source_ref === null ? null : String(row.source_ref));
      // 旧采纳正文是结构化字段的拼装结果；日程独立展示，不修改保存的正文或任意替换用户文字。
      let detail = String(row.detail);
      if (row.origin === 'ai_proposed' && row.adoption_details !== null) {
        try {
          const adoption = JSON.parse(String(row.adoption_details)) as Record<string, unknown>;
          if (typeof adoption.userGoal === 'string' && typeof adoption.selectedStartingOption === 'string'
            && typeof adoption.owner === 'string') {
            detail = [adoption.userGoal, `起始方式：${adoption.selectedStartingOption}`,
              `负责人：${adoption.owner}`,
              typeof adoption.progressNote === 'string' && adoption.progressNote ? `起始备注：${adoption.progressNote}` : null]
              .filter((item): item is string => item !== null).join('\n');
          }
        } catch { /* 无结构化内容的旧事项保留原文，不猜测或切割。 */ }
      }
      const sourceLabel = source && row.origin === 'clinician_document'
        ? [source.sourceDate, ...new Set(source.evidenceRefs.map((ref) => [ref.label, ref.locator].filter(Boolean).join(' · '))),
          '报告中的医生建议'].filter(Boolean).join(' · ')
        : source ? '来自本人已采纳的健康解读'
          : row.adoption_proposal_id !== null && row.source_ref === `proposal:${String(row.adoption_proposal_id)}`
            ? '本人已采纳的生活建议' : row.source_ref === null ? null : String(row.source_ref);
      return {
        id: String(row.id),
        personId: String(row.person_id),
        origin: String(row.origin) as ActionItem['origin'],
        status: String(row.status) as ActionItem['status'],
        title: String(row.title),
        detail,
        dueDate: row.due_date === null ? null : String(row.due_date),
        dueText: row.due_text === null ? null : String(row.due_text),
        userScheduleText: row.user_schedule_text === null ? null : String(row.user_schedule_text),
        completedAt: row.status === 'completed' && row.completed_at !== null ? String(row.completed_at) : null,
        evidenceRefs: source?.evidenceRefs ?? [],
        evidenceLabel: sourceLabel,
        userRevision: Number(row.user_revision),
        updatedAt: String(row.updated_at)
      };
    });
  }

  createUserAction(input: {
    personId: string;
    title: string;
    detail: string;
    dueDate: string | null;
    dueText: string | null;
  }): ActionItem {
    const id = randomUUID();
    const updatedAt = this.now().toISOString();
    const transaction = this.db.transaction(() => {
      const person = this.db.prepare(`SELECT id FROM persons WHERE id = ? AND archived_at IS NULL`).get(input.personId);
      if (!person) throw new Error('PERSON_NOT_FOUND');
      this.db.prepare(`
        INSERT INTO action_items (
          id, person_id, origin, source_ref, status, title, detail,
          due_date, due_text, user_schedule_text, user_revision, updated_at
        ) VALUES (?, ?, 'user_created', '用户记录', 'planned', ?, ?, ?, ?, ?, 1, ?)
      `).run(id, input.personId, input.title.trim(), input.detail.trim(), input.dueDate, input.dueText,
        input.dueText?.trim() || null, updatedAt);
      this.db.prepare(`
        INSERT INTO action_events (id, action_id, actor, previous_status, next_status, note, created_at)
        VALUES (?, ?, 'user', NULL, 'planned', '用户创建事项', ?)
      `).run(randomUUID(), id, updatedAt);
    });
    transaction();
    return this.listActionItems(input.personId).find((item) => item.id === id)!;
  }

  listAdoptedMemberAssessmentActions(personId: string): AdoptedMemberAssessmentAction[] {
    const sources = this.db.prepare(`
      SELECT id, source_ref FROM action_items WHERE person_id = ? AND source_ref LIKE ?
    `).all(personId, `${assessmentActionSourcePrefix}%`) as Array<{ id: string; source_ref: string | null }>;
    const actions = new Map(this.listActionItems(personId).map((action) => [action.id, action]));
    return sources.flatMap((row) => {
      const source = assessmentActionSource(row.source_ref);
      const action = actions.get(row.id);
      return source && action ? [{ action, dedupeKey: source.dedupeKey,
        sourceAssessmentId: source.snapshotId, sourceActionId: source.actionId,
        evidenceRefs: source.evidenceRefs, sourceDate: source.sourceDate }] : [];
    });
  }

  /** 来源日期是原医嘱所属资料的临床时间，不是生成或点击采纳的日期。 */
  private assessmentEvidenceSourceDate(personId: string, evidence: MemberEvidenceRef): string | null {
    if (!evidence.documentId || !evidence.sourceSpanId || !evidence.quote?.trim()) return null;
    const source = this.db.prepare(`
      SELECT ss.quote FROM source_spans ss JOIN documents d ON d.id = ss.document_id
      WHERE ss.id = ? AND d.id = ? AND d.person_id = ? AND d.excluded_from_analysis = 0
    `).get(evidence.sourceSpanId, evidence.documentId, personId) as { quote: string | null } | undefined;
    const normalize = (value: string) => value.replace(/\s+/g, '');
    if (!source?.quote || !normalize(source.quote).includes(normalize(evidence.quote))) return null;
    const reports = this.listReportMetadata(personId).filter((report) => report.documentId === evidence.documentId);
    const correctedDates = [...new Set(reports.filter((report) => report.metadataStatus === 'corrected')
      .map((report) => sourceClinicalDate(report.clinicalTime.value)).filter((date): date is string => date !== null))];
    if (correctedDates.length) return correctedDates.length === 1 ? correctedDates[0]! : null;
    const observation = evidence.observationId
      ? this.listAcceptedObservations(personId).find((fact) => fact.id === evidence.observationId
        && fact.documentId === evidence.documentId && (fact.sourceSpanId === evidence.sourceSpanId
          || fact.evidence.some((ref) => ref.sourceSpanId === evidence.sourceSpanId))) : undefined;
    const observationDate = sourceClinicalDate(observation?.clinicalDate);
    if (observationDate) return observationDate;
    // 元数据可能只有年或月；原样保留其精度，不猜补某月第一天，也不引用历史转述日期。
    for (const role of ['encounter', 'report_issued', 'examined', 'sampled']) {
      const dates = [...new Set(reports.flatMap((report) => report.extracted?.times ?? [])
        .filter((time) => time.role === role).map((time) => sourceClinicalDate(time.value))
        .filter((date): date is string => date !== null))];
      if (dates.length) return dates.length === 1 ? dates[0]! : null;
    }
    return null;
  }

  /** 点击采纳才创建行动；事务内重查当前快照、版本和稳定键，防止旧页面或重复点击。 */
  adoptMemberAssessmentAction(input: AdoptMemberAssessmentActionInput): ActionItem {
    const timestamp = this.now().toISOString();
    const actionId = this.db.transaction(() => {
      const person = this.db.prepare(`SELECT id FROM persons WHERE id = ? AND archived_at IS NULL`).get(input.personId);
      if (!person) throw new Error('PERSON_NOT_FOUND');
      const row = this.db.prepare(`
        SELECT id,status,created_at,payload_json, fact_revision, context_revision FROM member_assessment_snapshots_v3
        WHERE id = ? AND person_id = ? AND status = 'current'
      `).get(input.snapshotId, input.personId) as {
        id: string; status: 'current'; created_at: string; payload_json: string; fact_revision: number; context_revision: number
      } | undefined;
      if (!row || row.fact_revision !== this.getFactRevision(input.personId)
        || row.context_revision !== this.getClinicalContextRevision(input.personId)) {
        throw new Error('MEMBER_ASSESSMENT_ACTION_STALE');
      }
      const snapshot: MemberAssessmentSnapshotV3 = { ...JSON.parse(row.payload_json) as MemberAssessmentSnapshotV3,
        id: row.id, status: row.status, generatedAt: row.created_at };
      if (snapshot.reviewScopeSignature !== this.getOpenReviewScopeSignature(input.personId)) {
        throw new Error('MEMBER_ASSESSMENT_ACTION_STALE');
      }
      const proposal = snapshot.actions.find((item) => item.id === input.actionId);
      if (!proposal || snapshot.heldTargetIds.includes(input.actionId)) throw new Error('MEMBER_ASSESSMENT_ACTION_NOT_AVAILABLE');
      // 综合可能沿用本人已有事项的 ID；重复采纳只返回原项，不覆盖来源、正文、进度或个人安排。
      const sameAction = this.db.prepare(`
        SELECT id FROM action_items WHERE id = ? AND person_id = ? AND status != 'dismissed'
      `).get(proposal.id, input.personId) as { id: string } | undefined;
      if (sameAction) return sameAction.id;
      const existing = this.listAdoptedMemberAssessmentActions(input.personId)
        .find((item) => item.dedupeKey === proposal.dedupeKey && item.action.status !== 'dismissed');
      if (existing) return existing.action.id;
      const legacyProposalIds = new Set(this.listLifestyleProposals(input.personId)
        .filter((item) => sameAdoptedActionScope(item, proposal))
        .map((item) => item.id));
      const legacyAdoption = this.listActionAdoptions(input.personId).find((item) => (
        item.proposalId !== null && legacyProposalIds.has(item.proposalId) && item.status !== 'dismissed'
      ));
      if (legacyAdoption) return legacyAdoption.id;
      const id = randomUUID();
      const detail = [proposal.why, `第一步：${proposal.firstStep}`,
        proposal.reviewPlan ? `回看：${proposal.reviewPlan}` : null,
        proposal.caution ? `注意：${proposal.caution}` : null]
        .filter((part): part is string => Boolean(part)).join('\n');
      const evidenceRefs = snapshot.evidenceCatalog.filter((ref) => proposal.evidenceIds.includes(ref.id));
      const sourceObservation = proposal.sourceInstructionObservationId
        ? this.listAcceptedObservations(input.personId).find((fact) => fact.id === proposal.sourceInstructionObservationId) : undefined;
      const planEvidence = proposal.sourceInstructionObservationId
        ? reviewedSourceInstructionEvidence(proposal, snapshot).filter((ref) => sourceObservation
          && sourceObservation.documentId === ref.documentId && sourceObservation.rawText === proposal.firstStep
          && (sourceObservation.sourceSpanId === ref.sourceSpanId
            || sourceObservation.evidence.some((item) => item.sourceSpanId === ref.sourceSpanId)))
        : documentedPlanEvidence(proposal, evidenceRefs);
      const planDates = planEvidence.map((ref) => this.assessmentEvidenceSourceDate(input.personId, ref));
      const sourceDate = planDates.length > 0 && planDates.every((date) => date !== null)
        && new Set(planDates).size === 1 ? planDates[0]! : null;
      // 枚举标签不是医生意见的证明；旧快照也必须有可回溯原文和明确临床日期。
      const origin = proposal.kind === 'documented_plan' && sourceDate ? 'clinician_document' : 'ai_proposed';
      const sourceRef = `${assessmentActionSourcePrefix}${JSON.stringify({
        snapshotId: input.snapshotId, actionId: input.actionId, dedupeKey: proposal.dedupeKey,
        evidenceRefs, sourceDate
      })}`;
      this.db.prepare(`
        INSERT INTO action_items (
          id, person_id, origin, source_ref, status, title, detail,
          due_date, due_text, user_revision, updated_at
        ) VALUES (?, ?, ?, ?, 'planned', ?, ?, NULL, ?, 1, ?)
      `).run(id, input.personId, origin, sourceRef, proposal.title, detail, proposal.timing, timestamp);
      this.db.prepare(`
        INSERT INTO action_events (id, action_id, actor, previous_status, next_status, note, created_at)
        VALUES (?, ?, 'user', NULL, 'planned', '用户采纳成员健康解读中的行动', ?)
      `).run(randomUUID(), id, timestamp);
      return id;
    })();
    return this.listActionItems(input.personId).find((item) => item.id === actionId)!;
  }

  listLifestyleProposals(personId: string): StoredLifestyleProposal[] {
    const rows = this.db.prepare(`
      SELECT id, person_id, category, title, detail, consult_professional,
             evidence_refs_json, structure_json, status, source_snapshot_id, version, updated_at
      FROM lifestyle_proposals_v2
      WHERE person_id = ? AND status != 'superseded'
      ORDER BY CASE status WHEN 'adopted' THEN 1 WHEN 'dismissed' THEN 2 ELSE 0 END,
               updated_at DESC, id
    `).all(personId) as Array<Record<string, unknown>>;
    return rows.map((row) => {
      const structure = JSON.parse(String(row.structure_json ?? '{}')) as Partial<Pick<StoredLifestyleProposal,
        'dedupeKey' | 'goal' | 'rationale' | 'steps' | 'startingOptions' | 'scheduleSuggestion' |
        'trackingSuggestion' | 'constraints' | 'uncertainties' | 'generalKnowledgeEvidence' |
        'sourceKind' | 'relatedSystemIds'>>;
      const title = String(row.title);
      const detail = String(row.detail);
      return {
        id: String(row.id),
        personId: String(row.person_id),
        category: String(row.category) as StoredLifestyleProposal['category'],
        title,
        dedupeKey: structure.dedupeKey ?? `legacy:${String(row.id)}`,
        goal: structure.goal ?? title,
        rationale: structure.rationale ?? detail,
        detail,
        steps: structure.steps?.length ? structure.steps : [detail],
        startingOptions: structure.startingOptions?.length ? structure.startingOptions : ['从本人愿意且可承受的一小步开始'],
        scheduleSuggestion: structure.scheduleSuggestion ?? null,
        trackingSuggestion: structure.trackingSuggestion ?? '记录是否完成以及身体感受即可。',
        constraints: structure.constraints ?? [],
        uncertainties: structure.uncertainties ?? [],
        consultProfessional: Number(row.consult_professional) === 1,
        evidenceObservationIds: JSON.parse(String(row.evidence_refs_json)) as string[],
        generalKnowledgeEvidence: (structure.generalKnowledgeEvidence ?? []).map((item) => ({
          ...item,
          verificationStatus: item.verificationStatus ?? 'unverified_model_candidate'
        })),
        sourceKind: structure.sourceKind ?? 'care_preparation',
        relatedSystemIds: structure.relatedSystemIds ?? [],
        status: String(row.status) as StoredLifestyleProposal['status'],
        sourceSnapshotId: row.source_snapshot_id === null ? null : String(row.source_snapshot_id),
        version: Number(row.version),
        updatedAt: String(row.updated_at)
      };
    });
  }

  setLifestyleProposalDecision(input: {
    personId: string;
    proposalId: string;
    decision: 'dismiss' | 'restore';
  }): { proposalId: string; status: 'proposed' | 'dismissed'; updatedAt: string } {
    const updatedAt = this.now().toISOString();
    const transaction = this.db.transaction(() => {
      const proposal = this.db.prepare(`
        SELECT status FROM lifestyle_proposals_v2 WHERE id = ? AND person_id = ?
      `).get(input.proposalId, input.personId) as { status: string } | undefined;
      if (!proposal || proposal.status === 'superseded' || proposal.status === 'adopted') {
        throw new Error('LIFESTYLE_PROPOSAL_NOT_AVAILABLE');
      }
      const nextStatus = input.decision === 'dismiss' ? 'dismissed' : 'proposed';
      if ((input.decision === 'dismiss' && proposal.status !== 'proposed') || (input.decision === 'restore' && proposal.status !== 'dismissed')) {
        throw new Error('LIFESTYLE_PROPOSAL_DECISION_INVALID');
      }
      this.db.prepare(`UPDATE lifestyle_proposals_v2 SET status = ?, updated_at = ? WHERE id = ?`)
        .run(nextStatus, updatedAt, input.proposalId);
      this.db.prepare(`
        INSERT INTO audit_events (id, event_type, entity_id, summary, created_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(
        randomUUID(),
        input.decision === 'dismiss' ? 'lifestyle_proposal.dismissed' : 'lifestyle_proposal.restored',
        input.proposalId,
        input.decision === 'dismiss' ? '用户选择暂不采纳这条生活建议。' : '用户恢复了一条先前忽略的生活建议。',
        updatedAt
      );
      return nextStatus;
    });
    const status = transaction();
    return { proposalId: input.proposalId, status, updatedAt };
  }

  listActionAdoptions(personId: string): StoredActionAdoption[] {
    const rows = this.db.prepare(`
      SELECT id, person_id, proposal_id, title, details_json, status, due_date, user_revision, updated_at
      FROM action_adoptions_v2 WHERE person_id = ?
      ORDER BY CASE status WHEN 'completed' THEN 1 WHEN 'dismissed' THEN 2 ELSE 0 END,
               updated_at DESC, id
    `).all(personId) as Array<Record<string, unknown>>;
    return rows.map((row) => {
      const details = JSON.parse(String(row.details_json ?? '{}')) as Partial<Pick<StoredActionAdoption,
        'userGoal' | 'selectedStartingOption' | 'plannedTime' | 'owner' | 'progressNote'>>;
      const title = String(row.title);
      return {
        id: String(row.id),
        personId: String(row.person_id),
        proposalId: row.proposal_id === null ? null : String(row.proposal_id),
        title,
        userGoal: details.userGoal ?? title,
        selectedStartingOption: details.selectedStartingOption ?? title,
        plannedTime: details.plannedTime ?? null,
        owner: details.owner ?? '本人',
        progressNote: details.progressNote ?? null,
        status: String(row.status) as StoredActionAdoption['status'],
        dueDate: row.due_date === null ? null : String(row.due_date),
        userRevision: Number(row.user_revision),
        updatedAt: String(row.updated_at)
      };
    });
  }

  adoptLifestyleProposal(input: {
    personId: string;
    proposalId: string;
    userGoal: string;
    selectedStartingOption: string;
    plannedTime: string | null;
    owner: string;
    progressNote: string | null;
    dueDate: string | null;
  }): StoredActionAdoption {
    const timestamp = this.now().toISOString();
    const transaction = this.db.transaction(() => {
      const proposal = this.db.prepare(`
        SELECT id, person_id, title, detail, status, source_snapshot_id FROM lifestyle_proposals_v2
        WHERE id = ? AND person_id = ?
      `).get(input.proposalId, input.personId) as {
        id: string;
        person_id: string;
        title: string;
        detail: string;
        status: string;
        source_snapshot_id: string | null;
      } | undefined;
      if (!proposal || proposal.status === 'superseded' || proposal.status === 'dismissed') {
        throw new Error('LIFESTYLE_PROPOSAL_NOT_AVAILABLE');
      }
      if (proposal.source_snapshot_id) {
        const source = this.db.prepare(`SELECT status FROM derived_snapshots WHERE id = ? AND person_id = ?`)
          .get(proposal.source_snapshot_id, input.personId) as { status: string } | undefined;
        if (!source || source.status !== 'current') throw new Error('LIFESTYLE_PROPOSAL_STALE_REVIEW_REQUIRED');
      }
      const existing = this.db.prepare(`
        SELECT id FROM action_adoptions_v2
        WHERE person_id = ? AND proposal_id = ? AND status != 'dismissed'
        LIMIT 1
      `).get(input.personId, input.proposalId) as { id: string } | undefined;
      if (existing) return existing.id;
      const id = randomUUID();
      const actionDetail = [
        input.userGoal.trim(),
        `起始方式：${input.selectedStartingOption.trim()}`,
        input.plannedTime?.trim() ? `计划时间：${input.plannedTime.trim()}` : null,
        `负责人：${input.owner.trim()}`,
        input.progressNote?.trim() ? `起始备注：${input.progressNote.trim()}` : null
      ].filter((item): item is string => Boolean(item)).join('\n');
      this.db.prepare(`
        INSERT INTO action_items (
          id, person_id, origin, source_ref, status, title, detail,
          due_date, due_text, user_schedule_text, user_revision, updated_at
        ) VALUES (?, ?, 'ai_proposed', ?, 'planned', ?, ?, ?, '由我决定开始时间', ?, 1, ?)
      `).run(id, input.personId, `proposal:${input.proposalId}`, proposal.title, actionDetail, input.dueDate,
        input.plannedTime?.trim() || null, timestamp);
      this.db.prepare(`
        INSERT INTO action_events (id, action_id, actor, previous_status, next_status, note, created_at)
        VALUES (?, ?, 'user', NULL, 'planned', '用户采纳生活建议为独立行动', ?)
      `).run(randomUUID(), id, timestamp);
      this.db.prepare(`
        INSERT INTO action_adoptions_v2 (
          id, person_id, proposal_id, title, details_json, status, due_date,
          user_revision, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, 'planned', ?, 1, ?, ?)
      `).run(
        id, input.personId, input.proposalId, proposal.title,
        JSON.stringify({
          userGoal: input.userGoal.trim(),
          selectedStartingOption: input.selectedStartingOption.trim(),
          plannedTime: input.plannedTime?.trim() || null,
          owner: input.owner.trim(),
          progressNote: input.progressNote?.trim() || null
        }),
        input.dueDate, timestamp, timestamp
      );
      this.db.prepare(`UPDATE lifestyle_proposals_v2 SET status = 'adopted', updated_at = ? WHERE id = ?`)
        .run(timestamp, input.proposalId);
      return id;
    });
    const id = transaction();
    return this.listActionAdoptions(input.personId).find((item) => item.id === id)!;
  }

  updateActionSchedule(rawInput: UpdateActionScheduleInput): ActionItem {
    const input = updateActionScheduleInputSchema.parse(rawInput);
    const updatedAt = this.now().toISOString();
    this.db.transaction(() => {
      const current = this.db.prepare(`
        SELECT a.user_revision, a.status FROM action_items a JOIN persons p ON p.id = a.person_id
        WHERE a.id = ? AND a.person_id = ? AND p.archived_at IS NULL
      `).get(input.actionId, input.personId) as { user_revision: number; status: string } | undefined;
      if (!current) throw new Error('ACTION_NOT_FOUND');
      if (current.user_revision !== input.expectedRevision) throw new RevisionConflictError(input.expectedRevision, current.user_revision);
      const result = this.db.prepare(`
        UPDATE action_items SET due_date = ?, user_schedule_text = ?, user_revision = user_revision + 1, updated_at = ?
        WHERE id = ? AND person_id = ? AND user_revision = ?
      `).run(input.dueDate, input.userScheduleText?.trim() || null, updatedAt, input.actionId, input.personId, input.expectedRevision);
      if (result.changes !== 1) throw new Error('ACTION_REVISION_CONFLICT');
      // 旧生活计划的 plannedTime 本来就是用户填写字段，保持两处投影一致；不改原建议 due_text。
      this.db.prepare(`UPDATE action_adoptions_v2 SET due_date = ?,
        details_json = json_set(COALESCE(details_json, '{}'), '$.plannedTime', ?),
        user_revision = user_revision + 1, updated_at = ? WHERE id = ? AND person_id = ?`)
        .run(input.dueDate, input.userScheduleText?.trim() || null, updatedAt, input.actionId, input.personId);
      this.db.prepare(`INSERT INTO action_events (id, action_id, actor, previous_status, next_status, note, created_at)
        VALUES (?, ?, 'user', ?, ?, '用户更新个人时间安排；原建议时间不变', ?)`)
        .run(randomUUID(), input.actionId, current.status, current.status, updatedAt);
    })();
    return this.listActionItems(input.personId).find((action) => action.id === input.actionId)!;
  }

  updateActionStatus(input: {
    actionId: string;
    status: ActionItem['status'];
    expectedRevision: number;
  }): ActionItem {
    const updatedAt = this.now().toISOString();
    const transaction = this.db.transaction(() => {
      const current = this.db.prepare(`SELECT person_id, status, user_revision FROM action_items WHERE id = ?`).get(input.actionId) as {
        person_id: string;
        status: ActionItem['status'];
        user_revision: number;
      } | undefined;
      if (!current) throw new Error('ACTION_NOT_FOUND');
      if (current.user_revision !== input.expectedRevision) {
        throw new RevisionConflictError(input.expectedRevision, current.user_revision);
      }
      const result = this.db.prepare(`
        UPDATE action_items SET status = ?, user_revision = user_revision + 1, updated_at = ?
        WHERE id = ? AND user_revision = ?
      `).run(input.status, updatedAt, input.actionId, input.expectedRevision);
      if (result.changes !== 1) throw new Error('ACTION_REVISION_CONFLICT');
      this.db.prepare(`
        INSERT INTO action_events (id, action_id, actor, previous_status, next_status, note, created_at)
        VALUES (?, ?, 'user', ?, ?, NULL, ?)
      `).run(randomUUID(), input.actionId, current.status, input.status, updatedAt);
      this.db.prepare(`
        UPDATE action_adoptions_v2
        SET status = ?, user_revision = user_revision + 1, updated_at = ?
        WHERE id = ?
      `).run(input.status, updatedAt, input.actionId);
      return current.person_id;
    });
    const personId = transaction();
    return this.listActionItems(personId).find((item) => item.id === input.actionId)!;
  }

  listPersonDocumentCounts(): Map<string, number> {
    const rows = this.db.prepare(`
      SELECT person_id, COUNT(*) AS count
      FROM documents
      WHERE person_id IS NOT NULL AND status != 'ignored'
      GROUP BY person_id
    `).all() as Array<{ person_id: string; count: number }>;
    return new Map(rows.map((row) => [row.person_id, row.count]));
  }

  listPersonObservationStats(): Map<string, { acceptedFactCount: number; attentionCount: number; latestClinicalDate: string | null }> {
    const result = new Map<string, { acceptedFactCount: number; attentionCount: number; latestClinicalDate: string | null }>();
    for (const { row } of this.canonicalStoredObservationRows().observations) {
      const stats = result.get(row.person_id) ?? { acceptedFactCount: 0, attentionCount: 0, latestClinicalDate: null };
      stats.acceptedFactCount += 1;
      if (['high', 'low', 'positive'].includes(row.abnormal_flag)) stats.attentionCount += 1;
      if (row.display_clinical_date && (!stats.latestClinicalDate || row.display_clinical_date > stats.latestClinicalDate)) {
        stats.latestClinicalDate = row.display_clinical_date;
      }
      result.set(row.person_id, stats);
    }
    return result;
  }

  updateDisplayName(personId: string, displayName: string, expectedRevision: number): number {
    const result = this.db.prepare(`
      UPDATE persons
      SET display_name = ?, display_revision = display_revision + 1
      WHERE id = ? AND display_revision = ? AND archived_at IS NULL
    `).run(displayName.trim(), personId, expectedRevision);
    if (result.changes !== 1) throw new RevisionConflictError(expectedRevision, this.getPersonRevision(personId, 'display_revision'));
    return expectedRevision + 1;
  }

  updateClinicalContext(personId: string, payload: unknown, expectedRevision: number, sourceKind = 'user_reported'): number {
    const transaction = this.db.transaction(() => {
      const actual = this.getPersonRevision(personId, 'clinical_context_revision');
      if (actual !== expectedRevision) throw new RevisionConflictError(expectedRevision, actual);
      const next = actual + 1;
      this.db.prepare(`
        INSERT INTO person_context_revisions (person_id, revision, payload_json, source_kind, changed_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(personId, next, JSON.stringify(payload), sourceKind, this.now().toISOString());
      this.db.prepare(`
        UPDATE persons SET clinical_context_revision = ? WHERE id = ? AND clinical_context_revision = ?
      `).run(next, personId, actual);
      this.db.prepare(`UPDATE derived_snapshots SET status = 'stale' WHERE person_id = ? AND status = 'current'`).run(personId);
      this.db.prepare(`UPDATE system_analysis_snapshots_v2 SET status = 'stale' WHERE person_id = ? AND status = 'current'`).run(personId);
      this.invalidateMemberAssessmentSnapshots(personId);
      return next;
    });
    return transaction();
  }

  putSourceObject(input: SourceObjectInput): SourceObjectReceipt {
    const sha256 = createHash('sha256').update(input.bytes).digest('hex');
    const existing = this.db.prepare(`
      SELECT id, sha256, size, vault_relative_path FROM source_objects WHERE sha256 = ?
    `).get(sha256) as { id: string; sha256: string; size: number; vault_relative_path: string } | undefined;
    if (existing) {
      return { id: existing.id, sha256: existing.sha256, size: existing.size, vaultRelativePath: existing.vault_relative_path, duplicate: true };
    }

    const id = randomUUID();
    const relativePath = join(sha256.slice(0, 2), sha256.slice(2, 4), sha256);
    const targetPath = join(this.vaultDirectory, relativePath);
    const tempPath = `${targetPath}.${randomUUID()}.tmp`;
    mkdirSync(dirname(targetPath), { recursive: true, mode: 0o700 });
    writeFileSync(tempPath, input.bytes, { mode: 0o600, flag: 'wx' });
    renameSync(tempPath, targetPath);
    try {
      this.db.transaction(() => {
        this.db.prepare(`
          INSERT INTO source_objects (id, sha256, media_type, size, vault_relative_path, created_at)
          VALUES (?, ?, ?, ?, ?, ?)
        `).run(id, sha256, input.mediaType, input.bytes.byteLength, relativePath, this.now().toISOString());
        this.failureInjector?.('after_source_object_insert');
        this.db.prepare(`
          INSERT INTO audit_events (id, event_type, entity_id, summary, created_at)
          VALUES (?, 'source_object.created', ?, ?, ?)
        `).run(randomUUID(), id, `已保存 ${basename(input.displayName)}`, this.now().toISOString());
      })();
    } catch (error) {
      rmSync(targetPath, { force: true });
      throw error;
    }
    return { id, sha256, size: input.bytes.byteLength, vaultRelativePath: relativePath, duplicate: false };
  }

  registerDocumentConversion(input: DocumentConversionInput): void {
    const transaction = this.db.transaction(() => {
      const source = this.db.prepare(`
        SELECT original.media_type AS original_media_type, converted.media_type AS converted_media_type,
          original.sha256 AS original_sha256,original.vault_relative_path AS original_path,
          converted.sha256 AS converted_sha256,converted.vault_relative_path AS converted_path
        FROM documents d
        JOIN source_objects original ON original.id = d.source_object_id
        JOIN source_objects converted ON converted.id = ?
        WHERE d.id = ?
      `).get(input.convertedSourceObjectId, input.documentId) as {
        original_media_type: string;
        converted_media_type: string;
        original_sha256: string; original_path: string; converted_sha256: string; converted_path: string;
      } | undefined;
      if (!source) throw new Error('DOCUMENT_CONVERSION_SOURCE_MISSING');
      if (!['application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'].includes(source.original_media_type)
        || source.converted_media_type !== 'application/pdf') {
        throw new Error('DOCUMENT_CONVERSION_MEDIA_TYPE_INVALID');
      }
      const originalBytes = readFileSync(join(this.vaultDirectory, source.original_path));
      const convertedBytes = readFileSync(join(this.vaultDirectory, source.converted_path));
      if (!input.converterId.trim() || !input.converterVersion.trim() || !/^[a-f0-9]{64}$/u.test(input.executableSha256)
        || createHash('sha256').update(originalBytes).digest('hex') !== source.original_sha256
        || createHash('sha256').update(convertedBytes).digest('hex') !== source.converted_sha256
        || convertedBytes.subarray(0, 5).toString() !== '%PDF-') throw new Error('DOCUMENT_CONVERSION_PROVENANCE_INVALID');
      const existing = this.db.prepare(`SELECT converted_source_object_id,converter_id,converter_version,executable_sha256,warnings_json
        FROM document_conversions WHERE document_id=?`).get(input.documentId) as
        { converted_source_object_id: string; converter_id: string; converter_version: string; executable_sha256: string; warnings_json: string } | undefined;
      if (existing) {
        // 相同受控转换视图的重复技术准备是幂等的；不同视图不能默默替换旧证据页。
        if (existing.converted_source_object_id !== input.convertedSourceObjectId || existing.converter_id !== input.converterId
          || existing.converter_version !== input.converterVersion || existing.executable_sha256 !== input.executableSha256
          || existing.warnings_json !== JSON.stringify(input.warnings)) throw new Error('DOCUMENT_CONVERSION_VIEW_CHANGED');
        return;
      }
      this.db.prepare(`
        INSERT INTO document_conversions (
          document_id, converted_source_object_id, converter_id, converter_version,
          executable_sha256, warnings_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        input.documentId, input.convertedSourceObjectId, input.converterId,
        input.converterVersion, input.executableSha256, JSON.stringify(input.warnings), this.now().toISOString()
      );
      this.db.prepare(`
        INSERT INTO audit_events (id, event_type, entity_id, summary, created_at)
        VALUES (?, 'document.converted', ?, ?, ?)
      `).run(
        randomUUID(), input.documentId,
        `已用 ${input.converterId} ${input.converterVersion} 建立 Word 转换视图`,
        this.now().toISOString()
      );
    });
    transaction();
  }

  isSourceImportSuppressed(sourceHash: string): boolean {
    return Boolean(this.db.prepare(`
      SELECT 1 FROM deleted_document_tombstones WHERE source_hash = ? LIMIT 1
    `).get(sourceHash));
  }

  listDeletedDocuments(): DeletedDocumentSummary[] {
    const rows = this.db.prepare(`
      SELECT source_hash, display_name, person_id, media_type, deleted_at, raw_object_retained
      FROM deleted_document_tombstones
      ORDER BY deleted_at DESC, source_hash
    `).all() as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      sourceHash: String(row.source_hash),
      displayName: String(row.display_name),
      personId: row.person_id === null ? null : String(row.person_id),
      mediaType: String(row.media_type),
      deletedAt: String(row.deleted_at),
      rawObjectRetained: Number(row.raw_object_retained) === 1
    }));
  }

  getDocumentSourceHash(documentId: string): string {
    const row = this.db.prepare(`
      SELECT so.sha256 FROM documents d
      JOIN source_objects so ON so.id = d.source_object_id
      WHERE d.id = ?
    `).get(documentId) as { sha256: string } | undefined;
    if (!row) throw new Error('DOCUMENT_NOT_FOUND');
    return row.sha256;
  }

  releaseDeletedDocument(sourceHash: string): void {
    const result = this.db.prepare(`DELETE FROM deleted_document_tombstones WHERE source_hash = ?`).run(sourceHash);
    if (result.changes !== 1) throw new Error('DELETED_DOCUMENT_NOT_FOUND');
    this.db.prepare(`
      INSERT INTO audit_events (id, event_type, entity_id, summary, created_at)
      VALUES (?, 'document.import_allowed', NULL, '用户重新允许导入一份已删除资料', ?)
    `).run(randomUUID(), this.now().toISOString());
  }

  registerSourceOccurrence(input: { sourceObjectId: string; bindingId?: string | null; originalPath: string; displayName: string }): string {
    const id = randomUUID();
    this.db.prepare(`
      INSERT INTO source_occurrences (
        id, source_object_id, binding_id, original_path, display_name, first_seen, last_seen
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(source_object_id, original_path)
      DO UPDATE SET last_seen = excluded.last_seen, display_name = excluded.display_name
    `).run(id, input.sourceObjectId, input.bindingId ?? null, input.originalPath, input.displayName, this.now().toISOString(), this.now().toISOString());
    const stored = this.db.prepare(`SELECT id FROM source_occurrences WHERE source_object_id = ? AND original_path = ?`).get(input.sourceObjectId, input.originalPath) as { id: string };
    return stored.id;
  }

  registerImportedDocument(input: { sourceObjectId: string; personId: string | null; assignmentBasis?: 'user_selected' | 'folder_binding';
    uploadIntent?: { intentId: string; itemIndex: number } }): ImportedDocumentReceipt {
    return this.db.transaction(() => {
      const bindIntent = (documentId: string, duplicate: boolean) => {
        if (!input.uploadIntent) return;
        const source = this.db.prepare('SELECT sha256 FROM source_objects WHERE id=?').get(input.sourceObjectId) as { sha256: string } | undefined;
        if (!source) throw new Error('SOURCE_OBJECT_NOT_FOUND');
        this.automaticUploadIntents.bindDocument({ ...input.uploadIntent, documentId,
          sourceObjectId: input.sourceObjectId, sha256: source.sha256, duplicate });
      };
      const userSelected = input.assignmentBasis === 'user_selected' && input.personId !== null;
      type ExistingDocument = { id: string; person_id: string | null; person_assignment_basis: string; status: string };
      // 有目标成员时先在该成员的档案内去重，目录重扫同样不能借用另一人的
      // 同源文档。明确手动选择还允许建立独立归属，不降为未归属资料。
      const selectedPersonDocument = input.personId !== null ? this.db.prepare(`
        SELECT id, person_id, person_assignment_basis, status FROM documents
        WHERE source_object_id = ? AND person_id = ?
        ORDER BY CASE WHEN person_assignment_basis = 'identity_confirmed' THEN 0 ELSE 1 END,
                 created_at, id LIMIT 1
      `).get(input.sourceObjectId, input.personId) as ExistingDocument | undefined : undefined;
      const suppressedDocument = userSelected && !selectedPersonDocument ? this.db.prepare(`
        SELECT id, person_id, person_assignment_basis, status FROM documents
        WHERE source_object_id = ? AND status = 'ignored' ORDER BY created_at, id LIMIT 1
      `).get(input.sourceObjectId) as ExistingDocument | undefined : undefined;
      const existing = selectedPersonDocument ?? suppressedDocument ?? this.db.prepare(`
        SELECT id, person_id, person_assignment_basis, status FROM documents
        WHERE source_object_id = ?
        ORDER BY CASE WHEN person_assignment_basis = 'identity_confirmed' THEN 0 ELSE 1 END,
                 created_at, id LIMIT 1
      `).get(input.sourceObjectId) as ExistingDocument | undefined;
      // 目录扫描仍复用既有人工确认；明确上传只复用当前成员的文档。
      // 已移出分析的资料继续保留其抑制状态，不因再次上传而重新处理。
      if (existing && (existing.status === 'ignored'
        || existing.person_id === input.personId
        || !userSelected && existing.person_assignment_basis === 'identity_confirmed')) {
        if (userSelected && existing.person_id === input.personId
          && ['folder_binding', 'legacy'].includes(existing.person_assignment_basis)) {
          this.db.prepare(`UPDATE documents SET person_assignment_basis = 'user_selected' WHERE id = ?`).run(existing.id);
          this.db.prepare(`
            INSERT INTO audit_events (id, event_type, entity_id, summary, created_at)
            VALUES (?, 'document.user_assignment_selected', ?, '再次上传时已按用户明确选择保存成员归属；已有报告结果保持不变', ?)
          `).run(randomUUID(), existing.id, this.now().toISOString());
        }
        bindIntent(existing.id, true);
        return { documentId: existing.id, status: 'duplicate' as const, duplicate: true };
      }

      const documentId = randomUUID();
      const crossPersonConflict = !userSelected && Boolean(existing && existing.person_id !== input.personId);
      const status = input.personId && !crossPersonConflict ? 'queued' as const : 'needs_review' as const;
      this.db.prepare(`
        INSERT INTO documents (
          id, source_object_id, person_id, document_kind, status,
          acceptance_id, excluded_from_analysis, person_assignment_basis, created_at
        ) VALUES (?, ?, ?, 'health_report', ?, NULL, 0, ?, ?)
      `).run(
        documentId, input.sourceObjectId, crossPersonConflict ? null : input.personId,
        status, input.assignmentBasis ?? 'user_selected', this.now().toISOString()
      );
      this.db.prepare(`
        INSERT INTO audit_events (id, event_type, entity_id, summary, created_at)
        VALUES (?, 'document.imported', ?, ?, ?)
      `).run(randomUUID(), documentId, status === 'queued' ? '资料已进入本地待处理队列' : '资料等待确认所属成员', this.now().toISOString());
      bindIntent(documentId, false);
      return { documentId, status, duplicate: false };
    })();
  }

  recordUserAssignedSubjectNotice(input: { documentId: string; jobId: string; reason: 'name_mismatch' | 'subject_unproven' }): void {
    this.db.transaction(() => {
      if (!['name_mismatch', 'subject_unproven'].includes(input.reason)) throw new Error('DOCUMENT_SUBJECT_NOTICE_REASON_INVALID');
      const document = this.db.prepare(`
        SELECT person_id, person_assignment_basis, status, excluded_from_analysis FROM documents WHERE id = ?
      `).get(input.documentId) as { person_id: string | null; person_assignment_basis: string; status: string; excluded_from_analysis: number } | undefined;
      if (!document) throw new Error('DOCUMENT_NOT_FOUND');
      if (!document.person_id || !['user_selected', 'identity_confirmed'].includes(document.person_assignment_basis)
        || document.status === 'ignored' || document.excluded_from_analysis !== 0) throw new Error('DOCUMENT_USER_ASSIGNMENT_REQUIRED');
      const job = this.db.prepare(`SELECT person_id, checkpoint_json FROM jobs WHERE id = ?`).get(input.jobId) as
        { person_id: string | null; checkpoint_json: string | null } | undefined;
      const checkpoint = job?.checkpoint_json ? JSON.parse(job.checkpoint_json) as { documentIds?: unknown } : {};
      if (!job || job.person_id !== document.person_id || !Array.isArray(checkpoint.documentIds)
        || !checkpoint.documentIds.includes(input.documentId)) throw new Error('DOCUMENT_OUTSIDE_JOB_SCOPE');
      const id = `user-assigned-subject-notice:${createHash('sha256').update(JSON.stringify([input.jobId, input.documentId, input.reason])).digest('hex')}`;
      this.db.prepare(`
        INSERT OR IGNORE INTO audit_events (id, event_type, entity_id, summary, created_at)
        VALUES (?, 'document.user_assigned_subject_notice', ?, ?, ?)
      `).run(id, input.documentId, input.reason === 'name_mismatch'
        ? '报告姓名与上传时选择的成员不同，已按用户选择归属继续整理'
        : '报告姓名未能确认，已按上传时选择的成员归属继续整理', this.now().toISOString());
    })();
  }

  listImportedDocuments(): ImportedDocumentSummary[] {
    const rows = this.db.prepare(`
      SELECT d.id, d.person_id, d.person_assignment_basis, d.status, d.created_at, so.media_type,
             p.display_name AS person_label,
             (
               SELECT display_name FROM source_occurrences occ
               WHERE occ.source_object_id = d.source_object_id
               ORDER BY occ.last_seen DESC LIMIT 1
             ) AS display_name,
             (
               SELECT json_extract(ri.payload_json, '$.reportedName')
               FROM review_issues ri
               WHERE ri.field_ref = 'document:' || d.id
                 AND ri.kind = 'person_conflict'
                 AND ri.resolution_status = 'resolved'
               ORDER BY ri.created_at DESC, ri.id DESC LIMIT 1
             ) AS confirmed_reported_name
      FROM documents d
      JOIN source_objects so ON so.id = d.source_object_id
      LEFT JOIN persons p ON p.id = d.person_id
      ORDER BY d.created_at DESC, d.id DESC
    `).all() as Array<Record<string, unknown>>;
    return rows.map((row) => {
      const status = String(row.status) as ImportedDocumentSummary['status'];
      return {
        id: String(row.id),
        displayName: String(row.display_name ?? '未命名资料'),
        mediaType: String(row.media_type),
        discoveredAt: String(row.created_at),
        personId: row.person_id === null ? null : String(row.person_id),
        personLabel: row.person_label === null ? null : String(row.person_label),
        personAssignmentBasis: String(row.person_assignment_basis) as DocumentExtractionBundle['personAssignmentBasis'],
        status,
        sourceLabel: '手动导入',
        issue: status === 'needs_review'
          ? row.person_id === null ? '尚未可靠确认所属成员，确认前不会发送给 AI'
            : '报告读取或来源信息仍需核查；原件和已有结果会保留，请到处理中心查看原因'
          : status === 'blocked'
            ? '本地预处理失败，原始文件已保留，可修复后重试'
            : status === 'ignored'
              ? '已移出处理与分析；原文件仍在收件箱时也不会重复导入，可手动重新纳入'
            : null
      };
    });
  }

  saveSourceManifest(manifest: SourceManifest): void {
    sourceManifestSchema.parse(manifest);
    const transaction = this.db.transaction(() => {
      const document = this.db.prepare(`SELECT id FROM documents WHERE id = ? AND source_object_id = ?`)
        .get(manifest.spans[0]?.documentId, manifest.sourceObjectId) as { id: string } | undefined;
      if (!document) throw new Error('DOCUMENT_SOURCE_MISMATCH');
      const existing = this.db.prepare(`SELECT COUNT(*) AS count FROM source_spans WHERE document_id = ?`)
        .get(document.id) as { count: number };
      if (existing.count > 0) throw new Error('SOURCE_MANIFEST_ALREADY_EXISTS');
      this.db.prepare(`
        INSERT INTO source_manifests (
          document_id, manifest_id, source_object_id, sha256, media_type,
          original_display_name, total_units, covered_unit_indexes_json,
          normalizer_version, conversion_warnings_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        document.id, manifest.id, manifest.sourceObjectId, manifest.sha256, manifest.mediaType,
        manifest.originalDisplayName, manifest.totalUnits, JSON.stringify(manifest.coveredUnitIndexes),
        manifest.normalizerVersion, JSON.stringify(manifest.conversionWarnings), manifest.createdAt
      );
      const statement = this.db.prepare(`
        INSERT INTO source_spans (
          id, document_id, span_kind, page_number, block_id, line_start, line_end,
          quote, readability, normalizer_version, visual_evidence_json, model_evidence_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const span of manifest.spans) {
        if (span.documentId !== document.id) throw new Error('SOURCE_SPAN_DOCUMENT_MISMATCH');
        statement.run(
          span.id, span.documentId, span.spanKind, span.page, span.blockId,
          span.lineStart, span.lineEnd, span.quote, span.readability, manifest.normalizerVersion,
          span.visualEvidence ? JSON.stringify(span.visualEvidence) : null,
          span.modelEvidence ? JSON.stringify(span.modelEvidence) : null
        );
        this.db.prepare(`INSERT INTO source_manifest_spans (document_id, source_span_id) VALUES (?, ?)`)
          .run(document.id, span.id);
      }
      this.db.prepare(`
        INSERT INTO audit_events (id, event_type, entity_id, summary, created_at)
        VALUES (?, 'source_manifest.created', ?, ?, ?)
      `).run(randomUUID(), document.id, `已建立 ${manifest.spans.length} 条证据定位`, this.now().toISOString());
    });
    transaction();
  }

  /** 模型逐页直接读原件后的引用，只追加真实原页下的带回执来源，不覆盖原页或历史文字。 */
  saveDirectOriginalEvidenceForProcessing(manifest: SourceManifest, options: { executionGuard: JobExecutionGuard }): void {
    sourceManifestSchema.parse(manifest);
    this.db.transaction(() => {
      const documentId = manifest.spans[0]?.documentId;
      if (!documentId || manifest.spans.some((span) => span.documentId !== documentId)
        || new Set(manifest.spans.map((span) => span.id)).size !== manifest.spans.length) {
        throw new Error('SOURCE_SPAN_DOCUMENT_MISMATCH');
      }
      if (!options?.executionGuard) throw new Error('DIRECT_ORIGINAL_EXECUTION_GUARD_REQUIRED');
      this.assertJobExecutionActive(options.executionGuard, documentId);
      const attempt = this.db.prepare('SELECT model,reasoning_effort FROM job_attempts WHERE id=? AND job_id=?')
        .get(options.executionGuard.attemptId, options.executionGuard.jobId) as { model: string | null; reasoning_effort: string | null };
      if (attempt.model !== 'gpt-6.1-sol' || attempt.reasoning_effort !== 'medium') throw new Error('DIRECT_ORIGINAL_MODEL_SCOPE_INVALID');
      const previous = this.getDocumentExtractionBundle(documentId).manifest;
      const source = this.db.prepare(`SELECT d.status,d.excluded_from_analysis,so.sha256,so.id AS source_object_id
        FROM documents d JOIN source_objects so ON so.id=d.source_object_id WHERE d.id=?`).get(documentId) as
        { status: string; excluded_from_analysis: number; sha256: string; source_object_id: string } | undefined;
      const indexes = (values: number[]) => JSON.stringify([...values].sort((a, b) => a - b));
      if (!source || source.status === 'ignored' || source.excluded_from_analysis !== 0
        || source.source_object_id !== manifest.sourceObjectId || source.sha256 !== manifest.sha256
        || previous.sourceObjectId !== manifest.sourceObjectId || previous.sha256 !== manifest.sha256
        || previous.totalUnits !== manifest.totalUnits || previous.mediaType !== manifest.mediaType
        || indexes(previous.coveredUnitIndexes) !== indexes(manifest.coveredUnitIndexes)
        || previous.normalizerVersion !== manifest.normalizerVersion) {
        throw new Error('DIRECT_ORIGINAL_SOURCE_MISMATCH');
      }
      const incoming = new Map(manifest.spans.map((span) => [span.id, span]));
      if (previous.spans.some((span) => JSON.stringify(span) !== JSON.stringify(incoming.get(span.id)))) {
        throw new Error('DIRECT_ORIGINAL_HISTORY_CHANGED');
      }
      const existingIds = new Set(previous.spans.map((span) => span.id));
      const additions = manifest.spans.filter((span) => !existingIds.has(span.id));
      if (additions.length > 8000) throw new Error('DIRECT_ORIGINAL_EXCERPT_SCOPE_INVALID');
      const insert = this.db.prepare(`INSERT INTO source_spans
        (id,document_id,span_kind,page_number,block_id,line_start,line_end,quote,readability,
          normalizer_version,visual_evidence_json,model_evidence_json) VALUES (?,?,?,?,?,?,?,?,?,?,NULL,?)`);
      const membership = this.db.prepare(`INSERT INTO source_manifest_spans(document_id,source_span_id) VALUES (?,?)`);
      for (const span of additions) {
        const model = span.modelEvidence;
        const parent = model ? previous.spans.find((candidate) => candidate.id === model.parentSourceSpanId) : null;
        if (!model || model.engine !== 'codex-original-reading-v1' || model.modelId !== 'gpt-6.1-sol'
          || model.originalSha256 !== manifest.sha256 || model.originalSourceObjectId !== manifest.sourceObjectId
          || !parent || parent.modelEvidence || parent.visualEvidence || parent.page !== span.page
          || span.spanKind !== 'block' || span.blockId !== `model-original-excerpt:${parent.id}`
          || span.visualEvidence || !span.quote?.trim()
          || span.readability !== (model.clarity === 'clear' ? 'clear' : 'partial')
          || !model.threadId.trim() || !model.turnId.trim()) {
          throw new Error('DIRECT_ORIGINAL_EXCERPT_PROVENANCE_INVALID');
        }
        insert.run(span.id, documentId, span.spanKind, span.page, span.blockId, span.lineStart, span.lineEnd,
          span.quote, span.readability, manifest.normalizerVersion, JSON.stringify(model));
        membership.run(documentId, span.id);
      }
      this.db.prepare(`INSERT INTO audit_events(id,event_type,entity_id,summary,created_at)
        VALUES (?, 'source_manifest.original_model_evidence', ?, ?, ?)`)
        .run(randomUUID(), documentId, `已保存 ${additions.length} 条模型原件引用；原页、文件哈希和历史证据保持不变`, this.now().toISOString());
    })();
  }

  /** 重新规范化仅切换当前清单，历史事实引用的原文与定位不可被覆盖。 */
  replaceSourceManifestForReprocessing(manifest: SourceManifest, options?: { executionGuard?: JobExecutionGuard }): void {
    sourceManifestSchema.parse(manifest);
    this.db.transaction(() => {
      const documentId = manifest.spans[0]?.documentId;
      if (!documentId || manifest.spans.some((span) => span.documentId !== documentId)
        || new Set(manifest.spans.map((span) => span.id)).size !== manifest.spans.length) {
        throw new Error('SOURCE_SPAN_DOCUMENT_MISMATCH');
      }
      if (options?.executionGuard) this.assertJobExecutionActive(options.executionGuard, documentId);
      const source = this.db.prepare(`SELECT d.source_object_id, d.status, d.excluded_from_analysis,
          so.sha256, so.media_type FROM documents d JOIN source_objects so ON so.id = d.source_object_id WHERE d.id = ?`)
        .get(documentId) as { source_object_id: string; status: string; excluded_from_analysis: number; sha256: string; media_type: string } | undefined;
      if (!source || source.status === 'ignored' || source.excluded_from_analysis !== 0
        || source.source_object_id !== manifest.sourceObjectId || source.sha256 !== manifest.sha256) {
        throw new Error('SOURCE_MANIFEST_REPROCESSING_SOURCE_MISMATCH');
      }
      const previous = this.getDocumentExtractionBundle(documentId).manifest;
      const indexes = (values: number[]) => JSON.stringify([...values].sort((a, b) => a - b));
      const locator = (span: SourceManifest['spans'][number]) => originalSourceLocatorKey(span, source.media_type);
      const oldKeys = previous.spans.filter((span) => !span.blockId?.startsWith('local-vision-region:') && !span.modelEvidence).map(locator);
      const newKeys = manifest.spans.map(locator);
      if (previous.sha256 !== manifest.sha256 || previous.sourceObjectId !== manifest.sourceObjectId
        || previous.totalUnits !== manifest.totalUnits || indexes(previous.coveredUnitIndexes) !== indexes(manifest.coveredUnitIndexes)
        || oldKeys.some((key) => key === null) || newKeys.some((key) => key === null)
        || new Set(oldKeys).size !== oldKeys.length || new Set(newKeys).size !== newKeys.length
        || JSON.stringify([...oldKeys].sort()) !== JSON.stringify([...newKeys].sort())) {
        throw new Error('SOURCE_MANIFEST_REPROCESSING_COVERAGE_MISMATCH');
      }
      const currentIds: string[] = [];
      let sourceViewChanged = previous.normalizerVersion !== manifest.normalizerVersion || oldKeys.length !== previous.spans.length;
      const insert = this.db.prepare(`INSERT INTO source_spans
        (id, document_id, span_kind, page_number, block_id, line_start, line_end, quote, readability, normalizer_version, visual_evidence_json, model_evidence_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      for (const span of manifest.spans) {
        const old = previous.spans.find((item) => locator(item) === locator(span))!;
        const sameContent = old.spanKind === span.spanKind && old.quote === span.quote && old.readability === span.readability
          && JSON.stringify(old.visualEvidence ?? null) === JSON.stringify(span.visualEvidence ?? null)
          && JSON.stringify(old.modelEvidence ?? null) === JSON.stringify(span.modelEvidence ?? null);
        if (!sameContent) sourceViewChanged = true;
        const id = sameContent ? old.id : randomUUID();
        if (!sameContent) insert.run(id, documentId, span.spanKind, span.page, span.blockId,
          span.lineStart, span.lineEnd, span.quote, span.readability, manifest.normalizerVersion,
          span.visualEvidence ? JSON.stringify(span.visualEvidence) : null,
          span.modelEvidence ? JSON.stringify(span.modelEvidence) : null);
        currentIds.push(id);
      }
      this.db.prepare(`UPDATE source_manifests SET manifest_id = ?, media_type = ?, original_display_name = ?,
        total_units = ?, covered_unit_indexes_json = ?, normalizer_version = ?, conversion_warnings_json = ?, created_at = ?
        WHERE document_id = ?`).run(sourceViewChanged ? randomUUID() : previous.id, manifest.mediaType, manifest.originalDisplayName,
        manifest.totalUnits, JSON.stringify(manifest.coveredUnitIndexes), manifest.normalizerVersion,
        JSON.stringify(manifest.conversionWarnings), manifest.createdAt, documentId);
      this.db.prepare(`DELETE FROM source_manifest_spans WHERE document_id = ?`).run(documentId);
      const addMember = this.db.prepare(`INSERT INTO source_manifest_spans (document_id, source_span_id) VALUES (?, ?)`);
      for (const id of currentIds) addMember.run(documentId, id);
      this.db.prepare(`INSERT INTO audit_events (id, event_type, entity_id, summary, created_at)
        VALUES (?, 'source_manifest.reprocessed', ?, ?, ?)`)
        .run(randomUUID(), documentId, `已更新 ${currentIds.length} 条当前证据定位；历史原文引用保持不变。`, this.now().toISOString());
    })();
  }

  /** 局部重读只附加同一原页的独立视图，不覆盖旧 OCR、不增加必覆盖的原件页。 */
  appendLocalVisualEvidenceForReprocessing(manifest: SourceManifest, options?: { executionGuard?: JobExecutionGuard }): void {
    sourceManifestSchema.parse(manifest);
    this.db.transaction(() => {
      const documentId = manifest.spans[0]?.documentId;
      if (!documentId || manifest.spans.some((span) => span.documentId !== documentId)
        || new Set(manifest.spans.map((span) => span.id)).size !== manifest.spans.length) {
        throw new Error('SOURCE_SPAN_DOCUMENT_MISMATCH');
      }
      if (options?.executionGuard) this.assertJobExecutionActive(options.executionGuard, documentId);
      const document = this.db.prepare(`SELECT d.status,d.excluded_from_analysis,so.sha256,so.id AS source_object_id
        FROM documents d JOIN source_objects so ON so.id=d.source_object_id WHERE d.id=?`).get(documentId) as
        { status: string; excluded_from_analysis: number; sha256: string; source_object_id: string } | undefined;
      const previous = this.getDocumentExtractionBundle(documentId).manifest;
      const indexes = (values: number[]) => JSON.stringify([...values].sort((a, b) => a - b));
      if (!document || document.status === 'ignored' || document.excluded_from_analysis !== 0
        || document.source_object_id !== manifest.sourceObjectId || document.sha256 !== manifest.sha256
        || previous.sourceObjectId !== manifest.sourceObjectId || previous.sha256 !== manifest.sha256
        || previous.mediaType !== manifest.mediaType || previous.totalUnits !== manifest.totalUnits
        || indexes(previous.coveredUnitIndexes) !== indexes(manifest.coveredUnitIndexes)) {
        throw new Error('SOURCE_MANIFEST_REPROCESSING_SOURCE_MISMATCH');
      }
      const incoming = new Map(manifest.spans.map((span) => [span.id, span]));
      if (previous.spans.some((span) => JSON.stringify(span) !== JSON.stringify(incoming.get(span.id)))) {
        throw new Error('SOURCE_REGION_HISTORY_CHANGED');
      }
      const existingIds = new Set(previous.spans.map((span) => span.id));
      const additions = manifest.spans.filter((span) => !existingIds.has(span.id));
      if (additions.length > 8) throw new Error('SOURCE_REGION_SCOPE_INVALID');
      for (const span of additions) {
        const parentId = span.blockId?.startsWith('local-vision-region:')
          ? span.blockId.slice('local-vision-region:'.length) : null;
        const parent = previous.spans.find((item) => item.id === parentId && !item.blockId?.startsWith('local-vision-region:'));
        const visual = sourceVisualEvidenceSchema.safeParse(span.visualEvidence);
        if (!parent?.visualEvidence || !visual.success || visual.data.reading.mode !== 'region'
          || span.page !== parent.page || span.spanKind !== 'image' || !span.quote?.trim()) {
          throw new Error('SOURCE_REGION_SCOPE_INVALID');
        }
        const region = visual.data.reading.regionBounds!;
        const contained = (bounds: [number, number, number, number]) => {
          const [x, y, width, height] = bounds;
          const epsilon = 0.000001;
          return x + epsilon >= region[0] && y + epsilon >= region[1]
            && x + width <= region[0] + region[2] + epsilon && y + height <= region[1] + region[3] + epsilon;
        };
        if (region[2] * region[3] > 0.5 || visual.data.rows.length === 0
          || span.quote !== visual.data.rows.map((row) => row.text).join('\n')
          || span.lineStart !== 1 || span.lineEnd !== visual.data.rows.length
          || visual.data.rows.some((row, index) => row.line !== index + 1 || !contained(row.bounds)
            || row.boxes.some((box) => !contained(box.bounds)))
          || visual.data.omittedBoxes.some((box) => !contained(box.bounds))) {
          throw new Error('SOURCE_REGION_SCOPE_INVALID');
        }
        // 局部框必须包含至少一个已经保存的行框；不能借局部重读添加其他页或任意新位置。
        const containsOriginalRow = parent.visualEvidence.rows.some((row) => contained(row.bounds));
        if (!containsOriginalRow) throw new Error('SOURCE_REGION_SCOPE_INVALID');
        this.db.prepare(`INSERT INTO source_spans (id,document_id,span_kind,page_number,block_id,line_start,line_end,
          quote,readability,normalizer_version,visual_evidence_json) VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
          .run(span.id, documentId, span.spanKind, span.page, span.blockId, span.lineStart, span.lineEnd,
            span.quote, span.readability, manifest.normalizerVersion, JSON.stringify(visual.data));
        this.db.prepare('INSERT INTO source_manifest_spans (document_id,source_span_id) VALUES (?,?)').run(documentId, span.id);
      }
      if (additions.length === 0) return;
      this.db.prepare(`UPDATE source_manifests SET manifest_id=?,normalizer_version=?,conversion_warnings_json=?,created_at=?
        WHERE document_id=?`).run(randomUUID(), manifest.normalizerVersion, JSON.stringify(manifest.conversionWarnings), manifest.createdAt, documentId);
      this.db.prepare(`INSERT INTO audit_events (id,event_type,entity_id,summary,created_at)
        VALUES (?,'source_manifest.region_read',?,?,?)`).run(randomUUID(), documentId,
        `已附加 ${additions.length} 个同页局部来源视图；历史引用和原件页覆盖保持不变。`, this.now().toISOString());
    })();
  }

  /** 同原件位置仅支持去重定位，不能代替候选的项目、日期、结果与内容核验。 */
  isSameSourceLocationInDocument(oldSourceSpanId: string, newSourceSpanId: string): boolean {
    const read = this.db.prepare(`SELECT ss.id, ss.document_id, ss.page_number AS page, ss.block_id AS blockId,
        ss.line_start AS lineStart, ss.line_end AS lineEnd, so.id AS source_object_id, so.sha256, so.media_type
      FROM source_spans ss JOIN documents d ON d.id = ss.document_id
      JOIN source_objects so ON so.id = d.source_object_id WHERE ss.id = ?`);
    type LocatedSpan = OriginalSourceLocator & { document_id: string; source_object_id: string; sha256: string; media_type: string };
    const old = read.get(oldSourceSpanId) as LocatedSpan | undefined;
    const current = read.get(newSourceSpanId) as LocatedSpan | undefined;
    if (!old || !current || old.document_id !== current.document_id || old.source_object_id !== current.source_object_id
      || old.sha256 !== current.sha256) return false;
    const key = originalSourceLocatorKey(old, old.media_type);
    if (!key || key !== originalSourceLocatorKey(current, current.media_type)) return false;
    const currentSpans = this.getDocumentExtractionBundle(current.document_id).manifest.spans;
    return currentSpans.some((span) => span.id === current.id)
      && currentSpans.filter((span) => originalSourceLocatorKey(span, current.media_type) === key).length === 1;
  }

  reconstructLegacyPdfManifest(input: {
    documentId: string;
    sha256: string;
    totalPages: number;
    normalizerVersion: string;
  }): boolean {
    const transaction = this.db.transaction(() => {
      const document = this.db.prepare(`
        SELECT d.id, d.source_object_id, d.created_at,
               so.sha256, so.media_type,
               (
                 SELECT display_name FROM source_occurrences occ
                 WHERE occ.source_object_id = d.source_object_id
                 ORDER BY occ.last_seen DESC LIMIT 1
               ) AS display_name,
               EXISTS(SELECT 1 FROM document_conversions dc WHERE dc.document_id = d.id) AS has_conversion,
               EXISTS(SELECT 1 FROM source_manifests sm WHERE sm.document_id = d.id) AS has_manifest
        FROM documents d
        JOIN source_objects so ON so.id = d.source_object_id
        WHERE d.id = ?
      `).get(input.documentId) as {
        id: string;
        source_object_id: string;
        created_at: string;
        sha256: string;
        media_type: string;
        display_name: string | null;
        has_conversion: number;
        has_manifest: number;
      } | undefined;
      if (!document) throw new Error('DOCUMENT_NOT_FOUND');
      if (document.has_manifest === 1) return false;
      if (document.has_conversion === 1 || document.media_type !== 'application/pdf') {
        throw new Error('LEGACY_PDF_MANIFEST_RECOVERY_UNSAFE');
      }
      if (document.sha256 !== input.sha256) throw new Error('LEGACY_PDF_SOURCE_HASH_MISMATCH');
      if (!Number.isInteger(input.totalPages) || input.totalPages < 1) {
        throw new Error('LEGACY_PDF_PAGE_COUNT_INVALID');
      }

      const spans = this.db.prepare(`
        SELECT span_kind, page_number, quote, readability, normalizer_version
        FROM source_spans
        WHERE document_id = ?
        ORDER BY page_number, id
      `).all(document.id) as Array<{
        span_kind: string;
        page_number: number | null;
        quote: string | null;
        readability: string;
        normalizer_version: string;
      }>;
      const pages = spans.map((span) => span.page_number);
      const matchesVerifiedPdf = spans.length === input.totalPages
        && spans.every((span, index) => span.span_kind === 'page'
          && span.page_number === index + 1
          && span.quote !== null
          && span.quote.trim().length > 0
          && span.readability === 'clear'
          && span.normalizer_version === input.normalizerVersion)
        && new Set(pages).size === input.totalPages;
      if (!matchesVerifiedPdf) throw new Error('LEGACY_PDF_MANIFEST_RECOVERY_UNSAFE');

      this.db.prepare(`
        INSERT INTO source_manifests (
          document_id, manifest_id, source_object_id, sha256, media_type,
          original_display_name, total_units, covered_unit_indexes_json,
          normalizer_version, conversion_warnings_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        document.id,
        `reconstructed-manifest-${document.id}`,
        document.source_object_id,
        document.sha256,
        document.media_type,
        document.display_name ?? '旧版导入资料',
        input.totalPages,
        JSON.stringify(Array.from({ length: input.totalPages }, (_, index) => index)),
        input.normalizerVersion,
        JSON.stringify(['historical_manifest_reconstructed_from_verified_pdf']),
        this.now().toISOString()
      );
      this.db.prepare(`
        INSERT INTO audit_events (id, event_type, entity_id, summary, created_at)
        VALUES (?, 'source_manifest.reconstructed', ?, ?, ?)
      `).run(
        randomUUID(),
        document.id,
        `重新校验原始 PDF 后恢复 ${input.totalPages} 页旧版来源清单`,
        this.now().toISOString()
      );
      this.db.prepare(`INSERT OR IGNORE INTO source_manifest_spans (document_id, source_span_id)
        SELECT document_id, id FROM source_spans WHERE document_id = ?`).run(document.id);
      return true;
    });
    return transaction();
  }

  setDocumentStatus(documentId: string, status: 'queued' | 'needs_review' | 'blocked' | 'completed'): void {
    const result = this.db.prepare(`UPDATE documents SET status = ? WHERE id = ?`).run(status, documentId);
    if (result.changes !== 1) throw new Error('DOCUMENT_NOT_FOUND');
  }

  setDocumentIncluded(input: { documentId: string; included: boolean }): { included: boolean; personId: string | null } {
    const changedAt = this.now().toISOString();
    const transaction = this.db.transaction(() => {
      const document = this.db.prepare(`
        SELECT d.person_id, d.excluded_from_analysis, so.sha256,
               EXISTS(SELECT 1 FROM document_commits dc WHERE dc.document_id = d.id) AS committed
        FROM documents d JOIN source_objects so ON so.id = d.source_object_id
        WHERE d.id = ?
      `).get(input.documentId) as { person_id: string | null; excluded_from_analysis: number; sha256: string; committed: number } | undefined;
      if (!document) throw new Error('DOCUMENT_NOT_FOUND');
      const currentlyIncluded = document.excluded_from_analysis === 0;
      if (currentlyIncluded === input.included) return { included: input.included, personId: document.person_id };
      const affectedSystemIds = this.systemIdsForDocuments([input.documentId]);

      const activeJobs = this.db.prepare(`
        SELECT id, checkpoint_json FROM jobs
        WHERE status IN ('queued', 'running', 'waiting_auth', 'waiting_quota', 'waiting_user', 'retry_wait')
      `).all() as Array<{ id: string; checkpoint_json: string | null }>;
      const documentHasActiveJob = activeJobs.some((job) => {
        if (!job.checkpoint_json) return false;
        const checkpoint = JSON.parse(job.checkpoint_json) as { documentIds?: string[] };
        return checkpoint.documentIds?.includes(input.documentId) === true;
      });
      if (documentHasActiveJob) throw new Error('DOCUMENT_HAS_ACTIVE_JOB');

      if (input.included) {
        // 已有事实提交的资料重新纳入时，只需使派生说明失效并重算。
        // 若改成 queued，任务运行器会因已提交而跳过提取，界面却永久显示待处理。
        this.db.prepare(`UPDATE documents SET status = ?, excluded_from_analysis = 0 WHERE id = ?`)
          .run(document.committed ? 'completed' : 'queued', input.documentId);
        this.db.prepare(`DELETE FROM exclusions WHERE document_id = ? AND reason = 'user_removed_from_analysis'`).run(input.documentId);
      } else {
        this.db.prepare(`UPDATE documents SET status = 'ignored', excluded_from_analysis = 1 WHERE id = ?`).run(input.documentId);
        this.db.prepare(`DELETE FROM exclusions WHERE document_id = ? AND reason = 'user_removed_from_analysis'`).run(input.documentId);
        this.db.prepare(`
          INSERT INTO exclusions (id, source_hash, binding_id, document_id, reason, created_at)
          VALUES (?, ?, NULL, ?, 'user_removed_from_analysis', ?)
        `).run(randomUUID(), document.sha256, input.documentId, changedAt);
        this.db.prepare(`
          UPDATE review_issues SET resolution_status = 'deferred', resolution_revision = 1
          WHERE resolution_status = 'open' AND field_ref = 'document:' || ?
        `).run(input.documentId);
      }
      if (document.person_id) {
        this.db.prepare(`
          INSERT INTO person_revisions (person_id, fact_revision) VALUES (?, 1)
          ON CONFLICT(person_id) DO UPDATE SET fact_revision = fact_revision + 1
        `).run(document.person_id);
        this.db.prepare(`UPDATE derived_snapshots SET status = 'stale' WHERE person_id = ? AND status = 'current'`).run(document.person_id);
        this.invalidateSystemSnapshots(document.person_id, affectedSystemIds);
        this.invalidateMemberAssessmentSnapshots(document.person_id);
      }
      this.db.prepare(`
        INSERT INTO audit_events (id, event_type, entity_id, summary, created_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(
        randomUUID(),
        input.included ? 'document.reincluded' : 'document.excluded',
        input.documentId,
        input.included ? '用户重新允许资料进入处理与分析' : '用户将资料移出处理与分析，保留抑制记录',
        changedAt
      );
      return { included: input.included, personId: document.person_id };
    });
    return transaction();
  }

  deleteDocument(input: { documentId: string; retainedByRecoveryPoint: boolean }): DeleteDocumentReceipt {
    const document = this.db.prepare(`
      SELECT d.person_id, d.source_object_id, so.sha256, so.media_type, so.vault_relative_path,
             dc.converted_source_object_id, converted.vault_relative_path AS converted_vault_relative_path,
             (SELECT display_name FROM source_occurrences occ
              WHERE occ.source_object_id = d.source_object_id
              ORDER BY occ.last_seen DESC LIMIT 1) AS display_name
      FROM documents d JOIN source_objects so ON so.id = d.source_object_id
      LEFT JOIN document_conversions dc ON dc.document_id = d.id
      LEFT JOIN source_objects converted ON converted.id = dc.converted_source_object_id
      WHERE d.id = ?
    `).get(input.documentId) as {
      person_id: string | null;
      source_object_id: string;
      sha256: string;
      media_type: string;
      vault_relative_path: string;
      display_name: string | null;
      converted_source_object_id: string | null;
      converted_vault_relative_path: string | null;
    } | undefined;
    if (!document) throw new Error('DOCUMENT_NOT_FOUND');

    const activeJobs = this.db.prepare(`
      SELECT checkpoint_json FROM jobs
      WHERE status IN ('queued', 'running', 'waiting_auth', 'waiting_quota', 'waiting_user', 'retry_wait')
    `).all() as Array<{ checkpoint_json: string | null }>;
    const hasActiveJob = activeJobs.some((job) => {
      if (!job.checkpoint_json) return false;
      try {
        const checkpoint = JSON.parse(job.checkpoint_json) as { documentIds?: string[] };
        return checkpoint.documentIds?.includes(input.documentId) === true;
      } catch {
        return true;
      }
    });
    if (hasActiveJob) throw new Error('DOCUMENT_HAS_ACTIVE_JOB');

    const otherDocumentCount = (this.db.prepare(`
      SELECT COUNT(*) AS count FROM documents WHERE source_object_id = ? AND id != ?
    `).get(document.source_object_id, input.documentId) as { count: number }).count;
    const removeSourceObject = otherDocumentCount === 0;
    const convertedOtherReferenceCount = document.converted_source_object_id === null ? 0 : (this.db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM document_conversions WHERE converted_source_object_id = ? AND document_id != ?)
        + (SELECT COUNT(*) FROM documents WHERE source_object_id = ?) AS count
    `).get(document.converted_source_object_id, input.documentId, document.converted_source_object_id) as { count: number }).count;
    const removeConvertedSourceObject = document.converted_source_object_id !== null && convertedOtherReferenceCount === 0;
    const sourcePath = join(this.vaultDirectory, document.vault_relative_path);
    const quarantinePath = `${sourcePath}.${randomUUID()}.deleting`;
    const convertedSourcePath = document.converted_vault_relative_path
      ? join(this.vaultDirectory, document.converted_vault_relative_path)
      : null;
    const convertedQuarantinePath = convertedSourcePath ? `${convertedSourcePath}.${randomUUID()}.deleting` : null;
    const shouldDeleteRaw = removeSourceObject && !input.retainedByRecoveryPoint;
    if (shouldDeleteRaw) renameSync(sourcePath, quarantinePath);
    if (removeConvertedSourceObject && convertedSourcePath && convertedQuarantinePath) {
      renameSync(convertedSourcePath, convertedQuarantinePath);
    }

    const deletedAt = this.now().toISOString();
    try {
      const transaction = this.db.transaction(() => {
        const jobsWithCheckpoints = this.db.prepare(`SELECT id FROM jobs WHERE checkpoint_json IS NOT NULL`)
          .all() as Array<{ id: string }>;
        for (const job of jobsWithCheckpoints) this.scrubExtractionChunksFromJob(job.id, input.documentId);
        const spanRows = this.db.prepare(`SELECT id FROM source_spans WHERE document_id = ?`).all(input.documentId) as Array<{ id: string }>;
        const spanIds = spanRows.map((row) => row.id);
        const observationRows = spanIds.length === 0 ? [] : this.db.prepare(`
          SELECT DISTINCT observation_id FROM observation_revisions
          WHERE source_span_id IN (${spanIds.map(() => '?').join(',')})
        `).all(...spanIds) as Array<{ observation_id: string }>;
        const observationIds = observationRows.map((row) => row.observation_id);
        const acceptanceRows = observationIds.length === 0 ? [] : this.db.prepare(`
          SELECT DISTINCT acceptance_id FROM observation_revisions
          WHERE observation_id IN (${observationIds.map(() => '?').join(',')})
        `).all(...observationIds) as Array<{ acceptance_id: string }>;
        const reportRows = this.db.prepare(`
          SELECT DISTINCT report_id FROM report_source_links WHERE document_id = ?
        `).all(input.documentId) as Array<{ report_id: string }>;
        const reportIds = reportRows.map((row) => row.report_id);
        const eventRows = reportIds.length === 0 ? [] : this.db.prepare(`
          SELECT DISTINCT event_id FROM event_report_links
          WHERE report_id IN (${reportIds.map(() => '?').join(',')})
        `).all(...reportIds) as Array<{ event_id: string }>;

        if (document.person_id) {
          // 成员级综合可能引用这份资料；当前工作区无法安全地只删单份引用，故清除该成员整代 V3 正文及其采纳行动。
          const assessmentActions = this.db.prepare(`
            SELECT id FROM action_items
            WHERE person_id = ? AND source_ref LIKE ?
          `).all(document.person_id, `${assessmentActionSourcePrefix}%`) as Array<{ id: string }>;
          for (const action of assessmentActions) {
            this.db.prepare(`DELETE FROM action_events WHERE action_id = ?`).run(action.id);
            this.db.prepare(`DELETE FROM action_items WHERE id = ?`).run(action.id);
          }
          this.db.prepare(`DELETE FROM member_assessment_snapshots_v3 WHERE person_id = ?`).run(document.person_id);
          const snapshotRows = this.db.prepare(`SELECT id FROM derived_snapshots WHERE person_id = ?`).all(document.person_id) as Array<{ id: string }>;
          for (const snapshot of snapshotRows) this.db.prepare(`DELETE FROM snapshot_evidence WHERE snapshot_id = ?`).run(snapshot.id);
          this.db.prepare(`DELETE FROM derived_snapshots WHERE person_id = ?`).run(document.person_id);
          const memberSnapshotRows = this.db.prepare(`
            SELECT id FROM system_analysis_snapshots_v2 WHERE person_id = ?
          `).all(document.person_id) as Array<{ id: string }>;
          for (const snapshot of memberSnapshotRows) {
            this.db.prepare(`DELETE FROM derivation_dependencies WHERE derived_id = ?`).run(snapshot.id);
          }
          this.db.prepare(`DELETE FROM system_analysis_snapshots_v2 WHERE person_id = ?`).run(document.person_id);
          this.db.prepare(`DELETE FROM document_commits WHERE document_id = ?`).run(input.documentId);
          this.db.prepare(`DELETE FROM publication_events WHERE person_id = ? AND id NOT IN (SELECT publication_id FROM document_commits)`).run(document.person_id);
        }
        this.db.prepare(`DELETE FROM derivation_dependencies WHERE dependency_id = ?`).run(input.documentId);
        for (const observationId of observationIds) {
          this.db.prepare(`DELETE FROM derivation_dependencies WHERE dependency_id = ?`).run(observationId);
        }
        if (observationIds.length > 0) {
          for (const observationId of observationIds) {
            this.db.prepare(`DELETE FROM observation_revisions WHERE observation_id = ?`).run(observationId);
            this.db.prepare(`DELETE FROM observations WHERE id = ?`).run(observationId);
          }
        }
        if (spanIds.length > 0) {
          for (const spanId of spanIds) {
            this.db.prepare(`DELETE FROM clinical_statements WHERE source_span_id = ?`).run(spanId);
          }
        }
        this.db.prepare(`DELETE FROM clinical_statements WHERE document_id = ?`).run(input.documentId);
        this.db.prepare(`DELETE FROM review_issues WHERE field_ref = 'document:' || ?`).run(input.documentId);
        this.db.prepare(`UPDATE consents SET revoked_at = ? WHERE revoked_at IS NULL AND scope_json LIKE ?`).run(deletedAt, `%${input.documentId}%`);
        this.db.prepare(`UPDATE jobs SET status = 'cancelled', lease_owner = NULL, lease_expires_at = NULL, updated_at = ? WHERE status = 'failed' AND checkpoint_json LIKE ?`).run(deletedAt, `%${input.documentId}%`);
        const sourceRefs = [input.documentId, ...observationIds];
        for (const sourceRef of sourceRefs) {
          const actionRows = this.db.prepare(`SELECT id FROM action_items WHERE origin != 'user_created' AND source_ref = ?`).all(sourceRef) as Array<{ id: string }>;
          for (const action of actionRows) {
            this.db.prepare(`DELETE FROM action_events WHERE action_id = ?`).run(action.id);
            this.db.prepare(`DELETE FROM action_items WHERE id = ?`).run(action.id);
          }
        }
        this.db.prepare(`DELETE FROM encounter_documents WHERE document_id = ?`).run(input.documentId);
        this.db.prepare(`DELETE FROM encounters WHERE id NOT IN (SELECT encounter_id FROM encounter_documents) AND id NOT IN (SELECT encounter_id FROM observations WHERE encounter_id IS NOT NULL)`).run();
        this.db.prepare(`DELETE FROM source_spans WHERE document_id = ?`).run(input.documentId);
        this.db.prepare(`DELETE FROM source_manifests WHERE document_id = ?`).run(input.documentId);
        this.db.prepare(`DELETE FROM ai_transmissions WHERE document_id = ?`).run(input.documentId);
        this.db.prepare(`DELETE FROM exclusions WHERE document_id = ?`).run(input.documentId);
        this.db.prepare(`DELETE FROM document_conversions WHERE document_id = ?`).run(input.documentId);
        for (const reportId of reportIds) {
          this.db.prepare(`
            UPDATE event_relation_changes
            SET active = 0
            WHERE active = 1
              AND EXISTS (
                SELECT 1 FROM json_each(event_relation_changes.report_ids_json)
                WHERE json_each.value = ?
              )
          `).run(reportId);
          this.db.prepare(`DELETE FROM report_metadata_revisions WHERE report_id = ?`).run(reportId);
          this.db.prepare(`DELETE FROM event_report_links WHERE report_id = ?`).run(reportId);
          this.db.prepare(`DELETE FROM report_source_links WHERE report_id = ?`).run(reportId);
          this.db.prepare(`DELETE FROM report_records WHERE id = ?`).run(reportId);
        }
        for (const event of eventRows) {
          const stillUsed = this.db.prepare(`SELECT 1 FROM event_report_links WHERE event_id = ? LIMIT 1`).get(event.event_id);
          if (!stillUsed) {
            const relationIds = (this.db.prepare(`
              SELECT id FROM event_relation_changes WHERE from_event_id = ? OR to_event_id = ?
            `).all(event.event_id, event.event_id) as Array<{ id: string }>).map((row) => row.id);
            for (const relationId of relationIds) {
              this.db.prepare(`DELETE FROM event_relation_changes WHERE parent_change_id = ?`).run(relationId);
            }
            for (const relationId of relationIds) {
              this.db.prepare(`DELETE FROM event_relation_changes WHERE id = ?`).run(relationId);
            }
            this.db.prepare(`DELETE FROM health_events_v2 WHERE id = ?`).run(event.event_id);
          }
        }
        this.automaticUploadIntents.detachDocument(input.documentId);
        this.db.prepare(`DELETE FROM documents WHERE id = ?`).run(input.documentId);

        for (const acceptance of acceptanceRows) {
          const stillUsed = this.db.prepare(`SELECT 1 FROM observation_revisions WHERE acceptance_id = ? LIMIT 1`).get(acceptance.acceptance_id);
          if (!stillUsed) this.db.prepare(`DELETE FROM acceptance_decisions WHERE id = ?`).run(acceptance.acceptance_id);
        }
        if (removeSourceObject) {
          this.db.prepare(`DELETE FROM source_occurrences WHERE source_object_id = ?`).run(document.source_object_id);
          this.db.prepare(`DELETE FROM source_objects WHERE id = ?`).run(document.source_object_id);
        }
        if (removeConvertedSourceObject && document.converted_source_object_id) {
          this.db.prepare(`DELETE FROM source_objects WHERE id = ?`).run(document.converted_source_object_id);
        }
        this.db.prepare(`DELETE FROM deleted_document_tombstones WHERE source_hash = ?`).run(document.sha256);
        this.db.prepare(`
          INSERT INTO deleted_document_tombstones (
            source_hash, display_name, person_id, media_type, deleted_at, raw_object_retained
          ) VALUES (?, ?, ?, ?, ?, ?)
        `).run(
          document.sha256,
          document.display_name ?? '已删除资料',
          document.person_id,
          document.media_type,
          deletedAt,
          shouldDeleteRaw ? 0 : 1
        );
        if (document.person_id) {
          this.db.prepare(`
            INSERT INTO person_revisions (person_id, fact_revision) VALUES (?, 1)
            ON CONFLICT(person_id) DO UPDATE SET fact_revision = fact_revision + 1
          `).run(document.person_id);
        }
        this.db.prepare(`
          INSERT INTO audit_events (id, event_type, entity_id, summary, created_at)
          VALUES (?, 'document.deleted', NULL, '用户已从当前工作区删除一份资料并保留导入抑制记录', ?)
        `).run(randomUUID(), deletedAt);
      });
      transaction();
      if (shouldDeleteRaw) rmSync(quarantinePath, { force: true });
      if (removeConvertedSourceObject && convertedQuarantinePath) rmSync(convertedQuarantinePath, { force: true });
    } catch (error) {
      if (shouldDeleteRaw) renameSync(quarantinePath, sourcePath);
      if (removeConvertedSourceObject && convertedSourcePath && convertedQuarantinePath) {
        renameSync(convertedQuarantinePath, convertedSourcePath);
      }
      throw error;
    }
    return {
      sourceHash: document.sha256,
      currentWorkspaceRemoved: true,
      rawObjectDeleted: shouldDeleteRaw,
      retainedByRecoveryPoint: removeSourceObject && input.retainedByRecoveryPoint
    };
  }

  countSourceSpans(documentId: string): number {
    const row = this.db.prepare(`SELECT COUNT(*) AS count FROM source_spans WHERE document_id = ?`).get(documentId) as { count: number };
    return row.count;
  }

  /** nullable引用仅能读回当前已接纳同原件的整个模型摘录，不读OCR或寻找替代原文。 */
  getTrustedDirectOriginalExcerptQuote(personId: string, documentId: string, sourceSpanId: string): string | null {
    try {
      const source = this.db.prepare(`SELECT so.id AS source_object_id,so.sha256
        FROM documents d JOIN persons p ON p.id=d.person_id AND p.archived_at IS NULL
        JOIN source_objects so ON so.id=d.source_object_id
        JOIN source_manifests sm ON sm.document_id=d.id AND sm.source_object_id=so.id AND sm.sha256=so.sha256
        JOIN source_manifest_spans membership ON membership.document_id=d.id AND membership.source_span_id=?
        JOIN source_spans span ON span.id=membership.source_span_id AND span.document_id=d.id
        JOIN document_commits dc ON dc.document_id=d.id
        JOIN publication_events publication ON publication.id=dc.publication_id AND publication.person_id=d.person_id
        WHERE d.id=? AND d.person_id=? AND d.status IN ('completed','needs_review') AND d.excluded_from_analysis=0
          AND NOT EXISTS(SELECT 1 FROM review_issues issue WHERE issue.field_ref='document:'||d.id
            AND issue.kind='person_conflict' AND issue.resolution_status='open')
          AND EXISTS(SELECT 1 FROM observations observation
            JOIN observation_revisions revision ON revision.observation_id=observation.id AND revision.revision=observation.current_revision
            JOIN acceptance_decisions decision ON decision.id=revision.acceptance_id AND decision.decision IN ('accept','accept_with_warnings')
            JOIN source_spans primary_source ON primary_source.id=revision.source_span_id AND primary_source.document_id=d.id
            WHERE observation.person_id=d.person_id AND (
              revision.source_span_id=span.id
              OR EXISTS(SELECT 1 FROM json_each(revision.evidence_json) ref WHERE json_extract(ref.value,'$.sourceSpanId')=span.id)
              OR EXISTS(SELECT 1 FROM json_each(revision.source_binding_json,'$.units') ref WHERE json_extract(ref.value,'$.sourceSpanId')=span.id)
              OR EXISTS(SELECT 1 FROM json_each(revision.clinical_context_json,'$.conditions') ref WHERE json_extract(ref.value,'$.sourceSpanId')=span.id)
            ))`)
        .get(sourceSpanId, documentId, personId) as { source_object_id: string; sha256: string } | undefined;
      if (!source) return null;
      const bundle = this.getDocumentExtractionBundle(documentId);
      if (bundle.personId !== personId || bundle.manifest.sourceObjectId !== source.source_object_id
        || bundle.manifest.sha256 !== source.sha256) return null;
      return resolveDirectOriginalWholeExcerptQuote(bundle.manifest, documentId, sourceSpanId);
    } catch { return null; }
  }

  getDocumentExtractionBundle(documentId: string): DocumentExtractionBundle {
    const document = this.db.prepare(`
      SELECT d.id, d.person_id, d.person_assignment_basis, d.confirmed_reported_name,
             p.display_name AS person_display_name,
             so.id AS source_object_id, so.sha256, so.media_type,
             so.vault_relative_path, so.created_at,
             converted.media_type AS converted_media_type,
             converted.vault_relative_path AS converted_vault_relative_path,
             dc.converter_id, dc.converter_version, dc.executable_sha256, dc.warnings_json,
             sm.manifest_id, sm.media_type AS manifest_media_type,
             sm.original_display_name AS manifest_display_name, sm.total_units,
             sm.covered_unit_indexes_json, sm.normalizer_version AS manifest_normalizer_version,
             sm.conversion_warnings_json AS manifest_conversion_warnings_json,
             sm.created_at AS manifest_created_at,
             (
               SELECT display_name FROM source_occurrences occ
               WHERE occ.source_object_id = d.source_object_id
               ORDER BY occ.last_seen DESC LIMIT 1
             ) AS display_name
      FROM documents d
      JOIN source_objects so ON so.id = d.source_object_id
      JOIN persons p ON p.id = d.person_id
      LEFT JOIN document_conversions dc ON dc.document_id = d.id
      LEFT JOIN source_objects converted ON converted.id = dc.converted_source_object_id
      LEFT JOIN source_manifests sm ON sm.document_id = d.id
      WHERE d.id = ?
    `).get(documentId) as Record<string, unknown> | undefined;
    if (!document) throw new Error('DOCUMENT_NOT_FOUND');
    if (document.person_id === null) throw new Error('DOCUMENT_PERSON_REQUIRED');
    const rows = this.db.prepare(`
      SELECT id, span_kind, page_number, block_id, line_start, line_end,
             quote, readability, normalizer_version, visual_evidence_json, model_evidence_json
      FROM source_spans WHERE document_id = ?
        AND (NOT EXISTS(SELECT 1 FROM source_manifests WHERE document_id = ?)
          OR id IN (SELECT source_span_id FROM source_manifest_spans WHERE document_id = ?))
      ORDER BY COALESCE(page_number, 0), COALESCE(line_start, 0), COALESCE(block_id, ''), id
    `).all(documentId, documentId, documentId) as Array<Record<string, unknown>>;
    if (rows.length === 0) throw new Error('SOURCE_MANIFEST_MISSING');
    const spans = rows.map((row) => ({
      id: String(row.id),
      documentId,
      spanKind: String(row.span_kind) as SourceManifest['spans'][number]['spanKind'],
      page: row.page_number === null ? null : Number(row.page_number),
      blockId: row.block_id === null ? null : String(row.block_id),
      lineStart: row.line_start === null ? null : Number(row.line_start),
      lineEnd: row.line_end === null ? null : Number(row.line_end),
      quote: row.quote === null ? null : String(row.quote),
      readability: String(row.readability) as SourceManifest['spans'][number]['readability'],
      ...(row.visual_evidence_json ? { visualEvidence: JSON.parse(String(row.visual_evidence_json)) as NonNullable<SourceManifest['spans'][number]['visualEvidence']> } : {}),
      ...(row.model_evidence_json ? { modelEvidence: JSON.parse(String(row.model_evidence_json)) as NonNullable<SourceManifest['spans'][number]['modelEvidence']> } : {})
    }));
    return {
      documentId,
      personId: String(document.person_id),
      personDisplayName: String(document.person_display_name),
      personAssignmentBasis: String(document.person_assignment_basis) as DocumentExtractionBundle['personAssignmentBasis'],
      confirmedReportedName: document.confirmed_reported_name == null ? null : String(document.confirmed_reported_name),
      confirmedPersonAliases: this.listConfirmedPersonNameAliases(String(document.person_id)),
      sourcePath: join(this.vaultDirectory, String(document.converted_vault_relative_path ?? document.vault_relative_path)),
      manifest: {
        id: String(document.manifest_id ?? `manifest-${documentId}`),
        sourceObjectId: String(document.source_object_id),
        sha256: String(document.sha256),
        mediaType: String(document.manifest_media_type ?? document.converted_media_type ?? document.media_type),
        originalDisplayName: String(document.manifest_display_name ?? document.display_name ?? '未命名资料'),
        totalUnits: Number(document.total_units ?? spans.length),
        coveredUnitIndexes: document.covered_unit_indexes_json
          ? JSON.parse(String(document.covered_unit_indexes_json)) as number[]
          : [],
        spans,
        normalizerVersion: String(document.manifest_normalizer_version ?? rows[0]!.normalizer_version),
        conversionWarnings: [
          ...(document.manifest_conversion_warnings_json
            ? JSON.parse(String(document.manifest_conversion_warnings_json)) as string[]
            : ['historical_manifest_metadata_unavailable']),
          ...(document.converter_id
            ? [`converted_view:${String(document.converter_id)}:${String(document.converter_version)}`]
            : []),
          ...(document.warnings_json ? JSON.parse(String(document.warnings_json)) as string[] : []),
          ...(spans.some((span) => span.readability !== 'clear') ? ['one_or_more_units_need_visual_review'] : [])
        ],
        createdAt: String(document.manifest_created_at ?? document.created_at)
      }
    };
  }

  getEvidenceAccess(input: { sourceSpanId?: string; documentId?: string }): EvidenceAccess {
    if (Boolean(input.sourceSpanId) === Boolean(input.documentId)) throw new Error('EVIDENCE_SELECTOR_INVALID');
    const selector = input.sourceSpanId ? 'ss.id = ?' : 'd.id = ?';
    const value = input.sourceSpanId ?? input.documentId!;
    const row = this.db.prepare(`
      SELECT ss.id AS source_span_id, ss.document_id, ss.span_kind, ss.page_number,
             ss.block_id, ss.line_start, ss.line_end, ss.quote, ss.readability,
             so.media_type, so.vault_relative_path,
             converted.media_type AS converted_media_type,
             converted.vault_relative_path AS converted_vault_relative_path,
             dc.converter_id,
             (
               SELECT occ.display_name FROM source_occurrences occ
               WHERE occ.source_object_id = d.source_object_id
               ORDER BY occ.last_seen DESC LIMIT 1
             ) AS display_name
      FROM source_spans ss
      JOIN documents d ON d.id = ss.document_id
      JOIN source_objects so ON so.id = d.source_object_id
      LEFT JOIN document_conversions dc ON dc.document_id = d.id
      LEFT JOIN source_objects converted ON converted.id = dc.converted_source_object_id
      WHERE ${selector}
      ORDER BY COALESCE(ss.page_number, 0), COALESCE(ss.line_start, 0),
               COALESCE(ss.block_id, ''), ss.id
      LIMIT 1
    `).get(value) as Record<string, unknown> | undefined;
    if (!row) throw new Error('EVIDENCE_NOT_FOUND');
    const spanKind = String(row.span_kind);
    const locator = row.page_number !== null
      ? `第 ${Number(row.page_number)} 页`
      : row.line_start !== null
        ? `第 ${Number(row.line_start)}${row.line_end !== row.line_start ? `–${Number(row.line_end)}` : ''} 行`
        : row.block_id !== null ? `文档块 ${String(row.block_id)}` : spanKind === 'image' ? '图片原件' : '来源片段';
    return {
      sourceSpanId: String(row.source_span_id),
      documentId: String(row.document_id),
      displayName: String(row.display_name ?? '未命名资料'),
      mediaType: String(row.converted_media_type ?? row.media_type),
      locator,
      quote: row.quote === null ? null : String(row.quote),
      readability: String(row.readability) as EvidenceAccess['readability'],
      sourcePath: join(this.vaultDirectory, String(row.converted_vault_relative_path ?? row.vault_relative_path)),
      sourcePage: row.page_number === null ? null : Number(row.page_number),
      conversionView: row.converter_id !== null
    };
  }

  saveAcceptanceDecision(input: {
    method: 'auto' | 'user_resolution';
    actor: 'policy' | 'user';
    rulesVersion: string;
    inputSignature: string;
    outputHash: string;
    reviewRef: string | null;
    decision: 'accept' | 'accept_with_warnings' | 'reject' | 'needs_review';
  }): string {
    const id = randomUUID();
    this.db.prepare(`
      INSERT INTO acceptance_decisions (
        id, method, actor, rules_version, input_signature, output_hash,
        review_ref, decision, decided_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, input.method, input.actor, input.rulesVersion, input.inputSignature,
      input.outputHash, input.reviewRef, input.decision, this.now().toISOString()
    );
    return id;
  }

  saveExtractionReviewIssue(input: {
    readingAudit?: ReportReadingAudit;
    documentId: string;
    jobId?: string | null;
    attemptId?: string | null;
    stage?: string | null;
    kind: 'person_conflict' | 'field_conflict' | 'coverage_gap' | 'overwrite_protected' | 'derived_safety';
    severity: 'blocking' | 'warning';
    evidenceRefs: string[];
    preserveDocumentStatus?: boolean;
    candidateOptions?: ObservationCandidate[];
    candidateDiffs?: ReviewCandidateDiff[];
    fieldReviews?: DirectOriginalFieldAdmissionReview[];
    reportedName?: string;
    reasonCodes?: string[];
    documentRun?: {
      coverageComplete: boolean;
      coveredSourceSpanIds: string[];
      manifestSpanIds: string[];
      chunkCount: number;
    };
  }): string {
    const id = randomUUID();
    const transaction = this.db.transaction(() => {
      this.db.prepare(`
        INSERT INTO review_issues (
          id, job_id, field_ref, kind, severity, evidence_refs_json,
          resolution_status, resolution_revision, payload_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'open', NULL, ?, ?)
      `).run(
        id, input.jobId ?? null, `document:${input.documentId}`, input.kind,
        input.severity, JSON.stringify(input.evidenceRefs),
        input.candidateOptions || input.candidateDiffs || input.reportedName || input.reasonCodes?.length
          || input.attemptId || input.stage || input.documentRun || input.fieldReviews?.length || input.readingAudit
          ? JSON.stringify({
              ...(input.candidateOptions ? { candidateOptions: input.candidateOptions } : {}),
              ...(input.readingAudit ? { readingAudit: reportReadingAuditSchema.parse(input.readingAudit) } : {}),
              ...(input.candidateDiffs ? { candidateDiffs: input.candidateDiffs } : {}),
              ...(input.fieldReviews?.length ? { fieldReviews: input.fieldReviews } : {}),
              ...(input.reportedName ? { reportedName: input.reportedName } : {}),
              ...(input.reasonCodes?.length ? { reasonCodes: input.reasonCodes } : {}),
              ...(input.attemptId ? { attemptId: input.attemptId } : {}),
              ...(input.stage ? { stage: input.stage } : {}),
              ...(input.documentRun ? { documentRun: input.documentRun } : {})
            })
          : null,
        this.now().toISOString()
      );
      if (!input.preserveDocumentStatus) {
        this.db.prepare(`UPDATE documents SET status = 'needs_review' WHERE id = ?`).run(input.documentId);
      }
      const document = this.db.prepare(`SELECT person_id FROM documents WHERE id = ?`)
        .get(input.documentId) as { person_id: string | null } | undefined;
      if (document?.person_id) this.invalidateMemberAssessmentSnapshots(document.person_id);
    });
    transaction();
    return id;
  }

  /** 已提交报告重核发现受检者异名时，先隔离整份报告，绝不在原成员分析中继续使用其既有事实。 */
  saveCommittedIdentityReviewIssue(input: {
    documentId: string;
    reportedName: string;
    evidenceRefs: string[];
    reasonCodes?: string[];
    jobId?: string | null;
    attemptId?: string | null;
    executionGuard?: JobExecutionGuard;
  }): string {
    const transaction = this.db.transaction(() => {
      if (input.executionGuard) this.assertJobExecutionActive(input.executionGuard, input.documentId);
      const reportedName = input.reportedName.trim();
      if (!reportedName || input.evidenceRefs.length === 0) throw new Error('COMMITTED_IDENTITY_EVIDENCE_REQUIRED');
      const document = this.db.prepare(`
        SELECT d.person_id, d.status, d.excluded_from_analysis,
               EXISTS(SELECT 1 FROM document_commits dc WHERE dc.document_id = d.id) AS committed
        FROM documents d WHERE d.id = ?
      `).get(input.documentId) as {
        person_id: string | null; status: string; excluded_from_analysis: number; committed: number;
      } | undefined;
      if (!document?.person_id || document.status !== 'completed' || document.committed !== 1) {
        throw new Error('DOCUMENT_NOT_COMMITTED_FOR_IDENTITY_REVIEW');
      }
      const existing = this.listOpenExtractionReviewIssues().find((issue) => (
        issue.documentId === input.documentId && issue.kind === 'person_conflict'
        && issue.severity === 'blocking'
        && issue.reasonCodes.includes('COMMITTED_PERSON_IDENTITY_CONFLICT')
      ));
      if (existing) {
        if (document.excluded_from_analysis !== 1) throw new Error('COMMITTED_IDENTITY_REVIEW_STATE_CONFLICT');
        return existing.id;
      }
      if (document.excluded_from_analysis !== 0) throw new Error('DOCUMENT_ALREADY_EXCLUDED');
      const hasRepairWarning = this.listOpenExtractionReviewIssues().some((issue) => (
        issue.documentId === input.documentId && issue.severity === 'warning'
        && issue.stage === 'extract'
      ));
      if (!hasRepairWarning) throw new Error('COMMITTED_DOCUMENT_REPAIR_ISSUE_REQUIRED');
      const known = new Set((this.db.prepare(`
        SELECT id FROM source_spans WHERE document_id = ?
      `).all(input.documentId) as Array<{ id: string }>).map((span) => span.id));
      if (input.evidenceRefs.some((ref) => !known.has(ref))) throw new Error('COMMITTED_IDENTITY_EVIDENCE_INVALID');
      const affectedSystemIds = this.systemIdsForDocuments([input.documentId]);
      const changed = this.db.prepare(`
        UPDATE documents SET excluded_from_analysis = 1
        WHERE id = ? AND person_id = ? AND status = 'completed' AND excluded_from_analysis = 0
      `).run(input.documentId, document.person_id);
      if (changed.changes !== 1) throw new Error('COMMITTED_IDENTITY_REVIEW_STATE_CONFLICT');
      const issueId = this.saveExtractionReviewIssue({
        documentId: input.documentId,
        jobId: input.executionGuard?.jobId ?? input.jobId ?? null,
        attemptId: input.executionGuard?.attemptId ?? input.attemptId ?? null,
        stage: 'extract', kind: 'person_conflict', severity: 'blocking',
        evidenceRefs: input.evidenceRefs, reportedName,
        reasonCodes: [...new Set(['COMMITTED_PERSON_IDENTITY_CONFLICT', ...(input.reasonCodes ?? [])])],
        preserveDocumentStatus: true
      });
      this.advanceRevisionAfterDocumentVisibilityChange(document.person_id, affectedSystemIds);
      this.db.prepare(`
        INSERT INTO audit_events (id, event_type, entity_id, summary, created_at)
        VALUES (?, 'review_issue.committed_identity_quarantined', ?, '已提交报告身份存疑；原始事实保留，暂不参与任何成员分析', ?)
      `).run(randomUUID(), issueId, this.now().toISOString());
      return issueId;
    });
    return transaction();
  }

  private advanceRevisionAfterDocumentVisibilityChange(personId: string, systemIds: string[]): void {
    this.db.prepare(`
      INSERT INTO person_revisions (person_id, fact_revision) VALUES (?, 1)
      ON CONFLICT(person_id) DO UPDATE SET fact_revision = fact_revision + 1
    `).run(personId);
    this.db.prepare(`UPDATE derived_snapshots SET status = 'stale' WHERE person_id = ? AND status = 'current'`)
      .run(personId);
    this.invalidateSystemSnapshots(personId, systemIds);
    this.invalidateMemberAssessmentSnapshots(personId);
  }

  listOpenExtractionReviewIssues(): OpenExtractionReviewIssue[] {
    const rows = this.db.prepare(`
      SELECT ri.id, ri.job_id, ri.kind, ri.severity, ri.evidence_refs_json, ri.payload_json,
             d.id AS document_id, d.person_id
      FROM review_issues ri
      JOIN documents d ON ri.field_ref = 'document:' || d.id
      WHERE ri.resolution_status = 'open'
      ORDER BY ri.created_at, ri.id
    `).all() as Array<Record<string, unknown>>;
    return rows.map((row) => {
      const payload = row.payload_json
        ? JSON.parse(String(row.payload_json)) as {
            candidateOptions?: ObservationCandidate[];
            readingAudit?: ReportReadingAudit;
            candidateDiffs?: ReviewCandidateDiff[];
            reportedName?: string;
            reasonCodes?: string[];
            attemptId?: string;
            stage?: string;
            documentRun?: OpenExtractionReviewIssue['documentRun'];
          }
        : {};
      return {
        id: String(row.id),
        documentId: String(row.document_id),
        personId: row.person_id === null ? null : String(row.person_id),
        kind: String(row.kind) as OpenExtractionReviewIssue['kind'],
        severity: String(row.severity) as OpenExtractionReviewIssue['severity'],
        evidenceRefs: JSON.parse(String(row.evidence_refs_json)) as string[],
        candidateOptions: payload.candidateOptions ?? [],
        ...(reportReadingAuditSchema.safeParse(payload.readingAudit).success ? { readingAudit: payload.readingAudit! } : {}),
        candidateDiffs: payload.candidateDiffs ?? [],
        reportedName: payload.reportedName ?? null,
        reasonCodes: payload.reasonCodes ?? [],
        jobId: row.job_id === null ? null : String(row.job_id),
        attemptId: payload.attemptId ?? null,
        stage: payload.stage ?? null,
        documentRun: payload.documentRun ?? null
      };
    });
  }

  /** 待核对范围变化不一定增加事实版本；用独立签名阻止旧综合继续冒充当前结论。 */
  getOpenReviewScopeSignature(personId: string): string {
    const rows = this.db.prepare(`
      SELECT ri.id, ri.kind, ri.severity, ri.evidence_refs_json, ri.payload_json FROM review_issues ri
      JOIN documents d ON ri.field_ref = 'document:' || d.id
      WHERE d.person_id = ? AND ri.resolution_status = 'open'
      ORDER BY ri.id
    `).all(personId) as Array<{
      id: string; kind: string; severity: string; evidence_refs_json: string; payload_json: string | null;
    }>;
    // 同一个 issue 可在无事实新增时原地缩小待核对候选。只哈希 ID 会让在途综合
    // 误以为范围未变；把受控提醒内容一起纳入签名，防止旧说明晚到后发布。
    return createHash('sha256').update(JSON.stringify(rows)).digest('hex');
  }

  /** 任务范围不能只相信创建时的 checkpoint；成员归属可能在核对后改变。 */
  private checkpointDocumentPersonMismatches(documentIds: string[], personId: string): string[] {
    const belongsToPerson = this.db.prepare(`
      SELECT 1 FROM documents WHERE id = ? AND person_id = ? LIMIT 1
    `);
    return [...new Set(documentIds)]
      .filter((documentId) => !belongsToPerson.get(documentId, personId));
  }

  retryExtractionReview(input: { issueId: string; documentId: string }): void {
    const transaction = this.db.transaction(() => {
      const issue = this.db.prepare(`
        SELECT id, job_id, kind, resolution_status, payload_json FROM review_issues
        WHERE id = ? AND field_ref = 'document:' || ?
      `).get(input.issueId, input.documentId) as {
        id: string;
        job_id: string | null;
        kind: string;
        resolution_status: string;
        payload_json: string | null;
      } | undefined;
      if (!issue || issue.resolution_status !== 'open'
        || (issue.kind !== 'field_conflict' && issue.kind !== 'person_conflict')) {
        throw new Error('REVIEW_ISSUE_NOT_OPEN');
      }
      const payload = issue.payload_json
        ? JSON.parse(issue.payload_json) as {
          candidateOptions?: ObservationCandidate[];
          candidateDiffs?: ReviewCandidateDiff[];
          reasonCodes?: string[];
        }
        : {};
      const candidateDiffs = payload.candidateDiffs ?? [];
      const abnormalFlagOnly = candidateDiffs.length > 0
        && candidateDiffs.every((difference) => difference.fields.length === 1 && difference.fields[0] === 'reportedAbnormalFlag');
      const evidenceIssueOnly = candidateDiffs.length > 0
        && candidateDiffs.every((difference) => difference.fields.length === 1 && difference.fields[0] === 'issues');
      const legacyComparisonIssue = payload.reasonCodes?.includes('INDEPENDENT_REVIEW_MISMATCH') === true;
      const identityMisreadReview = issue.kind === 'person_conflict'
        && payload.reasonCodes?.includes('PERSON_IDENTITY_NOT_CONFIRMED') === true;
      if (!identityMisreadReview && (!payload.candidateOptions?.length
        || (candidateDiffs.length > 0 && !abnormalFlagOnly && !evidenceIssueOnly && !legacyComparisonIssue))) {
        throw new Error('REVIEW_ACTION_INVALID');
      }
      const document = this.db.prepare(`SELECT status FROM documents WHERE id = ?`).get(input.documentId) as { status: string } | undefined;
      if (!document || document.status !== 'needs_review') throw new Error('DOCUMENT_REVIEW_STATE_CONFLICT');

      this.db.prepare(`
        UPDATE review_issues SET resolution_status = 'resolved', resolution_revision = 1
        WHERE id = ?
      `).run(input.issueId);
      this.db.prepare(`UPDATE documents SET status = 'queued' WHERE id = ?`).run(input.documentId);
      const reviewDocument = this.db.prepare(`SELECT person_id FROM documents WHERE id = ?`)
        .get(input.documentId) as { person_id: string | null } | undefined;
      if (reviewDocument?.person_id) this.invalidateMemberAssessmentSnapshots(reviewDocument.person_id);
      this.db.prepare(`
        INSERT INTO audit_events (id, event_type, entity_id, summary, created_at)
        VALUES (?, 'review_issue.requeued', ?, '核对事项已关闭，资料按当前规则重新核对', ?)
      `).run(randomUUID(), input.issueId, this.now().toISOString());
      this.resumeWaitingJobsAfterReview(input.documentId, false, issue.job_id);
    });
    transaction();
  }

  markReviewIssueCorrected(issueId: string, documentId: string): void {
    const transaction = this.db.transaction(() => {
      const issue = this.db.prepare(`SELECT job_id FROM review_issues WHERE id = ?`).get(issueId) as { job_id: string | null } | undefined;
      const result = this.db.prepare(`
        UPDATE review_issues SET resolution_status = 'resolved', resolution_revision = 1
        WHERE id = ? AND field_ref = 'document:' || ? AND resolution_status = 'open' AND kind = 'field_conflict'
      `).run(issueId, documentId);
      if (result.changes !== 1) throw new Error('REVIEW_ISSUE_NOT_OPEN');
      const reviewDocument = this.db.prepare(`SELECT person_id FROM documents WHERE id = ?`)
        .get(documentId) as { person_id: string | null } | undefined;
      if (reviewDocument?.person_id) this.invalidateMemberAssessmentSnapshots(reviewDocument.person_id);
      this.db.prepare(`
        INSERT INTO audit_events (id, event_type, entity_id, summary, created_at)
        VALUES (?, 'review_issue.corrected', ?, '用户核对原始依据后修正并接纳事实', ?)
      `).run(randomUUID(), issueId, this.now().toISOString());
      this.resumeWaitingJobsAfterReview(documentId, false, issue?.job_id ?? null);
    });
    transaction();
  }

  assignDocumentPerson(documentId: string, personId: string): void {
    const transaction = this.db.transaction(() => {
      const person = this.db.prepare(`SELECT id FROM persons WHERE id = ? AND archived_at IS NULL`).get(personId) as { id: string } | undefined;
      if (!person) throw new Error('PERSON_NOT_FOUND');
      const updated = this.db.prepare(`
        UPDATE documents SET person_id = ?, status = 'queued', person_assignment_basis = 'user_selected'
        WHERE id = ? AND person_id IS NULL AND status = 'needs_review'
      `).run(personId, documentId);
      if (updated.changes !== 1) throw new Error('DOCUMENT_ASSIGNMENT_CONFLICT');
      this.invalidateMemberAssessmentSnapshots(personId);
      this.db.prepare(`
        INSERT INTO audit_events (id, event_type, entity_id, summary, created_at)
        VALUES (?, 'document.person_assigned', ?, '用户确认资料所属成员，已进入待处理队列', ?)
      `).run(randomUUID(), documentId, this.now().toISOString());
    });
    transaction();
  }

  confirmDocumentIdentity(input: { issueId: string; documentId: string; personId: string }): void {
    const transaction = this.db.transaction(() => {
      const issue = this.db.prepare(`
        SELECT ri.job_id, ri.kind, ri.severity, ri.resolution_status, ri.payload_json,
               d.person_id, d.status, d.excluded_from_analysis,
               EXISTS(SELECT 1 FROM document_commits dc WHERE dc.document_id = d.id) AS committed
        FROM review_issues ri
        JOIN documents d ON ri.field_ref = 'document:' || d.id
        WHERE ri.id = ? AND d.id = ?
      `).get(input.issueId, input.documentId) as {
        kind: string;
        severity: string;
        job_id: string | null;
        resolution_status: string;
        payload_json: string | null;
        person_id: string | null;
        status: string;
        excluded_from_analysis: number;
        committed: number;
      } | undefined;
      if (!issue || issue.resolution_status !== 'open' || issue.kind !== 'person_conflict') {
        throw new Error('REVIEW_ISSUE_NOT_OPEN');
      }
      if (issue.person_id !== input.personId) throw new Error('DOCUMENT_IDENTITY_CONFLICT');
      const payload = issue.payload_json
        ? JSON.parse(issue.payload_json) as { reportedName?: string; reasonCodes?: string[] }
        : {};
      const reportedName = payload.reportedName?.trim();
      if (!reportedName) throw new Error('REPORTED_NAME_REQUIRED');
      this.confirmPersonNameAlias({ personId: input.personId, reportedName, sourceDocumentId: input.documentId });

      if (payload.reasonCodes?.includes('COMMITTED_PERSON_IDENTITY_CONFLICT')) {
        if (issue.severity !== 'blocking' || issue.committed !== 1
          || issue.status !== 'completed' || issue.excluded_from_analysis !== 1) {
          throw new Error('COMMITTED_IDENTITY_REVIEW_STATE_CONFLICT');
        }
        const affectedSystemIds = this.systemIdsForDocuments([input.documentId]);
        const restored = this.db.prepare(`
          UPDATE documents SET excluded_from_analysis = 0,
              person_assignment_basis = 'identity_confirmed', confirmed_reported_name = ?
          WHERE id = ? AND person_id = ? AND status = 'completed' AND excluded_from_analysis = 1
        `).run(reportedName, input.documentId, input.personId);
        if (restored.changes !== 1) throw new Error('COMMITTED_IDENTITY_REVIEW_STATE_CONFLICT');
        const resolved = this.db.prepare(`
          UPDATE review_issues
          SET resolution_status = 'resolved', resolution_revision = 1,
              payload_json = json_set(payload_json, '$.identityConfirmed', json('true'))
          WHERE id = ? AND resolution_status = 'open'
        `).run(input.issueId);
        if (resolved.changes !== 1) throw new Error('REVIEW_ISSUE_NOT_OPEN');
        this.advanceRevisionAfterDocumentVisibilityChange(input.personId, affectedSystemIds);
        this.db.prepare(`
          INSERT INTO audit_events (id, event_type, entity_id, summary, created_at)
          VALUES (?, 'review_issue.committed_identity_confirmed', ?, '用户确认已提交报告属于当前成员；原有事实恢复参与分析，待核实项目保留', ?)
        `).run(randomUUID(), input.issueId, this.now().toISOString());
        this.resumeWaitingJobsAfterReview(input.documentId, false, issue.job_id);
        return;
      }

      const updated = this.db.prepare(`
        UPDATE documents
        SET status = 'queued', person_assignment_basis = 'identity_confirmed', confirmed_reported_name = ?
        WHERE id = ? AND person_id = ? AND status = 'needs_review'
      `).run(reportedName, input.documentId, input.personId);
      if (updated.changes !== 1) throw new Error('DOCUMENT_IDENTITY_CONFLICT');
      this.db.prepare(`
        UPDATE review_issues
        SET resolution_status = 'resolved', resolution_revision = 1,
            payload_json = json_set(payload_json, '$.identityConfirmed', json('true'))
        WHERE id = ?
      `).run(input.issueId);
      this.invalidateMemberAssessmentSnapshots(input.personId);
      this.db.prepare(`
        INSERT INTO audit_events (id, event_type, entity_id, summary, created_at)
        VALUES (?, 'review_issue.identity_confirmed', ?, '用户确认报告姓名与当前成员为同一人，任务重新进入核对队列', ?)
      `).run(randomUUID(), input.issueId, this.now().toISOString());
      this.resumeWaitingJobsAfterReview(input.documentId, false, issue.job_id);
    });
    transaction();
  }

  reassignDocumentPerson(input: { issueId: string; documentId: string; personId: string }): void {
    const transaction = this.db.transaction(() => {
      const issue = this.db.prepare(`
        SELECT ri.job_id, ri.kind, ri.severity, ri.resolution_status, ri.payload_json,
               d.person_id, d.status, d.confirmed_reported_name,
               EXISTS(SELECT 1 FROM document_commits dc WHERE dc.document_id = d.id) AS committed,
               EXISTS(
                 SELECT 1
                 FROM observation_revisions observation_revision
                 JOIN source_spans source_span ON source_span.id = observation_revision.source_span_id
                 WHERE source_span.document_id = d.id
               ) AS has_observations
        FROM review_issues ri
        JOIN documents d ON ri.field_ref = 'document:' || d.id
        WHERE ri.id = ? AND d.id = ?
      `).get(input.issueId, input.documentId) as {
        job_id: string | null;
        kind: string;
        severity: string;
        resolution_status: string;
        payload_json: string | null;
        person_id: string | null;
        status: string;
        confirmed_reported_name: string | null;
        committed: number;
        has_observations: number;
      } | undefined;
      if (!issue || issue.resolution_status !== 'open'
        || issue.kind !== 'person_conflict' || issue.severity !== 'blocking') {
        throw new Error('REVIEW_ISSUE_NOT_OPEN');
      }
      if (!issue.person_id || issue.person_id === input.personId || issue.status !== 'needs_review') {
        throw new Error('DOCUMENT_IDENTITY_CONFLICT');
      }
      const targetPerson = this.db.prepare(`
        SELECT id FROM persons WHERE id = ? AND archived_at IS NULL
      `).get(input.personId) as { id: string } | undefined;
      if (!targetPerson) throw new Error('PERSON_NOT_FOUND');
      if (issue.committed === 1) throw new Error('DOCUMENT_ALREADY_COMMITTED');
      if (issue.has_observations === 1) throw new Error('DOCUMENT_HAS_OBSERVATIONS');

      const relatedJobs = this.db.prepare(`
        SELECT id, person_id, stage, status, checkpoint_json
        FROM jobs
        WHERE checkpoint_json IS NOT NULL
      `).all() as Array<{
        id: string;
        person_id: string | null;
        stage: StoredJobSummary['stage'];
        status: StoredJobSummary['status'];
        checkpoint_json: string;
      }>;
      const jobsContainingDocument: Array<{
        id: string;
        personId: string | null;
        stage: StoredJobSummary['stage'];
        status: StoredJobSummary['status'];
        checkpoint: ({ documentIds?: string[]; completedUnits?: number; extractionChunks?: Record<string, unknown> } & Record<string, unknown>);
      }> = [];
      for (const job of relatedJobs) {
        let checkpoint: ({ documentIds?: string[]; completedUnits?: number; extractionChunks?: Record<string, unknown> } & Record<string, unknown>);
        try {
          checkpoint = JSON.parse(job.checkpoint_json) as typeof checkpoint;
        } catch {
          if (job.id === issue.job_id) throw new Error('JOB_CHECKPOINT_INVALID');
          continue;
        }
        if (!checkpoint.documentIds?.includes(input.documentId)) continue;
        if (job.status === 'running') throw new Error('DOCUMENT_HAS_RUNNING_JOB');
        jobsContainingDocument.push({
          id: job.id, personId: job.person_id, stage: job.stage, status: job.status, checkpoint
        });
      }

      const payload = issue.payload_json
        ? JSON.parse(issue.payload_json) as { reportedName?: string }
        : {};
      const reportedName = payload.reportedName?.trim() || issue.confirmed_reported_name?.trim();
      if (!reportedName) throw new Error('REPORTED_NAME_REQUIRED');

      const changedAt = this.now().toISOString();
      const updated = this.db.prepare(`
        UPDATE documents
        SET person_id = ?, status = 'queued', person_assignment_basis = 'identity_confirmed',
            confirmed_reported_name = ?
        WHERE id = ? AND person_id = ? AND status = 'needs_review'
          AND NOT EXISTS (SELECT 1 FROM document_commits dc WHERE dc.document_id = documents.id)
      `).run(input.personId, reportedName, input.documentId, issue.person_id);
      if (updated.changes !== 1) throw new Error('DOCUMENT_IDENTITY_CONFLICT');
      this.confirmPersonNameAlias({ personId: input.personId, reportedName, sourceDocumentId: input.documentId });
      this.db.prepare(`
        UPDATE review_issues
        SET resolution_status = 'resolved', resolution_revision = 1,
            payload_json = json_set(
              COALESCE(payload_json, '{}'),
              '$.identityConfirmed', json('true'),
              '$.reassignedPersonId', ?
            )
        WHERE id = ? AND resolution_status = 'open'
      `).run(input.personId, input.issueId);

      // 改归后的资料不得继续使用旧成员批次的授权或原文缓存。
      // 旧批次仍可以用原授权对“剩余的原成员资料”重建综合结果。
      for (const job of jobsContainingDocument) {
        if (['cancelled', 'succeeded'].includes(job.status)) continue;
        const remainingDocumentIds = (job.checkpoint.documentIds ?? [])
          .filter((documentId) => documentId !== input.documentId);
        const checkpoint: ({
          documentIds: string[];
          completedUnits?: number;
          extractionChunks?: Record<string, unknown>;
        } & Record<string, unknown>) = { ...job.checkpoint, documentIds: remainingDocumentIds };
        if (checkpoint.extractionChunks && typeof checkpoint.extractionChunks === 'object') {
          delete checkpoint.extractionChunks[input.documentId];
          if (Object.keys(checkpoint.extractionChunks).length === 0) delete checkpoint.extractionChunks;
        }
        // completed_with_issues 可以被用户重试，所以终态检查点也必须清掉旧成员系统结果。
        delete checkpoint.systemOutcomes;
        delete checkpoint.assessmentOutcome;

        if (remainingDocumentIds.length === 0) {
          this.db.prepare(`
            UPDATE jobs
            SET status = 'cancelled', lease_owner = NULL, lease_expires_at = NULL,
                checkpoint_json = ?, updated_at = ?
            WHERE id = ? AND status != 'running'
          `).run(JSON.stringify({ ...checkpoint, completedUnits: 0 }), changedAt, job.id);
          continue;
        }

        let nextStatus = job.status;
        let nextStage = job.stage;
        let completedUnits = Math.min(Number(job.checkpoint.completedUnits ?? 0), remainingDocumentIds.length);
        if (job.status === 'waiting_user') {
          const stillBlocked = remainingDocumentIds.some((documentId) => this.hasOpenBlockingReview(documentId));
          if (!stillBlocked) {
            const pendingExtraction = remainingDocumentIds.some((documentId) => {
              const document = this.db.prepare(`
                SELECT status,
                       EXISTS(SELECT 1 FROM document_commits dc WHERE dc.document_id = documents.id) AS committed,
                       excluded_from_analysis
                FROM documents WHERE id = ?
              `).get(documentId) as { status: string; committed: number; excluded_from_analysis: number } | undefined;
              return document?.status === 'queued' && document.committed === 0 && document.excluded_from_analysis === 0;
            });
            nextStatus = 'queued';
            nextStage = pendingExtraction ? 'extract' : 'analyze';
            completedUnits = pendingExtraction ? 0 : remainingDocumentIds.length;
            delete checkpoint.systemOutcomes;
            delete checkpoint.assessmentOutcome;
          }
        }
        this.db.prepare(`
          UPDATE jobs
          SET status = ?, stage = ?, lease_owner = NULL, lease_expires_at = NULL,
              checkpoint_json = ?, updated_at = ?
          WHERE id = ? AND status != 'running'
        `).run(
          nextStatus,
          nextStage,
          JSON.stringify({ ...checkpoint, completedUnits }),
          changedAt,
          job.id
        );
      }

      this.invalidateMemberAssessmentSnapshots(issue.person_id);
      this.invalidateMemberAssessmentSnapshots(input.personId);
      this.db.prepare(`
        INSERT INTO audit_events (id, event_type, entity_id, summary, created_at)
        VALUES (?, 'review_issue.identity_reassigned', ?, '用户确认报告属于其他成员；旧批次已移除该资料，重新处理前需再次授权', ?)
      `).run(randomUUID(), input.issueId, changedAt);
    });
    transaction();
  }

  resolveReviewIssue(input: {
    issueId: string;
    documentId: string;
    action: 'archive_only' | 'dismiss_derived';
  }): void {
    const transaction = this.db.transaction(() => {
      const issue = this.db.prepare(`
        SELECT id, job_id, kind, resolution_status FROM review_issues
        WHERE id = ? AND field_ref = 'document:' || ?
      `).get(input.issueId, input.documentId) as { id: string; job_id: string | null; kind: string; resolution_status: string } | undefined;
      if (!issue || issue.resolution_status !== 'open') throw new Error('REVIEW_ISSUE_NOT_OPEN');
      if (input.action === 'archive_only' && issue.kind === 'derived_safety') throw new Error('REVIEW_ACTION_INVALID');
      if (input.action === 'dismiss_derived' && issue.kind !== 'derived_safety') throw new Error('REVIEW_ACTION_INVALID');

      if (input.action === 'archive_only') {
        const document = this.db.prepare(`SELECT person_id FROM documents WHERE id = ?`).get(input.documentId) as { person_id: string | null } | undefined;
        const affectedSystemIds = this.systemIdsForDocuments([input.documentId]);
        const detachFromMember = issue.kind === 'person_conflict';

        // 归档不等于继续挂在原成员名下。在改变归属前先锁定所有非终态任务，
        // 运行中任务不允许直接改归，避免正在传输或写库时变更主体。
        const relatedJobs = detachFromMember ? this.db.prepare(`
          SELECT id, status, checkpoint_json
          FROM jobs
          WHERE checkpoint_json IS NOT NULL
            AND status NOT IN ('cancelled', 'succeeded')
        `).all() as Array<{
          id: string;
          status: StoredJobSummary['status'];
          checkpoint_json: string;
        }> : [];
        const jobsContainingDocument: Array<{
          id: string;
          status: StoredJobSummary['status'];
          checkpoint: ({
            documentIds?: string[];
            completedUnits?: number;
            extractionChunks?: Record<string, unknown>;
          } & Record<string, unknown>);
        }> = [];
        for (const job of relatedJobs) {
          let checkpoint: ({
            documentIds?: string[];
            completedUnits?: number;
            extractionChunks?: Record<string, unknown>;
          } & Record<string, unknown>);
          try {
            checkpoint = JSON.parse(job.checkpoint_json) as typeof checkpoint;
          } catch {
            if (job.id === issue.job_id) throw new Error('JOB_CHECKPOINT_INVALID');
            continue;
          }
          if (!checkpoint.documentIds?.includes(input.documentId)) continue;
          if (job.status === 'running') throw new Error('DOCUMENT_HAS_RUNNING_JOB');
          jobsContainingDocument.push({ id: job.id, status: job.status, checkpoint });
        }

        if (detachFromMember) {
          this.db.prepare(`
            UPDATE documents
            SET person_id = NULL, status = 'ignored', excluded_from_analysis = 1
            WHERE id = ?
          `).run(input.documentId);
        } else {
          this.db.prepare(`
            UPDATE documents SET status = 'completed', excluded_from_analysis = 1 WHERE id = ?
          `).run(input.documentId);
        }

        const changedAt = this.now().toISOString();
        for (const job of jobsContainingDocument) {
          const remainingDocumentIds = (job.checkpoint.documentIds ?? [])
            .filter((documentId) => documentId !== input.documentId);
          const checkpoint: ({
            documentIds: string[];
            completedUnits: number;
            extractionChunks?: Record<string, unknown>;
          } & Record<string, unknown>) = {
            ...job.checkpoint,
            documentIds: remainingDocumentIds,
            completedUnits: Math.min(
              Number(job.checkpoint.completedUnits ?? 0),
              remainingDocumentIds.length
            )
          };
          if (checkpoint.extractionChunks && typeof checkpoint.extractionChunks === 'object') {
            delete checkpoint.extractionChunks[input.documentId];
            if (Object.keys(checkpoint.extractionChunks).length === 0) delete checkpoint.extractionChunks;
          }
          delete checkpoint.systemOutcomes;
          delete checkpoint.assessmentOutcome;
          this.db.prepare(`
            UPDATE jobs
            SET status = CASE WHEN ? = 0 THEN 'cancelled' ELSE status END,
                lease_owner = NULL, lease_expires_at = NULL,
                checkpoint_json = ?, updated_at = ?
            WHERE id = ? AND status != 'running'
          `).run(
            remainingDocumentIds.length,
            JSON.stringify(checkpoint),
            changedAt,
            job.id
          );
        }

        if (document?.person_id) {
          this.db.prepare(`
            INSERT INTO person_revisions (person_id, fact_revision) VALUES (?, 1)
            ON CONFLICT(person_id) DO UPDATE SET fact_revision = fact_revision + 1
          `).run(document.person_id);
          this.db.prepare(`UPDATE derived_snapshots SET status = 'stale' WHERE person_id = ? AND status = 'current'`).run(document.person_id);
          this.invalidateSystemSnapshots(document.person_id, affectedSystemIds);
          this.invalidateMemberAssessmentSnapshots(document.person_id);
        }
      }
      this.db.prepare(`
        UPDATE review_issues SET resolution_status = 'resolved', resolution_revision = 1
        WHERE id = ? AND resolution_status = 'open'
      `).run(input.issueId);
      const reviewDocument = this.db.prepare(`SELECT person_id FROM documents WHERE id = ?`)
        .get(input.documentId) as { person_id: string | null } | undefined;
      if (reviewDocument?.person_id) this.invalidateMemberAssessmentSnapshots(reviewDocument.person_id);
      this.db.prepare(`
        INSERT INTO audit_events (id, event_type, entity_id, summary, created_at)
        VALUES (?, 'review_issue.resolved', ?, ?, ?)
      `).run(
        randomUUID(), input.issueId,
        input.action === 'archive_only' ? '用户选择仅归档，不纳入分析' : '用户选择不发布本次派生说明',
        this.now().toISOString()
      );
      this.resumeWaitingJobsAfterReview(input.documentId, input.action === 'dismiss_derived', issue.job_id);
    });
    transaction();
  }

  listReadyDocuments(): ReadyDocument[] {
    return this.db.prepare(`
      SELECT id, person_id AS personId
      FROM documents
      WHERE status = 'queued' AND person_id IS NOT NULL
      ORDER BY created_at, id
    `).all() as ReadyDocument[];
  }

  listDerivedRefreshTargets(): Array<{ personId: string; documentId: string }> {
    const rows = this.db.prepare(`
      SELECT p.id AS person_id, MIN(d.id) AS document_id
      FROM persons p
      JOIN observations o ON o.person_id = p.id
      JOIN source_spans ss ON ss.id = (
        SELECT r.source_span_id FROM observation_revisions r
        WHERE r.observation_id = o.id AND r.revision = o.current_revision
      )
      JOIN documents d ON d.id = ss.document_id AND d.excluded_from_analysis = 0
      LEFT JOIN derived_snapshots current_snapshot
        ON current_snapshot.person_id = p.id AND current_snapshot.status = 'current'
        AND current_snapshot.fact_revision = COALESCE((SELECT fact_revision FROM person_revisions pr WHERE pr.person_id = p.id), 0)
        AND current_snapshot.context_revision = p.clinical_context_revision
      WHERE p.archived_at IS NULL AND current_snapshot.id IS NULL
      GROUP BY p.id
    `).all() as Array<{ person_id: string; document_id: string }>;
    return rows.map((row) => ({ personId: row.person_id, documentId: row.document_id }));
  }

  private resumeWaitingJobsAfterReview(documentId: string, finishWithoutResume = false, issueJobId: string | null = null): void {
    const jobs = this.db.prepare(`
      SELECT id, stage, checkpoint_json FROM jobs WHERE status = 'waiting_user'
    `).all() as Array<{ id: string; stage: StoredJobSummary['stage']; checkpoint_json: string | null }>;
    for (const job of jobs) {
      const checkpoint = job.checkpoint_json ? JSON.parse(job.checkpoint_json) as {
        documentIds?: string[];
        completedUnits?: number;
        consentId?: string | null;
      } & Record<string, unknown> : {};
      if (!checkpoint.documentIds?.length) continue;
      if (issueJobId ? job.id !== issueJobId : !checkpoint.documentIds?.includes(documentId)) continue;
      if (!checkpoint.consentId || !this.db.prepare(`SELECT 1 FROM consents WHERE id = ? AND revoked_at IS NULL`).get(checkpoint.consentId)) {
        // 旧授权已撤回：绝不自动恢复传输，也不能让僵住的 waiting_user 占着资料
        // 阻止用户重新授权建立新批次。保留任务历史，以 cancelled 终结该批次。
        this.db.prepare(`
          UPDATE jobs SET status = 'cancelled', lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
          WHERE id = ? AND status = 'waiting_user'
        `).run(this.now().toISOString(), job.id);
        continue;
      }
      const stillBlockedForJob = Boolean(this.db.prepare(`
        SELECT 1 FROM review_issues
        WHERE job_id = ? AND resolution_status = 'open' AND severity = 'blocking'
        LIMIT 1
      `).get(job.id));
      const stillBlockedForLegacyDocument = checkpoint.documentIds?.some((id) => this.hasOpenBlockingReview(id)) ?? false;
      const stillBlocked = stillBlockedForJob || stillBlockedForLegacyDocument;
      if (stillBlocked) continue;
      const pendingExtraction = checkpoint.documentIds.some((id) => {
        const document = this.db.prepare(`
          SELECT status,
                 EXISTS(SELECT 1 FROM document_commits dc WHERE dc.document_id = documents.id) AS committed,
                 excluded_from_analysis
          FROM documents WHERE id = ?
        `).get(id) as { status: string; committed: number; excluded_from_analysis: number } | undefined;
        return document?.status === 'queued' && document.committed === 0 && document.excluded_from_analysis === 0;
      });
      const resumeExtraction = !finishWithoutResume
        && (pendingExtraction || job.stage === 'extract' || job.stage === 'review_facts');
      const resumeAnalysis = !finishWithoutResume && !resumeExtraction;
      const status = resumeExtraction || resumeAnalysis ? 'queued' : 'succeeded';
      if (resumeAnalysis) delete checkpoint.systemOutcomes;
      if (resumeExtraction || resumeAnalysis) delete checkpoint.assessmentOutcome;
      this.db.prepare(`
        UPDATE jobs
        SET status = ?, stage = ?, lease_owner = NULL, lease_expires_at = NULL,
            checkpoint_json = ?, updated_at = ?
        WHERE id = ?
      `).run(
        status,
        resumeExtraction ? 'extract' : resumeAnalysis ? 'analyze' : job.stage,
        JSON.stringify({
          ...checkpoint,
          // 保留原批次范围。JobRunner 会跳过已经提交或明确排除的资料，
          // 并在所有阻断事项解决后重新生成这一批的综合分析。
          documentIds: checkpoint.documentIds,
          completedUnits: resumeExtraction ? 0 : checkpoint.documentIds.length
        }),
        this.now().toISOString(),
        job.id
      );
    }
  }

  createInboxBinding(input: {
    canonicalPath: string;
    personId: string | null;
    recursive: boolean;
    allowScheduledAiProcessing: boolean;
    accountFingerprint: string | null;
    consentVersion: number;
  }): InboxBindingSummary {
    const bindingId = randomUUID();
    const consentId = randomUUID();
    const timestamp = this.now().toISOString();
    const pathFingerprint = createHash('sha256').update(input.canonicalPath).digest('hex');
    const scope = {
      type: 'inbox_binding',
      personId: input.personId,
      localImport: true,
      scheduledAiProcessing: input.allowScheduledAiProcessing,
      includeRelevantHistory: input.allowScheduledAiProcessing,
      pathFingerprint
    };
    const transaction = this.db.transaction(() => {
      const existing = this.db.prepare(`SELECT id, consent_id FROM inbox_bindings WHERE canonical_path = ?`)
        .get(input.canonicalPath) as { id: string; consent_id: string | null } | undefined;
      if (existing?.consent_id) {
        this.db.prepare(`UPDATE consents SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL`).run(timestamp, existing.consent_id);
      }
      this.db.prepare(`
        INSERT INTO consents (
          id, scope_json, recipient, purpose, account_fingerprint, version, granted_at, revoked_at
        ) VALUES (?, ?, 'OpenAI/Codex', ?, ?, ?, ?, NULL)
      `).run(
        consentId,
        JSON.stringify(scope),
        input.allowScheduledAiProcessing ? 'scheduled_health_report_processing' : 'local_import_only',
        input.accountFingerprint,
        input.consentVersion,
        timestamp
      );
      if (existing) {
        this.db.prepare(`
          UPDATE inbox_bindings
          SET person_id = ?, recursive = ?, consent_id = ?, enabled = 1, created_at = ?
          WHERE id = ?
        `).run(input.personId, input.recursive ? 1 : 0, consentId, timestamp, existing.id);
      } else {
        this.db.prepare(`
          INSERT INTO inbox_bindings (
            id, canonical_path, person_id, recursive, consent_id, enabled, created_at
          ) VALUES (?, ?, ?, ?, ?, 1, ?)
        `).run(bindingId, input.canonicalPath, input.personId, input.recursive ? 1 : 0, consentId, timestamp);
      }
      const effectiveId = existing?.id ?? bindingId;
      this.db.prepare(`
        INSERT INTO audit_events (id, event_type, entity_id, summary, created_at)
        VALUES (?, 'inbox_binding.enabled', ?, ?, ?)
      `).run(randomUUID(), effectiveId, input.allowScheduledAiProcessing ? '已授权本地发现与日程 AI 处理' : '仅授权本地发现，未授权 AI 处理', timestamp);
      return effectiveId;
    });
    const effectiveId = transaction();
    const created = this.listInboxBindings().find((binding) => binding.id === effectiveId);
    if (!created) throw new Error('INBOX_BINDING_CREATE_FAILED');
    return created;
  }

  listInboxBindings(): InboxBindingSummary[] {
    const rows = this.db.prepare(`
      SELECT b.id, b.canonical_path, b.person_id, b.recursive, b.enabled, b.created_at,
             p.display_name AS person_label, c.scope_json, c.revoked_at
      FROM inbox_bindings b
      LEFT JOIN persons p ON p.id = b.person_id
      LEFT JOIN consents c ON c.id = b.consent_id
      ORDER BY b.created_at, b.id
    `).all() as Array<Record<string, unknown>>;
    return rows.map((row) => {
      const scope = row.scope_json ? JSON.parse(String(row.scope_json)) as { scheduledAiProcessing?: boolean } : {};
      return {
        id: String(row.id),
        displayName: basename(String(row.canonical_path)),
        personId: row.person_id === null ? null : String(row.person_id),
        personLabel: row.person_label === null ? null : String(row.person_label),
        recursive: Number(row.recursive) === 1,
        aiProcessingAuthorized: row.revoked_at === null && scope.scheduledAiProcessing === true,
        enabled: Number(row.enabled) === 1,
        createdAt: String(row.created_at)
      };
    });
  }

  listActiveInboxBindings(): ActiveInboxBinding[] {
    const summaries = new Map(this.listInboxBindings().map((binding) => [binding.id, binding]));
    const rows = this.db.prepare(`
      SELECT id, canonical_path, consent_id FROM inbox_bindings WHERE enabled = 1 ORDER BY created_at, id
    `).all() as Array<{ id: string; canonical_path: string; consent_id: string }>;
    return rows.flatMap((row) => {
      const summary = summaries.get(row.id);
      return summary ? [{ ...summary, canonicalPath: row.canonical_path, consentId: row.consent_id }] : [];
    });
  }

  disableInboxBinding(bindingId: string): void {
    const transaction = this.db.transaction(() => {
      const binding = this.db.prepare(`SELECT consent_id FROM inbox_bindings WHERE id = ?`).get(bindingId) as { consent_id: string | null } | undefined;
      if (!binding) throw new Error('INBOX_BINDING_NOT_FOUND');
      const timestamp = this.now().toISOString();
      this.db.prepare(`UPDATE inbox_bindings SET enabled = 0 WHERE id = ?`).run(bindingId);
      if (binding.consent_id) this.revokeConsent(binding.consent_id);
      this.db.prepare(`
        INSERT INTO audit_events (id, event_type, entity_id, summary, created_at)
        VALUES (?, 'inbox_binding.disabled', ?, '已停止目录监控并撤回对应处理授权', ?)
      `).run(randomUUID(), bindingId, timestamp);
    });
    transaction();
  }

  revokeAllAiAuthorizations(): { revokedConsentCount: number; waitingJobCount: number } {
    const timestamp = this.now().toISOString();
    const transaction = this.db.transaction(() => {
      const revoked = this.db.prepare(`
        UPDATE consents SET revoked_at = ?
        WHERE revoked_at IS NULL AND purpose IN (
          'scheduled_health_report_processing', 'manual_health_report_processing', 'automatic_upload_processing'
        )
      `).run(timestamp);
      const waiting = this.db.prepare(`
        UPDATE jobs SET status = 'waiting_auth', lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
        WHERE status IN ('queued', 'waiting_quota', 'retry_wait')
      `).run(timestamp);
      const jobs = this.db.prepare(`SELECT id FROM jobs WHERE checkpoint_json IS NOT NULL`)
        .all() as Array<{ id: string }>;
      for (const job of jobs) {
        try { this.scrubExtractionChunksFromJob(job.id); } catch {
          // 损坏的任务记录不能阻止用户撤回全部授权；活动执行仍会被授权门禁阻断。
        }
      }
      this.db.prepare(`
        INSERT INTO audit_events (id, event_type, entity_id, summary, created_at)
        VALUES (?, 'account.logged_out', NULL, 'Codex 已退出；本机档案保留，待发送任务与 AI 授权已暂停', ?)
      `).run(randomUUID(), timestamp);
      return { revokedConsentCount: revoked.changes, waitingJobCount: waiting.changes };
    });
    return transaction();
  }

  sanitizeRestoredMachineState(): {
    disabledBindingCount: number;
    revokedConsentCount: number;
    pausedScheduleCount: number;
    waitingJobCount: number;
  } {
    const timestamp = this.now().toISOString();
    const transaction = this.db.transaction(() => {
      const bindings = this.db.prepare(`
        UPDATE inbox_bindings
        SET enabled = 0, canonical_path = 'restored://inbox/' || id
      `).run();
      this.db.prepare(`
        UPDATE source_occurrences
        SET original_path = 'restored://source/' || id
      `).run();
      const consents = this.db.prepare(`
        UPDATE consents
        SET revoked_at = COALESCE(revoked_at, ?), account_fingerprint = NULL
      `).run(timestamp);
      const schedules = this.db.prepare(`
        UPDATE schedules
        SET enabled = 0, paused = 1, next_run_utc = NULL, revision = revision + 1
        WHERE enabled = 1 OR paused = 0 OR next_run_utc IS NOT NULL
      `).run();
      const jobs = this.db.prepare(`
        UPDATE jobs
        SET status = 'waiting_auth', lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
        WHERE status IN ('queued', 'running', 'waiting_quota', 'retry_wait')
      `).run(timestamp);
      const checkpointJobs = this.db.prepare(`SELECT id FROM jobs WHERE checkpoint_json IS NOT NULL`)
        .all() as Array<{ id: string }>;
      for (const job of checkpointJobs) {
        try { this.scrubExtractionChunksFromJob(job.id); } catch {
          // 恢复设备时，即使个别旧检查点损坏，也必须先撤回授权与目录绑定。
        }
      }
      this.db.prepare(`
        INSERT INTO audit_events (id, event_type, entity_id, summary, created_at)
        VALUES (?, 'backup.restore_machine_state_sanitized', NULL, '恢复后已清除设备路径并暂停目录授权、AI 授权与自动任务', ?)
      `).run(randomUUID(), timestamp);
      return {
        disabledBindingCount: bindings.changes,
        revokedConsentCount: consents.changes,
        pausedScheduleCount: schedules.changes,
        waitingJobCount: jobs.changes
      };
    });
    return transaction();
  }

  getOrCreateSchedule(timeZone: string, nextRunUtc: string | null): StoredSchedule {
    const existing = this.db.prepare(`
      SELECT id, enabled, local_time, zone_history_json, last_slot, next_run_utc, paused, revision
      FROM schedules WHERE id = 'daily' LIMIT 1
    `).get() as Record<string, unknown> | undefined;
    if (!existing) {
      this.db.prepare(`
        INSERT INTO schedules (
          id, enabled, local_time, zone_history_json, last_slot, next_run_utc, paused, revision
        ) VALUES ('daily', 0, '20:00', ?, NULL, ?, 0, 0)
      `).run(JSON.stringify([timeZone]), nextRunUtc);
      return { id: 'daily', enabled: false, localTime: '20:00', timeZone, lastSlot: null, nextRunUtc, revision: 0 };
    }
    const zoneHistory = JSON.parse(String(existing.zone_history_json)) as string[];
    return {
      id: String(existing.id),
      enabled: Number(existing.enabled) === 1 && Number((existing as { paused?: number }).paused ?? 0) === 0,
      localTime: String(existing.local_time) as `${number}:${number}`,
      timeZone: zoneHistory.at(-1) ?? timeZone,
      lastSlot: existing.last_slot === null ? null : String(existing.last_slot),
      nextRunUtc: existing.next_run_utc === null ? null : String(existing.next_run_utc),
      revision: Number(existing.revision)
    };
  }

  updateSchedule(input: {
    enabled: boolean;
    localTime: `${number}:${number}`;
    timeZone: string;
    nextRunUtc: string;
    expectedRevision: number;
  }): StoredSchedule {
    const current = this.getOrCreateSchedule(input.timeZone, input.nextRunUtc);
    if (current.revision !== input.expectedRevision) throw new RevisionConflictError(input.expectedRevision, current.revision);
    const zoneHistory = this.db.prepare(`SELECT zone_history_json FROM schedules WHERE id = 'daily'`).get() as { zone_history_json: string };
    const zones = JSON.parse(zoneHistory.zone_history_json) as string[];
    if (zones.at(-1) !== input.timeZone) zones.push(input.timeZone);
    const updated = this.db.prepare(`
      UPDATE schedules SET enabled = ?, local_time = ?, zone_history_json = ?,
        next_run_utc = ?, paused = 0, revision = revision + 1
      WHERE id = 'daily' AND revision = ?
    `).run(input.enabled ? 1 : 0, input.localTime, JSON.stringify(zones), input.nextRunUtc, input.expectedRevision);
    if (updated.changes !== 1) throw new RevisionConflictError(input.expectedRevision, this.getOrCreateSchedule(input.timeZone, input.nextRunUtc).revision);
    return this.getOrCreateSchedule(input.timeZone, input.nextRunUtc);
  }

  markScheduleChecked(slotKey: string, nextRunUtc: string): void {
    const result = this.db.prepare(`
      UPDATE schedules SET last_slot = ?, next_run_utc = ? WHERE id = 'daily'
    `).run(slotKey, nextRunUtc);
    if (result.changes !== 1) throw new Error('SCHEDULE_NOT_FOUND');
  }

  listScheduledReadyGroups(accountFingerprint: string | null, cutoff: string, limit = 100): ScheduledReadyGroup[] {
    const rows = this.db.prepare(`
      SELECT DISTINCT d.id AS document_id, d.person_id, b.consent_id, c.scope_json,
             c.account_fingerprint, d.created_at
      FROM documents d
      JOIN source_occurrences occ ON occ.source_object_id = d.source_object_id
      JOIN inbox_bindings b ON b.id = occ.binding_id AND b.enabled = 1
      JOIN consents c ON c.id = b.consent_id AND c.revoked_at IS NULL
      WHERE d.status = 'queued' AND d.person_id IS NOT NULL AND d.created_at <= ?
      ORDER BY d.created_at, d.id
    `).all(cutoff) as Array<Record<string, unknown>>;
    const groups = new Map<string, ScheduledReadyGroup>();
    const claimedDocuments = new Set<string>();
    for (const row of rows) {
      if (claimedDocuments.size >= limit) break;
      const scope = JSON.parse(String(row.scope_json)) as { type?: string; personId?: string | null; scheduledAiProcessing?: boolean };
      const personId = String(row.person_id);
      const documentId = String(row.document_id);
      const consentId = String(row.consent_id);
      if (claimedDocuments.has(documentId)) continue;
      if (accountFingerprint !== null && String(row.account_fingerprint ?? '') !== accountFingerprint) continue;
      if (scope.type !== 'inbox_binding' || scope.scheduledAiProcessing !== true || scope.personId !== personId) continue;
      const key = `${personId}:${consentId}`;
      const group = groups.get(key) ?? {
        personId,
        consentId,
        accountFingerprint: row.account_fingerprint === null ? null : String(row.account_fingerprint),
        documentIds: []
      };
      group.documentIds.push(documentId);
      groups.set(key, group);
      claimedDocuments.add(documentId);
    }
    return [...groups.values()];
  }

  createScheduledBatch(input: {
    slotKey: string;
    cutoff: string;
    groups: Array<ScheduledReadyGroup & {
      inputSignature: string;
      initialStatus: 'queued' | 'waiting_auth' | 'waiting_quota';
    }>;
  }): { batchId: string; jobIds: string[]; idempotent: boolean } {
    const existing = this.db.prepare(`SELECT id FROM batches WHERE slot_key = ?`).get(input.slotKey) as { id: string } | undefined;
    if (existing) return { batchId: existing.id, jobIds: [], idempotent: true };
    const batchId = randomUUID();
    const jobIds: string[] = [];
    const transaction = this.db.transaction(() => {
      this.db.prepare(`
        INSERT INTO batches (id, trigger, slot_key, cutoff, status, created_at, finished_at)
        VALUES (?, 'scheduled', ?, ?, ?, ?, NULL)
      `).run(
        batchId,
        input.slotKey,
        input.cutoff,
        input.groups.some((group) => group.initialStatus === 'queued') ? 'queued'
          : input.groups.some((group) => group.initialStatus === 'waiting_quota') ? 'waiting_quota' : 'waiting_auth',
        this.now().toISOString()
      );
      for (const group of input.groups) {
        const jobId = randomUUID();
        jobIds.push(jobId);
        this.db.prepare(`
          INSERT INTO jobs (
            id, batch_id, person_id, stage, input_signature, status,
            lease_owner, lease_expires_at, attempt_count, idempotency_key,
            checkpoint_json, created_at, updated_at
          ) VALUES (?, ?, ?, 'extract', ?, ?, NULL, NULL, 0, ?, ?, ?, ?)
        `).run(
          jobId, batchId, group.personId, group.inputSignature, group.initialStatus,
          `scheduled:${input.slotKey}:${group.personId}:${group.consentId}`,
          JSON.stringify({ documentIds: group.documentIds, completedUnits: 0, consentId: group.consentId, authorizationType: 'scheduled' }),
          this.now().toISOString(), this.now().toISOString()
        );
      }
      this.db.prepare(`UPDATE schedules SET last_slot = ? WHERE id = 'daily'`).run(input.slotKey);
    });
    transaction();
    return { batchId, jobIds, idempotent: false };
  }

  /** 报告有检查时期但部分结果未对应日期，只提供维护线索，不推填日期或制造核查事项。 */
  listDateBindingReviewDocumentCounts(): Map<string, number> {
    const rows = this.db.prepare(`SELECT d.id,COUNT(DISTINCT o.id) AS count
      FROM documents d JOIN persons p ON p.id=d.person_id
      JOIN source_spans s ON s.document_id=d.id
      JOIN observation_revisions r ON r.source_span_id=s.id
      JOIN observations o ON o.id=r.observation_id AND o.current_revision=r.revision AND o.person_id=d.person_id
      JOIN acceptance_decisions a ON a.id=r.acceptance_id
      WHERE d.status='completed' AND d.excluded_from_analysis=0 AND p.archived_at IS NULL
        AND r.clinical_date IS NULL AND r.value_kind IN ('numeric','qualitative') AND a.actor='policy'
        AND r.source_binding_json IS NOT NULL
        AND NOT EXISTS(SELECT 1 FROM concept_mapping_corrections c WHERE c.observation_id=o.id AND c.active=1)
        AND EXISTS(SELECT 1 FROM document_commits dc WHERE dc.document_id=d.id)
        AND EXISTS(SELECT 1 FROM report_source_links l JOIN report_records rr ON rr.id=l.report_id
          JOIN health_events_v2 e ON e.id=rr.event_id WHERE l.document_id=d.id AND rr.person_id=d.person_id
            AND e.clinical_date IS NOT NULL AND e.date_precision='day')
      GROUP BY d.id`).all() as Array<{ id: string; count: number }>;
    return new Map(rows.map(row => [row.id, row.count]));
  }

  /** 来源问题、旧姓名门禁及未对应日期可显式重核；活跃任务存在时不开放重跑。 */
  listRepairableExtractionDocumentIds(): Set<string> {
    if (this.db.prepare(`SELECT 1 FROM job_attempts WHERE finished_at IS NULL LIMIT 1`).get()
      || this.db.prepare(`SELECT 1 FROM jobs WHERE status IN ('queued','running','waiting_auth','waiting_quota','retry_wait') LIMIT 1`).get()) {
      return new Set();
    }
    const issues = this.listOpenExtractionReviewIssues();
    const jobs = this.db.prepare(`SELECT id, person_id, status, checkpoint_json FROM jobs`).all() as Array<{
      id: string; person_id: string | null; status: string; checkpoint_json: string | null;
    }>;
    const latest = this.db.prepare(`SELECT finished_at FROM job_attempts WHERE job_id = ? ORDER BY started_at DESC, rowid DESC LIMIT 1`);
    const eligibleJob = (job: typeof jobs[number]): boolean => {
      if (job.status !== 'waiting_user') return ['succeeded', 'completed_with_issues', 'failed', 'cancelled'].includes(job.status);
      try {
        const checkpoint = JSON.parse(job.checkpoint_json ?? '{}') as { documentIds?: unknown; completedUnits?: unknown };
        const attempt = latest.get(job.id) as { finished_at: string | null } | undefined;
        return Array.isArray(checkpoint.documentIds) && checkpoint.documentIds.length > 0
          && checkpoint.documentIds.every((id) => typeof id === 'string')
          && typeof checkpoint.completedUnits === 'number' && Number.isInteger(checkpoint.completedUnits)
          && checkpoint.completedUnits >= checkpoint.documentIds.length && Boolean(attempt?.finished_at);
      } catch { return false; }
    };
    const result = new Set<string>();
    const readDocument = this.db.prepare(`SELECT d.person_id, d.person_assignment_basis, d.status, d.excluded_from_analysis,
        EXISTS(SELECT 1 FROM document_commits dc WHERE dc.document_id=d.id) AS committed
      FROM documents d JOIN persons p ON p.id=d.person_id
      WHERE d.id=? AND d.person_id IS NOT NULL AND p.archived_at IS NULL`);
    for (const issue of issues) {
      const document = readDocument.get(issue.documentId) as {
        person_id: string; person_assignment_basis: string; status: string; excluded_from_analysis: number; committed: number;
      } | undefined;
      if (!document || document.excluded_from_analysis !== 0) continue;
      const identityRepair = isUserAssignedIdentityRepairIssue(issue, document.person_assignment_basis, document.person_id);
      const hasIdentityRepair = issues.some((other) => other.documentId === issue.documentId
        && isUserAssignedIdentityRepairIssue(other, document.person_assignment_basis, document.person_id));
      if (hasIdentityRepair && issues.some((other) => other.documentId === issue.documentId
        && !isUserAssignedIdentityRepairIssue(other, document.person_assignment_basis, document.person_id)
        && (other.severity === 'blocking' || !isSourceExtractionRepairIssue(other)))) continue;
      const sourceRepair = isSourceExtractionRepairIssue(issue);
      if (issue.stage !== 'extract' || !identityRepair && !sourceRepair
        || issues.some((other) => other.documentId === issue.documentId
          && (other.kind === 'overwrite_protected' || (other.kind === 'person_conflict'
              || other.reasonCodes.some((code) => code.startsWith('PERSON_') || code === 'DIRECT_ORIGINAL_IDENTITY_UNPROVEN'))
            && !isUserAssignedIdentityRepairIssue(other, document.person_assignment_basis, document.person_id)))
        || !((document.status === 'completed' && document.committed === 1 && issue.severity === 'warning')
          || (document.status === 'needs_review' && document.committed === 0 && issue.severity === 'blocking'))) continue;
      const related = jobs.filter((job) => {
        if (issue.jobId === job.id) return true;
        try {
          const ids = (JSON.parse(job.checkpoint_json ?? '{}') as { documentIds?: unknown }).documentIds;
          return Array.isArray(ids) && ids.includes(issue.documentId);
        } catch { return false; }
      });
      if (related.every((job) => eligibleJob(job) && (!hasIdentityRepair || job.person_id === document.person_id))) {
        result.add(issue.documentId);
      }
    }
    for (const documentId of this.listDateBindingReviewDocumentCounts().keys()) {
      // 没有 open issue 的旧报告也可维护，但不能借日期线索绕过身份、人工保护或医疗差异。
      if (issues.some(issue => issue.documentId === documentId && (issue.severity === 'blocking'
        || issue.kind === 'person_conflict' || issue.kind === 'overwrite_protected'
        || issue.candidateDiffs.length > 0 || issue.reasonCodes.some(code => code.startsWith('PERSON_')
          || code === 'DIRECT_ORIGINAL_IDENTITY_UNPROVEN')))) continue;
      const related = jobs.filter(job => {
        try { return (JSON.parse(job.checkpoint_json ?? '{}') as { documentIds?: string[] }).documentIds?.includes(documentId); }
        catch { return true; }
      });
      if (related.every(eligibleJob)) result.add(documentId);
    }
    return result;
  }

  createWaitingAuthBatch(input: {
    cutoff: string;
    groups: Array<{ personId: string; documentIds: string[]; inputSignature: string; stage?: StoredJobSummary['stage'] }>;
    initialStatus?: 'queued' | 'waiting_auth';
    consentId?: string | null;
    repairDocumentIds?: string[];
    dateCorrectionDocumentId?: string;
    supplementScopes?: ReportSupplementScope[];
  }): { batchId: string; jobIds: string[]; idempotent: boolean } {
    const initialStatus = input.initialStatus ?? 'waiting_auth';
    const signature = input.groups.map((group) => group.inputSignature).sort()[0];
    const transaction = this.db.transaction(() => {
    let assessmentIntentId: string | null = null;
    const repairIds = input.repairDocumentIds ?? [];
    const supplementScopes = (input.supplementScopes ?? []).map(scope => reportSupplementScopeSchema.parse(scope));
    if (supplementScopes.length && (!input.consentId || input.dateCorrectionDocumentId
      || new Set(supplementScopes.map(scope => scope.documentId)).size !== supplementScopes.length
      || supplementScopes.some(scope => !repairIds.includes(scope.documentId)
        || !input.groups.some(group => group.personId === scope.personId && group.stage === 'extract'
          && group.documentIds.includes(scope.documentId))
        || stableHash(scope) !== stableHash(this.getReportSupplementScope(scope.documentId))))) {
      throw new Error('REPORT_SUPPLEMENT_SCOPE_CHANGED');
    }
    const dateCorrection = input.dateCorrectionDocumentId
      ? this.getDateCorrectionScope(input.dateCorrectionDocumentId) : null;
    if (dateCorrection && !input.consentId) throw new Error('DATE_CORRECTION_CONSENT_REQUIRED');
    const scopeIds = [...new Set(input.groups.flatMap((group) => group.documentIds))].sort();
    const sameSet = (left: string[], right: string[]) => JSON.stringify([...new Set(left)].sort()) === JSON.stringify([...new Set(right)].sort());
    // 一次问题页授权中的每份报告都必须有冻结范围，不能夹带默认整份读取。
    if (supplementScopes.length && (!sameSet(supplementScopes.map(scope => scope.documentId), scopeIds)
      || input.groups.some(group => group.stage !== 'extract'))) {
      throw new Error('REPORT_SUPPLEMENT_SCOPE_CHANGED');
    }
    if (input.consentId) {
      const consent = this.db.prepare(`SELECT scope_json FROM consents WHERE id=? AND revoked_at IS NULL`)
        .get(input.consentId) as { scope_json: string } | undefined;
      const scope = consent ? JSON.parse(consent.scope_json) as {
        assessmentOnly?: boolean; personIds?: string[]; documentIds?: string[]; stages?: string[];
        dateCorrection?: DateCorrectionScope;
        supplementScopes?: ReportSupplementScope[];
      } : null;
      if (stableHash(scope?.supplementScopes ?? []) !== stableHash(supplementScopes)) throw new Error('REPORT_SUPPLEMENT_CONSENT_MISMATCH');
      if (dateCorrection && (repairIds.length !== 0 || input.groups.length !== 1
        || input.groups[0]!.stage !== 'extract' || input.groups[0]!.personId !== dateCorrection.personId
        || !sameSet(scopeIds, [dateCorrection.documentId])
        || JSON.stringify(scope?.dateCorrection) !== JSON.stringify(dateCorrection))) {
        throw new Error('DATE_CORRECTION_SCOPE_CHANGED');
      }
      if (!dateCorrection && scope?.dateCorrection) throw new Error('DATE_CORRECTION_SCOPE_INVALID');
      if (scope?.assessmentOnly === true && (repairIds.length > 0 || input.groups.length !== 1
        || input.groups[0]!.stage !== 'analyze'
        || !sameSet(scope.personIds ?? [], [input.groups[0]!.personId])
        || !sameSet(scope.documentIds ?? [], scopeIds)
        || !sameSet(scope.stages ?? [], ['analyze', 'review_derived', 'publish']))) {
        throw new Error('ASSESSMENT_ONLY_SCOPE_INVALID');
      }
      if (scope?.assessmentOnly === true) assessmentIntentId = input.consentId;
    }
    const assertRepairConsent = (consentId: string | null | undefined): void => {
      const consent = consentId ? this.db.prepare(`SELECT scope_json, account_fingerprint FROM consents
        WHERE id=? AND revoked_at IS NULL AND recipient='OpenAI/Codex' AND purpose='manual_health_report_processing'`)
        .get(consentId) as { scope_json: string; account_fingerprint: string | null } | undefined : undefined;
      const scope = consent ? JSON.parse(consent.scope_json) as { type?: string; documentIds?: string[]; personIds?: string[]; stages?: string[] } : null;
      if (!consent?.account_fingerprint || !scope || scope.type !== 'manual_batch'
        || !Array.isArray(scope.documentIds) || !sameSet(scope.documentIds, scopeIds)
        || !Array.isArray(scope.personIds) || !sameSet(scope.personIds, input.groups.map((group) => group.personId))
        || !scope.stages?.includes('extract')) throw new Error('PROCESSING_REPAIR_CONSENT_INVALID');
    };
    if (repairIds.length > 0) assertRepairConsent(input.consentId);
    if (assessmentIntentId) {
      // 相同授权的请求重放仍指向原任务，包括已结束任务；不重置旧断点或发送预算。
      const previousIntent = this.db.prepare(`SELECT batch_id AS batchId,id,person_id,checkpoint_json FROM jobs
        WHERE input_signature=? AND json_valid(checkpoint_json)
        AND json_extract(checkpoint_json,'$.consentId')=? LIMIT 1`)
        .get(signature, assessmentIntentId) as { batchId: string; id: string; person_id: string; checkpoint_json: string } | undefined;
      if (previousIntent) {
        const previousScope = JSON.parse(previousIntent.checkpoint_json) as { documentIds?: string[] };
        if (previousIntent.person_id !== input.groups[0]!.personId
          || !sameSet(previousScope.documentIds ?? [], scopeIds)) throw new Error('ASSESSMENT_ONLY_SCOPE_INVALID');
        return { batchId: previousIntent.batchId, jobIds: [previousIntent.id], idempotent: true };
      }
    }
    if (signature) {
      const existing = this.db.prepare(`
        SELECT batch_id AS batchId, id, person_id, checkpoint_json FROM jobs
        WHERE input_signature = ? AND status IN ('queued', 'running', 'waiting_auth', 'waiting_quota', 'waiting_user', 'retry_wait')
        LIMIT 1
      `).get(signature) as { batchId: string; id: string; person_id: string; checkpoint_json: string | null } | undefined;
      if (existing) {
        if (repairIds.length > 0) {
          const checkpoint = JSON.parse(existing.checkpoint_json ?? '{}') as { documentIds?: string[]; repairDocumentIds?: string[]; consentId?: string; supplementScopes?: ReportSupplementScope[] };
          if (input.groups.length !== 1 || existing.person_id !== input.groups[0]!.personId
            || !sameSet(checkpoint.documentIds ?? [], scopeIds) || !sameSet(checkpoint.repairDocumentIds ?? [], repairIds)) {
            throw new Error('PROCESSING_REPAIR_SCOPE_CONFLICT');
          }
          assertRepairConsent(checkpoint.consentId);
          if (stableHash(checkpoint.supplementScopes ?? []) !== stableHash(supplementScopes)) {
            throw new Error('REPORT_SUPPLEMENT_SCOPE_CHANGED');
          }
          return { batchId: existing.batchId, jobIds: [existing.id], idempotent: true };
        }
        if (input.consentId) {
          const checkpoint = existing.checkpoint_json ? JSON.parse(existing.checkpoint_json) as Record<string, unknown> : {};
          if (!checkpoint.consentId) {
            this.db.prepare(`UPDATE jobs SET checkpoint_json = ?, status = ?, updated_at = ? WHERE id = ?`).run(
              JSON.stringify({ ...checkpoint, consentId: input.consentId }),
              initialStatus,
              this.now().toISOString(),
              existing.id
            );
          }
        }
        return { batchId: existing.batchId, jobIds: [existing.id], idempotent: true };
      }
    }
    if (repairIds.length > 0) {
      const repairable = this.listRepairableExtractionDocumentIds();
      if (new Set(repairIds).size !== repairIds.length || repairIds.some((id) => !repairable.has(id)
        || !input.groups.some((group) => (group.stage ?? 'extract') === 'extract' && group.documentIds.includes(id)))) {
        throw new Error('PROCESSING_REPAIR_STATE_CHANGED');
      }
      const documentPerson = this.db.prepare(`SELECT person_id, person_assignment_basis FROM documents WHERE id=?`);
      for (const group of input.groups) for (const id of group.documentIds) {
        if (repairIds.includes(id) && (documentPerson.get(id) as { person_id: string } | undefined)?.person_id !== group.personId) {
          throw new Error('PROCESSING_REPAIR_SCOPE_CONFLICT');
        }
      }
      const timestamp = this.now().toISOString();
      const waiting = this.db.prepare(`SELECT id, checkpoint_json FROM jobs WHERE status='waiting_user'`)
        .all() as Array<{ id: string; checkpoint_json: string | null }>;
      for (const job of waiting) {
        const checkpoint = JSON.parse(job.checkpoint_json ?? '{}') as { documentIds?: string[] };
        if (!checkpoint.documentIds?.some((id) => repairIds.includes(id))) continue;
        this.db.prepare(`UPDATE jobs SET status='completed_with_issues', lease_owner=NULL, lease_expires_at=NULL, updated_at=? WHERE id=?`)
          .run(timestamp, job.id);
        this.scrubExtractionChunksFromJob(job.id);
      }
      const issues = this.listOpenExtractionReviewIssues();
      for (const id of repairIds) {
        const document = documentPerson.get(id) as { person_id: string; person_assignment_basis: string };
        const identityIssues = issues.filter((issue) => issue.documentId === id
          && isUserAssignedIdentityRepairIssue(issue, document.person_assignment_basis, document.person_id));
        for (const issue of identityIssues) {
          // deferred 表示旧门禁被新归属政策替代，不把原姓名伪装成“已确认”或保存为别名。
          this.db.prepare(`UPDATE review_issues SET resolution_status='deferred',
            resolution_revision=COALESCE(resolution_revision,0)+1 WHERE id=? AND resolution_status='open'`)
            .run(issue.id);
          this.db.prepare(`INSERT INTO audit_events (id,event_type,entity_id,summary,created_at)
            VALUES (?,'document.user_assignment_review_superseded',?,'已按上传时的明确成员归属替代旧姓名门禁，并排队重新读取原件；未确认原姓名，未改已有医疗结果。',?)`)
            .run(randomUUID(), issue.id, timestamp);
        }
        if (!this.isDocumentCommitted(id)) {
          this.db.prepare(`UPDATE documents SET status='queued' WHERE id=?`).run(id);
          this.db.prepare(`UPDATE review_issues SET resolution_status='deferred', resolution_revision=1
            WHERE field_ref='document:' || ? AND resolution_status='open' AND kind IN ('field_conflict','coverage_gap')`)
            .run(id);
        }
        this.invalidateMemberAssessmentSnapshots(document.person_id);
        this.db.prepare(`INSERT INTO audit_events (id,event_type,entity_id,summary,created_at)
          VALUES (?,'extraction_repair.requeued',?,'已按明确选择重新排队；旧核对问题并未视为已解决。',?)`)
          .run(randomUUID(), id, timestamp);
      }
    }
    const batchId = randomUUID();
    const jobIds: string[] = [];
      this.db.prepare(`
        INSERT INTO batches (id, trigger, slot_key, cutoff, status, created_at, finished_at)
        VALUES (?, 'manual', NULL, ?, ?, ?, NULL)
      `).run(batchId, input.cutoff, initialStatus, this.now().toISOString());
      for (const group of input.groups) {
        const jobId = randomUUID();
        jobIds.push(jobId);
        this.db.prepare(`
          INSERT INTO jobs (
            id, batch_id, person_id, stage, input_signature, status,
            lease_owner, lease_expires_at, attempt_count, idempotency_key,
            checkpoint_json, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, 0, ?, ?, ?, ?)
        `).run(
          jobId, batchId, group.personId, group.stage ?? 'extract', group.inputSignature,
          initialStatus,
          // 新的仅综合更新意图允许使用相同资料；运行中的同签名任务已在上方合并。
          assessmentIntentId ? `manual:${group.inputSignature}:assessment:${assessmentIntentId}` : `manual:${group.inputSignature}`,
          JSON.stringify({ documentIds: group.documentIds, completedUnits: 0, consentId: input.consentId ?? null, authorizationType: 'manual',
            ...(supplementScopes.length ? { supplementScopes: supplementScopes.filter(scope => group.documentIds.includes(scope.documentId)) } : {}),
            ...(dateCorrection ? { dateCorrection } : {}),
            ...(repairIds.length > 0 ? { repairDocumentIds: group.documentIds.filter((id) => repairIds.includes(id)) } : {}) }),
          this.now().toISOString(), this.now().toISOString()
        );
      }
    if (dateCorrection) this.ensureDateCorrectionIssue(jobIds[0]!, dateCorrection.documentId);
    return { batchId, jobIds, idempotent: false };
    });
    return transaction();
  }

  createAutomaticUploadBatch(input: {
    personId: string;
    documentIds: string[];
    accountFingerprint: string | null;
    version: number;
    promptVersion: string;
    rulesVersion: string;
    authorizationEpoch: number;
  }): { batchId: string; idempotent: boolean } {
    return this.db.transaction(() => {
      if (input.authorizationEpoch !== this.getAutomaticUploadAuthorizationEpoch()) {
        throw new Error('AUTOMATIC_UPLOAD_AUTHORIZATION_CHANGED');
      }
      const documentIds = [...new Set(input.documentIds)].sort();
      if (!documentIds.length || documentIds.length !== input.documentIds.length
        || this.checkpointDocumentPersonMismatches(documentIds, input.personId).length) {
        throw new Error('AUTOMATIC_UPLOAD_SCOPE_INVALID');
      }
      const readSource = this.db.prepare(`SELECT d.source_object_id, s.sha256 FROM documents d
        JOIN persons p ON p.id=d.person_id AND p.archived_at IS NULL
        JOIN source_objects s ON s.id=d.source_object_id
        JOIN source_manifests m ON m.document_id=d.id AND m.source_object_id=s.id AND m.sha256=s.sha256
        WHERE d.id=? AND d.person_id=? AND d.status='queued' AND d.excluded_from_analysis=0`);
      const uploadSources = documentIds.map((documentId) => {
        const source = readSource.get(documentId, input.personId) as { source_object_id: string; sha256: string } | undefined;
        if (!source) throw new Error('AUTOMATIC_UPLOAD_SOURCE_CHANGED');
        return { documentId, sourceObjectId: source.source_object_id, sha256: source.sha256 };
      });
      const processingIds = this.listProcessingDocumentIds();
      if (documentIds.some((id) => processingIds.has(id))) throw new Error('DOCUMENT_ALREADY_IN_PROCESSING');
      const consentId = randomUUID();
      this.db.prepare(`INSERT INTO consents
        (id,scope_json,recipient,purpose,account_fingerprint,version,granted_at,revoked_at)
        VALUES (?,?,'OpenAI/Codex','automatic_upload_processing',?,?,?,NULL)`)
        .run(consentId, JSON.stringify({ type: 'manual_batch', automaticUpload: true,
          documentIds, personIds: [input.personId], uploadSources, includeRelevantHistory: true,
          includeCurrentMemberHistory: true, historicalObservationIds: this.listAcceptedObservations(input.personId).map((item) => item.id),
          stages: ['extract','review_facts','analyze','guidance','review_derived','system_analysis','system_review','publish'] }),
        input.accountFingerprint, input.version, this.now().toISOString());
      const batch = this.createWaitingAuthBatch({ cutoff: this.now().toISOString(), consentId,
        initialStatus: input.accountFingerprint ? 'queued' : 'waiting_auth', groups: [{ personId: input.personId,
          documentIds, stage: 'extract', inputSignature: stableHash({ purpose: 'automatic_upload', personId: input.personId,
            uploadSources, promptVersion: input.promptVersion, rulesVersion: input.rulesVersion }) }] });
      if (batch.idempotent) this.revokeConsent(consentId);
      return { batchId: batch.batchId, idempotent: batch.idempotent };
    })();
  }

  getAutomaticUploadAuthorizationEpoch(): number {
    const row = this.db.prepare(`SELECT COALESCE(MAX(rowid),0) AS epoch FROM audit_events
      WHERE event_type IN ('account.logged_out','backup.restore_machine_state_sanitized')`).get() as { epoch: number };
    return row.epoch;
  }

  private automaticUploadScopeIsCurrent(scope: Record<string, unknown>, personId: string, documentIds: string[]): boolean {
    const scopedIds = scope.documentIds;
    const uploadSources = scope.uploadSources;
    if (scope.automaticUpload !== true || scope.type !== 'manual_batch' || scope.includeCurrentMemberHistory !== true
      || !Array.isArray(scope.personIds) || scope.personIds.length !== 1 || scope.personIds[0] !== personId
      || !Array.isArray(scopedIds) || scopedIds.length !== documentIds.length || !documentIds.length
      || new Set(documentIds).size !== documentIds.length || !documentIds.every((id) => scopedIds.includes(id))
      || !Array.isArray(uploadSources) || uploadSources.length !== documentIds.length) return false;
    const readSource = this.db.prepare(`SELECT d.source_object_id,s.sha256 FROM documents d
      JOIN persons p ON p.id=d.person_id AND p.archived_at IS NULL
      JOIN source_objects s ON s.id=d.source_object_id
      WHERE d.id=? AND d.person_id=? AND d.excluded_from_analysis=0`);
    return documentIds.every((documentId) => {
      const saved = uploadSources.filter((item: unknown) => item && typeof item === 'object'
        && (item as Record<string, unknown>).documentId === documentId) as Array<Record<string, unknown>>;
      const current = readSource.get(documentId, personId) as { source_object_id: string; sha256: string } | undefined;
      return saved.length === 1 && current !== undefined && saved[0]!.sourceObjectId === current.source_object_id
        && saved[0]!.sha256 === current.sha256;
    });
  }

  bindPendingAutomaticUploads(accountFingerprint: string): number {
    if (!accountFingerprint.trim()) throw new Error('ACCOUNT_FINGERPRINT_REQUIRED');
    return this.db.transaction(() => {
      const rows = this.db.prepare(`SELECT j.id,j.person_id,j.checkpoint_json,c.id AS consent_id,c.scope_json
        FROM jobs j JOIN consents c ON c.id=CASE WHEN json_valid(j.checkpoint_json)
          THEN json_extract(j.checkpoint_json,'$.consentId') END
        WHERE j.status='waiting_auth' AND c.purpose='automatic_upload_processing'
          AND c.account_fingerprint IS NULL AND c.revoked_at IS NULL`).all() as Array<{
        id: string; person_id: string; checkpoint_json: string; consent_id: string; scope_json: string;
      }>;
      let count = 0;
      for (const row of rows) {
        try {
          const checkpoint = JSON.parse(row.checkpoint_json) as { documentIds?: unknown; cancelRequested?: boolean };
          const scope = JSON.parse(row.scope_json) as Record<string, unknown>;
          if (checkpoint.cancelRequested) continue;
          if (!Array.isArray(checkpoint.documentIds)
            || !checkpoint.documentIds.every((id) => typeof id === 'string')
            || !this.automaticUploadScopeIsCurrent(scope, row.person_id, checkpoint.documentIds as string[])) {
            this.settleAutomaticUploadScopeChange(row.id);
            continue;
          }
          const bound = this.db.prepare(`UPDATE consents SET account_fingerprint=? WHERE id=? AND account_fingerprint IS NULL AND revoked_at IS NULL`)
            .run(accountFingerprint, row.consent_id);
          if (bound.changes !== 1) continue;
          count += this.db.prepare(`UPDATE jobs SET status='queued',updated_at=? WHERE id=? AND status='waiting_auth'`)
            .run(this.now().toISOString(), row.id).changes;
        } catch { continue; }
      }
      return count;
    })();
  }

  private settleAutomaticUploadScopeChange(jobId: string): void {
    this.db.prepare(`UPDATE jobs SET status='completed_with_issues',lease_owner=NULL,lease_expires_at=NULL,
      checkpoint_json=json_set(checkpoint_json,'$.automaticUploadStop','scope_changed'),updated_at=?
      WHERE id=? AND status IN ('queued','retry_wait','waiting_auth') AND json_valid(checkpoint_json)`)
      .run(this.now().toISOString(), jobId);
    this.scrubExtractionChunksFromJob(jobId);
  }

  shouldDeferAutomaticUploadAssessment(jobId: string): boolean {
    const current = this.db.prepare(`SELECT j.person_id,c.purpose,c.scope_json,c.account_fingerprint FROM jobs j JOIN consents c
      ON c.id=CASE WHEN json_valid(j.checkpoint_json) THEN json_extract(j.checkpoint_json,'$.consentId') END
      WHERE j.id=? AND c.revoked_at IS NULL`).get(jobId) as {
        person_id: string; purpose: string; scope_json: string; account_fingerprint: string | null;
      } | undefined;
    if (!current || current.purpose !== 'automatic_upload_processing') return false;
    const scope = JSON.parse(current.scope_json) as { automaticUpload?: boolean };
    if (scope.automaticUpload !== true) return false;
    if (this.automaticUploadIntents.hasPendingPerson(current.person_id, current.account_fingerprint)) return true;
    const pending = this.db.prepare(`SELECT j.person_id,j.checkpoint_json,c.scope_json FROM jobs j JOIN consents c ON c.id=CASE WHEN json_valid(j.checkpoint_json)
      THEN json_extract(j.checkpoint_json,'$.consentId') END WHERE j.id!=? AND j.person_id=?
      AND j.status IN ('queued','retry_wait') AND j.stage IN ('extract','review_facts')
      AND c.purpose='automatic_upload_processing' AND c.revoked_at IS NULL
      AND c.account_fingerprint=?`).all(jobId, current.person_id, current.account_fingerprint) as Array<{
        person_id: string; checkpoint_json: string; scope_json: string;
      }>;
    return pending.some((item) => {
      try {
        const checkpoint = JSON.parse(item.checkpoint_json) as { documentIds?: unknown; cancelRequested?: boolean };
        return !checkpoint.cancelRequested && Array.isArray(checkpoint.documentIds)
          && checkpoint.documentIds.every((id) => typeof id === 'string')
          && this.automaticUploadScopeIsCurrent(JSON.parse(item.scope_json) as Record<string, unknown>, item.person_id,
            checkpoint.documentIds as string[]);
      } catch { return false; }
    });
  }

  deferAutomaticUploadAssessment(guard: JobExecutionGuard): void {
    this.db.transaction(() => {
      this.assertJobExecutionActive(guard);
      const consent = this.db.prepare(`SELECT purpose FROM consents WHERE id=? AND revoked_at IS NULL`)
        .get(guard.consentId) as { purpose: string } | undefined;
      if (consent?.purpose !== 'automatic_upload_processing') throw new Error('AUTOMATIC_UPLOAD_SCOPE_REQUIRED');
      const changed = this.db.prepare(`UPDATE jobs SET stage='analyze',status='queued',lease_owner=NULL,lease_expires_at=NULL,
        checkpoint_json=json_set(checkpoint_json,'$.automaticAssessmentDeferred',json('true')),updated_at=?
        WHERE id=? AND status='running' AND json_valid(checkpoint_json)`).run(this.now().toISOString(), guard.jobId);
      if (changed.changes !== 1) throw new Error('JOB_EXECUTION_INACTIVE');
    })();
  }

  hasQueuedAutomaticUploads(): boolean {
    return !this.isQueuePaused() && Boolean(this.db.prepare(`SELECT 1 FROM jobs j JOIN consents c
      ON c.id=CASE WHEN json_valid(j.checkpoint_json) THEN json_extract(j.checkpoint_json,'$.consentId') END
      WHERE j.status='queued' AND c.purpose='automatic_upload_processing' AND c.revoked_at IS NULL
        AND c.account_fingerprint IS NOT NULL
        AND (json_extract(j.checkpoint_json,'$.modelBusyRetry.nextRetryAt') IS NULL
          OR json_extract(j.checkpoint_json,'$.modelBusyRetry.nextRetryAt')<=?) LIMIT 1`).get(this.now().toISOString()));
  }

  createManualProcessingConsent(input: {
    documentIds: string[];
    personIds: string[];
    historicalObservationIds?: string[];
    accountFingerprint: string;
    version: number;
    assessmentOnly?: true;
    dateCorrectionDocumentId?: string;
    supplementScopes?: ReportSupplementScope[];
  }): string {
    if (input.supplementScopes?.length && (input.assessmentOnly || input.dateCorrectionDocumentId
      || input.supplementScopes.some(scope => !input.documentIds.includes(scope.documentId)
        || !input.personIds.includes(scope.personId)
        || stableHash(reportSupplementScopeSchema.parse(scope)) !== stableHash(this.getReportSupplementScope(scope.documentId))))) {
      throw new Error('REPORT_SUPPLEMENT_SCOPE_CHANGED');
    }
    const dateCorrection = input.dateCorrectionDocumentId ? this.getDateCorrectionScope(input.dateCorrectionDocumentId) : null;
    if (dateCorrection && (input.assessmentOnly || input.personIds.length !== 1 || input.documentIds.length !== 1
      || input.personIds[0] !== dateCorrection.personId || input.documentIds[0] !== dateCorrection.documentId)) {
      throw new Error('DATE_CORRECTION_SCOPE_INVALID');
    }
    if (input.assessmentOnly) {
      const personId = input.personIds[0];
      const historicalIds = input.historicalObservationIds ?? [];
      const validObservations = new Set(personId ? this.listAcceptedObservations(personId).map((item) => item.id) : []);
      const person = personId ? this.listPersons().find((item) => item.id === personId && item.archivedAt === null) : undefined;
      if (!person || input.personIds.length !== 1 || input.documentIds.length !== 1 || historicalIds.length === 0
        || historicalIds.some((id) => !validObservations.has(id))
        || this.checkpointDocumentPersonMismatches(input.documentIds, person.id).length > 0
        || !this.isDocumentCommitted(input.documentIds[0]!) || this.isDocumentExcluded(input.documentIds[0]!)) {
        throw new Error('ASSESSMENT_ONLY_SCOPE_INVALID');
      }
    }
    const id = randomUUID();
    this.db.prepare(`
      INSERT INTO consents (
        id, scope_json, recipient, purpose, account_fingerprint, version, granted_at, revoked_at
      ) VALUES (?, ?, 'OpenAI/Codex', 'manual_health_report_processing', ?, ?, ?, NULL)
    `).run(
      id,
      JSON.stringify({
        type: 'manual_batch',
        documentIds: [...input.documentIds].sort(),
        personIds: [...input.personIds].sort(),
        historicalObservationIds: [...(input.historicalObservationIds ?? [])].sort(),
        includeRelevantHistory: true,
        ...(input.assessmentOnly ? { assessmentOnly: true } : {}),
        ...(dateCorrection ? { dateCorrection } : {}),
        ...(input.supplementScopes?.length ? { supplementScopes: input.supplementScopes } : {}),
        stages: input.assessmentOnly ? ['analyze', 'review_derived', 'publish']
          : ['extract', 'review_facts', 'analyze', 'guidance', 'review_derived', 'system_analysis', 'system_review', 'publish']
      }),
      input.accountFingerprint,
      input.version,
      this.now().toISOString()
    );
    return id;
  }

  /** 授权用途是运行时边界，不用可变阶段名或界面按钮文案猜测。 */
  isAssessmentOnlyJob(jobId: string): boolean {
    const row = this.db.prepare(`SELECT c.scope_json FROM jobs j JOIN consents c
      ON c.id=CASE WHEN json_valid(j.checkpoint_json) THEN json_extract(j.checkpoint_json,'$.consentId') END WHERE j.id=?`)
      .get(jobId) as { scope_json: string } | undefined;
    return row ? (JSON.parse(row.scope_json) as { assessmentOnly?: boolean }).assessmentOnly === true : false;
  }

  /** 日期纠错确认范围只由当前原件、归属和版本生成，不接受调用方提供新日期。 */
  getDateCorrectionScope(documentId: string): DateCorrectionScope {
    const document = this.db.prepare(`SELECT d.person_id,d.source_object_id,d.status,d.excluded_from_analysis,s.sha256
      FROM documents d JOIN source_objects s ON s.id=d.source_object_id JOIN persons p ON p.id=d.person_id
      WHERE d.id=? AND p.archived_at IS NULL`).get(documentId) as {
        person_id: string; source_object_id: string; status: string; excluded_from_analysis: number; sha256: string
      } | undefined;
    if (!document || document.excluded_from_analysis || document.status !== 'completed' || !this.isDocumentCommitted(documentId)) {
      throw new Error('DATE_CORRECTION_DOCUMENT_NOT_ELIGIBLE');
    }
    const observations = this.db.prepare(`SELECT o.id,o.current_revision FROM observations o
      JOIN observation_revisions r ON r.observation_id=o.id AND r.revision=o.current_revision
      JOIN source_spans s ON s.id=r.source_span_id WHERE s.document_id=? AND o.person_id=? ORDER BY o.id`)
      .all(documentId, document.person_id);
    if (!observations.length) throw new Error('DATE_CORRECTION_NO_EXISTING_FACTS');
    const reports = this.db.prepare(`SELECT r.id,r.metadata_revision,e.metadata_revision AS event_revision
      FROM report_records r JOIN report_source_links l ON l.report_id=r.id JOIN health_events_v2 e ON e.id=r.event_id
      WHERE l.document_id=? AND r.person_id=? ORDER BY r.id`).all(documentId, document.person_id);
    const revision = createHash('sha256').update(JSON.stringify({ document, observations, reports,
      factRevision: this.getFactRevision(document.person_id), contextRevision: this.getClinicalContextRevision(document.person_id) })).digest('hex');
    return { purpose: 'date_correction', documentId, personId: document.person_id,
      sourceObjectId: document.source_object_id, sha256: document.sha256, revision };
  }

  isDateCorrectionJob(jobId: string): boolean {
    const row = this.db.prepare(`SELECT c.scope_json FROM jobs j JOIN consents c ON c.id=
      CASE WHEN json_valid(j.checkpoint_json) THEN json_extract(j.checkpoint_json,'$.consentId') END WHERE j.id=?`)
      .get(jobId) as { scope_json: string } | undefined;
    return row ? (JSON.parse(row.scope_json) as { dateCorrection?: DateCorrectionScope }).dateCorrection?.purpose === 'date_correction' : false;
  }

  /** 日期用途使用自己任务的独立记录，不能借旧医疗候选warning清空其未核实范围。 */
  private ensureDateCorrectionIssue(jobId: string, documentId: string, reasonCodes?: string[], evidenceRefs?: string[]): string {
    if (!this.isDateCorrectionJob(jobId)) throw new Error('DATE_CORRECTION_SCOPE_INVALID');
    const existing = this.db.prepare(`SELECT id,payload_json,resolution_status FROM review_issues WHERE job_id=?
      AND field_ref=? AND kind='field_conflict' AND severity='warning'
      AND json_valid(payload_json) AND json_extract(payload_json,'$.purpose')='date_correction'`)
      .all(jobId, `document:${documentId}`) as Array<{ id: string; payload_json: string; resolution_status: string }>;
    if (existing.length > 1) throw new Error('DATE_CORRECTION_REVIEW_SCOPE_AMBIGUOUS');
    const row = existing[0];
    if (row) {
      if (reasonCodes && row.resolution_status === 'open') this.db.prepare(`UPDATE review_issues SET payload_json=?,
        evidence_refs_json=?,resolution_revision=COALESCE(resolution_revision,0)+1 WHERE id=? AND resolution_status='open'`)
        .run(JSON.stringify({ ...JSON.parse(row.payload_json), reasonCodes }), JSON.stringify(evidenceRefs ?? []), row.id);
      return row.id;
    }
    const id = randomUUID();
    this.db.prepare(`INSERT INTO review_issues(id,job_id,field_ref,kind,severity,evidence_refs_json,resolution_status,
      resolution_revision,payload_json,created_at) VALUES (?,?,?,'field_conflict','warning',?,'open',NULL,?,?)`)
      .run(id, jobId, `document:${documentId}`, JSON.stringify(evidenceRefs ?? []), JSON.stringify({ stage: 'extract',
        purpose: 'date_correction', candidateOptions: [], reasonCodes: reasonCodes ?? ['explicit_date_correction_requires_independent_original_review'] }),
      this.now().toISOString());
    return id;
  }

  saveDateCorrectionReviewIssue(guard: JobExecutionGuard, documentId: string, reasonCodes: string[], evidenceRefs: string[]): string {
    return this.db.transaction(() => {
      this.assertJobExecutionActive(guard, documentId);
      if (!this.assertDateCorrectionScope(guard, documentId)) throw new Error('DATE_CORRECTION_SCOPE_INVALID');
      return this.ensureDateCorrectionIssue(guard.jobId, documentId, reasonCodes, evidenceRefs);
    })();
  }

  private storedDateCorrectionFacts(personId: string, documentId: string): Array<{ observationId: string;
    binding: ResolvedReportSourceBinding | null; dateEvidence: PublishedObservationInput['evidence']; observation: PublishedObservationInput }> {
    const values = this.db.prepare(`SELECT o.id,o.concept_key,o.original_name,o.model_standard_name_candidate,r.*
      FROM observations o JOIN observation_revisions r ON r.observation_id=o.id AND r.revision=o.current_revision
      JOIN source_spans s ON s.id=r.source_span_id WHERE o.person_id=? AND s.document_id=? ORDER BY o.id`)
      .all(personId, documentId) as Array<StoredReconciliationObservationRow & { acceptance_id: string;
        model_standard_name_candidate: string | null; date_evidence_json: string }>;
    return values.map((row) => ({ observationId: row.id,
      dateEvidence: JSON.parse(row.date_evidence_json) as PublishedObservationInput['evidence'],
      binding: row.source_binding_json ? JSON.parse(row.source_binding_json) as ResolvedReportSourceBinding | null : null, observation: {
      conceptKey: row.concept_key, originalName: row.original_name ?? row.concept_key,
      modelStandardNameCandidate: row.model_standard_name_candidate, rawText: row.raw_text, valueKind: row.value_kind,
      decimalValue: row.decimal_value, qualifier: row.qualifier, unit: row.unit, referenceRange: row.reference_range,
      clinicalDate: row.clinical_date, abnormalFlag: row.abnormal_flag, documentId, sourceSpanId: row.source_span_id,
      acceptanceId: row.acceptance_id, specimen: row.specimen, method: row.method, bodySite: row.body_site,
      clinicalContext: row.clinical_context_json ? JSON.parse(row.clinical_context_json) as ClinicalContext : null,
      evidence: JSON.parse(row.evidence_json) as PublishedObservationInput['evidence']
    } }));
  }

  /** 提供不含旧日期/值/引用的稳定范围；真正原值只在提交事务中从旧修订投影。 */
  getDateCorrectionFactScopes(guard: JobExecutionGuard, documentId: string): {
    scopeRevision: string; factScopes: DateCorrectionFactScope[];
    appliedReceipt: { threadId: string; turnId: string } | null;
    modelId: string; reasoningEffort: string;
  } {
    this.assertJobExecutionActive(guard, documentId);
    const scope = this.assertDateCorrectionScope(guard, documentId);
    if (!scope) throw new Error('DATE_CORRECTION_SCOPE_INVALID');
    const attempt = this.db.prepare('SELECT model,reasoning_effort FROM job_attempts WHERE id=? AND job_id=?')
      .get(guard.attemptId, guard.jobId) as { model: string | null; reasoning_effort: string | null };
    const row = this.db.prepare('SELECT checkpoint_json FROM jobs WHERE id=?').get(guard.jobId) as { checkpoint_json: string };
    const checkpoint = JSON.parse(row.checkpoint_json) as {
      dateCorrectionAppliedRevision?: string; dateCorrectionReceipt?: { threadId: string; turnId: string }
    };
    if (!checkpoint.dateCorrectionAppliedRevision && (attempt.model !== 'gpt-6.1-sol' || attempt.reasoning_effort !== 'medium')) {
      throw new Error('DIRECT_ORIGINAL_MODEL_SCOPE_INVALID');
    }
    const facts = this.storedDateCorrectionFacts(scope.personId, documentId);
    return { scopeRevision: scope.revision, modelId: attempt.model ?? '', reasoningEffort: attempt.reasoning_effort ?? '',
      factScopes: facts.map((fact, index) => ({ scopeId: `fact_${index + 1}`, observationId: fact.observationId,
        originalName: fact.observation.originalName!, specimen: fact.observation.specimen,
        method: fact.observation.method, bodySite: fact.observation.bodySite })),
      appliedReceipt: checkpoint.dateCorrectionAppliedRevision && checkpoint.dateCorrectionReceipt
        ? checkpoint.dateCorrectionReceipt : null };
  }

  private assertDateCorrectionScope(guard: JobExecutionGuard, documentId: string): DateCorrectionScope | null {
    const row = this.db.prepare(`SELECT j.checkpoint_json,c.scope_json FROM jobs j JOIN consents c ON c.id=? WHERE j.id=?`)
      .get(guard.consentId, guard.jobId) as { checkpoint_json: string | null; scope_json: string } | undefined;
    const scope = row ? (JSON.parse(row.scope_json) as { dateCorrection?: DateCorrectionScope }).dateCorrection : undefined;
    if (!scope) return null;
    const checkpoint = JSON.parse(row!.checkpoint_json ?? '{}') as {
      dateCorrection?: DateCorrectionScope; dateCorrectionAppliedRevision?: string; documentIds?: string[]
    };
    if (scope.documentId !== documentId || checkpoint.documentIds?.length !== 1 || checkpoint.documentIds[0] !== documentId
      || JSON.stringify(checkpoint.dateCorrection) !== JSON.stringify(scope)) throw new Error('DATE_CORRECTION_SCOPE_INVALID');
    const current = this.getDateCorrectionScope(documentId);
    if (current.personId !== scope.personId || current.sha256 !== scope.sha256 || current.sourceObjectId !== scope.sourceObjectId
      || current.revision !== (checkpoint.dateCorrectionAppliedRevision ?? scope.revision)) throw new Error('DATE_CORRECTION_SCOPE_CHANGED');
    return scope;
  }

  /** 两份独立日期盲读的真实回执、输出哈希和范围绑定必须同时有效，旧patch断点不能授予替换能力。 */
  private dateCorrectionReviewReceipt(guard: JobExecutionGuard, documentId: string) {
    const scope = this.assertDateCorrectionScope(guard, documentId);
    if (!scope) throw new Error('DATE_CORRECTION_SCOPE_INVALID');
    const frozen = this.getDateCorrectionFactScopes(guard, documentId);
    const bundle = this.getDocumentExtractionBundle(documentId);
    const row = this.db.prepare('SELECT checkpoint_json FROM jobs WHERE id=?').get(guard.jobId) as { checkpoint_json: string };
    const checkpoint = JSON.parse(row.checkpoint_json) as {
      extractionChunks?: Record<string, Record<string, ExtractionChunkCheckpoint>>
    };
    for (const chunk of Object.values(checkpoint.extractionChunks?.[documentId] ?? {})) {
      if (chunk.consentId !== guard.consentId || chunk.documentId !== documentId) continue;
      const parsed = directOriginalDateReviewCheckpointSchema.safeParse(chunk.output);
      if (!parsed.success) continue;
      const state = parsed.data; const first = state.reads[0]; const second = state.reads[1];
      if (state.failureCode || state.scopeRevision !== scope.revision || state.originalSha256 !== scope.sha256
        || state.sourceObjectId !== scope.sourceObjectId || state.factScopesHash !== stableHash(frozen.factScopes)
        || !first?.reading || !second?.reading || first.outputHash !== stableHash(first.reading)
        || second.outputHash !== stableHash(second.reading) || first.receipt.threadId === second.receipt.threadId
        || first.receipt.turnId === second.receipt.turnId || first.transmissionId === second.transmissionId
        || chunk.threadId !== second.receipt.threadId || chunk.turnId !== second.receipt.turnId) continue;
      const transmission = this.db.prepare(`SELECT t.stage,p.proof_version,p.thread_id,p.turn_id,p.output_hash,p.input_signature
        FROM ai_transmissions t JOIN job_attempts a ON a.id=t.attempt_id AND a.job_id=t.job_id
        JOIN ai_transmission_receipts p ON p.transmission_id=t.id
        WHERE t.id=? AND t.job_id=? AND t.consent_id=? AND t.document_id=? AND t.status='completed' AND t.finished_at IS NOT NULL
        AND a.model='gpt-6.1-sol' AND a.reasoning_effort='medium'`);
      const receiptsMatch = [first, second].every((read, index) => {
        const receipt = transmission.get(read.transmissionId, guard.jobId, guard.consentId, documentId) as {
          stage: string; proof_version: string; thread_id: string; turn_id: string; output_hash: string; input_signature: string
        } | undefined;
        return receipt?.stage === (index === 0 ? 'extract' : 'repair_extraction')
          && receipt.proof_version === DIRECT_ORIGINAL_DATE_READING_VERSION && receipt.input_signature === chunk.signature
          && receipt.thread_id === read.receipt.threadId && receipt.turn_id === read.receipt.turnId && receipt.output_hash === read.outputHash;
      });
      if (!receiptsMatch) continue;
      const consensus = inspectDirectOriginalDateConsensus(first.reading, second.reading, { documentId,
        pageIds: bundle.manifest.spans.filter((span) => !span.modelEvidence).map((span) => span.id),
        factScopeIds: frozen.factScopes.map((fact) => fact.scopeId),
        acceptedReportedNames: [bundle.personDisplayName, bundle.confirmedReportedName ?? '', ...bundle.confirmedPersonAliases],
        subjectPolicy: ['user_selected', 'identity_confirmed'].includes(bundle.personAssignmentBasis)
          ? 'user_assigned' : 'require_source_identity' });
      if (consensus.issues.length) continue;
      return { ...second.receipt, first, second, consensus, factScopes: frozen.factScopes, modelId: frozen.modelId };
    }
    throw new Error('DATE_CORRECTION_INDEPENDENT_REVIEW_REQUIRED');
  }

  private dateCorrectionProjection(guard: JobExecutionGuard, documentId: string) {
    const proof = this.dateCorrectionReviewReceipt(guard, documentId);
    const bundle = this.getDocumentExtractionBundle(documentId);
    const manifest = bundle.manifest;
    const required = new Map<string, SourceSpan>();
    const refs = (firstKey: string, secondKey: string): PublishedObservationInput['evidence'] => [
      [proof.first, firstKey], [proof.second, secondKey]
    ].map(([read, key]) => {
      const entry = read as typeof proof.first;
      const date = entry.reading!.dates.find((item) => item.localKey === key)!;
      const parent = manifest.spans.find((item) => item.id === date.pageSourceSpanId && !item.modelEvidence);
      if (!parent || !date.quote) throw new Error('DATE_CORRECTION_INDEPENDENT_DATE_EVIDENCE_REQUIRED');
      const id = `model-original-${stableHash({ version: DIRECT_ORIGINAL_DATE_READING_VERSION, documentId,
        sha256: manifest.sha256, receipt: entry.receipt, date }).slice(0, 40)}`;
      required.set(id, { id, documentId, spanKind: 'block', page: parent.page,
        blockId: `model-original-excerpt:${parent.id}`, lineStart: null, lineEnd: null,
        quote: date.quote, readability: 'clear', modelEvidence: { version: 1,
          engine: 'codex-original-reading-v1', modelId: proof.modelId, ...entry.receipt,
          originalSha256: manifest.sha256, originalSourceObjectId: manifest.sourceObjectId,
          parentSourceSpanId: parent.id, inputKind: parent.spanKind === 'image' || manifest.mediaType === 'application/pdf'
            || manifest.mediaType.startsWith('image/') ? 'image' : 'native_text', role: 'date', clarity: 'clear' } });
      return { sourceSpanId: id, quote: date.quote };
    });
    const previous = this.db.prepare(`SELECT mr.payload_json FROM report_metadata_revisions mr
      JOIN report_records r ON r.id=mr.report_id AND r.metadata_revision=mr.revision
      JOIN report_source_links l ON l.report_id=r.id WHERE l.document_id=? AND r.person_id=?`)
      .all(documentId, bundle.personId) as Array<{ payload_json: string }>;
    if (previous.length !== 1) throw new Error('DATE_CORRECTION_REPORT_SCOPE_AMBIGUOUS');
    const oldMetadata = (JSON.parse(previous[0]!.payload_json) as { extracted?: ReportMetadataCandidate }).extracted;
    if (!oldMetadata || !proof.consensus.primary) throw new Error('DATE_CORRECTION_REPORT_METADATA_REQUIRED');
    const uniqueDates = [...new Map(proof.consensus.assignments.map((date) => [date.firstKey, date])).values()];
    const times: ReportMetadataCandidate['times'] = uniqueDates.map((date) => ({ role: date.role, value: date.value,
      precision: 'day', evidence: refs(date.firstKey, date.secondKey) }));
    if (proof.consensus.issued) times.push({ role: 'report_issued', value: proof.consensus.issued.value,
      precision: 'day', evidence: refs(proof.consensus.issued.firstKey, proof.consensus.issued.secondKey) });
    if (oldMetadata.times.some((time) => time.precision !== 'day'
      || !['sampled', 'examined', 'encounter', 'report_issued'].includes(time.role))
      || oldMetadata.times.filter((time) => time.role !== 'report_issued').length > uniqueDates.length
      || oldMetadata.times.some((time) => time.role === 'report_issued') && !proof.consensus.issued) {
      throw new Error('DATE_CORRECTION_METADATA_TIME_SCOPE_INCOMPLETE');
    }
    const { primaryClinicalTimeIndex: _oldPrimary, ...oldFields } = oldMetadata;
    const metadata: ReportMetadataCandidate = { ...oldFields, times,
      primaryClinicalTimeIndex: uniqueDates.findIndex((date) => date.firstKey === proof.consensus.primary!.firstKey) };
    if (metadata.primaryClinicalTimeIndex === -1) throw new Error('DATE_CORRECTION_PRIMARY_SCOPE_INVALID');
    const oldFacts = this.storedDateCorrectionFacts(bundle.personId, documentId);
    const observations = proof.factScopes.map((scope): PublishedObservationInput => {
      const saved = oldFacts.find((fact) => fact.observationId === scope.observationId);
      const old = saved?.observation;
      const date = proof.consensus.assignments.find((date) => date.factScopeId === scope.scopeId);
      if (!old || !date) throw new Error('DATE_CORRECTION_SCOPE_CHANGED');
      const supersededDateRef = (ref: PublishedObservationInput['evidence'][number]) => saved!.dateEvidence.some((previous) =>
        previous.sourceSpanId === ref.sourceSpanId && previous.quote === ref.quote);
      if ((old.clinicalContext?.conditions ?? []).some(supersededDateRef)) {
        throw new Error('DATE_CORRECTION_CONTEXT_DATE_SCOPE_AMBIGUOUS');
      }
      const evidence = [...old.evidence.filter((ref) => !supersededDateRef(ref)), ...refs(date.firstKey, date.secondKey)];
      // 来源锚点继承已接纳原句；盲读仅提供新日期，不重新生成医疗字段或旧引用。
      if (!saved?.binding?.units.length) throw new Error('DATE_CORRECTION_ORIGINAL_BINDING_UNPROVEN');
      const sourceBinding = { headingEvidence: [], findingEvidence: saved.binding.units.map((unit) => {
        const source = manifest.spans.find((span) => span.id === unit.sourceSpanId);
        const quote = source?.quote?.slice(unit.segmentStart, unit.segmentEnd);
        if (!quote) throw new Error('DATE_CORRECTION_ORIGINAL_BINDING_UNPROVEN');
        return { sourceSpanId: unit.sourceSpanId, quote };
      }) };
      const observation = { ...old, clinicalDate: date.value, evidence, sourceBinding };
      const candidate = { ...publishedObservationCandidate(observation), localKey: scope.scopeId };
      const resolved = this.resolveStoredReportBinding({ ...observation, candidate }, { ...manifest,
        spans: [...new Map([...manifest.spans, ...required.values()].map((span) => [span.id, span])).values()] });
      if (resolved.status !== 'resolved' || stableHash(resolved.binding) !== stableHash(saved.binding)) {
        throw new Error('DATE_CORRECTION_ORIGINAL_BINDING_UNPROVEN');
      }
      return { ...observation, candidate };
    });
    const existingIds = new Set(manifest.spans.map((span) => span.id));
    return { proof, observations, metadata, manifest: { ...manifest,
      spans: [...manifest.spans, ...[...required.values()].filter((span) => !existingIds.has(span.id))] } };
  }

  /** 正常产品提交：双盲读只贡献日期，所有医疗值由冻结的已接纳修订逐字投影。 */
  applyBlindDateCorrection(guard: JobExecutionGuard, documentId: string): AppendCommittedFactsReceipt {
    return this.db.transaction(() => {
      this.assertJobExecutionActive(guard, documentId);
      const projected = this.dateCorrectionProjection(guard, documentId);
      const bundle = this.getDocumentExtractionBundle(documentId);
      const issueId = this.ensureDateCorrectionIssue(guard.jobId, documentId);
      this.saveDirectOriginalEvidenceForProcessing(projected.manifest, { executionGuard: guard });
      const result = this.appendCommittedFacts({ personId: bundle.personId, documentId,
        expectedRevision: this.getFactRevision(bundle.personId), observations: projected.observations,
        reportMetadata: projected.metadata, summary: '两次完整原件独立日期读取一致，保留医疗原值并正式更新日期修订',
        reviewUpdate: { issueId, remainingCandidates: [], remainingReasonCodes: [], remainingEvidenceRefs: [] }, executionGuard: guard });
      // held 不得标为已证明，也不得让未核实的旧日期触发后续综合。
      if (result.heldCount || !result.reviewResolved) throw new Error('DATE_CORRECTION_DATE_ONLY_ADMISSION_HELD');
      const row = this.db.prepare('SELECT checkpoint_json FROM jobs WHERE id=?').get(guard.jobId) as { checkpoint_json: string };
      const checkpoint = JSON.parse(row.checkpoint_json) as Record<string, unknown>;
      this.db.prepare('UPDATE jobs SET checkpoint_json=? WHERE id=? AND checkpoint_json=?').run(JSON.stringify({ ...checkpoint,
        dateCorrectionAppliedRevision: this.getDateCorrectionScope(documentId).revision,
        dateCorrectionReceipt: { threadId: projected.proof.threadId, turnId: projected.proof.turnId } }), guard.jobId, row.checkpoint_json);
      this.supersedePreviousDateCorrectionWarnings(guard, documentId, projected.proof);
      return result;
    })();
  }

  /** 只结案同一原件的旧日期专用尝试；其医疗候选不因此被接纳，普通重核warning绝不清除。 */
  private supersedePreviousDateCorrectionWarnings(guard: JobExecutionGuard, documentId: string,
    proof: ReturnType<WorkspaceStore['dateCorrectionReviewReceipt']>): void {
    const current = this.assertDateCorrectionScope(guard, documentId);
    if (!current) throw new Error('DATE_CORRECTION_SCOPE_INVALID');
    const rows = this.db.prepare(`SELECT ri.id,ri.payload_json,j.id AS job_id,j.person_id,j.checkpoint_json,c.scope_json
      FROM review_issues ri JOIN jobs j ON j.id=ri.job_id JOIN consents c ON c.id=
        CASE WHEN json_valid(j.checkpoint_json) THEN json_extract(j.checkpoint_json,'$.consentId') END
      WHERE ri.field_ref=? AND ri.resolution_status='open' AND ri.severity='warning'
        AND ri.kind IN ('field_conflict','coverage_gap') AND j.id!=?
        AND j.status IN ('succeeded','completed_with_issues','failed','cancelled')
        AND NOT EXISTS(SELECT 1 FROM job_attempts a WHERE a.job_id=j.id AND a.finished_at IS NULL)`)
      .all(`document:${documentId}`, guard.jobId) as Array<{ id: string; job_id: string; person_id: string;
        payload_json: string | null; checkpoint_json: string | null; scope_json: string }>;
    const matches = (scope: DateCorrectionScope | undefined) => scope?.purpose === 'date_correction'
      && scope.documentId === documentId && scope.personId === current.personId
      && scope.sourceObjectId === current.sourceObjectId && scope.sha256 === current.sha256;
    for (const row of rows) {
      let payload: Record<string, unknown>; let checkpoint: { documentIds?: string[]; dateCorrection?: DateCorrectionScope };
      let consent: { dateCorrection?: DateCorrectionScope; documentIds?: string[]; personIds?: string[] };
      try {
        payload = JSON.parse(row.payload_json ?? '{}') as Record<string, unknown>;
        checkpoint = JSON.parse(row.checkpoint_json ?? '{}') as typeof checkpoint;
        consent = JSON.parse(row.scope_json) as typeof consent;
      } catch { continue; }
      if (!payload || !checkpoint || !consent || Array.isArray(payload) || Array.isArray(checkpoint) || Array.isArray(consent)
        || payload.stage !== 'extract' || row.person_id !== current.personId || checkpoint.documentIds?.length !== 1
        || checkpoint.documentIds[0] !== documentId || !matches(checkpoint.dateCorrection) || !matches(consent.dateCorrection)
        || consent.documentIds?.length !== 1 || consent.documentIds[0] !== documentId
        || consent.personIds?.length !== 1 || consent.personIds[0] !== current.personId
        || checkpoint.dateCorrection?.revision !== consent.dateCorrection?.revision) continue;
      this.db.prepare(`UPDATE review_issues SET resolution_status='resolved',
        resolution_revision=COALESCE(resolution_revision,0)+1,payload_json=? WHERE id=? AND resolution_status='open'`)
        .run(JSON.stringify({ ...payload, supersededByDateVerification: { jobId: guard.jobId,
          version: DIRECT_ORIGINAL_DATE_READING_VERSION, documentId, originalSha256: current.sha256,
          firstReceipt: proof.first.receipt, secondReceipt: proof.second.receipt,
          verifiedAt: this.now().toISOString(), candidateDisposition: 'not_reextracted_or_accepted' } }), row.id);
    }
  }

  revokeConsent(consentId: string): void {
    this.db.transaction(() => {
      this.db.prepare(`UPDATE consents SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL`)
        .run(this.now().toISOString(), consentId);
      const rows = this.db.prepare(`SELECT id, checkpoint_json FROM jobs WHERE checkpoint_json IS NOT NULL`)
        .all() as Array<{ id: string; checkpoint_json: string }>;
      for (const row of rows) {
        let checkpoint: { consentId?: string };
        try { checkpoint = JSON.parse(row.checkpoint_json) as { consentId?: string }; } catch { continue; }
        if (checkpoint.consentId === consentId) this.scrubExtractionChunksFromJob(row.id);
      }
    })();
  }

  revokeUnreferencedManualProcessingConsents(): number {
    const active = this.db.prepare(`
      SELECT id FROM consents
      WHERE purpose IN ('manual_health_report_processing','automatic_upload_processing') AND revoked_at IS NULL
    `).all() as Array<{ id: string }>;
    const referenced = new Set<string>();
    const jobs = this.db.prepare(`SELECT checkpoint_json FROM jobs WHERE checkpoint_json IS NOT NULL`)
      .all() as Array<{ checkpoint_json: string }>;
    for (const job of jobs) {
      try {
        const consentId = (JSON.parse(job.checkpoint_json) as { consentId?: unknown }).consentId;
        if (typeof consentId === 'string') referenced.add(consentId);
      } catch {
        // 损坏的任务检查点不能成为撤回其他授权的依据。
      }
    }
    const timestamp = this.now().toISOString();
    const revoke = this.db.prepare(`UPDATE consents SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL`);
    let revoked = 0;
    const transaction = this.db.transaction(() => {
      for (const consent of active) {
        if (!referenced.has(consent.id)) revoked += revoke.run(timestamp, consent.id).changes;
      }
    });
    transaction();
    return revoked;
  }

  listProcessingDocumentIds(): Set<string> {
    const rows = this.db.prepare(`
      SELECT checkpoint_json FROM jobs
      WHERE status NOT IN ('cancelled', 'succeeded', 'completed_with_issues') AND checkpoint_json IS NOT NULL
    `).all() as Array<{ checkpoint_json: string }>;
    const documentIds = new Set<string>();
    for (const row of rows) {
      try {
        const checkpoint = JSON.parse(row.checkpoint_json) as { documentIds?: unknown };
        if (Array.isArray(checkpoint.documentIds)) {
          for (const documentId of checkpoint.documentIds) {
            if (typeof documentId === 'string') documentIds.add(documentId);
          }
        }
      } catch {
        // 无法解析的旧任务不应该影响其他资料的可见性。
      }
    }
    return documentIds;
  }

  listActiveProcessingDocumentIds(): Set<string> {
    const rows = this.db.prepare(`
      SELECT checkpoint_json FROM jobs
      WHERE status IN ('queued', 'running', 'waiting_auth', 'waiting_quota', 'waiting_user', 'retry_wait')
        AND checkpoint_json IS NOT NULL
    `).all() as Array<{ checkpoint_json: string }>;
    const documentIds = new Set<string>();
    for (const row of rows) {
      try {
        const checkpoint = JSON.parse(row.checkpoint_json) as { documentIds?: unknown };
        if (!Array.isArray(checkpoint.documentIds)) continue;
        for (const documentId of checkpoint.documentIds) {
          if (typeof documentId === 'string') documentIds.add(documentId);
        }
      } catch {
        // 无法解析的旧任务不应锁住新一轮派生分析。
      }
    }
    return documentIds;
  }

  claimNextQueuedJob(leaseOwner: string, accountFingerprint: string, leaseMs = 15 * 60_000): JobExecution | null {
    const transaction = this.db.transaction(() => {
      if (this.isQueuePaused()) return null;
      for (;;) {
      const candidates = this.db.prepare(`
        SELECT id, person_id, checkpoint_json, attempt_count, stage, status
        FROM jobs WHERE ((status = 'queued' AND (NOT json_valid(checkpoint_json)
          OR json_extract(checkpoint_json, '$.modelBusyRetry.nextRetryAt') IS NULL
          OR json_extract(checkpoint_json, '$.modelBusyRetry.nextRetryAt') <= ?)) OR (status = 'retry_wait'
          AND json_valid(checkpoint_json)
          AND json_extract(checkpoint_json, '$.modelBusyRetry.nextRetryAt') <= ?))
        AND NOT EXISTS (
          SELECT 1 FROM jobs active WHERE active.id != jobs.id AND active.person_id = jobs.person_id
            AND (active.status = 'running' OR EXISTS (
              SELECT 1 FROM job_attempts a WHERE a.job_id=active.id AND a.finished_at IS NULL
            ))
        )
        ORDER BY CASE WHEN stage IN ('extract','review_facts') THEN 0 ELSE 1 END,
          CASE WHEN stage='analyze' AND json_valid(checkpoint_json)
          AND json_extract(checkpoint_json,'$.automaticAssessmentDeferred')=1 THEN 1 ELSE 0 END, created_at, id
      `).all(this.now().toISOString(), this.now().toISOString()) as Array<{ id: string; person_id: string | null; checkpoint_json: string | null; attempt_count: number; stage: StoredJobSummary['stage']; status: 'queued' | 'retry_wait' }>;
      const row = candidates.find((candidate) => candidate.stage !== 'analyze'
        || !this.shouldDeferAutomaticUploadAssessment(candidate.id));
      if (!row) return null;
      if (!row.person_id) {
        this.db.prepare(`UPDATE jobs SET status='waiting_user',updated_at=? WHERE id=?`).run(this.now().toISOString(), row.id);
        continue;
      }
      const checkpoint = row.checkpoint_json ? JSON.parse(row.checkpoint_json) as {
        documentIds?: string[];
        consentId?: string | null;
        authorizationType?: 'manual' | 'scheduled';
        modelBusyRetry?: unknown;
        assessmentPhaseHandoff?: { version?: unknown; analysisAiPreferences?: unknown };
      } : {};
      const busyRetry = parseModelBusyRetryState(checkpoint.modelBusyRetry);
      const phasePreferences = checkpoint.assessmentPhaseHandoff === undefined ? null
        : checkpoint.assessmentPhaseHandoff?.version === 1
          ? aiPreferencesSchema.safeParse(checkpoint.assessmentPhaseHandoff.analysisAiPreferences) : null;
      if (checkpoint.assessmentPhaseHandoff !== undefined && !phasePreferences?.success) {
        this.db.prepare(`UPDATE jobs SET status='waiting_user',updated_at=? WHERE id=?`).run(this.now().toISOString(), row.id);
        continue;
      }
      if (row.status === 'retry_wait' && (!busyRetry?.nextRetryAt
        || new Date(busyRetry.nextRetryAt).getTime() > this.now().getTime())) return null;
      if (!checkpoint.documentIds?.length || !checkpoint.consentId) {
        this.db.prepare(`UPDATE jobs SET status = 'waiting_user', updated_at = ? WHERE id = ?`).run(this.now().toISOString(), row.id);
        continue;
      }
      const consent = this.db.prepare(`SELECT id, account_fingerprint, scope_json, purpose FROM consents WHERE id = ? AND revoked_at IS NULL`).get(checkpoint.consentId) as { id: string; account_fingerprint: string | null; scope_json: string; purpose: string } | undefined;
      if (this.checkpointDocumentPersonMismatches(checkpoint.documentIds, row.person_id).length > 0) {
        // 归属变更后，旧任务与旧授权不得再读取该资料；同时清理可能含原文的缓存。
        this.scrubExtractionChunksFromJob(row.id);
        if (consent?.purpose === 'automatic_upload_processing') this.settleAutomaticUploadScopeChange(row.id);
        else this.db.prepare(`UPDATE jobs SET status = 'waiting_user', updated_at = ? WHERE id = ?`)
          .run(this.now().toISOString(), row.id);
        continue;
      }
      const scope = consent ? JSON.parse(consent.scope_json) as {
        type?: string;
        documentIds?: string[];
        personIds?: string[];
        stages?: string[];
        personId?: string | null;
        scheduledAiProcessing?: boolean;
        includeRelevantHistory?: boolean;
        assessmentOnly?: boolean;
        automaticUpload?: boolean;
      } : null;
      const requiredStages = scope?.assessmentOnly === true ? ['analyze', 'review_derived', 'publish']
        : ['extract', 'review_facts', 'analyze', 'guidance', 'review_derived', 'system_analysis', 'system_review', 'publish'];
      const scheduledDocumentsMatch = checkpoint.authorizationType === 'scheduled' && scope?.type === 'inbox_binding'
        ? checkpoint.documentIds.every((documentId) => {
          const occurrence = this.db.prepare(`
            SELECT 1
            FROM documents d
            JOIN source_occurrences occ ON occ.source_object_id = d.source_object_id
            JOIN inbox_bindings b ON b.id = occ.binding_id
            WHERE d.id = ? AND b.enabled = 1 AND b.consent_id = ?
            LIMIT 1
          `).get(documentId, checkpoint.consentId);
          return Boolean(occurrence);
        })
        : false;
      const scopeMatches = checkpoint.authorizationType === 'scheduled'
        ? scope?.type === 'inbox_binding'
          && scope.scheduledAiProcessing === true
          && scope.includeRelevantHistory === true
          && scope.personId === row.person_id
          && scheduledDocumentsMatch
        : scope?.type === 'manual_batch'
          && checkpoint.documentIds.every((documentId) => scope.documentIds?.includes(documentId))
          && scope.personIds?.includes(row.person_id)
          && (scope.assessmentOnly !== true || scope.personIds.length === 1 && requiredStages.includes(row.stage)
            && !scope.stages?.includes('extract') && !scope.stages?.includes('review_facts'))
          && requiredStages.every((stage) => scope.stages?.includes(stage));
      if (consent && consent.account_fingerprint !== accountFingerprint) {
        this.db.prepare(`UPDATE jobs SET status = 'waiting_auth', updated_at = ? WHERE id = ?`).run(this.now().toISOString(), row.id);
        continue;
      }
      const automaticScopeMatches = scope?.automaticUpload !== true && consent?.purpose !== 'automatic_upload_processing'
        || consent?.purpose === 'automatic_upload_processing' && scope
          && this.automaticUploadScopeIsCurrent(scope, row.person_id, checkpoint.documentIds);
      if (!consent || !scopeMatches || !automaticScopeMatches) {
        if (consent?.purpose === 'automatic_upload_processing') this.settleAutomaticUploadScopeChange(row.id);
        else this.db.prepare(`UPDATE jobs SET status = 'waiting_user', updated_at = ? WHERE id = ?`).run(this.now().toISOString(), row.id);
        continue;
      }
      const expiresAt = new Date(this.now().getTime() + leaseMs).toISOString();
      const updated = this.db.prepare(`
        UPDATE jobs SET status = 'running', lease_owner = ?, lease_expires_at = ?,
                        attempt_count = attempt_count + 1, updated_at = ?
        WHERE id = ? AND status = ? AND checkpoint_json IS ?
      `).run(leaseOwner, expiresAt, this.now().toISOString(), row.id, row.status, row.checkpoint_json);
      if (updated.changes !== 1) return null;
      return {
        id: row.id,
        personId: row.person_id,
        documentIds: checkpoint.documentIds,
        consentId: checkpoint.consentId,
        attemptCount: row.attempt_count + 1,
        stage: row.stage,
        ...(phasePreferences?.success ? { phaseAnalysisAiPreferences: phasePreferences.data } : {}),
        ...(busyRetry ? { modelBusyRetry: busyRetry } : {})
      };
      }
    });
    // 领取先取得写锁，再读取成员门；避免并发连接从旧 WAL 快照升级写锁而产生 BUSY_SNAPSHOT。
    return transaction.immediate();
  }

  /** 首轮提取结束时让另一位成员先读取；不抢占已经开始的综合。 */
  shouldYieldMemberAssessment(guard: JobExecutionGuard): boolean {
    this.assertJobExecutionActive(guard);
    if (this.isQueuePaused()) return false;
    const current = this.db.prepare(`SELECT person_id,stage,checkpoint_json FROM jobs WHERE id=? AND status='running'`)
      .get(guard.jobId) as { person_id: string; stage: string; checkpoint_json: string };
    if (!['extract', 'review_facts'].includes(current.stage)) return false;
    const currentCheckpoint = JSON.parse(current.checkpoint_json) as { assessmentPhaseHandoff?: unknown };
    if (currentCheckpoint.assessmentPhaseHandoff !== undefined) return false;
    const timestamp = this.now().toISOString();
    const candidates = this.db.prepare(`SELECT j.id,j.person_id,j.checkpoint_json,c.scope_json,c.purpose FROM jobs j
      JOIN consents c ON c.id=CASE WHEN json_valid(j.checkpoint_json) THEN json_extract(j.checkpoint_json,'$.consentId') END
      JOIN persons p ON p.id=j.person_id AND p.archived_at IS NULL
      WHERE j.person_id!=? AND j.stage IN ('extract','review_facts') AND c.revoked_at IS NULL
        AND c.account_fingerprint=? AND json_valid(j.checkpoint_json)
        AND COALESCE(json_extract(j.checkpoint_json,'$.cancelRequested'),0)!=1
        AND ((j.status='queued' AND (json_extract(j.checkpoint_json,'$.modelBusyRetry.nextRetryAt') IS NULL
          OR json_extract(j.checkpoint_json,'$.modelBusyRetry.nextRetryAt')<=?))
          OR (j.status='retry_wait' AND json_extract(j.checkpoint_json,'$.modelBusyRetry.nextRetryAt')<=?))
        AND NOT EXISTS (SELECT 1 FROM jobs active WHERE active.id!=j.id AND active.person_id=j.person_id
          AND (active.status='running' OR EXISTS (SELECT 1 FROM job_attempts a WHERE a.job_id=active.id AND a.finished_at IS NULL)))
      ORDER BY j.created_at,j.id`).all(current.person_id, guard.accountFingerprint, timestamp, timestamp) as Array<{
        id: string; person_id: string; checkpoint_json: string; scope_json: string; purpose: string;
      }>;
    return candidates.some((candidate) => {
      try {
        const checkpoint = JSON.parse(candidate.checkpoint_json) as { documentIds?: unknown; consentId?: string;
          authorizationType?: 'manual' | 'scheduled' };
        if (!Array.isArray(checkpoint.documentIds) || !checkpoint.documentIds.length
          || !checkpoint.documentIds.every((id) => typeof id === 'string')
          || this.checkpointDocumentPersonMismatches(checkpoint.documentIds as string[], candidate.person_id).length) return false;
        const documentIds = checkpoint.documentIds as string[];
        const scope = JSON.parse(candidate.scope_json) as { type?: string; personIds?: string[]; documentIds?: string[];
          stages?: string[]; personId?: string; scheduledAiProcessing?: boolean; includeRelevantHistory?: boolean;
          automaticUpload?: boolean; assessmentOnly?: boolean };
        if (checkpoint.authorizationType === 'scheduled') {
          if (scope.type !== 'inbox_binding' || scope.scheduledAiProcessing !== true || scope.includeRelevantHistory !== true
            || scope.personId !== candidate.person_id || !documentIds.every((documentId) => Boolean(this.db.prepare(`SELECT 1
              FROM documents d JOIN source_occurrences occ ON occ.source_object_id=d.source_object_id
              JOIN inbox_bindings b ON b.id=occ.binding_id WHERE d.id=? AND b.enabled=1 AND b.consent_id=? LIMIT 1`)
              .get(documentId, checkpoint.consentId)))) return false;
        } else if (scope.type !== 'manual_batch' || scope.assessmentOnly === true
          || !scope.personIds?.includes(candidate.person_id) || !documentIds.every((id) => scope.documentIds?.includes(id))
          || !['extract','review_facts','analyze','guidance','review_derived','system_analysis','system_review','publish']
            .every((stage) => scope.stages?.includes(stage))) return false;
        if ((scope.automaticUpload === true || candidate.purpose === 'automatic_upload_processing')
          && (candidate.purpose !== 'automatic_upload_processing'
            || !this.automaticUploadScopeIsCurrent(scope, candidate.person_id, documentIds))) return false;
        const processed = this.getJobProcessedDocumentIds(candidate.id);
        return documentIds.some((id) => !processed.has(id) && !this.isDocumentExcluded(id) && !this.hasOpenBlockingReview(id));
      } catch (error) {
        if (error instanceof SyntaxError || error instanceof TypeError) return false;
        throw error;
      }
    });
  }

  /** 阶段回执、冻结模型与重新排队在同一事务保存，断电不能留未结束 attempt 锁住成员。 */
  yieldMemberAssessment(input: { guard: JobExecutionGuard; analysisAiPreferences: AiPreferences;
    threadId?: string; turnId?: string; usage?: Parameters<WorkspaceStore['finishJobAttempt']>[0]['usage'] }): boolean {
    const transaction = this.db.transaction(() => {
      if (!this.shouldYieldMemberAssessment(input.guard)) return false;
      const row = this.db.prepare(`SELECT checkpoint_json,stage FROM jobs WHERE id=? AND status='running'`)
        .get(input.guard.jobId) as { checkpoint_json: string; stage: string };
      const checkpoint = JSON.parse(row.checkpoint_json) as Record<string, unknown> & { documentIds?: string[] };
      const processed = this.getJobProcessedDocumentIds(input.guard.jobId);
      if (!checkpoint.documentIds?.length || checkpoint.documentIds.some((id) => !processed.has(id))) {
        throw new Error('JOB_EXTRACTION_PHASE_INCOMPLETE');
      }
      const preferences = aiPreferencesSchema.parse(input.analysisAiPreferences);
      const timestamp = this.now().toISOString();
      const result = this.db.prepare(`UPDATE jobs SET stage='analyze',status='queued',lease_owner=NULL,lease_expires_at=NULL,
        checkpoint_json=?,updated_at=? WHERE id=? AND status='running'`)
        .run(JSON.stringify({ ...checkpoint, assessmentPhaseHandoff: { version: 1, sourceStage: row.stage,
          yieldedAt: timestamp, analysisAiPreferences: preferences } }), timestamp, input.guard.jobId);
      if (result.changes !== 1) throw new Error('JOB_EXECUTION_INACTIVE');
      this.finishJobAttempt({ attemptId: input.guard.attemptId, status: 'succeeded',
        ...(input.threadId ? { threadId: input.threadId } : {}), ...(input.turnId ? { turnId: input.turnId } : {}),
        ...(input.usage ? { usage: input.usage } : {}) });
      return true;
    });
    return transaction.immediate();
  }

  requeueWaitingJobs(status: 'waiting_auth' | 'waiting_quota', accountFingerprint?: string): number {
    // 通用额度可用不证明本模型/范围的明确用量上限已解除；这类任务只由本人主动继续。
    const result = this.db.prepare(`
      UPDATE jobs
      SET status = 'queued', updated_at = ?
      WHERE status = ?
        AND (? IS NULL OR EXISTS (
          SELECT 1 FROM consents c WHERE json_valid(jobs.checkpoint_json)
            AND c.id=json_extract(jobs.checkpoint_json,'$.consentId')
            AND c.account_fingerprint=? AND c.revoked_at IS NULL
        ))
        AND (? <> 'waiting_auth' OR NOT EXISTS (
          SELECT 1 FROM consents c WHERE json_valid(jobs.checkpoint_json)
            AND c.id=json_extract(jobs.checkpoint_json,'$.consentId')
            AND c.purpose='automatic_upload_processing' AND c.account_fingerprint IS NULL
        ))
        AND (? <> 'waiting_quota' OR COALESCE((
          SELECT a.error_code FROM job_attempts a WHERE a.job_id = jobs.id
          ORDER BY a.started_at DESC, a.rowid DESC LIMIT 1
        ), '') <> 'CODEX_QUOTA_EXHAUSTED')
    `).run(this.now().toISOString(), status, accountFingerprint ?? null, accountFingerprint ?? null, status, status);
    return result.changes;
  }

  hasDueModelBusyRetry(): boolean {
    if (this.isQueuePaused()) return false;
    return Boolean(this.db.prepare(`SELECT 1 FROM jobs WHERE status IN ('retry_wait','queued')
      AND json_valid(checkpoint_json)
      AND json_extract(checkpoint_json, '$.modelBusyRetry.nextRetryAt') <= ? LIMIT 1`)
      .get(this.now().toISOString()));
  }

  requestJobCancellation(jobId: string): { running: boolean; alreadyTerminal: boolean } {
    const transaction = this.db.transaction(() => {
      const row = this.db.prepare(`SELECT status, checkpoint_json FROM jobs WHERE id = ?`).get(jobId) as {
        status: StoredJobSummary['status'];
        checkpoint_json: string | null;
      } | undefined;
      if (!row) throw new Error('JOB_NOT_FOUND');
      if (row.status === 'succeeded' || row.status === 'completed_with_issues' || row.status === 'cancelled') {
        return { running: false, alreadyTerminal: true };
      }
      if (row.status === 'running') {
        const checkpoint = row.checkpoint_json ? JSON.parse(row.checkpoint_json) as Record<string, unknown> : {};
        this.db.prepare(`UPDATE jobs SET checkpoint_json = ?, updated_at = ? WHERE id = ? AND status = 'running'`).run(
          JSON.stringify({ ...checkpoint, cancelRequested: true }),
          this.now().toISOString(),
          jobId
        );
        this.scrubExtractionChunksFromJob(jobId);
        return { running: true, alreadyTerminal: false };
      }
      this.db.prepare(`
        UPDATE jobs
        SET status = 'cancelled', lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
        WHERE id = ?
      `).run(this.now().toISOString(), jobId);
      this.scrubExtractionChunksFromJob(jobId);
      return { running: false, alreadyTerminal: false };
    });
    return transaction();
  }

  isJobCancellationRequested(jobId: string): boolean {
    const row = this.db.prepare(`SELECT checkpoint_json FROM jobs WHERE id = ?`).get(jobId) as { checkpoint_json: string | null } | undefined;
    if (!row?.checkpoint_json) return false;
    const checkpoint = JSON.parse(row.checkpoint_json) as { cancelRequested?: boolean };
    return checkpoint.cancelRequested === true;
  }

  assertJobExecutionActive(guard: JobExecutionGuard, documentId?: string): void {
    if (this.closed) throw new Error('WORKSPACE_CLOSED');
    const row = this.db.prepare(`
      SELECT j.status, j.stage, j.person_id, j.checkpoint_json, a.status AS attempt_status,
             c.revoked_at, c.account_fingerprint, c.scope_json, c.purpose
      FROM jobs j
      JOIN job_attempts a ON a.job_id = j.id AND a.id = ?
      LEFT JOIN consents c ON c.id = ?
      WHERE j.id = ?
    `).get(guard.attemptId, guard.consentId, guard.jobId) as {
      status: string;
      stage: string;
      person_id: string | null;
      checkpoint_json: string | null;
      attempt_status: string;
      revoked_at: string | null;
      account_fingerprint: string | null;
      scope_json: string | null;
      purpose: string | null;
    } | undefined;
    if (!row || row.status !== 'running' || row.attempt_status !== 'running') throw new Error('JOB_EXECUTION_INACTIVE');
    const checkpoint = row.checkpoint_json ? JSON.parse(row.checkpoint_json) as {
      consentId?: string;
      documentIds?: string[];
      cancelRequested?: boolean;
    } : {};
    if (checkpoint.cancelRequested) throw new Error('JOB_CANCELLED');
    if (checkpoint.consentId !== guard.consentId || row.revoked_at !== null) throw new Error('CONSENT_REVOKED');
    if (row.account_fingerprint !== guard.accountFingerprint) throw new Error('ACCOUNT_FINGERPRINT_MISMATCH');
    const scope = row.scope_json ? JSON.parse(row.scope_json) as Record<string, unknown> & {
      assessmentOnly?: boolean; stages?: string[]; personIds?: string[]; automaticUpload?: boolean;
    } : null;
    if ((scope?.automaticUpload === true || row.purpose === 'automatic_upload_processing')
      && (row.purpose !== 'automatic_upload_processing' || !scope || !row.person_id
        || !this.automaticUploadScopeIsCurrent(scope, row.person_id, checkpoint.documentIds ?? []))) {
      throw new Error('AUTOMATIC_UPLOAD_SCOPE_CHANGED');
    }
    if (scope?.assessmentOnly === true && (!['analyze', 'review_derived', 'publish'].includes(row.stage)
      || !scope.stages?.includes(row.stage) || scope.personIds?.length !== 1 || scope.personIds[0] !== row.person_id)) {
      throw new Error('ASSESSMENT_ONLY_STAGE_OUTSIDE_SCOPE');
    }
    if (documentId && !checkpoint.documentIds?.includes(documentId)) throw new Error('DOCUMENT_OUTSIDE_CONSENT_SCOPE');
    if (!row.person_id || !checkpoint.documentIds?.length
      || this.checkpointDocumentPersonMismatches(checkpoint.documentIds, row.person_id).length > 0) {
      throw new Error('DOCUMENT_PERSON_SCOPE_MISMATCH');
    }
    if (this.isDateCorrectionJob(guard.jobId)) {
      this.assertDateCorrectionScope(guard, documentId ?? checkpoint.documentIds[0]!);
    }
  }

  /** 仅当前有效执行可读取；签名绑定原文件、证据片段与规则版本，授权 ID 改变则不可复用。 */
  getExtractionChunkCheckpoint(
    guard: JobExecutionGuard,
    documentId: string,
    signature: string
  ): Pick<ExtractionChunkCheckpoint, 'output' | 'threadId' | 'turnId' | 'extractionTurnId'> | null {
    return this.db.transaction(() => {
      this.assertJobExecutionActive(guard, documentId);
      const row = this.db.prepare(`SELECT checkpoint_json FROM jobs WHERE id = ?`)
        .get(guard.jobId) as { checkpoint_json: string | null };
      const checkpoint = row.checkpoint_json ? JSON.parse(row.checkpoint_json) as {
        extractionChunks?: Record<string, Record<string, ExtractionChunkCheckpoint>>;
      } : {};
      const saved = checkpoint.extractionChunks?.[documentId]?.[signature];
      return saved?.consentId === guard.consentId && saved.documentId === documentId
        && saved.signature === signature
        ? { output: saved.output, threadId: saved.threadId, turnId: saved.turnId, extractionTurnId: saved.extractionTurnId }
        : null;
    })();
  }

  /** 仅返回续跑调度提示，不授予来源接纳能力；原件、签名和证明仍由原流程完整复验。 */
  getJobSourceRefinementResumeDocumentIds(guard: JobExecutionGuard): string[] {
    return this.db.transaction(() => {
      this.assertJobExecutionActive(guard);
      const row = this.db.prepare('SELECT checkpoint_json FROM jobs WHERE id=?')
        .get(guard.jobId) as { checkpoint_json: string | null };
      const checkpoint = JSON.parse(row.checkpoint_json ?? '{}') as {
        documentIds?: string[]; extractionChunks?: Record<string, Record<string, ExtractionChunkCheckpoint>>
      };
      return (checkpoint.documentIds ?? []).filter((documentId) =>
        Object.values(checkpoint.extractionChunks?.[documentId] ?? {}).some((chunk) => {
          if (chunk.consentId !== guard.consentId || chunk.documentId !== documentId
            || !chunk.output || typeof chunk.output !== 'object') return false;
          const output = chunk.output as { checkpointKind?: unknown; sourceRefinementReview?: unknown };
          return output.checkpointKind === 'direct_original_reading'
            && typeof output.sourceRefinementReview === 'object' && output.sourceRefinementReview !== null;
        }));
    })();
  }

  saveExtractionChunkCheckpoint(input: {
    guard: JobExecutionGuard;
    documentId: string;
    signature: string;
    chunkIndex: number;
    output: unknown;
    threadId: string;
    turnId: string;
    extractionTurnId: string;
  }): void {
    this.db.transaction(() => {
      this.assertJobExecutionActive(input.guard, input.documentId);
      const row = this.db.prepare(`SELECT checkpoint_json FROM jobs WHERE id = ? AND status = 'running'`)
        .get(input.guard.jobId) as { checkpoint_json: string | null } | undefined;
      if (!row) throw new Error('JOB_EXECUTION_INACTIVE');
      const checkpoint = row.checkpoint_json ? JSON.parse(row.checkpoint_json) as Record<string, unknown> : {};
      const chunks = (checkpoint.extractionChunks ?? {}) as Record<string, Record<string, ExtractionChunkCheckpoint>>;
      const byDocument = chunks[input.documentId] ?? {};
      byDocument[input.signature] = {
        consentId: input.guard.consentId, documentId: input.documentId,
        signature: input.signature, chunkIndex: input.chunkIndex,
        output: input.output, threadId: input.threadId, turnId: input.turnId,
        extractionTurnId: input.extractionTurnId
      };
      chunks[input.documentId] = byDocument;
      const updated = this.db.prepare(`UPDATE jobs SET checkpoint_json = ?, updated_at = ? WHERE id = ? AND status = 'running'`)
        .run(JSON.stringify({ ...checkpoint, extractionChunks: chunks }), this.now().toISOString(), input.guard.jobId);
      if (updated.changes !== 1) throw new Error('JOB_EXECUTION_INACTIVE');
    })();
  }

  getRuntimeTurnRecovery(guard: JobExecutionGuard, signature: string, operationKey?: string): RuntimeTurnRecovery | null {
    this.assertJobExecutionActive(guard);
    if (!/^[a-f0-9]{64}$/.test(signature)) throw new Error('RUNTIME_RECOVERY_SIGNATURE_INVALID');
    const row = this.db.prepare('SELECT checkpoint_json FROM jobs WHERE id=?').get(guard.jobId) as { checkpoint_json: string | null };
    const checkpoint = JSON.parse(row.checkpoint_json ?? '{}') as { runtimeTurns?: Record<string, {
      consentId: string; accountFingerprint: string; state: unknown; operationKey?: string;
    }> };
    const saved = checkpoint.runtimeTurns?.[signature];
    if (!saved) {
      if (operationKey && Object.values(checkpoint.runtimeTurns ?? {}).some(entry => entry.operationKey === operationKey
        && runtimeTurnRecoverySchema.parse(entry.state).phase !== 'turn_terminal')) {
        throw new Error('RUNTIME_RECOVERY_INPUT_CHANGED');
      }
      return null;
    }
    if (saved.consentId !== guard.consentId || saved.accountFingerprint !== guard.accountFingerprint) {
      throw new Error('RUNTIME_RECOVERY_SCOPE_MISMATCH');
    }
    return runtimeTurnRecoverySchema.parse(saved.state);
  }

  saveRuntimeTurnRecovery(guard: JobExecutionGuard, signature: string, state: RuntimeTurnRecovery, operationKey?: string): void {
    const checked = runtimeTurnRecoverySchema.parse(state);
    this.db.transaction(() => {
      const prior = this.getRuntimeTurnRecovery(guard, signature, operationKey);
      if (prior && (checked.threadStarts > prior.threadStarts
        && (checked.phase !== 'thread_starting' || ['turn_starting','turn_running'].includes(prior.phase)
          || prior.terminalStatus === 'completed')
        || checked.turnStarts > prior.turnStarts
        && (checked.phase !== 'turn_starting' || prior.phase !== 'thread_ready' || checked.threadId !== prior.threadId))) {
        throw new Error('RUNTIME_RECOVERY_UNSAFE_RESEND');
      }
      if (prior && (checked.threadStarts < prior.threadStarts || checked.turnStarts < prior.turnStarts
        || checked.threadStarts > prior.threadStarts + 1 || checked.turnStarts > prior.turnStarts + 1
        || checked.turnStarts === prior.turnStarts && (checked.connectionErrorCount < prior.connectionErrorCount
          || prior.turnId !== null && checked.turnId !== prior.turnId && checked.phase !== 'thread_starting'))) {
        throw new Error('RUNTIME_RECOVERY_BUDGET_RESET');
      }
      const row = this.db.prepare('SELECT checkpoint_json FROM jobs WHERE id=?').get(guard.jobId) as { checkpoint_json: string | null };
      const checkpoint = JSON.parse(row.checkpoint_json ?? '{}') as Record<string, unknown>;
      const turns = (checkpoint.runtimeTurns ?? {}) as Record<string, unknown>;
      if (!(signature in turns) && Object.keys(turns).length >= 512) throw new Error('RUNTIME_RECOVERY_LIMIT');
      const next = { ...turns, [signature]: { consentId: guard.consentId, accountFingerprint: guard.accountFingerprint,
        ...(operationKey ? { operationKey } : {}), state: checked } };
      const updated = this.db.prepare('UPDATE jobs SET checkpoint_json=?,updated_at=? WHERE id=? AND status=\'running\' AND checkpoint_json IS ?')
        .run(JSON.stringify({ ...checkpoint, runtimeTurns: next }), this.now().toISOString(), guard.jobId, row.checkpoint_json);
      if (updated.changes !== 1) throw new Error('JOB_EXECUTION_INACTIVE');
    })();
  }

  recordRuntimeRecoveryDiagnostic(guard: JobExecutionGuard, signature: string, diagnostic: RuntimeRecoveryDiagnostic): void {
    const checked = runtimeRecoveryDiagnosticSchema.parse(diagnostic);
    this.assertJobExecutionActive(guard);
    if (!/^[a-f0-9]{64}$/.test(signature)) throw new Error('RUNTIME_RECOVERY_SIGNATURE_INVALID');
    // 相同忽略原因每次尝试只记一次，其余事件计数/请求号可区分；正文不进入诊断。
    const identity = checked.kind.startsWith('connection_ignored') ? { kind: checked.kind } : checked;
    const id = `runtime-recovery:${stableHash({ signature, attemptId: guard.attemptId, identity })}`;
    this.db.prepare('INSERT OR IGNORE INTO audit_events (id,event_type,entity_id,summary,created_at) VALUES (?,?,?,?,?)')
      .run(id, 'runtime_recovery', guard.jobId, JSON.stringify({ signature, attemptId: guard.attemptId, ...checked }), this.now().toISOString());
  }

  /** 已超时的启动回执可补齐ID；不接受正文、不重发、不复活取消/撤权或较新的attempt。 */
  saveRuntimeLateStartReceipt(guard: JobExecutionGuard, signature: string, threadId: string, turnId: string): boolean {
    if (!this.isOpen() || !/^[a-f0-9]{64}$/.test(signature)) return false;
    return this.db.transaction(() => {
      const row = this.db.prepare(`SELECT j.status,j.checkpoint_json,c.account_fingerprint,c.revoked_at
        FROM jobs j JOIN consents c ON c.id=? WHERE j.id=?`).get(guard.consentId, guard.jobId) as {
          status: string; checkpoint_json: string; account_fingerprint: string; revoked_at: string | null;
        } | undefined;
      const latest = this.db.prepare(`SELECT id,error_code FROM job_attempts WHERE job_id=?
        ORDER BY started_at DESC,rowid DESC LIMIT 1`).get(guard.jobId) as { id: string; error_code: string | null } | undefined;
      if (!row || row.revoked_at || row.account_fingerprint !== guard.accountFingerprint || latest?.id !== guard.attemptId
        || !['running','failed','queued','retry_wait'].includes(row.status)
        || latest.error_code !== null && latest.error_code !== 'CODEX_RPC_TIMEOUT:turn/start') return false;
      const checkpoint = JSON.parse(row.checkpoint_json) as Record<string, unknown>;
      if (checkpoint.cancelRequested || checkpoint.consentId !== guard.consentId) return false;
      const turns = (checkpoint.runtimeTurns ?? {}) as Record<string, { consentId: string; accountFingerprint: string;
        state: RuntimeTurnRecovery; operationKey?: string }>;
      const saved = turns[signature];
      if (!saved || saved.consentId !== guard.consentId || saved.accountFingerprint !== guard.accountFingerprint) return false;
      const prior = runtimeTurnRecoverySchema.parse(saved.state);
      if (prior.phase !== 'turn_starting' || prior.threadId !== threadId || prior.turnId !== null && prior.turnId !== turnId) return false;
      const state = runtimeTurnRecoverySchema.parse({ ...prior, phase: 'turn_running', turnId });
      const updated = this.db.prepare(`UPDATE jobs SET checkpoint_json=?,updated_at=? WHERE id=? AND checkpoint_json=?`)
        .run(JSON.stringify({ ...checkpoint, runtimeTurns: { ...turns, [signature]: { ...saved, state } } }),
          this.now().toISOString(), guard.jobId, row.checkpoint_json);
      if (updated.changes !== 1) return false;
      this.db.prepare(`INSERT INTO audit_events (id,event_type,entity_id,summary,created_at) VALUES (?,?,?,?,?)`)
        .run(randomUUID(), 'runtime_recovery.late_start_receipt', guard.jobId,
          JSON.stringify({ signature, attemptId: guard.attemptId, threadId, turnId }), this.now().toISOString());
      return true;
    })();
  }

  /** 综合阶段缓存绑定同一任务、授权和完整请求摘要；正文仅留在本机任务检查点。 */
  getAssessmentTurnCheckpoint(guard: JobExecutionGuard, documentId: string, signature: string): unknown {
    this.assertJobExecutionActive(guard, documentId);
    const row = this.db.prepare('SELECT checkpoint_json FROM jobs WHERE id=?').get(guard.jobId) as { checkpoint_json: string | null };
    const checkpoint = JSON.parse(row.checkpoint_json ?? '{}') as { assessmentTurns?: Record<string, {
      consentId: string; documentId: string; output: unknown;
    }> };
    const saved = checkpoint.assessmentTurns?.[signature];
    return saved?.consentId === guard.consentId && saved.documentId === documentId ? saved.output : null;
  }

  saveAssessmentTurnCheckpoint(input: { guard: JobExecutionGuard; documentId: string; signature: string; output: unknown }): void {
    this.db.transaction(() => {
      this.assertJobExecutionActive(input.guard, input.documentId);
      const row = this.db.prepare('SELECT checkpoint_json FROM jobs WHERE id=? AND status=\'running\'')
        .get(input.guard.jobId) as { checkpoint_json: string | null } | undefined;
      if (!row) throw new Error('JOB_EXECUTION_INACTIVE');
      const checkpoint = JSON.parse(row.checkpoint_json ?? '{}') as Record<string, unknown>;
      const turns = (checkpoint.assessmentTurns ?? {}) as Record<string, unknown>;
      // 有限步骤和有限请求预算也限制本机缓存；不驱逐后再发送，避免重新打开预算。
      if (!(input.signature in turns) && Object.keys(turns).length >= 48) throw new Error('ASSESSMENT_CHECKPOINT_LIMIT');
      const next = { ...turns, [input.signature]: { consentId: input.guard.consentId,
        documentId: input.documentId, output: input.output } };
      const updated = this.db.prepare('UPDATE jobs SET checkpoint_json=?,updated_at=? WHERE id=? AND status=\'running\' AND checkpoint_json IS ?')
        .run(JSON.stringify({ ...checkpoint, assessmentTurns: next }), this.now().toISOString(), input.guard.jobId, row.checkpoint_json);
      if (updated.changes !== 1) throw new Error('JOB_EXECUTION_INACTIVE');
    })();
  }

  /** 独立于回包检查点清理；仅当前授权尝试可写固定技术回执，不能借审计存任意内容。 */
  saveAssessmentKnowledgeRetrievalDiagnostic(input: AssessmentKnowledgeRetrievalDiagnostic & {
    guard: JobExecutionGuard; documentId: string;
  }): void {
    const { guard, documentId, ...payload } = input;
    const diagnostic = assessmentKnowledgeRetrievalDiagnosticSchema.parse(payload);
    this.db.transaction(() => {
      this.assertJobExecutionActive(guard, documentId);
      const outcomeIdentity = diagnostic.outcomes.map(({ sourceKey, status, code }) => ({ sourceKey, status, code }));
      const id = `assessment-knowledge:${stableHash({ jobId: guard.jobId, attemptId: guard.attemptId,
        consentId: guard.consentId, documentId, inputSignature: diagnostic.inputSignature,
        retrievalVersion: diagnostic.retrievalVersion, outcomes: outcomeIdentity })}`;
      this.db.prepare('INSERT OR IGNORE INTO audit_events (id,event_type,entity_id,summary,created_at) VALUES (?,?,?,?,?)')
        .run(id, 'assessment_knowledge_retrieval', guard.jobId,
          JSON.stringify({ ...diagnostic, attemptId: guard.attemptId }), this.now().toISOString());
    })();
  }

  /** 综合未发布时也保留固定校验分类，避免终态清理回包后只剩笼统失败提示。 */
  saveAssessmentRejectionDiagnostic(input: AssessmentRejectionDiagnostic & { guard: JobExecutionGuard; documentId: string }): void {
    const { guard, documentId, ...payload } = input;
    const diagnostic = assessmentRejectionDiagnosticSchema.parse(payload);
    this.db.transaction(() => {
      this.assertJobExecutionActive(guard, documentId);
      const id = `assessment-rejection:${stableHash({ jobId: guard.jobId, attemptId: guard.attemptId,
        consentId: guard.consentId, documentId, inputSignature: diagnostic.inputSignature })}`;
      this.db.prepare('INSERT OR IGNORE INTO audit_events (id,event_type,entity_id,summary,created_at) VALUES (?,?,?,?,?)')
        .run(id, 'assessment_rejected', guard.jobId,
          JSON.stringify({ ...diagnostic, attemptId: guard.attemptId }), this.now().toISOString());
    })();
  }

  /** 只存原因码和计数，不能把模型正文、原页文字或本机路径写入修复诊断。 */
  saveExtractionRepairDiagnostic(input: {
    documentId: string;
    chunkIndex: number;
    triggerCodes: string[];
    targetCandidateCount: number;
    missingSourceCount: number;
    metadataTimeTargetCount: number;
    outcome: 'schema_invalid' | 'scope_violation' | 'candidate_drift' | 'applied' | 'still_failed' | 'transport_exhausted';
    remainingFailureCount: number;
    acceptedCount: number;
    guard?: JobExecutionGuard;
  }): void {
    const counters = [input.chunkIndex, input.targetCandidateCount, input.missingSourceCount,
      input.metadataTimeTargetCount, input.remainingFailureCount, input.acceptedCount];
    if (counters.some((value) => !Number.isSafeInteger(value) || value < 0 || value > 100_000)
      || input.triggerCodes.length > 256
      || input.triggerCodes.some((code) => !/^[a-zA-Z0-9_:-]{1,160}$/.test(code))
      || !['schema_invalid', 'scope_violation', 'candidate_drift', 'applied', 'still_failed', 'transport_exhausted'].includes(input.outcome)) {
      throw new Error('EXTRACTION_REPAIR_DIAGNOSTIC_INVALID');
    }
    this.db.transaction(() => {
      if (input.guard) this.assertJobExecutionActive(input.guard, input.documentId);
      if (!this.db.prepare('SELECT 1 FROM documents WHERE id=?').get(input.documentId)) throw new Error('DOCUMENT_NOT_FOUND');
      const diagnostic = { chunkIndex: input.chunkIndex, targetCandidateCount: input.targetCandidateCount,
        missingSourceCount: input.missingSourceCount, metadataTimeTargetCount: input.metadataTimeTargetCount,
        outcome: input.outcome, remainingFailureCount: input.remainingFailureCount, acceptedCount: input.acceptedCount };
      // 同类引文问题仅记录码，不重复保存片段 ID，更不保存有敏感内容的错误消息。
      const triggerCodes = [...new Set(input.triggerCodes.map((code) => code.split(':')[0]!))];
      this.db.prepare(`INSERT INTO extraction_repair_diagnostics
        (id, document_id, job_id, attempt_id, chunk_index, outcome, payload_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(randomUUID(), input.documentId,
        input.guard?.jobId ?? null, input.guard?.attemptId ?? null, input.chunkIndex, input.outcome,
        JSON.stringify({ ...diagnostic, triggerCodes }), this.now().toISOString());
    })();
  }

  listExtractionRepairDiagnostics(input: { documentId?: string; jobId?: string }): Array<{
    documentId: string; chunkIndex: number; outcome: string; diagnostic: Record<string, unknown>; createdAt: string;
  }> {
    if (!input.documentId && !input.jobId) throw new Error('EXTRACTION_REPAIR_DIAGNOSTIC_SCOPE_REQUIRED');
    const rows = this.db.prepare(`SELECT document_id, chunk_index, outcome, payload_json, created_at
      FROM extraction_repair_diagnostics WHERE (? IS NULL OR document_id=?) AND (? IS NULL OR job_id=?)
      ORDER BY created_at, rowid`).all(input.documentId ?? null, input.documentId ?? null,
      input.jobId ?? null, input.jobId ?? null) as Array<Record<string, unknown>>;
    return rows.map((row) => ({ documentId: String(row.document_id), chunkIndex: Number(row.chunk_index),
      outcome: String(row.outcome), diagnostic: JSON.parse(String(row.payload_json)) as Record<string, unknown>,
      createdAt: String(row.created_at) }));
  }

  clearExtractionChunkCheckpoints(guard: JobExecutionGuard, documentId: string): void {
    this.db.transaction(() => {
      this.assertJobExecutionActive(guard, documentId);
      const row = this.db.prepare(`SELECT checkpoint_json FROM jobs WHERE id = ? AND status = 'running'`)
        .get(guard.jobId) as { checkpoint_json: string | null } | undefined;
      if (!row?.checkpoint_json) return;
      const checkpoint = JSON.parse(row.checkpoint_json) as Record<string, unknown>;
      const chunks = (checkpoint.extractionChunks ?? {}) as Record<string, Record<string, ExtractionChunkCheckpoint>>;
      if (!chunks[documentId]) return;
      delete chunks[documentId];
      if (Object.keys(chunks).length === 0) delete checkpoint.extractionChunks;
      else checkpoint.extractionChunks = chunks;
      const updated = this.db.prepare(`UPDATE jobs SET checkpoint_json = ?, updated_at = ? WHERE id = ? AND status = 'running'`)
        .run(JSON.stringify(checkpoint), this.now().toISOString(), guard.jobId);
      if (updated.changes !== 1) throw new Error('JOB_EXECUTION_INACTIVE');
    })();
  }

  /** 取消、撤权或删除时仅清理原文缓存，保留任务进度和授权收据。 */
  private scrubExtractionChunksFromJob(jobId: string, documentId?: string): void {
    const row = this.db.prepare(`SELECT checkpoint_json FROM jobs WHERE id = ?`)
      .get(jobId) as { checkpoint_json: string | null } | undefined;
    if (!row?.checkpoint_json) return;
    const checkpoint = JSON.parse(row.checkpoint_json) as Record<string, unknown>;
    // 任一来源删除或授权变化都使整人的派生步骤失效，不保留可能带原文的综合缓存。
    const hadAssessmentTurns = checkpoint.assessmentTurns !== undefined;
    delete checkpoint.assessmentTurns;
    if (!checkpoint.extractionChunks || typeof checkpoint.extractionChunks !== 'object') {
      if (hadAssessmentTurns) this.db.prepare('UPDATE jobs SET checkpoint_json=?,updated_at=? WHERE id=?')
        .run(JSON.stringify(checkpoint), this.now().toISOString(), jobId);
      return;
    }
    if (documentId === undefined) delete checkpoint.extractionChunks;
    else {
      const chunks = checkpoint.extractionChunks as Record<string, unknown>;
      if (!(documentId in chunks) && !hadAssessmentTurns) return;
      delete chunks[documentId];
      if (Object.keys(chunks).length === 0) delete checkpoint.extractionChunks;
    }
    this.db.prepare(`UPDATE jobs SET checkpoint_json = ?, updated_at = ? WHERE id = ?`)
      .run(JSON.stringify(checkpoint), this.now().toISOString(), jobId);
  }

  assertObservationScopeActive(
    guard: JobExecutionGuard,
    personId: string,
    observations: Array<{ id: string; documentId: string }>
  ): void {
    this.assertJobExecutionActive(guard);
    const row = this.db.prepare(`
      SELECT c.scope_json,c.purpose
      FROM jobs j
      JOIN job_attempts a ON a.job_id = j.id AND a.id = ?
      JOIN consents c ON c.id = ? AND c.revoked_at IS NULL
      WHERE j.id = ? AND j.person_id = ?
    `).get(guard.attemptId, guard.consentId, guard.jobId, personId) as { scope_json: string; purpose: string } | undefined;
    if (!row) throw new Error('CONSENT_REVOKED');
    const scope = JSON.parse(row.scope_json) as {
      type?: string;
      personId?: string | null;
      personIds?: string[];
      documentIds?: string[];
      historicalObservationIds?: string[];
      includeRelevantHistory?: boolean;
      scheduledAiProcessing?: boolean;
      assessmentOnly?: boolean;
      automaticUpload?: boolean;
      includeCurrentMemberHistory?: boolean;
    };
    if (row.purpose === 'automatic_upload_processing' && scope.automaticUpload === true
      && scope.includeCurrentMemberHistory === true && scope.personIds?.length === 1 && scope.personIds[0] === personId) {
      const currentFact = this.db.prepare(`SELECT 1 FROM observations o
        JOIN observation_revisions r ON r.observation_id=o.id AND r.revision=o.current_revision
        JOIN acceptance_decisions a ON a.id=r.acceptance_id AND a.decision IN ('accept','accept_with_warnings')
        JOIN source_spans ss ON ss.id=r.source_span_id
        JOIN documents d ON d.id=ss.document_id AND d.person_id=o.person_id AND d.excluded_from_analysis=0
        JOIN source_objects so ON so.id=d.source_object_id
        JOIN source_manifests sm ON sm.document_id=d.id AND sm.source_object_id=so.id AND sm.sha256=so.sha256
        JOIN document_commits dc ON dc.document_id=d.id
        JOIN persons p ON p.id=d.person_id AND p.archived_at IS NULL
        WHERE o.id=? AND o.person_id=? AND d.id=?
          AND NOT EXISTS(SELECT 1 FROM review_issues ri WHERE ri.field_ref='document:'||d.id AND ri.resolution_status='open'
            AND (ri.kind='person_conflict' OR ri.kind='overwrite_protected' AND ri.severity='blocking'))`);
      if (!observations.every((item) => Boolean(currentFact.get(item.id, personId, item.documentId)))) {
        throw new Error('HISTORICAL_FACTS_OUTSIDE_CONSENT_SCOPE');
      }
      return;
    }
    const allowed = scope.type === 'inbox_binding'
      ? scope.scheduledAiProcessing === true && scope.includeRelevantHistory === true && scope.personId === personId
      : scope.type === 'manual_batch'
        && scope.includeRelevantHistory === true
        && scope.personIds?.includes(personId)
        && observations.every((observation) => (
          scope.assessmentOnly !== true && scope.documentIds?.includes(observation.documentId)
          || scope.historicalObservationIds?.includes(observation.id)
        ));
    if (!allowed) throw new Error('HISTORICAL_FACTS_OUTSIDE_CONSENT_SCOPE');
  }

  beginAiTransmission(input: { guard: JobExecutionGuard; documentId: string; stage: string }): string {
    this.assertJobExecutionActive(input.guard, input.documentId);
    if (this.isAssessmentOnlyJob(input.guard.jobId)
      && !['prepare_clinical_context', 'member_assessment', 'assessment_repair', 'focused_review'].includes(input.stage)) {
      throw new Error('ASSESSMENT_ONLY_STAGE_OUTSIDE_SCOPE');
    }
    const id = randomUUID();
    this.db.prepare(`
      INSERT INTO ai_transmissions (id, job_id, attempt_id, consent_id, document_id, stage, status, started_at, finished_at)
      VALUES (?, ?, ?, ?, ?, ?, 'sending', ?, NULL)
    `).run(id, input.guard.jobId, input.guard.attemptId, input.guard.consentId, input.documentId, input.stage, this.now().toISOString());
    return id;
  }

  finishAiTransmission(id: string, status: 'acknowledged' | 'completed' | 'unknown'): void {
    const result = this.db.prepare(`
      UPDATE ai_transmissions SET status = ?, finished_at = ? WHERE id = ? AND status = 'sending'
    `).run(status, this.now().toISOString(), id);
    if (result.changes !== 1) throw new Error('AI_TRANSMISSION_NOT_OPEN');
  }

  /** 普通原件直读也保存实际返回回执；checkpoint 文字本身不能授予来源修订能力。 */
  finishDirectOriginalTransmission(input: { guard: JobExecutionGuard; documentId: string; transmissionId: string;
    inputSignature: string; outputHash: string; threadId: string; turnId: string;
    proofVersion: typeof DIRECT_ORIGINAL_SOURCE_REFINEMENT_VERSION }): void {
    this.db.transaction(() => {
      this.assertJobExecutionActive(input.guard, input.documentId);
      if (input.proofVersion !== DIRECT_ORIGINAL_SOURCE_REFINEMENT_VERSION
        || !/^[a-f0-9]{64}$/.test(input.inputSignature) || !/^[a-f0-9]{64}$/.test(input.outputHash)
        || !input.threadId.trim() || !input.turnId.trim()) throw new Error('DIRECT_ORIGINAL_TRANSMISSION_RECEIPT_INVALID');
      const row = this.db.prepare(`SELECT t.stage,a.model,a.reasoning_effort FROM ai_transmissions t
        JOIN job_attempts a ON a.id=t.attempt_id AND a.job_id=t.job_id WHERE t.id=? AND t.job_id=? AND t.attempt_id=?
        AND t.consent_id=? AND t.document_id=? AND t.status='sending'`).get(input.transmissionId, input.guard.jobId,
        input.guard.attemptId, input.guard.consentId, input.documentId) as { stage: string; model: string; reasoning_effort: string } | undefined;
      if (!row || !['extract', 'repair_extraction'].includes(row.stage) || row.model !== 'gpt-6.1-sol'
        || row.reasoning_effort !== 'medium') throw new Error('DIRECT_ORIGINAL_TRANSMISSION_RECEIPT_INVALID');
      this.db.prepare(`INSERT INTO ai_transmission_receipts
        (transmission_id,proof_version,input_signature,thread_id,turn_id,output_hash,created_at) VALUES (?,?,?,?,?,?,?)`)
        .run(input.transmissionId, input.proofVersion, input.inputSignature,
          input.threadId, input.turnId, input.outputHash, this.now().toISOString());
      this.finishAiTransmission(input.transmissionId, 'completed');
    })();
  }

  /** 原件日期盲读的实际返回凭据与传输完成原子保存，不把checkpoint自述当作真实模型回执。 */
  finishDateCorrectionTransmission(input: { guard: JobExecutionGuard; documentId: string; transmissionId: string;
    inputSignature: string; outputHash: string; threadId: string; turnId: string }): void {
    this.db.transaction(() => {
      this.assertJobExecutionActive(input.guard, input.documentId);
      if (!this.isDateCorrectionJob(input.guard.jobId) || !/^[a-f0-9]{64}$/.test(input.inputSignature)
        || !/^[a-f0-9]{64}$/.test(input.outputHash) || !input.threadId.trim() || !input.turnId.trim()) {
        throw new Error('DATE_CORRECTION_TRANSMISSION_RECEIPT_INVALID');
      }
      const row = this.db.prepare(`SELECT t.stage,a.model,a.reasoning_effort FROM ai_transmissions t
        JOIN job_attempts a ON a.id=t.attempt_id AND a.job_id=t.job_id WHERE t.id=? AND t.job_id=? AND t.attempt_id=?
        AND t.consent_id=? AND t.document_id=? AND t.status='sending'`).get(input.transmissionId, input.guard.jobId,
        input.guard.attemptId, input.guard.consentId, input.documentId) as { stage: string; model: string; reasoning_effort: string } | undefined;
      if (!row || !['extract', 'repair_extraction'].includes(row.stage) || row.model !== 'gpt-6.1-sol' || row.reasoning_effort !== 'medium') {
        throw new Error('DATE_CORRECTION_TRANSMISSION_RECEIPT_INVALID');
      }
      this.db.prepare(`INSERT INTO ai_transmission_receipts
        (transmission_id,proof_version,input_signature,thread_id,turn_id,output_hash,created_at) VALUES (?,?,?,?,?,?,?)`)
        .run(input.transmissionId, DIRECT_ORIGINAL_DATE_READING_VERSION, input.inputSignature,
          input.threadId, input.turnId, input.outputHash, this.now().toISOString());
      this.finishAiTransmission(input.transmissionId, 'completed');
    })();
  }

  getDocumentAiTransmissionStatus(documentId: string): 'not_sent' | 'sending' | 'acknowledged' | 'completed' | 'unknown' {
    const row = this.db.prepare(`
      SELECT status FROM ai_transmissions WHERE document_id = ? ORDER BY started_at DESC, id DESC LIMIT 1
    `).get(documentId) as { status: 'sending' | 'acknowledged' | 'completed' | 'unknown' } | undefined;
    return row?.status ?? 'not_sent';
  }

  listDocumentAiTransmissionStatuses(documentIds: string[]): Map<string, 'not_sent' | 'sending' | 'acknowledged' | 'completed' | 'unknown'> {
    const statuses = new Map<string, 'not_sent' | 'sending' | 'acknowledged' | 'completed' | 'unknown'>(
      documentIds.map((documentId) => [documentId, 'not_sent'])
    );
    if (documentIds.length === 0) return statuses;
    const rows = this.db.prepare(`
      SELECT t.document_id, t.status
      FROM ai_transmissions t
      JOIN (
        SELECT document_id, MAX(started_at || id) AS latest
        FROM ai_transmissions
        WHERE document_id IN (${documentIds.map(() => '?').join(',')})
        GROUP BY document_id
      ) latest ON latest.document_id = t.document_id AND latest.latest = t.started_at || t.id
    `).all(...documentIds) as Array<{ document_id: string; status: 'sending' | 'acknowledged' | 'completed' | 'unknown' }>;
    for (const row of rows) statuses.set(row.document_id, row.status);
    return statuses;
  }

  isDocumentCommitted(documentId: string): boolean {
    return Boolean(this.db.prepare(`SELECT 1 FROM document_commits WHERE document_id = ?`).get(documentId));
  }

  isDocumentExcluded(documentId: string): boolean {
    const row = this.db.prepare(`SELECT excluded_from_analysis FROM documents WHERE id = ?`).get(documentId) as { excluded_from_analysis: number } | undefined;
    if (!row) throw new Error('DOCUMENT_NOT_FOUND');
    return row.excluded_from_analysis === 1;
  }

  hasOpenBlockingReview(documentId: string): boolean {
    return Boolean(this.db.prepare(`
      SELECT 1 FROM review_issues
      WHERE field_ref = 'document:' || ?
        AND resolution_status = 'open'
        AND severity = 'blocking'
      LIMIT 1
    `).get(documentId));
  }

  retryFailedJob(jobId: string): void {
    this.db.transaction(() => {
      const row = this.db.prepare(`SELECT checkpoint_json FROM jobs WHERE id=?
        AND status IN ('failed','completed_with_issues','waiting_quota')`).get(jobId) as { checkpoint_json: string | null } | undefined;
      if (!row) throw new Error('JOB_NOT_RETRYABLE');
      const checkpoint = row.checkpoint_json ? JSON.parse(row.checkpoint_json) as Record<string, unknown> : {};
      // 只有用户明确点重试才重新给出有限预算；完成记录和阶段缓存原样保留。
      delete checkpoint.modelBusyRetry;
      delete checkpoint.assessmentOutcome;
      const partialRetryStage = this.isAssessmentOnlyJob(jobId) ? 'analyze' : 'system_analysis';
      const result = this.db.prepare(`
      UPDATE jobs
      SET status = 'queued',
          stage = CASE WHEN status = 'completed_with_issues' THEN ? ELSE stage END,
          lease_owner = NULL,
          lease_expires_at = NULL,
          checkpoint_json = ?,
          updated_at = ?
      WHERE id = ? AND status IN ('failed', 'completed_with_issues', 'waiting_quota')
      `).run(partialRetryStage, JSON.stringify(checkpoint), this.now().toISOString(), jobId);
      if (result.changes !== 1) throw new Error('JOB_NOT_RETRYABLE');
    })();
  }

  isQueuePaused(): boolean {
    const row = this.db.prepare(`SELECT queue_paused FROM workspaces LIMIT 1`).get() as { queue_paused: number } | undefined;
    return Number(row?.queue_paused ?? 0) === 1;
  }

  setQueuePaused(paused: boolean): void {
    const result = this.db.prepare(`
      UPDATE workspaces
      SET queue_paused = ?, settings_revision = settings_revision + 1
    `).run(paused ? 1 : 0);
    if (result.changes !== 1) throw new Error('WORKSPACE_NOT_FOUND');
  }

  recoverInterruptedJobs(): number {
    const transaction = this.db.transaction(() => {
      const timestamp = this.now().toISOString();
      const automaticJobs = this.db.prepare(`SELECT j.id,j.person_id,j.checkpoint_json,c.scope_json
        FROM jobs j JOIN consents c ON c.id=CASE WHEN json_valid(j.checkpoint_json)
          THEN json_extract(j.checkpoint_json,'$.consentId') END
        WHERE j.status='running' AND c.purpose='automatic_upload_processing' AND c.revoked_at IS NULL`)
        .all() as Array<{ id: string; person_id: string; checkpoint_json: string; scope_json: string }>;
      this.db.prepare(`
        UPDATE job_attempts
        SET status = 'failed', error_code = 'APP_RESTART_INTERRUPTED', finished_at = ?
        WHERE status = 'running'
      `).run(timestamp);
      const result = this.db.prepare(`
        UPDATE jobs
        SET status = 'failed', lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
        WHERE status = 'running'
      `).run(timestamp);
      for (const row of automaticJobs) {
        try {
          const checkpoint = JSON.parse(row.checkpoint_json) as { documentIds?: unknown; cancelRequested?: boolean };
          const scope = JSON.parse(row.scope_json) as Record<string, unknown>;
          if (checkpoint.cancelRequested || !Array.isArray(checkpoint.documentIds)
            || !checkpoint.documentIds.every((id) => typeof id === 'string')
            || !this.automaticUploadScopeIsCurrent(scope, row.person_id, checkpoint.documentIds as string[])) continue;
          this.db.prepare(`UPDATE jobs SET status='queued',updated_at=? WHERE id=? AND status='failed'`)
            .run(timestamp, row.id);
        } catch { continue; }
      }
      return result.changes;
    });
    return transaction();
  }

  updateJobProgress(jobId: string, completedUnits: number): void {
    const row = this.db.prepare(`SELECT checkpoint_json FROM jobs WHERE id = ?`).get(jobId) as { checkpoint_json: string | null } | undefined;
    if (!row) throw new Error('JOB_NOT_FOUND');
    const checkpoint = row.checkpoint_json ? JSON.parse(row.checkpoint_json) as Record<string, unknown> : {};
    this.db.prepare(`UPDATE jobs SET checkpoint_json = ?, updated_at = ? WHERE id = ?`).run(
      JSON.stringify({ ...checkpoint, completedUnits }), this.now().toISOString(), jobId
    );
  }

  /** 读取任务归属只取明确读取阶段、重核范围或本任务真实读取传输，综合用旧事实不算重新读取。 */
  getJobReadingDocumentIds(jobId: string): Set<string> {
    const row = this.db.prepare(`SELECT stage,checkpoint_json FROM jobs WHERE id=?`).get(jobId) as
      { stage: string; checkpoint_json: string | null } | undefined;
    if (!row) throw new Error('JOB_NOT_FOUND');
    const checkpoint = row.checkpoint_json ? JSON.parse(row.checkpoint_json) as {
      documentIds?: unknown; repairDocumentIds?: unknown;
    } : {};
    const scope = new Set(Array.isArray(checkpoint.documentIds)
      ? checkpoint.documentIds.filter((id): id is string => typeof id === 'string') : []);
    if (row.stage === 'extract' || row.stage === 'review_facts') return scope;
    const result = new Set(Array.isArray(checkpoint.repairDocumentIds)
      ? checkpoint.repairDocumentIds.filter((id): id is string => typeof id === 'string' && scope.has(id)) : []);
    const completed = this.db.prepare(`SELECT DISTINCT document_id FROM ai_transmissions WHERE job_id=?
      AND stage IN ('extract','review_facts','repair_extraction') AND status='completed' AND finished_at IS NOT NULL`)
      .all(jobId) as { document_id: string }[];
    for (const { document_id: documentId } of completed) if (scope.has(documentId)) result.add(documentId);
    return result;
  }

  /** 显式重核意图来自持久任务范围；没有警告并不取消用户选择。此方法不替代执行授权检查。 */
  getJobRepairDocumentIds(jobId: string): Set<string> {
    const row = this.db.prepare('SELECT checkpoint_json FROM jobs WHERE id=?').get(jobId) as { checkpoint_json: string | null } | undefined;
    if (!row) throw new Error('JOB_NOT_FOUND');
    const checkpoint = JSON.parse(row.checkpoint_json ?? '{}') as { documentIds?: string[]; repairDocumentIds?: string[] };
    return new Set((checkpoint.repairDocumentIds ?? []).filter(id => checkpoint.documentIds?.includes(id)));
  }

  private hasJobCompletedReading(jobId: string, documentId: string): boolean {
    return Boolean(this.db.prepare(`SELECT 1 FROM ai_transmissions WHERE job_id=? AND document_id=?
      AND stage IN ('extract','review_facts') AND status='completed' AND finished_at IS NOT NULL LIMIT 1`).get(jobId, documentId));
  }

  /** 已处理范围只取逐份完成收据；兼容旧修复任务时必须有本任务的传输和新发布证据。 */
  getJobProcessedDocumentIds(jobId: string): Set<string> {
    const row = this.db.prepare(`SELECT person_id, stage, created_at, checkpoint_json FROM jobs WHERE id=?`)
      .get(jobId) as { person_id: string; stage: string; created_at: string; checkpoint_json: string | null } | undefined;
    if (!row) throw new Error('JOB_NOT_FOUND');
    const checkpoint = row.checkpoint_json ? JSON.parse(row.checkpoint_json) as {
      documentIds?: unknown; processedDocumentIds?: unknown; completedUnits?: unknown;
      repairDocumentIds?: unknown; extractionChunks?: Record<string, unknown>;
      documentOutcomes?: Record<string, { outcome?: string }>;
    } : {};
    const scoped = Array.isArray(checkpoint.documentIds)
      ? checkpoint.documentIds.filter((value): value is string => typeof value === 'string') : [];
    const result = new Set(Array.isArray(checkpoint.processedDocumentIds)
      ? checkpoint.processedDocumentIds.filter((value): value is string => typeof value === 'string' && scoped.includes(value)) : []);
    // 旧版曾把无警告的显式重核标成 published 却未读取。只在失败提取续跑时重新核实，
    // 已进入综合的任务不因此隐式扩大读取；真实完成或局部保留的报告继续复用。
    if (row.stage === 'extract' && Array.isArray(checkpoint.repairDocumentIds)) {
      for (const documentId of result) {
        if (checkpoint.repairDocumentIds.includes(documentId)
          && checkpoint.documentOutcomes?.[documentId]?.outcome === 'published'
          && !this.hasJobCompletedReading(jobId, documentId)) result.delete(documentId);
      }
    }
    if (row.stage !== 'extract' || !Array.isArray(checkpoint.repairDocumentIds)
      || !Number.isInteger(checkpoint.completedUnits) || Number(checkpoint.completedUnits) < 1) return result;
    const finished = this.db.prepare(`SELECT MAX(finished_at) AS finished_at FROM job_attempts WHERE job_id=?`)
      .get(jobId) as { finished_at: string | null };
    if (!finished.finished_at) return result;
    const proof = this.db.prepare(`SELECT 1 FROM documents d
      JOIN document_commits dc ON dc.document_id=d.id
      WHERE d.id=? AND d.person_id=? AND d.status='completed' AND d.excluded_from_analysis=0
        AND EXISTS(SELECT 1 FROM ai_transmissions t WHERE t.job_id=? AND t.document_id=d.id
          AND t.stage IN ('extract','review_facts') AND t.status='completed' AND t.finished_at IS NOT NULL)
        AND EXISTS(SELECT 1 FROM observations o JOIN observation_revisions r ON r.observation_id=o.id
          JOIN source_spans ss ON ss.id=r.source_span_id
          WHERE o.person_id=d.person_id AND ss.document_id=d.id AND r.created_at>=? AND r.created_at<=?
            AND EXISTS(SELECT 1 FROM publication_events p WHERE p.person_id=o.person_id
              AND p.committed_at>=r.created_at AND p.committed_at<=?)) LIMIT 1`);
    for (const documentId of scoped.slice(0, Math.min(Number(checkpoint.completedUnits), scoped.length))) {
      if (!checkpoint.repairDocumentIds.includes(documentId) || checkpoint.extractionChunks?.[documentId]) continue;
      if (proof.get(documentId, row.person_id, jobId, row.created_at, finished.finished_at, finished.finished_at)) {
        result.add(documentId);
      }
    }
    return result;
  }

  /** 内容终态逐份落收据；授权、任务存活和范围仍由当前执行 guard 检查。 */
  markJobDocumentProcessed(
    jobId: string, documentId: string, outcome: 'published' | 'partial' | 'needs_review' | 'excluded', guard: JobExecutionGuard
  ): void {
    this.db.transaction(() => {
      if (guard.jobId !== jobId) throw new Error('JOB_EXECUTION_INACTIVE');
      this.assertJobExecutionActive(guard, documentId);
      if (outcome === 'published' && this.getJobRepairDocumentIds(jobId).has(documentId)
        && !this.hasJobCompletedReading(jobId, documentId)) throw new Error('REPAIR_PUBLICATION_READING_RECEIPT_REQUIRED');
      const row = this.db.prepare(`SELECT checkpoint_json FROM jobs WHERE id=? AND status='running'`)
        .get(jobId) as { checkpoint_json: string | null };
      const checkpoint = row.checkpoint_json ? JSON.parse(row.checkpoint_json) as Record<string, unknown> : {};
      const processed = this.getJobProcessedDocumentIds(jobId);
      processed.add(documentId);
      const previous = typeof checkpoint.documentOutcomes === 'object' && checkpoint.documentOutcomes !== null
        ? checkpoint.documentOutcomes as Record<string, unknown> : {};
      const updated = this.db.prepare(`UPDATE jobs SET checkpoint_json=?,updated_at=?
        WHERE id=? AND status='running' AND checkpoint_json IS ?`).run(JSON.stringify({ ...checkpoint,
          processedDocumentIds: [...processed], completedUnits: processed.size,
          documentOutcomes: { ...previous, [documentId]: { outcome, updatedAt: this.now().toISOString() } }
        }), this.now().toISOString(), jobId, row.checkpoint_json);
      if (updated.changes !== 1) throw new Error('JOB_EXECUTION_INACTIVE');
    })();
  }

  updateJobSystemOutcome(jobId: string, outcome: {
    systemId: string;
    status: 'published' | 'rejected' | 'skipped_no_data' | 'skipped_cache' | 'out_of_scope';
    reason: string | null;
    inputSignature: string | null;
  }): void {
    const row = this.db.prepare(`SELECT checkpoint_json FROM jobs WHERE id = ? AND status = 'running'`).get(jobId) as { checkpoint_json: string | null } | undefined;
    if (!row) throw new Error('JOB_NOT_RUNNING');
    const checkpoint = row.checkpoint_json ? JSON.parse(row.checkpoint_json) as Record<string, unknown> : {};
    const current = Array.isArray(checkpoint.systemOutcomes)
      ? checkpoint.systemOutcomes as Array<Record<string, unknown>>
      : [];
    const next = [
      ...current.filter((item) => item.systemId !== outcome.systemId),
      { ...outcome, updatedAt: this.now().toISOString() }
    ];
    this.db.prepare(`UPDATE jobs SET checkpoint_json = ?, updated_at = ? WHERE id = ? AND status = 'running'`).run(
      JSON.stringify({ ...checkpoint, systemOutcomes: next }), this.now().toISOString(), jobId
    );
  }

  /** 当前尝试独立保存综合终态；已发布或复用必须绑定真正存在且仍有效的成员快照。 */
  updateJobAssessmentOutcome(
    guard: JobExecutionGuard,
    input: Omit<JobAssessmentOutcome, 'attemptId' | 'updatedAt'>
  ): JobAssessmentOutcome {
    return this.db.transaction(() => {
      this.assertJobExecutionActive(guard);
      const row = this.db.prepare(`SELECT person_id, checkpoint_json FROM jobs WHERE id=? AND status='running'
        AND (SELECT id FROM job_attempts WHERE job_id=jobs.id ORDER BY started_at DESC,rowid DESC LIMIT 1)=?`)
        .get(guard.jobId, guard.attemptId) as { person_id: string; checkpoint_json: string | null } | undefined;
      if (!row) throw new Error('JOB_EXECUTION_INACTIVE');
      const outcome = jobAssessmentOutcomeSchema.parse({ ...input,
        attemptId: guard.attemptId, updatedAt: this.now().toISOString() });
      if (outcome.factRevision !== this.getFactRevision(row.person_id)
        || outcome.contextRevision !== this.getClinicalContextRevision(row.person_id)
        || outcome.reviewScopeSignature !== this.getOpenReviewScopeSignature(row.person_id)) {
        throw new Error('JOB_ASSESSMENT_INPUT_REVISION_MISMATCH');
      }
      if (outcome.status === 'published' || outcome.status === 'reused_current') {
        if (!this.jobAssessmentSnapshotMatches(row.person_id, outcome, true)) {
          throw new Error('JOB_ASSESSMENT_SNAPSHOT_MISMATCH');
        }
      } else if (outcome.status === 'skipped_no_data') {
        const identityConflicts = new Set(this.listOpenExtractionReviewIssues()
          .filter((issue) => issue.kind === 'person_conflict').map((issue) => issue.documentId));
        const usableFacts = this.listAcceptedObservations(row.person_id).some((observation) => (
          observation.valueKind !== 'unknown' && observation.rawText.trim().length > 0
          && !identityConflicts.has(observation.documentId)
        ));
        if (usableFacts || this.listManualNotes(row.person_id).length > 0) throw new Error('JOB_ASSESSMENT_DATA_PRESENT');
      }
      const checkpoint = row.checkpoint_json ? JSON.parse(row.checkpoint_json) as Record<string, unknown> : {};
      const updated = this.db.prepare(`UPDATE jobs SET checkpoint_json=?,updated_at=?
        WHERE id=? AND status='running' AND checkpoint_json IS ?`)
        .run(JSON.stringify({ ...checkpoint, assessmentOutcome: outcome }), outcome.updatedAt, guard.jobId, row.checkpoint_json);
      if (updated.changes !== 1) throw new Error('JOB_EXECUTION_INACTIVE');
      return outcome;
    })();
  }

  private jobAssessmentSnapshotMatches(personId: string, outcome: JobAssessmentOutcome, currentOnly: boolean): boolean {
    const row = this.db.prepare(`SELECT id,person_id,input_signature,fact_revision,context_revision,payload_json,status,created_at
      FROM member_assessment_snapshots_v3 WHERE id=?`).get(outcome.snapshotId) as {
      id: string; person_id: string; input_signature: string; fact_revision: number; context_revision: number;
      payload_json: string; status: string; created_at: string;
    } | undefined;
    if (!row || row.person_id !== personId || row.input_signature !== outcome.inputSignature
      || row.fact_revision !== outcome.factRevision || row.context_revision !== outcome.contextRevision
      || (currentOnly && row.status !== 'current')) return false;
    try {
      const parsed = memberAssessmentSnapshotV3Schema.safeParse({ ...JSON.parse(row.payload_json),
        id: row.id, status: row.status, generatedAt: row.created_at });
      return parsed.success && parsed.data.personId === personId && parsed.data.inputSignature === outcome.inputSignature
        && parsed.data.factRevision === outcome.factRevision && parsed.data.contextRevision === outcome.contextRevision
        && parsed.data.reviewScopeSignature === outcome.reviewScopeSignature;
    } catch { return false; }
  }

  /** 读取与过期清理共用同一次完成凭据；不能因只剩 checkpoint 就相信已发布。 */
  private validatedJobAssessmentOutcome(input: {
    personId: string; status: string; value: unknown;
    latestAttemptId: unknown; latestAttemptStatus: unknown;
    latestAttemptStartedAt: unknown; latestAttemptFinishedAt: unknown;
  }): JobAssessmentOutcome | null {
    const parsed = jobAssessmentOutcomeSchema.safeParse(input.value);
    if (!parsed.success) return null;
    const outcome = parsed.data;
    if (!['succeeded', 'completed_with_issues', 'waiting_user'].includes(input.status)
      || input.latestAttemptId !== outcome.attemptId || input.latestAttemptStatus !== input.status
      || typeof input.latestAttemptStartedAt !== 'string' || typeof input.latestAttemptFinishedAt !== 'string') return null;
    const startedAt = Date.parse(input.latestAttemptStartedAt);
    const finishedAt = Date.parse(input.latestAttemptFinishedAt);
    const updatedAt = Date.parse(outcome.updatedAt);
    if (!Number.isFinite(startedAt) || !Number.isFinite(finishedAt) || startedAt > updatedAt || updatedAt > finishedAt) return null;
    return (outcome.status === 'published' || outcome.status === 'reused_current')
      && !this.jobAssessmentSnapshotMatches(input.personId, outcome, false) ? null : outcome;
  }

  updateJobStage(jobId: string, stage: StoredJobSummary['stage']): void {
    if (this.isAssessmentOnlyJob(jobId) && !['analyze', 'review_derived', 'publish'].includes(stage)) {
      throw new Error('ASSESSMENT_ONLY_STAGE_OUTSIDE_SCOPE');
    }
    const result = this.db.prepare(`
      UPDATE jobs SET stage = ?, updated_at = ? WHERE id = ? AND status = 'running'
    `).run(stage, this.now().toISOString(), jobId);
    if (result.changes !== 1) throw new Error('JOB_NOT_RUNNING');
  }

  finishJob(jobId: string, status: 'succeeded' | 'completed_with_issues' | 'failed' | 'waiting_auth' | 'waiting_quota' | 'waiting_user' | 'retry_wait' | 'cancelled'): void {
    this.db.transaction(() => {
      if (['failed', 'waiting_auth', 'waiting_quota', 'retry_wait', 'cancelled'].includes(status)) {
        this.db.prepare(`UPDATE jobs SET checkpoint_json=json_remove(checkpoint_json,'$.assessmentOutcome')
          WHERE id=? AND status='running' AND json_valid(checkpoint_json)`).run(jobId);
      }
      const result = this.db.prepare(`
        UPDATE jobs SET status = ?, lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
        WHERE id = ? AND status = 'running'
      `).run(status, this.now().toISOString(), jobId);
      if (result.changes !== 1) throw new Error('JOB_NOT_RUNNING');
      if (status === 'succeeded' || status === 'completed_with_issues' || status === 'cancelled') {
        this.scrubExtractionChunksFromJob(jobId);
      }
    })();
  }

  startJobAttempt(jobId: string, runtimeVersion: string | null, model: string | null = null, reasoningEffort: string | null = null): string {
    const id = randomUUID();
    // 新尝试不能展示上一轮发布/拒绝；逐份完成收据不受影响。
    this.db.prepare(`UPDATE jobs SET checkpoint_json=json_remove(checkpoint_json,'$.assessmentOutcome')
      WHERE id=? AND status='running' AND json_valid(checkpoint_json)`).run(jobId);
    this.db.prepare(`
      INSERT INTO job_attempts (
        id, job_id, runtime_version, model, reasoning_effort, thread_id, turn_id, status,
        error_code, usage_json, started_at, finished_at
      ) VALUES (?, ?, ?, ?, ?, NULL, NULL, 'running', NULL, NULL, ?, NULL)
    `).run(id, jobId, runtimeVersion, model, reasoningEffort, this.now().toISOString());
    return id;
  }

  /** 任务和尝试一起落盘；到期续领仍必须重新过授权、暂停、归属和取消门禁。 */
  finishModelBusyAttempt(input: {
    guard: JobExecutionGuard;
    analysisAiPreferences: AiPreferences;
    /** 仅结构化短期限流且刷新后额度可用时由执行器传入；与繁忙共用原有限预算。 */
    reasonCode?: 'CODEX_MODEL_BUSY' | 'CODEX_RATE_LIMITED';
    threadId?: string;
    turnId?: string;
    usage?: Parameters<WorkspaceStore['finishJobAttempt']>[0]['usage'];
  }): { status: 'retry_wait' | 'failed'; retryCount: number; nextRetryAt: string | null } {
    return this.db.transaction(() => {
      this.assertJobExecutionActive(input.guard);
      const row = this.db.prepare(`SELECT checkpoint_json FROM jobs WHERE id=? AND status='running'`)
        .get(input.guard.jobId) as { checkpoint_json: string | null };
      const checkpoint = row.checkpoint_json ? JSON.parse(row.checkpoint_json) as Record<string, unknown> : {};
      const previous = parseModelBusyRetryState(checkpoint.modelBusyRetry);
      // 非法预算绝不重置成首次尝试，以免重启或损坏记录无限调用。
      const used = checkpoint.modelBusyRetry !== undefined && !previous ? modelBusyRetryDelaysMs.length : previous?.retryCount ?? 0;
      const delay = modelBusyRetryDelaysMs[used];
      const status: 'failed' | 'retry_wait' = delay === undefined ? 'failed' : 'retry_wait';
      const nextRetryAt = delay === undefined ? null : new Date(this.now().getTime() + delay).toISOString();
      const retryCount = delay === undefined ? used : used + 1;
      const preferences = aiPreferencesSchema.parse(previous?.analysisAiPreferences ?? input.analysisAiPreferences);
      this.db.prepare(`UPDATE jobs SET checkpoint_json=?,updated_at=? WHERE id=? AND status='running'`)
        .run(JSON.stringify({ ...checkpoint, modelBusyRetry: { retryCount, nextRetryAt, analysisAiPreferences: preferences } }),
          this.now().toISOString(), input.guard.jobId);
      this.finishJobAttempt({ attemptId: input.guard.attemptId, status, errorCode: input.reasonCode ?? 'CODEX_MODEL_BUSY',
        threadId: input.threadId ?? null, turnId: input.turnId ?? null,
        ...(input.usage ? { usage: input.usage } : {}) });
      this.finishJob(input.guard.jobId, status);
      return { status, retryCount, nextRetryAt };
    })();
  }

  finishJobAttempt(input: {
    attemptId: string;
    status: 'succeeded' | 'completed_with_issues' | 'failed' | 'waiting_auth' | 'waiting_quota' | 'waiting_user' | 'retry_wait' | 'cancelled';
    errorCode?: string | null;
    threadId?: string | null;
    turnId?: string | null;
    usage?: {
      attemptedTurnRequests: Record<'P01' | 'P02' | 'P03' | 'P04' | 'other', number>;
      completedTurnResponses: Record<'P01' | 'P02' | 'P03' | 'P04' | 'other', number>;
      failedTurnRequests: Record<'P01' | 'P02' | 'P03' | 'P04' | 'other', number>;
      timedOutTurnRequests: Record<'P01' | 'P02' | 'P03' | 'P04' | 'other', number>;
      completedTurnDurationMs: Record<'P01' | 'P02' | 'P03' | 'P04' | 'other', number>;
      observedTurnMetrics: number;
      observedTokenUsage: number;
      webToolActions: { searches: number; pageOpens: number; pageFinds: number; other: number };
      inputTokens: number | null;
      outputTokens: number | null;
      cachedInputTokens: number | null;
      firstUsableFactMs: number | null;
      attemptDurationMs: number;
      safeRuntimeFailure?: {
        code: string; safeReason: string; modelId: string; reasoningEffort: string;
        serviceCode?: string; httpStatus?: number;
      } | null;
      memberAssessmentOutcome?: JobAssessmentOutcome | null;
    };
  }): void {
    const result = this.db.prepare(`
      UPDATE job_attempts
      SET status = ?, error_code = ?, thread_id = ?, turn_id = ?, usage_json = ?, finished_at = ?
      WHERE id = ? AND status = 'running'
    `).run(
      input.status, input.errorCode ?? null, input.threadId ?? null,
      input.turnId ?? null, input.usage ? JSON.stringify(input.usage) : null,
      this.now().toISOString(), input.attemptId
    );
    if (result.changes !== 1) throw new Error('JOB_ATTEMPT_NOT_RUNNING');
  }

  listStoredJobs(): StoredJobSummary[] {
    const rows = this.db.prepare(`
      SELECT j.id, j.person_id, j.stage, j.status, j.checkpoint_json, j.updated_at,
             b.created_at AS batch_created_at, p.display_name AS person_label,
             CASE WHEN json_valid(j.checkpoint_json) THEN (SELECT c.purpose FROM consents c
               WHERE c.id=json_extract(j.checkpoint_json,'$.consentId')) END AS consent_purpose,
             latest.id AS latest_attempt_id, latest.status AS latest_attempt_status,
             latest.started_at AS latest_attempt_started_at,
             latest.finished_at AS latest_attempt_finished_at,
             (
               SELECT ja.error_code
               FROM job_attempts ja
               WHERE ja.job_id = j.id
               ORDER BY ja.started_at DESC, ja.rowid DESC
               LIMIT 1
             ) AS latest_error_code
      FROM jobs j
      LEFT JOIN job_attempts latest ON latest.id=(SELECT ja.id FROM job_attempts ja WHERE ja.job_id=j.id
        ORDER BY ja.started_at DESC,ja.rowid DESC LIMIT 1)
      LEFT JOIN batches b ON b.id = j.batch_id
      LEFT JOIN persons p ON p.id = j.person_id
      ORDER BY j.created_at DESC, j.rowid DESC
    `).all() as Array<Record<string, unknown>>;
    return rows.map((row) => {
      const checkpoint = row.checkpoint_json ? JSON.parse(String(row.checkpoint_json)) as {
        documentIds?: string[];
        completedUnits?: number;
        cancelRequested?: boolean;
        systemOutcomes?: StoredJobSummary['systemOutcomes'];
        assessmentOutcome?: unknown;
        modelBusyRetry?: unknown;
        automaticUploadStop?: unknown;
      } : {};
      const status = String(row.status) as StoredJobSummary['status'];
      // 历史发布只证明该次任务的结果，不保证仍为当前最新；读取仍核对快照归属和原始输入绑定。
      const assessmentOutcome = this.validatedJobAssessmentOutcome({ personId: String(row.person_id), status,
        value: checkpoint.assessmentOutcome, latestAttemptId: row.latest_attempt_id,
        latestAttemptStatus: row.latest_attempt_status, latestAttemptStartedAt: row.latest_attempt_started_at,
        latestAttemptFinishedAt: row.latest_attempt_finished_at });
      const labels: Record<StoredJobSummary['status'], string> = {
        queued: '已排队', running: '正在处理', waiting_auth: '等待连接 Codex',
        waiting_quota: '等待额度恢复', waiting_user: '等待你的确认', retry_wait: '等待重试',
        succeeded: '已完成', completed_with_issues: '已保存可靠结果，部分内容未纳入', failed: '处理失败', cancelled: '已取消'
      };
      const latestErrorCode = row.latest_error_code === null ? null : String(row.latest_error_code);
      const busyRetry = parseModelBusyRetryState(checkpoint.modelBusyRetry);
      const busyWaitText = `${latestErrorCode === 'CODEX_RATE_LIMITED' ? '请求暂时受到限流' : '模型暂时繁忙'}，稍后自动重试（第 ${busyRetry?.retryCount ?? 1}/2 次）；已保存结果保留`;
      const failedStatusText = latestErrorCode !== null
        && /^(?:LOCAL_STORAGE_FULL|ENOSPC|SQLITE_FULL)(?:\b|:)/.test(latestErrorCode)
        ? '本机磁盘空间不足；原件和已完成结果保留。请释放空间后重试，将从保存的进度继续'
        : latestErrorCode === 'CODEX_MODEL_BUSY'
        ? '模型仍然繁忙，已停止自动重试；已保存结果保留，可稍后手动重试'
        : latestErrorCode === 'CODEX_REQUEST_LIMITED_UNKNOWN'
          ? '服务限制了本次请求（429），原因尚未明确；已保存结果保留，可查看 Codex 额度后继续'
        : latestErrorCode === 'CODEX_RATE_LIMITED'
          ? busyRetry
            ? '请求仍受到限流，已停止自动重试；已保存结果保留，可稍后手动重试'
            : '请求被服务限流；当前额度状态未确认，已保存结果保留，可稍后手动重试'
        : latestErrorCode?.includes('failed to load configuration')
        ? '当前版本的 Codex 配置不兼容，请安装更新后重试'
        : latestErrorCode === 'MEMBER_ASSESSMENT_INPUT_TOO_LARGE'
          ? '完整资料仍超过本次分析容量，尚未生成新分析；资料已保留，未拆分或删减'
        : latestErrorCode === 'DIRECT_ORIGINAL_CONTEXT_LIMIT_EXCEEDED'
          ? '完整请求超过本次容量；原件和已有结果已保留，未拆分或删减'
        : latestErrorCode === 'CODEX_OUTPUT_SCHEMA_INVALID'
          ? '结构化输出格式不兼容，请安装更新后重试'
          : latestErrorCode === 'CODEX_TURN_TIMEOUT'
            ? '报告内容较多，本次等待超时；资料已保留，可安全重试'
          : latestErrorCode === 'CODEX_CONNECTION_FAILED'
            ? '连接 Codex 时中断，请检查网络后重试'
            : labels.failed;
      return {
        id: String(row.id),
        documentIds: checkpoint.documentIds ?? [],
        batchLabel: `${row.consent_purpose === 'automatic_upload_processing' ? '上传后自动整理' : '手动处理'} · ${new Date(String(row.batch_created_at)).toLocaleString('zh-CN')}`,
        personLabel: row.person_label === null ? null : String(row.person_label),
        stage: String(row.stage) as StoredJobSummary['stage'],
        status,
        completedUnits: checkpoint.completedUnits ?? 0,
        totalUnits: Math.max(checkpoint.documentIds?.length ?? 1, 1),
        statusText: status === 'running' && checkpoint.cancelRequested ? '正在安全停止'
          : status === 'retry_wait' && busyRetry ? busyWaitText
          : status === 'waiting_quota' && latestErrorCode === 'CODEX_QUOTA_EXHAUSTED'
            ? '服务已返回用量上限，等待额度恢复；已保存结果保留'
          : status === 'completed_with_issues' && checkpoint.automaticUploadStop === 'scope_changed'
            ? '上传范围已发生变化，本次自动整理已停止；原件和已有结果保留'
          : status === 'failed' ? failedStatusText : labels[status],
        systemOutcomes: checkpoint.systemOutcomes ?? [],
        assessmentOutcome,
        updatedAt: String(row.updated_at)
      };
    });
  }

  cleanupTerminalTaskAttempts(cutoffIso: string): number {
    return this.db.transaction(() => {
      // 先固定清理前的最新尝试，不能删掉新尝试后再把较旧收据误认为最新。
      const rows = this.db.prepare(`SELECT a.id,j.person_id,j.status AS job_status,j.checkpoint_json,
        latest.id AS latest_attempt_id,latest.status AS latest_attempt_status,
        latest.started_at AS latest_attempt_started_at,latest.finished_at AS latest_attempt_finished_at
        FROM job_attempts a JOIN jobs j ON j.id=a.job_id
        LEFT JOIN job_attempts latest ON latest.id=(SELECT ja.id FROM job_attempts ja WHERE ja.job_id=j.id
          ORDER BY ja.started_at DESC,ja.rowid DESC LIMIT 1)
        WHERE a.finished_at IS NOT NULL AND a.finished_at < ?
          AND j.status IN ('succeeded','completed_with_issues','failed','cancelled')
          AND NOT EXISTS(SELECT 1 FROM review_issues r WHERE r.job_id=j.id AND r.resolution_status='open')
      `).all(cutoffIso) as Array<Record<string, unknown>>;
      const remove = this.db.prepare('DELETE FROM job_attempts WHERE id=?');
      const minimize = this.db.prepare(`UPDATE job_attempts SET runtime_version=NULL,model=NULL,reasoning_effort=NULL,
        thread_id=NULL,turn_id=NULL,error_code=NULL,usage_json=NULL WHERE id=?`);
      let removed = 0;
      for (const row of rows) {
        let value: unknown;
        try { value = (JSON.parse(String(row.checkpoint_json ?? '{}')) as { assessmentOutcome?: unknown }).assessmentOutcome; }
        catch { value = null; }
        const outcome = this.validatedJobAssessmentOutcome({ personId: String(row.person_id), status: String(row.job_status),
          value, latestAttemptId: row.latest_attempt_id, latestAttemptStatus: row.latest_attempt_status,
          latestAttemptStartedAt: row.latest_attempt_started_at, latestAttemptFinishedAt: row.latest_attempt_finished_at });
        if (outcome?.attemptId === row.id) {
          // 只留 id/归属/状态/起止时间这条完成凭据；完整会话、模型与用量仍遵循过期清理。
          minimize.run(String(row.id));
        } else removed += remove.run(String(row.id)).changes;
      }
      return removed;
    })();
  }

  getFactRevision(personId: string): number {
    const row = this.db.prepare(`SELECT fact_revision FROM person_revisions WHERE person_id = ?`).get(personId) as { fact_revision: number } | undefined;
    return row?.fact_revision ?? 0;
  }

  /** 事实、成员上下文或待核对范围变化时，旧综合与变化本身必须在同一事务失效。 */
  private invalidateMemberAssessmentSnapshots(personId: string): void {
    this.db.prepare(`UPDATE member_assessment_snapshots_v3 SET status = 'stale' WHERE person_id = ? AND status = 'current'`)
      .run(personId);
  }

  setObservationConceptMapping(input: {
    personId: string;
    observationId: string;
    conceptId: string | null;
    reason: string;
  }): ConceptMappingReceipt {
    const observation = this.listAcceptedObservations(input.personId).find((item) => item.id === input.observationId);
    if (!observation) throw new Error('OBSERVATION_NOT_FOUND');
    const definition = input.conceptId ? conceptDictionary.find((item) => item.id === input.conceptId) : null;
    if (input.conceptId && !definition) throw new Error('CONCEPT_NOT_FOUND');
    const nextMapping: ConceptMapping = definition ? {
      rawName: observation.originalName,
      normalizedName: definition.canonicalName,
      conceptId: definition.id,
      canonicalName: definition.canonicalName,
      status: 'verified',
      confidence: 1,
      reasons: [`用户确认归入“${definition.canonicalName}”；原始名称保持不变。`]
    } : {
      rawName: observation.originalName,
      normalizedName: observation.originalName,
      conceptId: null,
      canonicalName: null,
      status: 'unmapped',
      confidence: 0,
      reasons: ['用户确认当前不能安全归入现有概念；原始名称保持不变。']
    };
    if (nextMapping.conceptId === observation.mapping.conceptId && nextMapping.status === observation.mapping.status) {
      throw new Error('CONCEPT_MAPPING_UNCHANGED');
    }

    const correctionId = randomUUID();
    const timestamp = this.now().toISOString();
    const oldSystems = linkConceptToSystems(observation.mapping).map((item) => item.systemId);
    const newSystems = linkConceptToSystems(nextMapping).map((item) => item.systemId);
    const invalidatedSystemIds = [...new Set([...oldSystems, ...newSystems])];
    const transaction = this.db.transaction(() => {
      const currentRevision = this.db.prepare(`SELECT current_revision FROM observations WHERE id = ? AND person_id = ?`)
        .get(input.observationId, input.personId) as { current_revision: number } | undefined;
      if (!currentRevision) throw new Error('OBSERVATION_NOT_FOUND');
      this.db.prepare(`UPDATE concept_mapping_corrections SET active = 0 WHERE observation_id = ? AND active = 1`)
        .run(input.observationId);
      this.db.prepare(`
        INSERT INTO concept_mapping_corrections (
          id, observation_id, observation_revision, concept_id, normalized_name,
          status, confidence, reasons_json, previous_concept_id, previous_normalized_name,
          previous_status, previous_confidence, previous_reasons_json,
          action, reason, active, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'set', ?, 1, ?)
      `).run(
        correctionId, input.observationId, currentRevision.current_revision,
        nextMapping.conceptId, nextMapping.normalizedName, nextMapping.status,
        nextMapping.confidence, JSON.stringify(nextMapping.reasons),
        observation.mapping.conceptId, observation.mapping.normalizedName,
        observation.mapping.status, observation.mapping.confidence,
        JSON.stringify(observation.mapping.reasons), input.reason.trim(), timestamp
      );
      this.db.prepare(`
        INSERT INTO person_revisions (person_id, fact_revision) VALUES (?, 1)
        ON CONFLICT(person_id) DO UPDATE SET fact_revision = fact_revision + 1
      `).run(input.personId);
      if (invalidatedSystemIds.length > 0) {
        this.db.prepare(`
          UPDATE system_analysis_snapshots_v2 SET status = 'stale'
          WHERE person_id = ? AND status = 'current'
            AND system_id IN (${invalidatedSystemIds.map(() => '?').join(',')})
        `).run(input.personId, ...invalidatedSystemIds);
      }
      this.db.prepare(`UPDATE derived_snapshots SET status = 'stale' WHERE person_id = ? AND status = 'current'`).run(input.personId);
      this.invalidateMemberAssessmentSnapshots(input.personId);
      this.db.prepare(`
        INSERT INTO audit_events (id, event_type, entity_id, summary, created_at)
        VALUES (?, 'concept_mapping_corrected', ?, '用户修正了指标概念映射；原始事实保持不变。', ?)
      `).run(randomUUID(), input.observationId, timestamp);
    });
    transaction();
    return {
      observationId: input.observationId,
      mapping: nextMapping,
      mappingVersion: `user:${correctionId}`,
      correctedAt: timestamp,
      canUndo: true,
      invalidatedSystemIds,
      factRevision: this.getFactRevision(input.personId)
    };
  }

  undoObservationConceptMapping(input: { personId: string; observationId: string }): ConceptMappingReceipt {
    const observation = this.listAcceptedObservations(input.personId).find((item) => item.id === input.observationId);
    if (!observation) throw new Error('OBSERVATION_NOT_FOUND');
    const correction = this.db.prepare(`
      SELECT id, observation_revision, previous_concept_id, previous_normalized_name,
             previous_status, previous_confidence, previous_reasons_json
      FROM concept_mapping_corrections
      WHERE observation_id = ? AND active = 1 AND action = 'set'
    `).get(input.observationId) as Record<string, unknown> | undefined;
    if (!correction) throw new Error('CONCEPT_MAPPING_NOT_UNDOABLE');
    const previousConceptId = correction.previous_concept_id === null ? null : String(correction.previous_concept_id);
    const definition = previousConceptId ? conceptDictionary.find((item) => item.id === previousConceptId) : null;
    const restoredMapping: ConceptMapping = {
      rawName: observation.originalName,
      normalizedName: String(correction.previous_normalized_name),
      conceptId: previousConceptId,
      canonicalName: definition?.canonicalName ?? null,
      status: String(correction.previous_status) as ConceptMapping['status'],
      confidence: Number(correction.previous_confidence),
      reasons: JSON.parse(String(correction.previous_reasons_json)) as string[]
    };
    const undoId = randomUUID();
    const timestamp = this.now().toISOString();
    const oldSystems = linkConceptToSystems(observation.mapping).map((item) => item.systemId);
    const restoredSystems = linkConceptToSystems(restoredMapping).map((item) => item.systemId);
    const invalidatedSystemIds = [...new Set([...oldSystems, ...restoredSystems])];
    const transaction = this.db.transaction(() => {
      this.db.prepare(`UPDATE concept_mapping_corrections SET active = 0 WHERE id = ? AND active = 1`).run(String(correction.id));
      this.db.prepare(`
        INSERT INTO concept_mapping_corrections (
          id, observation_id, observation_revision, concept_id, normalized_name,
          status, confidence, reasons_json, previous_concept_id, previous_normalized_name,
          previous_status, previous_confidence, previous_reasons_json,
          action, reason, active, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'undo', '撤销上一次概念修正', 1, ?)
      `).run(
        undoId, input.observationId, Number(correction.observation_revision),
        restoredMapping.conceptId, restoredMapping.normalizedName, restoredMapping.status,
        restoredMapping.confidence, JSON.stringify(restoredMapping.reasons),
        observation.mapping.conceptId, observation.mapping.normalizedName,
        observation.mapping.status, observation.mapping.confidence,
        JSON.stringify(observation.mapping.reasons), timestamp
      );
      this.db.prepare(`
        INSERT INTO person_revisions (person_id, fact_revision) VALUES (?, 1)
        ON CONFLICT(person_id) DO UPDATE SET fact_revision = fact_revision + 1
      `).run(input.personId);
      if (invalidatedSystemIds.length > 0) {
        this.db.prepare(`
          UPDATE system_analysis_snapshots_v2 SET status = 'stale'
          WHERE person_id = ? AND status = 'current'
            AND system_id IN (${invalidatedSystemIds.map(() => '?').join(',')})
        `).run(input.personId, ...invalidatedSystemIds);
      }
      this.db.prepare(`UPDATE derived_snapshots SET status = 'stale' WHERE person_id = ? AND status = 'current'`).run(input.personId);
      this.invalidateMemberAssessmentSnapshots(input.personId);
      this.db.prepare(`
        INSERT INTO audit_events (id, event_type, entity_id, summary, created_at)
        VALUES (?, 'concept_mapping_undone', ?, '用户撤销了上一次指标概念修正；原始事实保持不变。', ?)
      `).run(randomUUID(), input.observationId, timestamp);
    });
    transaction();
    return {
      observationId: input.observationId,
      mapping: restoredMapping,
      mappingVersion: `user:${undoId}`,
      correctedAt: timestamp,
      canUndo: false,
      invalidatedSystemIds,
      factRevision: this.getFactRevision(input.personId)
    };
  }

  /** 当前正式行的统一只读投影；来源证明只在内存重证，不写别名或医疗修订。 */
  private canonicalStoredObservationRows(personId?: string, documentId?: string, pendingManifest?: SourceManifest):
    CanonicalObservationRowSelection {
    // 同连接写入看total_changes，其他连接提交看data_version，DDL看schema_version。
    // 任一来源/角色/锁/当前修订改变都会失效；仅复用同一数据库版本内的进程证明。
    const databaseToken = stableHash([
      this.db.prepare('SELECT total_changes() AS changes').get(),
      this.db.prepare('PRAGMA data_version').get(), this.db.prepare('PRAGMA schema_version').get()
    ]);
    if (this.canonicalObservationReadCache?.databaseToken !== databaseToken) {
      this.canonicalObservationReadCache = { databaseToken, scopes: new Map() };
    }
    const cache = this.canonicalObservationReadCache!;
    const scopeKey = stableHash([personId ?? null, documentId ?? null, pendingManifest ?? null]);
    const cached = cache.scopes.get(scopeKey);
    if (cached) return cached;
    const rows = this.db.prepare(`SELECT o.id,o.person_id,o.created_at,o.current_revision,o.concept_key,o.original_name,
      r.value_kind,r.raw_text,r.decimal_value,r.qualifier,r.unit,r.reference_range,r.abnormal_flag,r.specimen,r.method,r.body_site,
      r.source_span_id,r.evidence_json,r.clinical_context_json,r.source_binding_json,r.clinical_date,
      e.clinical_date AS display_clinical_date,ss.document_id,ad.actor AS acceptance_actor,
      (EXISTS(SELECT 1 FROM concept_mapping_corrections c WHERE c.observation_id=o.id AND c.active=1)
       OR EXISTS(SELECT 1 FROM report_records rr JOIN report_source_links l ON l.report_id=rr.id
         WHERE l.document_id=ss.document_id AND rr.person_id=o.person_id AND rr.metadata_status='corrected')
       OR EXISTS(SELECT 1 FROM review_issues ri WHERE ri.field_ref='document:'||ss.document_id
         AND ri.resolution_status='open' AND (ri.kind='person_conflict' OR ri.kind='overwrite_protected'))) AS user_locked
      FROM observations o JOIN observation_revisions r ON r.observation_id=o.id AND r.revision=o.current_revision
      JOIN source_spans ss ON ss.id=r.source_span_id JOIN documents d ON d.id=ss.document_id AND d.excluded_from_analysis=0
      JOIN acceptance_decisions ad ON ad.id=r.acceptance_id LEFT JOIN encounters e ON e.id=o.encounter_id
      WHERE (? IS NULL OR o.person_id=?) AND (? IS NULL OR ss.document_id=?)
      ORDER BY o.created_at,o.id`).all(personId ?? null, personId ?? null, documentId ?? null, documentId ?? null) as CanonicalObservationRow[];
    const manifests = new Map<string, SourceManifest | null>();
    const documentCache = this.canonicalObservationDocumentCache ??= new Map();
    const documentRows = new Map<string, CanonicalObservationRow[]>();
    for (const row of rows) {
      const key = JSON.stringify([row.person_id, row.document_id]);
      const group = documentRows.get(key) ?? []; group.push(row); documentRows.set(key, group);
    }
    const selectedById = new Map<string, CanonicalObservationRowSelection['observations'][number]>();
    const canonicalIdByObservationId = new Map<string, string>();
    for (const [documentKey, group] of documentRows) {
      const sourceDocumentId = group[0]!.document_id;
      // 完整关键输入指纹而非行数/最大时间；无关job/transmission写入不迫使医疗来源重证。
      // 角色、原文、几何、normalizer、原件SHA、当前修订、锁、条件和实际日期都在这些完整行内。
      const fingerprint = stableHash({ rows: group,
        sourceSpans: this.db.prepare('SELECT * FROM source_spans WHERE document_id=? ORDER BY id').all(sourceDocumentId),
        manifestMembership: this.db.prepare('SELECT * FROM source_manifest_spans WHERE document_id=? ORDER BY source_span_id')
          .all(sourceDocumentId),
        manifest: this.db.prepare(`SELECT sm.*,so.sha256 AS current_original_sha256,
          so.media_type AS current_original_media_type,
          d.source_object_id AS document_source_object_id,d.person_id AS document_person_id
          FROM documents d JOIN source_objects so ON so.id=d.source_object_id
          LEFT JOIN source_manifests sm ON sm.document_id=d.id WHERE d.id=?`).get(sourceDocumentId),
        pendingManifest: pendingManifest?.spans[0]?.documentId === sourceDocumentId ? pendingManifest : null });
      const documentCacheKey = JSON.stringify([documentKey, pendingManifest ? scopeKey : null]);
      const previous = documentCache.get(documentCacheKey);
      let documentSelection = previous?.fingerprint === fingerprint ? previous.selection : null;
      if (!documentSelection) documentSelection = selectCanonicalStoredObservations(group.map((row) => {
      let binding: ResolvedReportSourceBinding | null = null;
      let contextGrounded = false;
      const observation: PublishedObservationInput = { conceptKey: row.concept_key,
        originalName: row.original_name ?? row.concept_key, modelStandardNameCandidate: null,
        rawText: row.raw_text, valueKind: row.value_kind, decimalValue: row.decimal_value, qualifier: row.qualifier,
        unit: row.unit, referenceRange: row.reference_range, clinicalDate: row.clinical_date, abnormalFlag: row.abnormal_flag,
        documentId: row.document_id, sourceSpanId: row.source_span_id, acceptanceId: '',
        specimen: row.specimen, method: row.method, bodySite: row.body_site,
        clinicalContext: row.clinical_context_json ? JSON.parse(row.clinical_context_json) as ClinicalContext : null,
        evidence: JSON.parse(row.evidence_json) as PublishedObservationInput['evidence'] };
      const saved = storedReportSourceBinding(row.source_binding_json);
      if (!manifests.has(row.document_id)) {
        try {
          const current = pendingManifest?.spans[0]?.documentId === row.document_id
            ? pendingManifest : this.getDocumentExtractionBundle(row.document_id).manifest;
          const missing = group.find((other) => other.document_id === row.document_id
            && !current.spans.some((span) => span.id === other.source_span_id));
          const historical = missing ? this.reconciliationSourceManifest(row.document_id, missing.source_span_id) : null;
          manifests.set(row.document_id, historical ? { ...current, spans: [...new Map([
            ...historical.spans, ...current.spans].map((span) => [span.id, span])).values()] } : current);
        }
        catch { manifests.set(row.document_id, null); }
      }
      if (saved?.directOriginalField && row.original_name) {
        try {
          const manifest = manifests.get(row.document_id)!;
          if (manifest) {
            const restored = this.restoreStoredDirectSourceRoles(observation, saved, manifest);
            const resolved = this.resolveStoredReportBinding(restored, manifest);
            if (restored !== observation && resolved.status === 'resolved'
              && isVerifiedDirectOriginalSourceBinding(resolved.binding)) binding = resolved.binding;
            contextGrounded = binding !== null && observation.clinicalContext?.status === 'complete'
              && this.groundedClinicalContextJson(row.document_id, observation.clinicalContext, manifest) !== null;
          }
        } catch {
          // 缺少历史来源或旧绑定不可重证时保持全部物理行，不能把读取失败当成已判重。
          manifests.set(row.document_id, null);
        }
      }
      return { observationId: row.id, personId: row.person_id, documentId: row.document_id, revision: row.current_revision,
        createdAt: row.created_at, displayClinicalDate: row.display_clinical_date,
        acceptanceActor: row.acceptance_actor, userLocked: Boolean(row.user_locked),
        fact: publishedReconciliationFact(observation), binding, contextGrounded, row,
        sourcePageScope: manifests.get(row.document_id)
          ? observationSourcePageScope(observation, manifests.get(row.document_id)!) : null };
      }));
      if (previous?.fingerprint !== fingerprint) {
        if (documentCache.size >= 128) documentCache.delete(documentCache.keys().next().value!);
        documentCache.set(documentCacheKey, { fingerprint, selection: documentSelection });
      }
      for (const entry of documentSelection.observations) selectedById.set(entry.observationId, entry);
      for (const [id, canonicalId] of documentSelection.canonicalIdByObservationId) canonicalIdByObservationId.set(id, canonicalId);
    }
    const selection: CanonicalObservationRowSelection = { observations: rows.flatMap((row) => {
      const entry = selectedById.get(row.id); return entry ? [entry] : [];
    }), canonicalIdByObservationId };
    if (cache.scopes.size >= 64) cache.scopes.delete(cache.scopes.keys().next().value!);
    cache.scopes.set(scopeKey, selection);
    return selection;
  }

  /** 完整当前事实计数，不受前端明细窗口上限影响。 */
  listDocumentAcceptedFactCounts(): Map<string, number> {
    const result = new Map<string, number>();
    for (const { row } of this.canonicalStoredObservationRows().observations) result.set(row.document_id, (result.get(row.document_id) ?? 0) + 1);
    return result;
  }

  listAcceptedObservations(personId?: string, options?: { limitPerPerson?: number }): AcceptedObservationSummary[] {
    const limitPerPerson = options?.limitPerPerson;
    if (limitPerPerson !== undefined && (!Number.isInteger(limitPerPerson) || limitPerPerson < 1 || limitPerPerson > 5_000)) {
      throw new Error('OBSERVATION_WINDOW_LIMIT_INVALID');
    }
    const canonicalIds = new Set(this.canonicalStoredObservationRows(personId).observations.map((entry) => entry.observationId));
    const rows = this.db.prepare(`
      SELECT o.id, o.person_id, o.concept_key, o.original_name, o.model_standard_name_candidate, o.created_at,
             r.value_kind, r.raw_text, r.decimal_value, r.qualifier, r.unit,
             r.reference_range, r.abnormal_flag, r.source_span_id,
             r.specimen, r.method, r.body_site, r.evidence_json, r.clinical_context_json,
             e.clinical_date, ss.quote AS source_quote, d.id AS document_id,
             (
               SELECT rr.event_id
               FROM report_source_links rsl
               JOIN report_records rr ON rr.id = rsl.report_id
               WHERE rsl.document_id = d.id
               ORDER BY rr.created_at DESC LIMIT 1
             ) AS event_id,
             COALESCE(c.concept_id, m.concept_id) AS mapping_concept_id,
             COALESCE(c.normalized_name, m.normalized_name) AS mapping_normalized_name,
             COALESCE(c.status, m.status) AS mapping_status,
             COALESCE(c.confidence, m.confidence) AS mapping_confidence,
             COALESCE(c.reasons_json, m.reasons_json) AS mapping_reasons_json,
             c.id AS correction_id, c.action AS correction_action, c.created_at AS correction_created_at,
             m.mapper_version AS automatic_mapper_version,
             (
               SELECT occ.display_name
               FROM source_occurrences occ
               WHERE occ.source_object_id = d.source_object_id
               ORDER BY occ.last_seen DESC LIMIT 1
             ) AS source_label
      FROM observations o
      JOIN observation_revisions r
        ON r.observation_id = o.id AND r.revision = o.current_revision
      JOIN source_spans ss ON ss.id = r.source_span_id
      JOIN documents d ON d.id = ss.document_id AND d.excluded_from_analysis = 0
      LEFT JOIN encounters e ON e.id = o.encounter_id
      LEFT JOIN observation_concept_mappings m
        ON m.observation_id = o.id AND m.observation_revision = o.current_revision
       AND m.rowid = (
         SELECT MAX(m2.rowid) FROM observation_concept_mappings m2
         WHERE m2.observation_id = o.id AND m2.observation_revision = o.current_revision
       )
      LEFT JOIN concept_mapping_corrections c
        ON c.observation_id = o.id AND c.observation_revision = o.current_revision AND c.active = 1
      WHERE (? IS NULL OR o.person_id = ?)
      ORDER BY COALESCE(e.clinical_date, o.created_at), o.concept_key, o.id
    `).all(personId ?? null, personId ?? null) as Array<Record<string, unknown>>;
    const canonicalRows = rows.filter((row) => canonicalIds.has(String(row.id)));
    const windowIds = new Set<string>();
    if (limitPerPerson !== undefined) {
      const personCounts = new Map<string, number>();
      for (const row of [...canonicalRows].sort((left, right) =>
        String(right.clinical_date ?? right.created_at).localeCompare(String(left.clinical_date ?? left.created_at))
        || String(right.id).localeCompare(String(left.id)))) {
        const key = String(row.person_id); const count = personCounts.get(key) ?? 0;
        if (count < limitPerPerson) { windowIds.add(String(row.id)); personCounts.set(key, count + 1); }
      }
    }
    return canonicalRows.filter((row) => limitPerPerson === undefined || windowIds.has(String(row.id))).map((row) => {
      const legacyNameMissing = row.original_name === null || String(row.original_name).trim() === '';
      const originalName = legacyNameMissing
        ? '原项目名待核实（旧记录）'
        : String(row.original_name);
      const modelStandardNameCandidate = row.model_standard_name_candidate === null
        ? legacyNameMissing ? String(row.concept_key) : null
        : String(row.model_standard_name_candidate);
      const automatic = mapConcept({
        rawName: originalName,
        standardName: modelStandardNameCandidate,
        specimen: row.specimen === null ? null : String(row.specimen),
        method: row.method === null ? null : String(row.method),
        bodySite: row.body_site === null ? null : String(row.body_site),
        unit: row.unit === null ? null : String(row.unit)
      });
      const conceptId = row.mapping_concept_id === null ? automatic.conceptId : String(row.mapping_concept_id);
      const definition = conceptId ? conceptDictionary.find((item) => item.id === conceptId) : null;
      const storedAutomaticMappingIsTrusted = !legacyNameMissing || row.correction_id !== null;
      const mapping: ConceptMapping = row.mapping_status === null || !storedAutomaticMappingIsTrusted ? automatic : {
        rawName: originalName,
        normalizedName: String(row.mapping_normalized_name),
        conceptId,
        canonicalName: definition?.canonicalName ?? null,
        status: String(row.mapping_status) as ConceptMapping['status'],
        confidence: Number(row.mapping_confidence),
        reasons: JSON.parse(String(row.mapping_reasons_json)) as string[]
      };
      return ({
      id: String(row.id),
      personId: String(row.person_id),
      conceptKey: String(row.concept_key),
      originalName,
      originalNameStatus: legacyNameMissing ? 'legacy_missing' : 'recorded',
      modelStandardNameCandidate,
      rawText: String(row.raw_text),
      valueKind: String(row.value_kind) as AcceptedObservationSummary['valueKind'],
      decimalValue: row.decimal_value === null ? null : String(row.decimal_value),
      qualifier: row.qualifier === null ? null : String(row.qualifier),
      unit: row.unit === null ? null : String(row.unit),
      referenceRange: row.reference_range === null ? null : String(row.reference_range),
      clinicalDate: row.clinical_date === null ? null : String(row.clinical_date),
      abnormalFlag: String(row.abnormal_flag) as AcceptedObservationSummary['abnormalFlag'],
      sourceSpanId: String(row.source_span_id),
      sourceQuote: row.source_quote === null ? null : String(row.source_quote),
      sourceLabel: String(row.source_label ?? '已导入资料'),
      documentId: String(row.document_id),
      eventId: row.event_id === null ? null : String(row.event_id),
      specimen: row.specimen === null ? null : String(row.specimen),
      method: row.method === null ? null : String(row.method),
      bodySite: row.body_site === null ? null : String(row.body_site),
      clinicalContext: row.clinical_context_json == null ? null
        : clinicalContextSchema.parse(JSON.parse(String(row.clinical_context_json))),
      evidence: JSON.parse(String(row.evidence_json ?? '[]')) as AcceptedObservationSummary['evidence'],
      mapping,
      mappingVersion: row.correction_id === null
        ? String(row.automatic_mapper_version ?? CONCEPT_DICTIONARY_VERSION)
        : `user:${String(row.correction_id)}`,
      mappingCorrectedAt: row.correction_created_at === null ? null : String(row.correction_created_at),
      mappingCanUndo: row.correction_id !== null && row.correction_action === 'set',
      createdAt: String(row.created_at)
      });
    });
  }

  listReportMetadata(personId: string): StoredReportMetadataSummary[] {
    const rows = this.db.prepare(`
      SELECT r.id, r.event_id, r.title, r.report_kind, r.organization, r.report_date,
             r.metadata_status, r.metadata_revision, l.document_id, mr.payload_json,
             e.clinical_date, e.date_precision
      FROM report_records r
      JOIN report_source_links l ON l.report_id = r.id
      JOIN documents d
        ON d.id = l.document_id
       AND d.person_id = r.person_id
       AND d.excluded_from_analysis = 0
      LEFT JOIN health_events_v2 e ON e.id = r.event_id
      LEFT JOIN report_metadata_revisions mr
        ON mr.report_id = r.id AND mr.revision = r.metadata_revision
      WHERE r.person_id = ?
      ORDER BY r.created_at, r.id
    `).all(personId) as Array<Record<string, unknown>>;
    return rows.map((row) => {
      const payload = row.payload_json ? JSON.parse(String(row.payload_json)) as {
        extracted?: ReportMetadataCandidate | null;
        correction?: { department?: string | null } | null;
        action?: 'set' | 'undo';
      } : {};
      return {
        documentId: String(row.document_id),
        reportId: String(row.id),
        eventId: String(row.event_id),
        title: String(row.title),
        reportKind: String(row.report_kind),
        organization: row.organization === null ? null : String(row.organization),
        reportDate: row.report_date === null ? null : String(row.report_date),
        metadataStatus: String(row.metadata_status) as StoredReportMetadataSummary['metadataStatus'],
        metadataRevision: Number(row.metadata_revision),
        extracted: payload.extracted ?? null,
        department: payload.correction?.department ?? payload.extracted?.department?.value ?? null,
        clinicalTime: {
          value: row.clinical_date === null ? null : String(row.clinical_date),
          precision: (row.date_precision === null ? 'unknown' : String(row.date_precision)) as StoredReportMetadataSummary['clinicalTime']['precision']
        },
        canUndo: payload.action === 'set'
      };
    });
  }

  /** 正常初始化时撤销旧自动“检查日=签发日”缓存，不重读原件、不改变事实或事件时间。 */
  upgradeDirectOriginalReportDateProjection(): DirectOriginalReportDateProjectionUpgradeReceipt {
    const active = () => Boolean(this.db.prepare(`SELECT 1 FROM jobs
      WHERE status IN ('queued','running','waiting_auth','waiting_quota','waiting_user','retry_wait') LIMIT 1`).get()
      || this.db.prepare(`SELECT 1 FROM job_attempts WHERE finished_at IS NULL AND status='running' LIMIT 1`).get());
    const skipped = (): DirectOriginalReportDateProjectionUpgradeReceipt => ({ upgradedReportIds: [], affectedPersonIds: [], skippedActive: true });
    // 活动期间连升级事务都不启动；事务内仍再检查，避免读取后新任务入队的竞态。
    if (active()) return skipped();
    return this.db.transaction((): DirectOriginalReportDateProjectionUpgradeReceipt => {
      if (active()) return skipped();
      const rows = this.db.prepare(`SELECT r.id,r.person_id,r.event_id,r.report_date,r.metadata_status,r.metadata_revision,
        e.clinical_date,e.date_precision,e.metadata_revision AS event_metadata_revision,mr.payload_json,mr.evidence_refs_json,
        l.document_id,so.id AS source_object_id,so.sha256
        FROM report_records r JOIN report_source_links l ON l.report_id=r.id
        JOIN documents d ON d.id=l.document_id AND d.person_id=r.person_id AND d.excluded_from_analysis=0 AND d.status='completed'
        JOIN persons p ON p.id=r.person_id AND p.archived_at IS NULL
        JOIN source_objects so ON so.id=d.source_object_id AND so.sha256=l.source_hash
        JOIN source_manifests sm ON sm.document_id=d.id AND sm.source_object_id=so.id AND sm.sha256=so.sha256
        JOIN document_commits dc ON dc.document_id=d.id
        JOIN publication_events pe ON pe.id=dc.publication_id AND pe.person_id=r.person_id
        JOIN health_events_v2 e ON e.id=r.event_id AND e.person_id=r.person_id
        JOIN report_metadata_revisions mr ON mr.report_id=r.id AND mr.revision=r.metadata_revision
        WHERE r.report_date IS NOT NULL AND r.report_date=e.clinical_date
          AND r.metadata_status!='corrected' AND e.metadata_status!='corrected' AND e.date_source='explicit'
          AND mr.actor IN ('policy','independent_review_projection')
          AND (SELECT COUNT(*) FROM report_source_links other WHERE other.report_id=r.id)=1
          AND (SELECT COUNT(*) FROM report_source_links other WHERE other.document_id=d.id)=1
          AND NOT EXISTS(SELECT 1 FROM review_issues issue WHERE issue.field_ref='document:'||d.id
            AND issue.kind='person_conflict' AND issue.resolution_status='open')
        ORDER BY r.person_id,r.id`).all() as Array<{ id: string; person_id: string; event_id: string; report_date: string;
          metadata_status: string; metadata_revision: number; clinical_date: string; date_precision: string;
          event_metadata_revision: number; payload_json: string; evidence_refs_json: string; document_id: string;
          source_object_id: string; sha256: string }>;
      const upgradedReportIds: string[] = [];
      const perPerson = new Map<string, string[]>();
      const timestamp = this.now().toISOString();
      for (const row of rows) {
        let payload: Record<string, unknown> & { extracted?: ReportMetadataCandidate | null };
        let manifest: SourceManifest;
        try {
          payload = JSON.parse(row.payload_json) as typeof payload;
          const parsed = reportMetadataCandidateSchema.safeParse(payload.extracted);
          if (!parsed.success || parsed.data.times.some((time) => time.role === 'report_issued')) continue;
          // 使用旧回执原样内容，不由schema默认值或数组重排改动times/primary。
          const metadata = payload.extracted!;
          manifest = this.getDocumentExtractionBundle(row.document_id).manifest;
          if (!manifest.normalizerVersion.startsWith('direct-original-') || manifest.sourceObjectId !== row.source_object_id || manifest.sha256 !== row.sha256) continue;
          const original = this.getDocumentOriginalSource(row.document_id);
          if (original.personId !== row.person_id || original.sourceObjectId !== row.source_object_id || original.sha256 !== row.sha256
            || original.personArchived || original.excludedFromAnalysis
            || createHash('sha256').update(readFileSync(original.sourcePath)).digest('hex') !== row.sha256) continue;
          const trustedDates = metadata.times.length > 0
            && metadata.times.every((time) => trustedDirectReportTime(time, manifest, row.document_id));
          if (!trustedDates) continue;
          const selected = this.selectPrimaryClinicalTime(row.document_id, metadata, manifest);
          if (selected.heldReasonCodes.length > 0 || selected.time?.value !== row.clinical_date || selected.time.precision !== row.date_precision) continue;
        } catch { continue; }
        const nextRevision = row.metadata_revision + 1;
        const changed = this.db.prepare(`UPDATE report_records SET report_date=NULL,metadata_revision=?
          WHERE id=? AND person_id=? AND metadata_revision=? AND report_date=? AND metadata_status=? AND metadata_status!='corrected'
            AND EXISTS(SELECT 1 FROM report_metadata_revisions mr WHERE mr.report_id=report_records.id AND mr.revision=?
              AND mr.actor IN ('policy','independent_review_projection') AND mr.payload_json=?)
            AND EXISTS(SELECT 1 FROM health_events_v2 e WHERE e.id=report_records.event_id AND e.id=?
              AND e.person_id=? AND e.clinical_date=? AND e.metadata_revision=? AND e.date_source='explicit' AND e.metadata_status!='corrected')`)
          .run(nextRevision, row.id, row.person_id, row.metadata_revision, row.report_date, row.metadata_status,
            row.metadata_revision, row.payload_json, row.event_id, row.person_id, row.clinical_date, row.event_metadata_revision);
        if (changed.changes !== 1) throw new Error('DIRECT_ORIGINAL_REPORT_DATE_PROJECTION_STATE_CHANGED');
        this.db.prepare(`INSERT INTO report_metadata_revisions
          (report_id,revision,payload_json,actor,evidence_refs_json,created_at) VALUES (?,?,?,'policy',?,?)`)
          .run(row.id, nextRevision, JSON.stringify({ ...payload, action: 'policy_clear_inherited_report_date',
            projectionVersion: 'report-issued-date-v1',
            previous: { reportDate: row.report_date, metadataStatus: row.metadata_status, metadataRevision: row.metadata_revision, payload }
          }), row.evidence_refs_json, timestamp);
        this.db.prepare(`INSERT INTO audit_events (id,event_type,entity_id,summary,created_at)
          VALUES (?,'report_metadata.inherited_report_date_cleared',?,'已撤销无签发来源的旧自动签发日期缓存；检查日期和原始事实保持不变。',?)`)
          .run(randomUUID(), row.id, timestamp);
        upgradedReportIds.push(row.id);
        perPerson.set(row.person_id, [...(perPerson.get(row.person_id) ?? []), row.id]);
      }
      for (const [personId, reportIds] of perPerson) {
        this.invalidateAfterEventRelationChange(personId, reportIds);
      }
      return { upgradedReportIds, affectedPersonIds: [...perPerson.keys()], skippedActive: false };
    }).immediate();
  }

  getLatestActiveEventRelationChange(personId: string, eventId: string): ActiveEventRelationChange | null {
    const row = this.db.prepare(`
      SELECT id, action, from_event_id, to_event_id, report_ids_json, created_at
      FROM event_relation_changes
      WHERE person_id = ? AND active = 1 AND action IN ('merge','split')
        AND (from_event_id = ? OR to_event_id = ?)
      ORDER BY created_at DESC, id DESC
      LIMIT 1
    `).get(personId, eventId, eventId) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      id: String(row.id),
      action: String(row.action) as ActiveEventRelationChange['action'],
      fromEventId: String(row.from_event_id),
      toEventId: String(row.to_event_id),
      reportIds: JSON.parse(String(row.report_ids_json)) as string[],
      createdAt: String(row.created_at)
    };
  }

  updateReportMetadata(input: UpdateReportMetadataInput): ReportMetadataCorrectionReceipt {
    const transaction = this.db.transaction(() => {
      const row = this.db.prepare(`
        SELECT r.id, r.person_id, r.event_id, r.title, r.organization, r.metadata_status,
               r.metadata_revision, e.clinical_date, e.date_precision, e.date_role, e.date_source,
               mr.payload_json
        FROM report_records r
        LEFT JOIN health_events_v2 e ON e.id = r.event_id
        LEFT JOIN report_metadata_revisions mr
          ON mr.report_id = r.id AND mr.revision = r.metadata_revision
        WHERE r.id = ? AND r.person_id = ?
      `).get(input.reportId, input.personId) as Record<string, unknown> | undefined;
      if (!row) throw new Error('REPORT_NOT_FOUND');
      const revision = Number(row.metadata_revision);
      if (revision !== input.expectedRevision) throw new RevisionConflictError(input.expectedRevision, revision);
      const payload = row.payload_json ? JSON.parse(String(row.payload_json)) as {
        extracted?: ReportMetadataCandidate | null;
        correction?: { department?: string | null } | null;
      } : {};
      const nextRevision = revision + 1;
      const timestamp = this.now().toISOString();
      const affectedSystemIds = this.systemIdsForReports([input.reportId]);
      const organization = input.organization?.trim() || null;
      const department = input.department?.trim() || null;
      const correction = {
        title: input.title.trim(), organization, department,
        clinicalTime: input.clinicalTime,
        reason: input.reason.trim()
      };
      const previous = {
        title: String(row.title),
        organization: row.organization === null ? null : String(row.organization),
        metadataStatus: String(row.metadata_status),
        clinicalDate: row.clinical_date === null ? null : String(row.clinical_date),
        datePrecision: row.date_precision === null ? 'unknown' : String(row.date_precision),
        dateRole: row.date_role === null ? 'unknown' : String(row.date_role),
        dateSource: row.date_source === null ? 'unknown' : String(row.date_source),
        correction: payload.correction ?? null
      };
      this.db.prepare(`
        UPDATE report_records
        SET title = ?, organization = ?, metadata_status = 'corrected', metadata_revision = ?
        WHERE id = ?
      `).run(correction.title, organization, nextRevision, input.reportId);
      if (row.event_id !== null) this.db.prepare(`
        UPDATE health_events_v2
        SET title = ?, clinical_date = ?, end_date = NULL, date_precision = ?, date_role = 'exam',
            date_source = 'corrected', metadata_status = 'corrected', metadata_revision = ?, updated_at = ?
        WHERE id = ?
      `).run(correction.title, correction.clinicalTime.value, correction.clinicalTime.precision, nextRevision, timestamp, String(row.event_id));
      this.db.prepare(`
        INSERT INTO report_metadata_revisions (
          report_id, revision, payload_json, actor, evidence_refs_json, created_at
        ) VALUES (?, ?, ?, 'user', '[]', ?)
      `).run(input.reportId, nextRevision, JSON.stringify({
        extracted: payload.extracted ?? null, correction, action: 'set', previous
      }), timestamp);
      this.db.prepare(`
        INSERT INTO person_revisions (person_id, fact_revision) VALUES (?, 1)
        ON CONFLICT(person_id) DO UPDATE SET fact_revision = fact_revision + 1
      `).run(input.personId);
      this.invalidateSystemSnapshots(input.personId, affectedSystemIds);
      this.db.prepare(`UPDATE derived_snapshots SET status = 'stale' WHERE person_id = ? AND status = 'current'`).run(input.personId);
      this.invalidateMemberAssessmentSnapshots(input.personId);
      this.db.prepare(`
        INSERT INTO audit_events (id, event_type, entity_id, summary, created_at)
        VALUES (?, 'report_metadata_corrected', ?, '用户修正了报告标题、机构、科室或临床日期；原始提取记录保持不变。', ?)
      `).run(randomUUID(), input.reportId, timestamp);
      return nextRevision;
    });
    const metadataRevision = transaction();
    return { reportId: input.reportId, metadataRevision, factRevision: this.getFactRevision(input.personId), canUndo: true };
  }

  undoReportMetadata(input: UndoReportMetadataInput): ReportMetadataCorrectionReceipt {
    const transaction = this.db.transaction(() => {
      const row = this.db.prepare(`
        SELECT r.id, r.person_id, r.event_id, r.metadata_revision, mr.payload_json
        FROM report_records r
        JOIN report_metadata_revisions mr ON mr.report_id = r.id AND mr.revision = r.metadata_revision
        WHERE r.id = ? AND r.person_id = ?
      `).get(input.reportId, input.personId) as Record<string, unknown> | undefined;
      if (!row) throw new Error('REPORT_NOT_FOUND');
      const revision = Number(row.metadata_revision);
      if (revision !== input.expectedRevision) throw new RevisionConflictError(input.expectedRevision, revision);
      const payload = JSON.parse(String(row.payload_json)) as {
        extracted?: ReportMetadataCandidate | null;
        action?: 'set' | 'undo';
        previous?: {
          title: string; organization: string | null; metadataStatus: string;
          clinicalDate: string | null; datePrecision: string; dateRole: string; dateSource: string;
          correction: { department?: string | null } | null;
        };
      };
      if (payload.action !== 'set' || !payload.previous) throw new Error('REPORT_METADATA_NOT_UNDOABLE');
      const nextRevision = revision + 1;
      const timestamp = this.now().toISOString();
      const affectedSystemIds = this.systemIdsForReports([input.reportId]);
      const previous = payload.previous;
      this.db.prepare(`
        UPDATE report_records
        SET title = ?, organization = ?, metadata_status = ?, metadata_revision = ?
        WHERE id = ?
      `).run(previous.title, previous.organization, previous.metadataStatus, nextRevision, input.reportId);
      if (row.event_id !== null) this.db.prepare(`
        UPDATE health_events_v2
        SET title = ?, clinical_date = ?, end_date = NULL, date_precision = ?, date_role = ?,
            date_source = ?, metadata_status = ?, metadata_revision = ?, updated_at = ?
        WHERE id = ?
      `).run(
        previous.title, previous.clinicalDate, previous.datePrecision, previous.dateRole,
        previous.dateSource, previous.metadataStatus, nextRevision, timestamp, String(row.event_id)
      );
      this.db.prepare(`
        INSERT INTO report_metadata_revisions (
          report_id, revision, payload_json, actor, evidence_refs_json, created_at
        ) VALUES (?, ?, ?, 'user', '[]', ?)
      `).run(input.reportId, nextRevision, JSON.stringify({
        extracted: payload.extracted ?? null, correction: previous.correction, action: 'undo'
      }), timestamp);
      this.db.prepare(`
        INSERT INTO person_revisions (person_id, fact_revision) VALUES (?, 1)
        ON CONFLICT(person_id) DO UPDATE SET fact_revision = fact_revision + 1
      `).run(input.personId);
      this.invalidateSystemSnapshots(input.personId, affectedSystemIds);
      this.db.prepare(`UPDATE derived_snapshots SET status = 'stale' WHERE person_id = ? AND status = 'current'`).run(input.personId);
      this.invalidateMemberAssessmentSnapshots(input.personId);
      this.db.prepare(`
        INSERT INTO audit_events (id, event_type, entity_id, summary, created_at)
        VALUES (?, 'report_metadata_correction_undone', ?, '用户撤销了上一次报告元数据修正；原始提取记录保持不变。', ?)
      `).run(randomUUID(), input.reportId, timestamp);
      return nextRevision;
    });
    const metadataRevision = transaction();
    return { reportId: input.reportId, metadataRevision, factRevision: this.getFactRevision(input.personId), canUndo: false };
  }

  private moveReportsBetweenEvents(reportIds: string[], fromEventId: string, toEventId: string): void {
    const deleteLink = this.db.prepare(`DELETE FROM event_report_links WHERE event_id = ? AND report_id = ?`);
    const insertLink = this.db.prepare(`INSERT OR IGNORE INTO event_report_links (event_id, report_id) VALUES (?, ?)`);
    const updateReport = this.db.prepare(`UPDATE report_records SET event_id = ? WHERE id = ? AND event_id = ?`);
    for (const reportId of reportIds) {
      const changed = updateReport.run(toEventId, reportId, fromEventId).changes;
      if (changed !== 1) throw new Error('EVENT_RELATION_CHANGED');
      deleteLink.run(fromEventId, reportId);
      insertLink.run(toEventId, reportId);
    }
  }

  private systemIdsForDocuments(documentIds: string[]): string[] {
    if (documentIds.length === 0) return [];
    const placeholders = documentIds.map(() => '?').join(',');
    const linkedRows = this.db.prepare(`
      SELECT DISTINCT sfl.system_id
      FROM observations o
      JOIN observation_revisions r
        ON r.observation_id = o.id AND r.revision = o.current_revision
      JOIN source_spans ss ON ss.id = r.source_span_id
      JOIN system_fact_links sfl
        ON sfl.observation_id = o.id AND sfl.observation_revision = o.current_revision
      WHERE ss.document_id IN (${placeholders})
    `).all(...documentIds) as Array<{ system_id: string }>;
    const correctedRows = this.db.prepare(`
      SELECT DISTINCT c.concept_id
      FROM observations o
      JOIN observation_revisions r
        ON r.observation_id = o.id AND r.revision = o.current_revision
      JOIN source_spans ss ON ss.id = r.source_span_id
      JOIN concept_mapping_corrections c
        ON c.observation_id = o.id AND c.observation_revision = o.current_revision AND c.active = 1
      WHERE ss.document_id IN (${placeholders}) AND c.concept_id IS NOT NULL
    `).all(...documentIds) as Array<{ concept_id: string }>;
    const systemIds = new Set(linkedRows.map((row) => row.system_id));
    for (const row of correctedRows) {
      const definition = conceptDictionary.find((item) => item.id === row.concept_id);
      for (const link of definition?.systemLinks ?? []) systemIds.add(link.systemId);
    }
    return [...systemIds].sort();
  }

  private systemIdsForReports(reportIds: string[]): string[] {
    if (reportIds.length === 0) return [];
    const placeholders = reportIds.map(() => '?').join(',');
    const documentIds = (this.db.prepare(`
      SELECT DISTINCT document_id FROM report_source_links
      WHERE report_id IN (${placeholders})
    `).all(...reportIds) as Array<{ document_id: string }>).map((row) => row.document_id);
    return this.systemIdsForDocuments(documentIds);
  }

  private invalidateSystemSnapshots(personId: string, systemIds: string[]): void {
    if (systemIds.length === 0) return;
    this.db.prepare(`
      UPDATE system_analysis_snapshots_v2 SET status = 'stale'
      WHERE person_id = ? AND status = 'current'
        AND system_id IN (${systemIds.map(() => '?').join(',')})
    `).run(personId, ...systemIds);
  }

  private invalidateAfterEventRelationChange(personId: string, reportIds: string[]): number {
    this.db.prepare(`
      INSERT INTO person_revisions (person_id, fact_revision) VALUES (?, 1)
      ON CONFLICT(person_id) DO UPDATE SET fact_revision = fact_revision + 1
    `).run(personId);
    this.invalidateSystemSnapshots(personId, this.systemIdsForReports(reportIds));
    this.db.prepare(`UPDATE derived_snapshots SET status = 'stale' WHERE person_id = ? AND status = 'current'`).run(personId);
    this.invalidateMemberAssessmentSnapshots(personId);
    return this.getFactRevision(personId);
  }

  mergeHealthEvents(input: MergeHealthEventsInput): HealthEventRelationReceipt {
    if (input.targetEventId === input.sourceEventId) throw new Error('EVENTS_MUST_BE_DIFFERENT');
    const transaction = this.db.transaction(() => {
      const events = this.db.prepare(`
        SELECT id FROM health_events_v2 WHERE person_id = ? AND id IN (?, ?)
      `).all(input.personId, input.targetEventId, input.sourceEventId) as Array<{ id: string }>;
      if (events.length !== 2) throw new Error('HEALTH_EVENT_NOT_FOUND');
      const targetHasReport = this.db.prepare(`SELECT 1 FROM event_report_links WHERE event_id = ? LIMIT 1`).get(input.targetEventId);
      if (!targetHasReport) throw new Error('TARGET_EVENT_EMPTY');
      const reportIds = (this.db.prepare(`SELECT report_id FROM event_report_links WHERE event_id = ? ORDER BY report_id`).all(input.sourceEventId) as Array<{ report_id: string }>).map((row) => row.report_id);
      if (reportIds.length === 0) throw new Error('SOURCE_EVENT_EMPTY');
      this.moveReportsBetweenEvents(reportIds, input.sourceEventId, input.targetEventId);
      const changeId = randomUUID();
      const timestamp = this.now().toISOString();
      this.db.prepare(`
        INSERT INTO event_relation_changes (
          id, person_id, action, from_event_id, to_event_id, report_ids_json,
          reason, active, parent_change_id, created_at
        ) VALUES (?, ?, 'merge', ?, ?, ?, ?, 1, NULL, ?)
      `).run(changeId, input.personId, input.sourceEventId, input.targetEventId, JSON.stringify(reportIds), input.reason.trim(), timestamp);
      const factRevision = this.invalidateAfterEventRelationChange(input.personId, reportIds);
      this.db.prepare(`
        INSERT INTO audit_events (id, event_type, entity_id, summary, created_at)
        VALUES (?, 'health_events_merged', ?, '用户将两个健康事件合并；原始报告与事实保持不变，可撤销。', ?)
      `).run(randomUUID(), changeId, timestamp);
      return { changeId, reportIds, factRevision };
    });
    const result = transaction();
    return { ...result, eventIds: [input.targetEventId, input.sourceEventId], canUndo: true };
  }

  splitHealthEvent(input: SplitHealthEventInput): HealthEventRelationReceipt {
    const transaction = this.db.transaction(() => {
      const event = this.db.prepare(`SELECT * FROM health_events_v2 WHERE id = ? AND person_id = ?`).get(input.eventId, input.personId) as Record<string, unknown> | undefined;
      if (!event) throw new Error('HEALTH_EVENT_NOT_FOUND');
      const reportIds = (this.db.prepare(`SELECT report_id FROM event_report_links WHERE event_id = ? ORDER BY report_id`).all(input.eventId) as Array<{ report_id: string }>).map((row) => row.report_id);
      if (!reportIds.includes(input.reportId)) throw new Error('REPORT_NOT_IN_EVENT');
      if (reportIds.length < 2) throw new Error('EVENT_HAS_SINGLE_REPORT');
      const newEventId = randomUUID();
      const timestamp = this.now().toISOString();
      this.db.prepare(`
        INSERT INTO health_events_v2 (
          id, person_id, type, title, clinical_date, end_date, date_precision, date_role,
          date_source, metadata_status, metadata_revision, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        newEventId, input.personId, event.type, event.title, event.clinical_date, event.end_date,
        event.date_precision, event.date_role, 'corrected', 'corrected', event.metadata_revision, timestamp, timestamp
      );
      this.moveReportsBetweenEvents([input.reportId], input.eventId, newEventId);
      const changeId = randomUUID();
      this.db.prepare(`
        INSERT INTO event_relation_changes (
          id, person_id, action, from_event_id, to_event_id, report_ids_json,
          reason, active, parent_change_id, created_at
        ) VALUES (?, ?, 'split', ?, ?, ?, ?, 1, NULL, ?)
      `).run(changeId, input.personId, input.eventId, newEventId, JSON.stringify([input.reportId]), input.reason.trim(), timestamp);
      const factRevision = this.invalidateAfterEventRelationChange(input.personId, [input.reportId]);
      this.db.prepare(`
        INSERT INTO audit_events (id, event_type, entity_id, summary, created_at)
        VALUES (?, 'health_event_split', ?, '用户从健康事件中拆出一份报告；原始报告与事实保持不变，可撤销。', ?)
      `).run(randomUUID(), changeId, timestamp);
      return { changeId, newEventId, factRevision };
    });
    const result = transaction();
    return { changeId: result.changeId, eventIds: [input.eventId, result.newEventId], reportIds: [input.reportId], factRevision: result.factRevision, canUndo: true };
  }

  undoHealthEventRelation(input: UndoHealthEventRelationInput): HealthEventRelationReceipt {
    const transaction = this.db.transaction(() => {
      const change = this.db.prepare(`
        SELECT * FROM event_relation_changes WHERE id = ? AND person_id = ? AND active = 1 AND action IN ('merge','split')
      `).get(input.changeId, input.personId) as Record<string, unknown> | undefined;
      if (!change) throw new Error('EVENT_RELATION_NOT_UNDOABLE');
      const reportIds = JSON.parse(String(change.report_ids_json)) as string[];
      const fromEventId = String(change.from_event_id);
      const toEventId = String(change.to_event_id);
      this.moveReportsBetweenEvents(reportIds, toEventId, fromEventId);
      this.db.prepare(`UPDATE event_relation_changes SET active = 0 WHERE id = ?`).run(input.changeId);
      const undoId = randomUUID();
      const timestamp = this.now().toISOString();
      this.db.prepare(`
        INSERT INTO event_relation_changes (
          id, person_id, action, from_event_id, to_event_id, report_ids_json,
          reason, active, parent_change_id, created_at
        ) VALUES (?, ?, 'undo', ?, ?, ?, '撤销上一次事件关系修改', 0, ?, ?)
      `).run(undoId, input.personId, toEventId, fromEventId, JSON.stringify(reportIds), input.changeId, timestamp);
      const factRevision = this.invalidateAfterEventRelationChange(input.personId, reportIds);
      this.db.prepare(`
        INSERT INTO audit_events (id, event_type, entity_id, summary, created_at)
        VALUES (?, 'health_event_relation_undone', ?, '用户撤销了上一次健康事件合并或拆分。', ?)
      `).run(randomUUID(), input.changeId, timestamp);
      return { undoId, reportIds, fromEventId, toEventId, factRevision };
    });
    const result = transaction();
    return { changeId: result.undoId, eventIds: [result.fromEventId, result.toEventId], reportIds: result.reportIds, factRevision: result.factRevision, canUndo: false };
  }

  getDerivedContext(personId: string): { person: Person; notes: ManualNote[] } {
    const person = this.listPersons().find((item) => item.id === personId && item.archivedAt === null);
    if (!person) throw new Error('PERSON_NOT_FOUND');
    return { person, notes: this.listManualNotes(personId) };
  }

  getClinicalContextRevision(personId: string): number {
    return this.getPersonRevision(personId, 'clinical_context_revision');
  }

  publishDerivedSnapshot(input: {
    candidate: DerivedSnapshotCandidate;
    expectedFactRevision: number;
    expectedContextRevision: number;
    promptVersion: string;
    rulesVersion: string;
    modelId: string;
    executionGuard?: JobExecutionGuard;
  }): { snapshotId: string; idempotent: boolean } {
    const { candidate } = input;
    if (candidate.factRevision !== input.expectedFactRevision) throw new Error('DERIVED_FACT_REVISION_MISMATCH');
    const payloadJson = JSON.stringify(candidate);
    const existing = this.db.prepare(`
      SELECT id FROM derived_snapshots
      WHERE person_id = ? AND fact_revision = ? AND context_revision = ?
        AND prompt_version = ? AND rules_version = ? AND model_id = ?
        AND payload_json = ? AND status = 'current'
      LIMIT 1
    `).get(
      candidate.personId, input.expectedFactRevision, input.expectedContextRevision,
      input.promptVersion, input.rulesVersion, input.modelId, payloadJson
    ) as { id: string } | undefined;
    if (existing) return { snapshotId: existing.id, idempotent: true };

    const transaction = this.db.transaction(() => {
      if (input.executionGuard) this.assertJobExecutionActive(input.executionGuard);
      const actualFactRevision = this.getFactRevision(candidate.personId);
      const actualContextRevision = this.getClinicalContextRevision(candidate.personId);
      if (actualFactRevision !== input.expectedFactRevision) {
        throw new RevisionConflictError(input.expectedFactRevision, actualFactRevision);
      }
      if (actualContextRevision !== input.expectedContextRevision) throw new Error('CLINICAL_CONTEXT_REVISION_CONFLICT');

      const allItems = [
        ...candidate.claims.map((item) => ({ id: item.id, evidence: item.evidenceObservationIds })),
        ...candidate.lifestyleGuidance.map((item) => ({ id: item.id, evidence: item.evidenceObservationIds }))
      ];
      const itemIds = new Set(allItems.map((item) => item.id));
      if (itemIds.size !== allItems.length) throw new Error('DERIVED_ITEM_ID_DUPLICATE');
      const observationIds = [...new Set(allItems.flatMap((item) => item.evidence))];
      const observations = observationIds.length === 0 ? [] : this.db.prepare(`
        SELECT o.id, o.current_revision, r.source_span_id
        FROM observations o
        JOIN observation_revisions r
          ON r.observation_id = o.id AND r.revision = o.current_revision
        WHERE o.person_id = ? AND o.id IN (${observationIds.map(() => '?').join(',')})
      `).all(candidate.personId, ...observationIds) as Array<{ id: string; current_revision: number; source_span_id: string }>;
      const byObservation = new Map(observations.map((observation) => [observation.id, observation]));
      if (byObservation.size !== observationIds.length) throw new Error('DERIVED_EVIDENCE_MISMATCH');

      const snapshotId = randomUUID();
      this.db.prepare(`UPDATE derived_snapshots SET status = 'stale' WHERE person_id = ? AND status = 'current'`).run(candidate.personId);
      this.db.prepare(`
        INSERT INTO derived_snapshots (
          id, person_id, fact_revision, context_revision, prompt_version,
          rules_version, model_id, coverage_json, payload_json, status, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'current', ?)
      `).run(
        snapshotId, candidate.personId, input.expectedFactRevision, input.expectedContextRevision,
        input.promptVersion, input.rulesVersion, input.modelId,
        JSON.stringify({ observationIds }), payloadJson, this.now().toISOString()
      );
      const proposalTimestamp = this.now().toISOString();
      const dismissedDedupeKeys = new Set((this.db.prepare(`
        SELECT DISTINCT json_extract(structure_json, '$.dedupeKey') AS dedupe_key
        FROM lifestyle_proposals_v2
        WHERE person_id = ? AND status = 'dismissed'
          AND json_extract(structure_json, '$.dedupeKey') IS NOT NULL
      `).all(candidate.personId) as Array<{ dedupe_key: string }>).map((row) => row.dedupe_key));
      const adoptedDedupeKeys = new Set((this.db.prepare(`
        SELECT DISTINCT json_extract(structure_json, '$.dedupeKey') AS dedupe_key
        FROM lifestyle_proposals_v2
        WHERE person_id = ? AND status = 'adopted'
          AND json_extract(structure_json, '$.dedupeKey') IS NOT NULL
      `).all(candidate.personId) as Array<{ dedupe_key: string }>).map((row) => row.dedupe_key));
      this.db.prepare(`
        UPDATE lifestyle_proposals_v2
        SET status = 'superseded', updated_at = ?
        WHERE person_id = ? AND status IN ('proposed', 'dismissed')
      `).run(proposalTimestamp, candidate.personId);
      const proposalInsert = this.db.prepare(`
        INSERT INTO lifestyle_proposals_v2 (
          id, person_id, category, title, detail, consult_professional,
          evidence_refs_json, structure_json, status, source_snapshot_id, version, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
      `);
      for (const guidance of candidate.lifestyleGuidance) {
        const generalKnowledgeEvidence = guidance.generalKnowledgeEvidence.map((knowledge) => {
          const id = `knowledge-${createHash('sha256').update(JSON.stringify({
            sourceTitle: knowledge.sourceTitle,
            sourceOrganization: knowledge.sourceOrganization,
            sourceUrl: knowledge.sourceUrl,
            reviewedAt: knowledge.reviewedAt,
            supportedScope: knowledge.supportedScope
          })).digest('hex').slice(0, 24)}`;
          // 模型填写的网址、机构和“核对日期”只是来源候选。在受控获取、
          // 原文定位和审核记录完成前，不写入 knowledge_entries，也不宣称已独立核验。
          return { ...knowledge, id, verificationStatus: 'unverified_model_candidate' as const };
        });
        // 同一方向一旦被用户采纳，新一轮模型输出只更新快照，不再重复要求用户确认。
        // 原提案及其行动保持不变，继续作为用户决定的来源记录。
        if (adoptedDedupeKeys.has(guidance.dedupeKey)) continue;
        proposalInsert.run(
          randomUUID(),
          candidate.personId,
          guidance.category,
          guidance.title,
          guidance.detail,
          guidance.consultProfessional ? 1 : 0,
          JSON.stringify(guidance.evidenceObservationIds),
          JSON.stringify({
            dedupeKey: guidance.dedupeKey,
            goal: guidance.goal,
            rationale: guidance.rationale,
            steps: guidance.steps,
            startingOptions: guidance.startingOptions,
            scheduleSuggestion: guidance.scheduleSuggestion,
            trackingSuggestion: guidance.trackingSuggestion,
            constraints: guidance.constraints,
            uncertainties: guidance.uncertainties,
            generalKnowledgeEvidence,
            sourceKind: guidance.sourceKind,
            relatedSystemIds: guidance.relatedSystemIds
          }),
          dismissedDedupeKeys.has(guidance.dedupeKey) ? 'dismissed' : 'proposed',
          snapshotId,
          proposalTimestamp,
          proposalTimestamp
        );
      }
      const evidenceInsert = this.db.prepare(`
        INSERT INTO snapshot_evidence (
          snapshot_id, claim_id, observation_revision_id, source_span_id
        ) VALUES (?, ?, ?, ?)
      `);
      for (const item of allItems) {
        for (const observationId of item.evidence) {
          const observation = byObservation.get(observationId)!;
          evidenceInsert.run(snapshotId, `${item.id}:${observationId}`, `${observation.id}:${observation.current_revision}`, observation.source_span_id);
        }
      }
      return { snapshotId, idempotent: false };
    });
    return transaction();
  }

  listCurrentDerivedSnapshots(): PublishedDerivedSnapshot[] {
    const rows = this.db.prepare(`
      SELECT id, person_id, fact_revision, context_revision, prompt_version, rules_version, model_id,
             status, payload_json, created_at
      FROM derived_snapshots WHERE status = 'current' ORDER BY created_at, id
    `).all() as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      id: String(row.id),
      personId: String(row.person_id),
      factRevision: Number(row.fact_revision),
      contextRevision: Number(row.context_revision),
      promptVersion: String(row.prompt_version),
      rulesVersion: String(row.rules_version),
      modelId: String(row.model_id),
      status: String(row.status) as PublishedDerivedSnapshot['status'],
      payload: JSON.parse(String(row.payload_json)) as DerivedSnapshotCandidate,
      createdAt: String(row.created_at)
    }));
  }

  listLatestDerivedSnapshots(): PublishedDerivedSnapshot[] {
    const rows = this.db.prepare(`
      SELECT id, person_id, fact_revision, context_revision, prompt_version, rules_version, model_id,
             status, payload_json, created_at
      FROM derived_snapshots
      ORDER BY person_id, created_at DESC, rowid DESC
    `).all() as Array<Record<string, unknown>>;
    const seen = new Set<string>();
    return rows.flatMap((row) => {
      const personId = String(row.person_id);
      if (seen.has(personId)) return [];
      seen.add(personId);
      return [{
        id: String(row.id),
        personId,
        factRevision: Number(row.fact_revision),
        contextRevision: Number(row.context_revision),
        promptVersion: String(row.prompt_version),
        rulesVersion: String(row.rules_version),
        modelId: String(row.model_id),
        status: String(row.status) as PublishedDerivedSnapshot['status'],
        payload: JSON.parse(String(row.payload_json)) as DerivedSnapshotCandidate,
        createdAt: String(row.created_at)
      }];
    });
  }

  listSystemAnalysisSnapshots(personId?: string, currentOnly = false): PublishedSystemAnalysisSnapshot[] {
    const rows = this.db.prepare(`
      SELECT id, person_id, system_id, fact_revision, prompt_version, evidence_bundle_hash,
             payload_json, status, created_at
      FROM system_analysis_snapshots_v2
      WHERE (? IS NULL OR person_id = ?) AND (? = 0 OR status = 'current')
      ORDER BY person_id, system_id, created_at DESC, id DESC
    `).all(personId ?? null, personId ?? null, currentOnly ? 1 : 0) as Array<Record<string, unknown>>;
    return rows.map((row) => {
      const payload = JSON.parse(String(row.payload_json)) as Omit<SystemAnalysisSnapshot, 'id' | 'status' | 'generatedAt'>;
      return {
        ...payload,
        id: String(row.id),
        status: String(row.status) as SystemAnalysisSnapshot['status'],
        generatedAt: String(row.created_at)
      };
    });
  }

  listMemberAssessmentSnapshots(personId?: string, currentOnly = false): MemberAssessmentSnapshotV3[] {
    const rows = this.db.prepare(`
      SELECT id, person_id, fact_revision, context_revision, payload_json, status, created_at
      FROM member_assessment_snapshots_v3
      WHERE (? IS NULL OR person_id = ?) AND (? = 0 OR status = 'current')
      ORDER BY created_at DESC, rowid DESC
    `).all(personId ?? null, personId ?? null, currentOnly ? 1 : 0) as Array<{
      id: string; person_id: string; fact_revision: number; context_revision: number;
      payload_json: string; status: 'current' | 'stale'; created_at: string
    }>;
    return rows.flatMap((row) => {
      const snapshot = JSON.parse(row.payload_json) as MemberAssessmentSnapshotV3;
      if (currentOnly && (row.fact_revision !== this.getFactRevision(row.person_id)
        || row.context_revision !== this.getClinicalContextRevision(row.person_id)
        || snapshot.reviewScopeSignature !== this.getOpenReviewScopeSignature(row.person_id))) return [];
      return [{ ...snapshot, id: row.id, status: row.status, generatedAt: row.created_at }];
    });
  }

  hasMemberAssessmentHistory(personId: string): boolean {
    return Boolean(this.db.prepare(`
      SELECT 1 FROM member_assessment_snapshots_v3 WHERE person_id = ? LIMIT 1
    `).get(personId));
  }

  publishMemberAssessmentSnapshot(input: {
    snapshot: Omit<MemberAssessmentSnapshotV3, 'id' | 'status' | 'generatedAt'>;
    executionGuard?: JobExecutionGuard;
  }): { snapshotId: string; idempotent: boolean } {
    const { snapshot } = input;
    const transaction = this.db.transaction(() => {
      if (input.executionGuard) this.assertJobExecutionActive(input.executionGuard);
      // 写库边界重新检查完整契约与节点关系；不能只信任上游 TypeScript 类型或模型字段。
      const candidateId = randomUUID();
      const candidateTimestamp = this.now().toISOString();
      if (!memberAssessmentSnapshotV3Schema.safeParse({ ...snapshot,
        id: candidateId, status: 'current', generatedAt: candidateTimestamp }).success) {
        throw new Error('MEMBER_ASSESSMENT_SCHEMA_INVALID');
      }
      // 私有审计不是接纳凭据；只解释本轮已隔离/重建的节点，不能新增生效节点或跨成员引用。
      if (!assessmentReviewAuditScopeValid(snapshot) || snapshot.reviewAuditRecords?.records.some((record) => {
        const { recordHash, ...body } = record;
        return stableHash(body) !== recordHash;
      })) throw new Error('MEMBER_ASSESSMENT_REVIEW_AUDIT_INVALID');
      const claimIds = new Set(snapshot.claims.map((claim) => claim.id));
      const actionIds = new Set(snapshot.actions.map((action) => action.id));
      const systemIds = new Set(snapshot.systems.map((system) => system.id));
      const questionIds = new Set(snapshot.questions.map((question) => question.id));
      const evidenceIds = new Set(snapshot.evidenceCatalog.map((evidence) => evidence.id));
      const knowledgeIds = new Set(snapshot.knowledgeSources.map((source) => source.id));
      const liveNodeIds = ['overview', ...claimIds, ...actionIds, ...systemIds, ...questionIds];
      if (new Set(liveNodeIds).size !== liveNodeIds.length
        || evidenceIds.size !== snapshot.evidenceCatalog.length
        || knowledgeIds.size !== snapshot.knowledgeSources.length
        || snapshot.heldTargetIds.some((id) => liveNodeIds.includes(id))) {
        throw new Error('MEMBER_ASSESSMENT_HELD_OR_DUPLICATE_NODE');
      }
      const referencesValid = snapshot.overview.claimIds.every((id) => claimIds.has(id))
        && snapshot.overview.actionIds.every((id) => actionIds.has(id))
        && snapshot.systems.every((system) => system.id === `system:${system.systemId}`
          && system.claimIds.every((id) => claimIds.has(id))
          && system.actionIds.every((id) => actionIds.has(id)))
        && snapshot.actions.every((action) => action.claimIds.every((id) => claimIds.has(id)))
        && snapshot.questions.every((question) => question.relatedClaimIds.every((id) => claimIds.has(id)))
        && snapshot.claims.every((claim) => [...claim.evidenceIds, ...claim.counterEvidenceIds,
          ...(claim.criteriaBasis?.requirements.flatMap((requirement) => requirement.evidenceIds) ?? [])]
          .every((id) => evidenceIds.has(id)) && claim.knowledgeSourceIds.every((id) => knowledgeIds.has(id)))
        && snapshot.actions.every((action) => action.evidenceIds.every((id) => evidenceIds.has(id))
          && action.knowledgeSourceIds.every((id) => knowledgeIds.has(id)))
        && snapshot.questions.every((question) => question.evidenceIds.every((id) => evidenceIds.has(id)));
      if (!referencesValid) throw new Error('MEMBER_ASSESSMENT_REFERENCE_INVALID');
      if (this.getFactRevision(snapshot.personId) !== snapshot.factRevision) throw new Error('MEMBER_ASSESSMENT_FACT_REVISION_CONFLICT');
      if (this.getClinicalContextRevision(snapshot.personId) !== snapshot.contextRevision) throw new Error('MEMBER_ASSESSMENT_CONTEXT_REVISION_CONFLICT');
      if (this.getOpenReviewScopeSignature(snapshot.personId) !== snapshot.reviewScopeSignature) {
        throw new Error('MEMBER_ASSESSMENT_REVIEW_SCOPE_CONFLICT');
      }
      const observations = this.listAcceptedObservations(snapshot.personId);
      if (input.executionGuard) this.assertObservationScopeActive(input.executionGuard, snapshot.personId, observations);
      const currentObservationIds = new Set(observations.map((item) => item.id));
      if (snapshot.reviewAuditRecords?.records.some((record) => record.boundObservationIds
        .some((id) => !currentObservationIds.has(id)))) {
        throw new Error('MEMBER_ASSESSMENT_REVIEW_AUDIT_EVIDENCE_MISMATCH');
      }
      const evidenceObservationIds = snapshot.evidenceCatalog
        .map((item) => item.observationId).filter((id): id is string => id !== null);
      if (evidenceObservationIds.some((id) => !currentObservationIds.has(id))) throw new Error('MEMBER_ASSESSMENT_EVIDENCE_MISMATCH');
      const existing = this.db.prepare(`
        SELECT id FROM member_assessment_snapshots_v3
        WHERE person_id = ? AND input_signature = ? AND status = 'current' LIMIT 1
      `).get(snapshot.personId, snapshot.inputSignature) as { id: string } | undefined;
      if (existing) return { snapshotId: existing.id, idempotent: true };
      const snapshotId = randomUUID();
      const timestamp = this.now().toISOString();
      this.db.prepare(`UPDATE member_assessment_snapshots_v3 SET status = 'stale' WHERE person_id = ? AND status = 'current'`)
        .run(snapshot.personId);
      this.db.prepare(`
        INSERT INTO member_assessment_snapshots_v3 (
          id, person_id, input_signature, fact_revision, context_revision,
          prompt_version, rules_version, model_id, reasoning_effort, validation_mode,
          payload_json, status, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'current', ?)
      `).run(snapshotId, snapshot.personId, snapshot.inputSignature, snapshot.factRevision,
        snapshot.contextRevision, snapshot.promptVersion, snapshot.rulesVersion,
        snapshot.modelId, snapshot.reasoningEffort, snapshot.validationMode,
        JSON.stringify(snapshot), timestamp);
      return { snapshotId, idempotent: false };
    });
    return transaction();
  }

  publishSystemAnalysisSnapshot(input: {
    snapshot: Omit<SystemAnalysisSnapshot, 'id' | 'status' | 'generatedAt'>;
    evidenceBundle: SystemEvidenceBundle;
    expectedContextRevision: number;
    rulesVersion: string;
    modelId: string;
    executionGuard?: JobExecutionGuard;
  }): { snapshotId: string; idempotent: boolean } {
    const { snapshot, evidenceBundle } = input;
    if (snapshot.personId !== evidenceBundle.identity.personId
      || snapshot.systemId !== evidenceBundle.identity.systemId
      || snapshot.inputSignature !== evidenceBundle.scope.inputSignature
      || snapshot.factRevision !== evidenceBundle.scope.factRevision) {
      throw new Error('SYSTEM_ANALYSIS_SCOPE_MISMATCH');
    }
    const existing = this.db.prepare(`
      SELECT id FROM system_analysis_snapshots_v2
      WHERE person_id = ? AND system_id = ? AND evidence_bundle_hash = ?
        AND prompt_version = ? AND rules_version = ? AND model_id = ? AND status = 'current'
      LIMIT 1
    `).get(
      snapshot.personId, snapshot.systemId, snapshot.inputSignature,
      snapshot.promptVersion, input.rulesVersion, input.modelId
    ) as { id: string } | undefined;
    if (existing) return { snapshotId: existing.id, idempotent: true };

    const transaction = this.db.transaction(() => {
      if (input.executionGuard) this.assertJobExecutionActive(input.executionGuard);
      const actualFactRevision = this.getFactRevision(snapshot.personId);
      const actualContextRevision = this.getClinicalContextRevision(snapshot.personId);
      if (actualFactRevision !== snapshot.factRevision) {
        throw new RevisionConflictError(snapshot.factRevision, actualFactRevision);
      }
      if (actualContextRevision !== input.expectedContextRevision
        || actualContextRevision !== evidenceBundle.scope.contextRevision) {
        throw new Error('CLINICAL_CONTEXT_REVISION_CONFLICT');
      }
      const observationIds = [...new Set([
        ...evidenceBundle.directFacts,
        ...evidenceBundle.contextFacts
      ].map((fact) => fact.observationId))];
      if (observationIds.length > 0) {
        const count = this.db.prepare(`
          SELECT COUNT(*) AS count FROM observations
          WHERE person_id = ? AND id IN (${observationIds.map(() => '?').join(',')})
        `).get(snapshot.personId, ...observationIds) as { count: number };
        if (Number(count.count) !== observationIds.length) throw new Error('SYSTEM_ANALYSIS_EVIDENCE_MISMATCH');
      }

      const snapshotId = randomUUID();
      const timestamp = this.now().toISOString();
      this.db.prepare(`
        UPDATE system_analysis_snapshots_v2 SET status = 'stale'
        WHERE person_id = ? AND system_id = ? AND status = 'current'
      `).run(snapshot.personId, snapshot.systemId);
      this.db.prepare(`
        INSERT INTO system_analysis_snapshots_v2 (
          id, person_id, system_id, fact_revision, context_revision, prompt_version,
          rules_version, model_id, evidence_bundle_hash, coverage_json,
          payload_json, status, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'current', ?)
      `).run(
        snapshotId, snapshot.personId, snapshot.systemId, snapshot.factRevision,
        input.expectedContextRevision, snapshot.promptVersion, input.rulesVersion,
        input.modelId, snapshot.inputSignature, JSON.stringify(snapshot.coverage),
        JSON.stringify(snapshot), timestamp
      );
      const dependencyInsert = this.db.prepare(`
        INSERT OR REPLACE INTO derivation_dependencies (
          derived_kind, derived_id, dependency_kind, dependency_id, dependency_revision, created_at
        ) VALUES ('system_analysis', ?, ?, ?, ?, ?)
      `);
      for (const observationId of observationIds) {
        dependencyInsert.run(snapshotId, 'observation', observationId, String(snapshot.factRevision), timestamp);
      }
      for (const context of evidenceBundle.personalContext) {
        dependencyInsert.run(snapshotId, 'personal_context', context.id, String(input.expectedContextRevision), timestamp);
      }
      dependencyInsert.run(snapshotId, 'selector', snapshot.systemId, `${BODY_SYSTEM_REGISTRY_VERSION}:${CONCEPT_DICTIONARY_VERSION}`, timestamp);
      return { snapshotId, idempotent: false };
    });
    return transaction();
  }

  private optionalReportSourceManifest(documentId: string): SourceManifest | null {
    return this.db.prepare('SELECT 1 FROM source_manifests WHERE document_id=?').get(documentId)
      ? this.getDocumentExtractionBundle(documentId).manifest : null;
  }

  private isDirectOriginalManifest(manifest: SourceManifest | null): boolean {
    return Boolean(manifest && (manifest.normalizerVersion.startsWith('direct-original')
      || manifest.spans.some((span) => span.modelEvidence)));
  }

  /** 只核验模型日期角色与同原件出处，不由项目值、数组顺序或签发时间推断主要日期。 */
  private reportTimeEvidenceProblem(documentId: string, time: ReportMetadataCandidate['times'][number],
    metadata: ReportMetadataCandidate, manifest: SourceManifest | null): string | null {
    if (!manifest || time.evidence.length === 0) return 'report_metadata_date_evidence_unverified';
    // 同一天可同时是本次检查和历史转述；只校验本条日期自己的出处，不能按同值污染角色。
    const byId = new Map(manifest.spans.map((span) => [span.id, span]));
    const compact = (value: string) => value.normalize('NFKC').replace(/\s+/gu, '');
    for (const reference of time.evidence) {
      const owner = this.db.prepare('SELECT document_id FROM source_spans WHERE id=?').get(reference.sourceSpanId) as { document_id: string } | undefined;
      if (owner && owner.document_id !== documentId) throw new Error('COMMITTED_REPORT_METADATA_DOCUMENT_SCOPE_MISMATCH');
      const span = byId.get(reference.sourceSpanId);
      if (!span || span.documentId !== documentId || span.readability !== 'clear' || !span.quote
        || !(reference.quote === null && span.modelEvidence || reference.quote && compact(span.quote).includes(compact(reference.quote)))) {
        return 'report_metadata_date_evidence_unverified';
      }
    }
    const role = time.role === 'report_issued' ? 'report_issued' : 'clinical';
    const proven = time.evidence.some((reference) => {
      const span = byId.get(reference.sourceSpanId)!;
      if (span.modelEvidence) {
        return trustedDirectReportTime(time, manifest, documentId);
      }
      // 旧入口已声明的唯一月/年就诊日期保留原精度，只验证原文确实写出该部分日期。
      // 这不适用于新selector、整日日期或direct原件，更不把部分日期补成某一天。
      if (metadata.primaryClinicalTimeIndex === undefined && time.precision !== 'day'
        && !this.isDirectOriginalManifest(manifest) && ['sampled', 'examined', 'encounter'].includes(time.role)) {
        return Boolean(reference.quote && new RegExp(`(?:^|[^\\d])${time.value}(?![\\d-])`, 'u')
          .test(reference.quote.normalize('NFKC')));
      }
      // 旧文本管线的证据仍须有明确角色标签；不以日期本身的长相推断角色。
      const context = orderedDateSourceContext(manifest, reference.sourceSpanId);
      return Boolean(reference.quote && context && hasCurrentLabelledSourceDate(reference.quote, time.value, role)
        && hasCurrentLabelledSourceDate(context.text, time.value, role, context.minimumIndex));
    });
    return proven ? null : 'report_metadata_date_role_unverified';
  }

  private selectPrimaryClinicalTime(documentId: string, metadata: ReportMetadataCandidate | null | undefined,
    manifest: SourceManifest | null): PrimaryClinicalTimeSelection {
    const unknown = (): PrimaryClinicalTimeSelection => ({ time: null, heldReasonCodes: [], heldEvidenceRefs: [] });
    if (!metadata || metadata.primaryClinicalTimeIndex === null) return unknown();
    const fail = (reason: string, times: ReportMetadataCandidate['times']): PrimaryClinicalTimeSelection => ({
      time: null, heldReasonCodes: [reason], heldEvidenceRefs: [...new Set(times.flatMap((time) => time.evidence.map((ref) => ref.sourceSpanId)))],
      diagnostics: [{ scope: 'current_reading', reasonCodes: [reason], current: times, comparisons: [],
        sourceSpans: admissionDiagnosticSourceSpans(manifest, documentId, times.flatMap((time) => time.evidence)) }]
    });
    const index = metadata.primaryClinicalTimeIndex;
    const current = metadata.times.filter((time) => ['sampled', 'examined', 'encounter'].includes(time.role));
    const selected = index === undefined
      ? new Set(current.map((time) => `${time.precision}:${time.value}`)).size === 1 ? current[0] : undefined
      : metadata.times[index];
    if (index !== undefined && (!Number.isInteger(index) || index < 0 || !selected
      || !['sampled', 'examined', 'encounter'].includes(selected.role))) {
      return fail('report_metadata_primary_clinical_time_invalid', metadata.times);
    }
    if (!selected) return unknown();
    const issue = this.reportTimeEvidenceProblem(documentId, selected, metadata, manifest);
    return issue ? fail(issue, [selected]) : { ...unknown(), time: selected };
  }

  private findStrongMetadataEventMatch(personId: string, documentId: string,
    metadata: ReportMetadataCandidate | null | undefined, manifest: SourceManifest | null): string | null {
    if (!metadata?.organization?.value) return null;
    const normalized = (value: string) => value.normalize('NFKC').trim().toLocaleLowerCase('zh-CN');
    const organization = normalized(metadata.organization.value);
    const clinicalTime = this.selectPrimaryClinicalTime(documentId, metadata, manifest).time;
    if (!clinicalTime) return null;
    const encounterIdentifier = metadata.encounterIdentifier?.value
      ? normalized(metadata.encounterIdentifier.value)
      : null;
    const sampleIdentifiers = new Set((metadata.sampleIdentifiers ?? []).map((item) => normalized(item.value)));
    if (!encounterIdentifier && sampleIdentifiers.size === 0) return null;
    const rows = this.db.prepare(`
      SELECT r.event_id, mr.payload_json, l.document_id, e.clinical_date, e.end_date, e.date_precision,
        e.date_source, e.metadata_status AS event_metadata_status, r.metadata_status
      FROM report_records r
      JOIN report_source_links l ON l.report_id=r.id
      JOIN documents d ON d.id=l.document_id AND d.person_id=r.person_id AND d.excluded_from_analysis=0
      JOIN source_objects so ON so.id=d.source_object_id AND so.sha256=l.source_hash
      JOIN health_events_v2 e ON e.id=r.event_id AND e.person_id=r.person_id
      JOIN report_metadata_revisions mr
        ON mr.report_id = r.id AND mr.revision = r.metadata_revision
      WHERE r.person_id = ?
    `).all(personId) as Array<{ event_id: string; payload_json: string; document_id: string; clinical_date: string | null;
      end_date: string | null; date_precision: string; date_source: string; event_metadata_status: string; metadata_status: string }>;
    const matches = new Set<string>();
    for (const row of rows) {
      const payload = JSON.parse(row.payload_json) as { extracted?: ReportMetadataCandidate | null };
      const existing = payload.extracted;
      if (!existing?.organization?.value || normalized(existing.organization.value) !== organization) continue;
      if (row.metadata_status === 'corrected' || row.event_metadata_status === 'corrected' || row.date_source === 'corrected') continue;
      const existingTime = this.selectPrimaryClinicalTime(row.document_id, existing, this.optionalReportSourceManifest(row.document_id)).time;
      if (!existingTime || existingTime.value !== clinicalTime.value || existingTime.precision !== clinicalTime.precision) continue;
      // 当前事件锚点可能仍是旧自动投影；不能只看旧元数据就让新报告继承错误时间。
      if (row.clinical_date !== clinicalTime.value || row.date_precision !== clinicalTime.precision || row.end_date !== null) continue;
      const existingEncounter = existing.encounterIdentifier?.value
        ? normalized(existing.encounterIdentifier.value)
        : null;
      const existingSamples = new Set((existing.sampleIdentifiers ?? []).map((item) => normalized(item.value)));
      const sameEncounter = encounterIdentifier !== null && existingEncounter === encounterIdentifier;
      const sharedSample = [...sampleIdentifiers].some((identifier) => existingSamples.has(identifier));
      if (sameEncounter || sharedSample) matches.add(row.event_id);
    }
    // 若历史数据中同一标识已经对应多个事件，保持并列等待用户处理，绝不任选一个。
    return matches.size === 1 ? [...matches][0]! : null;
  }

  private groundedClinicalContextJson(documentId: string, context: ClinicalContext | null | undefined,
    suppliedManifest?: SourceManifest): string | null {
    if (!context) return null;
    const parsed = clinicalContextSchema.safeParse(context);
    if (!parsed.success) return null;
    const manifest = suppliedManifest ?? this.getDocumentExtractionBundle(documentId).manifest;
    if (manifest.normalizerVersion.startsWith('direct-original') || manifest.spans.some((span) => span.modelEvidence)) {
      const directValid = parsed.data.conditions.every((condition) => {
        const span = manifest.spans.find((item) => item.id === condition.sourceSpanId);
        const model = span?.modelEvidence;
        return Boolean(span?.quote && span.quote.includes(condition.quote) && span.readability === 'clear' && model
          && model.clarity === 'clear' && isDirectOriginalConditionSourceRole(model.role)
          && model.originalSha256 === manifest.sha256 && model.originalSourceObjectId === manifest.sourceObjectId
          && manifest.spans.some((parent) => parent.id === model.parentSourceSpanId && !parent.modelEvidence
            && !parent.visualEvidence && parent.page === span.page));
      });
      return directValid ? JSON.stringify(parsed.data) : null;
    }
    // 无效的补充条件不影响已经接纳的数值；留作旧格式，由定向补齐步骤处理。
    const sources = suppliedManifest ? suppliedManifest.spans.map((span) => ({ id: span.id, quote: span.quote }))
      : this.db.prepare('SELECT id, quote FROM source_spans WHERE document_id = ?')
        .all(documentId) as Array<{ id: string; quote: string | null }>;
    return clinicalContextHasValidSources(parsed.data, sources, true) ? JSON.stringify(parsed.data) : null;
  }

  getReportClinicalContext(personId: string, documentId: string, inputSignature: string): ReportClinicalContext | null {
    const row = this.db.prepare(`
      SELECT c.payload_json FROM report_clinical_contexts c
      JOIN documents d ON d.id = c.document_id AND d.person_id = c.person_id AND d.excluded_from_analysis = 0
      WHERE c.person_id = ? AND c.document_id = ? AND c.input_signature = ?
    `).get(personId, documentId, inputSignature) as { payload_json: string } | undefined;
    if (!row) return null;
    try {
      const parsed = reportClinicalContextSchema.safeParse(JSON.parse(row.payload_json));
      return parsed.success ? parsed.data : null;
    } catch { return null; }
  }

  saveReportClinicalContext(input: {
    personId: string; documentId: string; inputSignature: string; context: ReportClinicalContext;
    expectedFactRevision: number; expectedContextRevision: number; executionGuard?: JobExecutionGuard;
  }): void {
    const context = reportClinicalContextSchema.parse(input.context);
    this.db.transaction(() => {
      const owner = this.db.prepare('SELECT person_id FROM documents WHERE id = ? AND excluded_from_analysis = 0')
        .get(input.documentId) as { person_id: string | null } | undefined;
      if (owner?.person_id !== input.personId) throw new Error('CLINICAL_CONTEXT_SCOPE_MISMATCH');
      if (this.getFactRevision(input.personId) !== input.expectedFactRevision
        || this.getClinicalContextRevision(input.personId) !== input.expectedContextRevision) {
        throw new Error('CLINICAL_CONTEXT_REVISION_CONFLICT');
      }
      const facts = new Map(this.listAcceptedObservations(input.personId).map((fact) => [fact.id, fact]));
      const ids = new Set(context.items.map((item) => item.observationId));
      if (ids.size !== context.items.length || context.items.some((item) =>
        facts.get(item.observationId)?.documentId !== input.documentId)) throw new Error('CLINICAL_CONTEXT_SCOPE_MISMATCH');
      if (input.executionGuard) this.assertObservationScopeActive(input.executionGuard, input.personId,
        context.items.map((item) => ({ id: item.observationId, documentId: input.documentId })));
      const sources = this.db.prepare('SELECT id, quote FROM source_spans WHERE document_id = ?')
        .all(input.documentId) as Array<{ id: string; quote: string | null }>;
      if (context.items.some((item) => !clinicalContextHasValidSources(item.context, sources))) {
        throw new Error('CLINICAL_CONTEXT_EVIDENCE_MISMATCH');
      }
      this.db.prepare(`INSERT INTO report_clinical_contexts
        (person_id, document_id, input_signature, payload_json, created_at) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(person_id, document_id, input_signature) DO NOTHING`)
        .run(input.personId, input.documentId, input.inputSignature, JSON.stringify(context), this.now().toISOString());
    })();
  }

  publishFacts(input: PublishFactsInput): PublishFactsReceipt {
    if (input.executionGuard && this.isAssessmentOnlyJob(input.executionGuard.jobId)) {
      throw new Error('ASSESSMENT_ONLY_FACT_WRITE_FORBIDDEN');
    }
    const currentDocumentOwner = this.db.prepare(`
      SELECT person_id FROM documents WHERE id = ?
    `).get(input.documentId) as { person_id: string | null } | undefined;
    if (!currentDocumentOwner || currentDocumentOwner.person_id !== input.personId) {
      throw new Error('DOCUMENT_PERSON_SCOPE_MISMATCH');
    }
    const correctionIssue = input.resolvedReviewIssueId
      ? this.db.prepare(`
          SELECT id, job_id, kind, resolution_status, payload_json
          FROM review_issues
          WHERE id = ? AND field_ref = 'document:' || ?
        `).get(input.resolvedReviewIssueId, input.documentId) as {
          id: string;
          job_id: string | null;
          kind: string;
          resolution_status: string;
          payload_json: string | null;
        } | undefined
      : undefined;
    if (input.resolvedReviewIssueId) {
      if (!correctionIssue || correctionIssue.kind !== 'field_conflict' || correctionIssue.resolution_status !== 'open') {
        throw new Error('REVIEW_ISSUE_NOT_OPEN');
      }
      const payload = correctionIssue.payload_json
        ? JSON.parse(correctionIssue.payload_json) as {
            documentRun?: {
              coverageComplete?: unknown;
              coveredSourceSpanIds?: unknown;
              manifestSpanIds?: unknown;
            };
          }
        : {};
      const run = payload.documentRun;
      const covered = Array.isArray(run?.coveredSourceSpanIds)
        ? run.coveredSourceSpanIds.filter((value): value is string => typeof value === 'string')
        : [];
      const manifest = Array.isArray(run?.manifestSpanIds)
        ? run.manifestSpanIds.filter((value): value is string => typeof value === 'string')
        : [];
      const complete = run?.coverageComplete === true
        && covered.length > 0
        && new Set(covered).size === covered.length
        && new Set(manifest).size === manifest.length
        && covered.length === manifest.length
        && manifest.every((spanId) => covered.includes(spanId));
      if (!complete) throw new Error('DOCUMENT_REVIEW_RUN_INCOMPLETE');
    }
    const existing = this.db.prepare(`
      SELECT publication_id, revision FROM document_commits
      WHERE document_id = ? OR commit_key = ?
    `).get(input.documentId, input.documentCommitKey) as { publication_id: string; revision: number } | undefined;
    if (existing && input.resolvedReviewIssueId) {
      // 已提交资料不能通过幂等返回伪装成“修正成功”。修正需要新的显式修订流程，
      // 当前流程只允许在首次提交前关闭整篇事实冲突。
      throw new Error('DOCUMENT_ALREADY_COMMITTED_REVIEW_CONFLICT');
    }
    if (existing) return { publicationId: existing.publication_id, revision: existing.revision, idempotent: true,
      duplicateCount: 0, heldCount: 0, heldCandidates: [], heldReasonCodes: [], reviewIssueId: null };

    const transaction = this.db.transaction(() => {
      if (input.executionGuard) this.assertJobExecutionActive(input.executionGuard, input.documentId);
      const ownedDocument = this.db.prepare(`
        SELECT 1 FROM documents WHERE id = ? AND person_id = ? LIMIT 1
      `).get(input.documentId, input.personId);
      if (!ownedDocument) throw new Error('DOCUMENT_PERSON_SCOPE_MISMATCH');
      const committed = this.db.prepare(`
        SELECT publication_id, revision FROM document_commits
        WHERE document_id = ? OR commit_key = ?
      `).get(input.documentId, input.documentCommitKey) as { publication_id: string; revision: number } | undefined;
      if (committed && input.resolvedReviewIssueId) {
        throw new Error('DOCUMENT_ALREADY_COMMITTED_REVIEW_CONFLICT');
      }
      if (committed) return { publicationId: committed.publication_id, revision: committed.revision, idempotent: true,
        duplicateCount: 0, heldCount: 0, heldCandidates: [], heldReasonCodes: [], reviewIssueId: null };
      const actual = this.getFactRevision(input.personId);
      if (actual !== input.expectedRevision) throw new RevisionConflictError(input.expectedRevision, actual);
      const nextRevision = actual + 1;
      const publicationId = randomUUID();
      const encounters = new Map<string, string>();
      const affectedSystemIds = new Set<string>();
      const manifest = input.observations.length > 0 ? this.reconciliationSourceManifest(input.documentId)
        : this.optionalReportSourceManifest(input.documentId);
      const plan = this.planReportSourceAdmission({ mode: 'publish', personId: input.personId,
        documentId: input.documentId, manifest,
        observations: input.observations, reportMetadata: input.reportMetadata ?? null,
        fieldReviews: input.unresolvedReview?.fieldReviews ?? [] });
      const { additions: acceptedObservations, bindings, heldCandidates, heldReasonCodes, duplicateCount } = plan;
      const accounting = input.readingAccounting ? accountReportReading(input.readingAccounting,
        plan.admittedObservations.map((item) => item.candidate?.localKey ?? ''), heldCandidates) : null;
      this.recordDirectOriginalProtocolNormalizations(input.documentId, plan.admittedObservations, input.executionGuard);

      for (const observation of acceptedObservations) {
        const encounterKey = `${observation.documentId}:${observation.clinicalDate ?? 'unknown'}`;
        let encounterId = encounters.get(encounterKey);
        if (!encounterId) {
          encounterId = randomUUID();
          this.db.prepare(`
            INSERT INTO encounters (
              id, person_id, clinical_date, date_precision, type, source_text, version
            ) VALUES (?, ?, ?, ?, 'health_report', NULL, 1)
          `).run(
            encounterId, input.personId, observation.clinicalDate,
            observation.clinicalDate ? 'day' : 'unknown'
          );
          this.db.prepare(`
            INSERT INTO encounter_documents (encounter_id, document_id) VALUES (?, ?)
          `).run(encounterId, observation.documentId);
          encounters.set(encounterKey, encounterId);
        }
        const observationId = randomUUID();
        this.db.prepare(`
          INSERT INTO observations (
            id, person_id, encounter_id, concept_key, original_name,
            model_standard_name_candidate, current_revision, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, 1, ?)
        `).run(
          observationId, input.personId, encounterId, observation.conceptKey,
          observation.originalName ?? observation.conceptKey,
          observation.modelStandardNameCandidate ?? null,
          this.now().toISOString()
        );
        this.db.prepare(`
          INSERT INTO observation_revisions (
            observation_id, revision, value_kind, raw_text, decimal_value,
            qualifier, unit, reference_range, abnormal_flag, source_span_id,
            acceptance_id, specimen, method, body_site, evidence_json, clinical_context_json,
            source_binding_json, clinical_date, date_evidence_json, created_at
          ) VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          observationId, observation.valueKind, observation.rawText, observation.decimalValue,
          observation.qualifier, observation.unit, observation.referenceRange, observation.abnormalFlag,
          observation.sourceSpanId, observation.acceptanceId, observation.specimen, observation.method,
          observation.bodySite, JSON.stringify(observation.evidence),
          this.groundedClinicalContextJson(input.documentId, observation.clinicalContext), JSON.stringify(bindings.get(observation) ?? null),
          observation.clinicalDate, JSON.stringify(this.explicitClinicalDateEvidence(input.documentId, observation, input.reportMetadata)),
          this.now().toISOString()
        );
        const mapping = mapConcept({
          rawName: observation.originalName ?? observation.conceptKey,
          standardName: observation.modelStandardNameCandidate ?? null,
          specimen: observation.specimen,
          method: observation.method,
          bodySite: observation.bodySite,
          unit: observation.unit
        });
        this.db.prepare(`
          INSERT INTO observation_concept_mappings (
            observation_id, observation_revision, concept_id, normalized_name,
            status, confidence, reasons_json, mapper_version, created_at
          ) VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          observationId,
          mapping.conceptId,
          mapping.normalizedName,
          mapping.status,
          mapping.confidence,
          JSON.stringify(mapping.reasons),
          CONCEPT_DICTIONARY_VERSION,
          this.now().toISOString()
        );
        for (const link of linkConceptToSystems(mapping)) {
          affectedSystemIds.add(link.systemId);
          this.db.prepare(`
            INSERT INTO system_fact_links (
              observation_id, observation_revision, system_id, relation, linker_version, created_at
            ) VALUES (?, 1, ?, ?, ?, ?)
          `).run(observationId, link.systemId, link.relation, BODY_SYSTEM_REGISTRY_VERSION, this.now().toISOString());
        }
      }

      const document = this.db.prepare(`
        SELECT d.source_object_id,
               COALESCE((
                 SELECT occ.display_name FROM source_occurrences occ
                 WHERE occ.source_object_id = d.source_object_id
                 ORDER BY occ.last_seen DESC LIMIT 1
               ), '已导入健康资料') AS display_name,
               so.sha256
        FROM documents d JOIN source_objects so ON so.id = d.source_object_id
        WHERE d.id = ?
      `).get(input.documentId) as { source_object_id: string; display_name: string; sha256: string } | undefined;
      if (document) {
        const primary = this.selectPrimaryClinicalTime(input.documentId, input.reportMetadata, manifest);
        heldReasonCodes.push(...primary.heldReasonCodes);
        // 不可靠的主要日期不进入正式投影；其他已接纳事实不因此回滚。
        const metadata = primary.heldReasonCodes.length > 0 ? null : input.reportMetadata ?? null;
        const metadataTimes = metadata?.times ?? [];
        const currentClinicalTime = primary.time;
        const issued = metadataTimes.filter((time) => time.role === 'report_issued');
        const reportIssuedTime = new Set(issued.map((time) => `${time.precision}:${time.value}`)).size === 1 ? issued[0] : undefined;
        const dates = [...new Set(acceptedObservations.map((item) => item.clinicalDate).filter((value): value is string => Boolean(value)))].sort();
        const earliest = dates[0] ?? null;
        const latest = dates.at(-1) ?? null;
        const spanDays = earliest && latest
          ? Math.round((Date.parse(`${latest}T00:00:00Z`) - Date.parse(`${earliest}T00:00:00Z`)) / 86_400_000)
          : null;
        const legacyFactDateFallback = !input.reportMetadata && !this.isDirectOriginalManifest(manifest);
        const eventDate = currentClinicalTime?.value
          ?? (legacyFactDateFallback && (dates.length === 1 || (spanDays !== null && spanDays <= 14)) ? earliest : null);
        const eventEndDate = currentClinicalTime ? null : eventDate && latest !== eventDate ? latest : null;
        const matchedEventId = this.findStrongMetadataEventMatch(input.personId, input.documentId, metadata, manifest);
        const eventId = matchedEventId ?? randomUUID();
        const reportId = randomUUID();
        const eventTitle = metadata?.title?.value ?? metadata?.reportKind?.value ?? document.display_name;
        const reportTitle = metadata?.title?.value ?? document.display_name;
        const reportKind = metadata?.reportKind?.value ?? 'health_report';
        const reportDate = reportIssuedTime?.value ?? (this.isDirectOriginalManifest(manifest) ? null : eventDate);
        const metadataStatus = metadata ? 'inferred' : eventDate ? 'inferred' : 'unknown';
        if (!matchedEventId) this.db.prepare(`
            INSERT INTO health_events_v2 (
              id, person_id, type, title, clinical_date, end_date, date_precision,
              date_role, date_source, metadata_status, metadata_revision, created_at, updated_at
            ) VALUES (?, ?, 'checkup', ?, ?, ?, ?, 'exam', ?, ?, 1, ?, ?)
          `).run(
            eventId, input.personId, eventTitle, eventDate, eventEndDate,
            currentClinicalTime?.precision ?? (eventDate ? 'day' : 'unknown'),
            currentClinicalTime ? 'explicit' : eventDate ? 'inherited' : 'unknown',
            metadataStatus, this.now().toISOString(), this.now().toISOString()
          );
        this.db.prepare(`
          INSERT INTO report_records (
            id, person_id, event_id, report_kind, title, organization, report_date,
            metadata_status, metadata_revision, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
        `).run(
          reportId, input.personId, eventId, reportKind, reportTitle,
          metadata?.organization?.value ?? null, reportDate, metadataStatus, this.now().toISOString()
        );
        this.db.prepare(`
          INSERT INTO report_source_links (report_id, document_id, relation, source_hash, created_at)
          VALUES (?, ?, 'primary', ?, ?)
        `).run(reportId, input.documentId, document.sha256, this.now().toISOString());
        this.db.prepare(`INSERT INTO event_report_links (event_id, report_id) VALUES (?, ?)`).run(eventId, reportId);
        this.db.prepare(`
          INSERT INTO report_metadata_revisions (
            report_id, revision, payload_json, actor, evidence_refs_json, created_at
          ) VALUES (?, 1, ?, ?, ?, ?)
        `).run(reportId, JSON.stringify({
          memberModelVersion: MEMBER_MODEL_VERSION,
          clinicalDate: eventDate,
          endDate: eventEndDate,
          dateCandidates: dates,
          historicalColumnsDetected: dates.length > 1 && eventDate === null,
          extracted: metadata
        }), metadata ? 'independent_review_projection' : 'deterministic_projection', JSON.stringify(
          metadata ? [
            metadata.reportKind, metadata.title, metadata.organization, metadata.campus,
            metadata.department, metadata.reportNumber, metadata.encounterIdentifier,
            ...(metadata.sampleIdentifiers ?? []), ...metadata.examItems, ...metadata.times
          ].flatMap((field) => field?.evidence ?? []) : []
        ), this.now().toISOString());
      }

      this.db.prepare(`
        INSERT INTO person_revisions (person_id, fact_revision)
        VALUES (?, ?)
        ON CONFLICT(person_id) DO UPDATE SET fact_revision = excluded.fact_revision
      `).run(input.personId, nextRevision);
      this.db.prepare(`UPDATE derived_snapshots SET status = 'stale' WHERE person_id = ? AND status = 'current'`).run(input.personId);
      this.invalidateMemberAssessmentSnapshots(input.personId);
      const staleSystemSnapshot = this.db.prepare(`
        UPDATE system_analysis_snapshots_v2 SET status = 'stale'
        WHERE person_id = ? AND system_id = ? AND status = 'current'
      `);
      for (const systemId of affectedSystemIds) staleSystemSnapshot.run(input.personId, systemId);
      this.db.prepare(`
        INSERT INTO publication_events (
          id, person_id, expected_revision, new_revision, change_set_hash, summary, committed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(publicationId, input.personId, actual, nextRevision, input.changeSetHash, input.summary, this.now().toISOString());
      this.db.prepare(`
        INSERT INTO document_commits (document_id, commit_key, publication_id, revision, committed_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(input.documentId, input.documentCommitKey, publicationId, nextRevision, this.now().toISOString());
      this.db.prepare(`UPDATE documents SET status = 'completed' WHERE id = ?`).run(input.documentId);
      if (input.resolvedReviewIssueId) {
        const resolved = this.db.prepare(`
          UPDATE review_issues SET resolution_status = 'resolved', resolution_revision = 1
          WHERE id = ? AND field_ref = 'document:' || ? AND resolution_status = 'open' AND kind = 'field_conflict'
        `).run(input.resolvedReviewIssueId, input.documentId);
        if (resolved.changes !== 1) throw new Error('REVIEW_ISSUE_NOT_OPEN');
        this.resumeWaitingJobsAfterReview(input.documentId, false, correctionIssue?.job_id ?? null);
      }
      let reviewIssueId: string | null = null;
      if (input.unresolvedReview || heldCandidates.length > 0 || heldReasonCodes.length > 0 || accounting?.pendingCandidates.length) {
        const unresolved = input.unresolvedReview;
        reviewIssueId = this.saveExtractionReviewIssue({
          documentId: input.documentId,
          ...(input.executionGuard ? {
            jobId: input.executionGuard.jobId,
            attemptId: input.executionGuard.attemptId
          } : {}),
          stage: 'extract',
          kind: unresolved?.kind ?? 'field_conflict',
          severity: 'warning',
          preserveDocumentStatus: true,
          evidenceRefs: [...new Set([...(unresolved?.evidenceRefs ?? []), ...heldCandidates.flatMap((candidate) =>
            candidate.evidence.map((reference) => reference.sourceSpanId))])],
          candidateOptions: uniqueCandidates([...(unresolved?.candidateOptions ?? []), ...heldCandidates, ...(accounting?.pendingCandidates ?? [])]),
          ...(accounting ? { readingAudit: accounting.audit } : {}),
          ...(unresolved?.fieldReviews?.length ? { fieldReviews: unresolved.fieldReviews } : {}),
          reasonCodes: [...new Set([...(unresolved?.reasonCodes ?? []), ...heldReasonCodes,
            ...(accounting?.audit.pending.flatMap((item) => item.reasonCodes) ?? [])])],
          ...(unresolved?.documentRun ? { documentRun: unresolved.documentRun } : {})
        });
      }
      if (accounting) this.recordReportReadingAudit(input.documentId, accounting.audit, input.executionGuard);
      return { publicationId, revision: nextRevision, idempotent: false, duplicateCount,
        heldCount: uniqueCandidates(heldCandidates).length, heldCandidates: uniqueCandidates(heldCandidates),
        heldReasonCodes: [...new Set(heldReasonCodes)], reviewIssueId };
    });
    return transaction();
  }

  /** 对照只读取已命中的报告及其实际来源，不按成员扩展到其他报告。 */
  private reportDateDiagnosticComparison(personId: string, documentId: string, reportId: string,
    origin: 'stored_version' | 'shared_event', times: ReportMetadataCandidate['times'],
    projection?: { clinicalDate?: string | null; reportDate?: string | null }): DirectOriginalReportAdmissionDiagnostic['comparisons'][number] {
    const sources = this.db.prepare(`SELECT d.id,so.id AS source_object_id,so.sha256 FROM report_source_links l
      JOIN report_records r ON r.id=l.report_id JOIN documents d ON d.id=l.document_id AND d.person_id=r.person_id
      JOIN source_objects so ON so.id=d.source_object_id AND so.sha256=l.source_hash
      WHERE r.id=? AND r.person_id=? AND l.document_id=?`).all(reportId, personId, documentId) as Array<{ id: string; source_object_id: string; sha256: string }>;
    const manifests = sources.flatMap((source) => {
      const manifest = this.optionalReportSourceManifest(source.id);
      if (manifest?.sourceObjectId !== source.source_object_id || manifest.sha256 !== source.sha256) return [];
      return [manifest];
    });
    const scopedTimes = times.filter((time) => time.evidence.length > 0 && time.evidence.every((reference) => {
      const owner = this.db.prepare('SELECT document_id FROM source_spans WHERE id=?').get(reference.sourceSpanId) as { document_id: string } | undefined;
      return owner?.document_id === documentId && manifests.some((manifest) => manifest.spans.some((span) => span.id === reference.sourceSpanId
        && span.documentId === documentId && (!span.modelEvidence || span.modelEvidence.originalSha256 === manifest.sha256
          && span.modelEvidence.originalSourceObjectId === manifest.sourceObjectId)));
    }));
    const spans = manifests.flatMap((manifest) => admissionDiagnosticSourceSpans(manifest, documentId, scopedTimes.flatMap((time) => time.evidence)));
    const metadata: ReportMetadataCandidate = { reportKind: null, title: null, organization: null, campus: null,
      department: null, reportNumber: null, examItems: [], times: scopedTimes };
    const ownsDate = (value: string | null | undefined, roles: string[]) => value === null || value !== undefined
      && scopedTimes.some((time) => time.value === value && roles.includes(time.role)
        && manifests.some((manifest) => this.reportTimeEvidenceProblem(documentId, time, metadata, manifest) === null));
    // 事件日期可能由同一事件的另一原件建立；只有本文件自己的日期出处能授权附上投影值。
    const ownProjection: { clinicalDate?: string | null; reportDate?: string | null } = {};
    if (projection?.clinicalDate !== undefined && ownsDate(projection.clinicalDate, ['sampled', 'examined', 'encounter'])) {
      ownProjection.clinicalDate = projection.clinicalDate;
    }
    if (projection?.reportDate !== undefined && ownsDate(projection.reportDate, ['report_issued'])) ownProjection.reportDate = projection.reportDate;
    return { origin, reportId, sourceDocumentId: documentId, sourceSha256: sources[0]?.sha256 ?? null,
      times: scopedTimes, sourceSpans: [...new Map(spans.map((span) => [span.id, span])).values()], ...ownProjection };
  }

  /** 只补齐有明确角色和当前原文依据的空日期，不用元数据补强改写旧事实日期。 */
  private planCommittedReportDateEnrichment(personId: string, documentId: string,
    metadata: ReportMetadataCandidate | null | undefined, suppliedManifest?: SourceManifest): CommittedReportDateEnrichmentPlan {
    const unchanged = (): CommittedReportDateEnrichmentPlan => ({ reportIds: [], heldReasonCodes: [], heldEvidenceRefs: [], change: null });
    if (!metadata) return unchanged();
    if (!reportMetadataCandidateSchema.safeParse(metadata).success) throw new Error('COMMITTED_REPORT_METADATA_INVALID');
    const rows = this.db.prepare(`SELECT r.id, r.event_id, r.report_date, r.metadata_status, r.metadata_revision,
        e.clinical_date, e.end_date, e.date_precision, e.date_role, e.date_source,
        e.metadata_status AS event_metadata_status, e.metadata_revision AS event_metadata_revision,
        mr.payload_json, mr.evidence_refs_json, mr.actor
      FROM report_records r JOIN report_source_links l ON l.report_id=r.id
      JOIN documents d ON d.id=l.document_id AND d.person_id=r.person_id
      JOIN source_objects so ON so.id=d.source_object_id AND so.sha256=l.source_hash
      JOIN health_events_v2 e ON e.id=r.event_id AND e.person_id=r.person_id
      JOIN report_metadata_revisions mr ON mr.report_id=r.id AND mr.revision=r.metadata_revision
      WHERE l.document_id=? AND r.person_id=?`).all(documentId, personId) as CommittedReportDateRow[];
    const manifest = suppliedManifest ?? this.optionalReportSourceManifest(documentId);
    const held = (reason: string, times: ReportMetadataCandidate['times'],
      scope: DirectOriginalReportAdmissionDiagnostic['scope'] = 'current_reading',
      comparisons: DirectOriginalReportAdmissionDiagnostic['comparisons'] = []): CommittedReportDateEnrichmentPlan => ({
      reportIds: [], heldReasonCodes: [reason], change: null,
      heldEvidenceRefs: [...new Set(times.flatMap((time) => time.evidence.map((reference) => reference.sourceSpanId)))],
      diagnostics: [{ scope, reasonCodes: [reason], current: times, comparisons,
        sourceSpans: admissionDiagnosticSourceSpans(manifest, documentId, times.flatMap((time) => time.evidence)) }]
    });
    if (metadata.primaryClinicalTimeIndex !== undefined) {
      return this.planCommittedPrimaryDateProjection(personId, documentId, metadata, manifest, rows);
    }
    // 旧回执只允许补齐空日期，显式主日期的版本化重投影走上方独立计划。
    const row = rows.length === 1 ? rows[0] : undefined;
    if (!row || row.metadata_status === 'corrected' || row.event_metadata_status === 'corrected' || row.date_source === 'corrected') return unchanged();
    const previousPayload = JSON.parse(row.payload_json) as Record<string, unknown> & { extracted?: ReportMetadataCandidate | null };
    const currentClinical = metadata.times.filter((time) => time.precision === 'day' && ['sampled', 'examined', 'encounter'].includes(time.role));
    const issued = metadata.times.filter((time) => time.precision === 'day' && time.role === 'report_issued');
    const uniqueTime = (times: ReportMetadataCandidate['times']) => new Set(times.map((time) => time.value)).size === 1 ? times[0] : undefined;
    const clinical = uniqueTime(currentClinical);
    const signed = uniqueTime(issued);
    const previousTimes = previousPayload.extracted?.times ?? [];
    const contradicts = (times: ReportMetadataCandidate['times'], old: string | null) => Boolean(old && times.some((time) => time.value !== old));
    const eventClinicalConflict = contradicts(currentClinical, row.clinical_date);
    if (eventClinicalConflict || contradicts(issued, row.report_date)
      || previousTimes.some((old) => old.precision === 'day' && metadata.times.some((next) => next.precision === 'day'
        && next.role === old.role && next.value !== old.value))) {
      if (eventClinicalConflict && this.db.prepare('SELECT 1 FROM report_records WHERE event_id=? AND id!=? LIMIT 1').get(row.event_id, row.id)) {
        return held('report_metadata_date_conflict', [...currentClinical, ...issued], 'shared_event');
      }
      return held('report_metadata_date_conflict', [...currentClinical, ...issued], 'stored_version',
        [this.reportDateDiagnosticComparison(personId, documentId, row.id, 'stored_version', previousTimes,
          { clinicalDate: row.clinical_date, reportDate: row.report_date })]);
    }
    const fillClinical = row.clinical_date === null && row.end_date === null && row.date_precision === 'unknown' ? clinical : undefined;
    const fillSigned = row.report_date === null ? signed : undefined;
    const supplements = [fillClinical, fillSigned].filter((time): time is ReportMetadataCandidate['times'][number] => Boolean(time));
    if (supplements.length === 0) return unchanged();
    if (!manifest) return held('report_metadata_date_evidence_unverified', supplements);
    for (const time of supplements) {
      // 首次发布、显式主日期重投影和旧版空日期补强使用相同的逐条来源/角色门禁。
      const problem = this.reportTimeEvidenceProblem(documentId, time, metadata, manifest);
      if (problem) return held(problem, [time]);
    }
    // 被强标识合并的事件还可能包含其他文件。它们的明确临床日期同样不能被覆盖。
    if (fillClinical) {
      const related = this.db.prepare(`SELECT mr.payload_json FROM report_records r
        JOIN report_metadata_revisions mr ON mr.report_id=r.id AND mr.revision=r.metadata_revision
        WHERE r.event_id=? AND r.id!=?`).all(row.event_id, row.id) as Array<{ payload_json: string }>;
      if (related.some((other) => (JSON.parse(other.payload_json) as { extracted?: ReportMetadataCandidate | null }).extracted?.times
        .some((time) => ['sampled', 'examined', 'encounter'].includes(time.role) && time.value !== fillClinical.value))) {
        // 共享事件可说明阻断范围，不把另一原件的日期或正文带入本次重核。
        return held('report_metadata_date_conflict', [fillClinical], 'shared_event');
      }
    }
    return { reportIds: [row.id], heldReasonCodes: [], heldEvidenceRefs: [],
      change: { kind: 'enrich', row, previousPayload, fillClinical, fillSigned, supplements } };
  }

  /** 新回执明确主日期时，只版本化重投影同一原件的自动锚点，绝不改写观察事实。 */
  private planCommittedPrimaryDateProjection(personId: string, documentId: string, metadata: ReportMetadataCandidate,
    manifest: SourceManifest | null, rows: CommittedReportDateRow[]): CommittedReportDateEnrichmentPlan {
    const unchanged = (): CommittedReportDateEnrichmentPlan => ({ reportIds: [], heldReasonCodes: [], heldEvidenceRefs: [], change: null });
    const held = (reason: string, refs: string[] = metadata.times.flatMap((time) => time.evidence.map((ref) => ref.sourceSpanId)),
      times: ReportMetadataCandidate['times'] = metadata.times,
      scope: DirectOriginalReportAdmissionDiagnostic['scope'] = 'current_reading',
      comparisons: DirectOriginalReportAdmissionDiagnostic['comparisons'] = []): CommittedReportDateEnrichmentPlan => ({
      reportIds: [], heldReasonCodes: [reason], heldEvidenceRefs: [...new Set(refs)], change: null,
      diagnostics: [{ scope, reasonCodes: [reason], current: times, comparisons,
        sourceSpans: admissionDiagnosticSourceSpans(manifest, documentId, times.flatMap((time) => time.evidence)) }]
    });
    if (rows.length !== 1) return held('report_metadata_projection_ambiguous', undefined, metadata.times, 'stored_version');
    const row = rows[0]!;
    const original = this.db.prepare('SELECT d.person_id,d.source_object_id,so.sha256 FROM documents d JOIN source_objects so ON so.id=d.source_object_id WHERE d.id=?')
      .get(documentId) as { person_id: string | null; source_object_id: string; sha256: string } | undefined;
    if (!original || original.person_id !== personId || !manifest || original.source_object_id !== manifest.sourceObjectId
      || original.sha256 !== manifest.sha256) return held('report_metadata_date_evidence_unverified');
    const primary = this.selectPrimaryClinicalTime(documentId, metadata, manifest);
    if (primary.heldReasonCodes.length > 0) return { ...unchanged(), heldReasonCodes: primary.heldReasonCodes,
      heldEvidenceRefs: primary.heldEvidenceRefs, ...(primary.diagnostics ? { diagnostics: primary.diagnostics } : {}) };
    // 当前日期数组整体保存，确保selector始终指向本次模型数组，不接到旧数组上。
    for (const time of metadata.times) {
      for (const ref of time.evidence) {
        const owner = this.db.prepare('SELECT document_id FROM source_spans WHERE id=?').get(ref.sourceSpanId) as { document_id: string } | undefined;
        if (owner && owner.document_id !== documentId) throw new Error('COMMITTED_REPORT_METADATA_DOCUMENT_SCOPE_MISMATCH');
        const span = manifest.spans.find((item) => item.id === ref.sourceSpanId);
        const compact = (value: string) => value.normalize('NFKC').replace(/\s+/gu, '');
        if (!span || span.documentId !== documentId || !span.quote || span.readability !== 'clear'
          || !(ref.quote === null && span.modelEvidence || ref.quote && compact(span.quote).includes(compact(ref.quote)))) {
          return held('report_metadata_date_evidence_unverified', [ref.sourceSpanId], [time]);
        }
        if (span.modelEvidence && !trustedDirectReportTime(time, manifest, documentId)) return held('report_metadata_date_role_unverified', [ref.sourceSpanId], [time]);
      }
    }
    const issued = metadata.times.filter((time) => time.role === 'report_issued');
    if (new Set(issued.map((time) => `${time.precision}:${time.value}`)).size > 1) return held('report_metadata_date_conflict', undefined, issued);
    const signed = issued[0];
    if (signed) {
      const issue = this.reportTimeEvidenceProblem(documentId, signed, metadata, manifest);
      if (issue) return held(issue, signed.evidence.map((ref) => ref.sourceSpanId), [signed]);
    }
    const previousPayload = JSON.parse(row.payload_json) as Record<string, unknown> & { extracted?: ReportMetadataCandidate | null };
    const clinical = primary.time;
    const reportDate = signed?.value ?? (this.isDirectOriginalManifest(manifest) ? null : row.report_date);
    const eventChanged = row.clinical_date !== (clinical?.value ?? null) || row.end_date !== null || row.date_role !== 'exam'
      || row.date_precision !== (clinical?.precision ?? 'unknown') || row.date_source !== (clinical ? 'explicit' : 'unknown');
    if (!eventChanged && row.report_date === reportDate && JSON.stringify(previousPayload.extracted) === JSON.stringify(metadata)) return unchanged();
    const sharedEventChange = eventChanged && Boolean(this.db.prepare('SELECT 1 FROM report_records WHERE event_id=? AND id!=? LIMIT 1')
      .get(row.event_id, row.id));
    if (row.metadata_status === 'corrected' || row.event_metadata_status === 'corrected' || row.date_source === 'corrected'
      || !['policy', 'independent_review_projection', 'deterministic_projection'].includes(row.actor)) {
      if (sharedEventChange) return held('report_metadata_user_corrected_projection', undefined, metadata.times, 'shared_event');
      return held('report_metadata_user_corrected_projection',
        undefined, metadata.times, 'stored_version', [this.reportDateDiagnosticComparison(personId, documentId, row.id, 'stored_version', previousPayload.extracted?.times ?? [],
          { clinicalDate: row.clinical_date, reportDate: row.report_date })]);
    }
    const sourceCount = this.db.prepare('SELECT COUNT(*) AS count FROM report_source_links WHERE report_id=?').get(row.id) as { count: number };
    if (sourceCount.count !== 1) return held('report_metadata_projection_ambiguous', undefined, metadata.times, 'stored_version');
    if (sharedEventChange) {
      // 共享事件的日期属于多份报告；局部重读不能替其他原件改锚点。
      return held('report_metadata_shared_event_projection_conflict', undefined, metadata.times, 'shared_event');
    }
    return { reportIds: [row.id], heldReasonCodes: [], heldEvidenceRefs: [],
      change: { kind: 'reproject', row, previousPayload, metadata, clinical, reportDate, eventChanged } };
  }

  private enrichCommittedReportDates(personId: string, documentId: string,
    metadata: ReportMetadataCandidate | null | undefined): CommittedReportDateEnrichment {
    const plan = this.planCommittedReportDateEnrichment(personId, documentId, metadata);
    if (!plan.change) return { reportIds: plan.reportIds, heldReasonCodes: plan.heldReasonCodes, heldEvidenceRefs: plan.heldEvidenceRefs };
    if (plan.change.kind === 'reproject') return this.applyCommittedPrimaryDateProjection(plan.change);
    const { row, previousPayload, fillClinical, fillSigned, supplements } = plan.change;
    const timestamp = this.now().toISOString();
    const nextRevision = row.metadata_revision + 1;
    const reportUpdated = this.db.prepare(`UPDATE report_records SET report_date=?, metadata_status=?, metadata_revision=?
      WHERE id=? AND metadata_revision=? AND metadata_status!='corrected'`)
      .run(fillSigned?.value ?? row.report_date, row.metadata_status === 'unknown' ? 'inferred' : row.metadata_status,
        nextRevision, row.id, row.metadata_revision);
    if (reportUpdated.changes !== 1) throw new RevisionConflictError(row.metadata_revision, nextRevision);
    if (fillClinical) {
      const eventUpdated = this.db.prepare(`UPDATE health_events_v2 SET clinical_date=?, date_precision='day', date_role='exam',
        date_source='explicit', metadata_status=?, metadata_revision=?, updated_at=?
        WHERE id=? AND metadata_revision=? AND clinical_date IS NULL AND date_source!='corrected' AND metadata_status!='corrected'`)
        .run(fillClinical.value, row.event_metadata_status === 'unknown' ? 'inferred' : row.event_metadata_status,
          row.event_metadata_revision + 1, timestamp, row.event_id, row.event_metadata_revision);
      if (eventUpdated.changes !== 1) throw new Error('COMMITTED_REPORT_METADATA_STATE_CHANGED');
    }
    const base: ReportMetadataCandidate = previousPayload.extracted ?? {
      reportKind: null, title: null, organization: null, campus: null, department: null,
      reportNumber: null, examItems: [], times: []
    };
    const dedupe = <T>(values: T[]) => [...new Map(values.map((value) => [JSON.stringify(value), value])).values()];
    this.db.prepare(`INSERT INTO report_metadata_revisions
      (report_id,revision,payload_json,actor,evidence_refs_json,created_at) VALUES (?,?,?,'policy',?,?)`)
      .run(row.id, nextRevision, JSON.stringify({ ...previousPayload,
        extracted: { ...base, times: dedupe([...base.times, ...supplements]) }, action: 'policy_enrich',
        previous: { reportDate: row.report_date, clinicalDate: row.clinical_date, endDate: row.end_date,
          datePrecision: row.date_precision, dateRole: row.date_role, dateSource: row.date_source,
          metadataStatus: row.metadata_status, metadataRevision: row.metadata_revision, extracted: previousPayload.extracted ?? null },
        metadataSupplement: { times: supplements }
      }), JSON.stringify(dedupe([...(JSON.parse(row.evidence_refs_json) as unknown[]), ...supplements.flatMap((time) => time.evidence)])), timestamp);
    this.db.prepare(`INSERT INTO audit_events (id,event_type,entity_id,summary,created_at)
      VALUES (?,'report_metadata.policy_enriched',?,'已按当前原文补充报告日期；历史事实和人工修订保持不变。',?)`)
      .run(randomUUID(), row.id, timestamp);
    return { reportIds: [row.id], heldReasonCodes: [], heldEvidenceRefs: [] };
  }

  private applyCommittedPrimaryDateProjection(change: Extract<NonNullable<CommittedReportDateEnrichmentPlan['change']>, { kind: 'reproject' }>)
    : CommittedReportDateEnrichment {
    const { row, previousPayload, metadata, clinical, reportDate, eventChanged } = change;
    const timestamp = this.now().toISOString();
    const nextRevision = row.metadata_revision + 1;
    const reportUpdated = this.db.prepare(`UPDATE report_records SET report_date=?,metadata_status='inferred',metadata_revision=?
      WHERE id=? AND metadata_revision=? AND report_date IS ? AND metadata_status=? AND metadata_status!='corrected'`)
      .run(reportDate, nextRevision, row.id, row.metadata_revision, row.report_date, row.metadata_status);
    if (reportUpdated.changes !== 1) throw new Error('COMMITTED_REPORT_METADATA_STATE_CHANGED');
    if (eventChanged) {
      const eventUpdated = this.db.prepare(`UPDATE health_events_v2 SET clinical_date=?,end_date=NULL,date_precision=?,date_role='exam',
        date_source=?,metadata_status=?,metadata_revision=?,updated_at=? WHERE id=? AND metadata_revision=?
        AND clinical_date IS ? AND end_date IS ? AND date_precision=? AND date_role=? AND date_source=? AND metadata_status=?
        AND metadata_status!='corrected' AND date_source!='corrected'`)
        .run(clinical?.value ?? null, clinical?.precision ?? 'unknown', clinical ? 'explicit' : 'unknown', clinical ? 'inferred' : 'unknown',
          row.event_metadata_revision + 1, timestamp, row.event_id, row.event_metadata_revision,
          row.clinical_date, row.end_date, row.date_precision, row.date_role, row.date_source, row.event_metadata_status);
      if (eventUpdated.changes !== 1) throw new Error('COMMITTED_REPORT_METADATA_STATE_CHANGED');
    }
    const fields = [metadata.reportKind, metadata.title, metadata.organization, metadata.campus, metadata.department,
      metadata.reportNumber, metadata.encounterIdentifier, ...(metadata.sampleIdentifiers ?? []), ...metadata.examItems, ...metadata.times];
    this.db.prepare(`INSERT INTO report_metadata_revisions
      (report_id,revision,payload_json,actor,evidence_refs_json,created_at) VALUES (?,?,?,'policy',?,?)`)
      .run(row.id, nextRevision, JSON.stringify({ memberModelVersion: MEMBER_MODEL_VERSION, projectionVersion: 'primary-clinical-time-v1',
        action: 'policy_reproject_primary', clinicalDate: clinical?.value ?? null, endDate: null, extracted: metadata,
        previous: { reportDate: row.report_date, clinicalDate: row.clinical_date, endDate: row.end_date,
          datePrecision: row.date_precision, dateRole: row.date_role, dateSource: row.date_source,
          metadataStatus: row.metadata_status, metadataRevision: row.metadata_revision, payload: previousPayload }
      }), JSON.stringify(fields.flatMap((field) => field?.evidence ?? [])), timestamp);
    this.db.prepare(`INSERT INTO audit_events (id,event_type,entity_id,summary,created_at)
      VALUES (?,'report_metadata.policy_reprojected',?,'已按模型明示及当前原件出处重投影主要检查日期；历史事实和人工修订保持不变。',?)`)
      .run(randomUUID(), row.id, timestamp);
    return { reportIds: [row.id], heldReasonCodes: [], heldEvidenceRefs: [] };
  }

  /** 对已经提交的报告做可审计增量补修；既有事实只能由显式纠错流程修改，不能在这里覆盖。 */
  private reconciliationSourceManifest(documentId: string, legacySourceSpanId?: string): SourceManifest {
    const manifest = this.getDocumentExtractionBundle(documentId).manifest;
    if (!legacySourceSpanId || manifest.spans.some((span) => span.id === legacySourceSpanId)) return manifest;
    const spans = this.db.prepare(`SELECT id,document_id,span_kind,page_number,block_id,line_start,line_end,
      quote,readability,normalizer_version,visual_evidence_json,model_evidence_json FROM source_spans WHERE document_id=?`).all(documentId) as Array<{
        id: string; document_id: string; span_kind: SourceManifest['spans'][number]['spanKind'];
        page_number: number | null; block_id: string | null; line_start: number | null; line_end: number | null;
        quote: string | null; readability: SourceManifest['spans'][number]['readability']; normalizer_version: string;
        visual_evidence_json: string | null; model_evidence_json: string | null;
      }>;
    const primary = spans.find((span) => span.id === legacySourceSpanId);
    return { ...manifest, id: `legacy:${legacySourceSpanId}`,
      normalizerVersion: primary?.normalizer_version ?? manifest.normalizerVersion,
      spans: spans.map((span) => ({ id: span.id, documentId: span.document_id, spanKind: span.span_kind,
        page: span.page_number, blockId: span.block_id, lineStart: span.line_start, lineEnd: span.line_end,
        quote: span.quote, readability: span.readability,
        ...(span.visual_evidence_json ? { visualEvidence: JSON.parse(span.visual_evidence_json) as SourceSpan['visualEvidence'] } : {}),
        ...(span.model_evidence_json ? { modelEvidence: JSON.parse(span.model_evidence_json) as SourceSpan['modelEvidence'] } : {}) })) };
  }

  /** 跨版只复用唯一实际来源段；整页位置相同本身不足以证明是同一项。 */
  private sameBoundSourceFinding(incoming: ResolvedReportSourceBinding, previous: ResolvedReportSourceBinding): boolean {
    // direct字段身份来自核心核验过的标题/项目锚点，不再借旧OCR“相同区间”合并。
    // 混合视图或JSON里的未核验标签也不能凭同页、同结果猜测等价。
    if (incoming.sourceViewId.startsWith('codex-original:') || previous.sourceViewId.startsWith('codex-original:')) {
      return sameDirectOriginalField(incoming, previous);
    }
    if (incoming.sourceObjectId !== previous.sourceObjectId || incoming.sourceSha256 !== previous.sourceSha256
      || incoming.documentId !== previous.documentId || incoming.units.length !== previous.units.length) return false;
    const compact = (text: string) => text.normalize('NFKC').replace(/\s+/gu, '');
    const getQuote = this.db.prepare(`SELECT quote FROM source_spans WHERE id=? AND document_id=?`);
    return incoming.units.every((next) => previous.units.some((old) => {
      if (next.page !== old.page) return false;
      if (next.sourceSpanId === old.sourceSpanId && next.segmentStart === old.segmentStart && next.segmentEnd === old.segmentEnd) return true;
      if (!this.isSameSourceLocationInDocument(old.sourceSpanId, next.sourceSpanId)) {
        const a = this.storedFindingGeometry({ ...incoming, units: [next] }, true);
        const b = this.storedFindingGeometry({ ...previous, units: [old] }, true);
        return Boolean(a && b && a.length === b.length && a.every((box) => b.some((other) =>
          box.text === other.text && box.start === other.start && box.end === other.end
          && box.bounds.every((coordinate, index) => Math.abs(coordinate - other.bounds[index]!) <= 0.003)
          && this.samePhysicalVisualBox(box.bounds, other.bounds))));
      }
      const nextSource = (getQuote.get(next.sourceSpanId, incoming.documentId) as { quote: string | null } | undefined)?.quote;
      const oldSource = (getQuote.get(old.sourceSpanId, previous.documentId) as { quote: string | null } | undefined)?.quote;
      if (!nextSource || !oldSource) return false;
      // 跨 OCR 只允许可证明的排版等价，不按结果字符串的长相猜测“是不是数字”。
      // 完整来源正文有变化时，单个词、数值或文字结论即使唯一相同，也不能证明仍属于同一检查。
      if (compact(oldSource) !== compact(nextSource)) return false;
      const text = compact(oldSource.slice(old.segmentStart, old.segmentEnd));
      if (!text || text !== compact(nextSource.slice(next.segmentStart, next.segmentEnd))) return false;
      const appearsOnce = (source: string) => {
        const normalized = compact(source);
        const at = normalized.indexOf(text);
        return at >= 0 && normalized.indexOf(text, at + 1) < 0;
      };
      return appearsOnce(nextSource) && appearsOnce(oldSource);
    }));
  }

  /** 归一化容差不能吞掉长图上相邻的细行/细列，两个真实框必须彼此大幅交叠。 */
  private samePhysicalVisualBox(a: [number, number, number, number], b: [number, number, number, number]): boolean {
    const width = Math.max(0, Math.min(a[0] + a[2], b[0] + b[2]) - Math.max(a[0], b[0]));
    const height = Math.max(0, Math.min(a[1] + a[3], b[1] + b[3]) - Math.max(a[1], b[1]));
    const intersection = width * height;
    return a[2] * a[3] > 0 && b[2] * b[3] > 0 && intersection / (a[2] * a[3]) >= 0.8
      && intersection / (b[2] * b[3]) >= 0.8;
  }

  /** 由真实来源片段的偏移定位已存OCR框，不从项目名或结果值猜测位置。 */
  private storedFindingGeometry(binding: ResolvedReportSourceBinding, requireUniqueSlot = false): Array<{
    bounds: [number, number, number, number]; text: string; start: number; end: number;
  }> | null {
    type Position = { bounds: [number, number, number, number]; text: string; start: number; end: number };
    type StoredSpan = { id: string; document_id: string; page_number: number | null; block_id: string | null;
      quote: string | null; visual_evidence_json: string | null; source_object_id: string; sha256: string };
    const get = this.db.prepare(`SELECT ss.id,ss.document_id,ss.page_number,ss.block_id,ss.quote,ss.visual_evidence_json,
      d.source_object_id,so.sha256 FROM source_spans ss JOIN documents d ON d.id=ss.document_id
      JOIN source_objects so ON so.id=d.source_object_id WHERE ss.id=?`);
    const compact = (text: string) => text.replace(/\s/gu, '');
    const trusted = (span: StoredSpan | undefined) => span && span.document_id === binding.documentId
      && span.source_object_id === binding.sourceObjectId && span.sha256 === binding.sourceSha256
      && span.page_number !== null && span.quote !== null;
    const parseVisual = (span: StoredSpan) => {
      if (!span.visual_evidence_json) return null;
      try {
        const parsed = sourceVisualEvidenceSchema.safeParse(JSON.parse(span.visual_evidence_json));
        if (!parsed.success || compact(parsed.data.rows.map((row) => row.text).join('\n')) !== compact(span.quote!)) return null;
        if (parsed.data.reading.mode === 'region') {
          const parentId = span.block_id?.startsWith('local-vision-region:') ? span.block_id.slice('local-vision-region:'.length) : null;
          const parent = parentId ? get.get(parentId) as StoredSpan | undefined : undefined;
          if (!trusted(parent) || parent!.page_number !== span.page_number || !parent!.visual_evidence_json
            || parent!.block_id?.startsWith('local-vision-region:')) return null;
        }
        return parsed.data;
      } catch { return null; }
    };
    const boxesAt = (span: StoredSpan, start: number, end: number): Position[] | null => {
      const visual = parseVisual(span);
      if (!visual || !span.quote || start < 0 || end <= start || end > span.quote.length) return null;
      const from = compact(span.quote.slice(0, start)).length;
      const until = compact(span.quote.slice(0, end)).length;
      const boxes: Position[] = [];
      let rowStart = 0;
      for (const row of visual.rows) {
        const text = compact(row.text);
        const rowEnd = rowStart + text.length;
        if (from < rowEnd && until > rowStart) {
          let cursor = 0;
          for (const box of row.boxes) {
            const value = compact(box.text);
            const at = value ? text.indexOf(value, cursor) : -1;
            // 严格按真实box顺序重建；同值重复不通过任意字符串搜索绑定到另一列。
            if (at < 0 || !/^[|]*$/u.test(text.slice(cursor, at))) return null;
            if (from < rowStart + at + value.length && until > rowStart + at) {
              // 同框不是同字段：并排同值或参考区间不允许只凭整框坐标判重。
              // 不相交证明可用保守外框；判为同槽位则必须完整覆盖框，或框内只有一个实际数值token。
              if (requireUniqueSlot && (from > rowStart + at || until < rowStart + at + value.length)) {
                const numbers = [...value.matchAll(/[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/gu)];
                if (numbers.length !== 1) return null;
                const number = numbers[0]!;
                const tokenStart = rowStart + at + number.index;
                if (from > tokenStart || until < tokenStart + number[0].length) return null;
              }
              if (requireUniqueSlot && visual.reading.mode === 'region') {
                const parentId = span.block_id!.slice('local-vision-region:'.length);
                const parent = get.get(parentId) as StoredSpan | undefined;
                const parentVisual = parent ? parseVisual(parent) : null;
                if (!parentVisual || parentVisual.rows.flatMap((item) => item.boxes)
                  .filter((item) => this.samePhysicalVisualBox(box.bounds, item.bounds)).length !== 1) return null;
              }
              boxes.push({ bounds: box.bounds, text: value,
                start: Math.max(0, from - rowStart - at), end: Math.min(value.length, until - rowStart - at) });
            }
            cursor = at + value.length;
          }
          if (!/^[|]*$/u.test(text.slice(cursor))) return null;
        }
        rowStart = rowEnd;
      }
      return boxes.length > 0 && boxes.length <= 64 ? boxes : null;
    };
    const result: Position[] = [];
    for (const unit of binding.units) {
      const span = get.get(unit.sourceSpanId) as StoredSpan | undefined;
      if (!trusted(span) || span!.page_number !== unit.page || !span!.quote) return null;
      let boxes = boxesAt(span!, unit.segmentStart, unit.segmentEnd);
      if (!boxes && !span!.visual_evidence_json) {
        // 旧版没有几何时，只将实际来源原句逐字定位到同页唯一新primary；不换字、不按同名同值拼证据。
        const primaries = this.getDocumentExtractionBundle(binding.documentId).manifest.spans.filter((item) =>
          item.page === unit.page && !item.blockId?.startsWith('local-vision-region:') && item.visualEvidence);
        if (primaries.length !== 1) return null;
        const target = get.get(primaries[0]!.id) as StoredSpan | undefined;
        if (!trusted(target) || !target!.quote) return null;
        const quote = span!.quote;
        const targetText = compact(target!.quote!);
        // 整个旧来源单位必须排版等价，不能把旧数值短行搬到新页的“历史记录”中。
        if (targetText !== compact(quote)) return null;
        const mappings = [{ text: quote, start: 0 }].flatMap((witness) => {
          const relative = unit.segmentStart - witness.start;
          if (relative < 0 || unit.segmentEnd > witness.start + witness.text.length
            || !/[\p{Script=Han}A-Za-z]{2}/u.test(compact(witness.text.slice(0, relative)))) return [];
          const text = compact(witness.text);
          const at = targetText.indexOf(text);
          if (at < 0 || targetText.indexOf(text, at + 1) >= 0) return [];
          const from = at + compact(witness.text.slice(0, relative)).length;
          const until = at + compact(witness.text.slice(0, unit.segmentEnd - witness.start)).length;
          const positions: number[] = [];
          for (let index = 0; index < target!.quote!.length; index += 1) if (!/\s/u.test(target!.quote![index]!)) positions.push(index);
          if (positions[from] === undefined || positions[until - 1] === undefined) return [];
          const mapped = boxesAt(target!, positions[from]!, positions[until - 1]! + 1);
          return mapped ? [mapped] : [];
        });
        if (!mappings.length || mappings.some((mapped) => JSON.stringify(mapped) !== JSON.stringify(mappings[0]))) return null;
        boxes = mappings[0]!;
      }
      if (!boxes) return null;
      result.push(...boxes);
    }
    return result.length ? [...new Map(result.map((box) => [JSON.stringify(box), box])).values()] : null;
  }

  /** 只有同一原件同页的全部真实框均不相交，才能证明新增发现不占用旧槽位。 */
  private sourcePositionsProvenDisjoint(incoming: ResolvedReportSourceBinding, previous: ResolvedReportSourceBinding): boolean {
    if (incoming.sourceViewId.startsWith('codex-original:') || previous.sourceViewId.startsWith('codex-original:')) {
      return directOriginalFieldsProvenDistinct(incoming, previous);
    }
    if (incoming.sourceObjectId !== previous.sourceObjectId || incoming.sourceSha256 !== previous.sourceSha256
      || incoming.documentId !== previous.documentId || !incoming.units.length || !previous.units.length
      || incoming.units.some((unit) => unit.page === null) || previous.units.some((unit) => unit.page === null)
      || incoming.units.some((unit) => previous.units.every((old) => old.page !== unit.page))) return false;
    const a = this.storedFindingGeometry(incoming);
    const b = this.storedFindingGeometry(previous);
    const margin = 0.005;
    return Boolean(a && b && a.every(({ bounds: box }) => b.every(({ bounds: other }) => box[0] + box[2] + margin < other[0]
      || other[0] + other[2] + margin < box[0] || box[1] + box[3] + margin < other[1]
      || other[1] + other[3] + margin < box[1])));
  }

  private resolveStoredReportBinding(observation: PublishedObservationInput, manifest: SourceManifest) {
    const candidate = publishedObservationCandidate(observation);
    const storedRoles = this.restoredDirectSourceBindings?.get(observation);
    if (storedRoles) return resolveDirectOriginalSourceBindingFromStoredRoles(candidate, manifest, storedRoles);
    return manifest.spans.some((span) => span.id === observation.sourceSpanId && span.modelEvidence)
      ? resolveDirectOriginalSourceBinding(candidate, manifest) : resolveReportSourceBinding(candidate, manifest);
  }

  /**
   * 从同一旧修订的绑定恢复结果/栏目角色，而非把扁平 evidence 全当结果。
   * 每条引用仍走原有定位门禁，且完整绑定必须重算一致；缺证或歧义时不补猜。
   */
  private restoreStoredDirectSourceRoles(observation: PublishedObservationInput,
    saved: ResolvedReportSourceBinding | null, manifest: SourceManifest): PublishedObservationInput {
    if (!saved?.directOriginalField || saved.sourceViewId !== `codex-original:${manifest.sha256}`
      || saved.documentId !== observation.documentId || saved.sourceObjectId !== manifest.sourceObjectId
      || saved.sourceSha256 !== manifest.sha256 || saved.normalizerVersion !== manifest.normalizerVersion
      || !saved.units.some((unit) => unit.sourceSpanId === observation.sourceSpanId)) return observation;
    const candidate = publishedObservationCandidate(observation);
    if (candidate.evidence.some((ref) => {
      const sources = manifest.spans.filter((span) => span.id === ref.sourceSpanId);
      return sources.length !== 1 || sources[0]!.modelEvidence
        && manifest.spans.filter((span) => span.id === sources[0]!.modelEvidence!.parentSourceSpanId).length !== 1;
    })) return observation;
    const references = [...new Map(candidate.evidence.filter((ref) => ref.sourceRole !== 'duplicate_source')
      .map((ref) => [JSON.stringify([ref.sourceSpanId, ref.quote]), ref])).values()];
    const findings: ObservationCandidate['evidence'] = [];
    for (const unit of saved.units) {
      const sources = manifest.spans.filter((span) => span.id === unit.sourceSpanId);
      if (sources.length !== 1 || sources[0]!.documentId !== observation.documentId
        || !sources[0]!.quote || unit.segmentEnd > sources[0]!.quote!.length) return observation;
      const matching = references.filter((ref) => {
        if (ref.sourceSpanId !== unit.sourceSpanId) return false;
        const resolved = resolveDirectOriginalSourceBinding({ ...candidate,
          sourceBinding: { headingEvidence: [], findingEvidence: [ref] } }, manifest);
        return resolved.status === 'resolved' && resolved.binding.units.length === 1
          && stableHash(resolved.binding.units[0]) === stableHash(unit);
      });
      // null 与整段原句可能投影为同一位置；保留更保守的 null，不凭恢复提升窄引文证明权限。
      const selected = matching.find((ref) => ref.quote === null) ?? (matching.length === 1 ? matching[0] : undefined);
      if (!selected) return observation;
      findings.push(selected);
    }
    const headings: ObservationCandidate['evidence'] = [];
    for (const key of saved.directOriginalField.headingKeys) {
      const matching = references.filter((ref) => {
        const resolved = resolveDirectOriginalSourceBinding({ ...candidate,
          sourceBinding: { headingEvidence: [ref], findingEvidence: findings } }, manifest);
        if (resolved.status !== 'resolved' || resolved.binding.directOriginalField?.headingKeys.length !== 1) return false;
        return resolved.binding.directOriginalField.headingKeys[0] === key
          || projectDirectOriginalLegacyWhitespaceBindingIdentity(resolved.binding)?.directOriginalField?.headingKeys[0] === key;
      });
      if (matching.length !== 1) return observation;
      headings.push(matching[0]!);
    }
    const sourceBinding: NonNullable<ObservationCandidate['sourceBinding']> = { headingEvidence: headings, findingEvidence: findings,
      ...(saved.directOriginalField.structuredSlot ? { structuredSlot: structuredClone(saved.directOriginalField.structuredSlot) } : {}) };
    const restored = resolveDirectOriginalSourceBindingFromStoredRoles({ ...candidate, sourceBinding }, manifest, saved);
    if (restored.status !== 'resolved') return observation;
    const result = { ...observation, sourceBinding };
    // 不删旧引用或旧医疗条件；后续解析仍重证同一保存指纹，仅在内存保留已恢复的空栏目职责。
    (this.restoredDirectSourceBindings ??= new WeakMap()).set(result, saved);
    return result;
  }

  /** 已核验direct来源引用完整保存，供下一次正常重读恢复字段锚点；不补写任何医疗值。 */
  private attachDirectObservationEvidence(observation: PublishedObservationInput, manifest: SourceManifest): PublishedObservationInput {
    const resolution = this.resolveStoredReportBinding(observation, manifest);
    if (resolution.status !== 'resolved' || !isVerifiedDirectOriginalSourceBinding(resolution.binding)) return observation;
    const candidate = publishedObservationCandidate(observation);
    const evidence = [...new Map([...observation.evidence,
      ...(candidate.sourceBinding?.headingEvidence ?? []), ...(candidate.sourceBinding?.findingEvidence ?? []),
      ...observationStructuredSlotEvidence(candidate),
      ...(candidate.clinicalContext?.conditions ?? [])]
      .map((reference) => [JSON.stringify(reference), reference])).values()];
    return { ...observation, evidence,
      ...(observation.candidate ? { candidate: { ...observation.candidate, evidence } } : {}) };
  }

  /** 正式保存重算字段投影；调用方不能只传 null 日期或伪造一条警告绕过原门禁。 */
  private assertDirectOriginalFieldProjections(observations: PublishedObservationInput[],
    metadata: ReportMetadataCandidate | null, reviews: DirectOriginalFieldAdmissionReview[],
    manifest: SourceManifest, documentId: string): void {
    const metadataReviews = reviews.filter((review) => review.kind === 'metadata');
    if (metadataReviews.length > 1) throw new Error('DIRECT_ORIGINAL_FIELD_PROJECTION_INVALID');
    const originalMetadata = metadataReviews[0]?.original ?? metadata;
    if (metadataReviews.length) {
      const original = reportMetadataCandidateSchema.parse(originalMetadata);
      const projection = projectDirectOriginalMetadataFields(original, manifest, documentId);
      if (!projection.reviews.length || stableHash(projection.metadata) !== stableHash(metadata)
        || stableHash(projection.reviews) !== stableHash(metadataReviews[0]!.fields)) {
        throw new Error('DIRECT_ORIGINAL_FIELD_PROJECTION_INVALID');
      }
    }
    const candidateReviews = reviews.filter((review) => review.kind === 'candidate');
    if (new Set(candidateReviews.map((review) => review.original.localKey)).size !== candidateReviews.length) {
      throw new Error('DIRECT_ORIGINAL_FIELD_PROJECTION_INVALID');
    }
    for (const review of candidateReviews) {
      const original = observationCandidateSchema.parse(review.original);
      const projection = projectDirectOriginalCandidateFields(original, manifest,
        { personConsistent: true, overwritesUserLockedValue: false, reportMetadata: originalMetadata });
      if (!projection.reviews.length || stableHash(projection.reviews) !== stableHash(review.fields)) {
        throw new Error('DIRECT_ORIGINAL_FIELD_PROJECTION_INVALID');
      }
      const matches = observations.filter((observation) => observation.candidate?.localKey === original.localKey);
      if (matches.length > 1) throw new Error('DIRECT_ORIGINAL_FIELD_PROJECTION_INVALID');
      for (const observation of matches) {
        const expected = candidateToReconciliationFact(projection.candidate);
        expected.abnormalFlag = normalizedDirectOriginalAbnormalFlag(projection.candidate.reportedAbnormalFlag) ?? 'unknown';
        const actual = publishedReconciliationFact(observation);
        if (stableHash(observation.candidate) !== stableHash(original)
          || (Object.keys(expected) as Array<keyof ReportReconciliationFact>)
            .some((key) => stableHash({ value: actual[key] }) !== stableHash({ value: expected[key] }))
          || stableHash({ value: observation.sourceBinding }) !== stableHash({ value: projection.candidate.sourceBinding })
          || observation.evidence.some((ref) => ![
            ...projection.candidate.evidence, ...(projection.candidate.sourceBinding?.headingEvidence ?? []),
            ...(projection.candidate.sourceBinding?.findingEvidence ?? []), ...observationStructuredSlotEvidence(projection.candidate),
            ...(projection.candidate.clinicalContext?.conditions ?? [])
          ].some((expectedRef) => stableHash(expectedRef) === stableHash(ref)))) {
          throw new Error('DIRECT_ORIGINAL_FIELD_PROJECTION_INVALID');
        }
      }
    }
    for (const observation of observations) {
      if (observation.candidate && observation.candidate.clinicalDate !== observation.clinicalDate
        && !candidateReviews.some((review) => review.original.localKey === observation.candidate!.localKey)) {
        throw new Error('DIRECT_ORIGINAL_FIELD_PROJECTION_REQUIRED');
      }
    }
  }

  /** 已完成的协议归一化留原候选审计，不制造待用户核对事项，也不保留活跃重跑断点。 */
  private recordDirectOriginalProtocolNormalizations(documentId: string, observations: PublishedObservationInput[],
    guard?: JobExecutionGuard): void {
    for (const observation of observations) {
      const candidate = observation.candidate;
      if (!candidate || candidate.reportedAbnormalFlag === null) continue;
      const canonical = normalizedDirectOriginalAbnormalFlag(candidate.reportedAbnormalFlag);
      if (!canonical || canonical === candidate.reportedAbnormalFlag || canonical !== observation.abnormalFlag) continue;
      const payload = { stage: 'extract', protocolNormalization: { version: 1, fieldPath: 'reportedAbnormalFlag',
        originalCandidate: candidate, canonicalValue: canonical, reasonCode: 'direct_original_abnormal_format_normalized' } };
      const existing = this.db.prepare(`SELECT 1 FROM review_issues WHERE field_ref=? AND resolution_status='resolved'
        AND payload_json=? LIMIT 1`).get(`document:${documentId}`, JSON.stringify(payload));
      if (existing) continue;
      this.db.prepare(`INSERT INTO review_issues
        (id,job_id,field_ref,kind,severity,evidence_refs_json,resolution_status,resolution_revision,payload_json,created_at)
        VALUES (?,?,?,'coverage_gap','warning',?,'resolved',1,?,?)`).run(randomUUID(), guard?.jobId ?? null,
          `document:${documentId}`, JSON.stringify(candidate.evidence.map((ref) => ref.sourceSpanId)),
          JSON.stringify(payload), this.now().toISOString());
    }
  }

  /** 来源接纳计划只有 SELECT 和内存对象操作，预检与正式事务复用同一判定。 */
  private planReportSourceAdmission(input: {
    mode: 'publish' | 'append'; personId: string; documentId: string; manifest: SourceManifest | null;
    observations: PublishedObservationInput[]; reportMetadata?: ReportMetadataCandidate | null;
    sourceRefinementReview?: DirectOriginalSourceRefinementReview;
    executionGuard?: JobExecutionGuard;
    fieldReviews?: DirectOriginalFieldAdmissionReview[];
  }): ReportSourceAdmissionPlan {
    const dateCorrection = input.executionGuard && this.isDateCorrectionJob(input.executionGuard.jobId)
      ? this.assertDateCorrectionScope(input.executionGuard, input.documentId) : null;
    const currentManifest = input.manifest;
    if (!currentManifest) {
      if (input.mode !== 'publish' || input.observations.length > 0) throw new Error('SOURCE_MANIFEST_MISSING');
      return { existingRows: [], additions: [], admittedObservations: [], bindings: new Map(), refinements: new Map(), held: [], heldCandidates: [], heldReasonCodes: [], duplicateCount: 0 };
    }
    this.assertDirectOriginalFieldProjections(input.observations, input.reportMetadata ?? null,
      input.fieldReviews ?? [], currentManifest, input.documentId);
    const incomingObservations = input.observations.map((item) => this.attachDirectObservationEvidence(item, currentManifest));
    const existingRows = input.mode === 'append' ? this.db.prepare(`
      SELECT o.id,o.current_revision,o.concept_key,o.original_name,r.value_kind,r.raw_text,
        r.decimal_value,r.qualifier,r.unit,r.reference_range,r.abnormal_flag,r.specimen,r.method,r.body_site,
        r.source_span_id,r.evidence_json,r.clinical_context_json,r.source_binding_json,r.clinical_date,
        ad.actor AS acceptance_actor,
        EXISTS(SELECT 1 FROM concept_mapping_corrections c WHERE c.observation_id=o.id AND c.active=1) AS user_locked
      FROM observations o JOIN observation_revisions r ON r.observation_id=o.id AND r.revision=o.current_revision
      JOIN source_spans ss ON ss.id=r.source_span_id JOIN acceptance_decisions ad ON ad.id=r.acceptance_id
      WHERE ss.document_id=? AND o.person_id=?`).all(input.documentId, input.personId) as StoredReconciliationObservationRow[] : [];
    const existingObservations = existingRows.map((row): PublishedObservationInput => ({
      conceptKey: row.concept_key, originalName: row.original_name ?? row.concept_key,
      modelStandardNameCandidate: null, rawText: row.raw_text, valueKind: row.value_kind,
      decimalValue: row.decimal_value, qualifier: row.qualifier, unit: row.unit, referenceRange: row.reference_range,
      clinicalDate: row.clinical_date, abnormalFlag: row.abnormal_flag, documentId: input.documentId,
      sourceSpanId: row.source_span_id, acceptanceId: '', specimen: row.specimen, method: row.method, bodySite: row.body_site,
      clinicalContext: row.clinical_context_json ? JSON.parse(row.clinical_context_json) as ClinicalContext : null,
      evidence: JSON.parse(row.evidence_json) as PublishedObservationInput['evidence']
    }));
    const comparisonRecords = new Map<string, DirectOriginalAdmissionComparisonRecord>();
    const comparisonRecord = (recordId: string, observation: PublishedObservationInput, manifest: SourceManifest,
      origin: DirectOriginalAdmissionComparisonRecord['origin'], resolved: boolean): DirectOriginalAdmissionComparisonRecord => {
      const candidate = publishedObservationCandidate(observation);
      return { recordId, origin, bindingStatus: resolved ? 'resolved' : 'unresolved', candidate,
        sourceSpans: admissionDiagnosticSourceSpans(manifest, input.documentId, [...candidate.evidence,
          ...(candidate.sourceBinding?.headingEvidence ?? []), ...(candidate.sourceBinding?.findingEvidence ?? []),
          ...observationStructuredSlotEvidence(candidate),
          ...(candidate.clinicalContext?.conditions ?? [])]) };
    };
    const physicalRecords = existingRows.map((row, index) => {
      const storedObservation = existingObservations[index]!;
      const sourceManifest = currentManifest.spans.some((span) => span.id === row.source_span_id)
        ? currentManifest : this.reconciliationSourceManifest(input.documentId, row.source_span_id);
      const savedBinding = storedReportSourceBinding(row.source_binding_json);
      const observation = this.restoreStoredDirectSourceRoles(storedObservation, savedBinding, sourceManifest);
      existingObservations[index] = observation;
      const resolution = this.resolveStoredReportBinding(observation, sourceManifest);
      const source = sourceManifest.spans.find((span) => span.id === observation.sourceSpanId);
      // 历史direct绑定只在内存重新证明，不修改旧修订，也不相信JSON自行声明的标签。
      // 有显式旧角色却无法重证时不能退回扁平推断；更早没有字段角色的绑定仍走原保守兼容。
      const binding = source?.modelEvidence || savedBinding?.sourceViewId.startsWith('codex-original:')
        ? row.source_binding_json && (!savedBinding || savedBinding.directOriginalField) && observation === storedObservation ? null
          : resolution.status === 'resolved' ? resolution.binding : null
        : savedBinding ?? (resolution.status === 'resolved' ? resolution.binding : null);
      // 原始文档和成员已经由查询限域；来源版本还须与本次原件一致，旧JSON标签不构成证明。
      if (sourceManifest.sourceObjectId === currentManifest.sourceObjectId && sourceManifest.sha256 === currentManifest.sha256
        && (!savedBinding || savedBinding.documentId === input.documentId && savedBinding.sourceObjectId === currentManifest.sourceObjectId
          && savedBinding.sourceSha256 === currentManifest.sha256)) {
        comparisonRecords.set(row.id, { ...comparisonRecord(row.id, observation, sourceManifest, 'stored_version', binding !== null),
          recordRevision: row.current_revision, recordHash: stableHash(row) });
      }
      return { recordId: row.id, fact: publishedReconciliationFact(observation), binding,
        sourcePageScope: observationSourcePageScope(observation, sourceManifest) };
    });
    const canonicalSelection = input.mode === 'append'
      ? this.canonicalStoredObservationRows(input.personId, input.documentId, currentManifest) : null;
    const canonicalIds = canonicalSelection && new Set(canonicalSelection.observations.map((entry) => entry.observationId));
    const records = physicalRecords.filter((record) => !canonicalIds || canonicalIds.has(record.recordId));
    const storedComparisonRecords = new Map(comparisonRecords);
    const additions: PublishedObservationInput[] = [];
    const bindings = new Map<PublishedObservationInput, ResolvedReportSourceBinding | null>();
    const bindingReasons = new Map<PublishedObservationInput, string>();
    const refinements: ReportSourceAdmissionPlan['refinements'] = new Map();
    const held: DirectOriginalAdmissionPreview['held'] = [];
    const heldCandidates: ObservationCandidate[] = [];
    const heldReasonCodes: string[] = [];
    const heldObservations = new Set<PublishedObservationInput>();
    const diagnostic = (decision: ReturnType<typeof reconcileReportFact>, kind: DirectOriginalAdmissionDiagnostic['kind'] = 'reconciliation',
      comparisons = decision.existingRecordIds.flatMap((id) => {
        const record = comparisonRecords.get(id); return record ? [record] : [];
      })): DirectOriginalAdmissionDiagnostic => ({ kind, decision: decision.decision, changedFields: decision.changedFields,
        comparisonScope: admissionComparisonScope(comparisons), comparisons });
    const hold = (observation: PublishedObservationInput, reasons: string[], detail: DirectOriginalAdmissionDiagnostic) => {
      heldObservations.add(observation);
      const specific = bindingReasons.get(observation);
      const completeReasons = [...new Set([...reasons, ...(specific ? [specific] : [])])];
      const candidate = heldReconciliationCandidate(observation, completeReasons);
      held.push({ candidate, reasons: completeReasons, diagnostic: detail });
      heldCandidates.push(candidate); heldReasonCodes.push(...completeReasons);
    };
    for (const observation of incomingObservations) {
      const resolution = this.resolveStoredReportBinding(observation, currentManifest);
      bindings.set(observation, resolution.status === 'resolved' ? resolution.binding : null);
      if (resolution.status === 'unresolved') bindingReasons.set(observation, resolution.reason);
    }
    const batchConflicts = conflictingSourceBatchGroups(incomingObservations, bindings);
    const userDateCorrection = input.mode === 'append' && Boolean(this.db.prepare(`SELECT 1 FROM report_records r
      JOIN report_source_links l ON l.report_id=r.id WHERE l.document_id=?
        AND r.person_id=? AND r.metadata_status='corrected' LIMIT 1`).get(input.documentId, input.personId));
    const inputByRecord = new Map<string, PublishedObservationInput>();
    // 同一旧槽的来源补齐若出现竞争，整批撤回且不允许后续重复输入复活最后一个映射。
    const sourceRefinementInputs = new Map<string, PublishedObservationInput[]>();
    const blockedSourceRefinementTargets = new Set<string>();
    const incomingRecordIds = new Map(incomingObservations.map((observation, index) => [observation, `incoming:${index}`]));
    const sourceRefinementProofs: DirectOriginalSourceRefinementProof[] = [];
    // 只有已核验P03映射且医疗字段完全不变的旧整行，才可在本批对账中提供新槽位投影。
    // 不先修改正式旧行；依赖该投影的新增将在映射未接纳时一并撤回。
    const groundedRefinementReservations = new Map<string, { observation: PublishedObservationInput;
      binding: ResolvedReportSourceBinding }>();
    const admissionDependencies = new Map<PublishedObservationInput, Set<string>>();
    const sourceRefinementHolds = new Map<PublishedObservationInput, {
      recordIds: string[]; changedFields: string[]; reason: string;
    }>();
    if (input.sourceRefinementReview) {
      if (input.mode !== 'append' || !input.executionGuard || dateCorrection) {
        throw new Error('DIRECT_ORIGINAL_SOURCE_REFINEMENT_SCOPE_INVALID');
      }
      const guard = input.executionGuard;
      this.assertJobExecutionActive(guard, input.documentId);
      const receipts = this.db.prepare(`SELECT t.id AS transmissionId,t.stage,p.proof_version AS proofVersion,
        p.input_signature AS inputSignature,p.output_hash AS outputHash,p.thread_id AS threadId,p.turn_id AS turnId
        FROM ai_transmissions t JOIN job_attempts a ON a.id=t.attempt_id AND a.job_id=t.job_id
        JOIN ai_transmission_receipts p ON p.transmission_id=t.id
        WHERE t.job_id=? AND t.consent_id=? AND t.document_id=? AND t.status='completed' AND t.finished_at IS NOT NULL
        AND a.model='gpt-6.1-sol' AND a.reasoning_effort='medium'`).all(guard.jobId, guard.consentId,
        input.documentId) as DirectOriginalSourceRefinementReceipt[];
      const mappings = verifyDirectOriginalSourceRefinementReview({ review: input.sourceRefinementReview,
        documentId: input.documentId, factRevision: this.getFactRevision(input.personId), manifest: currentManifest, receipts });
      const proposals: Array<{ observation: PublishedObservationInput; previous: typeof records[number] }> = [];
      for (const mapping of mappings) {
        const row = existingRows.find((item) => item.id === mapping.target.recordId);
        if (!row || row.current_revision !== mapping.target.recordRevision || stableHash(row) !== mapping.target.recordHash) {
          throw new Error('DIRECT_ORIGINAL_SOURCE_REFINEMENT_VERSION_CHANGED');
        }
        const rawInputs = input.observations.filter((item) => item.candidate?.localKey === mapping.target.candidateKey);
        const incoming = incomingObservations.filter((item) => item.candidate?.localKey === mapping.target.candidateKey);
        // 结构校验未通过的候选不在本次接纳集合；它已有局部疑点，不能让无写入目标的映射拖停其他结果。
        if (rawInputs.length === 0 && incoming.length === 0) continue;
        if (rawInputs.length !== 1 || incoming.length !== 1
          || stableHash(rawInputs[0]!.candidate) !== stableHash(mapping.candidate)) {
          throw new Error('DIRECT_ORIGINAL_SOURCE_REFINEMENT_CANDIDATE_CHANGED');
        }
        const previous = physicalRecords.find((record) => record.recordId === row.id)!;
        const next = incoming[0]!;
        // 别名只改变读取，不替换旧P03明确授权的CAS目标；被隐藏的旧ID不得顺便写到另一个修订。
        if (canonicalIds && !canonicalIds.has(row.id)) {
          sourceRefinementHolds.set(next, { recordIds: [row.id], changedFields: [],
            reason: 'source_binding_refinement_noncanonical_target' });
          continue;
        }
        const candidate = mapping.candidate;
        const flag = candidate.reportedAbnormalFlag?.trim().toLocaleLowerCase('zh-CN');
        const expectedFact: ReportReconciliationFact = { originalName: candidate.originalName,
          valueKind: candidate.value.kind, rawText: candidate.value.rawText ?? '',
          decimalValue: candidate.value.kind === 'numeric' ? candidate.value.decimal : null,
          qualifier: candidate.value.kind === 'numeric' ? candidate.value.comparator
            : candidate.value.kind === 'qualitative' ? candidate.value.category : null,
          unit: candidate.unitRaw, referenceRange: candidate.referenceRangeRaw,
          abnormalFlag: flag && ['high', 'low', 'positive', 'negative', 'normal'].includes(flag) ? flag : 'unknown',
          specimen: candidate.specimen, method: candidate.method, bodySite: candidate.bodySite,
          clinicalDate: candidate.clinicalDate, clinicalContext: candidate.clinicalContext ?? null };
        const expectedReferences = [...candidate.evidence, ...(candidate.sourceBinding?.headingEvidence ?? []),
          ...(candidate.sourceBinding?.findingEvidence ?? []), ...observationStructuredSlotEvidence(candidate),
          ...(candidate.clinicalContext?.conditions ?? [])];
        const referenceSet = (references: PublishedObservationInput['evidence']) =>
          [...new Set(references.map((reference) => JSON.stringify(reference)))].sort();
        const primary = (candidate.sourceBinding?.findingEvidence ?? candidate.evidence).find((reference) =>
          reference.sourceRole !== 'duplicate_source' && currentManifest.spans.some((span) => span.id === reference.sourceSpanId
            && span.modelEvidence && ['finding', 'instruction'].includes(span.modelEvidence.role)));
        // candidate 与外层存档投影必须同时来自同一真实返回；不能保留回包外壳却偷换外围医疗字段或引用。
        const actualFact = publishedReconciliationFact(next);
        const raw = rawInputs[0]!;
        const rawReferences = stableHash(referenceSet(raw.evidence));
        const expandedReferences = stableHash(referenceSet(expectedReferences));
        const expectedAttachedReferences = bindings.get(next) ? expandedReferences : rawReferences;
        if ((Object.keys(expectedFact) as Array<keyof ReportReconciliationFact>).some((field) =>
          JSON.stringify(actualFact[field]) !== JSON.stringify(expectedFact[field]))
          || stableHash(next.sourceBinding ?? null) !== stableHash(candidate.sourceBinding ?? null)
          || next.sourceSpanId !== primary?.sourceSpanId
          || ![stableHash(referenceSet(candidate.evidence)), expandedReferences].includes(rawReferences)
          || stableHash(referenceSet(next.evidence)) !== expectedAttachedReferences) {
          throw new Error('DIRECT_ORIGINAL_SOURCE_REFINEMENT_CANDIDATE_CHANGED');
        }
        proposals.push({ observation: next, previous });
        const changedFields = (Object.keys(expectedFact) as Array<keyof ReportReconciliationFact>).filter((field) =>
          JSON.stringify(expectedFact[field] ?? null) !== JSON.stringify(previous.fact[field] ?? null));
        if (row.user_locked || row.acceptance_actor !== 'policy' || userDateCorrection) {
          sourceRefinementHolds.set(next, { recordIds: [row.id], changedFields,
            reason: 'source_binding_refinement_not_authorized' });
          continue;
        }
        const proof = createDirectOriginalSourceRefinementProof({ recordId: incomingRecordIds.get(next)!,
          fact: publishedReconciliationFact(next), binding: bindings.get(next) ?? null,
          sourcePageScope: observationSourcePageScope(next, currentManifest) }, previous);
        if (proof) {
          sourceRefinementProofs.push(proof);
          const nextBinding = bindings.get(next);
          if (nextBinding && previous.binding && !batchConflicts.has(next)
            && directOriginalLegacyFieldCanUpgradeToGroundedSlot(nextBinding, previous.binding)) {
            groundedRefinementReservations.set(previous.recordId, { observation: next, binding: nextBinding });
          }
        }
        else sourceRefinementHolds.set(next, { recordIds: [row.id], changedFields,
          reason: changedFields.length ? 'source_refinement_medical_fields_changed' : 'source_binding_requires_unique_mapping' });
      }
      // 一个旧短引文若也能落入本批另一处真实新槽，显式别名不能代替位置消歧。
      // 先整体判定再接纳，避免输入顺序使第一个来源映射抢先成功。
      for (const proposal of proposals) {
        const previousBinding = proposal.previous.binding;
        if (!previousBinding) continue;
        const grounded = groundedRefinementReservations.get(proposal.previous.recordId);
        if (grounded?.observation === proposal.observation) {
          const competing = proposals.filter((other) => other !== proposal && bindings.get(other.observation)
            && other.previous.binding
            && (directOriginalLegacyFieldCanUpgradeToGroundedSlot(bindings.get(other.observation)!, previousBinding)
              || directOriginalLegacyFieldCanUpgradeToGroundedSlot(grounded.binding, other.previous.binding))
            && (other.previous.recordId === proposal.previous.recordId
              || !groundedRefinementReservations.has(other.previous.recordId)
              || !directOriginalFieldsProvenDistinct(grounded.binding, bindings.get(other.observation)!)));
          const unmapped = records.filter((record) => record.recordId !== proposal.previous.recordId && record.binding
            && directOriginalLegacyFieldCanUpgradeToGroundedSlot(grounded.binding, record.binding)
            && !groundedRefinementReservations.has(record.recordId));
          if (!competing.length && !unmapped.length) continue;
          const recordIds = [...new Set([proposal.previous.recordId, ...competing.map((item) => item.previous.recordId),
            ...unmapped.map((item) => item.recordId)])];
          sourceRefinementHolds.set(proposal.observation, { recordIds, changedFields: [], reason: 'source_binding_ambiguous' });
          for (const other of competing) sourceRefinementHolds.set(other.observation,
            { recordIds, changedFields: [], reason: 'source_binding_ambiguous' });
          for (const recordId of recordIds) blockedSourceRefinementTargets.add(recordId);
          continue;
        }
        const matching = proposals.filter((other) => {
          const binding = bindings.get(other.observation);
          return binding && directOriginalExpandedFindingProvesSourceRefinement(binding, previousBinding);
        });
        const distinctSlots: ResolvedReportSourceBinding[] = [];
        for (const other of matching) {
          const binding = bindings.get(other.observation)!;
          if (!distinctSlots.some((existing) => sameDirectOriginalField(binding, existing))) distinctSlots.push(binding);
        }
        if (distinctSlots.length <= 1) continue;
        const recordIds = [...new Set([proposal.previous.recordId, ...matching.map((other) => other.previous.recordId)])];
        for (const other of matching) sourceRefinementHolds.set(other.observation,
          { recordIds, changedFields: [], reason: 'source_binding_ambiguous' });
        for (const recordId of recordIds) blockedSourceRefinementTargets.add(recordId);
      }
      // 明确映射已失败的旧目标，本批另一候选也不能再抢先补来源。
      for (const failure of sourceRefinementHolds.values()) {
        for (const recordId of failure.recordIds) blockedSourceRefinementTargets.add(recordId);
      }
      for (const targetId of blockedSourceRefinementTargets) groundedRefinementReservations.delete(targetId);
    }
    let duplicateCount = 0;
    const duplicateObservations = new Set<PublishedObservationInput>();
    for (const [index, observation] of incomingObservations.entries()) {
      const binding = bindings.get(observation) ?? null;
      const recordId = `incoming:${index}`;
      const mappedHold = sourceRefinementHolds.get(observation);
      if (mappedHold) {
        // 显式旧行来源补齐失败只能保留疑点，不能退回普通新增绕过同字段限制。
        hold(observation, [mappedHold.reason], diagnostic({ decision: 'unresolved',
          existingRecordIds: mappedHold.recordIds, changedFields: mappedHold.changedFields, reasonCodes: [mappedHold.reason] }));
        continue;
      }
      const batchConflict = batchConflicts.get(observation);
      if (batchConflict) {
        const comparisons = batchConflict.observations.filter((other) => other !== observation).map((other) =>
          comparisonRecord(incomingRecordIds.get(other)!, other, currentManifest, 'current_reading', Boolean(bindings.get(other))));
        hold(observation, ['same_source_finding_batch_conflict'], diagnostic({ decision: 'conflict',
          existingRecordIds: comparisons.map((record) => record.recordId), changedFields: batchConflict.changedFields,
          reasonCodes: ['same_source_finding_batch_conflict'] }, 'batch_conflict', comparisons));
        continue;
      }
      const incoming = { recordId, fact: publishedReconciliationFact(observation), binding,
        sourcePageScope: observationSourcePageScope(observation, currentManifest) };
      const dateEvidence = input.mode === 'append'
        ? this.explicitClinicalDateEvidence(input.documentId, observation, input.reportMetadata, currentManifest) : [];
      const dependencies = new Set<string>();
      const effectiveRecords = records.map((record) => {
        const reservation = groundedRefinementReservations.get(record.recordId);
        // 映射自身仍以原始旧绑定核验 branded proof；其他字段只看到同批已核验的一对一位置。
        if (!reservation || reservation.observation === observation) return record;
        if (binding && record.binding && !directOriginalFieldsProvenDistinct(binding, record.binding)) dependencies.add(record.recordId);
        return { ...record, binding: reservation.binding };
      });
      let decision = reconcileReportFact(incoming, effectiveRecords, input.mode === 'publish' ? {
        sameSourceUnit: sameDirectOriginalField, sourcePositionsProvenDisjoint: directOriginalFieldsProvenDistinct
      } : {
        sourceRefinementProofs,
        sameSourceUnit: (next, previous) => this.sameBoundSourceFinding(next, previous),
        sourcePositionsProvenDisjoint: (next, previous) => this.sourcePositionsProvenDisjoint(next, previous),
        canRefineClinicalDate: (_next, previous) => {
          const row = existingRows.find((item) => item.id === previous.recordId);
          return Boolean(row && !userDateCorrection && row.user_locked === 0 && row.acceptance_actor === 'policy' && dateEvidence.length > 0);
        },
        canRefineClinicalContext: (next, previous) => {
          const row = existingRows.find((item) => item.id === previous.recordId);
          const context = observation.clinicalContext;
          return Boolean(row && !userDateCorrection && row.user_locked === 0 && row.acceptance_actor === 'policy'
            && next.binding && previous.binding && isVerifiedDirectOriginalSourceBinding(next.binding)
            && isVerifiedDirectOriginalSourceBinding(previous.binding) && sameDirectOriginalField(next.binding, previous.binding)
            && context?.status === 'complete' && context.conditions.length > 0
            && this.groundedClinicalContextJson(input.documentId, context, currentManifest) !== null);
        },
        canRefineSourceBinding: (next, previous) => {
          const row = existingRows.find((item) => item.id === previous.recordId);
          // 日期纠错不是来源扩权入口；已人工修正/锁定的事实仍只保留原版本。
          return Boolean(row && !dateCorrection && !userDateCorrection && row.user_locked === 0
            && row.acceptance_actor === 'policy' && next.binding && previous.binding
            && isVerifiedDirectOriginalSourceBinding(next.binding) && isVerifiedDirectOriginalSourceBinding(previous.binding));
        }
      });
      for (const matchedId of decision.existingRecordIds) {
        const previousInput = inputByRecord.get(matchedId);
        if (previousInput) for (const dependency of admissionDependencies.get(previousInput) ?? []) dependencies.add(dependency);
      }
      admissionDependencies.set(observation, dependencies);
      if (dateCorrection) {
        // 独立原件核验仍不能覆盖别的医疗值；唯一同字段且只改非空日期才有此能力。
        const target = decision.existingRecordIds.length === 1 ? existingRows.find((row) => row.id === decision.existingRecordIds[0]) : null;
        const allowedDate = Boolean(target && !userDateCorrection && target.user_locked === 0
          && target.acceptance_actor === 'policy' && target.clinical_date && observation.clinicalDate
          && dateEvidence.length > 0 && binding && records.find((record) => record.recordId === target.id)?.binding
          && isVerifiedDirectOriginalSourceBinding(binding)
          && decision.changedFields.length === 1 && decision.changedFields[0] === 'clinicalDate'
          && input.reportMetadata?.times.some((time) => time.value === observation.clinicalDate
            && ['sampled', 'examined', 'encounter'].includes(time.role)));
        if (decision.decision === 'conflict' && allowedDate) decision = { ...decision, decision: 'enrichment', reasonCodes: [] };
        else if (decision.decision !== 'duplicate' && !(decision.decision === 'enrichment' && allowedDate)) {
          hold(observation, ['date_correction_only_existing_date_allowed', ...decision.reasonCodes], diagnostic(decision));
          continue;
        }
      }
      const legacySingle = input.mode === 'publish' && !observation.candidate && !observation.sourceBinding
        && decision.decision === 'unresolved'
        && !additions.some((previous) => committedFactIdentity(previous) === committedFactIdentity(observation));
      if (decision.decision === 'addition' || legacySingle) {
        additions.push(observation); records.push(incoming); inputByRecord.set(recordId, observation);
        comparisonRecords.set(recordId, comparisonRecord(recordId, observation, currentManifest, 'current_reading', Boolean(binding))); continue;
      }
      if (decision.decision === 'duplicate') { duplicateCount += 1; duplicateObservations.add(observation); continue; }
      if (decision.decision === 'enrichment' && binding && decision.existingRecordIds.length === 1) {
        const target = decision.existingRecordIds[0]!;
        const field = decision.changedFields[0] === 'clinicalContext' ? 'clinicalContext'
          : decision.changedFields[0] === 'sourceBinding' ? 'sourceBinding' : 'clinicalDate';
        const pending = refinements.get(target);
        if (field === 'sourceBinding' || pending?.field === 'sourceBinding') {
          if (blockedSourceRefinementTargets.has(target) || pending && (pending.field !== field
            || !sameDirectOriginalField(binding, pending.binding))) {
            blockedSourceRefinementTargets.add(target);
            const conflict = { ...decision, decision: 'unresolved' as const, reasonCodes: ['source_binding_ambiguous'] };
            hold(observation, conflict.reasonCodes, diagnostic(conflict));
            for (const previous of sourceRefinementInputs.get(target) ?? (pending ? [pending.observation] : [])) {
              hold(previous, conflict.reasonCodes, diagnostic(conflict, 'reconciliation',
                [comparisonRecord(recordId, observation, currentManifest, 'current_reading', true)]));
            }
            sourceRefinementInputs.delete(target); refinements.delete(target); inputByRecord.delete(target);
            const previousIndex = existingRows.findIndex((row) => row.id === target);
            records.find((item) => item.recordId === target)!.fact = publishedReconciliationFact(existingObservations[previousIndex]!);
            const storedComparison = storedComparisonRecords.get(target);
            if (storedComparison) comparisonRecords.set(target, storedComparison);
            else comparisonRecords.delete(target);
            continue;
          }
          if (field === 'sourceBinding') sourceRefinementInputs.set(target, [...(sourceRefinementInputs.get(target) ?? []), observation]);
        }
        const contextJson = field === 'clinicalContext'
          ? this.groundedClinicalContextJson(input.documentId, observation.clinicalContext, currentManifest) : null;
        if (field === 'clinicalContext' && !contextJson) { hold(observation, ['clinical_context_enrichment_unproven'], diagnostic(decision)); continue; }
        // 新来源可以补栏目，不能借此删除旧引用；旧修订和原医疗字段在事务中逐字保留。
        const refinedObservation = field === 'sourceBinding' ? { ...observation, evidence: [...new Map([
          ...(existingObservations[existingRows.findIndex((row) => row.id === target)]!.evidence), ...observation.evidence
        ].map((reference) => [JSON.stringify(reference), reference])).values()] } : observation;
        refinements.set(target, { observation: refinedObservation, binding, field, dateEvidence, ...(contextJson ? { contextJson } : {}) });
        records.find((item) => item.recordId === target)!.fact = incoming.fact;
        comparisonRecords.set(target, comparisonRecord(target, observation, currentManifest, 'current_reading', true));
        inputByRecord.set(target, observation); continue;
      }
      const reasons = decision.reasonCodes.length ? decision.reasonCodes : ['source_binding_unresolved'];
      hold(observation, reasons, diagnostic(decision));
      for (const previousId of decision.existingRecordIds) {
        // 冲突先到也不能被后续清晰候选掩盖；仅禁止该旧目标在本批再进行来源补齐。
        if (existingRows.some((row) => row.id === previousId)) blockedSourceRefinementTargets.add(previousId);
        const pending = inputByRecord.get(previousId);
        if (!pending) continue;
        if (refinements.has(previousId)) {
          const sourceInputs = refinements.get(previousId)!.field === 'sourceBinding'
            ? sourceRefinementInputs.get(previousId) ?? [pending] : [pending];
          if (refinements.get(previousId)!.field === 'sourceBinding') blockedSourceRefinementTargets.add(previousId);
          refinements.delete(previousId);
          sourceRefinementInputs.delete(previousId); inputByRecord.delete(previousId);
          const previousIndex = existingRows.findIndex((row) => row.id === previousId);
          const record = records.find((item) => item.recordId === previousId);
          if (previousIndex >= 0 && record) record.fact = publishedReconciliationFact(existingObservations[previousIndex]!);
          for (const previous of sourceInputs) hold(previous, reasons, diagnostic(decision, 'reconciliation',
            [comparisonRecord(recordId, observation, currentManifest, 'current_reading', Boolean(binding))]));
          const storedComparison = storedComparisonRecords.get(previousId);
          if (storedComparison) comparisonRecords.set(previousId, storedComparison);
          else comparisonRecords.delete(previousId);
        }
        const at = additions.indexOf(pending);
        if (at >= 0) { additions.splice(at, 1); hold(pending, reasons, diagnostic(decision, 'reconciliation',
          [comparisonRecord(recordId, observation, currentManifest, 'current_reading', Boolean(binding))])); }
      }
    }
    // 临时位置并非已写结果。若指定映射未被接纳，所有借它消除旧整行歧义的新增/判重/补强
    // 也必须撤回；固定点传播处理两个映射互相依赖，不能由输入先后次序留下半升级。
    const failedGroundedTargets = new Set<string>();
    const reservationAccepted = (targetId: string, reservation: { observation: PublishedObservationInput }) =>
      !heldObservations.has(reservation.observation) && refinements.get(targetId)?.field === 'sourceBinding'
      && sourceRefinementInputs.get(targetId)?.includes(reservation.observation) === true;
    for (const [targetId, reservation] of groundedRefinementReservations) {
      if (!reservationAccepted(targetId, reservation)) failedGroundedTargets.add(targetId);
    }
    for (let changed = true; changed;) {
      changed = false;
      for (const [observation, dependencies] of admissionDependencies) {
        const missing = [...dependencies].filter((targetId) => failedGroundedTargets.has(targetId));
        if (!missing.length || heldObservations.has(observation)) continue;
        hold(observation, ['source_binding_requires_unique_mapping'], diagnostic({ decision: 'unresolved',
          existingRecordIds: missing, changedFields: [], reasonCodes: ['source_binding_requires_unique_mapping'] }));
        const additionIndex = additions.indexOf(observation);
        if (additionIndex >= 0) additions.splice(additionIndex, 1);
        if (duplicateObservations.delete(observation)) duplicateCount -= 1;
        for (const [targetId, refinement] of refinements) {
          if (refinement.observation !== observation && !sourceRefinementInputs.get(targetId)?.includes(observation)) continue;
          refinements.delete(targetId); sourceRefinementInputs.delete(targetId); inputByRecord.delete(targetId);
          const previousIndex = existingRows.findIndex((row) => row.id === targetId);
          const record = records.find((item) => item.recordId === targetId);
          if (previousIndex >= 0 && record) record.fact = publishedReconciliationFact(existingObservations[previousIndex]!);
          const storedComparison = storedComparisonRecords.get(targetId);
          if (storedComparison) comparisonRecords.set(targetId, storedComparison);
          if (groundedRefinementReservations.has(targetId) && !failedGroundedTargets.has(targetId)) {
            failedGroundedTargets.add(targetId); changed = true;
          }
        }
      }
    }
    return { existingRows, additions, admittedObservations: incomingObservations.filter((item) => !heldObservations.has(item)),
      bindings, refinements, held, heldCandidates, heldReasonCodes, duplicateCount };
  }

  /** 模型返回前的原件预检：不保存来源、决定、事实、问题、事件或临时记录。 */
  previewDirectOriginalAdmission(input: DirectOriginalAdmissionPreviewInput): DirectOriginalAdmissionPreview {
    if (input.executionGuard) this.assertJobExecutionActive(input.executionGuard, input.documentId);
    const manifest = sourceManifestSchema.parse(input.manifest);
    const owner = this.db.prepare(`SELECT d.person_id,d.source_object_id,d.excluded_from_analysis,so.sha256
      FROM documents d JOIN source_objects so ON so.id=d.source_object_id WHERE d.id=?`)
      .get(input.documentId) as { person_id: string | null; source_object_id: string; excluded_from_analysis: number; sha256: string } | undefined;
    if (!owner || owner.person_id !== input.personId || owner.excluded_from_analysis !== 0) throw new Error('DOCUMENT_PERSON_SCOPE_MISMATCH');
    const stored = sourceManifestSchema.parse(this.reconciliationSourceManifest(input.documentId));
    const primary = (value: SourceManifest) => value.spans.filter((span) => !span.modelEvidence && !span.visualEvidence);
    const existingSpans = new Map(stored.spans.map((span) => [span.id, span]));
    if (!manifest.normalizerVersion.startsWith('direct-original-')
      || manifest.sourceObjectId !== owner.source_object_id || manifest.sha256 !== owner.sha256
      || manifest.sourceObjectId !== stored.sourceObjectId || manifest.sha256 !== stored.sha256
      || manifest.normalizerVersion !== stored.normalizerVersion
      || JSON.stringify(manifest.coveredUnitIndexes) !== JSON.stringify(stored.coveredUnitIndexes)
      || manifest.totalUnits !== stored.totalUnits || JSON.stringify(primary(manifest)) !== JSON.stringify(primary(stored))
      || new Set(manifest.spans.map((span) => span.id)).size !== manifest.spans.length
      || manifest.spans.some((span) => span.documentId !== input.documentId
        || existingSpans.has(span.id) && JSON.stringify(span) !== JSON.stringify(existingSpans.get(span.id))
        || span.modelEvidence && (span.modelEvidence.originalSha256 !== owner.sha256
          || span.modelEvidence.originalSourceObjectId !== owner.source_object_id))
      || input.observations.some((observation) => observation.documentId !== input.documentId || !observation.candidate)) {
      throw new Error('DIRECT_ORIGINAL_ADMISSION_SCOPE_MISMATCH');
    }
    const mode = this.isDocumentCommitted(input.documentId) ? 'append' : 'publish';
    const plan = this.planReportSourceAdmission({ ...input, manifest, mode });
    const metadataPlan = mode === 'append'
      ? this.planCommittedReportDateEnrichment(input.personId, input.documentId, input.reportMetadata, manifest) : null;
    const publishPrimary = mode === 'publish' ? this.selectPrimaryClinicalTime(input.documentId, input.reportMetadata, manifest) : null;
    return { mode, held: plan.held, acceptedCount: plan.additions.length, duplicateCount: plan.duplicateCount,
      refinedCount: plan.refinements.size, reportReasonCodes: metadataPlan?.heldReasonCodes ?? publishPrimary?.heldReasonCodes ?? [],
      reportDiagnostics: metadataPlan?.diagnostics ?? publishPrimary?.diagnostics ?? [] };
  }

  private explicitClinicalDateEvidence(
    documentId: string, observation: PublishedObservationInput, metadata?: ReportMetadataCandidate | null, suppliedManifest?: SourceManifest
  ): PublishedObservationInput['evidence'] {
    if (!observation.clinicalDate) return [];
    const manifest = suppliedManifest ?? this.getDocumentExtractionBundle(documentId).manifest;
    if (manifest.spans.some((span) => span.id === observation.sourceSpanId && span.modelEvidence)) {
      // 原件模型给出了日期角色与规范值；保存对应真实模型日期摘录，不再用 OCR 日期启发式重判。
      const times = metadata?.times.filter((time) => time.precision === 'day'
        && time.value === observation.clinicalDate && ['sampled', 'examined', 'encounter', 'history_quoted'].includes(time.role)) ?? [];
      return times.filter((time) => trustedDirectReportTime(time, manifest, documentId)).flatMap((time) => time.evidence)
        .filter((reference) => observation.evidence.some((own) => own.sourceSpanId === reference.sourceSpanId));
    }
    const byId = new Map(manifest.spans.map((span) => [span.id, span]));
    const compact = (text: string) => text.normalize('NFKC').replace(/\s+/gu, '');
    const labelledDates = (text: string, minimumIndex = 0) => calendarDateOccurrences(text)
      .filter((date) => date.index >= minimumIndex && hasCurrentLabelledSourceDate(text, date.date, 'clinical', minimumIndex)).map((date) => date.date);
    // 旧事实只有整页日期证据时，多检查日文档仍缺“日期属于哪个子项”的证明，不能自动补。
    if (new Set(manifest.spans.flatMap((span) => {
      const context = orderedDateSourceContext(manifest, span.id);
      return context ? labelledDates(context.text, context.minimumIndex) : [];
    })).size > 1) return [];
    const labelledDate = (text: string) => labelledDates(text).includes(observation.clinicalDate!);
    const exactCurrent = (references: PublishedObservationInput['evidence']) => references.filter((reference) => {
      const span = byId.get(reference.sourceSpanId);
      const context = orderedDateSourceContext(manifest, reference.sourceSpanId);
      return span?.documentId === documentId && span.readability === 'clear' && Boolean(reference.quote && span.quote
        && context && compact(span.quote).includes(compact(reference.quote)) && labelledDate(reference.quote)
        && hasCurrentLabelledSourceDate(context.text, observation.clinicalDate!, 'clinical', context.minimumIndex));
    });
    // 历史转述同日不否定独立的本次来源；截短历史引文仍会被有序全文上下文拒绝。
    const own = exactCurrent(observation.evidence);
    if (own.length) return own;
    const clinicalTimes = metadata?.times.filter((time) => time.precision === 'day'
      && ['sampled', 'examined', 'encounter'].includes(time.role)) ?? [];
    // 多检查日文件只能从项目自身取日期，不能把另一章节的日期借给它。
    if (new Set(clinicalTimes.map((time) => time.value)).size !== 1) return [];
    const matching = clinicalTimes.filter((time) => time.value === observation.clinicalDate);
    return exactCurrent(matching.flatMap((time) => time.evidence));
  }

  /** 只用本轮最终接纳的同原件唯一字段解决旧疑点；模型漏列、同页同名同值均不是证明。 */
  private unreconciledSourceReviewCandidates(
    candidates: ObservationCandidate[], plan: ReportSourceAdmissionPlan, documentId: string,
    manifest: SourceManifest, metadata?: ReportMetadataCandidate | null
  ): ObservationCandidate[] {
    return candidates.filter((previous) => {
      if (!observationCandidateSchema.safeParse(previous).success || previous.value.kind === 'unknown'
        || !previous.value.rawText?.trim()) return true;
      const direct = [...previous.evidence, ...(previous.sourceBinding?.findingEvidence ?? [])]
        .some((reference) => manifest.spans.some((span) => span.id === reference.sourceSpanId && span.modelEvidence));
      const old = direct ? resolveDirectOriginalSourceBinding(previous, manifest) : resolveReportSourceBinding(previous, manifest);
      if (old.status !== 'resolved') return true;
      const oldFact = candidateToReconciliationFact(previous);
      const oldSemantics = reportFactSemantics(oldFact);
      const oldOutcome = direct && previous.value.kind === 'numeric' ? evaluateDirectOriginalObservationCandidate(
        previous, manifest, { personConsistent: true, overwritesUserLockedValue: false, reportMetadata: metadata ?? null }) : null;
      const oldNumericRepresentationInvalid = oldOutcome?.decision === 'reject'
        && oldOutcome.reasons.includes('direct_original_numeric_representation_conflict');
      return !plan.admittedObservations.some((observation) => {
        const binding = plan.bindings.get(observation);
        if (!binding || !this.sameBoundSourceFinding(binding, old.binding)
          || observation.rawText !== previous.value.rawText) return false;
        const nextFact = publishedReconciliationFact(observation);
        const nextSemantics = reportFactSemantics(nextFact);
        const nextOutcome = oldNumericRepresentationInvalid && observation.valueKind === 'numeric'
          ? evaluateDirectOriginalObservationCandidate(publishedObservationCandidate(observation), manifest,
            { personConsistent: true, overwritesUserLockedValue: false, reportMetadata: metadata ?? null }) : null;
        const numericRepresentationRepaired = nextOutcome?.decision === 'accept' || nextOutcome?.decision === 'accept_with_warnings';
        const dateProven = !observation.clinicalDate || this.explicitClinicalDateEvidence(
          documentId, observation, metadata, manifest).length > 0;
        if (!dateProven) return false;
        return Object.keys(oldSemantics).every((field) => {
          if (oldSemantics[field] === nextSemantics[field]) return true;
          // 旧held从未成为事实；同一逐字原值的错误JSON解析可由本轮已验证解析解决，不改保存事实。
          if ((field === 'value' || field === 'qualifier') && numericRepresentationRepaired) return true;
          // 新来源可补回缺失日期/条件；非空日期、条件、否定词、左右及完整单位绝不借此改写。
          if (field === 'clinicalDate') return oldFact.clinicalDate === null && nextFact.clinicalDate !== null;
          if (field === 'clinicalContext') return (!oldFact.clinicalContext || oldFact.clinicalContext.conditions.length === 0)
            && nextFact.clinicalContext?.status === 'complete' && nextFact.clinicalContext.conditions.length > 0
            && this.groundedClinicalContextJson(documentId, nextFact.clinicalContext, manifest) !== null;
          return false;
        });
      });
    });
  }

  /** 对已经提交的报告做可审计增量补修；差异逐项保留，不能让内容疑点变成整批数据库错误。 */
  appendCommittedFacts(input: AppendCommittedFactsInput): AppendCommittedFactsReceipt {
    const transaction = this.db.transaction((): AppendCommittedFactsReceipt => {
      if (input.executionGuard) this.assertJobExecutionActive(input.executionGuard, input.documentId);
      const supplement = input.executionGuard ? this.getJobReportSupplementScope(input.executionGuard, input.documentId) : null;
      if (supplement) {
        const ledger = input.readingAccounting?.coverage;
        const manifest = this.reconciliationSourceManifest(input.documentId);
        const allowed = new Set(supplement.pageSourceSpanIds);
        const holdWithoutAdmission = input.observations.length === 0 && !input.readingAccounting
          && !input.sourceRefinementReview && input.reportMetadata == null;
        if (!holdWithoutAdmission && (input.reportMetadata != null || ledger?.scope !== 'selected_pages' || ledger.baseAuditId !== supplement.baseAuditId
          || ledger.originalSha256 !== supplement.originalSha256
          || stableHash(ledger.pages.map(page => page.sourceSpanId).sort()) !== stableHash([...allowed].sort())
          || input.observations.some(observation => {
            const source = manifest.spans.find(span => span.id === observation.sourceSpanId);
            return !source?.modelEvidence || !allowed.has(source.modelEvidence.parentSourceSpanId);
          }))) throw new Error('REPORT_SUPPLEMENT_ADMISSION_SCOPE_INVALID');
      }
      const dateCorrection = input.executionGuard && this.isDateCorrectionJob(input.executionGuard.jobId)
        ? this.assertDateCorrectionScope(input.executionGuard, input.documentId) : null;
      if (dateCorrection) {
        const projected = this.dateCorrectionProjection(input.executionGuard!, input.documentId);
        // 精确比对冻结版本，连格式等价的 rawText、异常标记和解释条件也不授权改写。
        if (stableHash(projected.observations) !== stableHash(input.observations)
          || stableHash(projected.metadata) !== stableHash(input.reportMetadata)) {
          throw new Error('DATE_CORRECTION_REVIEWED_CONTENT_CHANGED');
        }
      }
      const document = this.db.prepare(`
        SELECT d.person_id, d.status, d.excluded_from_analysis,
               dc.publication_id AS initial_publication_id
        FROM documents d
        LEFT JOIN document_commits dc ON dc.document_id = d.id
        WHERE d.id = ?
      `).get(input.documentId) as {
        person_id: string | null; status: string; excluded_from_analysis: number;
        initial_publication_id: string | null;
      } | undefined;
      if (!document || document.person_id !== input.personId) throw new Error('DOCUMENT_PERSON_SCOPE_MISMATCH');
      if (!document.initial_publication_id || document.status !== 'completed' || document.excluded_from_analysis !== 0) {
        throw new Error('DOCUMENT_NOT_COMMITTED_FOR_APPEND');
      }
      const report = this.db.prepare(`
        SELECT rr.id FROM report_source_links rsl
        JOIN report_records rr ON rr.id = rsl.report_id
        WHERE rsl.document_id = ? AND rr.person_id = ? LIMIT 1
      `).get(input.documentId, input.personId);
      if (!report) throw new Error('DOCUMENT_REPORT_LINK_MISSING');
      let reviewIssueId = input.reviewUpdate.issueId;
      const issue = reviewIssueId === null ? undefined : this.db.prepare(`
        SELECT job_id, kind, severity, resolution_status, payload_json, evidence_refs_json
        FROM review_issues WHERE id = ? AND field_ref = 'document:' || ?
      `).get(reviewIssueId, input.documentId) as {
        job_id: string | null; kind: string; severity: string; resolution_status: string;
        payload_json: string | null; evidence_refs_json: string;
      } | undefined;
      if (reviewIssueId === null) {
        // 这是任务授权，不制造一个医学警告来取得写入权限；真正的缺口在下方同事务保存。
        const guard = input.executionGuard;
        if (!guard || !this.getJobRepairDocumentIds(guard.jobId).has(input.documentId)
          || supplement || dateCorrection) throw new Error('COMMITTED_MAINTENANCE_SCOPE_REQUIRED');
        const authorization = this.db.prepare(`SELECT j.stage, j.checkpoint_json, c.scope_json FROM jobs j
          JOIN consents c ON c.id=? AND c.revoked_at IS NULL AND c.recipient='OpenAI/Codex'
            AND c.purpose='manual_health_report_processing' WHERE j.id=?`).get(guard.consentId, guard.jobId) as {
          stage: string; checkpoint_json: string; scope_json: string;
        } | undefined;
        const scope = authorization ? JSON.parse(authorization.scope_json) as {
          type?: string; assessmentOnly?: boolean; documentIds?: string[]; personIds?: string[]; stages?: string[];
        } : null;
        const jobScope = authorization ? JSON.parse(authorization.checkpoint_json) as { documentIds?: string[] } : null;
        if (!authorization || !['extract', 'review_facts'].includes(authorization.stage) || scope?.type !== 'manual_batch'
          || scope.assessmentOnly || !scope.stages?.includes('extract') || !scope.personIds?.includes(input.personId)
          || !jobScope?.documentIds?.every(id => scope.documentIds?.includes(id))) {
          throw new Error('COMMITTED_MAINTENANCE_SCOPE_REQUIRED');
        }
        if (this.listOpenExtractionReviewIssues().some(existing => existing.documentId === input.documentId)) {
          throw new Error('COMMITTED_REVIEW_RECONCILIATION_REQUIRED');
        }
      } else if (!issue || issue.severity !== 'warning'
        || (issue.kind !== 'field_conflict' && issue.kind !== 'coverage_gap')) {
        throw new Error('COMMITTED_REVIEW_ISSUE_INVALID');
      }
      const payload = issue?.payload_json ? JSON.parse(issue.payload_json) as Record<string, unknown> : {};
      if (issue && payload.stage !== 'extract') throw new Error('COMMITTED_REVIEW_ISSUE_INVALID');
      if (dateCorrection && (issue?.job_id !== input.executionGuard!.jobId || payload.purpose !== 'date_correction')) {
        throw new Error('DATE_CORRECTION_REVIEW_SCOPE_INVALID');
      }
      const originalCandidates = Array.isArray(payload.candidateOptions)
        ? payload.candidateOptions as ObservationCandidate[] : [];
      const sourceSpans = new Map((this.db.prepare(`
        SELECT id, quote FROM source_spans WHERE document_id = ?
      `).all(input.documentId) as Array<{ id: string; quote: string | null }>)
        .map((span) => [span.id, span]));
      for (const candidate of input.reviewUpdate.remainingCandidates) {
        // 历史警告里可能有相同 localKey 的不同项目，不能按 key 强制合并。
        // 待核对项可以记录“模型引用了无效片段”本身；只有正式接纳事实才要求
        // 所有证据片段真实属于本文件。否则重核时反而无法保存这个缺口。
        if (!observationCandidateSchema.safeParse(candidate).success) {
          throw new Error('COMMITTED_REVIEW_REMAINDER_INVALID');
        }
      }
      let remainingCandidates = [...input.reviewUpdate.remainingCandidates];
      let remainingReasonCodes = [...input.reviewUpdate.remainingReasonCodes];
      let remainingEvidenceRefs = [...input.reviewUpdate.remainingEvidenceRefs];
      if (supplement) {
        const manifest = this.reconciliationSourceManifest(input.documentId);
        const outside = (payload.evidenceRefs as string[] | undefined ?? []).filter(id => {
          const span = manifest.spans.find(source => source.id === id);
          return !span || !supplement.pageSourceSpanIds.includes(span.modelEvidence?.parentSourceSpanId ?? span.id);
        });
        if (outside.length) {
          remainingEvidenceRefs.push(...outside);
          remainingReasonCodes.push('prior_outside_page_scope_unverified');
        }
      }
      const accepted = this.db.prepare(`
        SELECT decision FROM acceptance_decisions WHERE id = ?
      `);
      for (const observation of input.observations) {
        if (observation.documentId !== input.documentId || observation.valueKind === 'unknown'
          || !observation.rawText.trim() || !sourceSpans.has(observation.sourceSpanId)
          || observation.evidence.length === 0
          || !observation.evidence.some((reference) => reference.sourceSpanId === observation.sourceSpanId)
          || observation.evidence.some((reference) => !sourceSpans.has(reference.sourceSpanId))) {
          throw new Error('COMMITTED_FACT_EVIDENCE_INVALID');
        }
        if (observation.valueKind === 'numeric'
          && (observation.decimalValue === null || !Number.isFinite(Number(observation.decimalValue)))) {
          throw new Error('COMMITTED_FACT_VALUE_INVALID');
        }
        const decision = accepted.get(observation.acceptanceId) as { decision: string } | undefined;
        if (!decision || (decision.decision !== 'accept' && decision.decision !== 'accept_with_warnings')) {
          throw new Error('COMMITTED_FACT_NOT_ACCEPTED');
        }
      }

      const manifest = this.reconciliationSourceManifest(input.documentId);
      const plan = this.planReportSourceAdmission({ mode: 'append', personId: input.personId,
        documentId: input.documentId, manifest,
        observations: input.observations, reportMetadata: input.reportMetadata ?? null,
        fieldReviews: input.reviewUpdate.fieldReviews ?? [],
        ...(input.sourceRefinementReview ? { sourceRefinementReview: input.sourceRefinementReview } : {}),
        ...(input.executionGuard ? { executionGuard: input.executionGuard } : {}) });
      const { existingRows, additions, bindings: additionBindings, refinements, heldCandidates, heldReasonCodes, duplicateCount } = plan;
      const accounting = input.readingAccounting ? accountReportReading(input.readingAccounting,
        plan.admittedObservations.map((item) => item.candidate?.localKey ?? ''), heldCandidates) : null;
      if (accounting) {
        remainingCandidates = uniqueCandidates([...remainingCandidates, ...accounting.pendingCandidates]);
        remainingReasonCodes.push(...accounting.audit.pending.flatMap((item) => item.reasonCodes));
      }
      this.recordDirectOriginalProtocolNormalizations(input.documentId, plan.admittedObservations, input.executionGuard);
      if (input.reviewUpdate.reconciliationMode === 'source_proven') {
        const unreconciled = this.unreconciledSourceReviewCandidates(originalCandidates, plan, input.documentId,
          manifest, input.reportMetadata);
        remainingCandidates = uniqueCandidates([...remainingCandidates, ...unreconciled]);
        if (unreconciled.length) remainingReasonCodes.push('prior_unresolved_source_not_reconciled');
        // 只补回仍然保留的逐项依据，不把旧元数据/整页原因黏回本轮已复证成功的范围。
        remainingEvidenceRefs.push(...unreconciled.flatMap((candidate) => [...candidate.evidence,
          ...(candidate.sourceBinding?.headingEvidence ?? []), ...(candidate.sourceBinding?.findingEvidence ?? []),
          ...observationStructuredSlotEvidence(candidate),
          ...(candidate.clinicalContext?.conditions ?? [])].map((reference) => reference.sourceSpanId)));
      }
      remainingCandidates = uniqueCandidates([...remainingCandidates, ...heldCandidates]);
      if (accounting) {
        const currentVersions = new Set([...accounting.pendingCandidates, ...heldCandidates].map((candidate) => JSON.stringify(candidate)));
        accounting.audit.historicalReadingCount = remainingCandidates.filter((candidate) => !currentVersions.has(JSON.stringify(candidate))).length;
      }
      const previousFieldReviews = Array.isArray(payload.fieldReviews) ? payload.fieldReviews as DirectOriginalFieldAdmissionReview[] : [];
      const activePreviousFieldReviews = previousFieldReviews.filter((review) => {
        if (review.kind !== 'candidate' || review.fields.some((field) => field.fieldPath !== 'clinicalDate')
          || !observationCandidateSchema.safeParse(review.original).success) return true;
        const oldBinding = resolveDirectOriginalSourceBinding(review.original, manifest);
        if (oldBinding.status !== 'resolved') return true;
        const oldSemantics = reportFactSemantics(candidateToReconciliationFact(review.original));
        return !plan.admittedObservations.some((observation) => {
          const binding = plan.bindings.get(observation);
          if (!observation.clinicalDate || !binding || !this.sameBoundSourceFinding(binding, oldBinding.binding)
            || this.explicitClinicalDateEvidence(input.documentId, observation, input.reportMetadata, manifest).length === 0) return false;
          const nextSemantics = reportFactSemantics(publishedReconciliationFact(observation));
          return Object.keys(oldSemantics).every((field) => field === 'clinicalDate' || oldSemantics[field] === nextSemantics[field]);
        });
      });
      const fieldReviews = [...new Map([
        ...activePreviousFieldReviews,
        ...(input.reviewUpdate.fieldReviews ?? [])
      ].map((review) => [stableHash(review), review])).values()];
      // 日期未核实不等于结果缺失。原始字段审计保留，不靠下一次回包漏列而清空。
      remainingReasonCodes.push(...fieldReviews.flatMap((review) => review.fields.map((field) => field.reasonCodes[0]!)));
      remainingEvidenceRefs.push(...fieldReviews.flatMap((review) => review.fields.flatMap((field) =>
        field.evidence.map((ref) => ref.sourceSpanId))));
      remainingReasonCodes = [...new Set([...remainingReasonCodes, ...heldReasonCodes])];
      remainingEvidenceRefs = [...new Set([...remainingEvidenceRefs, ...heldCandidates.flatMap((candidate) =>
        candidate.evidence.map((reference) => reference.sourceSpanId))])];
      let reviewResolved = remainingCandidates.length === 0 && remainingReasonCodes.length === 0 && remainingEvidenceRefs.length === 0;

      const currentRevision = this.getFactRevision(input.personId);
      const existingRemainderHash = createHash('sha256').update(JSON.stringify({
        candidates: originalCandidates, reasons: payload.reasonCodes ?? [],
        evidence: JSON.parse(issue?.evidence_refs_json ?? '[]') as string[], fieldReviews: payload.fieldReviews ?? []
      })).digest('hex');
      const nextRemainderHash = createHash('sha256').update(JSON.stringify({
        candidates: remainingCandidates, reasons: remainingReasonCodes,
        evidence: remainingEvidenceRefs, fieldReviews
      })).digest('hex');
      let reviewChanged = issue ? issue.resolution_status === 'open'
        && (reviewResolved || existingRemainderHash !== nextRemainderHash || Boolean(accounting)) : !reviewResolved;
      if (issue && issue.resolution_status !== 'open') {
        if (additions.length > 0 || refinements.size > 0 || !reviewResolved) throw new Error('COMMITTED_REVIEW_ISSUE_NOT_OPEN');
        return {
          publicationId: null, revision: currentRevision, appendedCount: 0,
          duplicateCount, updatedCount: 0, heldCount: heldCandidates.length,
          heldCandidates: uniqueCandidates(heldCandidates), heldReasonCodes: [...new Set(heldReasonCodes)],
          idempotent: true, reviewResolved: true, reviewIssueId
        };
      }
      if (currentRevision !== input.expectedRevision) {
        throw new RevisionConflictError(input.expectedRevision, currentRevision);
      }
      let metadata = input.reportMetadata;
      if (dateCorrection && metadata) {
        // 只更新日期关系；新模型的标题/机构等重写不借日期用途覆盖旧报告。
        const previous = this.db.prepare(`SELECT mr.payload_json FROM report_metadata_revisions mr
          JOIN report_records r ON r.id=mr.report_id AND r.metadata_revision=mr.revision
          JOIN report_source_links l ON l.report_id=r.id WHERE l.document_id=? AND r.person_id=?`)
          .all(input.documentId, input.personId) as Array<{ payload_json: string }>;
        if (previous.length !== 1) throw new Error('DATE_CORRECTION_REPORT_SCOPE_AMBIGUOUS');
        const old = (JSON.parse(previous[0]!.payload_json) as { extracted?: ReportMetadataCandidate }).extracted;
        if (!old) throw new Error('DATE_CORRECTION_REPORT_METADATA_REQUIRED');
        const { primaryClinicalTimeIndex: _previousPrimary, ...unchangedFields } = old;
        metadata = { ...unchangedFields, times: metadata.times,
          ...(metadata.primaryClinicalTimeIndex === undefined ? {} : { primaryClinicalTimeIndex: metadata.primaryClinicalTimeIndex }) };
      }
      const metadataEnrichment = this.enrichCommittedReportDates(input.personId, input.documentId, metadata);
      if (dateCorrection && metadataEnrichment.heldReasonCodes.length) throw new Error('DATE_CORRECTION_REPORT_DATE_UNPROVEN');
      const enrichedReportIds = metadataEnrichment.reportIds;
      if (metadataEnrichment.heldReasonCodes.length > 0) {
        remainingReasonCodes = [...new Set([...remainingReasonCodes, ...metadataEnrichment.heldReasonCodes])];
        remainingEvidenceRefs = [...new Set([...remainingEvidenceRefs, ...metadataEnrichment.heldEvidenceRefs])];
        heldReasonCodes.push(...metadataEnrichment.heldReasonCodes);
        reviewResolved = false;
        const finalHash = createHash('sha256').update(JSON.stringify({ candidates: remainingCandidates,
          reasons: remainingReasonCodes, evidence: remainingEvidenceRefs, fieldReviews })).digest('hex');
        reviewChanged = issue ? issue.resolution_status === 'open' && (finalHash !== existingRemainderHash || Boolean(accounting)) : true;
      }
      if (additions.length === 0 && refinements.size === 0 && !reviewChanged && enrichedReportIds.length === 0 && !accounting) {
        return {
          publicationId: null, revision: currentRevision, appendedCount: 0,
          duplicateCount, updatedCount: 0, heldCount: heldCandidates.length,
          heldCandidates: uniqueCandidates(heldCandidates), heldReasonCodes: [...new Set(heldReasonCodes)],
          idempotent: true, reviewResolved, reviewIssueId
        };
      }

      const affectedSystemIds = new Set<string>();
      for (const systemId of this.systemIdsForReports(enrichedReportIds)) affectedSystemIds.add(systemId);
      const existingEncounter = this.db.prepare(`
        SELECT e.id FROM encounters e
        JOIN encounter_documents ed ON ed.encounter_id = e.id
        WHERE ed.document_id = ? AND e.person_id = ? AND e.clinical_date IS ?
        ORDER BY e.id LIMIT 1
      `);
      const encounters = new Map<string, string>();
      for (const observation of additions) {
        const dateKey = observation.clinicalDate ?? '';
        let encounterId = encounters.get(dateKey);
        if (!encounterId) {
          encounterId = (existingEncounter.get(input.documentId, input.personId, observation.clinicalDate) as { id: string } | undefined)?.id;
          if (!encounterId) {
            encounterId = randomUUID();
            this.db.prepare(`
              INSERT INTO encounters (id, person_id, clinical_date, date_precision, type, source_text, version)
              VALUES (?, ?, ?, ?, 'health_report', NULL, 1)
            `).run(encounterId, input.personId, observation.clinicalDate, observation.clinicalDate ? 'day' : 'unknown');
            this.db.prepare(`INSERT INTO encounter_documents (encounter_id, document_id) VALUES (?, ?)`)
              .run(encounterId, input.documentId);
          }
          encounters.set(dateKey, encounterId);
        }
        const observationId = randomUUID();
        const now = this.now().toISOString();
        this.db.prepare(`
          INSERT INTO observations (
            id, person_id, encounter_id, concept_key, original_name,
            model_standard_name_candidate, current_revision, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, 1, ?)
        `).run(observationId, input.personId, encounterId, observation.conceptKey,
          observation.originalName ?? observation.conceptKey,
          observation.modelStandardNameCandidate ?? null, now);
        this.db.prepare(`
          INSERT INTO observation_revisions (
            observation_id, revision, value_kind, raw_text, decimal_value,
            qualifier, unit, reference_range, abnormal_flag, source_span_id,
            acceptance_id, specimen, method, body_site, evidence_json, clinical_context_json,
            source_binding_json, clinical_date, date_evidence_json, created_at
          ) VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(observationId, observation.valueKind, observation.rawText, observation.decimalValue,
          observation.qualifier, observation.unit, observation.referenceRange, observation.abnormalFlag,
          observation.sourceSpanId, observation.acceptanceId, observation.specimen,
          observation.method, observation.bodySite, JSON.stringify(observation.evidence),
          this.groundedClinicalContextJson(input.documentId, observation.clinicalContext),
          JSON.stringify(additionBindings.get(observation) ?? null), observation.clinicalDate,
          JSON.stringify(this.explicitClinicalDateEvidence(input.documentId, observation, input.reportMetadata)), now);
        const mapping = mapConcept({
          rawName: observation.originalName ?? observation.conceptKey,
          standardName: observation.modelStandardNameCandidate ?? null,
          specimen: observation.specimen, method: observation.method,
          bodySite: observation.bodySite, unit: observation.unit
        });
        this.db.prepare(`
          INSERT INTO observation_concept_mappings (
            observation_id, observation_revision, concept_id, normalized_name,
            status, confidence, reasons_json, mapper_version, created_at
          ) VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?)
        `).run(observationId, mapping.conceptId, mapping.normalizedName,
          mapping.status, mapping.confidence, JSON.stringify(mapping.reasons),
          CONCEPT_DICTIONARY_VERSION, now);
        for (const link of linkConceptToSystems(mapping)) {
          affectedSystemIds.add(link.systemId);
          this.db.prepare(`
            INSERT INTO system_fact_links (
              observation_id, observation_revision, system_id, relation, linker_version, created_at
            ) VALUES (?, 1, ?, ?, ?, ?)
          `).run(observationId, link.systemId, link.relation,
            BODY_SYSTEM_REGISTRY_VERSION, now);
        }
      }

      for (const [observationId, refinement] of refinements) {
        const previous = existingRows.find((row) => row.id === observationId)!;
        const timestamp = this.now().toISOString();
        const nextObservationRevision = previous.current_revision + 1;
        let updated: Database.RunResult;
        if (refinement.field === 'sourceBinding') {
          // 只版本化来源：原名在 observations 中不动，全部医疗值、日期、条件和 encounter 保留旧值。
          this.db.prepare(`INSERT INTO observation_revisions (observation_id,revision,value_kind,raw_text,decimal_value,
            qualifier,unit,reference_range,abnormal_flag,source_span_id,acceptance_id,specimen,method,body_site,
            evidence_json,clinical_context_json,source_binding_json,clinical_date,date_evidence_json,supersedes,created_at)
            SELECT observation_id,?,value_kind,raw_text,decimal_value,qualifier,unit,reference_range,abnormal_flag,
              ?,?,specimen,method,body_site,?,clinical_context_json,?,clinical_date,date_evidence_json,?,?
            FROM observation_revisions WHERE observation_id=? AND revision=?`)
            .run(nextObservationRevision, refinement.observation.sourceSpanId, refinement.observation.acceptanceId,
              JSON.stringify(refinement.observation.evidence), JSON.stringify(refinement.binding),
              previous.current_revision, timestamp, observationId, previous.current_revision);
          updated = this.db.prepare(`UPDATE observations SET current_revision=?
            WHERE id=? AND person_id=? AND current_revision=?`)
            .run(nextObservationRevision, observationId, input.personId, previous.current_revision);
        } else if (refinement.field === 'clinicalContext') {
          // 仅补旧缺失条件：原值、旧日期、日期依据及encounter全部从旧修订保留。
          this.db.prepare(`INSERT INTO observation_revisions (observation_id,revision,value_kind,raw_text,decimal_value,
            qualifier,unit,reference_range,abnormal_flag,source_span_id,acceptance_id,specimen,method,body_site,
            evidence_json,clinical_context_json,source_binding_json,clinical_date,date_evidence_json,supersedes,created_at)
            SELECT observation_id,?,value_kind,raw_text,decimal_value,qualifier,unit,reference_range,abnormal_flag,
              ?,?,specimen,method,body_site,?,?,?,clinical_date,date_evidence_json,?,?
            FROM observation_revisions WHERE observation_id=? AND revision=?`)
            .run(nextObservationRevision, refinement.observation.sourceSpanId, refinement.observation.acceptanceId,
              JSON.stringify(refinement.observation.evidence), refinement.contextJson!, JSON.stringify(refinement.binding),
              previous.current_revision, timestamp, observationId, previous.current_revision);
          updated = this.db.prepare(`UPDATE observations SET current_revision=?
            WHERE id=? AND person_id=? AND current_revision=?`)
            .run(nextObservationRevision, observationId, input.personId, previous.current_revision);
        } else {
          const date = refinement.observation.clinicalDate!;
          let encounterId = (existingEncounter.get(input.documentId, input.personId, date) as { id: string } | undefined)?.id;
          if (!encounterId) {
            encounterId = randomUUID();
            this.db.prepare(`INSERT INTO encounters (id,person_id,clinical_date,date_precision,type,source_text,version)
              VALUES (?,?,?,'day','health_report',NULL,1)`).run(encounterId, input.personId, date);
            this.db.prepare(`INSERT INTO encounter_documents (encounter_id,document_id) VALUES (?,?)`).run(encounterId, input.documentId);
          }
          // 原值、比较符、单位和原修订逐字保留；只建立带日期依据的新修订。
          this.db.prepare(`INSERT INTO observation_revisions (observation_id,revision,value_kind,raw_text,decimal_value,
            qualifier,unit,reference_range,abnormal_flag,source_span_id,acceptance_id,specimen,method,body_site,
            evidence_json,clinical_context_json,source_binding_json,clinical_date,date_evidence_json,supersedes,created_at)
            SELECT observation_id,?,value_kind,raw_text,decimal_value,qualifier,unit,reference_range,abnormal_flag,
              ?,?,specimen,method,body_site,?,clinical_context_json,CASE WHEN ? THEN source_binding_json ELSE ? END,?,?,?,?
            FROM observation_revisions WHERE observation_id=? AND revision=?`)
            .run(nextObservationRevision, refinement.observation.sourceSpanId, refinement.observation.acceptanceId,
              JSON.stringify(refinement.observation.evidence), dateCorrection ? 1 : 0, JSON.stringify(refinement.binding), date,
              JSON.stringify(refinement.dateEvidence), previous.current_revision, timestamp, observationId, previous.current_revision);
          updated = this.db.prepare(`UPDATE observations SET current_revision=?,encounter_id=?
            WHERE id=? AND person_id=? AND current_revision=?`).run(nextObservationRevision, encounterId,
              observationId, input.personId, previous.current_revision);
        }
        if (updated.changes !== 1) throw new Error('OBSERVATION_REFINEMENT_STATE_CHANGED');
        this.db.prepare(`INSERT INTO observation_concept_mappings (observation_id,observation_revision,concept_id,
          normalized_name,status,confidence,reasons_json,mapper_version,created_at)
          SELECT observation_id,?,concept_id,normalized_name,status,confidence,reasons_json,mapper_version,?
          FROM observation_concept_mappings WHERE observation_id=? AND observation_revision=?`)
          .run(nextObservationRevision, timestamp, observationId, previous.current_revision);
        this.db.prepare(`INSERT INTO system_fact_links (observation_id,observation_revision,system_id,relation,linker_version,created_at)
          SELECT observation_id,?,system_id,relation,linker_version,? FROM system_fact_links
          WHERE observation_id=? AND observation_revision=?`).run(nextObservationRevision, timestamp, observationId, previous.current_revision);
        const systems = this.db.prepare(`SELECT system_id FROM system_fact_links WHERE observation_id=? AND observation_revision=?`)
          .all(observationId, nextObservationRevision) as Array<{ system_id: string }>;
        for (const system of systems) affectedSystemIds.add(system.system_id);
        this.db.prepare(`INSERT INTO audit_events (id,event_type,entity_id,summary,created_at)
          VALUES (?,?,?,?,?)`)
          .run(randomUUID(), refinement.field === 'sourceBinding' ? 'observation.source_binding_enriched'
            : refinement.field === 'clinicalContext' ? 'observation.clinical_context_enriched'
            : dateCorrection ? 'observation.clinical_date_corrected' : 'observation.clinical_date_enriched',
            observationId, refinement.field === 'sourceBinding'
              ? '同一可信原件字段已补齐旧缺失的真实栏目来源，已保存新修订；原值、日期、条件和旧引用仍保留。'
              : refinement.field === 'clinicalContext'
              ? '同一来源事实已有明确解释条件，已保存新修订；旧值、原日期和旧依据仍保留。'
              : dateCorrection ? '已按单份原件及独立核验正式修正检查日期；原修订逐字保留，其他结果及个人计划不变。'
              : '同一来源事实已有明确检查日期，已保存新修订；旧值和旧依据仍保留。', timestamp);
      }

      let publicationId: string | null = null;
      let revision = currentRevision;
      if (additions.length > 0 || refinements.size > 0 || enrichedReportIds.length > 0) {
        publicationId = randomUUID();
        revision += 1;
        const changeSetHash = createHash('sha256').update(JSON.stringify([
          'committed-fact-append-v1', input.documentId,
          additions.map((observation) => [committedFactIdentity(observation), committedFactValue(observation)]).sort(),
          [...refinements].map(([id, refinement]) => [id, refinement.field,
            refinement.field === 'sourceBinding' ? { binding: refinement.binding, evidence: refinement.observation.evidence }
              : refinement.field === 'clinicalContext' ? refinement.observation.clinicalContext : refinement.observation.clinicalDate]),
          enrichedReportIds.length > 0 ? { times: input.reportMetadata?.times,
            primaryClinicalTimeIndex: input.reportMetadata?.primaryClinicalTimeIndex } : null
        ])).digest('hex');
        this.db.prepare(`
          INSERT INTO person_revisions (person_id, fact_revision) VALUES (?, ?)
          ON CONFLICT(person_id) DO UPDATE SET fact_revision = excluded.fact_revision
        `).run(input.personId, revision);
        this.db.prepare(`UPDATE derived_snapshots SET status = 'stale' WHERE person_id = ? AND status = 'current'`)
          .run(input.personId);
        const staleSystem = this.db.prepare(`
          UPDATE system_analysis_snapshots_v2 SET status = 'stale'
          WHERE person_id = ? AND system_id = ? AND status = 'current'
        `);
        for (const systemId of affectedSystemIds) staleSystem.run(input.personId, systemId);
        this.db.prepare(`
          INSERT INTO publication_events (
            id, person_id, expected_revision, new_revision, change_set_hash, summary, committed_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(publicationId, input.personId, currentRevision, revision,
          changeSetHash, input.summary, this.now().toISOString());
      }
      if (reviewChanged) {
        const nextPayload = {
          ...payload,
          stage: 'extract',
          candidateOptions: remainingCandidates,
          ...(accounting ? { readingAudit: accounting.audit } : {}),
          fieldReviews,
          ...(previousFieldReviews.length ? { previousFieldReviews: [...new Map([
            ...(Array.isArray(payload.previousFieldReviews) ? payload.previousFieldReviews : []), ...previousFieldReviews
          ].map((review) => [stableHash(review), review])).values()] } : {}),
          reasonCodes: remainingReasonCodes,
          ...(input.reviewUpdate.reconciliationMode === 'source_proven' ? {
            // 旧扁平原因无法逐候选可靠归属，留在本机诊断史，不冒充当前仍成立的具体错误。
            previousReasons: [...new Set([...(Array.isArray(payload.previousReasons) ? payload.previousReasons : []),
              ...(Array.isArray(payload.reasonCodes) ? payload.reasonCodes : [])])]
          } : {})
        };
        if (issue) this.db.prepare(`
          UPDATE review_issues
          SET resolution_status = ?, resolution_revision = COALESCE(resolution_revision, 0) + 1,
              evidence_refs_json = ?, payload_json = ?
          WHERE id = ? AND resolution_status = 'open'
        `).run(reviewResolved ? 'resolved' : 'open',
          JSON.stringify(remainingEvidenceRefs),
          JSON.stringify(nextPayload), reviewIssueId);
        else {
          reviewIssueId = this.saveExtractionReviewIssue({ documentId: input.documentId,
            jobId: input.executionGuard!.jobId, attemptId: input.executionGuard!.attemptId,
            stage: 'extract', severity: 'warning', kind: remainingCandidates.length ? 'field_conflict' : 'coverage_gap',
            preserveDocumentStatus: true, evidenceRefs: remainingEvidenceRefs, candidateOptions: remainingCandidates,
            reasonCodes: remainingReasonCodes, fieldReviews, ...(accounting ? { readingAudit: accounting.audit } : {}) });
        }
      }
      this.invalidateMemberAssessmentSnapshots(input.personId);
      if (accounting) this.recordReportReadingAudit(input.documentId, accounting.audit, input.executionGuard);
      if (dateCorrection) {
        const row = this.db.prepare('SELECT checkpoint_json FROM jobs WHERE id=?').get(input.executionGuard!.jobId) as { checkpoint_json: string };
        const checkpoint = JSON.parse(row.checkpoint_json) as Record<string, unknown>;
        this.db.prepare('UPDATE jobs SET checkpoint_json=? WHERE id=? AND checkpoint_json=?').run(
          JSON.stringify({ ...checkpoint, dateCorrectionAppliedRevision: this.getDateCorrectionScope(input.documentId).revision }),
          input.executionGuard!.jobId, row.checkpoint_json);
      }
      this.db.prepare(`
        INSERT INTO audit_events (id, event_type, entity_id, summary, created_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(randomUUID(), reviewIssueId ? reviewResolved ? 'review_issue.committed_reconciled' : 'review_issue.committed_narrowed'
        : 'report_maintenance.completed', reviewIssueId ?? input.documentId,
        `已提交报告增量接纳 ${additions.length} 条、补充来源、解释条件或日期 ${refinements.size} 条、跳过重复 ${duplicateCount} 条；${reviewResolved ? '待核对范围已清空' : '保留仍无法核实的项目'}`,
        this.now().toISOString());
      return {
        publicationId, revision, appendedCount: additions.length,
        duplicateCount, updatedCount: refinements.size, heldCount: uniqueCandidates(heldCandidates).length,
        heldCandidates: uniqueCandidates(heldCandidates), heldReasonCodes: [...new Set(heldReasonCodes)],
        idempotent: false, reviewResolved, reviewIssueId
      };
    });
    return transaction();
  }

  integrityCheck(): string {
    const rows = this.db.pragma('integrity_check') as Array<{ integrity_check: string }>;
    return rows.map((row) => row.integrity_check).join(',');
  }

  /** 与正式发布同一事务保存逐次对账；版本历史不覆盖，也不反向授予结果接纳。 */
  private recordReportReadingAudit(documentId: string, audit: ReportReadingAudit, guard?: JobExecutionGuard): void {
    const checked = reportReadingAuditSchema.parse(audit);
    this.db.prepare('INSERT INTO audit_events (id,event_type,entity_id,summary,created_at) VALUES (?,?,?,?,?)')
      .run(randomUUID(), 'report_reading.accounted', documentId,
        JSON.stringify({ jobId: guard?.jobId ?? null, attemptId: guard?.attemptId ?? null, ...checked }), this.now().toISOString());
  }

  /** 逐项审计与候选缓存分离；旧版本只有聚合数时原样返回，不伪造逐项盘点。 */
  /** 从真实待核对引用导出问题页；客户端不能传任意页、医疗值或覆盖许可。 */
  getReportSupplementScope(documentId: string): ReportSupplementScope {
    const bundle = this.getDocumentExtractionBundle(documentId);
    const latest = this.getLatestReportReadingAudit(documentId);
    const issues = this.listOpenExtractionReviewIssues().filter(issue => issue.documentId === documentId
      && issue.stage === 'extract' && issue.severity === 'warning');
    if (!this.isDocumentCommitted(documentId) || this.isDocumentExcluded(documentId) || !latest || !issues.length
      || !['user_selected', 'identity_confirmed'].includes(bundle.personAssignmentBasis)) {
      throw new Error('REPORT_SUPPLEMENT_SCOPE_UNAVAILABLE');
    }
    const primary = bundle.manifest.spans.filter(span => !span.modelEvidence && !span.visualEvidence);
    const refs = new Set(issues.flatMap(issue => [...issue.evidenceRefs, ...issue.candidateOptions.flatMap(candidate => [
      ...candidate.evidence, ...(candidate.sourceBinding?.findingEvidence ?? []), ...observationStructuredSlotEvidence(candidate)
    ].map(ref => ref.sourceSpanId))]));
    for (const pageId of latest.audit.ledger?.gapPageSourceSpanIds ?? []) refs.add(pageId);
    for (const source of latest.audit.ledger?.unrepresentedSources ?? []) refs.add(source.sourceSpanId);
    const pages = new Set<string>();
    for (const id of refs) {
      const span = bundle.manifest.spans.find(item => item.id === id);
      if (!span) continue;
      if (primary.some(item => item.id === id)) pages.add(id);
      else if (span.modelEvidence?.originalSha256 === bundle.manifest.sha256
        && span.modelEvidence.originalSourceObjectId === bundle.manifest.sourceObjectId
        && primary.some(item => item.id === span.modelEvidence!.parentSourceSpanId)) pages.add(span.modelEvidence.parentSourceSpanId);
    }
    if (!pages.size) throw new Error('REPORT_SUPPLEMENT_SCOPE_UNAVAILABLE');
    const facts = this.db.prepare(`SELECT o.id,o.current_revision FROM observations o
      JOIN observation_revisions r ON r.observation_id=o.id AND r.revision=o.current_revision
      JOIN source_spans s ON s.id=r.source_span_id WHERE s.document_id=? ORDER BY o.id`).all(documentId);
    return reportSupplementScopeSchema.parse({ version: 1, documentId, personId: bundle.personId,
      originalSha256: bundle.manifest.sha256, baseAuditId: latest.id,
      pageSourceSpanIds: primary.filter(page => pages.has(page.id)).map(page => page.id),
      preservationSignature: stableHash({ facts, issues, auditId: latest.id, personId: bundle.personId,
        sha256: bundle.manifest.sha256 }) });
  }

  getJobReportSupplementScope(guard: JobExecutionGuard, documentId: string): ReportSupplementScope | null {
    this.assertJobExecutionActive(guard, documentId);
    const row = this.db.prepare(`SELECT j.checkpoint_json,c.scope_json FROM jobs j JOIN consents c
      ON c.id=? WHERE j.id=?`).get(guard.consentId, guard.jobId) as { checkpoint_json: string; scope_json: string };
    const checkpoint = JSON.parse(row.checkpoint_json) as { supplementScopes?: ReportSupplementScope[] };
    const consent = JSON.parse(row.scope_json) as { supplementScopes?: ReportSupplementScope[] };
    const saved = checkpoint.supplementScopes?.find(scope => scope.documentId === documentId);
    const authorized = consent.supplementScopes?.find(scope => scope.documentId === documentId);
    if (!saved && !authorized) return null;
    if (!saved || !authorized || stableHash(saved) !== stableHash(authorized)
      || stableHash(saved) !== stableHash(this.getReportSupplementScope(documentId))) {
      throw new Error('REPORT_SUPPLEMENT_SCOPE_CHANGED');
    }
    return reportSupplementScopeSchema.parse(saved);
  }

  getLatestReportReadingAudit(documentId: string): { id: string; audit: ReportReadingAudit } | null {
    const row = this.db.prepare(`SELECT id,summary FROM audit_events WHERE event_type='report_reading.accounted'
      AND entity_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1`).get(documentId) as { id: string; summary: string } | undefined;
    if (!row) return null;
    const { jobId: _jobId, attemptId: _attemptId, ...audit } = JSON.parse(row.summary);
    return { id: row.id, audit: reportReadingAuditSchema.parse(audit) };
  }

  /** 重建允许结束等待用户的旧批次，但不能打断正在运行或即将发送的任务。 */
  assertProcessingRebuildIdle(): void {
    if (this.db.prepare(`SELECT 1 FROM jobs WHERE status IN ('queued', 'running', 'retry_wait') LIMIT 1`).get()
      || this.db.prepare(`SELECT 1 FROM job_attempts WHERE finished_at IS NULL AND status='running' LIMIT 1`).get()) {
      throw new Error('PROCESSING_REBUILD_HAS_ACTIVE_JOB');
    }
  }

  listProcessingRebuildSources(personIds?: readonly string[]): ProcessingRebuildSource[] {
    if (personIds && (personIds.length === 0 || personIds.length > 20 || new Set(personIds).size !== personIds.length
      || personIds.some((id) => !this.db.prepare('SELECT id FROM persons WHERE id=? AND archived_at IS NULL').get(id)))) {
      throw new Error('PROCESSING_REBUILD_PERSON_SCOPE_INVALID');
    }
    const rows = this.db.prepare(`SELECT d.id, d.person_id, so.id AS source_object_id, so.sha256,
      so.media_type, so.vault_relative_path,
      converted.media_type AS converted_media_type, converted.vault_relative_path AS converted_vault_relative_path,
      COALESCE((SELECT display_name FROM source_occurrences occ WHERE occ.source_object_id = so.id
        ORDER BY occ.last_seen DESC LIMIT 1), sm.original_display_name, '未命名资料') AS display_name
      FROM documents d JOIN persons p ON p.id = d.person_id
      JOIN source_objects so ON so.id = d.source_object_id
      LEFT JOIN source_manifests sm ON sm.document_id = d.id
      LEFT JOIN document_conversions dc ON dc.document_id = d.id
      LEFT JOIN source_objects converted ON converted.id = dc.converted_source_object_id
      WHERE p.archived_at IS NULL AND d.excluded_from_analysis = 0 AND d.status != 'ignored'
      ORDER BY d.created_at, d.id`).all() as Array<{
        id: string; person_id: string; source_object_id: string; sha256: string; media_type: string;
        vault_relative_path: string; converted_media_type: string | null;
        converted_vault_relative_path: string | null; display_name: string;
      }>;
    const selected = rows.filter((row) => !personIds || personIds.includes(row.person_id));
    // 显式选择的每位成员都必须有可重建原件，不能静默缩小用户确认的清空范围。
    if (personIds?.some((personId) => !selected.some((row) => row.person_id === personId))) {
      throw new Error('PROCESSING_REBUILD_PERSON_SCOPE_INVALID');
    }
    return selected.map((row) => ({ documentId: row.id, personId: row.person_id, sourceObjectId: row.source_object_id,
      sha256: row.sha256, mediaType: row.media_type, displayName: row.display_name,
      sourcePath: join(this.vaultDirectory, row.vault_relative_path),
      convertedSourcePath: row.converted_vault_relative_path ? join(this.vaultDirectory, row.converted_vault_relative_path) : null,
      convertedMediaType: row.converted_media_type }));
  }

  /** 始终返回不可变原件，不把 Word 的转换 PDF 路径冒充原件。仅供主进程读取。 */
  getDocumentOriginalSource(documentId: string): DocumentOriginalSource {
    const row = this.db.prepare(`SELECT d.id,d.person_id,d.status,d.excluded_from_analysis,
      p.archived_at,so.id AS source_object_id,so.sha256,so.media_type,so.vault_relative_path,
      COALESCE((SELECT display_name FROM source_occurrences occ WHERE occ.source_object_id=so.id
        ORDER BY occ.last_seen DESC LIMIT 1),(SELECT original_display_name FROM source_manifests sm
        WHERE sm.document_id=d.id),'未命名资料') AS display_name
      FROM documents d JOIN source_objects so ON so.id=d.source_object_id
      LEFT JOIN persons p ON p.id=d.person_id WHERE d.id=?`).get(documentId) as
      { id: string; person_id: string | null; status: ImportedDocumentSummary['status']; excluded_from_analysis: number;
        archived_at: string | null; source_object_id: string; sha256: string; media_type: string;
        vault_relative_path: string; display_name: string } | undefined;
    if (!row) throw new Error('DOCUMENT_NOT_FOUND');
    return { documentId: row.id, personId: row.person_id, personArchived: row.archived_at !== null,
      sourceObjectId: row.source_object_id, sha256: row.sha256, mediaType: row.media_type, displayName: row.display_name,
      sourcePath: join(this.vaultDirectory, row.vault_relative_path), status: row.status,
      excludedFromAnalysis: row.excluded_from_analysis !== 0 };
  }

  /** 排除资料全清后可缺骨架。准备后同步复核范围并保存；不改变纳入状态或调用模型。 */
  saveMissingSourceManifestForReinclusion(manifest: SourceManifest, expected: DocumentOriginalSource): boolean {
    sourceManifestSchema.parse(manifest);
    return this.db.transaction(() => {
      const current = this.getDocumentOriginalSource(expected.documentId);
      if (JSON.stringify(current) !== JSON.stringify(expected) || !current.personId || current.personArchived
        || manifest.sourceObjectId !== current.sourceObjectId || manifest.sha256 !== current.sha256
        || !manifest.normalizerVersion.startsWith('direct-original-')
        || manifest.spans.length === 0 || manifest.spans.some((span) => span.documentId !== current.documentId
          || span.modelEvidence || span.visualEvidence || span.quote !== null)
        || createHash('sha256').update(readFileSync(current.sourcePath)).digest('hex') !== current.sha256) {
        throw new Error('DOCUMENT_REINCLUSION_SOURCE_SCOPE_CHANGED');
      }
      const active = this.db.prepare(`SELECT checkpoint_json FROM jobs WHERE status IN
        ('queued','running','waiting_auth','waiting_quota','waiting_user','retry_wait')`).all() as Array<{ checkpoint_json: string | null }>;
      if (active.some((job) => {
        const checkpoint = JSON.parse(job.checkpoint_json ?? '{}') as { documentIds?: string[] };
        return checkpoint.documentIds?.includes(current.documentId);
      })) throw new Error('DOCUMENT_HAS_ACTIVE_JOB');
      if (this.countSourceSpans(current.documentId) > 0) return false;
      this.saveSourceManifest(manifest);
      return true;
    })();
  }

  /** 返回已通过正常转换入口保存的只读视图；原件与转换件的哈希分开核验。 */
  getDocumentConvertedView(documentId: string): {
    bytes: Uint8Array; sha256: string; mediaType: string; converterId: string;
    converterVersion: string; executableSha256: string;
  } | null {
    const row = this.db.prepare(`SELECT original.sha256 AS original_sha256,
      original.vault_relative_path AS original_path, converted.sha256,converted.media_type,
      converted.vault_relative_path,dc.converter_id,dc.converter_version,dc.executable_sha256
      FROM document_conversions dc JOIN documents d ON d.id=dc.document_id
      JOIN source_objects original ON original.id=d.source_object_id
      JOIN source_objects converted ON converted.id=dc.converted_source_object_id WHERE dc.document_id=?`).get(documentId) as
      { original_sha256: string; original_path: string; sha256: string; media_type: string; vault_relative_path: string;
        converter_id: string; converter_version: string; executable_sha256: string } | undefined;
    if (!row) return null;
    const original = readFileSync(join(this.vaultDirectory, row.original_path));
    const bytes = readFileSync(join(this.vaultDirectory, row.vault_relative_path));
    if (createHash('sha256').update(original).digest('hex') !== row.original_sha256
      || createHash('sha256').update(bytes).digest('hex') !== row.sha256
      || row.media_type !== 'application/pdf' || !row.converter_id || !row.converter_version
      || !/^[a-f0-9]{64}$/u.test(row.executable_sha256)) throw new Error('CONVERTED_SOURCE_VIEW_INVALID');
    return { bytes, sha256: row.sha256, mediaType: row.media_type, converterId: row.converter_id,
      converterVersion: row.converter_version, executableSha256: row.executable_sha256 };
  }

  /** 每次重建都生成新的恢复点，不把当天可能更早的日备份当作本次备份。 */
  async createProcessingRebuildBackup(): Promise<ProcessingRebuildBackup> {
    this.assertProcessingRebuildIdle();
    const id = randomUUID();
    const stateSignature = processingRebuildStateSignature(this.db);
    const databasePath = join(this.schemaBackupDirectory, `processing-rebuild-${id}.db`);
    await this.createDatabaseBackup(databasePath);
    chmodSync(databasePath, 0o600);
    const saved = new Database(databasePath, { readonly: true, fileMustExist: true });
    try {
      if (saved.pragma('integrity_check', { simple: true }) !== 'ok'
        || processingRebuildStateSignature(saved) !== stateSignature
        || processingRebuildStateSignature(this.db) !== stateSignature) {
        throw new Error('PROCESSING_REBUILD_BACKUP_CHANGED');
      }
    } finally {
      saved.close();
    }
    const backup = { id, databasePath, stateSignature, createdAt: this.now().toISOString() };
    writeFileSync(join(this.schemaBackupDirectory, `processing-rebuild-${id}.json`),
      `${JSON.stringify({ formatVersion: 1, kind: 'processing-rebuild', ...backup,
        databaseFile: basename(databasePath) }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    return backup;
  }

  /** 正式重建入口：恢复点、源文件、授权和新批次一起校验，事务失败则保持原结果。 */
  rebuildProcessingResults(input: {
    backup: ProcessingRebuildBackup;
    manifests: SourceManifest[];
    accountFingerprint: string;
    consentVersion: number;
    confirmedRebuildReportResults: true;
    personIds?: string[];
    clearPersonalData?: true;
    confirmedClearPersonalData?: true;
    confirmedPersonAliases?: Array<{ personId: string; reportedName: string }>;
    promptVersion: string;
    rulesVersion: string;
  }): { rebuildId: string; batchId: string; documentCount: number; personCount: number; recoveryPointCreated: true } {
    return this.db.transaction(() => {
      this.assertProcessingRebuildIdle();
      const expectedBackupPath = join(this.schemaBackupDirectory, `processing-rebuild-${input.backup.id}.db`);
      if (resolve(input.backup.databasePath) !== expectedBackupPath || !existsSync(expectedBackupPath)) {
        throw new Error('PROCESSING_REBUILD_BACKUP_REQUIRED');
      }
      const saved = new Database(expectedBackupPath, { readonly: true, fileMustExist: true });
      try {
        if (saved.pragma('integrity_check', { simple: true }) !== 'ok'
          || processingRebuildStateSignature(saved) !== input.backup.stateSignature
          || processingRebuildStateSignature(this.db) !== input.backup.stateSignature) {
          throw new Error('PROCESSING_REBUILD_BACKUP_CHANGED');
        }
      } finally { saved.close(); }
      if (!input.accountFingerprint || !Number.isInteger(input.consentVersion) || input.consentVersion < 1
        || input.confirmedRebuildReportResults !== true
        || Boolean(input.clearPersonalData) !== Boolean(input.confirmedClearPersonalData)) {
        throw new Error('PROCESSING_REBUILD_AUTH_REQUIRED');
      }
      const sources = this.listProcessingRebuildSources(input.personIds);
      if (sources.length === 0) throw new Error('NO_READY_DOCUMENTS');
      const manifests = new Map(input.manifests.map((manifest) => [manifest.spans[0]?.documentId, manifest]));
      if (manifests.size !== sources.length || input.manifests.length !== sources.length) {
        throw new Error('PROCESSING_REBUILD_SOURCE_SCOPE_CHANGED');
      }
      for (const source of sources) {
        const manifest = manifests.get(source.documentId);
        if (!manifest || manifest.sourceObjectId !== source.sourceObjectId || manifest.sha256 !== source.sha256
          || manifest.spans.length === 0 || manifest.spans.some((span) => span.documentId !== source.documentId)
          || createHash('sha256').update(readFileSync(source.sourcePath)).digest('hex') !== source.sha256) {
          throw new Error('PROCESSING_REBUILD_SOURCE_SCOPE_CHANGED');
        }
        const oldLocators = (this.db.prepare(`SELECT ss.id,ss.page_number,ss.block_id,ss.line_start,ss.line_end
          FROM source_spans ss JOIN source_manifests sm ON sm.document_id = ss.document_id
          WHERE ss.document_id = ? AND sm.source_object_id = ? AND sm.sha256 = ?`)
          .all(source.documentId, source.sourceObjectId, source.sha256) as Array<{
            id: string; page_number: number | null; block_id: string | null;
            line_start: number | null; line_end: number | null;
          }>).map((span) => ({ id: span.id, page: span.page_number, blockId: span.block_id,
            lineStart: span.line_start, lineEnd: span.line_end }));
        // 原件输入骨架的ID由文件哈希和页码稳定派生。不能复用旧OCR编号，
        // 否则提取时重新准备的原页集合会与清单不一致。
        if (!manifest.normalizerVersion.startsWith('direct-original-')) {
          manifests.set(source.documentId, reuseUniqueOriginalSourceLocators(oldLocators, manifest, source.mediaType));
        }
      }
      const timestamp = this.now().toISOString();
      const personIds = [...new Set(sources.map((source) => source.personId))];
      const documentIds = sources.map((source) => source.documentId);
      const personPlaceholders = personIds.map(() => '?').join(',');
      const documentPlaceholders = documentIds.map(() => '?').join(',');
      const aliases = input.confirmedPersonAliases ?? [];
      if (aliases.length > 20 || aliases.some((alias) => !personIds.includes(alias.personId)
        || typeof alias.reportedName !== 'string' || !alias.reportedName.trim() || alias.reportedName.trim().length > 80)
        || new Set(aliases.map((alias) => `${alias.personId}:${normalizedPersonName(alias.reportedName)}`)).size !== aliases.length) {
        throw new Error('PROCESSING_REBUILD_ALIAS_SCOPE_INVALID');
      }
      // 当前明确确认在恢复点与范围校验之后写入，同一事务内的冲突会撤回全部清理。
      for (const alias of aliases) this.confirmPersonNameAlias(alias);
      if (input.clearPersonalData && input.personIds) {
        this.clearScopedRebuildableWorkspaceData(personIds);
      } else if (input.clearPersonalData) {
        this.clearAllRebuildableWorkspaceData();
      } else {
      // 历史收据保留，但旧任务、旧授权与旧原文缓存不再具备发送能力。
      if (!input.personIds) this.db.prepare(`UPDATE consents SET revoked_at = ? WHERE revoked_at IS NULL`).run(timestamp);
      this.db.prepare(`UPDATE jobs SET status = 'cancelled', lease_owner = NULL, lease_expires_at = NULL,
        updated_at = ? WHERE status IN ('waiting_user', 'waiting_auth', 'waiting_quota')
        ${input.personIds ? `AND person_id IN (${personPlaceholders})` : ''}`)
        .run(timestamp, ...(input.personIds ? personIds : []));
      for (const job of this.db.prepare(`SELECT id FROM jobs WHERE checkpoint_json IS NOT NULL
        ${input.personIds ? `AND person_id IN (${personPlaceholders})` : ''}`)
        .all(...(input.personIds ? personIds : [])) as Array<{ id: string }>) {
        this.scrubExtractionChunksFromJob(job.id);
      }
      this.db.prepare(`UPDATE review_issues SET resolution_status = 'resolved',
        resolution_revision = COALESCE(resolution_revision, 0) + 1
        WHERE resolution_status = 'open' AND (field_ref IN (${documentIds.map(() => '?').join(',')})
          OR job_id IN (SELECT id FROM jobs WHERE person_id IN (${personPlaceholders})))`)
        .run(...documentIds.map((id) => `document:${id}`), ...personIds);
      this.db.prepare(`DELETE FROM derivation_dependencies WHERE dependency_id IN
        (SELECT id FROM observations WHERE person_id IN (${personPlaceholders}))
        OR derived_id IN (SELECT id FROM derived_snapshots WHERE person_id IN (${personPlaceholders})
          UNION SELECT id FROM system_analysis_snapshots_v2 WHERE person_id IN (${personPlaceholders}))`)
        .run(...personIds, ...personIds, ...personIds);
      for (const table of ['snapshot_evidence', 'derived_snapshots', 'member_assessment_snapshots_v3',
        'system_analysis_snapshots_v2'] as const) {
        if (table === 'snapshot_evidence') this.db.prepare(`DELETE FROM snapshot_evidence WHERE snapshot_id IN
          (SELECT id FROM derived_snapshots WHERE person_id IN (${personPlaceholders}))`).run(...personIds);
        else this.db.prepare(`DELETE FROM ${table} WHERE person_id IN (${personPlaceholders})`).run(...personIds);
      }
      this.db.prepare(`DELETE FROM observation_revisions WHERE observation_id IN
        (SELECT id FROM observations WHERE person_id IN (${personPlaceholders}))`).run(...personIds);
      this.db.prepare(`DELETE FROM observations WHERE person_id IN (${personPlaceholders})`).run(...personIds);
      this.db.prepare(`DELETE FROM clinical_statements WHERE person_id IN (${personPlaceholders})
        AND source_kind != 'user_reported'`).run(...personIds);
      this.db.prepare(`DELETE FROM encounter_documents WHERE encounter_id IN
        (SELECT id FROM encounters WHERE person_id IN (${personPlaceholders}))`).run(...personIds);
      this.db.prepare(`DELETE FROM encounters WHERE person_id IN (${personPlaceholders})`).run(...personIds);
      this.db.prepare(`DELETE FROM event_relation_changes WHERE person_id IN (${personPlaceholders})`).run(...personIds);
      this.db.prepare(`DELETE FROM report_metadata_revisions WHERE report_id IN
        (SELECT id FROM report_records WHERE person_id IN (${personPlaceholders}))`).run(...personIds);
      this.db.prepare(`DELETE FROM event_report_links WHERE report_id IN
        (SELECT id FROM report_records WHERE person_id IN (${personPlaceholders}))`).run(...personIds);
      this.db.prepare(`DELETE FROM report_source_links WHERE report_id IN
        (SELECT id FROM report_records WHERE person_id IN (${personPlaceholders}))`).run(...personIds);
      this.db.prepare(`DELETE FROM report_records WHERE person_id IN (${personPlaceholders})`).run(...personIds);
      this.db.prepare(`DELETE FROM health_events_v2 WHERE person_id IN (${personPlaceholders})`).run(...personIds);
      this.db.prepare(`DELETE FROM report_clinical_contexts WHERE person_id IN (${personPlaceholders})`).run(...personIds);
      this.db.prepare(`DELETE FROM document_commits WHERE document_id IN
        (SELECT id FROM documents WHERE person_id IN (${personPlaceholders}))`).run(...personIds);
      // 本人已采纳的行动及本人填写的计划保留；未采纳的机器生活建议退出当前视图。
      this.db.prepare(`UPDATE lifestyle_proposals_v2 SET status = 'superseded', updated_at = ?
        WHERE person_id IN (${personPlaceholders}) AND status != 'adopted'`).run(timestamp, ...personIds);
      }
      // 排除资料不重新发送；既然旧接纳结果已退出活动档案，也不能留下旧的已接纳标识。
      this.db.prepare(`UPDATE documents SET acceptance_id = NULL,
        status = CASE WHEN excluded_from_analysis = 1 OR status = 'ignored' THEN 'ignored' ELSE status END
        WHERE person_id IN (${personPlaceholders})`).run(...personIds);
      this.db.prepare(`UPDATE documents SET acceptance_id = NULL, status = 'queued'
        WHERE id IN (${documentPlaceholders})`).run(...documentIds);
      this.db.prepare(`DELETE FROM source_spans WHERE document_id IN (${documentPlaceholders})`).run(...documentIds);
      this.db.prepare(`DELETE FROM source_manifests WHERE document_id IN (${documentPlaceholders})`).run(...documentIds);
      for (const manifest of manifests.values()) this.saveSourceManifest(manifest);
      for (const personId of personIds) this.db.prepare(`INSERT INTO person_revisions(person_id, fact_revision)
        VALUES (?, 1) ON CONFLICT(person_id) DO UPDATE SET fact_revision = fact_revision + 1`).run(personId);
      const consentId = this.createManualProcessingConsent({ documentIds, personIds,
        accountFingerprint: input.accountFingerprint, version: input.consentVersion });
      const groups = personIds.map((personId) => {
        const ids = sources.filter((source) => source.personId === personId).map((source) => source.documentId);
        return { personId, documentIds: ids, stage: 'extract' as const,
          inputSignature: createHash('sha256').update(JSON.stringify({ rebuildId: input.backup.id,
            personId, documentIds: ids, promptVersion: input.promptVersion, rulesVersion: input.rulesVersion })).digest('hex') };
      });
      const batch = this.createWaitingAuthBatch({ cutoff: timestamp, groups, initialStatus: 'queued', consentId });
      this.db.prepare(`INSERT INTO audit_events(id,event_type,entity_id,summary,created_at)
        VALUES (?, 'processing.rebuilt_from_sources', ?, ?, ?)`).run(randomUUID(), input.backup.id,
          input.clearPersonalData
            ? `已保存独立恢复点，仅保留原件和成员，清理旧结果、本人补充及计划，重新排队 ${sources.length} 份原件`
            : `已保存独立恢复点，清理机器处理结果并按新流程重新排队 ${sources.length} 份本机原始资料；成员和本人记录保留`, timestamp);
      return { rebuildId: input.backup.id, batchId: batch.batchId, documentCount: sources.length,
        personCount: personIds.length, recoveryPointCreated: true as const };
    })();
  }

  /** 仅在已验证恢复点和原件后调用；只清空明确成员，不借共享批次或授权扩大删除范围。 */
  private clearScopedRebuildableWorkspaceData(personIds: readonly string[]): void {
    for (const personId of personIds) {
      this.db.prepare('DELETE FROM automatic_upload_intent_items WHERE intent_id IN (SELECT id FROM automatic_upload_intents WHERE person_id=?)').run(personId);
      this.db.prepare('DELETE FROM automatic_upload_intents WHERE person_id=?').run(personId);
    }
    if (!this.db.inTransaction || personIds.length === 0) throw new Error('PROCESSING_REBUILD_PERSON_SCOPE_INVALID');
    const marks = (ids: readonly string[]) => ids.length ? ids.map(() => '?').join(',') : 'NULL';
    const p = marks(personIds);
    const ids = (table: string, where: string, parameters: readonly string[]): string[] =>
      (this.db.prepare(`SELECT id FROM ${table} WHERE ${where}`).all(...parameters) as Array<{ id: string }>).map((row) => row.id);
    const remove = (table: string, column: string, values: readonly string[]) => {
      if (values.length) this.db.prepare(`DELETE FROM ${table} WHERE ${column} IN (${marks(values)})`).run(...values);
    };
    const image = (table: string, where = '1', parameters: readonly string[] = []) =>
      JSON.stringify(this.db.prepare(`SELECT * FROM ${table} WHERE ${where} ORDER BY rowid`).all(...parameters));
    const documentIds = ids('documents', `person_id IN (${p})`, personIds);
    const d = marks(documentIds);
    const jobIds = ids('jobs', `person_id IN (${p})`, personIds);
    const j = marks(jobIds);
    const batchIds = (this.db.prepare(`SELECT DISTINCT batch_id AS id FROM jobs WHERE id IN (${j}) AND batch_id IS NOT NULL`)
      .all(...jobIds) as Array<{ id: string }>).map((row) => row.id);
    const bindingIds = ids('inbox_bindings', `person_id IN (${p})`, personIds);
    const observationIds = ids('observations', `person_id IN (${p})`, personIds);
    const noteIds = ids('user_notes', `person_id IN (${p})`, personIds);
    const snapshotIds = ids('derived_snapshots', `person_id IN (${p})`, personIds);
    const systemSnapshotIds = ids('system_analysis_snapshots_v2', `person_id IN (${p})`, personIds);
    const assessmentIds = ids('member_assessment_snapshots_v3', `person_id IN (${p})`, personIds);
    const actionIds = ids('action_items', `person_id IN (${p})`, personIds);
    const proposalIds = ids('lifestyle_proposals_v2', `person_id IN (${p})`, personIds);
    const adoptionIds = ids('action_adoptions_v2', `person_id IN (${p})`, personIds);
    const reportIds = ids('report_records', `person_id IN (${p})`, personIds);
    const eventIds = ids('health_events_v2', `person_id IN (${p})`, personIds);
    const encounterIds = ids('encounters', `person_id IN (${p})`, personIds);
    const publicationIds = ids('publication_events', `person_id IN (${p})`, personIds);
    const spanIds = ids('source_spans', `document_id IN (${d})`, documentIds);
    const derivedIds = [...snapshotIds, ...systemSnapshotIds, ...assessmentIds, ...proposalIds, ...adoptionIds];
    const acceptanceIds = (this.db.prepare(`SELECT acceptance_id AS id FROM documents WHERE id IN (${d}) AND acceptance_id IS NOT NULL
      UNION SELECT acceptance_id AS id FROM observation_revisions WHERE observation_id IN (${marks(observationIds)})`)
      .all(...documentIds, ...observationIds) as Array<{ id: string }>).map((row) => row.id);
    const scopeEntities = [...personIds, ...documentIds, ...jobIds, ...bindingIds, ...observationIds, ...noteIds,
      ...derivedIds, ...actionIds, ...reportIds, ...eventIds, ...encounterIds, ...publicationIds, ...spanIds];
    // 异常跨成员外键不能靠 SET NULL 或删依赖掩盖；宁可整笔回滚，也不改另一人的记录。
    const crossScope = this.db.prepare(`SELECT 1 FROM ai_transmissions
        WHERE (job_id IN (${j}) AND document_id NOT IN (${d})) OR (document_id IN (${d}) AND job_id NOT IN (${j}))
      UNION ALL SELECT 1 FROM extraction_repair_diagnostics
        WHERE (job_id IN (${j}) AND document_id NOT IN (${d})) OR (document_id IN (${d}) AND job_id NOT IN (${j}))
      UNION ALL SELECT 1 FROM review_issues WHERE field_ref IN (${marks(documentIds)}) AND job_id NOT IN (${j})
      UNION ALL SELECT 1 FROM encounter_documents ed JOIN encounters e ON e.id=ed.encounter_id
        WHERE (ed.document_id IN (${d}) AND e.person_id NOT IN (${p}))
          OR (ed.encounter_id IN (${marks(encounterIds)}) AND ed.document_id NOT IN (${d}))
      UNION ALL SELECT 1 FROM report_source_links sl JOIN report_records r ON r.id=sl.report_id
        WHERE (sl.document_id IN (${d}) AND r.person_id NOT IN (${p}))
          OR (sl.report_id IN (${marks(reportIds)}) AND sl.document_id NOT IN (${d}))
      UNION ALL SELECT 1 FROM document_commits
        WHERE (publication_id IN (${marks(publicationIds)}) AND document_id NOT IN (${d}))
          OR (document_id IN (${d}) AND publication_id NOT IN (${marks(publicationIds)}))
      UNION ALL SELECT 1 FROM derivation_dependencies WHERE dependency_id IN (${marks([...observationIds, ...noteIds])})
        AND derived_id NOT IN (${marks(derivedIds)}) LIMIT 1`).get(
      ...jobIds, ...documentIds, ...documentIds, ...jobIds,
      ...jobIds, ...documentIds, ...documentIds, ...jobIds, ...documentIds.map((id) => `document:${id}`), ...jobIds,
      ...documentIds, ...personIds, ...encounterIds, ...documentIds,
      ...documentIds, ...personIds, ...reportIds, ...documentIds,
      ...publicationIds, ...documentIds, ...documentIds, ...publicationIds, ...observationIds, ...noteIds, ...derivedIds);
    if (crossScope) throw new Error('PROCESSING_REBUILD_CROSS_PERSON_REFERENCE');

    const sourceMappings = JSON.stringify(this.db.prepare(`SELECT d.id,d.source_object_id,d.person_id,so.sha256
      FROM documents d JOIN source_objects so ON so.id=d.source_object_id ORDER BY d.id`).all());
    const originals = this.db.prepare(`SELECT DISTINCT so.id,so.sha256,so.vault_relative_path FROM source_objects so
      JOIN documents d ON d.source_object_id=so.id WHERE d.id IN (${d}) ORDER BY so.id`).all(...documentIds) as
      Array<{ id: string; sha256: string; vault_relative_path: string }>;
    const originalHashes = () => originals.map((source) => ({ id: source.id,
      hash: createHash('sha256').update(readFileSync(join(this.vaultDirectory, source.vault_relative_path))).digest('hex') }));
    const beforeHashes = originalHashes();
    if (beforeHashes.some((source, index) => source.hash !== originals[index]!.sha256)) {
      throw new Error('PROCESSING_REBUILD_SOURCE_SCOPE_CHANGED');
    }
    const personTables = ['person_context_revisions', 'person_revisions', 'user_notes', 'clinical_statements',
      'observations', 'derived_snapshots', 'member_assessment_snapshots_v3', 'system_analysis_snapshots_v2',
      'action_items', 'action_adoptions_v2', 'lifestyle_proposals_v2', 'jobs', 'inbox_bindings',
      'encounters', 'health_events_v2', 'report_records', 'event_relation_changes', 'report_clinical_contexts', 'publication_events'] as const;
    const foreignRows = personTables.map((table) => ({ table,
      value: image(table, `person_id IS NULL OR person_id NOT IN (${p})`, personIds) }));
    const globalRows = ['source_objects', 'person_name_aliases', 'schedules', 'notifications', 'knowledge_entries',
      'backup_manifests', 'body_system_registry', 'concept_definitions', 'concept_aliases', 'workspaces']
      .map((table) => ({ table, value: image(table) }));
    // 共享同意回执保留原样。发送还必须持有仍存在的当前 job、attempt 和绑定；旧目标执行能力在此删除。
    const pureConsentIds = (this.db.prepare('SELECT id,scope_json FROM consents').all() as Array<{ id: string; scope_json: string }>)
      .filter((consent) => {
        try {
          const scope = JSON.parse(consent.scope_json) as { type?: string; personId?: string; personIds?: string[];
            documentIds?: string[]; historicalObservationIds?: string[] };
          return scope.type === 'inbox_binding' ? Boolean(scope.personId && personIds.includes(scope.personId))
            : scope.type === 'manual_batch' && Array.isArray(scope.personIds) && scope.personIds.length > 0
              && scope.personIds.every((id) => personIds.includes(id)) && Array.isArray(scope.documentIds)
              && scope.documentIds.every((id) => documentIds.includes(id))
              && (scope.historicalObservationIds ?? []).every((id) => observationIds.includes(id));
        } catch { return false; }
      }).map((consent) => consent.id);
    const retainedConsents = image('consents', `id NOT IN (${marks(pureConsentIds)})`, pureConsentIds);

    // 补全原件文件名元数据，不删原件或路径记录。
    const unnamed = this.db.prepare(`SELECT sm.source_object_id,sm.original_display_name,sm.created_at,so.vault_relative_path
      FROM source_manifests sm JOIN source_objects so ON so.id=sm.source_object_id WHERE sm.document_id IN (${d})
      AND NOT EXISTS(SELECT 1 FROM source_occurrences occ WHERE occ.source_object_id=sm.source_object_id)`)
      .all(...documentIds) as Array<{ source_object_id: string; original_display_name: string; created_at: string; vault_relative_path: string }>;
    for (const source of unnamed) this.db.prepare(`INSERT OR IGNORE INTO source_occurrences
      (id,source_object_id,binding_id,original_path,display_name,first_seen,last_seen) VALUES (?,?,NULL,?,?,?,?)`)
      .run(randomUUID(), source.source_object_id, join(this.vaultDirectory, source.vault_relative_path),
        source.original_display_name, source.created_at, this.now().toISOString());
    if (bindingIds.length) this.db.prepare(`UPDATE source_occurrences SET binding_id=NULL WHERE binding_id IN (${marks(bindingIds)})`).run(...bindingIds);
    remove('inbox_bindings', 'id', bindingIds);
    this.db.prepare(`UPDATE documents SET acceptance_id=NULL,confirmed_reported_name=NULL WHERE id IN (${d})`).run(...documentIds);
    this.db.prepare(`DELETE FROM ai_transmissions WHERE document_id IN (${d}) OR job_id IN (${j})`).run(...documentIds, ...jobIds);
    this.db.prepare(`DELETE FROM extraction_repair_diagnostics WHERE document_id IN (${d}) OR job_id IN (${j})`).run(...documentIds, ...jobIds);
    this.db.prepare(`DELETE FROM review_issues WHERE job_id IN (${j}) OR field_ref IN (${marks(documentIds)})`)
      .run(...jobIds, ...documentIds.map((id) => `document:${id}`));
    remove('job_attempts', 'job_id', jobIds);
    remove('jobs', 'id', jobIds);
    for (const batchId of batchIds) {
      const removed = this.db.prepare('DELETE FROM batches WHERE id=? AND NOT EXISTS(SELECT 1 FROM jobs WHERE batch_id=?)').run(batchId, batchId);
      if (removed.changes) scopeEntities.push(batchId);
    }
    remove('action_events', 'action_id', actionIds);
    remove('action_items', 'id', actionIds);
    remove('action_adoptions_v2', 'id', adoptionIds);
    remove('lifestyle_proposals_v2', 'id', proposalIds);
    remove('snapshot_evidence', 'snapshot_id', snapshotIds);
    remove('derived_snapshots', 'id', snapshotIds);
    remove('member_assessment_snapshots_v3', 'id', assessmentIds);
    remove('system_analysis_snapshots_v2', 'id', systemSnapshotIds);
    remove('derivation_dependencies', 'derived_id', derivedIds);
    remove('concept_mapping_corrections', 'observation_id', observationIds);
    remove('system_fact_links', 'observation_id', observationIds);
    remove('observation_concept_mappings', 'observation_id', observationIds);
    remove('observation_revisions', 'observation_id', observationIds);
    remove('observations', 'id', observationIds);
    for (const table of ['clinical_statements', 'user_notes', 'person_context_revisions', 'event_relation_changes', 'report_clinical_contexts']) {
      this.db.prepare(`DELETE FROM ${table} WHERE person_id IN (${p})`).run(...personIds);
    }
    remove('encounter_documents', 'encounter_id', encounterIds);
    remove('encounters', 'id', encounterIds);
    remove('report_metadata_revisions', 'report_id', reportIds);
    remove('event_report_links', 'report_id', reportIds);
    remove('report_source_links', 'report_id', reportIds);
    remove('report_records', 'id', reportIds);
    remove('health_events_v2', 'id', eventIds);
    remove('document_commits', 'document_id', documentIds);
    remove('publication_events', 'id', publicationIds);
    for (const acceptanceId of acceptanceIds) {
      const removed = this.db.prepare(`DELETE FROM acceptance_decisions WHERE id=?
        AND NOT EXISTS(SELECT 1 FROM documents WHERE acceptance_id=?)
        AND NOT EXISTS(SELECT 1 FROM observation_revisions WHERE acceptance_id=?)`).run(acceptanceId, acceptanceId, acceptanceId);
      if (removed.changes) scopeEntities.push(acceptanceId);
    }
    remove('source_manifest_spans', 'document_id', documentIds);
    remove('source_manifests', 'document_id', documentIds);
    remove('source_spans', 'document_id', documentIds);
    for (const consentId of pureConsentIds) this.db.prepare(`DELETE FROM consents WHERE id=?
      AND NOT EXISTS(SELECT 1 FROM inbox_bindings WHERE consent_id=?)
      AND NOT EXISTS(SELECT 1 FROM ai_transmissions WHERE consent_id=?)
      AND NOT EXISTS(SELECT 1 FROM jobs WHERE json_extract(checkpoint_json,'$.consentId')=?)`)
      .run(consentId, consentId, consentId, consentId);
    this.db.prepare(`DELETE FROM exclusions WHERE document_id IN (${d}) OR binding_id IN (${marks(bindingIds)})`).run(...documentIds, ...bindingIds);
    this.db.prepare(`DELETE FROM deleted_document_tombstones WHERE person_id IN (${p})`).run(...personIds);
    this.db.prepare(`DELETE FROM audit_events WHERE entity_id IN (${marks(scopeEntities)})
      AND event_type NOT IN ('person.name_alias_confirmed','person.name_alias_revoked','person_display_updated','person.created')`)
      .run(...scopeEntities);
    this.db.prepare(`UPDATE persons SET clinical_context_revision=0 WHERE id IN (${p})`).run(...personIds);
    this.db.prepare(`UPDATE person_revisions SET fact_revision=0 WHERE person_id IN (${p})`).run(...personIds);

    const remainingMappings = JSON.stringify(this.db.prepare(`SELECT d.id,d.source_object_id,d.person_id,so.sha256
      FROM documents d JOIN source_objects so ON so.id=d.source_object_id ORDER BY d.id`).all());
    if (sourceMappings !== remainingMappings || JSON.stringify(beforeHashes) !== JSON.stringify(originalHashes())
      || foreignRows.some(({ table, value }) => value !== image(table, `person_id IS NULL OR person_id NOT IN (${p})`, personIds))
      || globalRows.some(({ table, value }) => value !== image(table))
      || retainedConsents !== image('consents', `id NOT IN (${marks(pureConsentIds)})`, pureConsentIds)
      || (this.db.pragma('foreign_key_check') as unknown[]).length > 0) {
      throw new Error('PROCESSING_REBUILD_PRESERVED_SOURCE_CHANGED');
    }
  }

  /** 仅在已验证恢复点、全范围原件和强确认之后，由重建事务调用。 */
  private clearAllRebuildableWorkspaceData(): void {
    const preserved = this.db.prepare(`SELECT d.id,d.source_object_id,d.person_id,so.sha256
      FROM documents d JOIN source_objects so ON so.id=d.source_object_id ORDER BY d.id`).all();
    // 某些早期导入只在旧证据清单记录文件名。文件名属于原件元数据，清理
    // 识别结果前补入原件来源记录，否则重新纳入时会失去扩展名而无法准备输入。
    const unnamedOriginals = this.db.prepare(`SELECT sm.source_object_id,sm.original_display_name,
      sm.created_at,so.vault_relative_path FROM source_manifests sm JOIN source_objects so ON so.id=sm.source_object_id
      WHERE NOT EXISTS(SELECT 1 FROM source_occurrences occ WHERE occ.source_object_id=sm.source_object_id)
      ORDER BY sm.document_id`).all() as Array<{ source_object_id: string; original_display_name: string;
        created_at: string; vault_relative_path: string }>;
    const retainName = this.db.prepare(`INSERT OR IGNORE INTO source_occurrences
      (id,source_object_id,binding_id,original_path,display_name,first_seen,last_seen) VALUES (?,?,NULL,?,?,?,?)`);
    for (const original of unnamedOriginals) retainName.run(randomUUID(), original.source_object_id,
      join(this.vaultDirectory, original.vault_relative_path), original.original_display_name, original.created_at, this.now().toISOString());
    // 本机原件路径记录保留，自动扫描授权及计划清除，不让旧授权继续发送。
    this.db.exec('UPDATE source_occurrences SET binding_id=NULL; DELETE FROM inbox_bindings;');
    this.db.exec('UPDATE documents SET acceptance_id=NULL,confirmed_reported_name=NULL;');
    const deleteOrder = [
      'automatic_upload_intent_items', 'automatic_upload_intents',
      'ai_transmissions', 'extraction_repair_diagnostics', 'review_issues', 'job_attempts', 'jobs', 'batches',
      'action_events', 'action_items', 'action_adoptions_v2', 'lifestyle_proposals_v2',
      'snapshot_evidence', 'derived_snapshots', 'member_assessment_snapshots_v3', 'system_analysis_snapshots_v2',
      'derivation_dependencies', 'concept_mapping_corrections', 'system_fact_links', 'observation_concept_mappings',
      'observation_revisions', 'observations', 'clinical_statements', 'user_notes', 'person_context_revisions',
      'encounter_documents', 'encounters', 'event_relation_changes', 'report_metadata_revisions',
      'event_report_links', 'report_source_links', 'report_records', 'health_events_v2', 'report_clinical_contexts',
      'document_commits', 'publication_events', 'acceptance_decisions',
      'source_manifest_spans', 'source_manifests', 'source_spans',
      'consents', 'schedules', 'exclusions', 'notifications', 'audit_events', 'knowledge_entries',
      'deleted_document_tombstones'
    ] as const;
    for (const table of deleteOrder) this.db.exec(`DELETE FROM ${table}`);
    this.db.exec(`UPDATE documents SET acceptance_id=NULL,confirmed_reported_name=NULL;
      UPDATE persons SET clinical_context_revision=0;
      UPDATE person_revisions SET fact_revision=0;
      UPDATE workspaces SET queue_paused=0;`);
    // 已确认别名属于成员身份，不从报告识别猜测，也不随健康背景清理。
    const remaining = this.db.prepare(`SELECT d.id,d.source_object_id,d.person_id,so.sha256
      FROM documents d JOIN source_objects so ON so.id=d.source_object_id ORDER BY d.id`).all();
    if (JSON.stringify(preserved) !== JSON.stringify(remaining)
      || (this.db.pragma('foreign_key_check') as unknown[]).length > 0) {
      throw new Error('PROCESSING_REBUILD_PRESERVED_SOURCE_CHANGED');
    }
  }

  async createDatabaseSnapshot(destination: string): Promise<void> {
    await this.db.backup(destination);
  }

  async createDatabaseBackup(targetPath: string): Promise<void> {
    mkdirSync(dirname(resolve(targetPath)), { recursive: true, mode: 0o700 });
    await this.db.backup(resolve(targetPath));
  }

  private getPersonRevision(personId: string, column: 'display_revision' | 'clinical_context_revision'): number {
    const row = this.db.prepare(`SELECT ${column} AS revision FROM persons WHERE id = ?`).get(personId) as { revision: number } | undefined;
    if (!row) throw new Error('PERSON_NOT_FOUND');
    return row.revision;
  }

  private ensureWorkspace(): void {
    const existing = this.db.prepare(`SELECT id FROM workspaces LIMIT 1`).get() as { id: string } | undefined;
    if (existing) return;
    this.db.prepare(`
      INSERT INTO workspaces (id, schema_version, created_at, settings_revision)
      VALUES (?, ?, ?, 0)
    `).run(randomUUID(), SCHEMA_VERSION, this.now().toISOString());
  }

  private createPreMigrationDatabaseBackup(currentVersion: number): void {
    mkdirSync(this.schemaBackupDirectory, { recursive: true, mode: 0o700 });
    const timestamp = this.now().toISOString().replaceAll(':', '-').replaceAll('.', '-');
    const backupBase = `schema-upgrade-v${currentVersion}-to-v${SCHEMA_VERSION}-${timestamp}-${randomUUID()}`;
    const backupPath = join(this.schemaBackupDirectory, `${backupBase}.db`);
    this.db.prepare('VACUUM INTO ?').run(backupPath);
    chmodSync(backupPath, 0o600);
    writeFileSync(join(this.schemaBackupDirectory, `${backupBase}.json`), `${JSON.stringify({
      formatVersion: 1,
      kind: 'schema-upgrade',
      fromSchemaVersion: currentVersion,
      toSchemaVersion: SCHEMA_VERSION,
      createdAt: this.now().toISOString(),
      databaseFile: `${backupBase}.db`
    }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  }

  private migrate(): void {
    let current = Number(this.db.pragma('user_version', { simple: true }));
    if (current > SCHEMA_VERSION) throw new Error('WORKSPACE_SCHEMA_NEWER_THAN_APP');
    if (current === SCHEMA_VERSION) return;
    const upgradingExistingWorkspace = current > 0;
    if (upgradingExistingWorkspace) this.createPreMigrationDatabaseBackup(current);

    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (current === 1) {
        this.db.exec(`
          ALTER TABLE observation_revisions
            ADD COLUMN abnormal_flag TEXT NOT NULL DEFAULT 'unknown';
          UPDATE workspaces SET schema_version = 2;
          PRAGMA user_version = 2;
        `);
        current = 2;
      }

      if (current === 2) {
        this.db.exec(`
          ALTER TABLE workspaces
            ADD COLUMN queue_paused INTEGER NOT NULL DEFAULT 0 CHECK(queue_paused IN (0,1));
          UPDATE workspaces SET schema_version = 3;
          PRAGMA user_version = 3;
        `);
        current = 3;
      }

      if (current === 3) {
        this.db.exec(`
          CREATE TABLE deleted_document_tombstones (
            source_hash TEXT PRIMARY KEY,
            display_name TEXT NOT NULL,
            person_id TEXT,
            media_type TEXT NOT NULL,
            deleted_at TEXT NOT NULL,
            raw_object_retained INTEGER NOT NULL CHECK(raw_object_retained IN (0,1))
          ) STRICT;
          UPDATE workspaces SET schema_version = 4;
          PRAGMA user_version = 4;
        `);
        current = 4;
      }

      if (current === 4) {
        this.db.exec(`
          CREATE TABLE document_conversions (
            document_id TEXT PRIMARY KEY REFERENCES documents(id) ON DELETE CASCADE,
            converted_source_object_id TEXT NOT NULL REFERENCES source_objects(id),
            converter_id TEXT NOT NULL,
            converter_version TEXT NOT NULL,
            executable_sha256 TEXT NOT NULL,
            warnings_json TEXT NOT NULL,
            created_at TEXT NOT NULL
          ) STRICT;
          UPDATE workspaces SET schema_version = 5;
          PRAGMA user_version = 5;
        `);
        current = 5;
      }

      if (current === 5) {
        const hasTable = (name: string) => Boolean(this.db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(name));
        if (hasTable('documents')) this.db.exec(`ALTER TABLE documents ADD COLUMN person_assignment_basis TEXT NOT NULL DEFAULT 'legacy'`);
        if (hasTable('observation_revisions')) this.db.exec(`
          ALTER TABLE observation_revisions ADD COLUMN specimen TEXT;
          ALTER TABLE observation_revisions ADD COLUMN method TEXT;
          ALTER TABLE observation_revisions ADD COLUMN body_site TEXT;
          ALTER TABLE observation_revisions ADD COLUMN evidence_json TEXT NOT NULL DEFAULT '[]';
        `);
        if (hasTable('review_issues')) this.db.exec(`ALTER TABLE review_issues ADD COLUMN payload_json TEXT`);
        this.db.exec(`
          CREATE TABLE source_manifests (
            document_id TEXT PRIMARY KEY REFERENCES documents(id) ON DELETE CASCADE,
            manifest_id TEXT NOT NULL, source_object_id TEXT NOT NULL REFERENCES source_objects(id),
            sha256 TEXT NOT NULL, media_type TEXT NOT NULL, original_display_name TEXT NOT NULL,
            total_units INTEGER NOT NULL, covered_unit_indexes_json TEXT NOT NULL,
            normalizer_version TEXT NOT NULL, conversion_warnings_json TEXT NOT NULL,
            created_at TEXT NOT NULL
          ) STRICT;
          CREATE TABLE document_commits (
            document_id TEXT PRIMARY KEY REFERENCES documents(id) ON DELETE CASCADE,
            commit_key TEXT NOT NULL UNIQUE, publication_id TEXT NOT NULL REFERENCES publication_events(id),
            revision INTEGER NOT NULL, committed_at TEXT NOT NULL
          ) STRICT;
          CREATE TABLE ai_transmissions (
            id TEXT PRIMARY KEY, job_id TEXT NOT NULL REFERENCES jobs(id),
            attempt_id TEXT NOT NULL REFERENCES job_attempts(id), consent_id TEXT NOT NULL REFERENCES consents(id),
            document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
            stage TEXT NOT NULL, status TEXT NOT NULL, started_at TEXT NOT NULL, finished_at TEXT
          ) STRICT;
          CREATE INDEX idx_ai_transmissions_document ON ai_transmissions(document_id, started_at);
          UPDATE workspaces SET schema_version = 6;
          PRAGMA user_version = 6;
        `);
        current = 6;
      }

      if (current === 6) {
        const hasJobAttempts = Boolean(this.db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'job_attempts'`).get());
        if (hasJobAttempts) this.db.exec(`ALTER TABLE job_attempts ADD COLUMN reasoning_effort TEXT`);
        this.db.exec(`
          UPDATE workspaces SET schema_version = 7;
          PRAGMA user_version = 7;
        `);
        current = 7;
      }

      if (current === 7) {
        const hasDocuments = Boolean(this.db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'documents'`).get());
        const documentColumns = hasDocuments ? this.db.pragma('table_info(documents)') as Array<{ name: string }> : [];
        if (hasDocuments && !documentColumns.some((column) => column.name === 'confirmed_reported_name')) {
          this.db.exec(`ALTER TABLE documents ADD COLUMN confirmed_reported_name TEXT`);
        }
        const hasReviewIssues = Boolean(this.db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'review_issues'`).get());
        const hasSourceSpans = Boolean(this.db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'source_spans'`).get());
        if (hasReviewIssues && hasSourceSpans) {
          const identityCandidates = this.db.prepare(`
            SELECT id, evidence_refs_json
            FROM review_issues
            WHERE resolution_status = 'open' AND kind = 'field_conflict' AND payload_json IS NULL
          `).all() as Array<{ id: string; evidence_refs_json: string }>;
          const readQuote = this.db.prepare(`SELECT quote FROM source_spans WHERE id = ?`);
          const promoteIssue = this.db.prepare(`
            UPDATE review_issues SET kind = 'person_conflict', payload_json = ? WHERE id = ?
          `);
          for (const issue of identityCandidates) {
            const evidenceRefs = JSON.parse(issue.evidence_refs_json) as string[];
            const reportedName = evidenceRefs
              .map((sourceSpanId) => readQuote.get(sourceSpanId) as { quote: string | null } | undefined)
              .map((row) => row?.quote ? extractReportedNameFromIdentityEvidence(row.quote) : null)
              .find((name): name is string => Boolean(name));
            if (reportedName) promoteIssue.run(JSON.stringify({ reportedName }), issue.id);
          }
        }
        this.db.exec(`
          UPDATE workspaces SET schema_version = 8;
          PRAGMA user_version = 8;
        `);
        current = 8;
      }

      if (current === 8) {
        const tables = new Set((this.db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as Array<{ name: string }>)
          .map((row) => row.name));
        const canRecoverLegacyPdfIssues = [
          'documents', 'source_objects', 'source_manifests', 'document_conversions',
          'source_spans', 'review_issues', 'audit_events', 'jobs', 'job_attempts'
        ].every((table) => tables.has(table));
        if (canRecoverLegacyPdfIssues) {
          const legacyDocuments = this.db.prepare(`
          SELECT d.id, so.media_type,
                 EXISTS(SELECT 1 FROM document_conversions dc WHERE dc.document_id = d.id) AS has_conversion
          FROM documents d
          JOIN source_objects so ON so.id = d.source_object_id
          LEFT JOIN source_manifests sm ON sm.document_id = d.id
          WHERE sm.document_id IS NULL
          ORDER BY d.created_at, d.id
          `).all() as Array<{
            id: string;
            media_type: string;
            has_conversion: number;
          }>;

          for (const document of legacyDocuments) {
            if (document.has_conversion === 1 || document.media_type !== 'application/pdf') continue;
            const spans = this.db.prepare(`
            SELECT id, span_kind, page_number, quote, readability, normalizer_version
            FROM source_spans
            WHERE document_id = ?
            ORDER BY page_number, id
            `).all(document.id) as Array<{
              id: string;
              span_kind: string;
              page_number: number | null;
              quote: string | null;
              readability: string;
              normalizer_version: string;
            }>;
            if (spans.length === 0) continue;
            const normalizerVersions = new Set(spans.map((span) => span.normalizer_version));
            const pages = spans.map((span) => span.page_number);
            const isContiguousClearPageManifest = normalizerVersions.size === 1
              && spans.every((span) => span.span_kind === 'page'
                && span.page_number !== null
                && span.quote !== null
                && span.quote.trim().length > 0
                && span.readability === 'clear')
              && new Set(pages).size === spans.length
              && pages.every((page, index) => page === index + 1);
            if (!isContiguousClearPageManifest) continue;

            const coverageIssues = this.db.prepare(`
            SELECT id, payload_json FROM review_issues
            WHERE field_ref = 'document:' || ?
              AND kind = 'coverage_gap'
              AND resolution_status = 'open'
            `).all(document.id) as Array<{ id: string; payload_json: string | null }>;
            for (const issue of coverageIssues) {
              let payload: { candidateOptions?: ObservationCandidate[] } = {};
              try {
                payload = issue.payload_json ? JSON.parse(issue.payload_json) as typeof payload : {};
              } catch {
                continue;
              }
              const candidates = payload.candidateOptions ?? [];
              const hasBlockingCandidateIssue = candidates.some((candidate) => (
                candidate.issues.some((candidateIssue) => candidateIssue.code.startsWith('blocking_'))
              ));
              if (candidates.length === 0 || hasBlockingCandidateIssue) continue;
              this.db.prepare(`
              UPDATE review_issues
              SET resolution_status = 'resolved', resolution_revision = 1
              WHERE id = ? AND resolution_status = 'open'
              `).run(issue.id);
              this.db.prepare(`UPDATE documents SET status = 'queued' WHERE id = ? AND status = 'needs_review'`).run(document.id);
              this.db.prepare(`
              INSERT INTO audit_events (id, event_type, entity_id, summary, created_at)
              VALUES (?, 'review_issue.recovered', ?, '已识别旧版来源清单误拦截，资料重新进入原文件校验队列', ?)
              `).run(randomUUID(), issue.id, this.now().toISOString());
              this.resumeWaitingJobsAfterReview(document.id);
            }
          }
        }
        this.db.exec(`
          UPDATE workspaces SET schema_version = 9;
          PRAGMA user_version = 9;
        `);
        current = 9;
      }

      if (current === 9) {
        this.db.exec(`
          UPDATE workspaces SET schema_version = 10;
          PRAGMA user_version = 10;
        `);
        current = 10;
      }

      if (current === 10) {
        const tables = new Set((this.db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as Array<{ name: string }>)
          .map((row) => row.name));
        const canRetryPressureReview = [
          'documents', 'review_issues', 'audit_events', 'jobs', 'job_attempts'
        ].every((table) => tables.has(table));
        if (canRetryPressureReview) {
          const issues = this.db.prepare(`
            SELECT ri.id, ri.field_ref, ri.payload_json
            FROM review_issues ri
            WHERE ri.kind = 'field_conflict' AND ri.resolution_status = 'open'
            ORDER BY ri.created_at, ri.id
          `).all() as Array<{ id: string; field_ref: string; payload_json: string | null }>;
          for (const issue of issues) {
            let payload: { candidateOptions?: ObservationCandidate[]; candidateDiffs?: ReviewCandidateDiff[] } = {};
            try {
              payload = issue.payload_json ? JSON.parse(issue.payload_json) as typeof payload : {};
            } catch {
              continue;
            }
            const candidates = payload.candidateOptions ?? [];
            const differences = payload.candidateDiffs ?? [];
            const onlyIssueMarkersDiffer = differences.length > 0
              && differences.every((difference) => difference.fields.length > 0
                && difference.fields.every((field) => field === 'issues'));
            const hasCombinedPressure = candidates.some((candidate) => {
              const names = [candidate.originalName, candidate.standardNameCandidate]
                .filter((name): name is string => Boolean(name))
                .map((name) => name.normalize('NFKC').replace(/\s+/g, ' ').trim().toLocaleLowerCase('zh-CN'));
              return names.some((name) => name === '血压' || /\bblood pressure\b/.test(name))
                && /^\d{1,3}(?:\.\d+)?\s*[/／]\s*\d{1,3}(?:\.\d+)?$/.test(candidate.value.rawText?.normalize('NFKC').trim() ?? '');
            });
            if (!onlyIssueMarkersDiffer || !hasCombinedPressure) continue;
            const documentId = issue.field_ref.startsWith('document:') ? issue.field_ref.slice('document:'.length) : null;
            if (!documentId) continue;
            this.db.prepare(`
              UPDATE review_issues
              SET resolution_status = 'resolved', resolution_revision = 1
              WHERE id = ? AND resolution_status = 'open'
            `).run(issue.id);
            this.db.prepare(`UPDATE documents SET status = 'queued' WHERE id = ? AND status = 'needs_review'`).run(documentId);
            this.db.prepare(`
              INSERT INTO audit_events (id, event_type, entity_id, summary, created_at)
              VALUES (?, 'review_issue.recovered', ?, '血压成对结果已进入确定性拆分和重新核对', ?)
            `).run(randomUUID(), issue.id, this.now().toISOString());
            this.resumeWaitingJobsAfterReview(documentId);
          }
        }
        this.db.exec(`
          UPDATE workspaces SET schema_version = 11;
          PRAGMA user_version = 11;
        `);
        current = 11;
      }

      if (current === 11) {
        const tables = new Set((this.db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as Array<{ name: string }>)
          .map((row) => row.name));
        const canRetryContextualDateReview = [
          'documents', 'source_spans', 'review_issues', 'audit_events', 'jobs', 'job_attempts'
        ].every((table) => tables.has(table));
        if (canRetryContextualDateReview) {
          const readSpan = this.db.prepare(`SELECT quote, readability FROM source_spans WHERE id = ?`);
          const issues = this.db.prepare(`
            SELECT id, field_ref, payload_json
            FROM review_issues
            WHERE kind = 'field_conflict' AND resolution_status = 'open'
            ORDER BY created_at, id
          `).all() as Array<{ id: string; field_ref: string; payload_json: string | null }>;
          for (const issue of issues) {
            let payload: { candidateOptions?: ObservationCandidate[]; candidateDiffs?: ReviewCandidateDiff[] } = {};
            try {
              payload = issue.payload_json ? JSON.parse(issue.payload_json) as typeof payload : {};
            } catch {
              continue;
            }
            const candidates = payload.candidateOptions ?? [];
            const differences = payload.candidateDiffs ?? [];
            const onlyIssueMarkersDiffer = differences.length > 0
              && differences.every((difference) => difference.fields.length > 0
                && difference.fields.every((field) => field === 'issues'));
            const retryableDateContext = onlyIssueMarkersDiffer && differences.every((difference) => {
              const candidate = candidates.find((item) => item.localKey === difference.localKey);
              if (!candidate?.clinicalDate || candidate.issues.some((item) => item.code.startsWith('blocking_'))) return false;
              return candidate.evidence.some((reference) => {
                const span = readSpan.get(reference.sourceSpanId) as { quote: string | null; readability: string } | undefined;
                if (!span?.quote || span.readability !== 'clear' || !reference.quote || !span.quote.includes(reference.quote)) return false;
                const dates = calendarDatesInText(span.quote);
                return dates.length === 1 && dates[0] === candidate.clinicalDate;
              });
            });
            if (!retryableDateContext) continue;
            const documentId = issue.field_ref.startsWith('document:') ? issue.field_ref.slice('document:'.length) : null;
            if (!documentId) continue;
            this.db.prepare(`
              UPDATE review_issues
              SET resolution_status = 'resolved', resolution_revision = 1
              WHERE id = ? AND resolution_status = 'open'
            `).run(issue.id);
            this.db.prepare(`UPDATE documents SET status = 'queued' WHERE id = ? AND status = 'needs_review'`).run(documentId);
            this.db.prepare(`
              INSERT INTO audit_events (id, event_type, entity_id, summary, created_at)
              VALUES (?, 'review_issue.recovered', ?, '临床日期已由同一唯一日期来源片段补齐，资料重新进入核对队列', ?)
            `).run(randomUUID(), issue.id, this.now().toISOString());
            this.resumeWaitingJobsAfterReview(documentId);
          }
        }
        this.db.exec(`
          UPDATE workspaces SET schema_version = 12;
          PRAGMA user_version = 12;
        `);
        current = 12;
      }

      if (current === 12) {
        const tables = new Set((this.db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as Array<{ name: string }>)
          .map((row) => row.name));
        const canRetryQualitativeCategoryReview = [
          'documents', 'source_spans', 'review_issues', 'audit_events', 'jobs', 'job_attempts'
        ].every((table) => tables.has(table));
        if (canRetryQualitativeCategoryReview) {
          const readSpan = this.db.prepare(`SELECT quote, readability FROM source_spans WHERE id = ?`);
          const issues = this.db.prepare(`
            SELECT id, field_ref, payload_json
            FROM review_issues
            WHERE kind = 'field_conflict' AND resolution_status = 'open'
            ORDER BY created_at, id
          `).all() as Array<{ id: string; field_ref: string; payload_json: string | null }>;
          for (const issue of issues) {
            let payload: { candidateOptions?: ObservationCandidate[]; candidateDiffs?: ReviewCandidateDiff[] } = {};
            try {
              payload = issue.payload_json ? JSON.parse(issue.payload_json) as typeof payload : {};
            } catch {
              continue;
            }
            const candidates = payload.candidateOptions ?? [];
            const differences = payload.candidateDiffs ?? [];
            const onlyQualitativeValuesDiffer = differences.length > 0 && differences.every((difference) => {
              if (difference.fields.length !== 1 || difference.fields[0] !== 'value') return false;
              const candidate = candidates.find((item) => item.localKey === difference.localKey);
              if (candidate?.value.kind !== 'qualitative' || candidate.issues.some((item) => item.code.startsWith('blocking_'))) return false;
              const rawText = candidate.value.rawText;
              return candidate.evidence.some((reference) => {
                const span = readSpan.get(reference.sourceSpanId) as { quote: string | null; readability: string } | undefined;
                const citedQuote = reference.quote;
                if (!span?.quote || span.readability !== 'clear' || !citedQuote) return false;
                return span.quote.includes(citedQuote) && citedQuote.includes(rawText);
              });
            });
            if (!onlyQualitativeValuesDiffer) continue;
            const documentId = issue.field_ref.startsWith('document:') ? issue.field_ref.slice('document:'.length) : null;
            if (!documentId) continue;
            this.db.prepare(`
              UPDATE review_issues
              SET resolution_status = 'resolved', resolution_revision = 1
              WHERE id = ? AND resolution_status = 'open'
            `).run(issue.id);
            this.db.prepare(`UPDATE documents SET status = 'queued' WHERE id = ? AND status = 'needs_review'`).run(documentId);
            this.db.prepare(`
              INSERT INTO audit_events (id, event_type, entity_id, summary, created_at)
              VALUES (?, 'review_issue.recovered', ?, '定性原文一致时允许补充单侧标准分类，资料重新进入核对队列', ?)
            `).run(randomUUID(), issue.id, this.now().toISOString());
            this.resumeWaitingJobsAfterReview(documentId);
          }
        }
        this.db.exec(`
          UPDATE workspaces SET schema_version = 13;
          PRAGMA user_version = 13;
        `);
        current = 13;
      }

      if (current === 13) {
        const tables = new Set((this.db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as Array<{ name: string }>)
          .map((row) => row.name));
        const canRetrySectionDateReview = [
          'documents', 'source_spans', 'review_issues', 'audit_events', 'jobs', 'job_attempts'
        ].every((table) => tables.has(table));
        if (canRetrySectionDateReview) {
          const readSpan = this.db.prepare(`SELECT quote, readability FROM source_spans WHERE id = ?`);
          const issues = this.db.prepare(`
            SELECT id, field_ref, payload_json
            FROM review_issues
            WHERE kind = 'field_conflict' AND resolution_status = 'open'
            ORDER BY created_at, id
          `).all() as Array<{ id: string; field_ref: string; payload_json: string | null }>;
          for (const issue of issues) {
            let payload: { candidateOptions?: ObservationCandidate[]; candidateDiffs?: ReviewCandidateDiff[] } = {};
            try {
              payload = issue.payload_json ? JSON.parse(issue.payload_json) as typeof payload : {};
            } catch {
              continue;
            }
            const candidates = payload.candidateOptions ?? [];
            const differences = payload.candidateDiffs ?? [];
            const retryableSectionDateContext = differences.length > 0 && differences.every((difference) => {
              if (difference.fields.length !== 1 || difference.fields[0] !== 'issues') return false;
              const candidate = candidates.find((item) => item.localKey === difference.localKey);
              if (!candidate?.clinicalDate || candidate.issues.some((item) => item.code.startsWith('blocking_'))) return false;
              const rawText = candidate.value.rawText;
              if (!rawText) return false;
              return candidate.evidence.some((reference) => {
                const span = readSpan.get(reference.sourceSpanId) as { quote: string | null; readability: string } | undefined;
                const citedQuote = reference.quote;
                if (!span?.quote || span.readability !== 'clear' || !citedQuote) return false;
                if (!citedQuote.includes(rawText)) return false;
                return hasUnambiguousContextualDateEvidence(span.quote, citedQuote, candidate.clinicalDate!);
              });
            });
            if (!retryableSectionDateContext) continue;
            const documentId = issue.field_ref.startsWith('document:') ? issue.field_ref.slice('document:'.length) : null;
            if (!documentId) continue;
            this.db.prepare(`
              UPDATE review_issues
              SET resolution_status = 'resolved', resolution_revision = 1
              WHERE id = ? AND resolution_status = 'open'
            `).run(issue.id);
            this.db.prepare(`UPDATE documents SET status = 'queued' WHERE id = ? AND status = 'needs_review'`).run(documentId);
            this.db.prepare(`
              INSERT INTO audit_events (id, event_type, entity_id, summary, created_at)
              VALUES (?, 'review_issue.recovered', ?, '项目已与前置检查日期形成唯一连续证据，资料重新进入核对队列', ?)
            `).run(randomUUID(), issue.id, this.now().toISOString());
            this.resumeWaitingJobsAfterReview(documentId);
          }
        }
        this.db.exec(`
          UPDATE workspaces SET schema_version = 14;
          PRAGMA user_version = 14;
        `);
        current = 14;
      }

      if (current === 14) {
        const tables = new Set((this.db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as Array<{ name: string }>)
          .map((row) => row.name));
        const canRetryUltrasoundMethodReview = [
          'documents', 'review_issues', 'audit_events', 'jobs', 'job_attempts'
        ].every((table) => tables.has(table));
        if (canRetryUltrasoundMethodReview) {
          const issues = this.db.prepare(`
            SELECT id, field_ref, payload_json
            FROM review_issues
            WHERE kind = 'field_conflict' AND resolution_status = 'open'
            ORDER BY created_at, id
          `).all() as Array<{ id: string; field_ref: string; payload_json: string | null }>;
          for (const issue of issues) {
            let payload: { candidateOptions?: ObservationCandidate[]; candidateDiffs?: ReviewCandidateDiff[] } = {};
            try {
              payload = issue.payload_json ? JSON.parse(issue.payload_json) as typeof payload : {};
            } catch {
              continue;
            }
            const candidates = payload.candidateOptions ?? [];
            const differences = payload.candidateDiffs ?? [];
            const onlyUltrasoundMethodLabelsDiffer = differences.length > 0 && differences.every((difference) => {
              if (difference.fields.length !== 1 || difference.fields[0] !== 'method') return false;
              const candidate = candidates.find((item) => item.localKey === difference.localKey);
              return Boolean(candidate
                && isUltrasoundMethod(candidate.method)
                && isUltrasoundMethod(`${candidate.originalName} ${candidate.standardNameCandidate ?? ''}`)
                && !candidate.issues.some((item) => item.code.startsWith('blocking_')));
            });
            if (!onlyUltrasoundMethodLabelsDiffer) continue;
            const documentId = issue.field_ref.startsWith('document:') ? issue.field_ref.slice('document:'.length) : null;
            if (!documentId) continue;
            this.db.prepare(`
              UPDATE review_issues
              SET resolution_status = 'resolved', resolution_revision = 1
              WHERE id = ? AND resolution_status = 'open'
            `).run(issue.id);
            this.db.prepare(`UPDATE documents SET status = 'queued' WHERE id = ? AND status = 'needs_review'`).run(documentId);
            this.db.prepare(`
              INSERT INTO audit_events (id, event_type, entity_id, summary, created_at)
              VALUES (?, 'review_issue.recovered', ?, '同一超声项目的方法别名已统一，资料重新进入核对队列', ?)
            `).run(randomUUID(), issue.id, this.now().toISOString());
            this.resumeWaitingJobsAfterReview(documentId);
          }
        }
        this.db.exec(`
          UPDATE workspaces SET schema_version = 15;
          PRAGMA user_version = 15;
        `);
        current = 15;
      }

      if (current === 15) {
        const tables = new Set((this.db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as Array<{ name: string }>)
          .map((row) => row.name));
        const canRetryWhitespaceEvidenceReview = [
          'documents', 'source_spans', 'review_issues', 'audit_events', 'jobs', 'job_attempts'
        ].every((table) => tables.has(table));
        if (canRetryWhitespaceEvidenceReview) {
          const readSpan = this.db.prepare(`SELECT quote, readability FROM source_spans WHERE id = ?`);
          const issues = this.db.prepare(`
            SELECT id, field_ref, payload_json
            FROM review_issues
            WHERE kind = 'field_conflict' AND resolution_status = 'open'
            ORDER BY created_at, id
          `).all() as Array<{ id: string; field_ref: string; payload_json: string | null }>;
          for (const issue of issues) {
            let payload: { candidateOptions?: ObservationCandidate[]; candidateDiffs?: ReviewCandidateDiff[] } = {};
            try {
              payload = issue.payload_json ? JSON.parse(issue.payload_json) as typeof payload : {};
            } catch {
              continue;
            }
            const candidates = payload.candidateOptions ?? [];
            const differences = payload.candidateDiffs ?? [];
            const onlyWhitespaceSplitReportedText = differences.length > 0 && differences.every((difference) => {
              if (difference.fields.length !== 1 || difference.fields[0] !== 'issues') return false;
              const candidate = candidates.find((item) => item.localKey === difference.localKey);
              if (!candidate || (candidate.value.kind !== 'text' && candidate.value.kind !== 'qualitative')) return false;
              if (candidate.issues.some((item) => item.code.startsWith('blocking_'))) return false;
              const rawText = candidate.value.rawText.normalize('NFKC').toLocaleLowerCase('zh-CN');
              return candidate.evidence.some((reference) => {
                const span = readSpan.get(reference.sourceSpanId) as { quote: string | null; readability: string } | undefined;
                const citedQuote = reference.quote;
                if (!span?.quote || span.readability !== 'clear' || !citedQuote || !span.quote.includes(citedQuote)) return false;
                const cited = citedQuote.normalize('NFKC').toLocaleLowerCase('zh-CN');
                if (cited.includes(rawText) || !compactEvidenceText(cited).includes(compactEvidenceText(rawText))) return false;
                if (!candidate.clinicalDate) return true;
                return calendarDatesInText(citedQuote).includes(candidate.clinicalDate);
              });
            });
            if (!onlyWhitespaceSplitReportedText) continue;
            const documentId = issue.field_ref.startsWith('document:') ? issue.field_ref.slice('document:'.length) : null;
            if (!documentId) continue;
            this.db.prepare(`
              UPDATE review_issues
              SET resolution_status = 'resolved', resolution_revision = 1
              WHERE id = ? AND resolution_status = 'open'
            `).run(issue.id);
            this.db.prepare(`UPDATE documents SET status = 'queued' WHERE id = ? AND status = 'needs_review'`).run(documentId);
            this.db.prepare(`
              INSERT INTO audit_events (id, event_type, entity_id, summary, created_at)
              VALUES (?, 'review_issue.recovered', ?, 'PDF 排版空格造成的结果断字已按原文核对，资料重新进入核对队列', ?)
            `).run(randomUUID(), issue.id, this.now().toISOString());
            this.resumeWaitingJobsAfterReview(documentId);
          }
        }
        this.db.exec(`
          UPDATE workspaces SET schema_version = 16;
          PRAGMA user_version = 16;
        `);
        current = 16;
      }

      if (current === 16) {
        const tables = new Set((this.db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as Array<{ name: string }>)
          .map((row) => row.name));
        const canRetryOptionalNormalSummaryReview = [
          'documents', 'source_spans', 'review_issues', 'audit_events', 'jobs', 'job_attempts'
        ].every((table) => tables.has(table));
        if (canRetryOptionalNormalSummaryReview) {
          const readSpan = this.db.prepare(`SELECT quote, readability FROM source_spans WHERE id = ?`);
          const issues = this.db.prepare(`
            SELECT id, field_ref, payload_json
            FROM review_issues
            WHERE kind = 'field_conflict' AND resolution_status = 'open'
            ORDER BY created_at, id
          `).all() as Array<{ id: string; field_ref: string; payload_json: string | null }>;
          for (const issue of issues) {
            let payload: { candidateOptions?: ObservationCandidate[]; candidateDiffs?: ReviewCandidateDiff[] } = {};
            try {
              payload = issue.payload_json ? JSON.parse(issue.payload_json) as typeof payload : {};
            } catch {
              continue;
            }
            const candidates = payload.candidateOptions ?? [];
            const differences = payload.candidateDiffs ?? [];
            const onlyOneSidedNormalSummaries = differences.length > 0 && differences.every((difference) => {
              if (difference.fields.length !== 1 || difference.fields[0] !== 'presence') return false;
              const candidate = candidates.find((item) => item.localKey === difference.localKey);
              if (!candidate || !isOptionalNormalSummaryCandidate(candidate)) return false;
              if (candidate.issues.some((item) => item.code.startsWith('blocking_'))) return false;
              const rawText = candidate.value.rawText;
              if (!rawText) return false;
              return candidate.evidence.some((reference) => {
                const span = readSpan.get(reference.sourceSpanId) as { quote: string | null; readability: string } | undefined;
                const citedQuote = reference.quote;
                if (!span?.quote || span.readability !== 'clear' || !citedQuote || !span.quote.includes(citedQuote)) return false;
                return compactEvidenceText(citedQuote).includes(compactEvidenceText(rawText));
              });
            });
            if (!onlyOneSidedNormalSummaries) continue;
            const documentId = issue.field_ref.startsWith('document:') ? issue.field_ref.slice('document:'.length) : null;
            if (!documentId) continue;
            this.db.prepare(`
              UPDATE review_issues
              SET resolution_status = 'resolved', resolution_revision = 1
              WHERE id = ? AND resolution_status = 'open'
            `).run(issue.id);
            this.db.prepare(`UPDATE documents SET status = 'queued' WHERE id = ? AND status = 'needs_review'`).run(documentId);
            this.db.prepare(`
              INSERT INTO audit_events (id, event_type, entity_id, summary, created_at)
              VALUES (?, 'review_issue.recovered', ?, '仅单轮出现的正常小结将保守省略，资料重新进入核对队列', ?)
            `).run(randomUUID(), issue.id, this.now().toISOString());
            this.resumeWaitingJobsAfterReview(documentId);
          }
        }
        this.db.exec(`
          UPDATE workspaces SET schema_version = 17;
          PRAGMA user_version = 17;
        `);
        current = 17;
      }

      if (current === 17) {
        const tables = new Set((this.db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as Array<{ name: string }>)
          .map((row) => row.name));
        const canRetryOptionalEmptyUnknownReview = [
          'documents', 'source_spans', 'review_issues', 'audit_events', 'jobs', 'job_attempts'
        ].every((table) => tables.has(table));
        if (canRetryOptionalEmptyUnknownReview) {
          const readSpan = this.db.prepare(`SELECT quote, readability FROM source_spans WHERE id = ?`);
          const issues = this.db.prepare(`
            SELECT id, field_ref, payload_json
            FROM review_issues
            WHERE kind = 'field_conflict' AND resolution_status = 'open'
            ORDER BY created_at, id
          `).all() as Array<{ id: string; field_ref: string; payload_json: string | null }>;
          for (const issue of issues) {
            let payload: { candidateOptions?: ObservationCandidate[]; candidateDiffs?: ReviewCandidateDiff[] } = {};
            try {
              payload = issue.payload_json ? JSON.parse(issue.payload_json) as typeof payload : {};
            } catch {
              continue;
            }
            const candidates = payload.candidateOptions ?? [];
            const differences = payload.candidateDiffs ?? [];
            const onlyOneSidedEmptyUnknowns = differences.length > 0 && differences.every((difference) => {
              if (difference.fields.length !== 1 || difference.fields[0] !== 'presence') return false;
              const candidate = candidates.find((item) => item.localKey === difference.localKey);
              if (!candidate || !isOptionalEmptyUnknownCandidate(candidate)) return false;
              const normalizedName = compactEvidenceText(candidate.originalName);
              if (!normalizedName) return false;
              return candidate.evidence.some((reference) => {
                const span = readSpan.get(reference.sourceSpanId) as { quote: string | null; readability: string } | undefined;
                const citedQuote = reference.quote;
                if (!span?.quote || span.readability !== 'clear' || !citedQuote || !span.quote.includes(citedQuote)) return false;
                return compactEvidenceText(citedQuote).includes(normalizedName);
              });
            });
            if (!onlyOneSidedEmptyUnknowns) continue;
            const documentId = issue.field_ref.startsWith('document:') ? issue.field_ref.slice('document:'.length) : null;
            if (!documentId) continue;
            this.db.prepare(`
              UPDATE review_issues
              SET resolution_status = 'resolved', resolution_revision = 1
              WHERE id = ? AND resolution_status = 'open'
            `).run(issue.id);
            this.db.prepare(`UPDATE documents SET status = 'queued' WHERE id = ? AND status = 'needs_review'`).run(documentId);
            this.db.prepare(`
              INSERT INTO audit_events (id, event_type, entity_id, summary, created_at)
              VALUES (?, 'review_issue.recovered', ?, '仅单轮出现的空白未报告项目已保守省略，资料重新进入核对队列', ?)
            `).run(randomUUID(), issue.id, this.now().toISOString());
            this.resumeWaitingJobsAfterReview(documentId);
          }
        }
        this.db.exec(`
          UPDATE workspaces SET schema_version = 18;
          PRAGMA user_version = 18;
        `);
        current = 18;
      }

      if (current === 18) {
        const tables = new Set((this.db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as Array<{ name: string }>)
          .map((row) => row.name));
        const canRetryWhitespaceOnlyCitationReview = [
          'documents', 'source_spans', 'review_issues', 'audit_events', 'jobs', 'job_attempts'
        ].every((table) => tables.has(table));
        if (canRetryWhitespaceOnlyCitationReview) {
          const readSpan = this.db.prepare(`SELECT quote, readability FROM source_spans WHERE id = ?`);
          const issues = this.db.prepare(`
            SELECT id, field_ref, payload_json
            FROM review_issues
            WHERE kind = 'field_conflict' AND resolution_status = 'open'
            ORDER BY created_at, id
          `).all() as Array<{ id: string; field_ref: string; payload_json: string | null }>;
          for (const issue of issues) {
            let payload: { candidateOptions?: ObservationCandidate[]; candidateDiffs?: ReviewCandidateDiff[] } = {};
            try {
              payload = issue.payload_json ? JSON.parse(issue.payload_json) as typeof payload : {};
            } catch {
              continue;
            }
            const candidates = payload.candidateOptions ?? [];
            const differences = payload.candidateDiffs ?? [];
            const onlyWhitespaceOnlyCitationFailures = differences.length > 0 && differences.every((difference) => {
              if (difference.fields.length !== 1 || difference.fields[0] !== 'issues') return false;
              const candidate = candidates.find((item) => item.localKey === difference.localKey);
              if (!candidate || (candidate.value.kind !== 'text' && candidate.value.kind !== 'qualitative')) return false;
              if (candidate.issues.some((item) => item.code.startsWith('blocking_'))) return false;
              const rawText = compactEvidenceText(candidate.value.rawText);
              if (!rawText) return false;
              return candidate.evidence.some((reference) => {
                const span = readSpan.get(reference.sourceSpanId) as { quote: string | null; readability: string } | undefined;
                const citedQuote = reference.quote;
                if (!span?.quote || span.readability !== 'clear' || !citedQuote) return false;
                if (span.quote.includes(citedQuote)) return false;
                if (!compactEvidenceText(span.quote).includes(compactEvidenceText(citedQuote))) return false;
                if (!compactEvidenceText(citedQuote).includes(rawText)) return false;
                return !candidate.clinicalDate || calendarDatesInText(citedQuote).includes(candidate.clinicalDate);
              });
            });
            if (!onlyWhitespaceOnlyCitationFailures) continue;
            const documentId = issue.field_ref.startsWith('document:') ? issue.field_ref.slice('document:'.length) : null;
            if (!documentId) continue;
            this.db.prepare(`
              UPDATE review_issues
              SET resolution_status = 'resolved', resolution_revision = 1
              WHERE id = ? AND resolution_status = 'open'
            `).run(issue.id);
            this.db.prepare(`UPDATE documents SET status = 'queued' WHERE id = ? AND status = 'needs_review'`).run(documentId);
            this.db.prepare(`
              INSERT INTO audit_events (id, event_type, entity_id, summary, created_at)
              VALUES (?, 'review_issue.recovered', ?, 'PDF 空白排版不同但字符一致的证据摘录已核对，资料重新进入核对队列', ?)
            `).run(randomUUID(), issue.id, this.now().toISOString());
            this.resumeWaitingJobsAfterReview(documentId);
          }
        }
        this.db.exec(`
          UPDATE workspaces SET schema_version = 19;
          PRAGMA user_version = 19;
        `);
        current = 19;
      }

      if (current === 19) {
        const tables = new Set((this.db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as Array<{ name: string }>)
          .map((row) => row.name));
        const canRetryAbbreviatedCitationReview = [
          'documents', 'source_spans', 'review_issues', 'audit_events', 'jobs', 'job_attempts'
        ].every((table) => tables.has(table));
        if (canRetryAbbreviatedCitationReview) {
          const readSpan = this.db.prepare(`SELECT quote, readability FROM source_spans WHERE id = ?`);
          const issues = this.db.prepare(`
            SELECT id, field_ref, payload_json
            FROM review_issues
            WHERE kind = 'field_conflict' AND resolution_status = 'open'
            ORDER BY created_at, id
          `).all() as Array<{ id: string; field_ref: string; payload_json: string | null }>;
          for (const issue of issues) {
            let payload: { candidateOptions?: ObservationCandidate[]; candidateDiffs?: ReviewCandidateDiff[] } = {};
            try {
              payload = issue.payload_json ? JSON.parse(issue.payload_json) as typeof payload : {};
            } catch {
              continue;
            }
            const candidates = payload.candidateOptions ?? [];
            const differences = payload.candidateDiffs ?? [];
            const onlyUniquelyAbbreviatedCitations = differences.length > 0 && differences.every((difference) => {
              if (difference.fields.length !== 1 || difference.fields[0] !== 'issues') return false;
              const candidate = candidates.find((item) => item.localKey === difference.localKey);
              if (!candidate || candidate.issues.some((item) => item.code.startsWith('blocking_'))) return false;
              const rawText = compactEvidenceText(candidate.value.rawText ?? '');
              if (!rawText) return false;
              return candidate.evidence.some((reference) => {
                const span = readSpan.get(reference.sourceSpanId) as { quote: string | null; readability: string } | undefined;
                const citedQuote = reference.quote;
                if (!span?.quote || span.readability !== 'clear' || !citedQuote || span.quote.includes(citedQuote)) return false;
                const expanded = uniquelyExpandedAbbreviatedQuote(span.quote, citedQuote);
                if (!expanded || !compactEvidenceText(expanded).includes(rawText)) return false;
                return !candidate.clinicalDate || calendarDatesInText(expanded).includes(candidate.clinicalDate);
              });
            });
            if (!onlyUniquelyAbbreviatedCitations) continue;
            const documentId = issue.field_ref.startsWith('document:') ? issue.field_ref.slice('document:'.length) : null;
            if (!documentId) continue;
            this.db.prepare(`
              UPDATE review_issues
              SET resolution_status = 'resolved', resolution_revision = 1
              WHERE id = ? AND resolution_status = 'open'
            `).run(issue.id);
            this.db.prepare(`UPDATE documents SET status = 'queued' WHERE id = ? AND status = 'needs_review'`).run(documentId);
            this.db.prepare(`
              INSERT INTO audit_events (id, event_type, entity_id, summary, created_at)
              VALUES (?, 'review_issue.recovered', ?, '同一来源内可唯一定位的省略证据已展开为连续原文，资料重新进入核对队列', ?)
            `).run(randomUUID(), issue.id, this.now().toISOString());
            this.resumeWaitingJobsAfterReview(documentId);
          }
        }
        this.db.exec(`
          UPDATE workspaces SET schema_version = 20;
          PRAGMA user_version = 20;
        `);
        current = 20;
      }

      if (current === 20) {
        const tables = new Set((this.db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as Array<{ name: string }>)
          .map((row) => row.name));
        const canRetrySectionAnchoredAbbreviatedCitation = [
          'documents', 'source_spans', 'review_issues', 'audit_events', 'jobs', 'job_attempts'
        ].every((table) => tables.has(table));
        if (canRetrySectionAnchoredAbbreviatedCitation) {
          const readSpan = this.db.prepare(`SELECT quote, readability FROM source_spans WHERE id = ?`);
          const issues = this.db.prepare(`
            SELECT id, field_ref, payload_json
            FROM review_issues
            WHERE kind = 'field_conflict' AND resolution_status = 'open'
            ORDER BY created_at, id
          `).all() as Array<{ id: string; field_ref: string; payload_json: string | null }>;
          for (const issue of issues) {
            let payload: { candidateOptions?: ObservationCandidate[]; candidateDiffs?: ReviewCandidateDiff[] } = {};
            try {
              payload = issue.payload_json ? JSON.parse(issue.payload_json) as typeof payload : {};
            } catch {
              continue;
            }
            const candidates = payload.candidateOptions ?? [];
            const differences = payload.candidateDiffs ?? [];
            const onlySectionAnchoredAbbreviatedCitations = differences.length > 0 && differences.every((difference) => {
              if (difference.fields.length !== 1 || difference.fields[0] !== 'issues') return false;
              const candidate = candidates.find((item) => item.localKey === difference.localKey);
              if (!candidate || candidate.issues.some((item) => item.code.startsWith('blocking_'))) return false;
              const rawText = compactEvidenceText(candidate.value.rawText ?? '');
              if (!rawText) return false;
              return candidate.evidence.some((reference) => {
                const span = readSpan.get(reference.sourceSpanId) as { quote: string | null; readability: string } | undefined;
                const citedQuote = reference.quote;
                if (!span?.quote || span.readability !== 'clear' || !citedQuote || span.quote.includes(citedQuote)) return false;
                const expanded = uniquelyExpandedAbbreviatedQuote(span.quote, citedQuote);
                if (!expanded || !compactEvidenceText(expanded).includes(rawText)) return false;
                return !candidate.clinicalDate || calendarDatesInText(expanded).includes(candidate.clinicalDate);
              });
            });
            if (!onlySectionAnchoredAbbreviatedCitations) continue;
            const documentId = issue.field_ref.startsWith('document:') ? issue.field_ref.slice('document:'.length) : null;
            if (!documentId) continue;
            this.db.prepare(`
              UPDATE review_issues
              SET resolution_status = 'resolved', resolution_revision = 1
              WHERE id = ? AND resolution_status = 'open'
            `).run(issue.id);
            this.db.prepare(`UPDATE documents SET status = 'queued' WHERE id = ? AND status = 'needs_review'`).run(documentId);
            this.db.prepare(`
              INSERT INTO audit_events (id, event_type, entity_id, summary, created_at)
              VALUES (?, 'review_issue.recovered', ?, '省略证据已在下一科室日期前唯一展开，资料重新进入核对队列', ?)
            `).run(randomUUID(), issue.id, this.now().toISOString());
            this.resumeWaitingJobsAfterReview(documentId);
          }
        }
        this.db.exec(`
          UPDATE workspaces SET schema_version = 21;
          PRAGMA user_version = 21;
        `);
        current = 21;
      }

      if (current === 21) {
        const tables = new Set((this.db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as Array<{ name: string }>)
          .map((row) => row.name));
        const canRetryOneSidedReferenceRangeReview = [
          'documents', 'review_issues', 'audit_events', 'jobs', 'job_attempts'
        ].every((table) => tables.has(table));
        if (canRetryOneSidedReferenceRangeReview) {
          const issues = this.db.prepare(`
            SELECT id, field_ref, payload_json
            FROM review_issues
            WHERE kind = 'field_conflict' AND resolution_status = 'open'
            ORDER BY created_at, id
          `).all() as Array<{ id: string; field_ref: string; payload_json: string | null }>;
          for (const issue of issues) {
            let payload: { candidateOptions?: ObservationCandidate[]; candidateDiffs?: ReviewCandidateDiff[] } = {};
            try {
              payload = issue.payload_json ? JSON.parse(issue.payload_json) as typeof payload : {};
            } catch {
              continue;
            }
            const candidates = payload.candidateOptions ?? [];
            const differences = payload.candidateDiffs ?? [];
            const onlyMissingReviewedReferenceRanges = differences.length > 0 && differences.every((difference) => {
              if (difference.fields.length !== 1 || difference.fields[0] !== 'referenceRangeRaw') return false;
              const candidate = candidates.find((item) => item.localKey === difference.localKey);
              return Boolean(candidate
                && candidate.referenceRangeRaw === null
                && !candidate.issues.some((item) => item.code.startsWith('blocking_')));
            });
            if (!onlyMissingReviewedReferenceRanges) continue;
            const documentId = issue.field_ref.startsWith('document:') ? issue.field_ref.slice('document:'.length) : null;
            if (!documentId) continue;
            this.db.prepare(`
              UPDATE review_issues
              SET resolution_status = 'resolved', resolution_revision = 1
              WHERE id = ? AND resolution_status = 'open'
            `).run(issue.id);
            this.db.prepare(`UPDATE documents SET status = 'queued' WHERE id = ? AND status = 'needs_review'`).run(documentId);
            this.db.prepare(`
              INSERT INTO audit_events (id, event_type, entity_id, summary, created_at)
              VALUES (?, 'review_issue.recovered', ?, '单侧参考范围已保守留空，原始测量值重新进入核对队列', ?)
            `).run(randomUUID(), issue.id, this.now().toISOString());
            this.resumeWaitingJobsAfterReview(documentId);
          }
        }
        this.db.exec(`
          UPDATE workspaces SET schema_version = 22;
          PRAGMA user_version = 22;
        `);
        current = 22;
      }

      if (current === 22) {
        const tables = new Set((this.db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as Array<{ name: string }>)
          .map((row) => row.name));
        const canRetryDerivedSafetyReview = [
          'review_issues', 'audit_events', 'jobs'
        ].every((table) => tables.has(table));
        if (canRetryDerivedSafetyReview) {
          const issues = this.db.prepare(`
            SELECT id, field_ref
            FROM review_issues
            WHERE kind = 'derived_safety' AND resolution_status = 'open'
            ORDER BY created_at, id
          `).all() as Array<{ id: string; field_ref: string }>;
          for (const issue of issues) {
            const documentId = issue.field_ref.startsWith('document:') ? issue.field_ref.slice('document:'.length) : null;
            if (!documentId) continue;
            this.db.prepare(`
              UPDATE review_issues
              SET resolution_status = 'resolved', resolution_revision = 1
              WHERE id = ? AND resolution_status = 'open'
            `).run(issue.id);
            this.db.prepare(`
              UPDATE jobs
              SET status = 'queued', updated_at = ?
              WHERE status = 'waiting_user'
                AND stage IN ('analyze', 'guidance', 'review_derived', 'system_analysis', 'system_review', 'publish')
                AND EXISTS (
                  SELECT 1 FROM json_each(json_extract(jobs.checkpoint_json, '$.documentIds'))
                  WHERE value = ?
                )
            `).run(this.now().toISOString(), documentId);
            this.db.prepare(`
              INSERT INTO audit_events (id, event_type, entity_id, summary, created_at)
              VALUES (?, 'review_issue.recovered', ?, '否定式医学边界说明不再误判为诊断，派生分析重新进入安全核对队列', ?)
            `).run(randomUUID(), issue.id, this.now().toISOString());
          }
        }
        this.db.exec(`
          UPDATE workspaces SET schema_version = 23;
          PRAGMA user_version = 23;
        `);
        current = 23;
      }

      if (current === 23) {
        const tables = new Set((this.db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as Array<{ name: string }>)
          .map((row) => row.name));
        const canRecoverTrustedAssignmentReviews = [
          'documents', 'review_issues', 'audit_events', 'jobs'
        ].every((table) => tables.has(table));
        if (canRecoverTrustedAssignmentReviews) {
          const issues = this.db.prepare(`
            SELECT ri.id, d.id AS document_id
            FROM review_issues ri
            JOIN documents d ON ri.field_ref = 'document:' || d.id
            WHERE ri.kind = 'field_conflict'
              AND ri.resolution_status = 'open'
              AND ri.payload_json IS NULL
              AND d.status = 'needs_review'
              AND d.person_assignment_basis IN ('user_selected', 'folder_binding', 'identity_confirmed')
            ORDER BY ri.created_at, ri.id
          `).all() as Array<{ id: string; document_id: string }>;
          for (const issue of issues) {
            this.db.prepare(`
              UPDATE review_issues
              SET resolution_status = 'resolved', resolution_revision = 1,
                  payload_json = json_object('reasonCodes', json_array('TRUSTED_ASSIGNMENT_WITHOUT_VERIFIED_CONFLICT'))
              WHERE id = ? AND resolution_status = 'open'
            `).run(issue.id);
            this.db.prepare(`UPDATE documents SET status = 'queued' WHERE id = ? AND status = 'needs_review'`).run(issue.document_id);
            this.db.prepare(`
              INSERT INTO audit_events (id, event_type, entity_id, summary, created_at)
              VALUES (?, 'review_issue.recovered', ?, '报告未识别出可验证的不同姓名，沿用用户已确认的成员归属并继续处理', ?)
            `).run(randomUUID(), issue.id, this.now().toISOString());
            this.resumeWaitingJobsAfterReview(issue.document_id);
          }
        }
        this.db.exec(`
          UPDATE workspaces SET schema_version = 24;
          PRAGMA user_version = 24;
        `);
        current = 24;
      }

      if (current === 24) {
        const tables = new Set((this.db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as Array<{ name: string }>)
          .map((row) => row.name));
        const canRetryRepairableDerivedStructure = [
          'review_issues', 'audit_events', 'jobs'
        ].every((table) => tables.has(table));
        if (canRetryRepairableDerivedStructure) {
          const issues = this.db.prepare(`
            SELECT id, field_ref, payload_json
            FROM review_issues
            WHERE kind = 'derived_safety' AND resolution_status = 'open'
            ORDER BY created_at, id
          `).all() as Array<{ id: string; field_ref: string; payload_json: string | null }>;
          for (const issue of issues) {
            let reasonCodes: string[] = [];
            try {
              const payload = issue.payload_json ? JSON.parse(issue.payload_json) as { reasonCodes?: unknown } : {};
              reasonCodes = Array.isArray(payload.reasonCodes)
                ? payload.reasonCodes.filter((code): code is string => typeof code === 'string')
                : [];
            } catch {
              continue;
            }
            const repairable = reasonCodes.length > 0 && reasonCodes.every((code) => (
              code.startsWith('evidence_mismatch:') || code.startsWith('boundary_note_required:')
            ));
            if (!repairable) continue;
            const documentId = issue.field_ref.startsWith('document:') ? issue.field_ref.slice('document:'.length) : null;
            if (!documentId) continue;
            this.db.prepare(`
              UPDATE review_issues
              SET resolution_status = 'resolved', resolution_revision = 1
              WHERE id = ? AND resolution_status = 'open'
            `).run(issue.id);
            this.db.prepare(`
              UPDATE jobs
              SET status = 'queued', stage = 'analyze', lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
              WHERE status = 'waiting_user'
                AND stage IN ('analyze', 'guidance', 'review_derived', 'system_analysis', 'system_review', 'publish')
                AND EXISTS (
                  SELECT 1 FROM json_each(json_extract(jobs.checkpoint_json, '$.documentIds'))
                  WHERE value = ?
                )
            `).run(this.now().toISOString(), documentId);
            this.db.prepare(`
              INSERT INTO audit_events (id, event_type, entity_id, summary, created_at)
              VALUES (?, 'review_issue.recovered', ?, '派生说明的内部证据引用与边界备注改由自动修复并重新安全核对', ?)
            `).run(randomUUID(), issue.id, this.now().toISOString());
          }
        }
        this.db.exec(`
          UPDATE workspaces SET schema_version = 25;
          PRAGMA user_version = 25;
        `);
        current = 25;
      }

      if (current === 25) {
        const tables = new Set((this.db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as Array<{ name: string }>)
          .map((row) => row.name));
        const canRetryItemLevelDerivedRejection = [
          'review_issues', 'audit_events', 'jobs'
        ].every((table) => tables.has(table));
        if (canRetryItemLevelDerivedRejection) {
          const issues = this.db.prepare(`
            SELECT id, field_ref, payload_json
            FROM review_issues
            WHERE kind = 'derived_safety' AND resolution_status = 'open'
            ORDER BY created_at, id
          `).all() as Array<{ id: string; field_ref: string; payload_json: string | null }>;
          for (const issue of issues) {
            let reasonCodes: string[] = [];
            try {
              const payload = issue.payload_json ? JSON.parse(issue.payload_json) as { reasonCodes?: unknown } : {};
              reasonCodes = Array.isArray(payload.reasonCodes)
                ? payload.reasonCodes.filter((code): code is string => typeof code === 'string')
                : [];
            } catch {
              continue;
            }
            const itemLevelOnly = reasonCodes.length > 0 && reasonCodes.every((code) => (
              code.startsWith('claim_rejected:') || code.startsWith('guidance_rejected:')
            ));
            if (!itemLevelOnly) continue;
            const documentId = issue.field_ref.startsWith('document:') ? issue.field_ref.slice('document:'.length) : null;
            if (!documentId) continue;
            this.db.prepare(`
              UPDATE review_issues
              SET resolution_status = 'resolved', resolution_revision = 1
              WHERE id = ? AND resolution_status = 'open'
            `).run(issue.id);
            this.db.prepare(`
              UPDATE jobs
              SET status = 'queued', stage = 'analyze', lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
              WHERE status = 'waiting_user'
                AND stage IN ('analyze', 'guidance', 'review_derived', 'system_analysis', 'system_review', 'publish')
                AND EXISTS (
                  SELECT 1 FROM json_each(json_extract(jobs.checkpoint_json, '$.documentIds'))
                  WHERE value = ?
                )
            `).run(this.now().toISOString(), documentId);
            this.db.prepare(`
              INSERT INTO audit_events (id, event_type, entity_id, summary, created_at)
              VALUES (?, 'review_issue.recovered', ?, '独立复核拒绝的单条派生说明改为省略，其余安全内容重新进入发布流程', ?)
            `).run(randomUUID(), issue.id, this.now().toISOString());
          }
        }
        this.db.exec(`
          UPDATE workspaces SET schema_version = 26;
          PRAGMA user_version = 26;
        `);
        current = 26;
      }

      if (current === 26) {
        const tables = new Set((this.db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as Array<{ name: string }>)
          .map((row) => row.name));
        const canRecoverIncompleteComparison = [
          'documents', 'review_issues', 'audit_events', 'jobs'
        ].every((table) => tables.has(table));
        if (canRecoverIncompleteComparison) {
          const affectedDocumentIds = new Set<string>();
          const issues = this.db.prepare(`
            SELECT id, field_ref, kind, payload_json
            FROM review_issues
            WHERE resolution_status = 'open'
              AND kind IN ('field_conflict', 'coverage_gap')
            ORDER BY created_at, id
          `).all() as Array<{ id: string; field_ref: string; kind: string; payload_json: string | null }>;

          for (const issue of issues) {
            let payload: { reasonCodes?: unknown; candidateDiffs?: unknown } = {};
            try {
              payload = issue.payload_json ? JSON.parse(issue.payload_json) as typeof payload : {};
            } catch {
              continue;
            }
            const reasonCodes = Array.isArray(payload.reasonCodes)
              ? payload.reasonCodes.filter((code): code is string => typeof code === 'string')
              : [];
            const candidateDiffs = Array.isArray(payload.candidateDiffs)
              ? payload.candidateDiffs as Array<Record<string, unknown>>
              : [];
            const lacksBothReadings = candidateDiffs.length > 0 && candidateDiffs.some((difference) => (
              !Object.prototype.hasOwnProperty.call(difference, 'firstCandidate')
              || !Object.prototype.hasOwnProperty.call(difference, 'secondCandidate')
            ));
            const shouldRetry = issue.kind === 'coverage_gap'
              ? reasonCodes.includes('EXTRACTION_COVERAGE_INCOMPLETE') || reasonCodes.includes('REVIEW_COVERAGE_INCOMPLETE')
              : reasonCodes.includes('INDEPENDENT_REVIEW_MISMATCH') && lacksBothReadings;
            if (!shouldRetry) continue;
            const documentId = issue.field_ref.startsWith('document:')
              ? issue.field_ref.slice('document:'.length)
              : null;
            if (!documentId) continue;

            this.db.prepare(`
              UPDATE review_issues
              SET resolution_status = 'resolved', resolution_revision = 1
              WHERE id = ? AND resolution_status = 'open'
            `).run(issue.id);
            this.db.prepare(`UPDATE documents SET status = 'queued' WHERE id = ? AND status = 'needs_review'`).run(documentId);
            this.db.prepare(`
              INSERT INTO audit_events (id, event_type, entity_id, summary, created_at)
              VALUES (?, 'review_issue.recovered', ?, ?, ?)
            `).run(
              randomUUID(),
              issue.id,
              issue.kind === 'coverage_gap'
                ? '完整报告覆盖清单改由自动补救，资料重新进入整篇核对队列'
                : '两次读取结果改为完整保留并展示，资料重新进入独立核对队列',
              this.now().toISOString()
            );
            affectedDocumentIds.add(documentId);
          }

          if (affectedDocumentIds.size > 0) {
            const jobs = this.db.prepare(`
              SELECT id, checkpoint_json FROM jobs
              WHERE status = 'waiting_user' AND stage IN ('extract', 'review_facts')
            `).all() as Array<{ id: string; checkpoint_json: string | null }>;
            for (const job of jobs) {
              let checkpoint: ({ documentIds?: string[]; completedUnits?: number } & Record<string, unknown>) = {};
              try {
                checkpoint = job.checkpoint_json ? JSON.parse(job.checkpoint_json) as typeof checkpoint : {};
              } catch {
                continue;
              }
              if (!checkpoint.documentIds?.some((id) => affectedDocumentIds.has(id))) continue;
              this.db.prepare(`
                UPDATE jobs
                SET status = 'queued', stage = 'extract', lease_owner = NULL, lease_expires_at = NULL,
                    checkpoint_json = ?, updated_at = ?
                WHERE id = ?
              `).run(
                JSON.stringify({ ...checkpoint, completedUnits: 0 }),
                this.now().toISOString(),
                job.id
              );
            }
          }
        }
        this.db.exec(`
          UPDATE workspaces SET schema_version = 27;
          PRAGMA user_version = 27;
        `);
        current = 27;
      }

      if (current === 27) {
        const tables = new Set((this.db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as Array<{ name: string }>)
          .map((row) => row.name));
        const canRecoverIncompleteDocumentReview = [
          'review_issues', 'documents', 'document_commits', 'jobs', 'audit_events'
        ].every((table) => tables.has(table));
        const issues = canRecoverIncompleteDocumentReview
          ? this.db.prepare(`
              SELECT id, job_id, field_ref, payload_json
              FROM review_issues
              WHERE resolution_status = 'open' AND kind = 'field_conflict'
              ORDER BY created_at, id
            `).all() as Array<{ id: string; job_id: string | null; field_ref: string; payload_json: string | null }>
          : [];
        for (const issue of issues) {
          let payload: {
            documentRun?: {
              coverageComplete?: unknown;
              coveredSourceSpanIds?: unknown;
              manifestSpanIds?: unknown;
            };
          } = {};
          try {
            payload = issue.payload_json ? JSON.parse(issue.payload_json) as typeof payload : {};
          } catch {
            // 无法证明整篇覆盖的旧核对事项按未完成处理。
          }
          const run = payload.documentRun;
          const covered = Array.isArray(run?.coveredSourceSpanIds)
            ? run.coveredSourceSpanIds.filter((value): value is string => typeof value === 'string')
            : [];
          const manifest = Array.isArray(run?.manifestSpanIds)
            ? run.manifestSpanIds.filter((value): value is string => typeof value === 'string')
            : [];
          const hasCompleteRun = run?.coverageComplete === true
            && covered.length > 0
            && covered.length === manifest.length
            && new Set(covered).size === covered.length
            && new Set(manifest).size === manifest.length
            && manifest.every((spanId) => covered.includes(spanId));
          if (hasCompleteRun) continue;
          const documentId = issue.field_ref.startsWith('document:')
            ? issue.field_ref.slice('document:'.length)
            : null;
          if (!documentId) continue;
          this.db.prepare(`
            UPDATE review_issues SET resolution_status = 'resolved', resolution_revision = 1
            WHERE id = ? AND resolution_status = 'open'
          `).run(issue.id);
          this.db.prepare(`
            UPDATE documents SET status = 'queued'
            WHERE id = ? AND status = 'needs_review'
              AND NOT EXISTS (SELECT 1 FROM document_commits dc WHERE dc.document_id = documents.id)
              AND NOT EXISTS (
                SELECT 1 FROM review_issues ri
                WHERE ri.field_ref = 'document:' || documents.id
                  AND ri.resolution_status = 'open' AND ri.severity = 'blocking'
              )
          `).run(documentId);
          this.db.prepare(`
            INSERT INTO audit_events (id, event_type, entity_id, summary, created_at)
            VALUES (?, 'review_issue.recovered', ?, '旧核对事项无法证明整篇已读完，资料重新进入完整核对队列', ?)
          `).run(randomUUID(), issue.id, this.now().toISOString());

          const jobs = issue.job_id
            ? this.db.prepare(`SELECT id, checkpoint_json FROM jobs WHERE id = ? AND status = 'waiting_user'`).all(issue.job_id)
            : this.db.prepare(`SELECT id, checkpoint_json FROM jobs WHERE status = 'waiting_user'`).all();
          for (const job of jobs as Array<{ id: string; checkpoint_json: string | null }>) {
            let checkpoint: ({ documentIds?: string[]; consentId?: string | null } & Record<string, unknown>) = {};
            try {
              checkpoint = job.checkpoint_json ? JSON.parse(job.checkpoint_json) as typeof checkpoint : {};
            } catch {
              continue;
            }
            if (!issue.job_id && !checkpoint.documentIds?.includes(documentId)) continue;
            if (!checkpoint.consentId || !this.db.prepare(`
              SELECT 1 FROM consents WHERE id = ? AND revoked_at IS NULL
            `).get(checkpoint.consentId)) continue;
            const stillBlocked = issue.job_id
              ? Boolean(this.db.prepare(`
                  SELECT 1 FROM review_issues
                  WHERE job_id = ? AND resolution_status = 'open' AND severity = 'blocking'
                  LIMIT 1
                `).get(job.id))
              : checkpoint.documentIds?.some((id) => this.hasOpenBlockingReview(id));
            if (stillBlocked) continue;
            this.db.prepare(`
              UPDATE jobs
              SET status = 'queued', stage = 'extract', lease_owner = NULL, lease_expires_at = NULL,
                  checkpoint_json = ?, updated_at = ?
              WHERE id = ?
            `).run(JSON.stringify({ ...checkpoint, completedUnits: 0 }), this.now().toISOString(), job.id);
          }
        }
        this.db.exec(`
          UPDATE workspaces SET schema_version = 28;
          PRAGMA user_version = 28;
        `);
        current = 28;
      }

      if (current === 28) {
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS body_system_registry (
            id TEXT PRIMARY KEY, registry_version TEXT NOT NULL, name TEXT NOT NULL,
            short_name TEXT NOT NULL, description TEXT NOT NULL, display_order INTEGER NOT NULL,
            topics_json TEXT NOT NULL, updated_at TEXT NOT NULL
          ) STRICT;
          CREATE TABLE IF NOT EXISTS concept_definitions (
            id TEXT PRIMARY KEY, dictionary_version TEXT NOT NULL, canonical_name TEXT NOT NULL,
            specimen TEXT, method TEXT, body_site TEXT, compatible_units_json TEXT NOT NULL,
            system_links_json TEXT NOT NULL, topic_id TEXT, updated_at TEXT NOT NULL
          ) STRICT;
          CREATE TABLE IF NOT EXISTS concept_aliases (
            concept_id TEXT NOT NULL REFERENCES concept_definitions(id) ON DELETE CASCADE,
            alias TEXT NOT NULL, normalized_alias TEXT NOT NULL, dictionary_version TEXT NOT NULL,
            PRIMARY KEY(concept_id, normalized_alias)
          ) STRICT;
          CREATE INDEX IF NOT EXISTS idx_concept_alias_lookup ON concept_aliases(normalized_alias, dictionary_version);
          CREATE TABLE IF NOT EXISTS observation_concept_mappings (
            observation_id TEXT NOT NULL REFERENCES observations(id) ON DELETE CASCADE,
            observation_revision INTEGER NOT NULL, concept_id TEXT REFERENCES concept_definitions(id),
            normalized_name TEXT NOT NULL, status TEXT NOT NULL, confidence REAL NOT NULL,
            reasons_json TEXT NOT NULL, mapper_version TEXT NOT NULL, created_at TEXT NOT NULL,
            PRIMARY KEY(observation_id, observation_revision, mapper_version)
          ) STRICT;
          CREATE TABLE IF NOT EXISTS system_fact_links (
            observation_id TEXT NOT NULL REFERENCES observations(id) ON DELETE CASCADE,
            observation_revision INTEGER NOT NULL, system_id TEXT NOT NULL REFERENCES body_system_registry(id),
            relation TEXT NOT NULL CHECK(relation IN ('direct','context')),
            linker_version TEXT NOT NULL, created_at TEXT NOT NULL,
            PRIMARY KEY(observation_id, observation_revision, system_id, relation, linker_version)
          ) STRICT;
          CREATE INDEX IF NOT EXISTS idx_system_fact_links_system ON system_fact_links(system_id, observation_id);
          CREATE TABLE IF NOT EXISTS health_events_v2 (
            id TEXT PRIMARY KEY, person_id TEXT NOT NULL REFERENCES persons(id), type TEXT NOT NULL,
            title TEXT NOT NULL, clinical_date TEXT, end_date TEXT, date_precision TEXT NOT NULL,
            date_role TEXT NOT NULL, date_source TEXT NOT NULL, metadata_status TEXT NOT NULL,
            metadata_revision INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
          ) STRICT;
          CREATE INDEX IF NOT EXISTS idx_health_events_v2_person_date ON health_events_v2(person_id, clinical_date);
          CREATE TABLE IF NOT EXISTS report_records (
            id TEXT PRIMARY KEY, person_id TEXT NOT NULL REFERENCES persons(id), event_id TEXT REFERENCES health_events_v2(id),
            report_kind TEXT NOT NULL, title TEXT NOT NULL, organization TEXT, report_date TEXT,
            metadata_status TEXT NOT NULL, metadata_revision INTEGER NOT NULL, created_at TEXT NOT NULL
          ) STRICT;
          CREATE TABLE IF NOT EXISTS report_source_links (
            report_id TEXT NOT NULL REFERENCES report_records(id) ON DELETE CASCADE,
            document_id TEXT NOT NULL REFERENCES documents(id), relation TEXT NOT NULL,
            source_hash TEXT, created_at TEXT NOT NULL, PRIMARY KEY(report_id, document_id)
          ) STRICT;
          CREATE TABLE IF NOT EXISTS report_metadata_revisions (
            report_id TEXT NOT NULL REFERENCES report_records(id) ON DELETE CASCADE,
            revision INTEGER NOT NULL, payload_json TEXT NOT NULL, actor TEXT NOT NULL,
            evidence_refs_json TEXT NOT NULL, created_at TEXT NOT NULL,
            PRIMARY KEY(report_id, revision)
          ) STRICT;
          CREATE TABLE IF NOT EXISTS event_report_links (
            event_id TEXT NOT NULL REFERENCES health_events_v2(id) ON DELETE CASCADE,
            report_id TEXT NOT NULL REFERENCES report_records(id) ON DELETE CASCADE,
            PRIMARY KEY(event_id, report_id)
          ) STRICT;
          CREATE TABLE IF NOT EXISTS system_analysis_snapshots_v2 (
            id TEXT PRIMARY KEY, person_id TEXT NOT NULL REFERENCES persons(id),
            system_id TEXT NOT NULL REFERENCES body_system_registry(id), fact_revision INTEGER NOT NULL,
            context_revision INTEGER NOT NULL, prompt_version TEXT NOT NULL, rules_version TEXT NOT NULL,
            model_id TEXT NOT NULL, evidence_bundle_hash TEXT NOT NULL, coverage_json TEXT NOT NULL,
            payload_json TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL
          ) STRICT;
          CREATE INDEX IF NOT EXISTS idx_system_analysis_current ON system_analysis_snapshots_v2(person_id, system_id, status, created_at);
          CREATE TABLE IF NOT EXISTS knowledge_entries (
            id TEXT PRIMARY KEY, topic_key TEXT NOT NULL, locale TEXT NOT NULL,
            source_title TEXT NOT NULL, source_url TEXT, reviewed_at TEXT,
            payload_json TEXT NOT NULL, version TEXT NOT NULL, created_at TEXT NOT NULL
          ) STRICT;
          CREATE TABLE IF NOT EXISTS lifestyle_proposals_v2 (
            id TEXT PRIMARY KEY, person_id TEXT NOT NULL REFERENCES persons(id), category TEXT NOT NULL,
            title TEXT NOT NULL, detail TEXT NOT NULL, consult_professional INTEGER NOT NULL,
            evidence_refs_json TEXT NOT NULL, status TEXT NOT NULL, source_snapshot_id TEXT,
            version INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
          ) STRICT;
          CREATE INDEX IF NOT EXISTS idx_lifestyle_proposals_person ON lifestyle_proposals_v2(person_id, status, updated_at);
          CREATE TABLE IF NOT EXISTS action_adoptions_v2 (
            id TEXT PRIMARY KEY, person_id TEXT NOT NULL REFERENCES persons(id),
            proposal_id TEXT REFERENCES lifestyle_proposals_v2(id), title TEXT NOT NULL,
            status TEXT NOT NULL, due_date TEXT, user_revision INTEGER NOT NULL,
            created_at TEXT NOT NULL, updated_at TEXT NOT NULL
          ) STRICT;
          CREATE TABLE IF NOT EXISTS derivation_dependencies (
            derived_kind TEXT NOT NULL, derived_id TEXT NOT NULL, dependency_kind TEXT NOT NULL,
            dependency_id TEXT NOT NULL, dependency_revision TEXT NOT NULL,
            created_at TEXT NOT NULL,
            PRIMARY KEY(derived_kind, derived_id, dependency_kind, dependency_id)
          ) STRICT;
          UPDATE workspaces SET schema_version = 29;
          PRAGMA user_version = 29;
        `);
        current = 29;
      }

      if (current === 29) {
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS concept_mapping_corrections (
            id TEXT PRIMARY KEY,
            observation_id TEXT NOT NULL REFERENCES observations(id) ON DELETE CASCADE,
            observation_revision INTEGER NOT NULL,
            concept_id TEXT REFERENCES concept_definitions(id),
            normalized_name TEXT NOT NULL,
            status TEXT NOT NULL CHECK(status IN ('verified','proposed','unmapped')),
            confidence REAL NOT NULL,
            reasons_json TEXT NOT NULL,
            previous_concept_id TEXT REFERENCES concept_definitions(id),
            previous_normalized_name TEXT NOT NULL,
            previous_status TEXT NOT NULL CHECK(previous_status IN ('verified','proposed','unmapped')),
            previous_confidence REAL NOT NULL,
            previous_reasons_json TEXT NOT NULL,
            action TEXT NOT NULL CHECK(action IN ('set','undo')),
            reason TEXT NOT NULL,
            active INTEGER NOT NULL CHECK(active IN (0,1)),
            created_at TEXT NOT NULL
          ) STRICT;
          CREATE UNIQUE INDEX IF NOT EXISTS idx_concept_mapping_corrections_active
            ON concept_mapping_corrections(observation_id) WHERE active = 1;
          CREATE INDEX IF NOT EXISTS idx_concept_mapping_corrections_history
            ON concept_mapping_corrections(observation_id, created_at, id);
          UPDATE workspaces SET schema_version = 30;
          PRAGMA user_version = 30;
        `);
        current = 30;
      }

      if (current === 30) {
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS event_relation_changes (
            id TEXT PRIMARY KEY,
            person_id TEXT NOT NULL REFERENCES persons(id) ON DELETE CASCADE,
            action TEXT NOT NULL CHECK(action IN ('merge','split','undo')),
            from_event_id TEXT NOT NULL REFERENCES health_events_v2(id),
            to_event_id TEXT NOT NULL REFERENCES health_events_v2(id),
            report_ids_json TEXT NOT NULL,
            reason TEXT NOT NULL,
            active INTEGER NOT NULL CHECK(active IN (0,1)),
            parent_change_id TEXT REFERENCES event_relation_changes(id),
            created_at TEXT NOT NULL
          ) STRICT;
          CREATE INDEX IF NOT EXISTS idx_event_relation_changes_person
            ON event_relation_changes(person_id, created_at, id);
          UPDATE workspaces SET schema_version = 31;
          PRAGMA user_version = 31;
        `);
        current = 31;
      }

      if (current === 31) {
        const proposalColumns = this.db.pragma('table_info(lifestyle_proposals_v2)') as Array<{ name: string }>;
        if (!proposalColumns.some((column) => column.name === 'structure_json')) {
          this.db.exec(`
            ALTER TABLE lifestyle_proposals_v2
              ADD COLUMN structure_json TEXT NOT NULL DEFAULT '{}';
          `);
        }
        this.db.exec(`
          UPDATE workspaces SET schema_version = 32;
          PRAGMA user_version = 32;
        `);
        current = 32;
      }

      if (current === 32) {
        const adoptionColumns = this.db.pragma('table_info(action_adoptions_v2)') as Array<{ name: string }>;
        if (!adoptionColumns.some((column) => column.name === 'details_json')) {
          this.db.exec(`
            ALTER TABLE action_adoptions_v2
              ADD COLUMN details_json TEXT NOT NULL DEFAULT '{}';
          `);
        }
        this.db.exec(`
          UPDATE workspaces SET schema_version = 33;
          PRAGMA user_version = 33;
        `);
        current = 33;
      }

      if (current === 33) {
        const observationsTableExists = Boolean(this.db.prepare(`
          SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'observations'
        `).get());
        if (observationsTableExists) {
          const observationColumns = this.db.pragma('table_info(observations)') as Array<{ name: string }>;
          if (!observationColumns.some((column) => column.name === 'original_name')) {
            this.db.exec(`ALTER TABLE observations ADD COLUMN original_name TEXT`);
          }
          if (!observationColumns.some((column) => column.name === 'model_standard_name_candidate')) {
            this.db.exec(`ALTER TABLE observations ADD COLUMN model_standard_name_candidate TEXT`);
          }
        }
        this.db.exec(`
          UPDATE workspaces SET schema_version = 34;
          PRAGMA user_version = 34;
        `);
        current = 34;
      }

      if (current === 34) {
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS member_assessment_snapshots_v3 (
            id TEXT PRIMARY KEY, person_id TEXT NOT NULL REFERENCES persons(id),
            input_signature TEXT NOT NULL, fact_revision INTEGER NOT NULL,
            context_revision INTEGER NOT NULL, prompt_version TEXT NOT NULL,
            rules_version TEXT NOT NULL, model_id TEXT NOT NULL,
            reasoning_effort TEXT NOT NULL, validation_mode TEXT NOT NULL,
            payload_json TEXT NOT NULL, status TEXT NOT NULL,
            created_at TEXT NOT NULL
          ) STRICT;
          CREATE INDEX IF NOT EXISTS idx_member_assessment_current_v3
            ON member_assessment_snapshots_v3(person_id, status, created_at);
          UPDATE workspaces SET schema_version = 35;
          PRAGMA user_version = 35;
        `);
        current = 35;
      }

      if (current === 35) {
        const columns = this.db.pragma('table_info(observation_revisions)') as Array<{ name: string }>;
        if (columns.length > 0 && !columns.some((column) => column.name === 'clinical_context_json')) {
          this.db.exec('ALTER TABLE observation_revisions ADD COLUMN clinical_context_json TEXT');
        }
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS report_clinical_contexts (
            person_id TEXT NOT NULL REFERENCES persons(id) ON DELETE CASCADE,
            document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
            input_signature TEXT NOT NULL, payload_json TEXT NOT NULL, created_at TEXT NOT NULL,
            PRIMARY KEY(person_id, document_id, input_signature)
          ) STRICT;
          UPDATE workspaces SET schema_version = 36;
          PRAGMA user_version = 36;
        `);
        current = 36;
      }

      if (current === 36) {
        const columns = this.db.pragma('table_info(action_items)') as Array<{ name: string }>;
        if (columns.length > 0 && !columns.some((column) => column.name === 'user_schedule_text')) {
          this.db.exec('ALTER TABLE action_items ADD COLUMN user_schedule_text TEXT');
          // 只在首次新增字段时复制旧用户安排；以后清空时不能从旧字段复活。
          this.db.exec(`UPDATE action_items SET user_schedule_text = NULLIF(TRIM(due_text), '')
            WHERE origin = 'user_created'`);
          const adoptionColumns = this.db.pragma('table_info(action_adoptions_v2)') as Array<{ name: string }>;
          if (adoptionColumns.some((column) => column.name === 'details_json')) {
            this.db.exec(`UPDATE action_items SET user_schedule_text = (
              SELECT NULLIF(TRIM(json_extract(aa.details_json, '$.plannedTime')), '') FROM action_adoptions_v2 aa
              WHERE aa.id = action_items.id AND aa.person_id = action_items.person_id
                AND aa.proposal_id IS NOT NULL AND json_valid(aa.details_json)
                AND json_type(aa.details_json, '$.plannedTime') = 'text'
            ) WHERE origin = 'ai_proposed' AND EXISTS (
              SELECT 1 FROM action_adoptions_v2 aa WHERE aa.id = action_items.id
                AND aa.person_id = action_items.person_id AND aa.proposal_id IS NOT NULL
            )`);
          }
        }
        this.db.exec('UPDATE workspaces SET schema_version = 37; PRAGMA user_version = 37;');
        current = 37;
      }

      if (current === 37) {
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS person_name_aliases (
            id TEXT PRIMARY KEY, person_id TEXT NOT NULL REFERENCES persons(id),
            reported_name TEXT NOT NULL, normalized_name TEXT NOT NULL,
            source_document_id TEXT REFERENCES documents(id) ON DELETE SET NULL,
            confirmed_at TEXT NOT NULL, revoked_at TEXT
          ) STRICT;
          CREATE UNIQUE INDEX IF NOT EXISTS idx_person_name_alias_active ON person_name_aliases(normalized_name)
            WHERE revoked_at IS NULL;
          UPDATE workspaces SET schema_version = 38; PRAGMA user_version = 38;
        `);
        // 只迁移用户已有的明确姓名确认；模型候选和文件夹绑定不构成身份别名。
        const aliasColumns = this.db.pragma('table_info(person_name_aliases)') as Array<{ name: string }>;
        if (!['id', 'person_id', 'reported_name', 'normalized_name', 'source_document_id', 'confirmed_at', 'revoked_at']
          .every((column) => aliasColumns.some((item) => item.name === column))) {
          throw new Error('PERSON_NAME_ALIAS_SCHEMA_INVALID');
        }
        const hasDocuments = Boolean(this.db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'documents'`).get());
        const confirmations = (hasDocuments ? this.db.prepare(`SELECT id, person_id, confirmed_reported_name FROM documents
          WHERE person_assignment_basis = 'identity_confirmed' AND confirmed_reported_name IS NOT NULL
            AND person_id IS NOT NULL ORDER BY created_at, id`).all() : []) as Array<{
            id: string; person_id: string; confirmed_reported_name: string;
          }>;
        const owners = new Map<string, Set<string>>();
        for (const row of confirmations) {
          const name = normalizedPersonName(row.confirmed_reported_name);
          const set = owners.get(name) ?? new Set<string>();
          set.add(row.person_id);
          owners.set(name, set);
        }
        for (const row of confirmations) {
          const name = normalizedPersonName(row.confirmed_reported_name);
          if (!name || owners.get(name)?.size !== 1) continue;
          const displayConflict = this.listPersons().some((person) => person.id !== row.person_id
            && person.archivedAt === null && normalizedPersonName(person.displayName) === name);
          if (displayConflict) continue;
          this.db.prepare(`INSERT OR IGNORE INTO person_name_aliases
            (id, person_id, reported_name, normalized_name, source_document_id, confirmed_at, revoked_at)
            VALUES (?, ?, ?, ?, ?, ?, NULL)`).run(randomUUID(), row.person_id,
            row.confirmed_reported_name.trim(), name, row.id, this.now().toISOString());
        }
        current = 38;
      }

      if (current === 38) {
        this.db.exec(`CREATE TABLE IF NOT EXISTS source_manifest_spans (
          document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
          source_span_id TEXT NOT NULL REFERENCES source_spans(id) ON DELETE CASCADE,
          PRIMARY KEY(document_id, source_span_id)
        ) STRICT;`);
        const columns = this.db.pragma('table_info(source_manifest_spans)') as Array<{ name: string }>;
        if (!['document_id', 'source_span_id'].every((name) => columns.some((column) => column.name === name))) {
          throw new Error('SOURCE_MANIFEST_MEMBERSHIP_SCHEMA_INVALID');
        }
        const hasManifest = Boolean(this.db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='source_manifests'`).get());
        const hasSpans = Boolean(this.db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='source_spans'`).get());
        if (hasManifest && hasSpans) {
          const missing = this.db.prepare(`SELECT sm.document_id FROM source_manifests sm
            WHERE NOT EXISTS(SELECT 1 FROM source_manifest_spans current WHERE current.document_id=sm.document_id)`)
            .all() as Array<{ document_id: string }>;
          const backfill = this.db.prepare(`INSERT OR IGNORE INTO source_manifest_spans (document_id, source_span_id)
            SELECT document_id, id FROM source_spans WHERE document_id=?`);
          for (const row of missing) backfill.run(row.document_id);
        }
        this.db.exec('UPDATE workspaces SET schema_version = 39; PRAGMA user_version = 39;');
        current = 39;
      }

      if (current === 39) {
        const columns = this.db.pragma('table_info(observation_revisions)') as Array<{ name: string }>;
        if (columns.length > 0) {
          if (!columns.some((column) => column.name === 'source_binding_json')) {
            this.db.exec('ALTER TABLE observation_revisions ADD COLUMN source_binding_json TEXT');
          }
          if (!columns.some((column) => column.name === 'clinical_date')) {
            this.db.exec(`ALTER TABLE observation_revisions ADD COLUMN clinical_date TEXT;
              UPDATE observation_revisions SET clinical_date=(SELECT e.clinical_date
                FROM observations o LEFT JOIN encounters e ON e.id=o.encounter_id
                WHERE o.id=observation_revisions.observation_id);`);
          }
          if (!columns.some((column) => column.name === 'date_evidence_json')) {
            this.db.exec("ALTER TABLE observation_revisions ADD COLUMN date_evidence_json TEXT NOT NULL DEFAULT '[]'");
          }
        }
        this.db.exec('UPDATE workspaces SET schema_version = 40; PRAGMA user_version = 40;');
        current = 40;
      }

      if (current === 40) {
        const columns = this.db.pragma('table_info(source_spans)') as Array<{ name: string }>;
        if (columns.length > 0 && !columns.some((column) => column.name === 'visual_evidence_json')) {
          this.db.exec('ALTER TABLE source_spans ADD COLUMN visual_evidence_json TEXT');
        }
        this.db.exec(`CREATE TABLE IF NOT EXISTS extraction_repair_diagnostics (
          id TEXT PRIMARY KEY, document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
          job_id TEXT REFERENCES jobs(id) ON DELETE SET NULL,
          attempt_id TEXT REFERENCES job_attempts(id) ON DELETE SET NULL,
          chunk_index INTEGER NOT NULL CHECK(chunk_index>=0), outcome TEXT NOT NULL,
          payload_json TEXT NOT NULL, created_at TEXT NOT NULL
        ) STRICT;
        UPDATE workspaces SET schema_version=41; PRAGMA user_version=41;`);
        current = 41;
      }

      if (current === 41) {
        const columns = this.db.pragma('table_info(source_spans)') as Array<{ name: string }>;
        if (columns.length > 0 && !columns.some((column) => column.name === 'model_evidence_json')) {
          this.db.exec('ALTER TABLE source_spans ADD COLUMN model_evidence_json TEXT');
        }
        this.db.exec('UPDATE workspaces SET schema_version=42; PRAGMA user_version=42;');
        current = 42;
      }

      if (current === 42) {
        this.db.exec(`CREATE TABLE IF NOT EXISTS ai_transmission_receipts (
          transmission_id TEXT PRIMARY KEY REFERENCES ai_transmissions(id) ON DELETE CASCADE,
          proof_version TEXT NOT NULL, input_signature TEXT NOT NULL, thread_id TEXT NOT NULL,
          turn_id TEXT NOT NULL, output_hash TEXT NOT NULL, created_at TEXT NOT NULL
        ) STRICT;
        UPDATE workspaces SET schema_version=43; PRAGMA user_version=43;`);
        current = 43;
      }

      if (current === 43) {
        this.db.exec(AUTOMATIC_UPLOAD_INTENTS_SQL);
        this.db.exec('UPDATE workspaces SET schema_version=44; PRAGMA user_version=44;');
        current = 44;
      }

      if (current === 0) this.db.exec(`
      CREATE TABLE IF NOT EXISTS workspaces (
        id TEXT PRIMARY KEY, schema_version INTEGER NOT NULL, created_at TEXT NOT NULL,
        settings_revision INTEGER NOT NULL DEFAULT 0,
        queue_paused INTEGER NOT NULL DEFAULT 0 CHECK(queue_paused IN (0,1))
      ) STRICT;
      CREATE TABLE IF NOT EXISTS persons (
        id TEXT PRIMARY KEY, display_name TEXT NOT NULL, relation TEXT, birth_year INTEGER,
        gender_context TEXT, display_revision INTEGER NOT NULL,
        clinical_context_revision INTEGER NOT NULL, archived_at TEXT, created_at TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS person_context_revisions (
        person_id TEXT NOT NULL REFERENCES persons(id), revision INTEGER NOT NULL,
        payload_json TEXT NOT NULL, source_kind TEXT NOT NULL, changed_at TEXT NOT NULL,
        PRIMARY KEY(person_id, revision)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS person_revisions (
        person_id TEXT PRIMARY KEY REFERENCES persons(id), fact_revision INTEGER NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS person_name_aliases (
        id TEXT PRIMARY KEY, person_id TEXT NOT NULL REFERENCES persons(id),
        reported_name TEXT NOT NULL, normalized_name TEXT NOT NULL,
        source_document_id TEXT REFERENCES documents(id) ON DELETE SET NULL,
        confirmed_at TEXT NOT NULL, revoked_at TEXT
      ) STRICT;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_person_name_alias_active ON person_name_aliases(normalized_name)
        WHERE revoked_at IS NULL;
      CREATE TABLE IF NOT EXISTS consents (
        id TEXT PRIMARY KEY, scope_json TEXT NOT NULL, recipient TEXT NOT NULL,
        purpose TEXT NOT NULL, account_fingerprint TEXT, version INTEGER NOT NULL,
        granted_at TEXT NOT NULL, revoked_at TEXT
      ) STRICT;
      CREATE TABLE IF NOT EXISTS inbox_bindings (
        id TEXT PRIMARY KEY, canonical_path TEXT NOT NULL UNIQUE, person_id TEXT REFERENCES persons(id),
        recursive INTEGER NOT NULL CHECK(recursive IN (0,1)), consent_id TEXT REFERENCES consents(id),
        enabled INTEGER NOT NULL CHECK(enabled IN (0,1)), created_at TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS source_objects (
        id TEXT PRIMARY KEY, sha256 TEXT NOT NULL UNIQUE, media_type TEXT NOT NULL,
        size INTEGER NOT NULL CHECK(size >= 0), vault_relative_path TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS source_occurrences (
        id TEXT PRIMARY KEY, source_object_id TEXT NOT NULL REFERENCES source_objects(id),
        binding_id TEXT REFERENCES inbox_bindings(id), original_path TEXT NOT NULL,
        display_name TEXT NOT NULL, first_seen TEXT NOT NULL, last_seen TEXT NOT NULL,
        UNIQUE(source_object_id, original_path)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS documents (
        id TEXT PRIMARY KEY, source_object_id TEXT NOT NULL REFERENCES source_objects(id),
        person_id TEXT REFERENCES persons(id), document_kind TEXT NOT NULL, status TEXT NOT NULL,
        acceptance_id TEXT, excluded_from_analysis INTEGER NOT NULL DEFAULT 0,
        person_assignment_basis TEXT NOT NULL DEFAULT 'legacy',
        confirmed_reported_name TEXT,
        created_at TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS source_spans (
        id TEXT PRIMARY KEY, document_id TEXT NOT NULL REFERENCES documents(id), span_kind TEXT NOT NULL,
        page_number INTEGER, block_id TEXT, line_start INTEGER, line_end INTEGER,
        quote TEXT, readability TEXT NOT NULL, normalizer_version TEXT NOT NULL, visual_evidence_json TEXT,
        model_evidence_json TEXT
      ) STRICT;
      CREATE TABLE IF NOT EXISTS source_manifests (
        document_id TEXT PRIMARY KEY REFERENCES documents(id) ON DELETE CASCADE,
        manifest_id TEXT NOT NULL, source_object_id TEXT NOT NULL REFERENCES source_objects(id),
        sha256 TEXT NOT NULL, media_type TEXT NOT NULL, original_display_name TEXT NOT NULL,
        total_units INTEGER NOT NULL, covered_unit_indexes_json TEXT NOT NULL,
        normalizer_version TEXT NOT NULL, conversion_warnings_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS source_manifest_spans (
        document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
        source_span_id TEXT NOT NULL REFERENCES source_spans(id) ON DELETE CASCADE,
        PRIMARY KEY(document_id, source_span_id)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS document_conversions (
        document_id TEXT PRIMARY KEY REFERENCES documents(id) ON DELETE CASCADE,
        converted_source_object_id TEXT NOT NULL REFERENCES source_objects(id),
        converter_id TEXT NOT NULL,
        converter_version TEXT NOT NULL,
        executable_sha256 TEXT NOT NULL,
        warnings_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS encounters (
        id TEXT PRIMARY KEY, person_id TEXT NOT NULL REFERENCES persons(id), clinical_date TEXT,
        date_precision TEXT NOT NULL, type TEXT NOT NULL, source_text TEXT, version INTEGER NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS encounter_documents (
        encounter_id TEXT NOT NULL REFERENCES encounters(id), document_id TEXT NOT NULL REFERENCES documents(id),
        PRIMARY KEY(encounter_id, document_id)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS acceptance_decisions (
        id TEXT PRIMARY KEY, method TEXT NOT NULL, actor TEXT NOT NULL, rules_version TEXT NOT NULL,
        input_signature TEXT NOT NULL, output_hash TEXT NOT NULL, review_ref TEXT,
        decision TEXT NOT NULL, decided_at TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS observations (
        id TEXT PRIMARY KEY, person_id TEXT NOT NULL REFERENCES persons(id),
        encounter_id TEXT REFERENCES encounters(id), concept_key TEXT NOT NULL,
        original_name TEXT, model_standard_name_candidate TEXT,
        current_revision INTEGER NOT NULL, created_at TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS observation_revisions (
        observation_id TEXT NOT NULL REFERENCES observations(id), revision INTEGER NOT NULL,
        value_kind TEXT NOT NULL, raw_text TEXT NOT NULL, decimal_value TEXT, qualifier TEXT,
        unit TEXT, reference_range TEXT, abnormal_flag TEXT NOT NULL DEFAULT 'unknown', source_span_id TEXT NOT NULL,
        acceptance_id TEXT NOT NULL, specimen TEXT, method TEXT, body_site TEXT,
        evidence_json TEXT NOT NULL DEFAULT '[]', clinical_context_json TEXT, source_binding_json TEXT,
        clinical_date TEXT, date_evidence_json TEXT NOT NULL DEFAULT '[]', supersedes INTEGER, created_at TEXT NOT NULL,
        PRIMARY KEY(observation_id, revision)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS clinical_statements (
        id TEXT PRIMARY KEY, person_id TEXT NOT NULL REFERENCES persons(id), document_id TEXT REFERENCES documents(id),
        statement_kind TEXT NOT NULL, text TEXT NOT NULL, reported_status TEXT,
        source_span_id TEXT, source_kind TEXT NOT NULL, created_at TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS user_notes (
        id TEXT PRIMARY KEY, person_id TEXT NOT NULL REFERENCES persons(id), recorded_at TEXT NOT NULL,
        effective_date TEXT, immutable_text TEXT NOT NULL, structured_fields_json TEXT NOT NULL,
        revision INTEGER NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS derived_snapshots (
        id TEXT PRIMARY KEY, person_id TEXT NOT NULL REFERENCES persons(id), fact_revision INTEGER NOT NULL,
        context_revision INTEGER NOT NULL, prompt_version TEXT NOT NULL, rules_version TEXT NOT NULL,
        model_id TEXT NOT NULL, coverage_json TEXT NOT NULL, payload_json TEXT NOT NULL,
        status TEXT NOT NULL, created_at TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS member_assessment_snapshots_v3 (
        id TEXT PRIMARY KEY, person_id TEXT NOT NULL REFERENCES persons(id),
        input_signature TEXT NOT NULL, fact_revision INTEGER NOT NULL,
        context_revision INTEGER NOT NULL, prompt_version TEXT NOT NULL,
        rules_version TEXT NOT NULL, model_id TEXT NOT NULL,
        reasoning_effort TEXT NOT NULL, validation_mode TEXT NOT NULL,
        payload_json TEXT NOT NULL, status TEXT NOT NULL,
        created_at TEXT NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS idx_member_assessment_current_v3
        ON member_assessment_snapshots_v3(person_id, status, created_at);
      CREATE TABLE IF NOT EXISTS snapshot_evidence (
        snapshot_id TEXT NOT NULL REFERENCES derived_snapshots(id), claim_id TEXT NOT NULL,
        observation_revision_id TEXT, source_span_id TEXT,
        PRIMARY KEY(snapshot_id, claim_id)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS action_items (
        id TEXT PRIMARY KEY, person_id TEXT NOT NULL REFERENCES persons(id), origin TEXT NOT NULL,
        source_ref TEXT, status TEXT NOT NULL, title TEXT NOT NULL, detail TEXT NOT NULL,
        due_date TEXT, due_text TEXT, user_schedule_text TEXT, user_revision INTEGER NOT NULL, updated_at TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS action_events (
        id TEXT PRIMARY KEY, action_id TEXT NOT NULL REFERENCES action_items(id), actor TEXT NOT NULL,
        previous_status TEXT, next_status TEXT NOT NULL, note TEXT, created_at TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS batches (
        id TEXT PRIMARY KEY, trigger TEXT NOT NULL, slot_key TEXT UNIQUE, cutoff TEXT NOT NULL,
        status TEXT NOT NULL, created_at TEXT NOT NULL, finished_at TEXT
      ) STRICT;
      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY, batch_id TEXT REFERENCES batches(id), person_id TEXT REFERENCES persons(id),
        stage TEXT NOT NULL, input_signature TEXT NOT NULL, status TEXT NOT NULL,
        lease_owner TEXT, lease_expires_at TEXT, attempt_count INTEGER NOT NULL DEFAULT 0,
        idempotency_key TEXT NOT NULL UNIQUE, checkpoint_json TEXT, created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS job_attempts (
        id TEXT PRIMARY KEY, job_id TEXT NOT NULL REFERENCES jobs(id), runtime_version TEXT,
        model TEXT, reasoning_effort TEXT, thread_id TEXT, turn_id TEXT, status TEXT NOT NULL, error_code TEXT,
        usage_json TEXT, started_at TEXT NOT NULL, finished_at TEXT
      ) STRICT;
      CREATE TABLE IF NOT EXISTS extraction_repair_diagnostics (
        id TEXT PRIMARY KEY, document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
        job_id TEXT REFERENCES jobs(id) ON DELETE SET NULL,
        attempt_id TEXT REFERENCES job_attempts(id) ON DELETE SET NULL,
        chunk_index INTEGER NOT NULL CHECK(chunk_index>=0), outcome TEXT NOT NULL,
        payload_json TEXT NOT NULL, created_at TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS review_issues (
        id TEXT PRIMARY KEY, job_id TEXT REFERENCES jobs(id), field_ref TEXT, kind TEXT NOT NULL,
        severity TEXT NOT NULL, evidence_refs_json TEXT NOT NULL, resolution_status TEXT NOT NULL,
        resolution_revision INTEGER, payload_json TEXT, created_at TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS publication_events (
        id TEXT PRIMARY KEY, person_id TEXT NOT NULL REFERENCES persons(id),
        expected_revision INTEGER NOT NULL, new_revision INTEGER NOT NULL,
        change_set_hash TEXT NOT NULL UNIQUE, summary TEXT NOT NULL, committed_at TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS document_commits (
        document_id TEXT PRIMARY KEY REFERENCES documents(id) ON DELETE CASCADE,
        commit_key TEXT NOT NULL UNIQUE, publication_id TEXT NOT NULL REFERENCES publication_events(id),
        revision INTEGER NOT NULL, committed_at TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS ai_transmissions (
        id TEXT PRIMARY KEY, job_id TEXT NOT NULL REFERENCES jobs(id),
        attempt_id TEXT NOT NULL REFERENCES job_attempts(id), consent_id TEXT NOT NULL REFERENCES consents(id),
        document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
        stage TEXT NOT NULL, status TEXT NOT NULL, started_at TEXT NOT NULL, finished_at TEXT
      ) STRICT;
      CREATE TABLE IF NOT EXISTS schedules (
        id TEXT PRIMARY KEY, enabled INTEGER NOT NULL, local_time TEXT NOT NULL,
        zone_history_json TEXT NOT NULL, last_slot TEXT, next_run_utc TEXT,
        paused INTEGER NOT NULL DEFAULT 0, revision INTEGER NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS exclusions (
        id TEXT PRIMARY KEY, source_hash TEXT, binding_id TEXT, document_id TEXT,
        reason TEXT NOT NULL, created_at TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS deleted_document_tombstones (
        source_hash TEXT PRIMARY KEY,
        display_name TEXT NOT NULL,
        person_id TEXT,
        media_type TEXT NOT NULL,
        deleted_at TEXT NOT NULL,
        raw_object_retained INTEGER NOT NULL CHECK(raw_object_retained IN (0,1))
      ) STRICT;
      CREATE TABLE IF NOT EXISTS notifications (
        id TEXT PRIMARY KEY, event_type TEXT NOT NULL, status TEXT NOT NULL,
        created_at TEXT NOT NULL, read_at TEXT
      ) STRICT;
      CREATE TABLE IF NOT EXISTS audit_events (
        id TEXT PRIMARY KEY, event_type TEXT NOT NULL, entity_id TEXT,
        summary TEXT NOT NULL, created_at TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS backup_manifests (
        id TEXT PRIMARY KEY, workspace_revision INTEGER NOT NULL, object_manifest_hash TEXT NOT NULL,
        format_version INTEGER NOT NULL, encryption_version TEXT, status TEXT NOT NULL,
        created_at TEXT NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS idx_documents_person ON documents(person_id, status);
      CREATE INDEX IF NOT EXISTS idx_observations_person ON observations(person_id, concept_key);
      CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status, created_at);
      CREATE INDEX IF NOT EXISTS idx_actions_person_status ON action_items(person_id, status);
      CREATE INDEX IF NOT EXISTS idx_ai_transmissions_document ON ai_transmissions(document_id, started_at);
      CREATE TABLE IF NOT EXISTS body_system_registry (
        id TEXT PRIMARY KEY, registry_version TEXT NOT NULL, name TEXT NOT NULL,
        short_name TEXT NOT NULL, description TEXT NOT NULL, display_order INTEGER NOT NULL,
        topics_json TEXT NOT NULL, updated_at TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS concept_definitions (
        id TEXT PRIMARY KEY, dictionary_version TEXT NOT NULL, canonical_name TEXT NOT NULL,
        specimen TEXT, method TEXT, body_site TEXT, compatible_units_json TEXT NOT NULL,
        system_links_json TEXT NOT NULL, topic_id TEXT, updated_at TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS concept_aliases (
        concept_id TEXT NOT NULL REFERENCES concept_definitions(id) ON DELETE CASCADE,
        alias TEXT NOT NULL, normalized_alias TEXT NOT NULL, dictionary_version TEXT NOT NULL,
        PRIMARY KEY(concept_id, normalized_alias)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS idx_concept_alias_lookup ON concept_aliases(normalized_alias, dictionary_version);
      CREATE TABLE IF NOT EXISTS observation_concept_mappings (
        observation_id TEXT NOT NULL REFERENCES observations(id) ON DELETE CASCADE,
        observation_revision INTEGER NOT NULL, concept_id TEXT REFERENCES concept_definitions(id),
        normalized_name TEXT NOT NULL, status TEXT NOT NULL, confidence REAL NOT NULL,
        reasons_json TEXT NOT NULL, mapper_version TEXT NOT NULL, created_at TEXT NOT NULL,
        PRIMARY KEY(observation_id, observation_revision, mapper_version)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS system_fact_links (
        observation_id TEXT NOT NULL REFERENCES observations(id) ON DELETE CASCADE,
        observation_revision INTEGER NOT NULL, system_id TEXT NOT NULL REFERENCES body_system_registry(id),
        relation TEXT NOT NULL CHECK(relation IN ('direct','context')),
        linker_version TEXT NOT NULL, created_at TEXT NOT NULL,
        PRIMARY KEY(observation_id, observation_revision, system_id, relation, linker_version)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS idx_system_fact_links_system ON system_fact_links(system_id, observation_id);
      CREATE TABLE IF NOT EXISTS health_events_v2 (
        id TEXT PRIMARY KEY, person_id TEXT NOT NULL REFERENCES persons(id), type TEXT NOT NULL,
        title TEXT NOT NULL, clinical_date TEXT, end_date TEXT, date_precision TEXT NOT NULL,
        date_role TEXT NOT NULL, date_source TEXT NOT NULL, metadata_status TEXT NOT NULL,
        metadata_revision INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS idx_health_events_v2_person_date ON health_events_v2(person_id, clinical_date);
      CREATE TABLE IF NOT EXISTS report_records (
        id TEXT PRIMARY KEY, person_id TEXT NOT NULL REFERENCES persons(id), event_id TEXT REFERENCES health_events_v2(id),
        report_kind TEXT NOT NULL, title TEXT NOT NULL, organization TEXT, report_date TEXT,
        metadata_status TEXT NOT NULL, metadata_revision INTEGER NOT NULL, created_at TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS report_source_links (
        report_id TEXT NOT NULL REFERENCES report_records(id) ON DELETE CASCADE,
        document_id TEXT NOT NULL REFERENCES documents(id), relation TEXT NOT NULL,
        source_hash TEXT, created_at TEXT NOT NULL, PRIMARY KEY(report_id, document_id)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS report_metadata_revisions (
        report_id TEXT NOT NULL REFERENCES report_records(id) ON DELETE CASCADE,
        revision INTEGER NOT NULL, payload_json TEXT NOT NULL, actor TEXT NOT NULL,
        evidence_refs_json TEXT NOT NULL, created_at TEXT NOT NULL,
        PRIMARY KEY(report_id, revision)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS event_report_links (
        event_id TEXT NOT NULL REFERENCES health_events_v2(id) ON DELETE CASCADE,
        report_id TEXT NOT NULL REFERENCES report_records(id) ON DELETE CASCADE,
        PRIMARY KEY(event_id, report_id)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS event_relation_changes (
        id TEXT PRIMARY KEY,
        person_id TEXT NOT NULL REFERENCES persons(id) ON DELETE CASCADE,
        action TEXT NOT NULL CHECK(action IN ('merge','split','undo')),
        from_event_id TEXT NOT NULL REFERENCES health_events_v2(id),
        to_event_id TEXT NOT NULL REFERENCES health_events_v2(id),
        report_ids_json TEXT NOT NULL,
        reason TEXT NOT NULL,
        active INTEGER NOT NULL CHECK(active IN (0,1)),
        parent_change_id TEXT REFERENCES event_relation_changes(id),
        created_at TEXT NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS idx_event_relation_changes_person
        ON event_relation_changes(person_id, created_at, id);
      CREATE TABLE IF NOT EXISTS system_analysis_snapshots_v2 (
        id TEXT PRIMARY KEY, person_id TEXT NOT NULL REFERENCES persons(id),
        system_id TEXT NOT NULL REFERENCES body_system_registry(id), fact_revision INTEGER NOT NULL,
        context_revision INTEGER NOT NULL, prompt_version TEXT NOT NULL, rules_version TEXT NOT NULL,
        model_id TEXT NOT NULL, evidence_bundle_hash TEXT NOT NULL, coverage_json TEXT NOT NULL,
        payload_json TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS idx_system_analysis_current ON system_analysis_snapshots_v2(person_id, system_id, status, created_at);
      CREATE TABLE IF NOT EXISTS knowledge_entries (
        id TEXT PRIMARY KEY, topic_key TEXT NOT NULL, locale TEXT NOT NULL,
        source_title TEXT NOT NULL, source_url TEXT, reviewed_at TEXT,
        payload_json TEXT NOT NULL, version TEXT NOT NULL, created_at TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS lifestyle_proposals_v2 (
        id TEXT PRIMARY KEY, person_id TEXT NOT NULL REFERENCES persons(id), category TEXT NOT NULL,
        title TEXT NOT NULL, detail TEXT NOT NULL, consult_professional INTEGER NOT NULL,
        evidence_refs_json TEXT NOT NULL, structure_json TEXT NOT NULL DEFAULT '{}',
        status TEXT NOT NULL, source_snapshot_id TEXT,
        version INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS idx_lifestyle_proposals_person ON lifestyle_proposals_v2(person_id, status, updated_at);
      CREATE TABLE IF NOT EXISTS action_adoptions_v2 (
        id TEXT PRIMARY KEY, person_id TEXT NOT NULL REFERENCES persons(id),
        proposal_id TEXT REFERENCES lifestyle_proposals_v2(id), title TEXT NOT NULL,
        details_json TEXT NOT NULL DEFAULT '{}', status TEXT NOT NULL,
        due_date TEXT, user_revision INTEGER NOT NULL,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS derivation_dependencies (
        derived_kind TEXT NOT NULL, derived_id TEXT NOT NULL, dependency_kind TEXT NOT NULL,
        dependency_id TEXT NOT NULL, dependency_revision TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY(derived_kind, derived_id, dependency_kind, dependency_id)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS concept_mapping_corrections (
        id TEXT PRIMARY KEY,
        observation_id TEXT NOT NULL REFERENCES observations(id) ON DELETE CASCADE,
        observation_revision INTEGER NOT NULL,
        concept_id TEXT REFERENCES concept_definitions(id),
        normalized_name TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('verified','proposed','unmapped')),
        confidence REAL NOT NULL,
        reasons_json TEXT NOT NULL,
        previous_concept_id TEXT REFERENCES concept_definitions(id),
        previous_normalized_name TEXT NOT NULL,
        previous_status TEXT NOT NULL CHECK(previous_status IN ('verified','proposed','unmapped')),
        previous_confidence REAL NOT NULL,
        previous_reasons_json TEXT NOT NULL,
        action TEXT NOT NULL CHECK(action IN ('set','undo')),
        reason TEXT NOT NULL,
        active INTEGER NOT NULL CHECK(active IN (0,1)),
        created_at TEXT NOT NULL
      ) STRICT;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_concept_mapping_corrections_active
        ON concept_mapping_corrections(observation_id) WHERE active = 1;
      CREATE INDEX IF NOT EXISTS idx_concept_mapping_corrections_history
        ON concept_mapping_corrections(observation_id, created_at, id);
      CREATE TABLE IF NOT EXISTS report_clinical_contexts (
        person_id TEXT NOT NULL REFERENCES persons(id) ON DELETE CASCADE,
        document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
        input_signature TEXT NOT NULL, payload_json TEXT NOT NULL, created_at TEXT NOT NULL,
        PRIMARY KEY(person_id, document_id, input_signature)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS ai_transmission_receipts (
        transmission_id TEXT PRIMARY KEY REFERENCES ai_transmissions(id) ON DELETE CASCADE,
        proof_version TEXT NOT NULL, input_signature TEXT NOT NULL, thread_id TEXT NOT NULL,
        turn_id TEXT NOT NULL, output_hash TEXT NOT NULL, created_at TEXT NOT NULL
      ) STRICT;
      PRAGMA user_version = 44;
      `);

      if (current === 0) this.db.exec(AUTOMATIC_UPLOAD_INTENTS_SQL);

      this.seedMemberModelV2();

      if (upgradingExistingWorkspace) this.failureInjector?.('during_schema_migration');
      this.db.exec('COMMIT');
    } catch (error) {
      if (this.db.inTransaction) this.db.exec('ROLLBACK');
      throw error;
    }
  }

  private seedMemberModelV2(): void {
    const updatedAt = this.now().toISOString();
    const insertSystem = this.db.prepare(`
      INSERT INTO body_system_registry (
        id, registry_version, name, short_name, description, display_order, topics_json, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        registry_version = excluded.registry_version,
        name = excluded.name,
        short_name = excluded.short_name,
        description = excluded.description,
        display_order = excluded.display_order,
        topics_json = excluded.topics_json,
        updated_at = excluded.updated_at
    `);
    for (const system of bodySystemRegistry) {
      insertSystem.run(system.id, system.version, system.name, system.shortName, system.description, system.order, JSON.stringify(system.topics), updatedAt);
    }

    const insertDefinition = this.db.prepare(`
      INSERT INTO concept_definitions (
        id, dictionary_version, canonical_name, specimen, method, body_site,
        compatible_units_json, system_links_json, topic_id, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        dictionary_version = excluded.dictionary_version,
        canonical_name = excluded.canonical_name,
        specimen = excluded.specimen,
        method = excluded.method,
        body_site = excluded.body_site,
        compatible_units_json = excluded.compatible_units_json,
        system_links_json = excluded.system_links_json,
        topic_id = excluded.topic_id,
        updated_at = excluded.updated_at
    `);
    const insertAlias = this.db.prepare(`
      INSERT INTO concept_aliases (concept_id, alias, normalized_alias, dictionary_version)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(concept_id, normalized_alias) DO UPDATE SET
        alias = excluded.alias,
        dictionary_version = excluded.dictionary_version
    `);
    for (const definition of conceptDictionary) {
      insertDefinition.run(
        definition.id,
        definition.version,
        definition.canonicalName,
        definition.specimen,
        definition.method,
        definition.bodySite,
        JSON.stringify(definition.compatibleUnits),
        JSON.stringify(definition.systemLinks),
        definition.topicId,
        updatedAt
      );
      for (const alias of definition.aliases) {
        const normalized = alias.normalize('NFKC').toLocaleLowerCase('zh-CN').replace(/[\s_()（）\-—–]/g, '');
        insertAlias.run(definition.id, alias, normalized, definition.version);
      }
    }
  }
}
