import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { observationStructuredSlotEvidence, type ObservationCandidate, type SourceManifest, type SourceSpan } from '@contracts';
import { WorkspaceStore, type PublishFactsInput } from './index.js';

const directories: string[] = [];
const stores = new Set<WorkspaceStore>();
afterEach(() => {
  for (const store of stores) store.close();
  stores.clear();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function fixture(text: string) {
  const rootDirectory = mkdtempSync(join(tmpdir(), 'synthetic-grounded-slot-')); directories.push(rootDirectory);
  let store = new WorkspaceStore({ rootDirectory }); stores.add(store);
  const person = store.createPerson({ displayName: '合成成员' });
  const source = store.putSourceObject({ bytes: Buffer.from('合成原件字节，仅用于本地回归'), mediaType: 'image/png', displayName: 'synthetic.png' });
  const { documentId } = store.registerImportedDocument({ personId: person.id, sourceObjectId: source.id });
  const page: SourceSpan = { id: 'synthetic-page', documentId, spanKind: 'image', page: 1, blockId: 'direct-original-page:1',
    lineStart: null, lineEnd: null, quote: null, readability: 'clear' };
  const excerpt: SourceSpan = { ...page, id: 'synthetic-context', spanKind: 'block', quote: text,
    blockId: `model-original-excerpt:${page.id}`, modelEvidence: { version: 1, engine: 'codex-original-reading-v1',
      modelId: 'gpt-6.1-sol', threadId: 'synthetic-thread', turnId: 'synthetic-turn', originalSha256: source.sha256,
      originalSourceObjectId: source.id, parentSourceSpanId: page.id, inputKind: 'image', role: 'finding', clarity: 'clear' } };
  const manifest: SourceManifest = { id: 'synthetic-manifest', sourceObjectId: source.id, sha256: source.sha256, mediaType: 'image/png',
    originalDisplayName: 'synthetic.png', totalUnits: 1, coveredUnitIndexes: [0], spans: [page, excerpt], normalizerVersion: 'direct-original-v1',
    conversionWarnings: [], createdAt: '2026-01-01T00:00:00Z' };
  store.saveSourceManifest({ ...manifest, spans: [page] });
  const accountFingerprint = 'synthetic-slot-account';
  const consentId = store.createManualProcessingConsent({ documentIds: [documentId], personIds: [person.id], accountFingerprint, version: 1 });
  store.createWaitingAuthBatch({ cutoff: '2026-01-01T00:00:00Z', initialStatus: 'queued', consentId,
    groups: [{ personId: person.id, documentIds: [documentId], inputSignature: 'synthetic-slot-input' }] });
  const job = store.claimNextQueuedJob('synthetic-runner', accountFingerprint)!;
  const executionGuard = { jobId: job.id, consentId, accountFingerprint,
    attemptId: store.startJobAttempt(job.id, 'synthetic', 'gpt-6.1-sol', 'medium') };
  store.saveDirectOriginalEvidenceForProcessing(manifest, { executionGuard });
  const acceptanceId = store.saveAcceptanceDecision({ method: 'auto', actor: 'policy', rulesVersion: 'synthetic-grounded-slot',
    inputSignature: 'synthetic-slot-acceptance', outputHash: 'synthetic-slot-output', reviewRef: null, decision: 'accept_with_warnings' });
  const ref = (quote: string | null) => ({ sourceSpanId: excerpt.id, quote });
  const candidate = (column: string): ObservationCandidate => ({ localKey: `synthetic-${column}`, originalName: '合成项目', standardNameCandidate: null,
    value: { kind: 'numeric', rawText: '5.0', decimal: '5', comparator: 'eq' }, unitRaw: 'U/L', referenceRangeRaw: null,
    reportedAbnormalFlag: null, specimen: null, method: null, bodySite: null, clinicalDate: null,
    evidence: [ref('甲项 5.0 5.0')], sourceBinding: { headingEvidence: [], findingEvidence: [ref('甲项 5.0 5.0')],
      structuredSlot: { version: 1, kind: 'table_cell', contextEvidence: [ref(null)], rowEvidence: [ref('甲项')],
        columnEvidence: [ref(column)], axes: [], component: null } }, issues: [] });
  const observation = (candidate: ObservationCandidate): PublishFactsInput['observations'][number] => ({
    conceptKey: candidate.originalName, originalName: candidate.originalName, modelStandardNameCandidate: null,
    rawText: candidate.value.rawText!, valueKind: candidate.value.kind,
    decimalValue: candidate.value.kind === 'numeric' ? candidate.value.decimal : null,
    qualifier: candidate.value.kind === 'numeric' ? candidate.value.comparator : candidate.value.kind === 'qualitative' ? candidate.value.category : null,
    unit: candidate.unitRaw, referenceRange: null, clinicalDate: null, abnormalFlag: 'unknown', documentId,
    sourceSpanId: candidate.evidence[0]!.sourceSpanId, acceptanceId, specimen: null, method: null, bodySite: null, clinicalContext: null,
    evidence: [...candidate.evidence, ...observationStructuredSlotEvidence(candidate)], sourceBinding: candidate.sourceBinding, candidate });
  const publish = (candidates: ObservationCandidate[]) => store.publishFacts({ personId: person.id, documentId,
    expectedRevision: store.getFactRevision(person.id), documentCommitKey: 'c'.repeat(64), changeSetHash: 'd'.repeat(64),
    summary: '合成槽位回归发布', observations: candidates.map(observation), executionGuard });
  const append = (candidates: ObservationCandidate[]) => {
    const issueId = store.saveExtractionReviewIssue({ documentId, stage: 'extract', kind: 'coverage_gap', severity: 'warning',
      preserveDocumentStatus: true, candidateOptions: [], evidenceRefs: [], reasonCodes: ['SYNTHETIC_SLOT_RECHECK'] });
    return store.appendCommittedFacts({ personId: person.id, documentId, expectedRevision: store.getFactRevision(person.id),
      summary: '合成槽位回归重核', observations: candidates.map(observation), executionGuard,
      reviewUpdate: { issueId, remainingCandidates: [], remainingReasonCodes: [], remainingEvidenceRefs: [] } });
  };
  const restart = () => { store.close(); stores.delete(store); store = new WorkspaceStore({ rootDirectory }); stores.add(store); };
  return { get store() { return store; }, person, documentId, manifest, excerpt, executionGuard, ref, candidate, observation, publish, append, restart };
}

describe('真实保存/重启/追加链的表格槽位', () => {
  it('相同名称与相同数值的两列均发布，重启后新来源ID重核不新增重复事实', () => {
    const f = fixture('合成表\n项目 本次 上次\n甲项 5.0 5.0'); const first = f.candidate('本次'); const second = f.candidate('上次');
    first.sourceBinding!.headingEvidence = [f.ref('合成表')]; second.sourceBinding!.headingEvidence = [f.ref('合成表')];
    expect(f.publish([first, second])).toMatchObject({ heldCount: 0, duplicateCount: 0 });
    const original = f.store.listAcceptedObservations(f.person.id); expect(original).toHaveLength(2);
    f.restart();
    const fresh: SourceSpan = { ...structuredClone(f.excerpt), id: 'synthetic-next-context',
      modelEvidence: { ...f.excerpt.modelEvidence!, turnId: 'synthetic-next-turn' } };
    f.manifest.spans.push(fresh); f.store.saveDirectOriginalEvidenceForProcessing(f.manifest, { executionGuard: f.executionGuard });
    const reread = [first, second].map((candidate) => JSON.parse(JSON.stringify(candidate)
      .replaceAll('synthetic-context', fresh.id)) as ObservationCandidate);
    const result = f.append(reread);
    expect(result).toMatchObject({ duplicateCount: 2, heldCandidates: [] });
    expect(f.store.listAcceptedObservations(f.person.id)).toEqual(original);
  });

  it('同格只改展示名/localKey或数值仍被隔离，已有两个正确结果原样保留', () => {
    const f = fixture('合成表\n项目 本次 上次\n甲项 5.0 5.0'); f.publish([f.candidate('本次'), f.candidate('上次')]);
    const original = f.store.listAcceptedObservations(f.person.id); f.restart();
    const changed = f.candidate('本次'); changed.localKey = 'changed-local'; changed.originalName = '另一展示名称';
    changed.value = { kind: 'numeric', rawText: '6.0', decimal: '6', comparator: 'eq' };
    expect(f.append([changed]).heldCandidates).toHaveLength(1);
    expect(f.store.listAcceptedObservations(f.person.id)).toEqual(original);
  });

  it('同轮同格的真正数值矛盾整组保留，不先接纳第一个值', () => {
    const f = fixture('合成表\n项目 本次 上次\n甲项 5.0 5.0'); const a = f.candidate('本次'); const b = f.candidate('本次');
    b.localKey = 'contradictory-cell'; b.value = { kind: 'numeric', rawText: '6.0', decimal: '6', comparator: 'eq' };
    expect(f.publish([a, b])).toMatchObject({ heldCount: 2 });
    expect(f.store.listAcceptedObservations(f.person.id)).toHaveLength(0);
  });

  it('原件独立写出的定量值和定性结论均保留，重启后均判重而不当同源冲突', () => {
    const f = fixture('合成检测\n样本甲 - 4.8 DPM 阴性');
    const numeric = f.candidate('本次'); numeric.value = { kind: 'numeric', rawText: '- 4.8', decimal: '-4.8', comparator: 'eq' };
    numeric.unitRaw = 'DPM'; numeric.evidence = [f.ref('样本甲 - 4.8 DPM 阴性')];
    numeric.sourceBinding = { headingEvidence: [], findingEvidence: numeric.evidence, structuredSlot: {
      version: 1, kind: 'labeled_component', contextEvidence: [f.ref(null)], rowEvidence: [f.ref('样本甲')], columnEvidence: [], axes: [],
      component: { kind: 'quantitative', evidence: [f.ref('- 4.8 DPM')] } } };
    const qualitative = structuredClone(numeric); qualitative.localKey = 'synthetic-qualitative'; qualitative.unitRaw = null;
    qualitative.value = { kind: 'qualitative', rawText: '阴性', category: 'negative' };
    qualitative.sourceBinding!.structuredSlot!.component = { kind: 'qualitative', evidence: [f.ref('阴性')] };
    expect(f.publish([numeric, qualitative])).toMatchObject({ heldCount: 0 });
    const original = f.store.listAcceptedObservations(f.person.id); expect(original).toHaveLength(2);
    f.restart(); expect(f.append([numeric, qualitative])).toMatchObject({ duplicateCount: 2, heldCandidates: [] });
    expect(f.store.listAcceptedObservations(f.person.id)).toEqual(original);
  });
});
