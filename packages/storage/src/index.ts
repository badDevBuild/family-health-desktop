import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import Database from 'better-sqlite3';
import type { ActionItem, CreateManualNoteInput, DerivedSnapshotCandidate, ManualNote, ObservationCandidate, Person, SourceManifest } from '@contracts';

export const WORKSPACE_SCHEMA_VERSION = 7;
const SCHEMA_VERSION = WORKSPACE_SCHEMA_VERSION;

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
  personAssignmentBasis: 'user_selected' | 'folder_binding' | 'legacy';
  sourcePath: string;
  manifest: SourceManifest;
}

export interface JobExecutionGuard {
  jobId: string;
  attemptId: string;
  consentId: string;
  accountFingerprint: string;
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
  kind: 'field_conflict' | 'coverage_gap' | 'overwrite_protected' | 'derived_safety';
  severity: 'blocking' | 'warning';
  evidenceRefs: string[];
  candidateOptions: ObservationCandidate[];
}

export interface StoredJobSummary {
  id: string;
  batchLabel: string;
  personLabel: string | null;
  stage: 'extract' | 'review_facts' | 'analyze' | 'guidance' | 'review_derived' | 'publish';
  status: 'queued' | 'running' | 'waiting_auth' | 'waiting_quota' | 'waiting_user' | 'retry_wait' | 'succeeded' | 'failed' | 'cancelled';
  completedUnits: number;
  totalUnits: number;
  statusText: string;
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
  observations: Array<{
    conceptKey: string;
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
    evidence: Array<{ sourceSpanId: string; quote: string | null }>;
  }>;
  executionGuard?: JobExecutionGuard;
  resolvedReviewIssueId?: string;
}

export interface AcceptedObservationSummary {
  id: string;
  personId: string;
  conceptKey: string;
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
  specimen: string | null;
  method: string | null;
  bodySite: string | null;
  evidence: Array<{ sourceSpanId: string; quote: string | null }>;
  createdAt: string;
}

