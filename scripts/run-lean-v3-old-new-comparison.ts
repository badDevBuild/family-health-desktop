import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import type { BodySystemId, ExtractionResult, ObservationCandidate } from '@contracts';
import { aiReasoningEffortSchema } from '@contracts';
import { redactSensitiveLog, spawnCodexAppServer } from '../packages/codex-adapter/src/index.js';
import { completeOldNewComparison } from '../packages/evaluation/src/lean-v3-comparison.js';
import { CodexRuntimeManager } from '../apps/desktop/src/main/codex-runtime.js';
import { MemberAssessmentPipeline } from '../apps/desktop/src/main/member-assessment-pipeline.js';
import { DocumentExtractionPipeline } from '../apps/desktop/src/main/processing-pipeline.js';
import { SystemAnalysisPipeline } from '../apps/desktop/src/main/system-analysis-pipeline.js';
import { PersonalWorkspaceService } from '../apps/desktop/src/main/workspace-service.js';

/** 同一份纯合成已接纳事实：旧系统级生成＋独立复核，对照 V3 单次成员综合。P01 使用固定替身。 */
const modelId = process.argv.find((arg) => arg.startsWith('--model='))?.slice('--model='.length) ?? 'gpt-5.6-sol';
const reasoningEffort = aiReasoningEffortSchema.parse(
  process.argv.find((arg) => arg.startsWith('--effort='))?.slice('--effort='.length) ?? 'medium'
);
const scenarioId = process.argv.find((arg) => arg.startsWith('--case='))?.slice('--case='.length) ?? 'ldl';
const scenarios: Record<string, {
  sourceText: string; originalName: string; rawText: string; quote: string;
  systemId: BodySystemId; value: ObservationCandidate['value']; unitRaw: string | null;
  referenceRangeRaw: string | null; reportedAbnormalFlag: ObservationCandidate['reportedAbnormalFlag'];
}> = {
  ldl: {
    sourceText: '2025-06-10 LDL-C 4.2 mmol/L，参考范围 0-3.4 mmol/L，偏高。此文件仅用于软件测试。',
    originalName: 'LDL-C', rawText: '4.2', quote: '2025-06-10 LDL-C 4.2 mmol/L',
    systemId: 'cardiovascular', value: { kind: 'numeric', rawText: '4.2', decimal: '4.2', comparator: 'eq' },
    unitRaw: 'mmol/L', referenceRangeRaw: '0-3.4 mmol/L', reportedAbnormalFlag: '偏高'
  },
  'documented-fatty-liver': {
    // 合成属性记录在测试回执中，不写进报告正文；否则模型会合理地拒绝把它当临床来源。
    sourceText: '2025-06-10 肝脏彩超小结。诊断：脂肪肝。',
    originalName: '肝脏彩超小结', rawText: '脂肪肝', quote: '2025-06-10 肝脏彩超小结。诊断：脂肪肝。',
    systemId: 'hepatobiliary', value: { kind: 'qualitative', rawText: '脂肪肝', category: '脂肪肝' },
    unitRaw: null, referenceRangeRaw: null, reportedAbnormalFlag: null
  }
};
const scenario = scenarios[scenarioId];
if (!scenario) throw new Error(`UNKNOWN_SYNTHETIC_COMPARISON_CASE:${scenarioId}`);
const locatedExecutable = process.env.CODEX_EXECUTABLE ?? execFileSync('which', ['codex'], { encoding: 'utf8' }).trim();
const executable = isAbsolute(locatedExecutable) ? locatedExecutable : resolve(process.cwd(), locatedExecutable);
const outputDirectory = mkdtempSync(join(tmpdir(), 'fhd-lean-v3-old-new-compare-'));
const workingDirectory = join(outputDirectory, 'codex-workspace');
mkdirSync(workingDirectory, { recursive: true, mode: 0o700 });
const service = new PersonalWorkspaceService(join(outputDirectory, 'synthetic-workspace'), '纯合成新旧流程对照',
  () => new Date('2026-09-22T00:00:00.000Z'));
const runtimeErrors: string[] = [];
const calls: Array<{ stage: string; durationMs: number; inputTokens: number | null;
  outputTokens: number | null; webSearches: number }> = [];
let legacyDraft: { headline: string | null; overview: string | null } | null = null;
const receipt: Record<string, unknown> = {
  kind: 'LEGACY_SYSTEM_VS_LEAN_V3_ASSESSMENT_SYNTHETIC', syntheticOnly: true,
  scope: 'accepted_facts_to_analysis_only_P01_stubbed', scenarioId, createdAt: new Date().toISOString(),
  modelId, reasoningEffort, webSearchAllowed: false, calls
};
const runtime = new CodexRuntimeManager({ executable, runtimeVersion: null,
  codexHome: process.env.CODEX_HOME ?? resolve(homedir(), '.codex'), workingDirectory,
  requestTimeoutMs: 600_000,
  createClient: (options) => {
    const { client } = spawnCodexAppServer({ ...options, strictConfig: false });
    client.on('stderr', (line) => runtimeErrors.push(redactSensitiveLog(String(line)).slice(0, 500)));
    return client;
  } });

