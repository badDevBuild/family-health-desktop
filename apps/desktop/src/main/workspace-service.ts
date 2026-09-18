import { createHash } from 'node:crypto';
import { basename } from 'node:path';
import type { AccountState, ArchivePersonInput, CreateActionItemInput, CreateManualNoteInput, CreatePersonInput, DashboardSnapshot, DeleteDocumentInput, ImportFilesReceipt, InboxBindingSummary, ObservationCandidate, RestorePersonInput, SetDocumentInclusionInput, UpdatePersonDisplayInput, UpdateScheduleInput } from '@contracts';
import { dashboardSnapshotSchema } from '@contracts';
import { evaluateObservationCandidate, stableHash } from '@core';
import { buildDocxManifest, buildHeicManifest, buildImageManifest, buildPdfManifest, buildTextManifest, decodeText, detectInput, type LegacyDocConverter } from '@ingestion';
import { WorkspaceStore, type AcceptedObservationSummary } from '@storage';
import { determineEligibleSlot, jobInputSignature, nextScheduledRunUtc } from '@workflow';
import { recoveryPointsReferenceSourceHash } from './recovery-point-service.js';

const organNames = [
  ['cardiovascular', '心血管'],
  ['metabolic', '代谢 / 内分泌'],
  ['hepatobiliary', '肝胆'],
  ['renal', '肾脏 / 泌尿'],
  ['digestive', '消化'],
  ['hematology', '血液'],
  ['respiratory', '肺 / 呼吸'],
  ['sensory', '眼 / 五官']
] as const;

type OrganId = typeof organNames[number][0];

const organMatchers: Record<OrganId, RegExp> = {
  cardiovascular: /低密度|高密度|胆固醇|甘油三酯|载脂蛋白|血压|ldl|hdl|cholesterol|triglyceride|apolipoprotein/i,
  metabolic: /血糖|葡萄糖|糖化血红蛋白|胰岛素|甲状腺|促甲状腺|尿酸|glucose|hba1c|insulin|thyroid|tsh|ft3|ft4|uric/i,
  hepatobiliary: /谷丙|谷草|转氨酶|胆红素|白蛋白|球蛋白|碱性磷酸酶|谷氨酰|alt|ast|bilirubin|albumin|globulin|alp|ggt/i,
  renal: /肌酐|尿素|肾小球|尿蛋白|尿微量白蛋白|尿酸|creatinine|urea|egfr|proteinuria|uric/i,
  digestive: /便潜血|幽门螺杆菌|淀粉酶|脂肪酶|胃蛋白酶|fecal|occult blood|helicobacter|amylase|lipase|pepsin/i,
  hematology: /血红蛋白|红细胞|白细胞|血小板|铁蛋白|血清铁|中性粒|淋巴细胞|hemoglobin|rbc|wbc|platelet|ferritin|neutrophil|lymphocyte/i,
  respiratory: /肺活量|肺功能|呼吸|肺结节|一秒率|fev|fvc|spirometry|pulmonary/i,
  sensory: /视力|眼压|眼底|听力|耳鼻喉|vision|intraocular|fundus|hearing|audiometry/i
};

function observationOrgans(observation: AcceptedObservationSummary): OrganId[] {
  return organNames
    .filter(([id]) => organMatchers[id].test(observation.conceptKey))
    .map(([id]) => id);
}

function parseReferenceRange(value: string | null): { low: number | null; high: number | null } {
  if (!value) return { low: null, high: null };
  const match = value.trim().match(/^(-?\d+(?:\.\d+)?)\s*(?:-|–|—|~|至)\s*(-?\d+(?:\.\d+)?)(?:\s.*)?$/);
  if (!match) return { low: null, high: null };
  const low = Number(match[1]);
  const high = Number(match[2]);
  return Number.isFinite(low) && Number.isFinite(high) ? { low, high } : { low: null, high: null };
}

