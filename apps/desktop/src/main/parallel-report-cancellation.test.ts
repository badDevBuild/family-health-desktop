import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AccountState, DirectOriginalReadingResult } from '@contracts';
import type { CodexRuntimeManager } from './codex-runtime.js';
import { encodeDirectOriginalReading } from './direct-original-wire.js';
import { ProcessingJobRunner } from './job-runner.js';
import { PersonalWorkspaceService } from './workspace-service.js';

const roots: string[] = [];
const services: PersonalWorkspaceService[] = [];
afterEach(() => {
  services.splice(0).forEach((service) => service.close());
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }));
});

const account: AccountState = {
  status: 'connected', displayLabel: 'synthetic-parallel-cancellation@example.test',
  quota: { status: 'available', primaryUsedPercent: 0, secondaryUsedPercent: null, resetsAt: null },
  runtimeVersion: 'synthetic-parallel-runtime', lastCheckedAt: '2026-10-18T00:00:00Z'
};

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function originalReading(prompt: string): DirectOriginalReadingResult {
  const source = JSON.parse(prompt.split('ORIGINAL_SOURCE_PACKAGE=')[1]!) as {
    documentId: string; nativeText: string; units: Array<{ sourceSpanId: string }>
  };
  const decimal = /LDL-C ([\d.]+)/u.exec(source.nativeText)![1]!;
  const evidence = [{ sourceSpanId: 'e_result', quote: source.nativeText }];
  return {
    schemaVersion: 1, documentId: source.documentId,
    pageReadings: source.units.map((unit) => ({ sourceSpanId: unit.sourceSpanId, status: 'read',
      resultInventory: [{ sourceSpanId: 'e_result', candidateKeys: ['c_result'] }] })),
    sourceExcerpts: [{ localKey: 'e_result', pageSourceSpanId: source.units[0]!.sourceSpanId,
      quote: source.nativeText, role: 'finding', clarity: 'clear' }],
    extraction: {
      schemaVersion: 1, documentId: source.documentId,
      subject: { reportedName: null, confidence: 'absent', evidence: [] }, reportMetadata: null,
      coveredSourceSpanIds: source.units.map((unit) => unit.sourceSpanId),
      candidates: [{ localKey: 'c_result', originalName: 'LDL-C', standardNameCandidate: 'LDL-C',
        value: { kind: 'numeric', rawText: decimal, decimal, comparator: 'eq' }, unitRaw: 'mmol/L',
        referenceRangeRaw: null, reportedAbnormalFlag: null, specimen: null, method: null, bodySite: null,
        clinicalDate: null, evidence, sourceBinding: { headingEvidence: [], findingEvidence: evidence },
        clinicalContext: { version: 1, status: 'complete', conditions: [] }, issues: [] }]
    }
  };
}

function readAttempt(service: PersonalWorkspaceService) {
  const db = new Database(service.store.databasePath, { readonly: true });
  try {
    return db.prepare('SELECT status, finished_at, error_code FROM job_attempts ORDER BY rowid DESC LIMIT 1')
      .get() as { status: string; finished_at: string | null; error_code: string | null };
  } finally { db.close(); }
}

