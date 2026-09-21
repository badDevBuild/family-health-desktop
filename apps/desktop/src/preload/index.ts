import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type { AccountState, ActionItem, ActionStatus, AdoptedActionReceipt, AdoptLifestyleProposalInput, AiPreferences, AiSettings, ArchivePersonInput, BodySystemDetailV2, BodySystemId, BodySystemSummaryV2, CleanupReceipt, ConceptMappingReceipt, ConceptReviewBundle, ConfirmInboxBindingInput, CreateActionItemInput, CreateManualNoteInput, CreatePersonInput, CreateWorkspaceInput, DashboardSnapshot, DeleteDocumentInput, DeleteDocumentReceipt, DeletedDocumentSummary, DiagnosticBundle, DiagnosticExportReceipt, DisplayPreferences, EvidencePreview, EvidencePreviewRequest, ExportMemberSummaryInput, ExportMemberSummaryReceipt, HealthEventDetailV2, HealthEventRelationReceipt, HealthEventV2, ImportFilesReceipt, InboxBindingSummary, LifestylePlanV2, LifestyleProposalDecisionReceipt, ManualNote, MemberEvidenceBundle, MemberOverviewV2, MergeHealthEventsInput, MetricSeriesDetailV2, Person, ProcessNowInput, ReportMetadataCorrectionReceipt, ResolveReviewInput, RestorePersonInput, Result, SetConceptMappingInput, SetDocumentInclusionInput, SetLifestyleProposalDecisionInput, SplitHealthEventInput, UndoConceptMappingInput, UndoHealthEventRelationInput, UndoReportMetadataInput, UpdatePersonDisplayInput, UpdateReportMetadataInput, UpdateScheduleInput } from '@contracts';

