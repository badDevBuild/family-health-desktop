import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import Database from 'better-sqlite3';
import { memberAssessmentSnapshotV3Schema } from '@contracts';
import type {
  ActionItem,
  AdoptMemberAssessmentActionInput,
  ConceptMapping,
  ConceptMappingReceipt,
  CreateManualNoteInput,
  DerivedSnapshotCandidate,
  ManualNote,
  MemberAssessmentSnapshotV3,
  HealthEventRelationReceipt,
  MergeHealthEventsInput,
  ObservationCandidate,
  Person,
  ReportMetadataCandidate,
  ReportMetadataCorrectionReceipt,
  ReviewCandidateDiff,
  SourceManifest,
  SplitHealthEventInput,
  SystemAnalysisSnapshot,
  SystemEvidenceBundle,
  UndoReportMetadataInput,
  UndoHealthEventRelationInput,
  UpdateReportMetadataInput
} from '@contracts';
import { BODY_SYSTEM_REGISTRY_VERSION, CONCEPT_DICTIONARY_VERSION, MEMBER_MODEL_VERSION, bodySystemRegistry, conceptDictionary, linkConceptToSystems, mapConcept, sameAdoptedActionScope, selectContextSystems } from '@core';

export const WORKSPACE_SCHEMA_VERSION = 35;
const SCHEMA_VERSION = WORKSPACE_SCHEMA_VERSION;

const assessmentActionSourcePrefix = 'assessment-v3:';

