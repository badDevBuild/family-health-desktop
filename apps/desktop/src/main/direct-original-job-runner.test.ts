import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { stableHash } from '@core';
import { type AccountState, type AssessmentRequestV3, type DirectOriginalReadingResult,
  type MemberAssessmentCandidateV3, type MemberEvidencePackageV3 } from '@contracts';
import { PersonalWorkspaceService } from './workspace-service.js';
import { ProcessingJobRunner } from './job-runner.js';
import type { CodexRuntimeManager } from './codex-runtime.js';
import { expandMemberEvidence } from './member-evidence-transport.js';
import { encodeDirectOriginalReading, encodeDirectOriginalRepair } from './direct-original-wire.js';
import { decodeDirectOriginalInput } from './direct-original-input.js';

const directories: string[] = [];
const services: PersonalWorkspaceService[] = [];
afterEach(() => {
  services.splice(0).forEach((service) => service.close());
  directories.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true }));
});
const account: AccountState = { status: 'connected', displayLabel: 'synthetic@example.test',
  quota: { status: 'available', primaryUsedPercent: 0, secondaryUsedPercent: null, resetsAt: null },
  runtimeVersion: 'synthetic-runtime', lastCheckedAt: '2026-10-14T00:00:00Z' };
function serviceFixture() {
  const root = mkdtempSync(join(tmpdir(), 'family-health-direct-runner-'));
  directories.push(root);
  const service = new PersonalWorkspaceService(root, '合成原件直读工作区', () => new Date('2026-10-14T00:00:00Z'));
  services.push(service);
  const personId = service.ensurePrimaryMember({ displayName: '合成成员', relation: '本人' });
  return { service, personId };
}
function promptValue<T>(prompt: string, key: string, nextKey?: string): T {
  const value = prompt.split(`${key}=`)[1]!;
  return JSON.parse(nextKey ? value.split(`\n${nextKey}=`)[0]! : value) as T;
}

// 仅合成模型替身：来源是测试输入全文，不查询或修改正式报告。队列/准备/存储/综合均用真实入口。
function readingFor(prompt: string): DirectOriginalReadingResult {
  const source = promptValue<{ documentId: string; nativeText: string; units: Array<{ sourceSpanId: string }> }>(prompt, 'ORIGINAL_SOURCE_PACKAGE');
  const decimal = /LDL-C ([\d.]+)/u.exec(source.nativeText)![1]!;
  const evidence = [{ sourceSpanId: 'e_result', quote: source.nativeText }];
  return { schemaVersion: 1, documentId: source.documentId,
    pageReadings: source.units.map((unit) => ({ sourceSpanId: unit.sourceSpanId, status: 'read',
      resultInventory: [{ sourceSpanId: 'e_result', candidateKeys: ['c_result'] }] })),
    sourceExcerpts: [{ localKey: 'e_result', pageSourceSpanId: source.units[0]!.sourceSpanId,
      quote: source.nativeText, role: 'finding', clarity: 'clear' }],
    extraction: { schemaVersion: 1, documentId: source.documentId,
      subject: { reportedName: null, confidence: 'absent', evidence: [] }, reportMetadata: null,
      coveredSourceSpanIds: source.units.map((unit) => unit.sourceSpanId),
      candidates: [{ localKey: 'c_result', originalName: 'LDL-C', standardNameCandidate: 'LDL-C',
        value: { kind: 'numeric', rawText: decimal, decimal, comparator: 'eq' }, unitRaw: 'mmol/L',
        referenceRangeRaw: null, reportedAbnormalFlag: null, specimen: null, method: null, bodySite: null,
        clinicalDate: null, evidence, sourceBinding: { headingEvidence: [], findingEvidence: evidence },
        clinicalContext: { version: 1, status: 'complete', conditions: [] }, issues: [] }] } };
}
function assessmentFor(prompt: string): MemberAssessmentCandidateV3 {
  const request = promptValue<AssessmentRequestV3>(prompt, 'ASSESSMENT_REQUEST', 'MEMBER_EVIDENCE_PACKAGE');
  const packet = expandMemberEvidence(promptValue(prompt, 'MEMBER_EVIDENCE_PACKAGE')) as MemberEvidencePackageV3;
  return { schemaVersion: 3, personId: request.personId, inputSignature: request.inputSignature,
    mode: request.mode, requestedSystemIds: request.requestedSystemIds,
    overview: { id: 'overview', headline: '血脂结果已记录', summary: '当前资料提供血脂测量结果，未提供完整临床背景。',
      claimIds: ['claim_result'], actionIds: [], limitations: [] },
    systems: request.requestedSystemIds.map((systemId) => ({ id: `system:${systemId}`, systemId,
      status: 'insufficient', headline: '现有血脂测量记录', summary: '参考范围与临床日期未提供。',
      claimIds: ['claim_result'], actionIds: [], limitations: [] })),
    claims: [{ id: 'claim_result', topicKey: 'lipid-record', systemIds: request.requestedSystemIds,
      kind: 'source_fact', text: '报告提供 LDL-C 测量结果。', diseaseName: null, diagnosticStatus: null,
      temporalStatus: 'uncertain', evidenceIds: [packet.facts[0]!.observationId], counterEvidenceIds: [],
      trendIds: [], knowledgeBasis: 'not_applicable', knowledgeSourceIds: [], criteriaBasis: null,
      rationale: '原报告测量记录。', materialUncertainty: '临床日期和参考范围未提供。', consequenceLevel: 'routine',
      changeAssessment: { direction: 'uncertain', basis: 'insufficient',
        summary: '暂时不能判断这项结果的前后变化。', reason: '原报告没有提供可确定先后顺序的日期。',
        currentEvidenceIds: [packet.facts[0]!.observationId], previousEvidenceIds: [] } }],
    actions: [], questions: [], knowledgeSources: [] };
}
function reviewFor(prompt: string) {
  const request = promptValue<{ personId: string; inputSignature: string; targets: string[]; reasons: string[] }>(
    prompt, 'REVIEW_REQUEST', 'SOURCE_CONTEXT');
  // 本合成原件确实没给临床日期/参考范围。核对的是缺失断言，而非重复生成 P02。
  expect(request.targets).toContain('claim_result');
  expect(request.reasons).toContain('limitation_source_consistency:claim_result');
  return { schemaVersion: 1, personId: request.personId, inputSignature: request.inputSignature,
    results: request.targets.map((targetId) => ({ targetId, verdict: 'pass',
      reason: '合成来源中的缺失断言核对通过。', replacement: null })) };
}
function runtimeFixture(onTurn?: (input: { prompt: string }) => void,
  transformReading: (reading: DirectOriginalReadingResult) => DirectOriginalReadingResult = reading => reading) {
  const stages: string[] = [];
  const runtime = { getState: () => account, runStructuredTurn: async (input: {
    prompt: string; imagePaths?: string[]; allowWebSearch?: boolean; aiPreferences: { modelId: string; reasoningEffort: string }
  }) => {
    onTurn?.(input);
    expect(input.aiPreferences).toEqual({ modelId: 'gpt-6.1-sol', reasoningEffort: 'medium' });
    const original = input.prompt.startsWith('# DIRECT_ORIGINAL_P01\n');
    const repair = input.prompt.startsWith('# DIRECT_ORIGINAL_P03\n');
    const review = input.prompt.includes('\nREVIEW_REQUEST=');
    stages.push(original ? 'P01' : repair ? 'P03' : review ? 'P04' : 'P02');
    if (repair) {
      const request = decodeDirectOriginalInput('REPAIR_REQUEST', promptValue(input.prompt, 'REPAIR_REQUEST', 'ORIGINAL_SOURCE_PACKAGE')) as {
        documentId: string; originalReadingHash: string; targets: Array<{targetId:string}>; issues: string[];
      };
      return { threadId: `synthetic-thread-${stages.length}`, turnId: `synthetic-turn-${stages.length}`,
        output: encodeDirectOriginalRepair({ schemaVersion: 1, documentId: request.documentId,
          originalReadingHash: request.originalReadingHash,
          results: request.targets.map(target => ({ targetId: target.targetId, action: 'unchanged', replacement: null })) }) };
    }
    if (original) {
      expect(input.allowWebSearch).toBe(false);
      expect(input.prompt).not.toContain('OCR_SOURCE_PACKAGE=');
    } else if (review) expect(input.allowWebSearch).toBe(false);
    else expect(input.prompt).toContain('ASSESSMENT_REQUEST=');
    return { threadId: `synthetic-thread-${stages.length}`, turnId: `synthetic-turn-${stages.length}`,
      output: original ? encodeDirectOriginalReading(transformReading(readingFor(input.prompt)))
        : review ? reviewFor(input.prompt) : assessmentFor(input.prompt) };
  } } as unknown as CodexRuntimeManager;
  return { runtime, stages };
}

