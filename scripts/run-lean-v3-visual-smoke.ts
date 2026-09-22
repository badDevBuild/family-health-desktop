import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { createCanvas, GlobalFonts } from '@napi-rs/canvas';
import { aiReasoningEffortSchema } from '@contracts';
import { redactSensitiveLog, spawnCodexAppServer } from '../packages/codex-adapter/src/index.js';
import { CodexRuntimeManager } from '../apps/desktop/src/main/codex-runtime.js';
import { DocumentExtractionPipeline } from '../apps/desktop/src/main/processing-pipeline.js';
import { MemberAssessmentPipeline } from '../apps/desktop/src/main/member-assessment-pipeline.js';
import { PersonalWorkspaceService } from '../apps/desktop/src/main/workspace-service.js';
import { createSyntheticTwoPageScannedPdf } from '../packages/evaluation/src/scanned-pdf-fixture.js';

/** 只用内存生成的虚构 PNG 验证真实 P01 图像链路，不读取家庭工作区或冒称临床准确率。 */
function syntheticImage(): Buffer {
  const fontPath = [
    '/System/Library/Fonts/STHeiti Medium.ttc',
    '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc',
    'C:\\Windows\\Fonts\\msyh.ttc'
  ].find((path) => existsSync(path));
  if (!fontPath || !GlobalFonts.registerFromPath(fontPath, 'SyntheticCJK')) {
    throw new Error('SYNTHETIC_CJK_FONT_UNAVAILABLE');
  }
  const canvas = createCanvas(1400, 1000);
  const context = canvas.getContext('2d');
  context.fillStyle = '#fffefa';
  context.fillRect(0, 0, 1400, 1000);
  context.fillStyle = '#243b30';
  context.font = 'bold 46px SyntheticCJK';
  context.fillText('纯合成体检记录', 80, 100);
  context.font = '32px SyntheticCJK';
  const rows = [
    '姓名：合成成员',
    '检查日期：2025-06-10',
    '低密度脂蛋白胆固醇 LDL-C：4.2 mmol/L；参考范围 0-3.4 mmol/L；偏高',
    '空腹血糖：5.1 mmol/L；参考范围 3.9-6.1 mmol/L',
    '此图仅用于软件测试，不是真实体检报告。'
  ];
  rows.forEach((row, index) => context.fillText(row, 80, 200 + index * 125));
  return canvas.encodeSync('png');
}

const scannedPdf = process.argv.includes('--scanned-pdf');
const fixtureBytes = scannedPdf ? createSyntheticTwoPageScannedPdf() : syntheticImage();
if (process.argv.includes('--fixture-only')) {
  const fixtureDirectory = mkdtempSync(join(tmpdir(), 'fhd-lean-v3-visual-fixture-'));
  const fixturePath = join(fixtureDirectory, scannedPdf ? 'synthetic-two-page-scan.pdf' : 'synthetic-report.png');
  writeFileSync(fixturePath, fixtureBytes, { mode: 0o600 });
  process.stdout.write(`Synthetic visual fixture: ${fixturePath}\n`);
  process.exit(0);
}

const modelId = process.argv.find((arg) => arg.startsWith('--model='))?.slice('--model='.length) ?? 'gpt-5.6-sol';
const fullAssessment = process.argv.includes('--full-assessment');
const reasoningEffort = aiReasoningEffortSchema.parse(
  process.argv.find((arg) => arg.startsWith('--effort='))?.slice('--effort='.length) ?? 'medium'
);
const locatedExecutable = process.env.CODEX_EXECUTABLE ?? execFileSync('which', ['codex'], { encoding: 'utf8' }).trim();
const executable = isAbsolute(locatedExecutable) ? locatedExecutable : resolve(process.cwd(), locatedExecutable);
const outputDirectory = mkdtempSync(join(tmpdir(), 'fhd-lean-v3-visual-smoke-'));
const workingDirectory = join(outputDirectory, 'codex-workspace');
mkdirSync(workingDirectory, { recursive: true, mode: 0o700 });
const service = new PersonalWorkspaceService(join(outputDirectory, 'synthetic-workspace'), '纯合成视觉测试',
  () => new Date('2026-09-22T00:00:00.000Z'));
