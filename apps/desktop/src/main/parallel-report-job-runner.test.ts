import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type AccountState, type AssessmentRequestV3, type DirectOriginalReadingResult,
  type MemberAssessmentCandidateV3, type MemberEvidencePackageV3 } from '@contracts';
import { PersonalWorkspaceService } from './workspace-service.js';
import { ProcessingJobRunner } from './job-runner.js';
import type { CodexRuntimeManager } from './codex-runtime.js';
import { CodexTurnFailure } from './codex-turn-failure.js';
import Database from 'better-sqlite3';
import { expandMemberEvidence } from './member-evidence-transport.js';
import { encodeDirectOriginalReading } from './direct-original-wire.js';

const directories: string[] = [];
const services: PersonalWorkspaceService[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  services.splice(0).forEach((service) => service.close());
  directories.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true }));
});
const account: AccountState = { status: 'connected', displayLabel: 'synthetic-parallel@example.test',
  quota: { status: 'available', primaryUsedPercent: 0, secondaryUsedPercent: null, resetsAt: null },
  runtimeVersion: 'synthetic-parallel-runtime', lastCheckedAt: '2026-10-18T00:00:00Z' };
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}
function promptValue<T>(prompt: string, key: string, nextKey?: string): T {
  const value = prompt.split(`${key}=`)[1]!;
  return JSON.parse(nextKey ? value.split(`\n${nextKey}=`)[0]! : value) as T;
}
function originalReading(prompt: string): DirectOriginalReadingResult {
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
function assessment(prompt: string): MemberAssessmentCandidateV3 {
  const request = promptValue<AssessmentRequestV3>(prompt, 'ASSESSMENT_REQUEST', 'MEMBER_EVIDENCE_PACKAGE');
  const packet = expandMemberEvidence(promptValue(prompt, 'MEMBER_EVIDENCE_PACKAGE')) as MemberEvidencePackageV3;
  return { schemaVersion: 3, personId: request.personId, inputSignature: request.inputSignature,
    mode: request.mode, requestedSystemIds: request.requestedSystemIds,
    overview: { id: 'overview', headline: '血脂结果已记录', summary: '现有资料提供血脂测量，未提供完整临床背景。',
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
function review(prompt: string) {
  const request = promptValue<{ personId: string; inputSignature: string; targets: string[]; reasons: string[] }>(
    prompt, 'REVIEW_REQUEST', 'SOURCE_CONTEXT');
  // 缺失断言需来源核对；把 P04 与只生成一次候选的 P02 分开计数。
  expect(request.targets).toContain('claim_result');
  expect(request.reasons).toContain('limitation_source_consistency:claim_result');
  return { schemaVersion: 1, personId: request.personId, inputSignature: request.inputSignature,
    results: request.targets.map((targetId) => ({ targetId, verdict: 'pass',
      reason: '合成来源中的缺失断言核对通过。', replacement: null })) };
}
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'family-health-parallel-runner-')); directories.push(root);
  let now = Date.parse('2026-10-18T00:00:00Z');
  const service = new PersonalWorkspaceService(root, '合成并行工作区', () => new Date(now)); services.push(service);
  const personId = service.ensurePrimaryMember({ displayName: '合成成员', relation: '本人' });
  await service.importFilesAndProcess([1, 2, 3].map((item) => ({ path: `/tmp/synthetic-parallel-${item}.txt`,
    bytes: Buffer.from(`LDL-C 4.${item} mmol/L`) })), personId, { accountState: account, consentVersion: 1 });
  return { service, personId, advance: () => { now += 30_000; } };
}

describe('正式报告任务的两路读取', () => {
  it('待提交证明的第二份先独占恢复，不能让原列表第一份抢先推进事实版本', async () => {
    const { service, personId } = await fixture();
    const ids = service.store.listStoredJobs()[0]!.documentIds;
    // 存储层单独验证真实断点筛选；这里验证调度器确实等待提示指向的报告完成。
    vi.spyOn(service.store, 'getJobSourceRefinementResumeDocumentIds').mockReturnValue([ids[1]!]);
    const priority = deferred(); const priorityStarted = deferred(); const started: string[] = [];
    const runtime = { getState: () => account, runStructuredTurn: async (input: { prompt: string }) => {
      if (input.prompt.includes('\nREVIEW_REQUEST=')) return {
        threadId: 'synthetic-review', turnId: 'synthetic-review', output: review(input.prompt) };
      if (!input.prompt.startsWith('# DIRECT_ORIGINAL_P01\n')) return {
        threadId: 'synthetic-assessment', turnId: 'synthetic-assessment', output: assessment(input.prompt) };
      const reading = originalReading(input.prompt); started.push(reading.documentId);
      if (reading.documentId === ids[1]) { priorityStarted.resolve(); await priority.promise; }
      else expect(service.store.listAcceptedObservations(personId).some((fact) => fact.documentId === ids[1])).toBe(true);
      return { threadId: `thread:${reading.documentId}`, turnId: `turn:${reading.documentId}`,
        output: encodeDirectOriginalReading(reading) };
    } } as unknown as CodexRuntimeManager;
    const running = new ProcessingJobRunner(runtime, undefined, { reportReads: 2 }).runAvailableJobs(service.store);
    await priorityStarted.promise; expect(started).toEqual([ids[1]]);
    priority.resolve(); await running;
    expect(started[0]).toBe(ids[1]); expect(started).toHaveLength(3);
    expect(service.store.listStoredJobs()[0]).toMatchObject({ status: 'succeeded', completedUnits: 3 });
  });

  it('两份读取重叠且乱序完成，第三份等空位，综合只在三份全部接纳后运行一次', async () => {
    const { service, personId } = await fixture();
    const waits = [deferred(), deferred(), deferred()];
    const secondStarted = deferred(); const thirdStarted = deferred();
    const started: string[] = []; let assessmentCalls = 0; let reviewCalls = 0;
    const runtime = { getState: () => account, runStructuredTurn: async (input: { prompt: string }) => {
      if (input.prompt.startsWith('# DIRECT_ORIGINAL_P01\n')) {
        const index = started.length; const reading = originalReading(input.prompt); started.push(reading.documentId);
        if (index === 1) secondStarted.resolve(); if (index === 2) thirdStarted.resolve();
        await waits[index]!.promise;
        return { threadId: `thread:${reading.documentId}`, turnId: `turn:${reading.documentId}`,
          output: encodeDirectOriginalReading(reading) };
      }
      if (input.prompt.includes('\nREVIEW_REQUEST=')) {
        reviewCalls++;
        expect(service.store.listAcceptedObservations(personId)).toHaveLength(3);
        return { threadId: 'synthetic-review', turnId: 'synthetic-review', output: review(input.prompt) };
      }
      assessmentCalls++;
      const packet = expandMemberEvidence(promptValue(input.prompt, 'MEMBER_EVIDENCE_PACKAGE')) as MemberEvidencePackageV3;
      // 传输层将实际文档 ID 替换为请求内引用，验证三份来源均在当前综合输入中。
      expect(new Set(packet.facts.map((fact) => fact.documentId)).size).toBe(3);
      expect(packet.facts).toHaveLength(3);
      return { threadId: 'synthetic-assessment', turnId: 'synthetic-assessment', output: assessment(input.prompt) };
    } } as unknown as CodexRuntimeManager;
    const running = new ProcessingJobRunner(runtime, undefined, { reportReads: 2 }).runAvailableJobs(service.store);
    await secondStarted.promise;
    expect(started).toHaveLength(2); expect(service.store.listAcceptedObservations(personId)).toHaveLength(0);
    waits[1]!.resolve(); await thirdStarted.promise;
    expect(service.store.listAcceptedObservations(personId)).toHaveLength(1);
    expect(assessmentCalls).toBe(0); expect(reviewCalls).toBe(0);
    waits[2]!.resolve(); waits[0]!.resolve(); await running;
    expect(assessmentCalls).toBe(1); expect(reviewCalls).toBe(1);
    expect(service.store.listAcceptedObservations(personId)).toHaveLength(3);
    const diagnostics = new Database(service.store.databasePath, { readonly: true });
    const attempts = diagnostics.prepare('SELECT status, error_code FROM job_attempts').all(); diagnostics.close();
    expect(attempts).toEqual([{ status: 'succeeded', error_code: null }]);
    expect(service.store.listStoredJobs()[0]).toMatchObject({ status: 'succeeded', completedUnits: 3 });
    expect(service.store.listMemberAssessmentSnapshots(personId, true)[0]?.factRevision).toBe(service.store.getFactRevision(personId));
  });

  it('繁忙后不启动第三份，等待另一份落定保留结果，有限续跑以受限读取配置跳过已完成资料', async () => {
    const { service, personId, advance } = await fixture();
    const fail = deferred(); const peer = deferred(); const bothStarted = deferred();
    const retryFirst = deferred(); const retryStarted = deferred();
    const initialDocuments: string[] = []; const resumedDocuments: string[] = [];
    let retrying = false; let finished = false;
    const runtime = { getState: () => account, runStructuredTurn: async (input: { prompt: string }) => {
      if (input.prompt.includes('\nREVIEW_REQUEST=')) return {
        threadId: 'synthetic-review', turnId: 'synthetic-review', output: review(input.prompt) };
      if (!input.prompt.startsWith('# DIRECT_ORIGINAL_P01\n')) return {
        threadId: 'synthetic-assessment', turnId: 'synthetic-assessment', output: assessment(input.prompt) };
      const reading = originalReading(input.prompt);
      if (!retrying) {
        const index = initialDocuments.length; initialDocuments.push(reading.documentId);
        if (index === 1) bothStarted.resolve();
        if (index === 0) { await fail.promise; throw new CodexTurnFailure({ code: 'CODEX_MODEL_BUSY' }); }
        await peer.promise;
      } else {
        resumedDocuments.push(reading.documentId);
        if (resumedDocuments.length === 1) { retryStarted.resolve(); await retryFirst.promise; }
      }
      return { threadId: `thread:${reading.documentId}`, turnId: `turn:${reading.documentId}`,
        output: encodeDirectOriginalReading(reading) };
    } } as unknown as CodexRuntimeManager;
    const runner = new ProcessingJobRunner(runtime, undefined, { reportReads: 2 });
    const running = runner.runAvailableJobs(service.store).finally(() => { finished = true; });
    await bothStarted.promise; fail.resolve(); await Promise.resolve(); await Promise.resolve();
    expect(finished).toBe(false); expect(initialDocuments).toHaveLength(2);
    peer.resolve(); await running;
    expect(initialDocuments).toHaveLength(2);
    expect(service.store.listStoredJobs()[0]).toMatchObject({ status: 'retry_wait', completedUnits: 1 });
    expect(service.store.listAcceptedObservations(personId)).toHaveLength(1);
    retrying = true; advance();
    // 换进程保留重试断点；此例显式限制读取为单路，实际自动升降由 runtime 池单独验证。
    const resumed = new ProcessingJobRunner(runtime, undefined, { reportReads: 1 }).runAvailableJobs(service.store);
    await retryStarted.promise; expect(resumedDocuments).toHaveLength(1);
    retryFirst.resolve(); await resumed;
    expect(resumedDocuments).toHaveLength(2); expect(resumedDocuments).not.toContain(initialDocuments[1]);
    expect(service.store.listAcceptedObservations(personId)).toHaveLength(3);
    expect(service.store.listStoredJobs()[0]).toMatchObject({ status: 'succeeded', completedUnits: 3 });
  });

  it.each([
    ['ENOSPC', 'LOCAL_STORAGE_FULL'], ['SQLITE_CORRUPT', 'SQLITE_CORRUPT']
  ])('模型先繁忙、另一份随后发生 %s 时不能掩盖故障或自动重试', async (message, expectedCode) => {
    const { service } = await fixture();
    const fail = deferred(); const peer = deferred(); const bothStarted = deferred();
    let calls = 0; let finished = false;
    const runtime = { getState: () => account, runStructuredTurn: async () => {
      const index = calls++; if (index === 1) bothStarted.resolve();
      if (index === 0) { await fail.promise; throw new CodexTurnFailure({ code: 'CODEX_MODEL_BUSY' }); }
      await peer.promise; throw new Error(message);
    } } as unknown as CodexRuntimeManager;
    const running = new ProcessingJobRunner(runtime, undefined, { reportReads: 2 }).runAvailableJobs(service.store).finally(() => { finished = true; });
    await bothStarted.promise; fail.resolve(); await Promise.resolve(); await Promise.resolve();
    expect(finished).toBe(false); expect(calls).toBe(2);
    peer.resolve(); await running;
    expect(calls).toBe(2); expect(service.store.listStoredJobs()[0]).toMatchObject({ status: 'failed', completedUnits: 0 });
    const db = new Database(service.store.databasePath, { readonly: true });
    try { expect(db.prepare('SELECT status, error_code FROM job_attempts').all())
      .toEqual([{ status: 'failed', error_code: expectedCode }]); }
    finally { db.close(); }
  });
});