async function maintenanceFixture() {
  const fixture = serviceFixture();
  await fixture.service.importFilesAndProcess(['4.1', '4.2'].map((value, index) => ({
    path: `/tmp/合成历史日期${index}.txt`, bytes: Buffer.from(`检查日期：2024-01-02\nLDL-C ${value} mmol/L`)
  })), fixture.personId, { accountState: account, consentVersion: 1 });
  // 合成旧版状态：日期线索已读取但当时未能绑定，没有开放的警告。
  const initial = runtimeFixture(undefined, reading => {
    reading.extraction.candidates[0]!.issues = [{ code: 'clinical_date_not_assignable', message: '合成旧版未对应日期' }];
    return reading;
  });
  await new ProcessingJobRunner(initial.runtime).runAvailableJobs(fixture.service.store);
  const db = new Database(fixture.service.store.databasePath);
  const documentIds = fixture.service.store.listImportedDocuments().map(document => document.id);
  db.prepare("UPDATE health_events_v2 SET clinical_date='2024-01-02',date_precision='day'").run();
  expect(fixture.service.store.listOpenExtractionReviewIssues()).toHaveLength(0);
  expect(fixture.service.store.listDateBindingReviewDocumentCounts().size).toBe(2);
  const oldRevisions = db.prepare('SELECT * FROM observation_revisions ORDER BY observation_id,revision').all();
  const oldFacts = db.prepare('SELECT * FROM observations ORDER BY id').all();
  db.close();
  return { ...fixture, documentIds, oldRevisions, oldFacts };
}

function bindSyntheticDate(reading: DirectOriginalReadingResult): DirectOriginalReadingResult {
  const date = { sourceSpanId: 'e_date', quote: '检查日期：2024-01-02' };
  reading.sourceExcerpts.push({ localKey: date.sourceSpanId, quote: date.quote, role: 'date', clarity: 'clear',
    pageSourceSpanId: reading.pageReadings[0]!.sourceSpanId });
  reading.extraction.reportMetadata = { reportKind: null, title: null, organization: null, campus: null,
    department: null, reportNumber: null, examItems: [],
    times: [{ value: '2024-01-02', precision: 'day', role: 'examined', evidence: [date] }], primaryClinicalTimeIndex: 0 };
  reading.extraction.candidates[0]!.clinicalDate = '2024-01-02';
  reading.extraction.candidates[0]!.evidence = [...reading.extraction.candidates[0]!.evidence, date];
  return reading;
}