const runtimeErrors: string[] = [];
const turnErrors: string[] = [];
const runtime = new CodexRuntimeManager({ executable, runtimeVersion: null,
  codexHome: process.env.CODEX_HOME ?? resolve(homedir(), '.codex'), workingDirectory,
  requestTimeoutMs: 600_000,
  createClient: (options) => {
    const { client } = spawnCodexAppServer({ ...options, strictConfig: false });
    client.on('stderr', (line) => runtimeErrors.push(redactSensitiveLog(String(line)).slice(0, 500)));
    client.on('turn/completed', (notification: { turn?: { error?: unknown } }) => {
      if (notification.turn?.error) turnErrors.push(redactSensitiveLog(JSON.stringify(notification.turn.error)).slice(0, 3_000));
    });
    return client;
  } });
const calls: Array<{ stage: 'P01' | 'P01_P03' | 'P02' | 'P02_P03' | 'P04'; durationMs: number; inputTokens: number | null;
  outputTokens: number | null; webSearches: number; imageCount: number }> = [];
const receipt: Record<string, unknown> = {
  kind: scannedPdf ? 'TWO_PAGE_SCANNED_PDF_SYNTHETIC'
    : fullAssessment ? 'P01_P02_IMAGE_SYNTHETIC' : 'P01_IMAGE_ONLY_SYNTHETIC',
  syntheticOnly: true, fixtureSha256: createHash('sha256').update(fixtureBytes).digest('hex'), modelId, reasoningEffort,
  webSearchAllowed: false, createdAt: new Date().toISOString(), calls
};

async function runTrackedTurn(stage: (typeof calls)[number]['stage'], input: {
  prompt: string; imagePaths?: string[]; outputSchema: Record<string, unknown>;
  allowWebSearch?: boolean; timeoutMs?: number;
}) {
  const turn = await runtime.runStructuredTurn<unknown>({ ...input, aiPreferences: { modelId, reasoningEffort } });
  calls.push({ stage, durationMs: turn.metrics.durationMs, inputTokens: turn.metrics.inputTokens,
    outputTokens: turn.metrics.outputTokens, webSearches: turn.metrics.webSearches,
    imageCount: input.imagePaths?.length ?? 0 });
  return turn;
}

