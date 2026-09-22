import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { z } from 'zod';
import { aiReasoningEffortSchema, clinicalFocusedReviewV1Schema, memberAssessmentCandidateV3Schema } from '@contracts';
import { stableHash } from '@core';
import { redactSensitiveLog, spawnCodexAppServer } from '../packages/codex-adapter/src/index.js';
import { createAssessmentV3SyntheticCases } from '../packages/evaluation/src/assessment-v3-cases.js';
import { normalizeAssessmentStructuralFields, validateAssessmentCandidate } from '../apps/desktop/src/main/assessment-validation.js';
import { repairChangedOnlyAllowed, repairTargets } from '../apps/desktop/src/main/member-assessment-pipeline.js';
import { applyFocusedReview, routeFocusedReview } from '../apps/desktop/src/main/clinical-review-router.js';
import { CodexRuntimeManager } from '../apps/desktop/src/main/codex-runtime.js';
import { buildP02Prompt, buildP03Prompt, buildP04Prompt } from '../apps/desktop/src/main/prompts/lean.js';

/** 只运行纯合成 P02 或指定候选的 P03/P04；不读取家庭工作区，也不冒充完整流水线/临床质量评测。 */
const requestedIds = (process.argv.find((arg) => arg.startsWith('--cases='))?.slice('--cases='.length) ?? 'A001')
  .split(',').map((id) => id.trim()).filter(Boolean);
const cases = createAssessmentV3SyntheticCases();
const selected = requestedIds.map((id) => {
  const item = cases.find((candidate) => candidate.id === id);
  if (!item) throw new Error(`UNKNOWN_SYNTHETIC_CASE:${id}`);
  return item;
});
const reviewCandidateArgument = process.argv.find((arg) => arg.startsWith('--review-candidate='))?.slice('--review-candidate='.length);
const repairCandidateArgument = process.argv.find((arg) => arg.startsWith('--repair-candidate='))?.slice('--repair-candidate='.length);
if (reviewCandidateArgument && repairCandidateArgument) throw new Error('SYNTHETIC_MODE_CONFLICT');
if ((reviewCandidateArgument || repairCandidateArgument) && selected.length !== 1) throw new Error('CANDIDATE_FOLLOWUP_REQUIRES_ONE_CASE');
const modelId = process.argv.find((arg) => arg.startsWith('--model='))?.slice('--model='.length) ?? 'gpt-5.6-sol';
const reasoningEffort = aiReasoningEffortSchema.parse(
  process.argv.find((arg) => arg.startsWith('--effort='))?.slice('--effort='.length) ?? 'medium'
);
const locatedExecutable = process.env.CODEX_EXECUTABLE ?? execFileSync('which', ['codex'], { encoding: 'utf8' }).trim();
const executable = isAbsolute(locatedExecutable) ? locatedExecutable : resolve(process.cwd(), locatedExecutable);
const runtimeHome = process.env.CODEX_HOME ?? resolve(homedir(), '.codex');
const outputDirectory = mkdtempSync(join(tmpdir(), 'fhd-lean-v3-synthetic-eval-'));
const workingDirectory = join(outputDirectory, 'codex-workspace');
mkdirSync(workingDirectory, { recursive: true, mode: 0o700 });
const runtimeErrors: string[] = [];
const turnErrors: string[] = [];
const runtime = new CodexRuntimeManager({ executable, runtimeVersion: null, codexHome: runtimeHome,
  workingDirectory, requestTimeoutMs: 240_000,
  createClient: (options) => {
    const { client } = spawnCodexAppServer({ ...options, strictConfig: false });
    client.on('stderr', (line) => runtimeErrors.push(redactSensitiveLog(String(line)).slice(0, 500)));
    client.on('turn/completed', (notification: { turn?: { error?: unknown } }) => {
      if (notification.turn?.error) turnErrors.push(redactSensitiveLog(JSON.stringify(notification.turn.error)).slice(0, 3_000));
    });
    return client;
  } });