async function runTrackedTurn(stage: string, input: {
  prompt: string; outputSchema: Record<string, unknown>; allowWebSearch?: boolean; timeoutMs?: number;
}) {
  if (input.allowWebSearch === true) throw new Error('SYNTHETIC_COMPARISON_SEARCH_MUST_BE_DISABLED');
  const turn = await runtime.runStructuredTurn<unknown>({
    ...input, aiPreferences: { modelId, reasoningEffort }, allowWebSearch: false,
    timeoutMs: input.timeoutMs ?? 600_000
  });
  calls.push({ stage, durationMs: turn.metrics.durationMs, inputTokens: turn.metrics.inputTokens,
    outputTokens: turn.metrics.outputTokens, webSearches: turn.metrics.webSearches });
  if (stage === 'legacy_analysis' && typeof turn.output === 'object' && turn.output !== null) {
    const candidate = turn.output as Record<string, unknown>;
    legacyDraft = {
      headline: typeof candidate.headline === 'string' ? candidate.headline : null,
      overview: typeof candidate.overview === 'string' ? candidate.overview : null
    };
  }
  writeFileSync(join(outputDirectory, `${stage}-candidate.json`), `${JSON.stringify(turn.output, null, 2)}\n`, { mode: 0o600 });
  return turn;
}

try {
  const account = await runtime.refreshAccount();
  if (account.status !== 'connected') throw new Error('CODEX_AUTH_REQUIRED');
  const personId = service.ensurePrimaryMember({ displayName: '合成成员', relation: '本人' });
  const imported = await service.importFiles([{
    path: '/tmp/纯合成检查报告.txt', bytes: Buffer.from(scenario.sourceText, 'utf8')
  }], personId);
  if (imported.rejected.length > 0) throw new Error('SYNTHETIC_IMPORT_REJECTED');
  const documentId = service.getSnapshot(null).inbox[0]?.id;
  if (!documentId) throw new Error('SYNTHETIC_DOCUMENT_MISSING');
  const spans = service.store.getDocumentExtractionBundle(documentId).manifest.spans;
  const spanId = spans[0]?.id;
  if (!spanId) throw new Error('SYNTHETIC_SPAN_MISSING');
  const extraction: ExtractionResult = {
    schemaVersion: 1, documentId,
    subject: { reportedName: null, evidence: [], confidence: 'absent' },
    coveredSourceSpanIds: spans.map((span) => span.id),
    candidates: [{
      localKey: `synthetic-${scenarioId}`, originalName: scenario.originalName,
      standardNameCandidate: scenario.originalName, value: scenario.value,
      unitRaw: scenario.unitRaw, referenceRangeRaw: scenario.referenceRangeRaw,
      reportedAbnormalFlag: scenario.reportedAbnormalFlag,
      specimen: null, method: null, bodySite: null, clinicalDate: '2025-06-10',
      evidence: [{ sourceSpanId: spanId, quote: scenario.quote }], issues: []
    }]
  };
  const extracted = await new DocumentExtractionPipeline(service.store, {
    runStructuredTurn: async () => ({ threadId: 'synthetic-p01-stub', turnId: 'synthetic-p01-stub', output: extraction })
  }).process(documentId);
  if (extracted.status !== 'published') throw new Error(`SYNTHETIC_FACTS_NOT_PUBLISHED:${extracted.status}`);
  const facts = service.store.listAcceptedObservations(personId);
  if (facts.length !== 1 || facts[0]?.rawText !== scenario.rawText) throw new Error('SYNTHETIC_FACTS_MISMATCH');
  receipt.acceptedFacts = facts.map((fact) => ({ name: fact.originalName, value: fact.rawText,
    unit: fact.unit, clinicalDate: fact.clinicalDate }));

  let legacyCall = 0;
  const legacy = await new SystemAnalysisPipeline(service.store, {
    runStructuredTurn: (input) => runTrackedTurn(++legacyCall === 1 ? 'legacy_analysis' : 'legacy_review', input)
  }, undefined, undefined, undefined, modelId).process(personId, scenario.systemId);
  const legacySnapshot = service.store.listSystemAnalysisSnapshots(personId, true)
    .find((snapshot) => snapshot.systemId === scenario.systemId);
  receipt.legacy = { status: legacy.status, reason: legacy.status === 'rejected' ? legacy.reason : null,
    calls: legacyCall, publishedHeadline: legacySnapshot?.headline ?? null,
    publishedOverview: legacySnapshot?.overview ?? null, draft: legacyDraft };

  let v3Call = 0;
  const v3 = await new MemberAssessmentPipeline(service.store, {
    runStructuredTurn: (input) => {
      v3Call += 1; // 失败请求也属于实际调用尝试。
      return runTrackedTurn(input.prompt.includes('REVIEW_REQUEST=') ? 'P04'
        : input.prompt.includes('REPAIR_REQUEST=') ? 'P02_P03' : 'P02', input);
    }
  }, undefined, undefined, undefined, modelId, reasoningEffort, '2026-09-22', false).process(personId);
  const v3Snapshot = service.store.listMemberAssessmentSnapshots(personId, true)[0];
  receipt.v3 = { status: v3.status, reason: v3.status === 'rejected' ? v3.reason : null,
    calls: v3Call, headline: v3Snapshot?.overview.headline ?? null,
    summary: v3Snapshot?.overview.summary ?? null };
  receipt.comparisonComplete = completeOldNewComparison({
    legacyStatus: legacy.status, legacyCalls: legacyCall,
    v3Status: v3.status, v3Calls: v3Call, calls
  });
  if (receipt.comparisonComplete !== true) process.exitCode = 1;
} catch (error) {
  receipt.errorCode = error instanceof Error ? error.message.split(':')[0] : 'UNKNOWN';
  receipt.runtimeErrors = runtimeErrors.slice(-3);
  process.exitCode = 1;
} finally {
  runtime.shutdown();
  service.close();
  writeFileSync(join(outputDirectory, 'receipt.json'), `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
  process.stdout.write(`Old/new comparison receipt: ${join(outputDirectory, 'receipt.json')}\n`);
  process.stdout.write(`Legacy: ${JSON.stringify(receipt.legacy ?? null)}; V3: ${JSON.stringify(receipt.v3 ?? null)}\n`);
}
