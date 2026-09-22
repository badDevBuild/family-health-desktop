import { readFileSync, readdirSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { memberAssessmentCandidateV3Schema } from '@contracts';
import { createAssessmentV3SyntheticCases, ASSESSMENT_V3_CASESET_VERSION } from '../packages/evaluation/src/assessment-v3-cases.js';
import { ASSESSMENT_VALIDATION_RULES_VERSION, normalizeAssessmentStructuralFields, validateAssessmentCandidate } from '../apps/desktop/src/main/assessment-validation.js';
import { routeFocusedReview } from '../apps/desktop/src/main/clinical-review-router.js';

/** 只读重放已保存的纯合成候选，不发模型请求，也不把本地规则通过冒充医学准确。 */
const receiptArgument = process.argv.find((arg) => arg.startsWith('--receipt='))?.slice('--receipt='.length);
if (!receiptArgument) throw new Error('SYNTHETIC_RECEIPT_REQUIRED');
const receiptPath = realpathSync(receiptArgument);
const directory = dirname(receiptPath);
if (basename(receiptPath) !== 'receipt.json' || dirname(directory) !== realpathSync(tmpdir())
  || !basename(directory).startsWith('fhd-lean-v3-synthetic-eval-')) {
  throw new Error('SYNTHETIC_EVALUATION_RECEIPT_PATH_REQUIRED');
}

const original = JSON.parse(readFileSync(receiptPath, 'utf8')) as {
  kind: string; modelId: string; reasoningEffort: string;
  cases: Array<{ id?: string; status?: string; durationMs?: number; inputTokens?: number;
    outputTokens?: number; webSearches?: number; validationIssues?: string[] }>;
};
if (original.kind !== 'P02_ONLY_SYNTHETIC') throw new Error('P02_RECEIPT_REQUIRED');
const cases = new Map(createAssessmentV3SyntheticCases().map((item) => [item.id, item]));
const originalById = new Map(original.cases.filter((item) => item.id).map((item) => [item.id!, item]));
const candidateFiles = readdirSync(directory).filter((file) => /^[A-Z]\d{3}-candidate\.json$/.test(file)).sort();
const results = candidateFiles.map((file) => {
  const id = file.slice(0, 4);
  const item = cases.get(id);
  if (!item) throw new Error(`UNKNOWN_SYNTHETIC_CASE:${id}`);
  const parsed = memberAssessmentCandidateV3Schema.safeParse(JSON.parse(readFileSync(join(directory, file), 'utf8')));
  if (!parsed.success) return { id, split: item.split, schemaValid: false,
    originalLocalIssues: originalById.get(id)?.validationIssues ?? null,
    localIssues: null, focusedReviewTargets: null };
  const candidate = normalizeAssessmentStructuralFields(parsed.data);
  const localIssues = validateAssessmentCandidate(candidate, {
    personId: item.request.personId, inputSignature: item.request.inputSignature,
    mode: item.request.mode, requestedSystemIds: item.request.requestedSystemIds,
    evidenceCatalog: item.evidencePackage.evidenceCatalog,
    trendIds: item.evidencePackage.trends.map((trend) => trend.id),
    catalogKnowledgeIds: item.evidencePackage.knowledge.map((source) => source.id),
    criteriaSets: item.evidencePackage.criteriaSets
  }).issues;
  return { id, split: item.split, schemaValid: true,
    originalLocalIssues: originalById.get(id)?.validationIssues ?? null, localIssues,
    focusedReviewTargets: routeFocusedReview(candidate).targetIds.length };
});
const receipts = original.cases.filter((item) => item.id);
const values = (key: 'durationMs' | 'inputTokens' | 'outputTokens' | 'webSearches') =>
  receipts.map((item) => item[key]).filter((value): value is number => typeof value === 'number');
function percentile(numbers: number[], fraction: number): number | null {
  if (numbers.length === 0) return null;
  const sorted = [...numbers].sort((left, right) => left - right);
  return sorted[Math.ceil(sorted.length * fraction) - 1]!;
}
const durations = values('durationMs');
const report = {
  kind: 'P02_SAVED_CANDIDATE_REVALIDATION', caseSetVersion: ASSESSMENT_V3_CASESET_VERSION,
  validationRulesVersion: ASSESSMENT_VALIDATION_RULES_VERSION,
  modelId: original.modelId, reasoningEffort: original.reasoningEffort,
  receiptCaseCount: receipts.length, savedCandidateCount: results.length,
  schemaValidCount: results.filter((item) => item.schemaValid).length,
  zeroLocalIssueCount: results.filter((item) => item.schemaValid && item.localIssues?.length === 0).length,
  casesNeedingFocusedReview: results.filter((item) => (item.focusedReviewTargets ?? 0) > 0).length,
  totalFocusedReviewTargets: results.reduce((sum, item) => sum + (item.focusedReviewTargets ?? 0), 0),
  originalLocalIssueCount: receipts.reduce((sum, item) => sum + (item.validationIssues?.length ?? 0), 0),
  observedP02Metrics: {
    completedTurnCount: durations.length, durationP50Ms: percentile(durations, 0.5),
    durationP95Ms: percentile(durations, 0.95),
    inputTokens: values('inputTokens').reduce((sum, value) => sum + value, 0),
    outputTokens: values('outputTokens').reduce((sum, value) => sum + value, 0),
    webSearches: values('webSearches').reduce((sum, value) => sum + value, 0)
  },
  cases: results
};
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (results.length !== cases.size || results.some((item) => !item.schemaValid || item.localIssues?.length)) {
  process.exitCode = 1;
}