export interface HealthDesktopBridge {
  getBootstrap(): Promise<{
    platform: 'darwin' | 'win32' | 'linux';
    versions: { app: string; electron: string; chrome: string; node: string };
    desktopBehavior: { stayInTray: boolean | null; openAtLogin: boolean; notificationsEnabled: boolean };
    displayPreferences: DisplayPreferences;
    aiPreferences: AiPreferences;
    recoveryStatus: { pointCount: number; totalBytes: number; latestAt: string | null };
  }>;
  getSnapshot(): Promise<DashboardSnapshot>;
  getMemberOverview(personId: string): Promise<Result<MemberOverviewV2>>;
  listBodySystems(personId: string): Promise<Result<BodySystemSummaryV2[]>>;
  getConceptReview(personId: string): Promise<Result<ConceptReviewBundle>>;
  setConceptMapping(input: SetConceptMappingInput): Promise<Result<ConceptMappingReceipt>>;
  undoConceptMapping(input: UndoConceptMappingInput): Promise<Result<ConceptMappingReceipt>>;
  getBodySystemDetail(personId: string, systemId: BodySystemId): Promise<Result<BodySystemDetailV2>>;
  getMetricSeries(personId: string, seriesId: string): Promise<Result<MetricSeriesDetailV2>>;
  listHealthEvents(input: { personId: string; systemId?: BodySystemId | null; type?: HealthEventV2['type'] | null }): Promise<Result<HealthEventV2[]>>;
  getHealthEventDetail(personId: string, eventId: string): Promise<Result<HealthEventDetailV2>>;
  updateReportMetadata(input: UpdateReportMetadataInput): Promise<Result<ReportMetadataCorrectionReceipt>>;
  undoReportMetadata(input: UndoReportMetadataInput): Promise<Result<ReportMetadataCorrectionReceipt>>;
  mergeHealthEvents(input: MergeHealthEventsInput): Promise<Result<HealthEventRelationReceipt>>;
  splitHealthEvent(input: SplitHealthEventInput): Promise<Result<HealthEventRelationReceipt>>;
  undoHealthEventRelation(input: UndoHealthEventRelationInput): Promise<Result<HealthEventRelationReceipt>>;
  getMemberEvidenceBundle(personId: string, evidenceIds: string[]): Promise<Result<MemberEvidenceBundle>>;
  getLifestylePlan(personId: string): Promise<Result<LifestylePlanV2>>;
  adoptLifestyleProposal(input: AdoptLifestyleProposalInput): Promise<Result<AdoptedActionReceipt>>;
  setLifestyleProposalDecision(input: SetLifestyleProposalDecisionInput): Promise<Result<LifestyleProposalDecisionReceipt>>;
  getDiagnosticPreview(): Promise<Result<DiagnosticBundle>>;
  exportDiagnostic(): Promise<Result<DiagnosticExportReceipt | null>>;
  cleanupExpiredData(): Promise<Result<CleanupReceipt>>;
  getEvidence(input: EvidencePreviewRequest): Promise<Result<EvidencePreview>>;
  resolveReview(input: ResolveReviewInput): Promise<Result<{ action: ResolveReviewInput['action'] }>>;
  createWorkspace(input: CreateWorkspaceInput): Promise<Result<DashboardSnapshot>>;
  createPerson(input: CreatePersonInput): Promise<Result<{ personId: string; snapshot: DashboardSnapshot }>>;
  updatePersonDisplay(input: UpdatePersonDisplayInput): Promise<Result<DashboardSnapshot>>;
  listArchivedPeople(): Promise<Result<Person[]>>;
  archivePerson(input: ArchivePersonInput): Promise<Result<DashboardSnapshot>>;
  restorePerson(input: RestorePersonInput): Promise<Result<{ person: Person; snapshot: DashboardSnapshot }>>;
  setDocumentIncluded(input: SetDocumentInclusionInput): Promise<Result<DashboardSnapshot>>;
  listDeletedDocuments(): Promise<Result<DeletedDocumentSummary[]>>;
  deleteDocument(input: DeleteDocumentInput): Promise<Result<{ receipt: DeleteDocumentReceipt; snapshot: DashboardSnapshot }>>;
  releaseDeletedDocument(sourceHash: string): Promise<Result<{ sourceHash: string }>>;
  switchWorkspace(mode: 'demo' | 'personal'): Promise<Result<DashboardSnapshot>>;
  selectFiles(personId: string | null): Promise<Result<ImportFilesReceipt>>;
  importDroppedFiles(personId: string | null, files: File[]): Promise<Result<ImportFilesReceipt>>;
  pickInboxDirectory(): Promise<Result<{ selectionId: string; displayName: string } | null>>;
  confirmInboxDirectory(input: ConfirmInboxBindingInput): Promise<Result<InboxBindingSummary>>;
  listInboxDirectories(): Promise<Result<InboxBindingSummary[]>>;
  disableInboxDirectory(bindingId: string): Promise<Result<{ bindingId: string }>>;
  processNow(input: ProcessNowInput): Promise<Result<{ batchId: string }>>;
  cancelJob(jobId: string): Promise<Result<{ running: boolean; alreadyTerminal: boolean }>>;
  retryJob(jobId: string): Promise<Result<{ jobId: string }>>;
  setQueuePaused(paused: boolean): Promise<Result<{ paused: boolean }>>;
  createBackup(passphrase: string): Promise<Result<{ objectCount: number; createdAt: string; displayName: string } | null>>;
  pickRestoreBackup(): Promise<Result<{ selectionId: string; displayName: string } | null>>;
  restoreBackup(input: { selectionId: string; passphrase: string; confirmedReplaceWorkspace: true }): Promise<Result<DashboardSnapshot>>;
  cancelRestore(): Promise<Result<{ cancelled: boolean }>>;
  updateDesktopBehavior(input: { stayInTray: boolean; openAtLogin: boolean; notificationsEnabled: boolean }): Promise<Result<{ stayInTray: boolean; openAtLogin: boolean; notificationsEnabled: boolean }>>;
  updateDisplayPreferences(input: DisplayPreferences): Promise<Result<DisplayPreferences>>;
  getAiSettings(): Promise<Result<AiSettings>>;
  updateAiPreferences(input: AiPreferences): Promise<Result<AiPreferences>>;
  updateSchedule(input: UpdateScheduleInput): Promise<Result<DashboardSnapshot>>;
  startLogin(): Promise<Result<{ loginStarted: boolean }>>;
  refreshAccount(): Promise<Result<AccountState>>;
  logoutAccount(): Promise<Result<AccountState>>;
  onAccountStateChanged(listener: (state: AccountState) => void): () => void;
  onSnapshotChanged(listener: (snapshot: DashboardSnapshot) => void): () => void;
  onTrayProcessRequested(listener: () => void): () => void;
  setActionStatus(input: {
    actionId: string;
    status: ActionStatus;
    expectedRevision: number;
  }): Promise<Result<ActionItem>>;
  createAction(input: CreateActionItemInput): Promise<Result<ActionItem>>;
  createManualNote(input: CreateManualNoteInput): Promise<Result<ManualNote>>;
  exportMemberSummary(input: ExportMemberSummaryInput): Promise<Result<ExportMemberSummaryReceipt | null>>;
}