const outputSchema = z.toJSONSchema(memberAssessmentCandidateV3Schema, { target: 'draft-7' }) as Record<string, unknown>;
const reviewOutputSchema = z.toJSONSchema(clinicalFocusedReviewV1Schema, { target: 'draft-7' }) as Record<string, unknown>;
const receipt: {
  kind: 'P02_ONLY_SYNTHETIC' | 'P03_ONLY_SYNTHETIC' | 'P04_ONLY_SYNTHETIC';
  createdAt: string;
  modelId: string;
  reasoningEffort: string;
  webSearchAllowed: false;
  runtimeProfile: 'app_server_global_login_non_strict_config';
  cases: Array<Record<string, unknown>>;
} = {
  kind: reviewCandidateArgument ? 'P04_ONLY_SYNTHETIC' : repairCandidateArgument ? 'P03_ONLY_SYNTHETIC' : 'P02_ONLY_SYNTHETIC',
  createdAt: new Date().toISOString(), modelId,
  reasoningEffort, webSearchAllowed: false,
  runtimeProfile: 'app_server_global_login_non_strict_config', cases: []
};

function loadSyntheticCandidate(candidateArgument: string, caseId: string) {
  const candidatePath = realpathSync(candidateArgument);
  const parent = dirname(candidatePath);
  if (dirname(parent) !== realpathSync(tmpdir())
    || !basename(parent).startsWith('fhd-lean-v3-synthetic-eval-')
    || basename(candidatePath) !== `${caseId}-candidate.json`) {
    throw new Error('SYNTHETIC_CANDIDATE_PATH_REQUIRED');
  }
  return normalizeAssessmentStructuralFields(
    memberAssessmentCandidateV3Schema.parse(JSON.parse(readFileSync(candidatePath, 'utf8')))
  );
}

function validationInputFor(item: (typeof selected)[number]) {
  return {
    personId: item.request.personId, inputSignature: item.request.inputSignature,
    mode: item.request.mode, requestedSystemIds: item.request.requestedSystemIds,
    evidenceCatalog: item.evidencePackage.evidenceCatalog,
    trendIds: item.evidencePackage.trends.map((trend) => trend.id),
    catalogKnowledgeIds: item.evidencePackage.knowledge.map((source) => source.id),
    criteriaSets: item.evidencePackage.criteriaSets
  };
}

