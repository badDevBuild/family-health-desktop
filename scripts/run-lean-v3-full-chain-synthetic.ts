import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { aiReasoningEffortSchema, DEFAULT_AI_PREFERENCES } from '@contracts';
import { EXTRACTION_AI_PREFERENCES } from '../apps/desktop/src/main/job-runner.js';
import { redactSensitiveLog, spawnCodexAppServer } from '../packages/codex-adapter/src/index.js';
import { CodexRuntimeManager } from '../apps/desktop/src/main/codex-runtime.js';
import { MemberAssessmentPipeline } from '../apps/desktop/src/main/member-assessment-pipeline.js';
import { DocumentExtractionPipeline } from '../apps/desktop/src/main/processing-pipeline.js';
import { PersonalWorkspaceService } from '../apps/desktop/src/main/workspace-service.js';
import { ASSESSMENT_VALIDATION_RULES_VERSION } from '../apps/desktop/src/main/assessment-validation.js';
import { CLINICAL_ROUTER_VERSION } from '../apps/desktop/src/main/clinical-review-router.js';
import { ASSESSMENT_PRESENTATION_VERSION, presentMemberAssessment } from '../apps/desktop/src/main/assessment-presentation.js';
import { findProcessNarrativeIssues } from '../apps/desktop/src/main/assessment-content-quality.js';
import { ACCEPTANCE_RULES_VERSION, EXTRACTION_PROMPT_VERSION, MEMBER_ASSESSMENT_PROMPT_VERSION,
  MEMBER_ASSESSMENT_RULES_VERSION, RUNTIME_PROMPT_VERSION } from '../apps/desktop/src/main/prompts/shared.js';
import { syntheticCurrentSymptomPresentationChecks, syntheticSourceFingerprint, syntheticTurnStage } from './synthetic-chain-evidence.js';
import { isSyntheticFamilyCase, syntheticFamilyScenarios, syntheticFamilyInputHash, syntheticFamilyContentChecks,
  syntheticFamilyReviewDocument, SYNTHETIC_REFERENCE_DATE } from './synthetic-family-scenarios.js';

/** 固定哈希的纯合成文本；用当前正式管道实跑 P01＋P02，不读取家庭工作区。 */
const fixtures = {
  'clear-ldl': {
    filename: 'full-chain-ldl.txt',
    sha256: '174709df569fb8d696db9174d2774aa5d5925fb5383ead28a8646f9151507028'
  },
  'documented-fatty-liver': {
    filename: 'full-chain-documented-fatty-liver.txt',
    sha256: '29dbe99346a57936b891ba7870bd6aaff910b659a3cd5fa3eaf79509a9c1c106'
  },
  'partial-thyroid': {
    filename: 'full-chain-partial-thyroid.txt',
    sha256: 'ab0655c2c318b9d415ed893c57d3e93bfd509d1131f01db2e96d80b418c9fd80'
  },
  'current-chest-pain': {
    filename: 'full-chain-current-chest-pain.txt',
    sha256: 'b9230e7aac3c30589fd119f0d0f3efe6bb52cf28f78b2462783af4c36f4031cd'
  },
  ...syntheticFamilyScenarios
} as const;
const requestedCase = process.argv.find((arg) => arg.startsWith('--case='))?.slice('--case='.length) ?? 'clear-ldl';
if (!(requestedCase in fixtures)) throw new Error('UNKNOWN_SYNTHETIC_CASE');
const caseId = requestedCase as keyof typeof fixtures;
const fixture = fixtures[caseId];
const familyCase = isSyntheticFamilyCase(caseId) ? caseId : null;
const familyScenario = familyCase ? syntheticFamilyScenarios[familyCase] : null;
const fixturePath = resolve('packages/evaluation/fixtures', fixture.filename);
const fixtureBytes = readFileSync(fixturePath);
const fixtureSha256 = createHash('sha256').update(fixtureBytes).digest('hex');
if (fixtureSha256 !== fixture.sha256) throw new Error('SYNTHETIC_FIXTURE_HASH_MISMATCH');
const modelId = process.argv.find((arg) => arg.startsWith('--model='))?.slice('--model='.length) ?? DEFAULT_AI_PREFERENCES.modelId;
const reasoningEffort = aiReasoningEffortSchema.parse(
  process.argv.find((arg) => arg.startsWith('--effort='))?.slice('--effort='.length) ?? DEFAULT_AI_PREFERENCES.reasoningEffort
);
const locatedExecutable = process.env.CODEX_EXECUTABLE ?? execFileSync('which', ['codex'], { encoding: 'utf8' }).trim();
const executable = isAbsolute(locatedExecutable) ? locatedExecutable : resolve(process.cwd(), locatedExecutable);
const runtimeVersion = execFileSync(executable, ['--version'], { encoding: 'utf8' }).trim();
const outputDirectory = mkdtempSync(join(tmpdir(), 'fhd-lean-v3-full-chain-synthetic-'));
const sourceFingerprint = syntheticSourceFingerprint(process.cwd());
const workingDirectory = join(outputDirectory, 'codex-workspace');
mkdirSync(workingDirectory, { recursive: true, mode: 0o700 });
const service = new PersonalWorkspaceService(join(outputDirectory, 'synthetic-workspace'), '纯合成 V3 完整链路',
  () => new Date('2026-09-22T00:00:00.000Z'));