function assessmentActionSource(sourceRef: string | null): {
  snapshotId: string; actionId: string; dedupeKey: string
} | null {
  if (!sourceRef?.startsWith(assessmentActionSourcePrefix)) return null;
  try {
    const parsed = JSON.parse(sourceRef.slice(assessmentActionSourcePrefix.length)) as Record<string, unknown>;
    return typeof parsed.snapshotId === 'string' && typeof parsed.actionId === 'string'
      && typeof parsed.dedupeKey === 'string'
      ? { snapshotId: parsed.snapshotId, actionId: parsed.actionId, dedupeKey: parsed.dedupeKey } : null;
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
  sourcePath: string;
  manifest: SourceManifest;
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
  updatedAt: string;
}

export interface JobExecution {
  id: string;
  personId: string;
  documentIds: string[];
  consentId: string;
  attemptCount: number;
  stage: StoredJobSummary['stage'];
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
    evidence: Array<{
      sourceSpanId: string;
      quote: string | null;
      sourceRole?: 'primary' | 'duplicate_source' | undefined;
      duplicateBasis?: 'report_structure' | 'exam_item_id' | 'sample_id' | null | undefined;
    }>;
  }>;
  executionGuard?: JobExecutionGuard;
  resolvedReviewIssueId?: string;
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
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  close(): void {
    this.db.close();
  }

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
             due_date, due_text, user_revision, updated_at
      FROM action_items
      WHERE (? IS NULL OR person_id = ?)
      ORDER BY CASE status WHEN 'completed' THEN 1 WHEN 'dismissed' THEN 2 ELSE 0 END,
               COALESCE(due_date, '9999-12-31'), updated_at DESC, id
    `).all(personId ?? null, personId ?? null) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      id: String(row.id),
      personId: String(row.person_id),
      origin: String(row.origin) as ActionItem['origin'],
      status: String(row.status) as ActionItem['status'],
      title: String(row.title),
      detail: String(row.detail),
      dueDate: row.due_date === null ? null : String(row.due_date),
      dueText: row.due_text === null ? null : String(row.due_text),
      evidenceLabel: assessmentActionSource(row.source_ref === null ? null : String(row.source_ref))
        ? '来自本人已采纳的健康解读'
        : row.source_ref === null ? null : String(row.source_ref),
      userRevision: Number(row.user_revision),
      updatedAt: String(row.updated_at)
    }));
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
          due_date, due_text, user_revision, updated_at
        ) VALUES (?, ?, 'user_created', '用户记录', 'planned', ?, ?, ?, ?, 1, ?)
      `).run(id, input.personId, input.title.trim(), input.detail.trim(), input.dueDate, input.dueText, updatedAt);
      this.db.prepare(`
        INSERT INTO action_events (id, action_id, actor, previous_status, next_status, note, created_at)
        VALUES (?, ?, 'user', NULL, 'planned', '用户创建事项', ?)
      `).run(randomUUID(), id, updatedAt);
    });
    transaction();
    return this.listActionItems(input.personId).find((item) => item.id === id)!;
  }

  listAdoptedMemberAssessmentActions(personId: string): Array<{ action: ActionItem; dedupeKey: string }> {
    const sources = this.db.prepare(`
      SELECT id, source_ref FROM action_items WHERE person_id = ? AND origin = 'ai_proposed'
    `).all(personId) as Array<{ id: string; source_ref: string | null }>;
    const actions = new Map(this.listActionItems(personId).map((action) => [action.id, action]));
    return sources.flatMap((row) => {
      const source = assessmentActionSource(row.source_ref);
      const action = actions.get(row.id);
      return source && action ? [{ action, dedupeKey: source.dedupeKey }] : [];
    });
  }

  /** 点击采纳才创建行动；事务内重查当前快照、版本和稳定键，防止旧页面或重复点击。 */
  adoptMemberAssessmentAction(input: AdoptMemberAssessmentActionInput): ActionItem {
    const timestamp = this.now().toISOString();
    const actionId = this.db.transaction(() => {
      const person = this.db.prepare(`SELECT id FROM persons WHERE id = ? AND archived_at IS NULL`).get(input.personId);
      if (!person) throw new Error('PERSON_NOT_FOUND');
      const row = this.db.prepare(`
        SELECT payload_json, fact_revision, context_revision FROM member_assessment_snapshots_v3
        WHERE id = ? AND person_id = ? AND status = 'current'
      `).get(input.snapshotId, input.personId) as {
        payload_json: string; fact_revision: number; context_revision: number
      } | undefined;
      if (!row || row.fact_revision !== this.getFactRevision(input.personId)
        || row.context_revision !== this.getClinicalContextRevision(input.personId)) {
        throw new Error('MEMBER_ASSESSMENT_ACTION_STALE');
      }
      const snapshot = JSON.parse(row.payload_json) as MemberAssessmentSnapshotV3;
      if (snapshot.reviewScopeSignature !== this.getOpenReviewScopeSignature(input.personId)) {
        throw new Error('MEMBER_ASSESSMENT_ACTION_STALE');
      }
      const proposal = snapshot.actions.find((item) => item.id === input.actionId);
      if (!proposal || snapshot.heldTargetIds.includes(input.actionId)) throw new Error('MEMBER_ASSESSMENT_ACTION_NOT_AVAILABLE');
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
      const sourceRef = `${assessmentActionSourcePrefix}${JSON.stringify({
        snapshotId: input.snapshotId, actionId: input.actionId, dedupeKey: proposal.dedupeKey
      })}`;
      this.db.prepare(`
        INSERT INTO action_items (
          id, person_id, origin, source_ref, status, title, detail,
          due_date, due_text, user_revision, updated_at
        ) VALUES (?, ?, 'ai_proposed', ?, 'planned', ?, ?, NULL, ?, 1, ?)
      `).run(id, input.personId, sourceRef, proposal.title, detail, proposal.timing, timestamp);
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
          due_date, due_text, user_revision, updated_at
        ) VALUES (?, ?, 'ai_proposed', ?, 'planned', ?, ?, ?, '由我决定开始时间', 1, ?)
      `).run(id, input.personId, `proposal:${input.proposalId}`, proposal.title, actionDetail, input.dueDate, timestamp);
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
    const rows = this.db.prepare(`
      SELECT o.person_id,
             COUNT(*) AS accepted_fact_count,
             SUM(CASE WHEN r.abnormal_flag IN ('high', 'low', 'positive') THEN 1 ELSE 0 END) AS attention_count,
             MAX(e.clinical_date) AS latest_clinical_date
      FROM observations o
      JOIN observation_revisions r
        ON r.observation_id = o.id AND r.revision = o.current_revision
      JOIN source_spans ss ON ss.id = r.source_span_id
      JOIN documents d ON d.id = ss.document_id AND d.excluded_from_analysis = 0
      LEFT JOIN encounters e ON e.id = o.encounter_id
      GROUP BY o.person_id
    `).all() as Array<{
      person_id: string;
      accepted_fact_count: number;
      attention_count: number;
      latest_clinical_date: string | null;
    }>;
    return new Map(rows.map((row) => [row.person_id, {
      acceptedFactCount: Number(row.accepted_fact_count),
      attentionCount: Number(row.attention_count),
      latestClinicalDate: row.latest_clinical_date
    }]));
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
        SELECT original.media_type AS original_media_type, converted.media_type AS converted_media_type
        FROM documents d
        JOIN source_objects original ON original.id = d.source_object_id
        JOIN source_objects converted ON converted.id = ?
        WHERE d.id = ?
      `).get(input.convertedSourceObjectId, input.documentId) as {
        original_media_type: string;
        converted_media_type: string;
      } | undefined;
      if (!source) throw new Error('DOCUMENT_CONVERSION_SOURCE_MISSING');
      if (source.original_media_type !== 'application/msword' || source.converted_media_type !== 'application/pdf') {
        throw new Error('DOCUMENT_CONVERSION_MEDIA_TYPE_INVALID');
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
        `已用 ${input.converterId} ${input.converterVersion} 建立旧版 Word 转换视图`,
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

  registerImportedDocument(input: { sourceObjectId: string; personId: string | null; assignmentBasis?: 'user_selected' | 'folder_binding' }): ImportedDocumentReceipt {
    const existing = this.db.prepare(`
      SELECT id, person_id FROM documents WHERE source_object_id = ? ORDER BY created_at LIMIT 1
    `).get(input.sourceObjectId) as { id: string; person_id: string | null } | undefined;
    if (existing && existing.person_id === input.personId) {
      return { documentId: existing.id, status: 'duplicate', duplicate: true };
    }

    const documentId = randomUUID();
    const crossPersonConflict = Boolean(existing && existing.person_id !== input.personId);
    const status = input.personId && !crossPersonConflict ? 'queued' : 'needs_review';
    this.db.prepare(`
      INSERT INTO documents (
        id, source_object_id, person_id, document_kind, status,
        acceptance_id, excluded_from_analysis, person_assignment_basis, created_at
      ) VALUES (?, ?, ?, 'health_report', ?, NULL, 0, ?, ?)
    `).run(
      documentId,
      input.sourceObjectId,
      crossPersonConflict ? null : input.personId,
      status,
      input.assignmentBasis ?? 'user_selected',
      this.now().toISOString()
    );
    this.db.prepare(`
      INSERT INTO audit_events (id, event_type, entity_id, summary, created_at)
      VALUES (?, 'document.imported', ?, ?, ?)
    `).run(randomUUID(), documentId, status === 'queued' ? '资料已进入本地待处理队列' : '资料等待确认所属成员', this.now().toISOString());
    return { documentId, status, duplicate: false };
  }

  listImportedDocuments(): ImportedDocumentSummary[] {
    const rows = this.db.prepare(`
      SELECT d.id, d.person_id, d.status, d.created_at, so.media_type,
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
        status,
        sourceLabel: '手动导入',
        issue: status === 'needs_review'
          ? '尚未可靠确认所属成员，确认前不会发送给 AI'
          : status === 'blocked'
            ? '本地预处理失败，原始文件已保留，可修复后重试'
            : status === 'ignored'
              ? '已移出处理与分析；原文件仍在收件箱时也不会重复导入，可手动重新纳入'
            : null
      };
    });
  }

  saveSourceManifest(manifest: SourceManifest): void {
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
          quote, readability, normalizer_version
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const span of manifest.spans) {
        if (span.documentId !== document.id) throw new Error('SOURCE_SPAN_DOCUMENT_MISMATCH');
        statement.run(
          span.id, span.documentId, span.spanKind, span.page, span.blockId,
          span.lineStart, span.lineEnd, span.quote, span.readability, manifest.normalizerVersion
        );
      }
      this.db.prepare(`
        INSERT INTO audit_events (id, event_type, entity_id, summary, created_at)
        VALUES (?, 'source_manifest.created', ?, ?, ?)
      `).run(randomUUID(), document.id, `已建立 ${manifest.spans.length} 条证据定位`, this.now().toISOString());
    });
    transaction();
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
            WHERE person_id = ? AND origin = 'ai_proposed' AND source_ref LIKE ?
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
             quote, readability, normalizer_version
      FROM source_spans WHERE document_id = ?
      ORDER BY COALESCE(page_number, 0), COALESCE(line_start, 0), COALESCE(block_id, ''), id
    `).all(documentId) as Array<Record<string, unknown>>;
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
      readability: String(row.readability) as SourceManifest['spans'][number]['readability']
    }));
    return {
      documentId,
      personId: String(document.person_id),
      personDisplayName: String(document.person_display_name),
      personAssignmentBasis: String(document.person_assignment_basis) as DocumentExtractionBundle['personAssignmentBasis'],
      confirmedReportedName: document.confirmed_reported_name == null ? null : String(document.confirmed_reported_name),
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
          || input.attemptId || input.stage || input.documentRun
          ? JSON.stringify({
              ...(input.candidateOptions ? { candidateOptions: input.candidateOptions } : {}),
              ...(input.candidateDiffs ? { candidateDiffs: input.candidateDiffs } : {}),
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
      SELECT ri.id FROM review_issues ri
      JOIN documents d ON ri.field_ref = 'document:' || d.id
      WHERE d.person_id = ? AND ri.resolution_status = 'open'
      ORDER BY ri.id
    `).all(personId) as Array<{ id: string }>;
    return createHash('sha256').update(JSON.stringify(rows.map((row) => row.id))).digest('hex');
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
      if (!issue || issue.resolution_status !== 'open' || issue.kind !== 'field_conflict') {
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
      if (!payload.candidateOptions?.length
        || (candidateDiffs.length > 0 && !abnormalFlagOnly && !evidenceIssueOnly && !legacyComparisonIssue)) {
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
        SELECT ri.job_id, ri.kind, ri.resolution_status, ri.payload_json, d.person_id
        FROM review_issues ri
        JOIN documents d ON ri.field_ref = 'document:' || d.id
        WHERE ri.id = ? AND d.id = ?
      `).get(input.issueId, input.documentId) as {
        kind: string;
        job_id: string | null;
        resolution_status: string;
        payload_json: string | null;
        person_id: string | null;
      } | undefined;
      if (!issue || issue.resolution_status !== 'open' || issue.kind !== 'person_conflict') {
        throw new Error('REVIEW_ISSUE_NOT_OPEN');
      }
      if (issue.person_id !== input.personId) throw new Error('DOCUMENT_IDENTITY_CONFLICT');
      const payload = issue.payload_json
        ? JSON.parse(issue.payload_json) as { reportedName?: string }
        : {};
      const reportedName = payload.reportedName?.trim();
      if (!reportedName) throw new Error('REPORTED_NAME_REQUIRED');

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
        this.db.prepare(`
          UPDATE documents SET status = 'completed', excluded_from_analysis = 1 WHERE id = ?
        `).run(input.documentId);
        if (document?.person_id) {
          this.db.prepare(`
            INSERT INTO person_revisions (person_id, fact_revision) VALUES (?, 1)
            ON CONFLICT(person_id) DO UPDATE SET fact_revision = fact_revision + 1
          `).run(document.person_id);
          this.db.prepare(`UPDATE derived_snapshots SET status = 'stale' WHERE person_id = ? AND status = 'current'`).run(document.person_id);
          this.invalidateSystemSnapshots(document.person_id, affectedSystemIds);
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
      const resumeExtraction = !finishWithoutResume && (job.stage === 'extract' || job.stage === 'review_facts');
      const status = resumeExtraction ? 'queued' : 'succeeded';
      this.db.prepare(`
        UPDATE jobs
        SET status = ?, stage = ?, lease_owner = NULL, lease_expires_at = NULL,
            checkpoint_json = ?, updated_at = ?
        WHERE id = ?
      `).run(
        status,
        resumeExtraction ? 'extract' : job.stage,
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
          'scheduled_health_report_processing', 'manual_health_report_processing'
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

  createWaitingAuthBatch(input: {
    cutoff: string;
    groups: Array<{ personId: string; documentIds: string[]; inputSignature: string; stage?: StoredJobSummary['stage'] }>;
    initialStatus?: 'queued' | 'waiting_auth';
    consentId?: string | null;
  }): { batchId: string; jobIds: string[]; idempotent: boolean } {
    const initialStatus = input.initialStatus ?? 'waiting_auth';
    const signature = input.groups.map((group) => group.inputSignature).sort()[0];
    if (signature) {
      const existing = this.db.prepare(`
        SELECT batch_id AS batchId, id, checkpoint_json FROM jobs
        WHERE input_signature = ? AND status IN ('queued', 'running', 'waiting_auth', 'waiting_quota', 'waiting_user', 'retry_wait')
        LIMIT 1
      `).get(signature) as { batchId: string; id: string; checkpoint_json: string | null } | undefined;
      if (existing) {
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
    const batchId = randomUUID();
    const jobIds: string[] = [];
    const transaction = this.db.transaction(() => {
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
          `manual:${group.inputSignature}`,
          JSON.stringify({ documentIds: group.documentIds, completedUnits: 0, consentId: input.consentId ?? null, authorizationType: 'manual' }),
          this.now().toISOString(), this.now().toISOString()
        );
      }
    });
    transaction();
    return { batchId, jobIds, idempotent: false };
  }

  createManualProcessingConsent(input: {
    documentIds: string[];
    personIds: string[];
    historicalObservationIds?: string[];
    accountFingerprint: string;
    version: number;
  }): string {
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
        stages: ['extract', 'review_facts', 'analyze', 'guidance', 'review_derived', 'system_analysis', 'system_review', 'publish']
      }),
      input.accountFingerprint,
      input.version,
      this.now().toISOString()
    );
    return id;
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
      WHERE purpose = 'manual_health_report_processing' AND revoked_at IS NULL
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
      const row = this.db.prepare(`
        SELECT id, person_id, checkpoint_json, attempt_count, stage
        FROM jobs WHERE status = 'queued' ORDER BY created_at, id LIMIT 1
      `).get() as { id: string; person_id: string | null; checkpoint_json: string | null; attempt_count: number; stage: StoredJobSummary['stage'] } | undefined;
      if (!row?.person_id) return null;
      const checkpoint = row.checkpoint_json ? JSON.parse(row.checkpoint_json) as {
        documentIds?: string[];
        consentId?: string | null;
        authorizationType?: 'manual' | 'scheduled';
      } : {};
      if (!checkpoint.documentIds?.length || !checkpoint.consentId) {
        this.db.prepare(`UPDATE jobs SET status = 'waiting_user', updated_at = ? WHERE id = ?`).run(this.now().toISOString(), row.id);
        return null;
      }
      const consent = this.db.prepare(`SELECT id, account_fingerprint, scope_json FROM consents WHERE id = ? AND revoked_at IS NULL`).get(checkpoint.consentId) as { id: string; account_fingerprint: string | null; scope_json: string } | undefined;
      const scope = consent ? JSON.parse(consent.scope_json) as {
        type?: string;
        documentIds?: string[];
        personIds?: string[];
        stages?: string[];
        personId?: string | null;
        scheduledAiProcessing?: boolean;
        includeRelevantHistory?: boolean;
      } : null;
      const requiredStages = ['extract', 'review_facts', 'analyze', 'guidance', 'review_derived', 'system_analysis', 'system_review', 'publish'];
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
          && requiredStages.every((stage) => scope.stages?.includes(stage));
      if (consent && consent.account_fingerprint !== accountFingerprint) {
        this.db.prepare(`UPDATE jobs SET status = 'waiting_auth', updated_at = ? WHERE id = ?`).run(this.now().toISOString(), row.id);
        return null;
      }
      if (!consent || !scopeMatches) {
        this.db.prepare(`UPDATE jobs SET status = 'waiting_user', updated_at = ? WHERE id = ?`).run(this.now().toISOString(), row.id);
        return null;
      }
      const expiresAt = new Date(this.now().getTime() + leaseMs).toISOString();
      const updated = this.db.prepare(`
        UPDATE jobs SET status = 'running', lease_owner = ?, lease_expires_at = ?,
                        attempt_count = attempt_count + 1, updated_at = ?
        WHERE id = ? AND status = 'queued'
      `).run(leaseOwner, expiresAt, this.now().toISOString(), row.id);
      if (updated.changes !== 1) return null;
      return {
        id: row.id,
        personId: row.person_id,
        documentIds: checkpoint.documentIds,
        consentId: checkpoint.consentId,
        attemptCount: row.attempt_count + 1,
        stage: row.stage
      };
    });
    return transaction();
  }

  requeueWaitingJobs(status: 'waiting_auth' | 'waiting_quota'): number {
    const result = this.db.prepare(`
      UPDATE jobs
      SET status = 'queued', updated_at = ?
      WHERE status = ?
    `).run(this.now().toISOString(), status);
    return result.changes;
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
    const row = this.db.prepare(`
      SELECT j.status, j.checkpoint_json, a.status AS attempt_status,
             c.revoked_at, c.account_fingerprint
      FROM jobs j
      JOIN job_attempts a ON a.job_id = j.id AND a.id = ?
      LEFT JOIN consents c ON c.id = ?
      WHERE j.id = ?
    `).get(guard.attemptId, guard.consentId, guard.jobId) as {
      status: string;
      checkpoint_json: string | null;
      attempt_status: string;
      revoked_at: string | null;
      account_fingerprint: string | null;
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
    if (documentId && !checkpoint.documentIds?.includes(documentId)) throw new Error('DOCUMENT_OUTSIDE_CONSENT_SCOPE');
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
    if (!checkpoint.extractionChunks || typeof checkpoint.extractionChunks !== 'object') return;
    if (documentId === undefined) delete checkpoint.extractionChunks;
    else {
      const chunks = checkpoint.extractionChunks as Record<string, unknown>;
      if (!(documentId in chunks)) return;
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
      SELECT c.scope_json
      FROM jobs j
      JOIN job_attempts a ON a.job_id = j.id AND a.id = ?
      JOIN consents c ON c.id = ? AND c.revoked_at IS NULL
      WHERE j.id = ? AND j.person_id = ?
    `).get(guard.attemptId, guard.consentId, guard.jobId, personId) as { scope_json: string } | undefined;
    if (!row) throw new Error('CONSENT_REVOKED');
    const scope = JSON.parse(row.scope_json) as {
      type?: string;
      personId?: string | null;
      personIds?: string[];
      documentIds?: string[];
      historicalObservationIds?: string[];
      includeRelevantHistory?: boolean;
      scheduledAiProcessing?: boolean;
    };
    const allowed = scope.type === 'inbox_binding'
      ? scope.scheduledAiProcessing === true && scope.includeRelevantHistory === true && scope.personId === personId
      : scope.type === 'manual_batch'
        && scope.includeRelevantHistory === true
        && scope.personIds?.includes(personId)
        && observations.every((observation) => (
          scope.documentIds?.includes(observation.documentId)
          || scope.historicalObservationIds?.includes(observation.id)
        ));
    if (!allowed) throw new Error('HISTORICAL_FACTS_OUTSIDE_CONSENT_SCOPE');
  }

  beginAiTransmission(input: { guard: JobExecutionGuard; documentId: string; stage: string }): string {
    this.assertJobExecutionActive(input.guard, input.documentId);
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
    const result = this.db.prepare(`
      UPDATE jobs
      SET status = 'queued',
          stage = CASE WHEN status = 'completed_with_issues' THEN 'system_analysis' ELSE stage END,
          lease_owner = NULL,
          lease_expires_at = NULL,
          updated_at = ?
      WHERE id = ? AND status IN ('failed', 'completed_with_issues')
    `).run(this.now().toISOString(), jobId);
    if (result.changes !== 1) throw new Error('JOB_NOT_RETRYABLE');
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

  updateJobStage(jobId: string, stage: StoredJobSummary['stage']): void {
    const result = this.db.prepare(`
      UPDATE jobs SET stage = ?, updated_at = ? WHERE id = ? AND status = 'running'
    `).run(stage, this.now().toISOString(), jobId);
    if (result.changes !== 1) throw new Error('JOB_NOT_RUNNING');
  }

  finishJob(jobId: string, status: 'succeeded' | 'completed_with_issues' | 'failed' | 'waiting_auth' | 'waiting_quota' | 'waiting_user' | 'cancelled'): void {
    this.db.transaction(() => {
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
    this.db.prepare(`
      INSERT INTO job_attempts (
        id, job_id, runtime_version, model, reasoning_effort, thread_id, turn_id, status,
        error_code, usage_json, started_at, finished_at
      ) VALUES (?, ?, ?, ?, ?, NULL, NULL, 'running', NULL, NULL, ?, NULL)
    `).run(id, jobId, runtimeVersion, model, reasoningEffort, this.now().toISOString());
    return id;
  }

  finishJobAttempt(input: {
    attemptId: string;
    status: 'succeeded' | 'completed_with_issues' | 'failed' | 'waiting_auth' | 'waiting_quota' | 'waiting_user' | 'cancelled';
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
      SELECT j.id, j.stage, j.status, j.checkpoint_json, j.updated_at,
             b.created_at AS batch_created_at, p.display_name AS person_label,
             (
               SELECT ja.error_code
               FROM job_attempts ja
               WHERE ja.job_id = j.id
               ORDER BY ja.started_at DESC, ja.rowid DESC
               LIMIT 1
             ) AS latest_error_code
      FROM jobs j
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
      } : {};
      const status = String(row.status) as StoredJobSummary['status'];
      const labels: Record<StoredJobSummary['status'], string> = {
        queued: '已排队', running: '正在处理', waiting_auth: '等待连接 Codex',
        waiting_quota: '等待额度恢复', waiting_user: '等待你的确认', retry_wait: '等待重试',
        succeeded: '已完成', completed_with_issues: '事实已保存，部分系统说明未通过', failed: '处理失败', cancelled: '已取消'
      };
      const latestErrorCode = row.latest_error_code === null ? null : String(row.latest_error_code);
      const failedStatusText = latestErrorCode?.includes('failed to load configuration')
        ? '当前版本的 Codex 配置不兼容，请安装更新后重试'
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
        batchLabel: `手动处理 · ${new Date(String(row.batch_created_at)).toLocaleString('zh-CN')}`,
        personLabel: row.person_label === null ? null : String(row.person_label),
        stage: String(row.stage) as StoredJobSummary['stage'],
        status,
        completedUnits: checkpoint.completedUnits ?? 0,
        totalUnits: Math.max(checkpoint.documentIds?.length ?? 1, 1),
        statusText: status === 'running' && checkpoint.cancelRequested ? '正在安全停止' : status === 'failed' ? failedStatusText : labels[status],
        systemOutcomes: checkpoint.systemOutcomes ?? [],
        updatedAt: String(row.updated_at)
      };
    });
  }

  cleanupTerminalTaskAttempts(cutoffIso: string): number {
    const result = this.db.prepare(`
      DELETE FROM job_attempts
      WHERE finished_at IS NOT NULL
        AND finished_at < ?
        AND job_id IN (
          SELECT j.id FROM jobs j
          WHERE j.status IN ('succeeded', 'completed_with_issues', 'failed', 'cancelled')
            AND NOT EXISTS (
              SELECT 1 FROM review_issues r
              WHERE r.job_id = j.id AND r.resolution_status = 'open'
            )
        )
    `).run(cutoffIso);
    return result.changes;
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

  listAcceptedObservations(personId?: string, options?: { limitPerPerson?: number }): AcceptedObservationSummary[] {
    const limitPerPerson = options?.limitPerPerson;
    if (limitPerPerson !== undefined && (!Number.isInteger(limitPerPerson) || limitPerPerson < 1 || limitPerPerson > 5_000)) {
      throw new Error('OBSERVATION_WINDOW_LIMIT_INVALID');
    }
    const scopeCte = limitPerPerson === undefined ? '' : `
      WITH ranked_observation_ids AS (
        SELECT o2.id,
               ROW_NUMBER() OVER (
                 PARTITION BY o2.person_id
                 ORDER BY COALESCE(e2.clinical_date, o2.created_at) DESC, o2.id DESC
               ) AS person_rank
        FROM observations o2
        JOIN observation_revisions r2
          ON r2.observation_id = o2.id AND r2.revision = o2.current_revision
        JOIN source_spans ss2 ON ss2.id = r2.source_span_id
        JOIN documents d2 ON d2.id = ss2.document_id AND d2.excluded_from_analysis = 0
        LEFT JOIN encounters e2 ON e2.id = o2.encounter_id
        WHERE (? IS NULL OR o2.person_id = ?)
      )`;
    const scopeJoin = limitPerPerson === undefined ? '' : `
      JOIN ranked_observation_ids scoped
        ON scoped.id = o.id AND scoped.person_rank <= ?`;
    const rows = this.db.prepare(`${scopeCte}
      SELECT o.id, o.person_id, o.concept_key, o.original_name, o.model_standard_name_candidate, o.created_at,
             r.value_kind, r.raw_text, r.decimal_value, r.qualifier, r.unit,
             r.reference_range, r.abnormal_flag, r.source_span_id,
             r.specimen, r.method, r.body_site, r.evidence_json,
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
      ${scopeJoin}
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
    `).all(...(limitPerPerson === undefined
      ? [personId ?? null, personId ?? null]
      : [personId ?? null, personId ?? null, limitPerPerson, personId ?? null, personId ?? null]
    )) as Array<Record<string, unknown>>;
    return rows.map((row) => {
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

  private findStrongMetadataEventMatch(personId: string, metadata: ReportMetadataCandidate | null | undefined): string | null {
    if (!metadata?.organization?.value) return null;
    const normalized = (value: string) => value.normalize('NFKC').trim().toLocaleLowerCase('zh-CN');
    const organization = normalized(metadata.organization.value);
    const clinicalTime = metadata.times
      .filter((time) => ['sampled', 'examined', 'encounter'].includes(time.role))
      .sort((left, right) => ({ day: 3, month: 2, year: 1 }[right.precision] - { day: 3, month: 2, year: 1 }[left.precision]))[0];
    if (!clinicalTime) return null;
    const encounterIdentifier = metadata.encounterIdentifier?.value
      ? normalized(metadata.encounterIdentifier.value)
      : null;
    const sampleIdentifiers = new Set((metadata.sampleIdentifiers ?? []).map((item) => normalized(item.value)));
    if (!encounterIdentifier && sampleIdentifiers.size === 0) return null;
    const rows = this.db.prepare(`
      SELECT r.event_id, mr.payload_json
      FROM report_records r
      JOIN report_metadata_revisions mr
        ON mr.report_id = r.id AND mr.revision = r.metadata_revision
      WHERE r.person_id = ?
    `).all(personId) as Array<{ event_id: string; payload_json: string }>;
    const matches = new Set<string>();
    for (const row of rows) {
      const payload = JSON.parse(row.payload_json) as { extracted?: ReportMetadataCandidate | null };
      const existing = payload.extracted;
      if (!existing?.organization?.value || normalized(existing.organization.value) !== organization) continue;
      const existingTime = existing.times
        .filter((time) => ['sampled', 'examined', 'encounter'].includes(time.role))
        .sort((left, right) => ({ day: 3, month: 2, year: 1 }[right.precision] - { day: 3, month: 2, year: 1 }[left.precision]))[0];
      if (!existingTime || existingTime.value !== clinicalTime.value || existingTime.precision !== clinicalTime.precision) continue;
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

  publishFacts(input: PublishFactsInput): { publicationId: string; revision: number; idempotent: boolean } {
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
    if (existing) return { publicationId: existing.publication_id, revision: existing.revision, idempotent: true };

    const transaction = this.db.transaction(() => {
      if (input.executionGuard) this.assertJobExecutionActive(input.executionGuard, input.documentId);
      const committed = this.db.prepare(`
        SELECT publication_id, revision FROM document_commits
        WHERE document_id = ? OR commit_key = ?
      `).get(input.documentId, input.documentCommitKey) as { publication_id: string; revision: number } | undefined;
      if (committed && input.resolvedReviewIssueId) {
        throw new Error('DOCUMENT_ALREADY_COMMITTED_REVIEW_CONFLICT');
      }
      if (committed) return { publicationId: committed.publication_id, revision: committed.revision, idempotent: true };
      const actual = this.getFactRevision(input.personId);
      if (actual !== input.expectedRevision) throw new RevisionConflictError(input.expectedRevision, actual);
      const nextRevision = actual + 1;
      const publicationId = randomUUID();
      const encounters = new Map<string, string>();
      const affectedSystemIds = new Set<string>();

      for (const observation of input.observations) {
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
            acceptance_id, specimen, method, body_site, evidence_json, created_at
          ) VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          observationId, observation.valueKind, observation.rawText, observation.decimalValue,
          observation.qualifier, observation.unit, observation.referenceRange, observation.abnormalFlag,
          observation.sourceSpanId, observation.acceptanceId, observation.specimen, observation.method,
          observation.bodySite, JSON.stringify(observation.evidence), this.now().toISOString()
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
        const metadata = input.reportMetadata ?? null;
        const metadataTimes = metadata?.times ?? [];
        const currentClinicalTime = metadataTimes
          .filter((time) => ['sampled', 'examined', 'encounter'].includes(time.role))
          .sort((left, right) => ({ day: 3, month: 2, year: 1 }[right.precision] - { day: 3, month: 2, year: 1 }[left.precision]))[0];
        const reportIssuedTime = metadataTimes.find((time) => time.role === 'report_issued');
        const dates = [...new Set(input.observations.map((item) => item.clinicalDate).filter((value): value is string => Boolean(value)))].sort();
        const earliest = dates[0] ?? null;
        const latest = dates.at(-1) ?? null;
        const spanDays = earliest && latest
          ? Math.round((Date.parse(`${latest}T00:00:00Z`) - Date.parse(`${earliest}T00:00:00Z`)) / 86_400_000)
          : null;
        const eventDate = currentClinicalTime?.value
          ?? (dates.length === 1 || (spanDays !== null && spanDays <= 14) ? earliest : null);
        const eventEndDate = currentClinicalTime ? null : eventDate && latest !== eventDate ? latest : null;
        const matchedEventId = this.findStrongMetadataEventMatch(input.personId, metadata);
        const eventId = matchedEventId ?? randomUUID();
        const reportId = randomUUID();
        const eventTitle = metadata?.title?.value ?? metadata?.reportKind?.value ?? document.display_name;
        const reportTitle = metadata?.title?.value ?? document.display_name;
        const reportKind = metadata?.reportKind?.value ?? 'health_report';
        const reportDate = reportIssuedTime?.value ?? eventDate;
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
      return { publicationId, revision: nextRevision, idempotent: false };
    });
    return transaction();
  }

  integrityCheck(): string {
    const rows = this.db.pragma('integrity_check') as Array<{ integrity_check: string }>;
    return rows.map((row) => row.integrity_check).join(',');
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
        quote TEXT, readability TEXT NOT NULL, normalizer_version TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS source_manifests (
        document_id TEXT PRIMARY KEY REFERENCES documents(id) ON DELETE CASCADE,
        manifest_id TEXT NOT NULL, source_object_id TEXT NOT NULL REFERENCES source_objects(id),
        sha256 TEXT NOT NULL, media_type TEXT NOT NULL, original_display_name TEXT NOT NULL,
        total_units INTEGER NOT NULL, covered_unit_indexes_json TEXT NOT NULL,
        normalizer_version TEXT NOT NULL, conversion_warnings_json TEXT NOT NULL,
        created_at TEXT NOT NULL
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
        evidence_json TEXT NOT NULL DEFAULT '[]', supersedes INTEGER, created_at TEXT NOT NULL,
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
        due_date TEXT, due_text TEXT, user_revision INTEGER NOT NULL, updated_at TEXT NOT NULL
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
      PRAGMA user_version = 35;
      `);

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