describe('无旧警告的显式维护走完整执行与保存链路', () => {
  it('本次仅确认已有结果时仍保存实际读取对账，不虚增事实或制造待核对事项', async () => {
    const { service, personId, documentIds, oldRevisions } = await maintenanceFixture();
    service.processNow({ accountState: account, consentVersion: 1, documentIds: [documentIds[0]!] });
    const job = service.store.listStoredJobs().find(item => item.status === 'queued')!;
    const revision = service.store.getFactRevision(personId);
    const run = runtimeFixture(undefined, reading => {
      reading.extraction.candidates[0]!.issues = [{ code: 'clinical_date_not_assignable', message: '合成来源仍未确认日期关系' }];
      return reading;
    });
    await new ProcessingJobRunner(run.runtime).runAvailableJobs(service.store);
    expect(run.stages).toEqual(['P01', 'P02', 'P04']);
    expect(service.store.getFactRevision(personId)).toBe(revision);
    expect(service.store.listOpenExtractionReviewIssues()).toHaveLength(0);
    const db = new Database(service.store.databasePath, { readonly: true });
    try {
      expect(db.prepare('SELECT * FROM observation_revisions ORDER BY observation_id,revision').all()).toEqual(oldRevisions);
      const audit = db.prepare("SELECT summary FROM audit_events WHERE event_type='report_reading.accounted' AND entity_id=? ORDER BY rowid DESC LIMIT 1")
        .get(documentIds[0]) as {summary:string};
      expect(JSON.parse(audit.summary).jobId).toBe(job.id);
    } finally { db.close(); }
  });

  it('只读取明确选中的已完成报告、按来源补日期并保留旧修订，随后更新综合', async () => {
    const { service, personId, documentIds, oldRevisions } = await maintenanceFixture();
    const selected = documentIds[0]!;
    service.processNow({ accountState: account, consentVersion: 1, documentIds: [selected] });
    const job = service.store.listStoredJobs().find(item => item.status === 'queued')!;
    const rereadIds: string[] = [];
    const run = runtimeFixture(undefined, reading => {
      rereadIds.push(reading.documentId);
      return bindSyntheticDate(reading);
    });
    await new ProcessingJobRunner(run.runtime).runAvailableJobs(service.store);
    expect(rereadIds).toEqual([selected]);
    const diagnostics = new Database(service.store.databasePath, { readonly: true });
    const errors = diagnostics.prepare('SELECT error_code FROM job_attempts WHERE job_id=?').all(job.id);
    diagnostics.close();
    expect(service.store.listStoredJobs().find(item => item.id === job.id)?.stage, JSON.stringify(errors)).toBe('publish');
    expect(run.stages).toEqual(['P01', 'P02', 'P04']);
    expect(service.store.listStoredJobs().find(item => item.id === job.id)?.stage).toBe('publish');
    expect(service.store.listAcceptedObservations(personId)).toHaveLength(2);
    const openIssues = service.store.listOpenExtractionReviewIssues();
    expect(openIssues, JSON.stringify(openIssues.map(issue => issue.reasonCodes))).toHaveLength(0);
    const db = new Database(service.store.databasePath, { readonly: true });
    try {
      expect(db.prepare('SELECT * FROM observation_revisions WHERE revision=1 ORDER BY observation_id,revision').all()).toEqual(oldRevisions);
      expect(db.prepare('SELECT clinical_date FROM observation_revisions WHERE revision=2').all()).toEqual([{ clinical_date: '2024-01-02' }]);
      const audits = db.prepare("SELECT summary FROM audit_events WHERE event_type='report_reading.accounted' AND entity_id=?").all(selected) as {summary:string}[];
      expect(audits.some(row => JSON.parse(row.summary).jobId === job.id)).toBe(true);
      expect(db.prepare('SELECT count(*) AS n FROM review_issues').get()).toEqual({ n: 0 });
    } finally { db.close(); }
    expect(service.store.listMemberAssessmentSnapshots(personId, true)[0]?.factRevision).toBe(service.store.getFactRevision(personId));
  });

  it('旧版无传输的完成收据不再掩盖重核；真正完成的报告在综合失败续跑时不重复读取', async () => {
    const { service, documentIds } = await maintenanceFixture();
    service.processNow({ accountState: account, consentVersion: 1, documentIds: [documentIds[0]!] });
    const job = service.store.listStoredJobs().find(item => item.status === 'queued')!;
    const db = new Database(service.store.databasePath);
    const checkpoint = JSON.parse((db.prepare('SELECT checkpoint_json FROM jobs WHERE id=?').get(job.id) as {checkpoint_json:string}).checkpoint_json);
    db.prepare('UPDATE jobs SET checkpoint_json=? WHERE id=?').run(JSON.stringify({ ...checkpoint,
      completedUnits: 1, processedDocumentIds: job.documentIds,
      documentOutcomes: { [documentIds[0]!]: { outcome: 'published' } } }), job.id);
    db.close();
    expect(service.store.getJobProcessedDocumentIds(job.id).size).toBe(0);
    let failAssessment = true;
    const run = runtimeFixture(input => {
      if (failAssessment && input.prompt.includes('\nASSESSMENT_REQUEST=')) throw new Error('SYNTHETIC_ASSESSMENT_FAILURE');
    }, bindSyntheticDate);
    const runner = new ProcessingJobRunner(run.runtime);
    await runner.runAvailableJobs(service.store);
    const diagnostics = new Database(service.store.databasePath, { readonly: true });
    const errors = diagnostics.prepare('SELECT error_code FROM job_attempts WHERE job_id=?').all(job.id);
    diagnostics.close();
    expect(service.store.listStoredJobs().find(item => item.id === job.id), JSON.stringify(errors)).toMatchObject({ status: 'failed', stage: 'analyze' });
    expect(run.stages).toEqual(['P01']);
    failAssessment = false;
    service.store.retryFailedJob(job.id);
    await runner.runAvailableJobs(service.store);
    expect(run.stages).toEqual(['P01', 'P02', 'P04']);
  });

  it('维护回包无法读取时只记录真实新缺口，原事实保留且无需伪造旧警告', async () => {
    const { service, personId, documentIds, oldRevisions } = await maintenanceFixture();
    service.processNow({ accountState: account, consentVersion: 1, documentIds: [documentIds[0]!] });
    const run = runtimeFixture();
    const original = run.runtime.runStructuredTurn.bind(run.runtime);
    run.runtime.runStructuredTurn = async input => input.prompt.includes('ASSESSMENT_REQUEST=') || input.prompt.includes('REVIEW_REQUEST=')
      ? original(input) : { threadId: 'synthetic-unreadable', turnId: 'synthetic-unreadable', output: { malformed: true } } as never;
    await new ProcessingJobRunner(run.runtime).runAvailableJobs(service.store);
    expect(service.store.listAcceptedObservations(personId)).toHaveLength(2);
    expect(service.store.listOpenExtractionReviewIssues()).toEqual([expect.objectContaining({
      documentId: documentIds[0], severity: 'warning', reasonCodes: expect.arrayContaining(['DIRECT_ORIGINAL_STRUCTURE_INVALID'])
    })]);
    const db = new Database(service.store.databasePath, { readonly: true });
    try { expect(db.prepare('SELECT * FROM observation_revisions ORDER BY observation_id,revision').all()).toEqual(oldRevisions); }
    finally { db.close(); }
  });

  it.each(['missing_guard', 'wrong_account', 'revoked', 'unselected', 'not_extract', 'missing_intent', 'existing_review'] as const)(
    '%s 不得借无旧警告维护绕过授权或遗漏历史疑点', async change => {
      const { service, personId, documentIds, oldRevisions } = await maintenanceFixture();
      service.processNow({ accountState: account, consentVersion: 1, documentIds: [documentIds[0]!] });
      const accountFingerprint = stableHash({ provider: 'codex-chatgpt', displayLabel: account.displayLabel });
      const job = service.store.claimNextQueuedJob('synthetic-maintenance', accountFingerprint)!;
      const guard = { jobId: job.id, attemptId: service.store.startJobAttempt(job.id, 'synthetic'),
        consentId: job.consentId, accountFingerprint };
      const db = new Database(service.store.databasePath);
      if (change === 'wrong_account') guard.accountFingerprint = 'another-account';
      if (change === 'revoked') db.prepare("UPDATE consents SET revoked_at='2026-10-14T00:00:00Z' WHERE id=?").run(job.consentId);
      if (change === 'not_extract') service.store.updateJobStage(job.id, 'analyze');
      if (change === 'missing_intent') db.prepare("UPDATE jobs SET checkpoint_json=json_remove(checkpoint_json,'$.repairDocumentIds') WHERE id=?").run(job.id);
      if (change === 'existing_review') service.store.saveExtractionReviewIssue({ documentId: documentIds[0]!, stage: 'extract',
        kind: 'coverage_gap', severity: 'warning', preserveDocumentStatus: true, evidenceRefs: [], reasonCodes: ['SYNTHETIC_REAL_GAP'] });
      try {
        expect(() => service.store.appendCommittedFacts({ personId, documentId: documentIds[change === 'unselected' ? 1 : 0]!,
          expectedRevision: service.store.getFactRevision(personId), summary: '合成维护权限核查', observations: [],
          reviewUpdate: { issueId: null, remainingCandidates: [], remainingReasonCodes: [], remainingEvidenceRefs: [] },
          ...(change === 'missing_guard' ? {} : { executionGuard: guard }) })).toThrow();
        expect(db.prepare('SELECT * FROM observation_revisions ORDER BY observation_id,revision').all()).toEqual(oldRevisions);
      } finally { db.close(); }
    });
});