try {
  const account = await runtime.refreshAccount();
  if (account.status !== 'connected') throw new Error('CODEX_AUTH_REQUIRED');
  const personId = service.ensurePrimaryMember({ displayName: '合成成员', relation: '本人' });
  const imported = await service.importFiles([{
    path: scannedPdf ? '/tmp/纯合成双页扫描报告.pdf' : '/tmp/纯合成图像报告.png', bytes: fixtureBytes
  }], personId);
  if (imported.rejected.length > 0) throw new Error('SYNTHETIC_IMAGE_IMPORT_REJECTED');
  const documentId = service.getSnapshot(null).inbox[0]?.id;
  if (!documentId) throw new Error('SYNTHETIC_DOCUMENT_MISSING');
  const manifest = service.store.getDocumentExtractionBundle(documentId).manifest;
  receipt.source = { mediaType: manifest.mediaType, spanKinds: manifest.spans.map((span) => span.spanKind),
    pageNumbers: manifest.spans.map((span) => span.page),
    sourceHasTextQuote: manifest.spans.some((span) => span.quote !== null) };
  const pipeline = new DocumentExtractionPipeline(service.store, {
    runStructuredTurn: (input) => runTrackedTurn(calls.length === 0 ? 'P01' : 'P01_P03', input)
  });
  const result = await pipeline.process(documentId);
  const facts = service.store.listAcceptedObservations(personId).map((fact) => ({
    name: fact.originalName, value: fact.rawText, unit: fact.unit,
    clinicalDate: fact.clinicalDate, sourceSpanIds: fact.evidence.map((item) => item.sourceSpanId),
    evidenceQuotes: fact.evidence.map((item) => item.quote)
  }));
  receipt.result = { status: result.status, candidateCount: result.status === 'published' ? result.candidateCount : null,
    reason: result.status === 'needs_review' ? result.reason : null };
  receipt.facts = facts;
  receipt.openReviewIssueKinds = service.store.listOpenExtractionReviewIssues().map((issue) => issue.kind);
  const expectedValuesFound = {
    ldl: facts.some((fact) => /低密度脂蛋白|LDL/i.test(fact.name) && fact.value === '4.2'),
    glucose: facts.some((fact) => /空腹血糖/.test(fact.name) && fact.value === '5.1')
  };
  receipt.expectedValuesFound = expectedValuesFound;
  if (scannedPdf) {
    const secondPageIds = new Set(manifest.spans.filter((span) => span.page === 2).map((span) => span.id));
    receipt.scannedPageChecks = {
      pageCount: manifest.totalUnits,
      bothPagesHaveNoTextLayer: manifest.spans.length === 2 && manifest.spans.every((span) => span.quote === null),
      bothValuesUseHeaderDate: facts.filter((fact) => /低密度脂蛋白|LDL|空腹血糖/i.test(fact.name))
        .filter((fact) => fact.value === '4.2' || fact.value === '5.1')
        .every((fact) => fact.clinicalDate === '2025-06-10'),
      glucoseCitesSecondPage: facts.some((fact) => /空腹血糖/.test(fact.name) && fact.value === '5.1'
        && fact.sourceSpanIds.some((id) => secondPageIds.has(id)))
    };
  }
  if (result.status !== 'published' || !Object.values(expectedValuesFound).every(Boolean)
    || scannedPdf && Object.values(receipt.scannedPageChecks as Record<string, unknown>).some((value) => value === false || value === 0)
    || calls.some((call) => call.imageCount !== (scannedPdf ? 2 : 1) || call.webSearches !== 0)) process.exitCode = 1;
  if (fullAssessment && result.status === 'published') {
    const assessment = await new MemberAssessmentPipeline(service.store, {
      runStructuredTurn: (input) => runTrackedTurn(input.prompt.includes('REVIEW_REQUEST=') ? 'P04'
        : input.prompt.includes('REPAIR_REQUEST=') ? 'P02_P03' : 'P02', input)
    }, undefined, undefined, undefined, modelId, reasoningEffort, '2026-09-22', false).process(personId);
    const published = assessment.status === 'published'
      ? service.store.listMemberAssessmentSnapshots(personId, true)[0] : null;
    receipt.assessment = { status: assessment.status, callCount: assessment.callCount,
      reason: assessment.status === 'rejected' ? assessment.reason : null,
      headline: published?.overview.headline ?? null,
      claimCount: published?.claims.length ?? null, actionCount: published?.actions.length ?? null };
    if (assessment.status !== 'published' || calls.length !== 2
      || calls[0]?.stage !== 'P01' || calls[1]?.stage !== 'P02'
      || calls.some((call) => call.webSearches !== 0)) process.exitCode = 1;
  }
} catch (error) {
  receipt.errorCode = error instanceof Error ? error.message.split(':')[0] : 'UNKNOWN';
  receipt.runtimeErrors = runtimeErrors.slice(-3);
  receipt.turnErrors = turnErrors.slice(-1);
  process.exitCode = 1;
} finally {
  runtime.shutdown();
  service.close();
  writeFileSync(join(outputDirectory, 'receipt.json'), `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
  process.stdout.write(`Visual smoke receipt: ${join(outputDirectory, 'receipt.json')}\n`);
  process.stdout.write(`Status: ${JSON.stringify(receipt.result ?? receipt.errorCode)}; turns: ${calls.length}\n`);
}