function buildTrendSeries(observations: AcceptedObservationSummary[]) {
  const groups = new Map<string, AcceptedObservationSummary[]>();
  for (const observation of observations) {
    if (observation.valueKind !== 'numeric' || !observation.clinicalDate) continue;
    const contextKey = [observation.specimen, observation.method, observation.bodySite]
      .map((value) => value?.trim().toLocaleLowerCase('zh-CN') ?? '未记录')
      .join('|');
    const key = `${observation.personId}\u0000${observation.conceptKey}\u0000${observation.unit ?? ''}\u0000${contextKey}`;
    const group = groups.get(key) ?? [];
    group.push(observation);
    groups.set(key, group);
  }
  return [...groups.values()].map((group) => {
    const first = group[0]!;
    const points = group
      .map((observation) => {
        const numeric = observation.qualifier === 'eq' && observation.decimalValue !== null
          ? Number(observation.decimalValue)
          : null;
        const range = parseReferenceRange(observation.referenceRange);
        return {
          date: observation.clinicalDate!,
          displayValue: observation.rawText,
          numericValue: numeric !== null && Number.isFinite(numeric) ? numeric : null,
          referenceLow: range.low,
          referenceHigh: range.high,
          abnormalFlag: observation.abnormalFlag,
          sourceLabel: observation.sourceLabel,
          sourceSpanId: observation.sourceSpanId,
          documentId: observation.documentId
        };
      })
      .sort((a, b) => a.date.localeCompare(b.date));
    return {
      id: `trend-${stableHash({ personId: first.personId, concept: first.conceptKey, unit: first.unit, specimen: first.specimen, method: first.method, bodySite: first.bodySite }).slice(0, 20)}`,
      personId: first.personId,
      name: first.conceptKey,
      unit: first.unit,
      interpretation: points.length > 1 ? `已有 ${points.length} 次带日期的数值记录。` : '目前只有 1 次带日期的数值记录，暂不能判断趋势。',
      comparisonNote: `已按相同单位、标本、方法和部位分组；未记录的比较条件不会与已知条件混合。`,
      points
    };
  });
}

function formatLabel(mediaType: string): string {
  const labels: Record<string, string> = {
    'application/pdf': 'PDF',
    'image/jpeg': 'JPEG',
    'image/png': 'PNG',
    'image/heic': 'HEIC',
    'image/heif': 'HEIC',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'Word DOCX',
    'application/msword': 'Word DOC',
    'text/plain': '纯文本'
  };
  return labels[mediaType] ?? mediaType;
}

function normalizeAbnormalFlag(value: string | null) {
  const normalized = value?.trim().toLowerCase();
  if (['high', 'h', '偏高', '升高', '↑'].includes(normalized ?? '')) return 'high' as const;
  if (['low', 'l', '偏低', '降低', '↓'].includes(normalized ?? '')) return 'low' as const;
  if (['positive', '+', '阳性'].includes(normalized ?? '')) return 'positive' as const;
  if (['negative', '-', '阴性'].includes(normalized ?? '')) return 'negative' as const;
  if (['normal', '正常', '未见异常'].includes(normalized ?? '')) return 'normal' as const;
  return 'unknown' as const;
}

export class PersonalWorkspaceService {
  readonly store: WorkspaceStore;

  constructor(
    rootDirectory: string,
    readonly workspaceName: string,
    private readonly now: () => Date = () => new Date(),
    private readonly timeZoneProvider: () => string = () => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
    private readonly legacyDocConverter: LegacyDocConverter | null = null
  ) {
    this.store = new WorkspaceStore({ rootDirectory, now });
    this.store.recoverInterruptedJobs();
    this.store.revokeUnreferencedManualProcessingConsents();
  }

  close(): void {
    this.store.close();
  }

  ensurePrimaryMember(input: { displayName: string; relation: string }): string {
    const existing = this.store.listPersons().find((person) => person.archivedAt === null);
    if (existing) return existing.id;
    return this.store.createPerson(input).id;
  }

  createMember(input: CreatePersonInput): string {
    return this.store.createPerson(input).id;
  }

  updateMemberDisplay(input: UpdatePersonDisplayInput) {
    return this.store.updatePersonDisplay(input);
  }

  listArchivedMembers() {
    return this.store.listPersons().filter((person) => person.archivedAt !== null);
  }

  archiveMember(input: ArchivePersonInput) {
    return this.store.archivePerson(input);
  }

  restoreMember(input: RestorePersonInput) {
    return this.store.restorePerson(input);
  }

  setDocumentIncluded(input: SetDocumentInclusionInput) {
    return this.store.setDocumentIncluded(input);
  }