try {
  const account = await runtime.refreshAccount();
  if (account.status !== 'connected') throw new Error('CODEX_AUTH_REQUIRED');
  for (const item of selected) {
    const startedAt = Date.now();
    try {
      if (repairCandidateArgument) {
        const candidate = loadSyntheticCandidate(repairCandidateArgument, item.id);
        if (candidate.personId !== item.request.personId || candidate.inputSignature !== item.request.inputSignature) {
          throw new Error('SYNTHETIC_CANDIDATE_SCOPE_MISMATCH');
        }
        const validationInput = validationInputFor(item);
        const originalIssues = validateAssessmentCandidate(candidate, validationInput).issues;
        const targetIds = repairTargets(candidate, originalIssues);
        if (targetIds.length === 0) throw new Error('SYNTHETIC_TARGETED_REPAIR_NOT_TRIGGERED');
        const repairRequest = { stage: 'assessment', targets: targetIds,
          allowedPaths: targetIds.map((id) => id === 'overview' ? 'overview' : `node:${id}`),
          issues: originalIssues, originalCandidateHash: stableHash(candidate) };
        const turn = await runtime.runStructuredTurn<unknown>({
          prompt: buildP03Prompt(repairRequest, item.evidencePackage, candidate),
          outputSchema, aiPreferences: { modelId, reasoningEffort }, allowWebSearch: false, timeoutMs: 240_000
        });
        const repaired = normalizeAssessmentStructuralFields(memberAssessmentCandidateV3Schema.parse(turn.output));
        const repairScoped = repairChangedOnlyAllowed(candidate, repaired, targetIds);
        const postValidationIssues = validateAssessmentCandidate(repaired, validationInput).issues;
        if (!repairScoped || postValidationIssues.length > 0) process.exitCode = 1;
        receipt.cases.push({ id: item.id, status: 'repair_completed', targetIds, originalIssues,
          repairScoped, postValidationIssues, durationMs: turn.metrics.durationMs,
          elapsedMs: Date.now() - startedAt, webSearches: turn.metrics.webSearches,
          inputTokens: turn.metrics.inputTokens, outputTokens: turn.metrics.outputTokens });
        writeFileSync(join(outputDirectory, `${item.id}-repaired.json`), `${JSON.stringify(repaired, null, 2)}\n`, { mode: 0o600 });
        process.stdout.write(`${item.id}: P03 repaired ${targetIds.length} targets, scoped=${repairScoped}, local issues=${postValidationIssues.length}\n`);
        continue;
      }
      if (reviewCandidateArgument) {
        const candidate = loadSyntheticCandidate(reviewCandidateArgument, item.id);
        if (candidate.personId !== item.request.personId || candidate.inputSignature !== item.request.inputSignature) {
          throw new Error('SYNTHETIC_CANDIDATE_SCOPE_MISMATCH');
        }
        const route = routeFocusedReview(candidate);
        if (route.targetIds.length === 0) throw new Error('SYNTHETIC_FOCUSED_REVIEW_NOT_TRIGGERED');
        const nodeById = new Map<string, unknown>([
          [candidate.overview.id, candidate.overview],
          ...candidate.systems.map((node) => [node.id, node] as const),
          ...candidate.claims.map((node) => [node.id, node] as const),
          ...candidate.actions.map((node) => [node.id, node] as const),
          ...candidate.questions.map((node) => [node.id, node] as const)
        ]);
        const relevantEvidenceIds = new Set([
          ...candidate.claims.filter((node) => route.targetIds.includes(node.id))
            .flatMap((node) => [...node.evidenceIds, ...node.counterEvidenceIds]),
          ...candidate.actions.filter((node) => route.targetIds.includes(node.id)).flatMap((node) => node.evidenceIds)
        ]);
        const sourceContext = {
          evidenceCatalog: item.evidencePackage.evidenceCatalog.filter((evidence) => relevantEvidenceIds.has(evidence.id)),
          knowledge: item.evidencePackage.knowledge, criteriaSets: item.evidencePackage.criteriaSets,
          analysisReferenceDate: item.request.analysisReferenceDate
        };
        const turn = await runtime.runStructuredTurn<unknown>({
          prompt: buildP04Prompt({ personId: item.request.personId, inputSignature: item.request.inputSignature,
            targets: route.targetIds, reasons: route.reasons }, sourceContext,
          route.targetIds.map((id) => ({ id, node: nodeById.get(id) }))),
          outputSchema: reviewOutputSchema, aiPreferences: { modelId, reasoningEffort },
          allowWebSearch: false, timeoutMs: 240_000
        });
        const review = clinicalFocusedReviewV1Schema.parse(turn.output);
        const applied = applyFocusedReview(candidate, review, route.targetIds);
        const validation = validateAssessmentCandidate(applied.candidate, {
          personId: item.request.personId, inputSignature: item.request.inputSignature,
          mode: item.request.mode, requestedSystemIds: item.request.requestedSystemIds,
          evidenceCatalog: item.evidencePackage.evidenceCatalog,
          trendIds: item.evidencePackage.trends.map((trend) => trend.id),
          catalogKnowledgeIds: item.evidencePackage.knowledge.map((source) => source.id),
          criteriaSets: item.evidencePackage.criteriaSets
        });
        if (validation.issues.length > 0) process.exitCode = 1;
        receipt.cases.push({ id: item.id, status: 'review_completed', targetIds: route.targetIds,
          verdicts: review.results.map((result) => ({ targetId: result.targetId, verdict: result.verdict })),
          heldTargetIds: applied.heldTargetIds, postValidationIssues: validation.issues,
          durationMs: turn.metrics.durationMs, elapsedMs: Date.now() - startedAt,
          webSearches: turn.metrics.webSearches, inputTokens: turn.metrics.inputTokens,
          outputTokens: turn.metrics.outputTokens });
        writeFileSync(join(outputDirectory, `${item.id}-review.json`), `${JSON.stringify(review, null, 2)}\n`, { mode: 0o600 });
        process.stdout.write(`${item.id}: P04 reviewed ${route.targetIds.length} targets, held ${applied.heldTargetIds.length}, local issues ${validation.issues.length}\n`);
        continue;
      }
      const turn = await runtime.runStructuredTurn<unknown>({
        prompt: buildP02Prompt(item.request, item.evidencePackage), outputSchema,
        aiPreferences: { modelId, reasoningEffort },
        allowWebSearch: false, timeoutMs: 240_000
      });
      const parsed = memberAssessmentCandidateV3Schema.safeParse(turn.output);
      const candidate = parsed.success ? normalizeAssessmentStructuralFields(parsed.data) : null;
      const validation = candidate ? validateAssessmentCandidate(candidate, {
        personId: item.request.personId, inputSignature: item.request.inputSignature,
        mode: item.request.mode, requestedSystemIds: item.request.requestedSystemIds,
        evidenceCatalog: item.evidencePackage.evidenceCatalog,
        trendIds: item.evidencePackage.trends.map((trend) => trend.id),
        catalogKnowledgeIds: item.evidencePackage.knowledge.map((source) => source.id),
        criteriaSets: item.evidencePackage.criteriaSets
      }) : null;
      const route = candidate ? routeFocusedReview(candidate) : null;
      if (!parsed.success || (validation?.issues.length ?? 0) > 0) process.exitCode = 1;
      const caseReceipt = {
        id: item.id, status: parsed.success ? 'schema_valid' : 'schema_invalid',
        schemaIssues: parsed.success ? [] : parsed.error.issues.map((issue) => ({
          path: issue.path.join('.'), code: issue.code
        })),
        validationIssues: validation?.issues ?? null,
        focusedReviewTargets: route?.targetIds ?? null,
        durationMs: turn.metrics.durationMs, elapsedMs: Date.now() - startedAt,
        webSearches: turn.metrics.webSearches, webPageOpens: turn.metrics.webPageOpens,
        inputTokens: turn.metrics.inputTokens, outputTokens: turn.metrics.outputTokens,
        headline: candidate?.overview.headline ?? null,
        claimSummaries: candidate ? candidate.claims.map((claim) => ({
          diseaseName: claim.diseaseName, diagnosticStatus: claim.diagnosticStatus, text: claim.text
        })) : null
      };
      receipt.cases.push(caseReceipt);
      writeFileSync(join(outputDirectory, `${item.id}-candidate.json`), `${JSON.stringify(turn.output, null, 2)}\n`, { mode: 0o600 });
      process.stdout.write(`${item.id}: ${caseReceipt.status}, local issues=${validation?.issues.length ?? 'n/a'}, P04 targets=${route?.targetIds.length ?? 'n/a'}\n`);
    } catch (error) {
      const code = error instanceof Error ? error.message.split(':')[0] : 'UNKNOWN';
      process.exitCode = 1;
      receipt.cases.push({ id: item.id, status: 'runtime_error', errorCode: code,
        elapsedMs: Date.now() - startedAt, turnErrors: turnErrors.slice(-1) });
      process.stdout.write(`${item.id}: runtime_error ${code}\n`);
    }
  }
} catch (error) {
  receipt.cases.push({ status: 'setup_error', errorCode: error instanceof Error ? error.message.split(':')[0] : 'UNKNOWN',
    runtimeErrors: runtimeErrors.slice(-3) });
  process.exitCode = 1;
} finally {
  runtime.shutdown();
  writeFileSync(join(outputDirectory, 'receipt.json'), `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
  process.stdout.write(`Synthetic evaluation receipt: ${join(outputDirectory, 'receipt.json')}\n`);
}