const bridge: HealthDesktopBridge = {
  getBootstrap: () => ipcRenderer.invoke('app:get-bootstrap'),
  getSnapshot: () => ipcRenderer.invoke('dashboard:get-snapshot'),
  getMemberOverview: (personId) => ipcRenderer.invoke('members:get-overview', { personId }),
  listBodySystems: (personId) => ipcRenderer.invoke('body:list-systems', { personId }),
  getConceptReview: (personId) => ipcRenderer.invoke('concepts:get-review', { personId }),
  setConceptMapping: (input) => ipcRenderer.invoke('concepts:set-mapping', input),
  undoConceptMapping: (input) => ipcRenderer.invoke('concepts:undo-mapping', input),
  getBodySystemDetail: (personId, systemId) => ipcRenderer.invoke('body:get-system-detail', { personId, systemId }),
  getMetricSeries: (personId, seriesId) => ipcRenderer.invoke('metrics:get-series', { personId, seriesId }),
  listHealthEvents: (input) => ipcRenderer.invoke('events:list', input),
  getHealthEventDetail: (personId, eventId) => ipcRenderer.invoke('events:get-detail', { personId, eventId }),
  updateReportMetadata: (input) => ipcRenderer.invoke('events:update-metadata', input),
  undoReportMetadata: (input) => ipcRenderer.invoke('events:undo-metadata', input),
  mergeHealthEvents: (input) => ipcRenderer.invoke('events:merge', input),
  splitHealthEvent: (input) => ipcRenderer.invoke('events:split', input),
  undoHealthEventRelation: (input) => ipcRenderer.invoke('events:undo-relation', input),
  getMemberEvidenceBundle: (personId, evidenceIds) => ipcRenderer.invoke('evidence:get-bundle', { personId, evidenceIds }),
  getLifestylePlan: (personId) => ipcRenderer.invoke('guidance:get-plan', { personId }),
  adoptLifestyleProposal: (input) => ipcRenderer.invoke('guidance:adopt-proposal', input),
  setLifestyleProposalDecision: (input) => ipcRenderer.invoke('guidance:set-proposal-decision', input),
  getDiagnosticPreview: () => ipcRenderer.invoke('diagnostics:get-preview'),
  exportDiagnostic: () => ipcRenderer.invoke('diagnostics:export'),
  cleanupExpiredData: () => ipcRenderer.invoke('privacy:cleanup-expired'),
  getEvidence: (input) => ipcRenderer.invoke('documents:get-evidence', input),
  resolveReview: (input) => ipcRenderer.invoke('reviews:resolve', input),
  createWorkspace: (input) => ipcRenderer.invoke('workspace:create', input),
  createPerson: (input) => ipcRenderer.invoke('people:create', input),
  updatePersonDisplay: (input) => ipcRenderer.invoke('people:update-display', input),
  listArchivedPeople: () => ipcRenderer.invoke('people:list-archived'),
  archivePerson: (input) => ipcRenderer.invoke('people:archive', input),
  restorePerson: (input) => ipcRenderer.invoke('people:restore', input),
  setDocumentIncluded: (input) => ipcRenderer.invoke('documents:set-included', input),
  listDeletedDocuments: () => ipcRenderer.invoke('documents:list-deleted'),
  deleteDocument: (input) => ipcRenderer.invoke('documents:delete', input),
  releaseDeletedDocument: (sourceHash) => ipcRenderer.invoke('documents:release-deleted', { sourceHash }),
  switchWorkspace: (mode) => ipcRenderer.invoke('workspace:switch', { mode }),
  selectFiles: (personId) => ipcRenderer.invoke('inbox:select-files', { personId }),
  importDroppedFiles: (personId, files) => ipcRenderer.invoke('inbox:import-dropped', {
    personId,
    paths: files.map((file) => webUtils.getPathForFile(file)).filter(Boolean)
  }),
  pickInboxDirectory: () => ipcRenderer.invoke('inbox:pick-directory'),
  confirmInboxDirectory: (input) => ipcRenderer.invoke('inbox:confirm-directory', input),
  listInboxDirectories: () => ipcRenderer.invoke('inbox:list-directories'),
  disableInboxDirectory: (bindingId) => ipcRenderer.invoke('inbox:disable-directory', { bindingId }),
  processNow: (input) => ipcRenderer.invoke('jobs:process-now', input),
  cancelJob: (jobId) => ipcRenderer.invoke('jobs:cancel', { jobId }),
  retryJob: (jobId) => ipcRenderer.invoke('jobs:retry', { jobId }),
  setQueuePaused: (paused) => ipcRenderer.invoke('jobs:set-queue-paused', { paused }),
  createBackup: (passphrase) => ipcRenderer.invoke('backup:create', { passphrase }),
  pickRestoreBackup: () => ipcRenderer.invoke('backup:pick-restore'),
  restoreBackup: (input) => ipcRenderer.invoke('backup:restore', input),
  cancelRestore: () => ipcRenderer.invoke('backup:cancel-restore'),
  updateDesktopBehavior: (input) => ipcRenderer.invoke('desktop:update-behavior', input),
  updateDisplayPreferences: (input) => ipcRenderer.invoke('display:update-preferences', input),
  getAiSettings: () => ipcRenderer.invoke('ai:get-settings'),
  updateAiPreferences: (input) => ipcRenderer.invoke('ai:update-preferences', input),
  updateSchedule: (input) => ipcRenderer.invoke('schedule:update', input),
  startLogin: () => ipcRenderer.invoke('account:start-login'),
  refreshAccount: () => ipcRenderer.invoke('account:refresh'),
  logoutAccount: () => ipcRenderer.invoke('account:logout'),
  onAccountStateChanged: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, state: AccountState) => listener(state);
    ipcRenderer.on('account:state-changed', handler);
    return () => ipcRenderer.off('account:state-changed', handler);
  },
  onSnapshotChanged: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, snapshot: DashboardSnapshot) => listener(snapshot);
    ipcRenderer.on('dashboard:snapshot-changed', handler);
    return () => ipcRenderer.off('dashboard:snapshot-changed', handler);
  },
  onTrayProcessRequested: (listener) => {
    const handler = () => listener();
    ipcRenderer.on('tray:process-now-requested', handler);
    return () => ipcRenderer.off('tray:process-now-requested', handler);
  },
  setActionStatus: (input) => ipcRenderer.invoke('actions:set-status', input),
  createAction: (input) => ipcRenderer.invoke('actions:create', input),
  createManualNote: (input) => ipcRenderer.invoke('notes:create', input),
  exportMemberSummary: (input) => ipcRenderer.invoke('export:member-summary', input)
};

contextBridge.exposeInMainWorld('healthDesktop', bridge);