  listDeletedDocuments() {
    return this.store.listDeletedDocuments();
  }

  async deleteDocument(input: DeleteDocumentInput) {
    const sourceHash = this.store.getDocumentSourceHash(input.documentId);
    const retainedByRecoveryPoint = await recoveryPointsReferenceSourceHash(this.store.rootDirectory, sourceHash);
    return this.store.deleteDocument({ documentId: input.documentId, retainedByRecoveryPoint });
  }

  releaseDeletedDocument(sourceHash: string): void {
    this.store.releaseDeletedDocument(sourceHash);
  }

  createAction(input: CreateActionItemInput) {
    return this.store.createUserAction(input);
  }

  createManualNote(input: CreateManualNoteInput) {
    return this.store.createManualNote(input);
  }

  acceptCorrectedFacts(input: { issueId: string; documentId: string; candidates: ObservationCandidate[] }) {
    const bundle = this.store.getDocumentExtractionBundle(input.documentId);
    const observations = input.candidates.map((candidate) => {
      const outcome = evaluateObservationCandidate(candidate, bundle.manifest, {
        personConsistent: bundle.personAssignmentBasis !== 'legacy',
        overwritesUserLockedValue: false
      });
      if (outcome.decision === 'reject' || outcome.decision === 'needs_review') {
        throw new Error(`CORRECTION_INVALID:${outcome.reasons.join(',')}`);
      }
      const acceptanceId = this.store.saveAcceptanceDecision({
        method: 'user_resolution', actor: 'user', rulesVersion: 'health-acceptance-v2',
        inputSignature: stableHash({ documentId: input.documentId, candidate }),
        outputHash: stableHash({ candidate, outcome }), reviewRef: input.issueId, decision: outcome.decision
      });
      const firstEvidence = candidate.evidence[0]!;
      return {
        conceptKey: candidate.standardNameCandidate ?? candidate.originalName,
        rawText: candidate.value.rawText ?? '',
        valueKind: candidate.value.kind,
        decimalValue: candidate.value.kind === 'numeric' ? candidate.value.decimal : null,
        qualifier: candidate.value.kind === 'numeric' ? candidate.value.comparator : candidate.value.kind === 'qualitative' ? candidate.value.category : null,
        unit: candidate.unitRaw,
        referenceRange: candidate.referenceRangeRaw,
        clinicalDate: candidate.clinicalDate,
        abnormalFlag: normalizeAbnormalFlag(candidate.reportedAbnormalFlag),
        documentId: input.documentId,
        sourceSpanId: firstEvidence.sourceSpanId,
        acceptanceId,
        specimen: candidate.specimen,
        method: candidate.method,
        bodySite: candidate.bodySite,
        evidence: candidate.evidence
      };
    });
    return this.store.publishFacts({
      personId: bundle.personId,
      documentId: input.documentId,
      documentCommitKey: stableHash({
        documentId: input.documentId, sourceSha256: bundle.manifest.sha256,
        normalizerVersion: bundle.manifest.normalizerVersion,
        extractionSchemaVersion: 1, rulesVersion: 'health-acceptance-v2'
      }),
      expectedRevision: this.store.getFactRevision(bundle.personId),
      changeSetHash: stableHash({ documentId: input.documentId, candidates: input.candidates, rulesVersion: 'health-acceptance-v2', actor: 'user' }),
      summary: `用户核对原始依据后修正并接纳 ${observations.length} 条事实`,
      observations,
      resolvedReviewIssueId: input.issueId
    });
  }

  updateActionStatus(input: { actionId: string; status: 'proposed' | 'discussed' | 'planned' | 'completed' | 'dismissed'; expectedRevision: number }) {
    return this.store.updateActionStatus(input);
  }

  createInboxBinding(input: {
    canonicalPath: string;
    personId: string | null;
    recursive: boolean;
    allowScheduledAiProcessing: boolean;
    consentVersion: number;
    accountState: AccountState;
  }): InboxBindingSummary {
    const accountFingerprint = input.accountState.status === 'connected' && input.accountState.displayLabel
      ? stableHash({ provider: 'codex-chatgpt', displayLabel: input.accountState.displayLabel })
      : null;
    return this.store.createInboxBinding({
      canonicalPath: input.canonicalPath,
      personId: input.personId,
      recursive: input.recursive,
      allowScheduledAiProcessing: input.allowScheduledAiProcessing,
      accountFingerprint,
      consentVersion: input.consentVersion
    });
  }

