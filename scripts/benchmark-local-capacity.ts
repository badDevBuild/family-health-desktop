import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { cpus, tmpdir, totalmem } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import type { SourceManifest } from '@contracts';
import { PersonalWorkspaceService } from '../apps/desktop/src/main/workspace-service.js';

const memberCount = 10;
const documentCount = 500;
const observationCount = 50_000;
const documentsPerMember = documentCount / memberCount;
const observationsPerMember = observationCount / memberCount;

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function dateFor(index: number): string {
  const date = new Date(Date.UTC(2024, 0, 1 + (index % 730)));
  return date.toISOString().slice(0, 10);
}

export async function runLocalCapacityBenchmark() {
  const root = await mkdtemp(join(tmpdir(), 'family-health-capacity-'));
  const startedAt = performance.now();
  try {
    const service = new PersonalWorkspaceService(root, '纯合成容量测试', () => new Date('2026-09-18T00:00:00Z'), () => 'Asia/Shanghai');
    const members = Array.from({ length: memberCount }, (_, index) => service.createMember({
      displayName: `合成成员${index + 1}`,
      relation: '测试成员',
      birthYear: 1960 + index
    }));
    const documentRefs = new Map<string, Array<{ documentId: string; sourceSpanId: string }>>();
    for (const personId of members) documentRefs.set(personId, []);

    for (let index = 0; index < documentCount; index += 1) {
      const personId = members[Math.floor(index / documentsPerMember)]!;
      const displayName = `synthetic-${index + 1}.txt`;
      const source = service.store.putSourceObject({
        bytes: Buffer.from(`纯合成容量样例 ${index + 1}`),
        mediaType: 'text/plain',
        displayName
      });
      service.store.registerSourceOccurrence({
        sourceObjectId: source.id,
        originalPath: `/synthetic/${displayName}`,
        displayName
      });
      const document = service.store.registerImportedDocument({ sourceObjectId: source.id, personId });
      const sourceSpanId = randomUUID();
      const manifest: SourceManifest = {
        id: randomUUID(), sourceObjectId: source.id, sha256: source.sha256,
        mediaType: 'text/plain', originalDisplayName: displayName,
        totalUnits: 1, coveredUnitIndexes: [0],
        spans: [{
          id: sourceSpanId, documentId: document.documentId, spanKind: 'line', page: null,
          blockId: null, lineStart: 1, lineEnd: 1, quote: `纯合成证据 ${index + 1}`, readability: 'clear'
        }],
        normalizerVersion: 'capacity-v1', conversionWarnings: [], createdAt: '2026-09-18T00:00:00.000Z'
      };
      service.store.saveSourceManifest(manifest);
      documentRefs.get(personId)!.push({ documentId: document.documentId, sourceSpanId });
    }

    for (let memberIndex = 0; memberIndex < members.length; memberIndex += 1) {
      const personId = members[memberIndex]!;
      const refs = documentRefs.get(personId)!;
      const acceptanceId = service.store.saveAcceptanceDecision({
        method: 'auto', actor: 'policy', rulesVersion: 'capacity-v1',
        inputSignature: sha256(`capacity-input-${memberIndex}`),
        outputHash: sha256(`capacity-output-${memberIndex}`), reviewRef: null, decision: 'accept'
      });
      service.store.publishFacts({
        personId, documentId: refs[0]!.documentId, documentCommitKey: sha256(`capacity-commit-${memberIndex}`), expectedRevision: 0, changeSetHash: sha256(`capacity-change-${memberIndex}`),
        summary: '纯合成容量数据',
        observations: Array.from({ length: observationsPerMember }, (_, observationIndex) => {
          const ref = refs[observationIndex % refs.length]!;
          return {
            conceptKey: `合成指标${observationIndex % 100}`, rawText: String(observationIndex % 500),
            valueKind: 'numeric' as const, decimalValue: String(observationIndex % 500), qualifier: null,
            unit: 'unit', referenceRange: '0-500', clinicalDate: dateFor(observationIndex),
            abnormalFlag: 'normal' as const, documentId: ref.documentId,
            sourceSpanId: ref.sourceSpanId, acceptanceId,
            specimen: null, method: null, bodySite: null,
            evidence: [{ sourceSpanId: ref.sourceSpanId, quote: `纯合成证据 ${(observationIndex % documentsPerMember) + 1}` }]
          };
        })
      });
    }

    const account = {
      status: 'disconnected' as const, displayLabel: null,
      quota: { status: 'unknown' as const, primaryUsedPercent: null, secondaryUsedPercent: null, resetsAt: null },
      runtimeVersion: '0.145.0', lastCheckedAt: null
    };
    const datasetConstructionMs = performance.now() - startedAt;
    service.getSnapshot(account);
    service.getSnapshot(account);
    const samples = Array.from({ length: 12 }, () => {
      const start = performance.now();
      const snapshot = service.getSnapshot(account);
      if (snapshot.persons.length !== memberCount || snapshot.persons.reduce((total, person) => total + person.acceptedFactCount, 0) !== observationCount) {
        throw new Error('CAPACITY_DATASET_COUNT_MISMATCH');
      }
      return performance.now() - start;
    }).sort((left, right) => left - right);
    const p95 = samples[Math.ceil(samples.length * 0.95) - 1]!;
    const result = {
      generatedAt: new Date().toISOString(),
      platform: `${process.platform}-${process.arch}`,
      node: process.version,
      cpu: cpus()[0]?.model ?? 'unknown',
      logicalCpuCount: cpus().length,
      totalMemoryGb: Number((totalmem() / 1024 / 1024 / 1024).toFixed(1)),
      dataset: { memberCount, documentCount, observationCount },
      datasetConstructionMs: Number(datasetConstructionMs.toFixed(1)),
      totalBenchmarkMs: Number((performance.now() - startedAt).toFixed(1)),
      snapshotReadMs: {
        min: Number(samples[0]!.toFixed(1)),
        median: Number(samples[Math.floor(samples.length / 2)]!.toFixed(1)),
        p95: Number(p95.toFixed(1)),
        max: Number(samples.at(-1)!.toFixed(1)),
        sampleCount: samples.length,
        targetP95Ms: 1000,
        passed: p95 <= 1000
      }
    };
    service.close();
    return result;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
