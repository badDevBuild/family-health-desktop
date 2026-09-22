import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { aiReasoningEffortSchema } from '@contracts';
import { redactSensitiveLog, spawnCodexAppServer } from '../packages/codex-adapter/src/index.js';
import { CodexRuntimeManager } from '../apps/desktop/src/main/codex-runtime.js';
import { MemberAssessmentPipeline } from '../apps/desktop/src/main/member-assessment-pipeline.js';
import { DocumentExtractionPipeline } from '../apps/desktop/src/main/processing-pipeline.js';
import { PersonalWorkspaceService } from '../apps/desktop/src/main/workspace-service.js';

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
  }
} as const;
const requestedCase = process.argv.find((arg) => arg.startsWith('--case='))?.slice('--case='.length) ?? 'clear-ldl';
if (!(requestedCase in fixtures)) throw new Error('UNKNOWN_SYNTHETIC_CASE');
const caseId = requestedCase as keyof typeof fixtures;
const fixture = fixtures[caseId];
const fixturePath = resolve('packages/evaluation/fixtures', fixture.filename);
const fixtureBytes = readFileSync(fixturePath);
const fixtureSha256 = createHash('sha256').update(fixtureBytes).digest('hex');
if (fixtureSha256 !== fixture.sha256) throw new Error('SYNTHETIC_FIXTURE_HASH_MISMATCH');
const modelId = process.argv.find((arg) => arg.startsWith('--model='))?.slice('--model='.length) ?? 'gpt-5.6-sol';
const reasoningEffort = aiReasoningEffortSchema.parse(
  process.argv.find((arg) => arg.startsWith('--effort='))?.slice('--effort='.length) ?? 'medium'
);
const locatedExecutable = process.env.CODEX_EXECUTABLE ?? execFileSync('which', ['codex'], { encoding: 'utf8' }).trim();
const executable = isAbsolute(locatedExecutable) ? locatedExecutable : resolve(process.cwd(), locatedExecutable);
const outputDirectory = mkdtempSync(join(tmpdir(), 'fhd-lean-v3-full-chain-synthetic-'));
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
const calls: Array<{ phase: string; index: number; requestedWebSearch: boolean; actualWebSearchAllowed: false;
  durationMs: number; inputTokens: number | null; outputTokens: number | null; webSearches: number;
  status: 'completed' | 'failed'; errorCode: string | null }> = [];
const receipt: Record<string, unknown> = {
  kind: 'LEAN_V3_FULL_CHAIN_SYNTHETIC', syntheticOnly: true, caseId,
  fixtureSha256, modelId, reasoningEffort, webSearchAllowed: false,
  createdAt: new Date().toISOString(), calls
};
let phase = 'P01';
async function runTrackedTurn(input: {
  prompt: string; imagePaths?: string[]; outputSchema: Record<string, unknown>;
  allowWebSearch?: boolean; timeoutMs?: number;
}) {
  const index = calls.length + 1;
  const stage = input.prompt.includes('REPAIR_REQUEST=') ? `${phase}_P03`
    : input.prompt.includes('REVIEW_REQUEST=') ? 'P04' : phase;
  const call = { phase: stage, index, requestedWebSearch: input.allowWebSearch === true,
    actualWebSearchAllowed: false as const, durationMs: 0, inputTokens: null as number | null,
    outputTokens: null as number | null, webSearches: 0,
    status: 'failed' as 'completed' | 'failed', errorCode: null as string | null };
  calls.push(call);
  try {
    const turn = await runtime.runStructuredTurn<unknown>({ ...input,
      aiPreferences: { modelId, reasoningEffort }, allowWebSearch: false,
      timeoutMs: input.timeoutMs ?? 600_000
    });
    call.durationMs = turn.metrics.durationMs;
    call.inputTokens = turn.metrics.inputTokens;
    call.outputTokens = turn.metrics.outputTokens;
    call.webSearches = turn.metrics.webSearches;
    call.status = 'completed';
    writeFileSync(join(outputDirectory, `turn-${index}.json`), `${JSON.stringify(turn.output, null, 2)}\n`, { mode: 0o600 });
    return turn;
  } catch (error) {
    call.errorCode = error instanceof Error ? error.message.split(':')[0] ?? 'UNKNOWN' : 'UNKNOWN';
    throw error;
  }
}

try {
  const account = await runtime.refreshAccount();
  if (account.status !== 'connected') throw new Error('CODEX_AUTH_REQUIRED');
  const personId = service.ensurePrimaryMember({ displayName: '合成成员', relation: '本人' });
  const imported = await service.importFiles([{ path: `/tmp/纯合成报告-${caseId}.txt`, bytes: fixtureBytes }], personId);
  if (imported.rejected.length > 0) throw new Error('SYNTHETIC_IMPORT_REJECTED');
  const documentId = service.getSnapshot(null).inbox[0]?.id;
  if (!documentId) throw new Error('SYNTHETIC_DOCUMENT_MISSING');
  const extraction = await new DocumentExtractionPipeline(service.store, { runStructuredTurn: runTrackedTurn }).process(documentId);
  const facts = service.store.listAcceptedObservations(personId);
  receipt.extraction = { status: extraction.status, reason: extraction.status === 'needs_review' ? extraction.reason : null,
    facts: facts.map((fact) => ({ name: fact.originalName, value: fact.rawText,
      unit: fact.unit, clinicalDate: fact.clinicalDate })) };
  if (extraction.status === 'published') {
    phase = 'P02';
    const assessment = await new MemberAssessmentPipeline(service.store, { runStructuredTurn: runTrackedTurn },
      undefined, undefined, undefined, modelId, reasoningEffort, '2026-09-22', false).process(personId);
    const snapshot = service.store.listMemberAssessmentSnapshots(personId, true)[0];
    receipt.assessment = { status: assessment.status,
      reason: assessment.status === 'rejected' ? assessment.reason : null,
      callCount: assessment.callCount,
      headline: snapshot?.overview.headline ?? null, summary: snapshot?.overview.summary ?? null };
  }
  receipt.chainPublished = (receipt.extraction as { status: string }).status === 'published'
    && (receipt.assessment as { status?: string } | undefined)?.status === 'published';
  if (receipt.chainPublished !== true || calls.some((call) => call.webSearches > 0)) process.exitCode = 1;
} catch (error) {
  receipt.errorCode = error instanceof Error ? error.message.split(':')[0] : 'UNKNOWN';
  receipt.runtimeErrors = runtimeErrors.slice(-4);
  process.exitCode = 1;
} finally {
  runtime.shutdown();
  service.close();
  writeFileSync(join(outputDirectory, 'receipt.json'), `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
  process.stdout.write(`V3 full-chain receipt: ${join(outputDirectory, 'receipt.json')}\n`);
  process.stdout.write(`Turns: ${calls.length}; chain published: ${receipt.chainPublished === true}\n`);
}