  listInboxBindings(): InboxBindingSummary[] {
    return this.store.listInboxBindings();
  }

  disableInboxBinding(bindingId: string): void {
    this.store.disableInboxBinding(bindingId);
  }

  private timeZone(): string {
    return this.timeZoneProvider();
  }

  getSchedule() {
    const timeZone = this.timeZone();
    const current = this.store.getOrCreateSchedule(timeZone, nextScheduledRunUtc('20:00', timeZone, this.now()));
    if (current.timeZone === timeZone) return current;
    return this.store.updateSchedule({
      enabled: current.enabled,
      localTime: current.localTime,
      timeZone,
      nextRunUtc: nextScheduledRunUtc(current.localTime, timeZone, this.now()),
      expectedRevision: current.revision
    });
  }

  updateSchedule(input: UpdateScheduleInput) {
    const timeZone = this.timeZone();
    return this.store.updateSchedule({
      ...input,
      localTime: input.localTime as `${number}:${number}`,
      timeZone,
      nextRunUtc: nextScheduledRunUtc(input.localTime as `${number}:${number}`, timeZone, this.now())
    });
  }

  runScheduleCheck(accountState: AccountState): { created: boolean; queued: boolean; idempotent: boolean } {
    const now = this.now();
    const schedule = this.getSchedule();
    const accountFingerprint = accountState.status === 'connected' && accountState.displayLabel
      ? stableHash({ provider: 'codex-chatgpt', displayLabel: accountState.displayLabel })
      : null;
    const groups = this.store.listScheduledReadyGroups(null, now.toISOString());
    const slot = determineEligibleSlot({
      id: schedule.id,
      enabled: schedule.enabled,
      localTime: schedule.localTime,
      timeZone: schedule.timeZone,
      revision: schedule.revision,
      lastSlot: schedule.lastSlot
    }, now, true);
    if (!slot) return { created: false, queued: false, idempotent: false };
    const nextRunUtc = nextScheduledRunUtc(schedule.localTime, schedule.timeZone, now);
    if (groups.length === 0) {
      this.store.markScheduleChecked(slot.key, nextRunUtc);
      return { created: false, queued: false, idempotent: false };
    }
    const created = this.store.createScheduledBatch({
      slotKey: slot.key,
      cutoff: slot.observedAtUtc,
      groups: groups.map((group) => ({
        ...group,
        initialStatus: accountFingerprint === null || group.accountFingerprint !== accountFingerprint
          ? 'waiting_auth' as const
          : accountState.quota.status === 'exhausted' || accountState.quota.status === 'unknown'
            ? 'waiting_quota' as const : 'queued' as const,
        inputSignature: jobInputSignature({
          stage: 'extract',
          personId: group.personId,
          sourceRevisionIds: group.documentIds,
          factRevision: this.store.getFactRevision(group.personId),
          contextRevision: 0,
          promptVersion: 'extract-v1',
          rulesVersion: 'acceptance-v1'
        })
      }))
    });
    this.store.markScheduleChecked(slot.key, nextRunUtc);
    return {
      created: !created.idempotent,
      queued: groups.some((group) => accountFingerprint !== null
        && group.accountFingerprint === accountFingerprint
        && !['exhausted', 'unknown'].includes(accountState.quota.status)),
      idempotent: created.idempotent
    };
  }