export interface PublishedDerivedSnapshot {
  id: string;
  personId: string;
  factRevision: number;
  contextRevision: number;
  status: 'current' | 'stale' | 'building' | 'unavailable';
  payload: DerivedSnapshotCandidate;
  createdAt: string;
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
      const kind = ['history', 'allergy', 'medication', 'self_measurement', 'free_text'].includes(String(stored.kind))
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
      evidenceLabel: row.source_ref === null ? null : String(row.source_ref),
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
             ) AS display_name
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

  setDocumentStatus(documentId: string, status: 'queued' | 'needs_review' | 'blocked' | 'completed'): void {
    const result = this.db.prepare(`UPDATE documents SET status = ? WHERE id = ?`).run(status, documentId);
    if (result.changes !== 1) throw new Error('DOCUMENT_NOT_FOUND');
  }

  setDocumentIncluded(input: { documentId: string; included: boolean }): { included: boolean; personId: string | null } {
    const changedAt = this.now().toISOString();
    const transaction = this.db.transaction(() => {
      const document = this.db.prepare(`
        SELECT d.person_id, d.excluded_from_analysis, so.sha256
        FROM documents d JOIN source_objects so ON so.id = d.source_object_id
        WHERE d.id = ?
      `).get(input.documentId) as { person_id: string | null; excluded_from_analysis: number; sha256: string } | undefined;
      if (!document) throw new Error('DOCUMENT_NOT_FOUND');
      const currentlyIncluded = document.excluded_from_analysis === 0;
      if (currentlyIncluded === input.included) return { included: input.included, personId: document.person_id };

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
        this.db.prepare(`UPDATE documents SET status = 'queued', excluded_from_analysis = 0 WHERE id = ?`).run(input.documentId);
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

        if (document.person_id) {
          const snapshotRows = this.db.prepare(`SELECT id FROM derived_snapshots WHERE person_id = ?`).all(document.person_id) as Array<{ id: string }>;
          for (const snapshot of snapshotRows) this.db.prepare(`DELETE FROM snapshot_evidence WHERE snapshot_id = ?`).run(snapshot.id);
          this.db.prepare(`DELETE FROM derived_snapshots WHERE person_id = ?`).run(document.person_id);
          this.db.prepare(`DELETE FROM document_commits WHERE document_id = ?`).run(input.documentId);
          this.db.prepare(`DELETE FROM publication_events WHERE person_id = ? AND id NOT IN (SELECT publication_id FROM document_commits)`).run(document.person_id);
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
      SELECT d.id, d.person_id, d.person_assignment_basis, p.display_name AS person_display_name,
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
    kind: 'field_conflict' | 'coverage_gap' | 'overwrite_protected' | 'derived_safety';
    severity: 'blocking' | 'warning';
    evidenceRefs: string[];
    preserveDocumentStatus?: boolean;
    candidateOptions?: ObservationCandidate[];
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
        input.candidateOptions ? JSON.stringify({ candidateOptions: input.candidateOptions }) : null,
        this.now().toISOString()
      );
      if (!input.preserveDocumentStatus) {
        this.db.prepare(`UPDATE documents SET status = 'needs_review' WHERE id = ?`).run(input.documentId);
      }
    });
    transaction();
    return id;
  }

  listOpenExtractionReviewIssues(): OpenExtractionReviewIssue[] {
    const rows = this.db.prepare(`
      SELECT ri.id, ri.kind, ri.severity, ri.evidence_refs_json, ri.payload_json,
             d.id AS document_id, d.person_id
      FROM review_issues ri
      JOIN documents d ON ri.field_ref = 'document:' || d.id
      WHERE ri.resolution_status = 'open'
      ORDER BY ri.created_at, ri.id
    `).all() as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      id: String(row.id),
      documentId: String(row.document_id),
      personId: row.person_id === null ? null : String(row.person_id),
      kind: String(row.kind) as OpenExtractionReviewIssue['kind'],
      severity: String(row.severity) as OpenExtractionReviewIssue['severity'],
      evidenceRefs: JSON.parse(String(row.evidence_refs_json)) as string[],
      candidateOptions: row.payload_json
        ? (JSON.parse(String(row.payload_json)) as { candidateOptions?: ObservationCandidate[] }).candidateOptions ?? []
        : []
    }));
  }

  markReviewIssueCorrected(issueId: string, documentId: string): void {
    const transaction = this.db.transaction(() => {
      const result = this.db.prepare(`
        UPDATE review_issues SET resolution_status = 'resolved', resolution_revision = 1
        WHERE id = ? AND field_ref = 'document:' || ? AND resolution_status = 'open' AND kind = 'field_conflict'
      `).run(issueId, documentId);
      if (result.changes !== 1) throw new Error('REVIEW_ISSUE_NOT_OPEN');
      this.db.prepare(`
        INSERT INTO audit_events (id, event_type, entity_id, summary, created_at)
        VALUES (?, 'review_issue.corrected', ?, '用户核对原始依据后修正并接纳事实', ?)
      `).run(randomUUID(), issueId, this.now().toISOString());
      this.resumeWaitingJobsAfterReview(documentId);
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
      this.db.prepare(`
        INSERT INTO audit_events (id, event_type, entity_id, summary, created_at)
        VALUES (?, 'document.person_assigned', ?, '用户确认资料所属成员，已进入待处理队列', ?)
      `).run(randomUUID(), documentId, this.now().toISOString());
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
        SELECT id, kind, resolution_status FROM review_issues
        WHERE id = ? AND field_ref = 'document:' || ?
      `).get(input.issueId, input.documentId) as { id: string; kind: string; resolution_status: string } | undefined;
      if (!issue || issue.resolution_status !== 'open') throw new Error('REVIEW_ISSUE_NOT_OPEN');
      if (input.action === 'archive_only' && issue.kind === 'derived_safety') throw new Error('REVIEW_ACTION_INVALID');
      if (input.action === 'dismiss_derived' && issue.kind !== 'derived_safety') throw new Error('REVIEW_ACTION_INVALID');

      if (input.action === 'archive_only') {
        const document = this.db.prepare(`SELECT person_id FROM documents WHERE id = ?`).get(input.documentId) as { person_id: string | null } | undefined;
        this.db.prepare(`
          UPDATE documents SET status = 'completed', excluded_from_analysis = 1 WHERE id = ?
        `).run(input.documentId);
        if (document?.person_id) {
          this.db.prepare(`
            INSERT INTO person_revisions (person_id, fact_revision) VALUES (?, 1)
            ON CONFLICT(person_id) DO UPDATE SET fact_revision = fact_revision + 1
          `).run(document.person_id);
          this.db.prepare(`UPDATE derived_snapshots SET status = 'stale' WHERE person_id = ? AND status = 'current'`).run(document.person_id);
        }
      }
      this.db.prepare(`
        UPDATE review_issues SET resolution_status = 'resolved', resolution_revision = 1
        WHERE id = ? AND resolution_status = 'open'
      `).run(input.issueId);
      this.db.prepare(`
        INSERT INTO audit_events (id, event_type, entity_id, summary, created_at)
        VALUES (?, 'review_issue.resolved', ?, ?, ?)
      `).run(
        randomUUID(), input.issueId,
        input.action === 'archive_only' ? '用户选择仅归档，不纳入分析' : '用户选择不发布本次派生说明',
        this.now().toISOString()
      );
      this.resumeWaitingJobsAfterReview(input.documentId);
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

  private resumeWaitingJobsAfterReview(documentId: string): void {
    const jobs = this.db.prepare(`
      SELECT id, checkpoint_json FROM jobs WHERE status = 'waiting_user'
    `).all() as Array<{ id: string; checkpoint_json: string | null }>;
    for (const job of jobs) {
      const checkpoint = job.checkpoint_json ? JSON.parse(job.checkpoint_json) as { documentIds?: string[]; completedUnits?: number } & Record<string, unknown> : {};
      if (!checkpoint.documentIds?.includes(documentId)) continue;
      const ready = checkpoint.documentIds.filter((id) => {
        const row = this.db.prepare(`SELECT status FROM documents WHERE id = ?`).get(id) as { status: string } | undefined;
        return row?.status === 'queued';
      });
      const status = ready.length > 0 ? 'queued' : 'succeeded';
      this.db.prepare(`
        UPDATE jobs SET status = ?, checkpoint_json = ?, updated_at = ? WHERE id = ?
      `).run(
        status,
        JSON.stringify({ ...checkpoint, documentIds: ready, completedUnits: ready.length > 0 ? 0 : checkpoint.documentIds.length }),
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
      if (binding.consent_id) this.db.prepare(`UPDATE consents SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL`).run(timestamp, binding.consent_id);
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
        stages: ['extract', 'review_facts', 'analyze', 'guidance', 'review_derived', 'publish']
      }),
      input.accountFingerprint,
      input.version,
      this.now().toISOString()
    );
    return id;
  }

  revokeConsent(consentId: string): void {
    this.db.prepare(`UPDATE consents SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL`)
      .run(this.now().toISOString(), consentId);
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
      WHERE status != 'cancelled' AND checkpoint_json IS NOT NULL
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
      } : null;
      const requiredStages = ['extract', 'review_facts', 'analyze', 'guidance', 'review_derived', 'publish'];
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
      if (row.status === 'succeeded' || row.status === 'cancelled') {
        return { running: false, alreadyTerminal: true };
      }
      if (row.status === 'running') {
        const checkpoint = row.checkpoint_json ? JSON.parse(row.checkpoint_json) as Record<string, unknown> : {};
        this.db.prepare(`UPDATE jobs SET checkpoint_json = ?, updated_at = ? WHERE id = ? AND status = 'running'`).run(
          JSON.stringify({ ...checkpoint, cancelRequested: true }),
          this.now().toISOString(),
          jobId
        );
        return { running: true, alreadyTerminal: false };
      }
      this.db.prepare(`
        UPDATE jobs
        SET status = 'cancelled', lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
        WHERE id = ?
      `).run(this.now().toISOString(), jobId);
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

  retryFailedJob(jobId: string): void {
    const result = this.db.prepare(`
      UPDATE jobs
      SET status = 'queued', lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
      WHERE id = ? AND status = 'failed'
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

  updateJobStage(jobId: string, stage: StoredJobSummary['stage']): void {
    const result = this.db.prepare(`
      UPDATE jobs SET stage = ?, updated_at = ? WHERE id = ? AND status = 'running'
    `).run(stage, this.now().toISOString(), jobId);
    if (result.changes !== 1) throw new Error('JOB_NOT_RUNNING');
  }

  finishJob(jobId: string, status: 'succeeded' | 'failed' | 'waiting_auth' | 'waiting_quota' | 'waiting_user' | 'cancelled'): void {
    const result = this.db.prepare(`
      UPDATE jobs SET status = ?, lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
      WHERE id = ? AND status = 'running'
    `).run(status, this.now().toISOString(), jobId);
    if (result.changes !== 1) throw new Error('JOB_NOT_RUNNING');
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
    status: 'succeeded' | 'failed' | 'waiting_auth' | 'waiting_quota' | 'waiting_user' | 'cancelled';
    errorCode?: string | null;
    threadId?: string | null;
    turnId?: string | null;
  }): void {
    const result = this.db.prepare(`
      UPDATE job_attempts
      SET status = ?, error_code = ?, thread_id = ?, turn_id = ?, finished_at = ?
      WHERE id = ? AND status = 'running'
    `).run(
      input.status, input.errorCode ?? null, input.threadId ?? null,
      input.turnId ?? null, this.now().toISOString(), input.attemptId
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
      ORDER BY j.created_at DESC, j.id DESC
    `).all() as Array<Record<string, unknown>>;
    return rows.map((row) => {
      const checkpoint = row.checkpoint_json ? JSON.parse(String(row.checkpoint_json)) as { documentIds?: string[]; completedUnits?: number; cancelRequested?: boolean } : {};
      const status = String(row.status) as StoredJobSummary['status'];
      const labels: Record<StoredJobSummary['status'], string> = {
        queued: '已排队', running: '正在处理', waiting_auth: '等待连接 Codex',
        waiting_quota: '等待额度恢复', waiting_user: '等待你的确认', retry_wait: '等待重试',
        succeeded: '已完成', failed: '处理失败', cancelled: '已取消'
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
        batchLabel: `手动处理 · ${new Date(String(row.batch_created_at)).toLocaleString('zh-CN')}`,
        personLabel: row.person_label === null ? null : String(row.person_label),
        stage: String(row.stage) as StoredJobSummary['stage'],
        status,
        completedUnits: checkpoint.completedUnits ?? 0,
        totalUnits: Math.max(checkpoint.documentIds?.length ?? 1, 1),
        statusText: status === 'running' && checkpoint.cancelRequested ? '正在安全停止' : status === 'failed' ? failedStatusText : labels[status],
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
          WHERE j.status IN ('succeeded', 'failed', 'cancelled')
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

  listAcceptedObservations(personId?: string): AcceptedObservationSummary[] {
    const rows = this.db.prepare(`
      SELECT o.id, o.person_id, o.concept_key, o.created_at,
             r.value_kind, r.raw_text, r.decimal_value, r.qualifier, r.unit,
             r.reference_range, r.abnormal_flag, r.source_span_id,
             r.specimen, r.method, r.body_site, r.evidence_json,
             e.clinical_date, ss.quote AS source_quote, d.id AS document_id,
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
      WHERE (? IS NULL OR o.person_id = ?)
      ORDER BY COALESCE(e.clinical_date, o.created_at), o.concept_key, o.id
    `).all(personId ?? null, personId ?? null) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      id: String(row.id),
      personId: String(row.person_id),
      conceptKey: String(row.concept_key),
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
      specimen: row.specimen === null ? null : String(row.specimen),
      method: row.method === null ? null : String(row.method),
      bodySite: row.body_site === null ? null : String(row.body_site),
      evidence: JSON.parse(String(row.evidence_json ?? '[]')) as Array<{ sourceSpanId: string; quote: string | null }>,
      createdAt: String(row.created_at)
    }));
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
      SELECT id, person_id, fact_revision, context_revision, status, payload_json, created_at
      FROM derived_snapshots WHERE status = 'current' ORDER BY created_at, id
    `).all() as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      id: String(row.id),
      personId: String(row.person_id),
      factRevision: Number(row.fact_revision),
      contextRevision: Number(row.context_revision),
      status: String(row.status) as PublishedDerivedSnapshot['status'],
      payload: JSON.parse(String(row.payload_json)) as DerivedSnapshotCandidate,
      createdAt: String(row.created_at)
    }));
  }

  listLatestDerivedSnapshots(): PublishedDerivedSnapshot[] {
    const rows = this.db.prepare(`
      SELECT id, person_id, fact_revision, context_revision, status, payload_json, created_at
      FROM derived_snapshots
      ORDER BY person_id, created_at DESC, id DESC
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
        status: String(row.status) as PublishedDerivedSnapshot['status'],
        payload: JSON.parse(String(row.payload_json)) as DerivedSnapshotCandidate,
        createdAt: String(row.created_at)
      }];
    });
  }

  publishFacts(input: PublishFactsInput): { publicationId: string; revision: number; idempotent: boolean } {
    const existing = this.db.prepare(`
      SELECT publication_id, revision FROM document_commits
      WHERE document_id = ? OR commit_key = ?
    `).get(input.documentId, input.documentCommitKey) as { publication_id: string; revision: number } | undefined;
    if (existing) return { publicationId: existing.publication_id, revision: existing.revision, idempotent: true };

    const transaction = this.db.transaction(() => {
      if (input.executionGuard) this.assertJobExecutionActive(input.executionGuard, input.documentId);
      const committed = this.db.prepare(`
        SELECT publication_id, revision FROM document_commits
        WHERE document_id = ? OR commit_key = ?
      `).get(input.documentId, input.documentCommitKey) as { publication_id: string; revision: number } | undefined;
      if (committed) return { publicationId: committed.publication_id, revision: committed.revision, idempotent: true };
      const actual = this.getFactRevision(input.personId);
      if (actual !== input.expectedRevision) throw new RevisionConflictError(input.expectedRevision, actual);
      const nextRevision = actual + 1;
      const publicationId = randomUUID();
      const encounters = new Map<string, string>();

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
          INSERT INTO observations (id, person_id, encounter_id, concept_key, current_revision, created_at)
          VALUES (?, ?, ?, ?, 1, ?)
        `).run(observationId, input.personId, encounterId, observation.conceptKey, this.now().toISOString());
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
      }

      this.db.prepare(`
        INSERT INTO person_revisions (person_id, fact_revision)
        VALUES (?, ?)
        ON CONFLICT(person_id) DO UPDATE SET fact_revision = excluded.fact_revision
      `).run(input.personId, nextRevision);
      this.db.prepare(`UPDATE derived_snapshots SET status = 'stale' WHERE person_id = ? AND status = 'current'`).run(input.personId);
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
      PRAGMA user_version = 7;
      `);

      if (upgradingExistingWorkspace) this.failureInjector?.('during_schema_migration');
      this.db.exec('COMMIT');
    } catch (error) {
      if (this.db.inTransaction) this.db.exec('ROLLBACK');
      throw error;
    }
  }
}