const runtimeErrors: string[] = [];
const runtime = new CodexRuntimeManager({ executable, runtimeVersion: null,
  codexHome: process.env.CODEX_HOME ?? resolve(homedir(), '.codex'), workingDirectory,
  requestTimeoutMs: 600_000,
  createClient: (options) => {
    const { client } = spawnCodexAppServer({ ...options, strictConfig: false });
    client.on('stderr', (line) => runtimeErrors.push(redactSensitiveLog(String(line)).slice(0, 500)));
    return client;
  } });
const calls: Array<{ phase: string; index: number; modelId: string; reasoningEffort: string; requestedWebSearch: boolean; actualWebSearchAllowed: false;
  durationMs: number; inputTokens: number | null; outputTokens: number | null; webSearches: number;
  status: 'completed' | 'failed'; errorCode: string | null }> = [];
const receipt: Record<string, unknown> = {
  kind: 'LEAN_V3_FULL_CHAIN_SYNTHETIC', syntheticOnly: true, caseId, runStatus: 'running',
  fixtureSha256, modelId, reasoningEffort, extractionAiPreferences: EXTRACTION_AI_PREFERENCES, runtimeVersion, webSearchAllowed: false,
  ...(familyCase ? { scenarioInputSha256: syntheticFamilyInputHash(familyCase), syntheticScenarioInput: familyScenario,
    presentationSurface: 'service_read_models_used_by_member_pages', visualReviewStatus: 'NOT_REVIEWED' } : {}),
  runtimeProfile: 'app_server_global_login_non_strict_config',
  versions: { EXTRACTION_PROMPT_VERSION, ACCEPTANCE_RULES_VERSION, MEMBER_ASSESSMENT_PROMPT_VERSION,
    MEMBER_ASSESSMENT_RULES_VERSION, RUNTIME_PROMPT_VERSION, ASSESSMENT_VALIDATION_RULES_VERSION,
    CLINICAL_ROUTER_VERSION, ASSESSMENT_PRESENTATION_VERSION },
  sourceFingerprint,
  contentReviewStatus: 'NOT_REVIEWED', clinicalQualityStatus: 'NOT_CLINICIAN_REVIEWED',
  createdAt: new Date().toISOString(), calls
};
function writeReceipt() {
  writeFileSync(join(outputDirectory, 'receipt.json'), `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
}
function recordPhase(stage: string, status: 'started' | 'completed' | 'failed', index: number | null = null) {
  receipt.currentStage = { stage, status, index, at: new Date().toISOString() };
  writeReceipt();
  // 仅输出阶段和序号，不把合成健康正文混入执行日志。
  process.stdout.write(`[${new Date().toISOString()}] ${stage}${index === null ? '' : ` #${index}`} ${status}\n`);
}
writeReceipt();
process.stdout.write(`V3 full-chain running receipt: ${join(outputDirectory, 'receipt.json')}\n`);
let phase: 'P01' | 'P02' = 'P01';
async function runTrackedTurn(input: {
  prompt: string; imagePaths?: string[]; outputSchema: Record<string, unknown>;
  allowWebSearch?: boolean; timeoutMs?: number;
}) {
  const index = calls.length + 1;
  const stage = syntheticTurnStage(phase, input.prompt);
  // 与正式队列一致：--model 只调整成员分析，不悄悄替换事实提取的固定模型。
  const aiPreferences = phase === 'P01' ? EXTRACTION_AI_PREFERENCES : { modelId, reasoningEffort };
  const call = { phase: stage, index, ...aiPreferences, requestedWebSearch: input.allowWebSearch === true,
    actualWebSearchAllowed: false as const, durationMs: 0, inputTokens: null as number | null,
    outputTokens: null as number | null, webSearches: 0,
    status: 'failed' as 'completed' | 'failed', errorCode: null as string | null };
  calls.push(call);
  recordPhase(stage, 'started', index);
  try {
    const turn = await runtime.runStructuredTurn<unknown>({ ...input,
      aiPreferences, allowWebSearch: false,
      timeoutMs: input.timeoutMs ?? 600_000
    });
    call.durationMs = turn.metrics.durationMs;
    call.inputTokens = turn.metrics.inputTokens;
    call.outputTokens = turn.metrics.outputTokens;
    call.webSearches = turn.metrics.webSearches;
    call.status = 'completed';
    writeFileSync(join(outputDirectory, `turn-${index}.json`), `${JSON.stringify(turn.output, null, 2)}\n`, { mode: 0o600 });
    recordPhase(stage, 'completed', index);
    return turn;
  } catch (error) {
    call.errorCode = error instanceof Error ? error.message.split(':')[0] ?? 'UNKNOWN' : 'UNKNOWN';
    recordPhase(stage, 'failed', index);
    throw error;
  }
}

try {
  recordPhase('account', 'started');
  const account = await runtime.refreshAccount();
  if (account.status !== 'connected') throw new Error('CODEX_AUTH_REQUIRED');
  recordPhase('account', 'completed');
  const personId = familyScenario ? service.createMember(familyScenario.member)
    : service.ensurePrimaryMember({ displayName: '合成成员', relation: '本人' });
  if (familyScenario) {
    // 使用与应用相同的补充和计划入口；不篡改已接纳事实或直接插入数据库。
    for (const note of familyScenario.notes) service.createManualNote({ personId, kind: note.kind,
      immutableText: note.text, effectiveDate: note.date, structuredFields: note.fields,
      expectedContextRevision: service.store.getClinicalContextRevision(personId) });
    if (familyScenario.existingPlan) service.createAction({ personId, ...familyScenario.existingPlan });
  }
  recordPhase('import', 'started');
  const imported = await service.importFiles([{ path: `/tmp/纯合成报告-${caseId}.txt`, bytes: fixtureBytes }], personId);
  if (imported.rejected.length > 0) throw new Error('SYNTHETIC_IMPORT_REJECTED');
  const documentId = service.getSnapshot(null).inbox[0]?.id;
  if (!documentId) throw new Error('SYNTHETIC_DOCUMENT_MISSING');
  recordPhase('import', 'completed');
  recordPhase('extraction', 'started');
  const extraction = await new DocumentExtractionPipeline(service.store, { runStructuredTurn: runTrackedTurn }).process(documentId);
  const facts = service.store.listAcceptedObservations(personId);
  receipt.extraction = { status: extraction.status, reason: extraction.status === 'needs_review' ? extraction.reason : null,
    facts: facts.map((fact) => ({ id: fact.id, name: fact.originalName, value: fact.rawText,
      unit: fact.unit, clinicalDate: fact.clinicalDate })) };
  recordPhase('extraction', 'completed');
  if (extraction.status === 'published') {
    if (caseId === 'current-chest-pain') {
      service.createManualNote({
        personId, kind: 'history', immutableText: '本人今天自述持续胸痛并伴出汗。',
        effectiveDate: '2026-09-22', structuredFields: {},
        expectedContextRevision: service.store.getClinicalContextRevision(personId)
      });
      receipt.syntheticManualNote = '本人今天自述持续胸痛并伴出汗。';
    }
    phase = 'P02';
    recordPhase('assessment', 'started');
    const assessment = await new MemberAssessmentPipeline(service.store, { runStructuredTurn: runTrackedTurn },
      undefined, undefined, undefined, modelId, reasoningEffort, SYNTHETIC_REFERENCE_DATE, false).process(personId);
    const snapshot = service.store.listMemberAssessmentSnapshots(personId, true)[0];
    receipt.finalSnapshotPresent = snapshot?.status === 'current';
    if (snapshot) {
      // 冻结发布事务后的终态和只读展示终态；原始回合输出不能充当最终正文。
      const presented = presentMemberAssessment(snapshot);
      for (const [filename, value] of [['published-snapshot.json', snapshot],
        ['presented-snapshot.json', presented]] as const) {
        const bytes = `${JSON.stringify(value, null, 2)}\n`;
        writeFileSync(join(outputDirectory, filename), bytes, { mode: 0o600 });
        receipt[filename] = { path: filename, sha256: createHash('sha256').update(bytes).digest('hex') };
      }
      receipt.finalContentProcessIssues = findProcessNarrativeIssues(presented);
      if (caseId === 'current-chest-pain') {
        receipt.scenarioChecks = syntheticCurrentSymptomPresentationChecks(presented, '2026-09-22');
        receipt.scenarioPassed = Object.values(receipt.scenarioChecks as Record<string, boolean>).every(Boolean);
      }
      if (familyCase) {
        recordPhase('presentation', 'started');
        const systems = service.listBodySystems(personId);
        const events = service.listHealthEvents(personId);
        const readModels = { overview: service.getMemberOverview(personId), systems, events,
          bodyDetails: systems.map((system) => service.getBodySystemDetail(personId, system.id)),
          eventDetails: events.map((event) => service.getHealthEventDetail(personId, event.id)),
          lifestyle: service.getLifestylePlan(personId), assessment: service.getMemberAssessment(personId) };
        const bytes = `${JSON.stringify(readModels, null, 2)}\n`;
        writeFileSync(join(outputDirectory, 'member-page-read-models.json'), bytes, { mode: 0o600 });
        receipt['member-page-read-models.json'] = { path: 'member-page-read-models.json',
          sha256: createHash('sha256').update(bytes).digest('hex') };
        const checks = syntheticFamilyContentChecks(familyCase, { personId, snapshot: presented, readModels, requireDailyLife: true,
          facts: facts.map((fact) => ({ id: fact.id, name: fact.originalName, value: fact.rawText,
            unit: fact.unit, clinicalDate: fact.clinicalDate })), processIssues: findProcessNarrativeIssues(presented) });
        receipt.scenarioChecks = checks;
        receipt.scenarioPassed = checks.every((check) => check.passed);
        receipt.automatedContentCheckStatus = checks.every((check) => check.passed) ? 'PASSED' : 'FAILED';
        // 即使自动检查全过，也必须由独立审阅者阅读最终正文；不自动宣称家庭可用或临床验收。
        writeFileSync(join(outputDirectory, 'content-review.md'),
          syntheticFamilyReviewDocument(familyCase, checks, presented, readModels), { mode: 0o600 });
        recordPhase('presentation', 'completed');
      }
    }
    receipt.assessment = { status: assessment.status,
      reason: assessment.status === 'rejected' ? assessment.reason : null,
      callCount: assessment.callCount,
      headline: snapshot?.overview.headline ?? null, summary: snapshot?.overview.summary ?? null };
    recordPhase('assessment', 'completed');
  }
  receipt.chainPublished = (receipt.extraction as { status: string }).status === 'published'
    && (receipt.assessment as { status?: string } | undefined)?.status === 'published';
  receipt.focusedReviewObserved = calls.some((call) => call.phase === 'P04');
  if (receipt.chainPublished !== true || calls.some((call) => call.webSearches > 0)
    || receipt.finalSnapshotPresent !== true
    || (receipt.finalContentProcessIssues as string[] | undefined)?.length
    || familyCase !== null && receipt.scenarioPassed !== true
    || caseId === 'current-chest-pain' && (receipt.focusedReviewObserved !== true || receipt.scenarioPassed !== true)) process.exitCode = 1;
} catch (error) {
  receipt.errorCode = error instanceof Error ? error.message.split(':')[0] : 'UNKNOWN';
  receipt.runtimeErrors = runtimeErrors.slice(-4);
  process.exitCode = 1;
} finally {
  runtime.shutdown();
  service.close();
  receipt.sourceUnchanged = syntheticSourceFingerprint(process.cwd()).sha256 === sourceFingerprint.sha256;
  if (receipt.sourceUnchanged !== true) process.exitCode = 1;
  receipt.runStatus = process.exitCode ? 'failed' : 'completed';
  receipt.completedAt = new Date().toISOString();
  writeReceipt();
  process.stdout.write(`V3 full-chain receipt: ${join(outputDirectory, 'receipt.json')}\n`);
  process.stdout.write(`Turns: ${calls.length}; chain published: ${receipt.chainPublished === true}\n`);
}