  processNow(options?: {
    accountState: AccountState;
    consentVersion: number;
    documentIds?: string[];
  }): { batchId: string; idempotent: boolean } {
    const selectedIds = options?.documentIds ? new Set(options.documentIds) : null;
    const processingDocumentIds = options ? this.store.listProcessingDocumentIds() : new Set<string>();
    if (selectedIds && [...selectedIds].some((documentId) => processingDocumentIds.has(documentId))) {
      throw new Error('DOCUMENT_ALREADY_IN_PROCESSING');
    }
    const byPerson = new Map<string, { documentIds: string[]; stage: 'extract' | 'analyze' }>();
    for (const document of this.store.listReadyDocuments()) {
      if (selectedIds && !selectedIds.has(document.id)) continue;
      if (processingDocumentIds.has(document.id)) continue;
      const group = byPerson.get(document.personId) ?? { documentIds: [], stage: 'extract' as const };
      group.documentIds.push(document.id);
      byPerson.set(document.personId, group);
    }
    if (!selectedIds) {
      for (const target of this.store.listDerivedRefreshTargets()) {
        if (processingDocumentIds.has(target.documentId)) continue;
        if (!byPerson.has(target.personId)) {
          byPerson.set(target.personId, { documentIds: [target.documentId], stage: 'analyze' });
        }
      }
    }
    if (byPerson.size === 0) throw new Error('NO_READY_DOCUMENTS');
    if (options && (options.accountState.status !== 'connected' || !options.accountState.displayLabel)) {
      throw new Error('AUTH_REQUIRED');
    }
    const groups = [...byPerson.entries()].map(([personId, group]) => ({
      personId,
      documentIds: group.documentIds,
      stage: group.stage,
      inputSignature: stableHash({
        stage: group.stage,
        personId,
        documentIds: [...group.documentIds].sort(),
        factRevision: this.store.getFactRevision(personId),
        contextRevision: this.store.getClinicalContextRevision(personId),
        promptVersion: 'extract-v1',
        rulesVersion: 'acceptance-v1'
      })
    }));
    const consentId = options
      ? this.store.createManualProcessingConsent({
        documentIds: groups.flatMap((group) => group.documentIds),
        personIds: groups.map((group) => group.personId),
        accountFingerprint: stableHash({ provider: 'codex-chatgpt', displayLabel: options.accountState.displayLabel }),
        version: options.consentVersion
      })
      : null;
    try {
      const created = this.store.createWaitingAuthBatch({
        cutoff: this.now().toISOString(),
        groups,
        initialStatus: options ? 'queued' : 'waiting_auth',
        consentId
      });
      return { batchId: created.batchId, idempotent: created.idempotent };
    } catch (error) {
      if (consentId) this.store.revokeConsent(consentId);
      throw error;
    }
  }

  async importFiles(files: Array<{ path: string; bytes: Uint8Array }>, personId: string | null, bindingId: string | null = null): Promise<ImportFilesReceipt> {
    const receipt: ImportFilesReceipt = {
      selectedCount: files.length,
      importedCount: 0,
      duplicateCount: 0,
      suppressedCount: 0,
      rejected: []
    };
    for (const file of files) {
      const displayName = basename(file.path);
      try {
        const detected = await detectInput(displayName, file.bytes);
        const sourceHash = createHash('sha256').update(detected.bytes).digest('hex');
        if (this.store.isSourceImportSuppressed(sourceHash)) {
          receipt.suppressedCount += 1;
          continue;
        }
        const source = this.store.putSourceObject({
          bytes: detected.bytes,
          mediaType: detected.mediaType,
          displayName
        });
        this.store.registerSourceOccurrence({
          sourceObjectId: source.id,
          bindingId,
          originalPath: file.path,
          displayName
        });
        const document = this.store.registerImportedDocument({
          sourceObjectId: source.id,
          personId,
          assignmentBasis: bindingId ? 'folder_binding' : 'user_selected'
        });
        if (document.duplicate) {
          receipt.duplicateCount += 1;
          continue;
        }
        const createdAt = this.now().toISOString();
        try {
          const common = {
            sourceObjectId: source.id,
            documentId: document.documentId,
            sha256: source.sha256,
            displayName,
            createdAt
          };
          if (detected.kind === 'txt') {
            const decoded = decodeText(detected.bytes);
            this.store.saveSourceManifest(buildTextManifest({ ...common, text: decoded.text }));
          } else if (detected.kind === 'docx') {
            this.store.saveSourceManifest(await buildDocxManifest({ ...common, bytes: detected.bytes }));
          } else if (detected.kind === 'pdf') {
            this.store.saveSourceManifest(await buildPdfManifest({ ...common, bytes: detected.bytes }));
          } else if (detected.kind === 'heic') {
            this.store.saveSourceManifest(await buildHeicManifest({ ...common, mediaType: detected.mediaType, bytes: detected.bytes }));
          } else if (['jpeg', 'png'].includes(detected.kind)) {
            this.store.saveSourceManifest(buildImageManifest({ ...common, mediaType: detected.mediaType }));
          } else if (detected.kind === 'doc') {
            if (!this.legacyDocConverter) throw new Error('LEGACY_DOC_CONVERSION_REQUIRED');
            const converted = await this.legacyDocConverter.convert(detected.bytes);
            const convertedSource = this.store.putSourceObject({
              bytes: converted.bytes,
              mediaType: converted.mediaType,
              displayName: `${displayName}.converted.pdf`
            });
            this.store.registerDocumentConversion({
              documentId: document.documentId,
              convertedSourceObjectId: convertedSource.id,
              converterId: converted.converterId,
              converterVersion: converted.converterVersion,
              executableSha256: converted.executableSha256,
              warnings: ['legacy_doc_layout_may_differ_from_original']
            });
            const manifest = await buildPdfManifest({ ...common, bytes: converted.bytes });
            manifest.normalizerVersion = `${converted.converterId}-${converted.converterVersion}-pdf-v1`;
            manifest.conversionWarnings = [
              `converted_view:${converted.converterId}:${converted.converterVersion}`,
              'legacy_doc_layout_may_differ_from_original',
              ...manifest.conversionWarnings
            ];
            this.store.saveSourceManifest(manifest);
          } else {
            throw new Error('UNSUPPORTED_FORMAT');
          }
          receipt.importedCount += 1;
        } catch (error) {
          this.store.setDocumentStatus(document.documentId, 'blocked');
          throw error;
        }
      } catch (error) {
        receipt.rejected.push({
          displayName,
          code: error instanceof Error ? error.message : 'IMPORT_FAILED'
        });
      }
    }
    return receipt;
  }