describe('并行报告的取消与撤权边界', () => {
  it.each(['cancel', 'consent'] as const)('%s 后先收到一份成功回执，仍等另一份落定再结束 attempt，且不接纳或继续发送', async (gate) => {
    const root = mkdtempSync(join(tmpdir(), 'family-health-parallel-cancellation-')); roots.push(root);
    const service = new PersonalWorkspaceService(root, '合成并行取消工作区', () => new Date('2026-10-18T00:00:00Z'));
    services.push(service);
    const personId = service.ensurePrimaryMember({ displayName: '合成成员', relation: '本人' });
    await service.importFilesAndProcess([1, 2, 3].map((index) => ({
      path: `/tmp/synthetic-cancellation-${index}.txt`, bytes: Buffer.from(`LDL-C 4.${index} mmol/L`)
    })), personId, { accountState: account, consentVersion: 1 });
    const jobId = service.store.listStoredJobs()[0]!.id;
    const bothStarted = deferred();
    const firstReturned = deferred();
    const waits = [deferred(), deferred()];
    const prompts: string[] = [];
    const startedDocuments: string[] = [];
    const interruptActiveTurn = vi.fn(async () => undefined);
    const runtime = {
      getState: () => account,
      interruptActiveTurn,
      runStructuredTurn: async (input: { prompt: string }) => {
        prompts.push(input.prompt);
        // 非 P01 调用也记录后直接失败，不能用替身悄悄完成 P03 或成员综合。
        if (!input.prompt.startsWith('# DIRECT_ORIGINAL_P01\n')) throw new Error('UNEXPECTED_DERIVED_TURN');
        const index = startedDocuments.length;
        const reading = originalReading(input.prompt);
        startedDocuments.push(reading.documentId);
        if (startedDocuments.length === 2) bothStarted.resolve();
        if (!waits[index]) throw new Error('UNEXPECTED_THIRD_DOCUMENT');
        await waits[index]!.promise;
        if (index === 0) firstReturned.resolve();
        return { threadId: `thread:${reading.documentId}`, turnId: `turn:${reading.documentId}`,
          output: encodeDirectOriginalReading(reading) };
      }
    } as unknown as CodexRuntimeManager;
    const finishAttempt = vi.spyOn(service.store, 'finishJobAttempt');
    const runner = new ProcessingJobRunner(runtime, undefined, { reportReads: 2 });
    let finished = false;
    const running = runner.runAvailableJobs(service.store).finally(() => { finished = true; });
    await bothStarted.promise;
    expect(new Set(startedDocuments).size).toBe(2);
    expect(service.store.listAcceptedObservations(personId)).toHaveLength(0);

    if (gate === 'cancel') {
      expect(await runner.cancelJob(service.store, jobId)).toEqual({ running: true, alreadyTerminal: false });
      expect(interruptActiveTurn).toHaveBeenCalledTimes(1);
    } else {
      const db = new Database(service.store.databasePath, { readonly: true });
      const row = db.prepare('SELECT checkpoint_json FROM jobs WHERE id=?').get(jobId) as { checkpoint_json: string };
      db.close();
      service.store.revokeConsent((JSON.parse(row.checkpoint_json) as { consentId: string }).consentId);
      expect(interruptActiveTurn).not.toHaveBeenCalled();
    }

    waits[0]!.resolve(); await firstReturned.promise;
    // 让第一份回执完整穿过提取器和来源/接纳门禁，另一份仍由 deferred 保持运行。
    for (let index = 0; index < 40; index++) await Promise.resolve();
    expect(finished).toBe(false);
    expect(finishAttempt).not.toHaveBeenCalled();
    expect(readAttempt(service)).toMatchObject({ status: 'running', finished_at: null });
    expect(startedDocuments).toHaveLength(2);
    expect(service.store.listAcceptedObservations(personId)).toHaveLength(0);
    expect(service.store.listMemberAssessmentSnapshots(personId, true)).toHaveLength(0);

    waits[1]!.resolve(); await running;
    expect(finished).toBe(true);
    expect(finishAttempt).toHaveBeenCalledTimes(1);
    const expectedStatus = gate === 'cancel' ? 'cancelled' : 'waiting_user';
    expect(service.store.listStoredJobs()[0]).toMatchObject({ id: jobId, status: expectedStatus, completedUnits: 0 });
    expect(readAttempt(service)).toMatchObject({ status: expectedStatus, finished_at: expect.any(String) });
    expect(service.store.listAcceptedObservations(personId)).toHaveLength(0);
    expect(service.store.listMemberAssessmentSnapshots(personId, true)).toHaveLength(0);
    expect(service.store.listImportedDocuments()).toHaveLength(3);
    expect(prompts).toHaveLength(2);
    expect(prompts.every((prompt) => prompt.startsWith('# DIRECT_ORIGINAL_P01\n'))).toBe(true);
    await runner.runAvailableJobs(service.store);
    expect(prompts).toHaveLength(2);
  });
});