describe('正常队列使用原件直读，而不是旧OCR流水线', () => {
  it('模型调用期间账号变化时不接纳回执或继续综合，也不把任务授权转给新账号', async () => {
    const { service, personId } = serviceFixture();
    await service.importFilesAndProcess([{ path: '/tmp/合成账号栅栏.txt', bytes: Buffer.from('LDL-C 4.1 mmol/L') }],
      personId, { accountState: account, consentVersion: 1 });
    let currentAccount = account;
    let calls = 0;
    const runtime = { getState: () => currentAccount, runStructuredTurn: async (input: { prompt: string; expectedAccountFingerprint?: string }) => {
      calls += 1;
      expect(input.expectedAccountFingerprint).toBe(stableHash({ provider: 'codex-chatgpt', displayLabel: account.displayLabel }));
      currentAccount = { ...account, displayLabel: 'another-synthetic-account@example.test' };
      return { threadId: 'synthetic-account-switch', turnId: 'synthetic-account-switch',
        output: encodeDirectOriginalReading(readingFor(input.prompt)) };
    } } as unknown as CodexRuntimeManager;
    const runner = new ProcessingJobRunner(runtime);
    await runner.runAvailableJobs(service.store);
    expect(calls).toBe(1);
    expect(service.store.listStoredJobs()[0]?.status).toBe('waiting_auth');
    expect(service.store.listAcceptedObservations(personId)).toHaveLength(0);
    expect(service.store.listMemberAssessmentSnapshots(personId, true)).toHaveLength(0);
    await runner.runAvailableJobs(service.store);
    expect(calls).toBe(1);
    const database = new Database(service.store.databasePath, { readonly: true });
    try {
      expect(database.prepare('SELECT error_code FROM job_attempts ORDER BY rowid DESC LIMIT 1').get())
        .toEqual({ error_code: 'JOB_AUTH_ACCOUNT_CHANGED' });
    } finally { database.close(); }
  });

  it('续跑前批已隔离报告并延后综合时，仍保留内容缺口终态而不重复读取', async () => {
    const { service, personId } = serviceFixture();
    await service.importFilesAndProcess([{ path: '/tmp/合成已隔离上传.txt', bytes: Buffer.from('合成无法读取的来源') }],
      personId, { accountState: account, consentVersion: 1 });
    const accountFingerprint = stableHash({ provider: 'codex-chatgpt', displayLabel: account.displayLabel });
    const interruptedJob = service.store.claimNextQueuedJob('synthetic-interrupted', accountFingerprint)!;
    const attemptId = service.store.startJobAttempt(interruptedJob.id, 'synthetic-runtime');
    const documentId = interruptedJob.documentIds[0]!;
    service.store.saveExtractionReviewIssue({ documentId, stage: 'extract', kind: 'coverage_gap', severity: 'warning',
      evidenceRefs: [], reasonCodes: ['SYNTHETIC_UNREADABLE_SOURCE'] });
    service.store.markJobDocumentProcessed(interruptedJob.id, documentId, 'partial', {
      jobId: interruptedJob.id, attemptId, consentId: interruptedJob.consentId, accountFingerprint
    });
    service.store.updateJobProgress(interruptedJob.id, 1);
    service.store.finishJob(interruptedJob.id, 'failed');
    service.store.finishJobAttempt({ attemptId, status: 'failed', errorCode: 'SYNTHETIC_INTERRUPTED' });
    service.store.retryFailedJob(interruptedJob.id);
    await service.importFilesAndProcess([{ path: '/tmp/合成续传可靠报告.txt', bytes: Buffer.from('LDL-C 4.2 mmol/L') }],
      personId, { accountState: account, consentVersion: 1 });
    const { runtime, stages } = runtimeFixture();
    await new ProcessingJobRunner(runtime).runAvailableJobs(service.store);
    expect(stages).toEqual(['P01', 'P02', 'P04']);
    expect(service.store.listStoredJobs().find((job) => job.id === interruptedJob.id))
      .toMatchObject({ status: 'completed_with_issues', completedUnits: 1 });
    expect(service.store.listAcceptedObservations(personId)).toHaveLength(1);
    expect(service.store.listMemberAssessmentSnapshots(personId, true)).toHaveLength(1);
  });

  it('同一成员连续上传在队列中自动合并综合，完整提取两批后只生成一次看板', async () => {
    const { service, personId } = serviceFixture();
    await service.importFilesAndProcess([{ path: '/tmp/合成连续上传甲.txt', bytes: Buffer.from('LDL-C 4.1 mmol/L') }],
      personId, { accountState: account, consentVersion: 1 });
    await service.importFilesAndProcess([{ path: '/tmp/合成连续上传乙.txt', bytes: Buffer.from('LDL-C 4.2 mmol/L') }],
      personId, { accountState: account, consentVersion: 1 });
    expect(service.store.listStoredJobs()).toHaveLength(2);
    const { runtime, stages } = runtimeFixture((input) => {
      if (input.prompt.includes('\nASSESSMENT_REQUEST=')) {
        const packet = expandMemberEvidence(promptValue(input.prompt, 'MEMBER_EVIDENCE_PACKAGE')) as MemberEvidencePackageV3;
        expect(packet.facts).toHaveLength(2);
        expect(new Set(packet.facts.map((fact) => fact.documentId)).size).toBe(2);
      }
    });
    await new ProcessingJobRunner(runtime).runAvailableJobs(service.store);
    const database = new Database(service.store.databasePath, { readonly: true });
    const attempts = database.prepare('SELECT error_code FROM job_attempts ORDER BY rowid').all();
    database.close();
    expect(stages, JSON.stringify(attempts)).toEqual(['P01', 'P01', 'P02', 'P04']);
    expect(service.store.listStoredJobs().every((job) => job.status === 'succeeded' && job.completedUnits === 1)).toBe(true);
    expect(service.store.listAcceptedObservations(personId)).toHaveLength(2);
    expect(service.store.listMemberAssessmentSnapshots(personId, true)).toHaveLength(1);
    expect(service.store.listMemberAssessmentSnapshots(personId, true)[0]?.factRevision).toBe(service.store.getFactRevision(personId));
  });

  it('后续上传在前批延期后取消，前批仍自动完成综合而不遗失已接纳结果', async () => {
    const { service, personId } = serviceFixture();
    await service.importFilesAndProcess([{ path: '/tmp/合成前批独立结果.txt', bytes: Buffer.from('LDL-C 4.1 mmol/L') }],
      personId, { accountState: account, consentVersion: 1 });
    await service.importFilesAndProcess([{ path: '/tmp/合成后批取消.txt', bytes: Buffer.from('LDL-C 4.2 mmol/L') }],
      personId, { accountState: account, consentVersion: 1 });
    const { runtime, stages } = runtimeFixture();
    const runner = new ProcessingJobRunner(runtime);
    let cancelled = false;
    let deferredJobId = ''; let cancelledJobId = '';
    runner.on('changed', () => {
      const jobs = service.store.listStoredJobs();
      const deferred = jobs.find((job) => job.stage === 'analyze' && job.status === 'queued');
      if (!cancelled && deferred) {
        cancelled = true;
        deferredJobId = deferred.id;
        cancelledJobId = jobs.find((job) => job.id !== deferred.id)!.id;
        service.store.requestJobCancellation(cancelledJobId);
      }
    });
    await runner.runAvailableJobs(service.store);
    expect(cancelled).toBe(true);
    expect(stages).toEqual(['P01', 'P02', 'P04']);
    expect(service.store.listStoredJobs().find((job) => job.id === deferredJobId)?.status).toBe('succeeded');
    expect(service.store.listStoredJobs().find((job) => job.id === cancelledJobId)?.status).toBe('cancelled');
    expect(service.store.listAcceptedObservations(personId)).toHaveLength(1);
    expect(service.store.listMemberAssessmentSnapshots(personId, true)[0]?.factRevision)
      .toBe(service.store.getFactRevision(personId));
  });

  it.each(['structure', 'identity'] as const)('一份报告%s无法可靠完成时隔离提示，其余报告自动完成综合且无需确认', async (problem) => {
    const { service, personId } = serviceFixture();
    const binding = problem === 'identity' ? service.store.createInboxBinding({
      canonicalPath: directories.at(-1)!, personId, recursive: false, allowScheduledAiProcessing: false,
      accountFingerprint: null, consentVersion: 1
    }) : null;
    await service.importFiles([
      { path: '/tmp/合成无法完成.txt', bytes: Buffer.from('LDL-C 4.1 mmol/L\n合成问题来源') },
      { path: '/tmp/合成可靠结果.txt', bytes: Buffer.from('LDL-C 4.2 mmol/L\n合成可靠来源') }
    ], personId, binding?.id ?? null);
    service.processNow({ accountState: account, consentVersion: 1 });
    let problemDocumentId = ''; let cleanDocumentId = ''; let assessmentCalls = 0; let reviewCalls = 0;
    let badReading: DirectOriginalReadingResult | null = null;
    const runtime = { getState: () => account, runStructuredTurn: async (input: { prompt: string; allowWebSearch?: boolean }) => {
      if (input.prompt.startsWith('# DIRECT_ORIGINAL_P01\n')) {
        const source = promptValue<{ documentId: string; nativeText: string; units: Array<{ sourceSpanId: string }> }>(input.prompt, 'ORIGINAL_SOURCE_PACKAGE');
        const output = readingFor(input.prompt);
        if (source.nativeText.includes('合成问题来源')) {
          problemDocumentId = source.documentId;
          if (problem === 'structure') return { threadId: 'synthetic-invalid', turnId: 'synthetic-invalid', output: { invalid: true } };
          const quote = '受检者：另一合成成员';
          output.sourceExcerpts.push({ localKey: 'e_subject', pageSourceSpanId: source.units[0]!.sourceSpanId,
            quote, role: 'identity', clarity: 'clear' });
          output.extraction.subject = { reportedName: '另一合成成员', confidence: 'explicit', evidence: [{ sourceSpanId: 'e_subject', quote }] };
          badReading = output;
        } else cleanDocumentId = source.documentId;
        return { threadId: `synthetic-original-${source.documentId}`, turnId: `synthetic-original-${source.documentId}`,
          output: encodeDirectOriginalReading(output) };
      }
      if (input.prompt.startsWith('# DIRECT_ORIGINAL_P03\n')) {
        expect(problem).toBe('identity'); expect(badReading).not.toBeNull();
        const request = decodeDirectOriginalInput('REPAIR_REQUEST', promptValue(input.prompt, 'REPAIR_REQUEST', 'ORIGINAL_SOURCE_PACKAGE')) as {
          documentId: string; originalReadingHash: string; targets: Array<{ targetId: string }> };
        return { threadId: 'synthetic-identity-review', turnId: 'synthetic-identity-review', output: encodeDirectOriginalRepair({
          schemaVersion: 1, documentId: request.documentId, originalReadingHash: request.originalReadingHash,
          results: request.targets.map((target) => ({ targetId: target.targetId, action: 'unchanged', replacement: null })) }) };
      }
      if (input.prompt.includes('\nREVIEW_REQUEST=')) {
        reviewCalls += 1;
        return { threadId: 'synthetic-review', turnId: 'synthetic-review', output: reviewFor(input.prompt) };
      }
      assessmentCalls += 1;
      const packet = expandMemberEvidence(promptValue(input.prompt, 'MEMBER_EVIDENCE_PACKAGE')) as MemberEvidencePackageV3;
      expect(packet.facts).toHaveLength(1);
      return { threadId: 'synthetic-comprehensive', turnId: 'synthetic-comprehensive', output: assessmentFor(input.prompt) };
    } } as unknown as CodexRuntimeManager;
    await new ProcessingJobRunner(runtime).runAvailableJobs(service.store);
    const database = new Database(service.store.databasePath, { readonly: true });
    const attempts = database.prepare('SELECT error_code FROM job_attempts ORDER BY rowid').all();
    database.close();
    expect(service.store.listStoredJobs()[0], JSON.stringify(attempts)).toMatchObject({ status: 'completed_with_issues', stage: 'publish', completedUnits: 2, totalUnits: 2 });
    expect(assessmentCalls).toBe(1);
    expect(reviewCalls).toBe(1);
    expect(service.store.listAcceptedObservations(personId).map((fact) => fact.documentId)).toEqual([cleanDocumentId]);
    expect(service.store.isDocumentCommitted(problemDocumentId)).toBe(false);
    expect(service.store.listOpenExtractionReviewIssues()).toHaveLength(1);
    expect(service.store.listOpenExtractionReviewIssues()[0]).toMatchObject({ documentId: problemDocumentId,
      kind: problem === 'identity' ? 'person_conflict' : 'coverage_gap' });
    expect(service.store.listMemberAssessmentSnapshots(personId, true)).toHaveLength(1);
  });

  it('上传时选定成员的脱敏与异名两份报告完整入队接纳，保留原身份且只生成一次综合', async () => {
    const { service, personId } = serviceFixture();
    await service.importFilesAndProcess([
      { path: '/tmp/合成脱敏姓名报告.txt', bytes: Buffer.from('患者姓名：*成员\nLDL-C 4.1 mmol/L') },
      { path: '/tmp/合成异名报告.txt', bytes: Buffer.from('患者姓名：另一合成成员\nLDL-C 4.2 mmol/L') }
    ], personId, { accountState: account, consentVersion: 1 });
    const documents = service.store.listImportedDocuments();
    expect(documents).toHaveLength(2);
    expect(documents.every((document) => service.store.getDocumentExtractionBundle(document.id).personAssignmentBasis === 'user_selected')).toBe(true);
    const stages: string[] = [];
    const runtime = { getState: () => account, runStructuredTurn: async (input: { prompt: string; allowWebSearch?: boolean }) => {
      if (input.prompt.startsWith('# DIRECT_ORIGINAL_P01\n')) {
        stages.push('P01'); expect(input.allowWebSearch).toBe(false);
        const source = promptValue<{ nativeText: string; units: Array<{ sourceSpanId: string }> }>(input.prompt, 'ORIGINAL_SOURCE_PACKAGE');
        const output = readingFor(input.prompt);
        const reportedName = source.nativeText.includes('*成员') ? '*成员' : '另一合成成员';
        const quote = `患者姓名：${reportedName}`;
        output.sourceExcerpts.push({ localKey: 'e_identity', pageSourceSpanId: source.units[0]!.sourceSpanId,
          quote, role: 'identity', clarity: 'clear' });
        output.extraction.subject = { reportedName, confidence: 'explicit', evidence: [{ sourceSpanId: 'e_identity', quote }] };
        return { threadId: `synthetic-selected-${output.documentId}`, turnId: `synthetic-selected-${output.documentId}`,
          output: encodeDirectOriginalReading(output) };
      }
      expect(input.prompt.startsWith('# DIRECT_ORIGINAL_P03\n')).toBe(false);
      if (input.prompt.includes('\nREVIEW_REQUEST=')) {
        stages.push('P04');
        return { threadId: 'synthetic-selected-review', turnId: 'synthetic-selected-review', output: reviewFor(input.prompt) };
      }
      stages.push('P02');
      const packet = expandMemberEvidence(promptValue(input.prompt, 'MEMBER_EVIDENCE_PACKAGE')) as MemberEvidencePackageV3;
      expect(packet.facts).toHaveLength(2);
      // 模型输入使用本轮短引用；只核查两份独立来源，不把永久ID混入模型契约。
      expect(new Set(packet.facts.map((fact) => fact.documentId)).size).toBe(2);
      const output = assessmentFor(input.prompt);
      output.claims[0]!.text = '两份报告均提供 LDL-C 测量结果。';
      output.claims[0]!.evidenceIds = packet.facts.map((fact) => fact.observationId);
      return { threadId: 'synthetic-selected-assessment', turnId: 'synthetic-selected-assessment', output };
    } } as unknown as CodexRuntimeManager;
    await new ProcessingJobRunner(runtime).runAvailableJobs(service.store);
    expect(stages).toEqual(['P01', 'P01', 'P02', 'P04']);
    expect(service.store.listStoredJobs()).toHaveLength(1);
    const diagnosticDatabase = new Database(service.store.databasePath, { readonly: true });
    let attemptDiagnostics: unknown;
    try { attemptDiagnostics = diagnosticDatabase.prepare('SELECT error_code FROM job_attempts ORDER BY rowid').all(); }
    finally { diagnosticDatabase.close(); }
    expect(service.store.listStoredJobs()[0], JSON.stringify(attemptDiagnostics))
      .toMatchObject({ status: 'succeeded', completedUnits: 2, totalUnits: 2, stage: 'publish' });
    const facts = service.store.listAcceptedObservations(personId);
    expect(facts).toHaveLength(2);
    expect(facts.map((fact) => fact.decimalValue).sort()).toEqual(['4.1', '4.2']);
    expect(service.store.listOpenExtractionReviewIssues()).toEqual([]);
    expect(service.store.listImportedDocuments().every((document) => document.status === 'completed')).toBe(true);
    const snapshots = service.store.listMemberAssessmentSnapshots(personId, true);
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]!.factRevision).toBe(service.store.getFactRevision(personId));
    const publishedClaimEvidenceIds = new Set(snapshots[0]!.claims[0]!.evidenceIds);
    expect(snapshots[0]!.evidenceCatalog.filter((ref) => publishedClaimEvidenceIds.has(ref.id))
      .map((ref) => ref.observationId).sort()).toEqual(facts.map((fact) => fact.id).sort());
    const identityQuotes = documents.flatMap((document) => service.store.getDocumentExtractionBundle(document.id).manifest.spans
      .filter((span) => span.modelEvidence?.role === 'identity').map((span) => span.quote));
    expect(new Set(identityQuotes)).toEqual(new Set(['患者姓名：*成员', '患者姓名：另一合成成员']));
    expect(service.store.getDocumentExtractionBundle(documents[0]!.id).confirmedPersonAliases).toEqual([]);
    const database = new Database(service.store.databasePath, { readonly: true });
    try {
      expect(database.prepare("SELECT COUNT(*) AS count FROM audit_events WHERE event_type='document.user_assigned_subject_notice'").get())
        .toEqual({ count: 2 });
    } finally { database.close(); }
  });

  it('真实技术准备→整份P01→真实接纳→P02与缺口P04保存来源和模型，不生成OCR文本', async () => {
    const { service, personId } = serviceFixture();
    await service.importFiles([{ path: '/tmp/合成完整报告.txt', bytes: Buffer.from('LDL-C 4.1 mmol/L\n\n完整报告末行') }], personId);
    const documentId = service.store.listImportedDocuments()[0]!.id;
    expect(service.store.getDocumentExtractionBundle(documentId).manifest.spans.every((span) => span.quote === null)).toBe(true);
    service.processNow({ accountState: account, consentVersion: 1 });
    const { runtime, stages } = runtimeFixture((input) => {
      if (input.prompt.startsWith('# DIRECT_ORIGINAL_P01\n')) expect(input.prompt).toContain('完整报告末行');
    });
    await new ProcessingJobRunner(runtime).runAvailableJobs(service.store);
    expect(stages).toEqual(['P01', 'P02', 'P04']);
    expect(service.store.listStoredJobs()[0], JSON.stringify(service.store.listOpenExtractionReviewIssues().map((issue) => issue.reasonCodes)))
      .toMatchObject({ status: 'succeeded', completedUnits: 1 });
    expect(service.store.listAcceptedObservations(personId)).toHaveLength(1);
    const manifest = service.store.getDocumentExtractionBundle(documentId).manifest;
    expect(manifest.spans.every((span) => !span.visualEvidence)).toBe(true);
    expect(manifest.spans.find((span) => span.modelEvidence)?.modelEvidence).toMatchObject({
      modelId: 'gpt-6.1-sol', engine: 'codex-original-reading-v1', inputKind: 'native_text' });
    expect(service.store.listMemberAssessmentSnapshots(personId, true)[0]).toMatchObject({
      modelId: 'gpt-6.1-sol', reasoningEffort: 'medium', factRevision: service.store.getFactRevision(personId) });
  });

  it('仅保留原件和成员的正常重建后不复用旧OCR定位，真实队列可以完整重跑', async () => {
    const { service, personId } = serviceFixture();
    await service.importFiles([{ path: '/tmp/合成重建报告.txt', bytes: Buffer.from('LDL-C 4.3 mmol/L') }], personId);
    service.processNow({ accountState: account, consentVersion: 1 });
    const first = runtimeFixture();
    await new ProcessingJobRunner(first.runtime).runAvailableJobs(service.store);
    const before = service.store.listProcessingRebuildSources().map((document) => [document.documentId, document.sourceObjectId, document.sha256]);
    const receipt = await service.rebuildProcessingFromSources({ accountState: account, consentVersion: 1,
      expectedSources: service.store.listProcessingRebuildSources()
        .map(({ documentId, personId, sourceObjectId, sha256 }) => ({ documentId, personId, sourceObjectId, sha256 })),
      confirmedRebuildReportResults: true, clearPersonalData: true, confirmedClearPersonalData: true });
    expect(receipt).toMatchObject({ documentCount: 1, personCount: 1, recoveryPointCreated: true });
    expect(service.store.listProcessingRebuildSources().map((document) => [document.documentId, document.sourceObjectId, document.sha256]))
      .toEqual(before);
    expect(service.store.listAcceptedObservations(personId)).toEqual([]);
    const second = runtimeFixture();
    await new ProcessingJobRunner(second.runtime).runAvailableJobs(service.store);
    expect(second.stages).toEqual(['P01', 'P02', 'P04']);
    expect(service.store.listStoredJobs()).toHaveLength(1);
    expect(service.store.listStoredJobs()[0]?.status).toBe('succeeded');
    const database = new Database(service.store.databasePath, { readonly: true });
    try {
      expect(database.pragma('integrity_check', { simple: true })).toBe('ok');
      expect(database.pragma('foreign_key_check')).toEqual([]);
      expect(database.prepare('SELECT COUNT(*) AS count FROM user_notes').get()).toEqual({ count: 0 });
    } finally { database.close(); }
  });
});