  getSnapshot(accountState: AccountState | null = null): DashboardSnapshot {
    const generatedAt = this.now();
    const schedule = this.getSchedule();
    const counts = this.store.listPersonDocumentCounts();
    const storedPersons = this.store.listPersons();
    const activePersonIds = new Set(storedPersons.filter((person) => person.archivedAt === null).map((person) => person.id));
    const imported = this.store.listImportedDocuments().filter((document) => document.personId === null || activePersonIds.has(document.personId));
    const processingDocumentIds = this.store.listProcessingDocumentIds();
    const acceptedObservations = this.store.listAcceptedObservations().filter((observation) => activePersonIds.has(observation.personId));
    const derivedByPerson = new Map(this.store.listCurrentDerivedSnapshots().map((snapshot) => [snapshot.personId, snapshot]));
    const latestDerivedByPerson = new Map(this.store.listLatestDerivedSnapshots().map((snapshot) => [snapshot.personId, snapshot]));
    const persons = storedPersons.filter((person) => person.archivedAt === null).map((person) => {
      const documentCount = counts.get(person.id) ?? 0;
      const pendingCount = imported.filter((document) => document.personId === person.id && document.status === 'queued' && !processingDocumentIds.has(document.id)).length;
      const processingCount = imported.filter((document) => document.personId === person.id && processingDocumentIds.has(document.id)).length;
      const facts = acceptedObservations.filter((observation) => observation.personId === person.id);
      const attentionCount = facts.filter((observation) => ['high', 'low', 'positive'].includes(observation.abnormalFlag)).length;
      const datedFacts = facts.filter((observation) => observation.clinicalDate).map((observation) => observation.clinicalDate!);
      const lastDocumentDate = datedFacts.sort().at(-1) ?? null;
      const derived = latestDerivedByPerson.get(person.id);
      return {
        id: person.id,
        displayName: person.displayName,
        relation: person.relation ?? '家庭成员',
        birthYear: person.birthYear,
        avatarInitial: Array.from(person.displayName)[0] ?? '家',
        lastDocumentDate,
        documentCount,
        acceptedFactCount: facts.length,
        pendingCount,
        attentionCount,
        dataQuality: documentCount > 0 ? 'partial' as const : 'insufficient' as const,
        freshnessLabel: facts.length > 0
          ? `已接纳 ${facts.length} 条有来源事实`
          : processingCount > 0 ? `${processingCount} 份资料已进入处理中心`
            : documentCount > 0 ? `${documentCount} 份资料等待处理` : '尚未导入资料',
        changeSummary: derived?.payload.claims[0]?.title ?? (facts.length > 0
          ? `最近处理已保存 ${facts.length} 条报告事实；健康解释仍需单独生成和复核`
          : processingCount > 0 ? '资料已安全保存在本机，请到处理中心查看进度或恢复失败任务'
            : documentCount > 0 ? '资料已安全保存在本机，尚未形成健康结论' : '可以先添加一份体检或门诊资料'),
        derivedStatus: derived?.status ?? 'unavailable' as const,
        assessmentSummary: derived?.status === 'current' ? derived.payload.claims[0]?.explanation ?? null : null,
        displayRevision: person.displayRevision,
        clinicalContextRevision: person.clinicalContextRevision
      };
    });
    const transmissionStatuses = this.store.listDocumentAiTransmissionStatuses(imported.map((document) => document.id));
    const inbox = imported.map((document) => ({
      id: document.id,
      displayName: document.displayName,
      discoveredAt: document.discoveredAt,
      personId: document.personId,
      personLabel: document.personLabel,
      status: document.status,
      format: formatLabel(document.mediaType),
      sourceLabel: document.sourceLabel,
      sentToAi: transmissionStatuses.get(document.id) !== 'not_sent',
      aiTransmissionStatus: transmissionStatuses.get(document.id) ?? 'not_sent',
      inProcessingCenter: processingDocumentIds.has(document.id),
      issue: document.issue
    }));
    const assignmentReviews = imported
      .filter((document) => document.status === 'needs_review' && document.personId === null)
      .map((document) => ({
        id: `review-${document.id}`,
        personId: null,
        documentId: document.id,
        kind: 'person_conflict' as const,
        severity: 'blocking' as const,
        title: `确认“${document.displayName}”属于谁`,
        description: '这份资料尚未可靠关联到家庭成员。确认之前不会发送给 AI。',
        evidenceRefs: [],
        candidateOptions: [],
        resolutionStatus: 'open' as const
      }));
    const extractionIssues = this.store.listOpenExtractionReviewIssues()
      .filter((issue) => issue.personId === null || activePersonIds.has(issue.personId));
    const extractionDocumentIds = new Set(extractionIssues.map((issue) => issue.documentId));
    const reviews = [
      ...assignmentReviews.filter((issue) => !extractionDocumentIds.has(issue.documentId)),
      ...extractionIssues.map((issue) => ({
        id: issue.id,
        personId: issue.personId,
        documentId: issue.documentId,
        kind: issue.kind,
        severity: issue.severity,
        title: issue.kind === 'field_conflict'
          ? '两次事实核对结果不一致'
          : issue.kind === 'derived_safety' ? '健康说明未通过安全复核' : '资料覆盖需要人工确认',
        description: issue.kind === 'derived_safety'
          ? '报告事实已经安全保存，但分析或生活指南包含需要人工核对的内容，因此没有发布这部分说明。'
          : '为避免把不确定内容写入健康档案，这份资料已暂停并等待你的核对。',
        evidenceRefs: issue.evidenceRefs,
        candidateOptions: issue.candidateOptions,
        resolutionStatus: 'open' as const
      }))
    ];
    return dashboardSnapshotSchema.parse({
      workspaceMode: 'personal',
      workspaceName: this.workspaceName,
      account: accountState ?? {
        status: 'disconnected',
        displayLabel: null,
        quota: { status: 'unknown', primaryUsedPercent: null, secondaryUsedPercent: null, resetsAt: null },
        runtimeVersion: null,
        lastCheckedAt: null
      },
      nextScheduledRun: schedule.enabled ? schedule.nextRunUtc : null,
      scheduleEnabled: schedule.enabled,
      scheduleLocalTime: schedule.localTime,
      scheduleTimeZone: schedule.timeZone,
      scheduleRevision: schedule.revision,
      queuePaused: this.store.isQueuePaused(),
      pendingInboxCount: inbox.filter((item) => !item.inProcessingCenter && ['queued', 'needs_review'].includes(item.status)).length,
      openReviewCount: reviews.length,
      persons,
      organs: persons.flatMap((person) => organNames.map(([id, name]) => {
        const related = acceptedObservations.filter((observation) => observation.personId === person.id && observationOrgans(observation).includes(id));
        const attention = related.filter((observation) => ['high', 'low', 'positive'].includes(observation.abnormalFlag));
        const evidenceDate = related.filter((observation) => observation.clinicalDate).map((observation) => observation.clinicalDate!).sort().at(-1) ?? null;
        const derivedClaim = derivedByPerson.get(person.id)?.payload.claims.find((claim) => claim.organId === id);
        const derivedEvidence = derivedClaim?.evidenceObservationIds
          .map((observationId) => acceptedObservations.find((observation) => observation.id === observationId))
          .find(Boolean);
        return {
          id,
          personId: person.id,
          name,
          status: related.length === 0 ? 'insufficient' as const : attention.length > 0 ? 'attention' as const : 'stable' as const,
          summary: derivedClaim?.explanation ?? (related.length === 0
            ? '尚无经过接纳的相关记录。'
            : attention.length > 0
              ? `已记录 ${related.length} 项，其中 ${attention.length} 项由原报告标记需关注。`
              : `已记录 ${related.length} 项，现有原报告未标记异常。`),
          evidenceDate,
          evidenceSourceSpanId: derivedEvidence?.sourceSpanId ?? related.at(-1)?.sourceSpanId ?? null,
          metricCount: related.length
        };
      })),
      trends: buildTrendSeries(acceptedObservations),
      timeline: [
        ...[...acceptedObservations.reduce((groups, observation) => {
          const group = groups.get(observation.documentId) ?? [];
          group.push(observation);
          groups.set(observation.documentId, group);
          return groups;
        }, new Map<string, AcceptedObservationSummary[]>()).values()].map((sameDocument) => {
          const observation = sameDocument[0]!;
          const date = sameDocument.map((item) => item.clinicalDate).filter((value): value is string => Boolean(value)).sort()[0] ?? null;
          const names = [...new Set(sameDocument.map((item) => item.conceptKey))];
          return {
            id: `event-document-${observation.documentId}`,
            personId: observation.personId,
            date,
            dateLabel: date ?? '报告日期待确认',
            type: 'health_report' as const,
            title: observation.sourceLabel,
            summary: `${sameDocument.length} 条已接纳记录：${names.slice(0, 3).join('、')}${names.length > 3 ? '等' : ''}`,
            sourceLabel: observation.sourceLabel,
            documentId: observation.documentId,
            sourceSpanId: observation.sourceSpanId
          };
        }),
        ...this.store.listManualNotes().filter((note) => activePersonIds.has(note.personId)).map((note) => ({
          id: `event-note-${note.id}`,
          personId: note.personId,
          date: note.effectiveDate,
          dateLabel: note.effectiveDate ?? new Date(note.recordedAt).toISOString().slice(0, 10),
          type: 'manual_note' as const,
          title: '本人补充',
          summary: note.immutableText,
          sourceLabel: '用户填写',
          documentId: null,
          sourceSpanId: null
        }))
      ].sort((a, b) => (b.date ?? '').localeCompare(a.date ?? '')),
      guidance: [...derivedByPerson.values()].filter((snapshot) => activePersonIds.has(snapshot.personId)).flatMap((snapshot) => snapshot.payload.lifestyleGuidance.map((guidance) => ({
        id: guidance.id,
        personId: snapshot.personId,
        title: guidance.title,
        detail: guidance.detail,
        consultProfessional: guidance.consultProfessional,
        evidenceCount: guidance.evidenceObservationIds.length
      }))),
      inbox,
      jobs: this.store.listStoredJobs().map((job) => ({
        ...job,
        canCancel: ['queued', 'running', 'waiting_auth', 'waiting_quota', 'waiting_user', 'retry_wait'].includes(job.status)
          && job.statusText !== '正在安全停止',
        canRetry: job.status === 'failed'
      })),
      reviews,
      actions: this.store.listActionItems().filter((action) => activePersonIds.has(action.personId)),
      notes: this.store.listManualNotes().filter((note) => activePersonIds.has(note.personId)),
      privacyNotice: '资料已保存在本机个人工作区。只有在你连接 Codex 并明确授权范围后，必要内容才会发送给 OpenAI。',
      generatedAt: generatedAt.toISOString()
    });
  }
}
