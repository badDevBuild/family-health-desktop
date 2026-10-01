import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import type { ClinicalContext, ExtractionResult, ReportClinicalContext, SourceSpan } from '@contracts';
import { PersonalWorkspaceService } from './workspace-service.js';
import { DocumentExtractionPipeline } from './processing-pipeline.js';
import { buildMemberAssessmentInput } from './member-assessment-input.js';
import { buildMemberAnalysisPackage, createMemberAnalysisTransport } from './member-analysis-package.js';
import { prepareClinicalRecords, validContextPatch } from './clinical-record-preparation.js';
import { buildClinicalContextPrompt } from './prompts/clinical-context.js';

const services: PersonalWorkspaceService[] = [];
const roots: string[] = [];
afterEach(() => {
  services.splice(0).forEach((service) => service.close());
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }));
});

async function fixture(context?: (spanId: string) => ClinicalContext) {
  const root = mkdtempSync(join(tmpdir(), 'family-health-context-test-'));
  roots.push(root);
  const service = new PersonalWorkspaceService(root, '合成条件补齐测试');
  services.push(service);
  const personId = service.ensurePrimaryMember({ displayName: '合成成员', relation: '本人' });
  await service.importFiles([{ path: '/tmp/合成条件报告.txt',
    bytes: Buffer.from('2026-09-21 葡萄糖 4.9 mmol/L；检查条件：空腹。') }], personId);
  const documentId = service.getSnapshot(null).inbox[0]!.id;
  const span = service.store.getDocumentExtractionBundle(documentId).manifest.spans[0]!;
  const extraction: ExtractionResult = { schemaVersion: 1, documentId,
    coveredSourceSpanIds: [span.id], subject: { reportedName: null, evidence: [], confidence: 'absent' }, candidates: [{
      localKey: 'glucose', originalName: '葡萄糖', standardNameCandidate: null,
      value: { kind: 'numeric', rawText: '4.9', decimal: '4.9', comparator: 'eq' },
      unitRaw: 'mmol/L', referenceRangeRaw: null, reportedAbnormalFlag: null,
      specimen: null, method: null, bodySite: null, clinicalDate: '2026-09-21',
      evidence: [{ sourceSpanId: span.id, quote: span.quote }], issues: [],
      ...(context ? { clinicalContext: context(span.id) } : {})
    }] };
  expect((await new DocumentExtractionPipeline(service.store, {
    runStructuredTurn: async () => ({ threadId: 'extract', turnId: 'extract', output: extraction })
  }).process(documentId)).status).toBe('published');
  const build = () => buildMemberAssessmentInput(service.store, personId, {
    modelId: 'synthetic-model', reasoningEffort: 'medium', analysisReferenceDate: '2026-09-26', webSearchAllowed: true
  });
  const prepare = (built: ReturnType<typeof build>, runTurn: Parameters<typeof prepareClinicalRecords>[0]['runTurn'],
    assertActive = () => {}) => prepareClinicalRecords({ store: service.store, personId, evidencePackage: built.evidencePackage,
    factRevision: built.factRevision, contextRevision: built.contextRevision, runTurn, assertActive });
  return { service, personId, documentId, span, build, prepare };
}

describe('可直接分析的临床记录', () => {
  it('v35 升级只新增条件存储与缓存，原事实和引用不变，旧记录明确为未补齐', async () => {
    const { service, personId } = await fixture();
    const before = service.store.listAcceptedObservations(personId);
    const root = service.store.rootDirectory;
    const path = service.store.databasePath;
    service.close();
    services.splice(services.indexOf(service), 1);
    const legacy = new Database(path);
    legacy.exec(`DROP TABLE report_clinical_contexts;
      ALTER TABLE observation_revisions DROP COLUMN clinical_context_json;
      UPDATE workspaces SET schema_version = 35; PRAGMA user_version = 35;`);
    legacy.close();
    const upgraded = new PersonalWorkspaceService(root, '合成条件升级测试');
    services.push(upgraded);
    expect(upgraded.store.listAcceptedObservations(personId)).toEqual(before);
    const check = new Database(path, { readonly: true });
    try {
      expect(check.pragma('user_version', { simple: true })).toBe(36);
      expect(check.prepare('SELECT COUNT(*) AS n FROM report_clinical_contexts').get()).toEqual({ n: 0 });
    } finally { check.close(); }
  });

  it('新提取条件持久化且不再补齐；事实、来源、条件各归其位', async () => {
    const { service, personId, span, build, prepare } = await fixture((id) => ({ version: 1, status: 'complete',
      conditions: [{ sourceSpanId: id, quote: '检查条件：空腹。' }] }));
    expect(service.store.listAcceptedObservations(personId)[0]!.clinicalContext).toEqual({ version: 1, status: 'complete',
      conditions: [{ sourceSpanId: span.id, quote: '检查条件：空腹。' }] });
    const built = build();
    await prepare(built, async () => { throw new Error('不应再次调用模型'); });
    const packet = buildMemberAnalysisPackage(built.evidencePackage);
    expect(packet.facts[0]!.rawValue).toBe('4.9');
    expect(packet.facts[0]!.conditions).toEqual(['检查条件：空腹。']);
    expect(packet.sourceContext).toEqual([]);
    expect(packet.evidenceCatalog).toEqual([]);
    expect(built.evidencePackage.evidenceCatalog.some((ref) => ref.quote === '检查条件：空腹。')).toBe(true);
  });

  it('旧资料只补条件并缓存，重新构包后不重读；不修改已接纳事实及版本', async () => {
    const { service, personId, span, build, prepare } = await fixture();
    const before = service.store.listAcceptedObservations(personId);
    const initialRevision = service.store.getFactRevision(personId);
    const built = build();
    let calls = 0;
    await prepare(built, async (input) => {
      calls += 1;
      expect(input.allowWebSearch).toBe(false);
      expect(input.prompt).toContain('不能改变任何已有结果');
      expect(input.prompt).toContain(span.quote);
      return { output: { version: 1, items: [{ observationId: built.evidencePackage.facts[0]!.observationId,
        context: { version: 1, status: 'complete', conditions: [{ sourceSpanId: span.id, quote: '检查条件：空腹。' }] } }] } };
    });
    const again = build();
    expect(again.request.inputSignature).not.toBe(built.request.inputSignature);
    await prepare(again, async () => { throw new Error('不应重复补齐'); });
    expect(calls).toBe(1);
    expect(again.evidencePackage).toEqual(built.evidencePackage);
    expect(service.store.listAcceptedObservations(personId)).toEqual(before);
    expect(service.store.getFactRevision(personId)).toBe(initialRevision);
    expect(buildMemberAnalysisPackage(again.evidencePackage).sourceContext).toEqual([]);
    const transport = createMemberAnalysisTransport(again.evidencePackage);
    const restored = transport.restoreOutput({ evidenceIds: [again.evidencePackage.facts[0]!.observationId] });
    expect(restored.evidenceIds).toEqual(again.evidencePackage.facts[0]!.evidenceIds);
  });

  it.each(['伪造条件', '其他资料'])('不接纳无依据的补齐：%s', async (kind) => {
    const { span, build, prepare } = await fixture();
    const built = build();
    await prepare(built, async () => ({ output: { version: 1, items: [{
      observationId: built.evidencePackage.facts[0]!.observationId,
      context: { version: 1, status: 'complete', conditions: [{
        sourceSpanId: kind === '其他资料' ? 'foreign-span' : span.id,
        quote: kind === '伪造条件' ? '检查条件：餐后。' : '检查条件：空腹。'
      }] }
    }] } }));
    expect(built.evidencePackage.facts[0]!.clinicalContext).toEqual({ version: 1, status: 'unresolved', conditions: [] });
    expect(buildMemberAnalysisPackage(built.evidencePackage).sourceContext.length).toBeGreaterThan(0);
  });

  it('提取的额外条件无效时保留可靠数值，不把问题变成新的人工核对', async () => {
    const { service, personId } = await fixture(() => ({ version: 1, status: 'complete',
      conditions: [{ sourceSpanId: 'foreign-span', quote: '不属于这份资料' }] }));
    expect(service.store.listAcceptedObservations(personId)).toMatchObject([{ rawText: '4.9', clinicalContext: null }]);
    expect(service.store.listOpenExtractionReviewIssues()).toEqual([]);
  });

  it('取消后的迟到补齐不能缓存；再次执行仍需合法补齐', async () => {
    const { span, build, prepare } = await fixture();
    const built = build();
    let active = true;
    const output = { version: 1, items: [{ observationId: built.evidencePackage.facts[0]!.observationId,
      context: { version: 1, status: 'complete', conditions: [{ sourceSpanId: span.id, quote: '空腹' }] } }] };
    await expect(prepare(built, async () => { active = false; return { output }; },
      () => { if (!active) throw new Error('cancelled'); })).rejects.toThrow('cancelled');
    let calledAgain = false;
    await prepare(build(), async () => { calledAgain = true; return { output }; });
    expect(calledAgain).toBe(true);
  });

  it('缓存写入重查版本和成员范围，不污染其他成员或新版本', async () => {
    const { service, personId, documentId, build } = await fixture();
    const built = build();
    const input = { personId, documentId, inputSignature: 'synthetic-signature',
      context: { version: 1 as const, items: [{ observationId: built.evidencePackage.facts[0]!.observationId,
        context: { version: 1 as const, status: 'complete' as const, conditions: [] } }] },
      expectedFactRevision: built.factRevision, expectedContextRevision: built.contextRevision };
    expect(() => service.store.saveReportClinicalContext({ ...input, expectedFactRevision: built.factRevision + 1 }))
      .toThrow('CLINICAL_CONTEXT_REVISION_CONFLICT');
    const other = service.store.createPerson({ displayName: '另一个合成成员' });
    expect(() => service.store.saveReportClinicalContext({ ...input, personId: other.id }))
      .toThrow('CLINICAL_CONTEXT_SCOPE_MISMATCH');
    expect(service.store.getReportClinicalContext(personId, documentId, input.inputSignature)).toBeNull();
  });

  it('完整性校验要求每项恰好一次；无文字图像不能被文本步骤冒充已补齐', () => {
    const context = { version: 1 as const, status: 'complete' as const, conditions: [] };
    const patch: ReportClinicalContext = { version: 1, items: [{ observationId: 'a', context }] };
    const span = { id: 'span', quote: '合成来源' } as SourceSpan;
    expect(validContextPatch(patch, ['a'], [span])).toBe(true);
    expect(validContextPatch(patch, ['a', 'b'], [span])).toBe(false);
    expect(validContextPatch({ ...patch, items: [patch.items[0]!, patch.items[0]!] }, ['a'], [span])).toBe(false);
    expect(validContextPatch(patch, ['a'], [{ ...span, quote: null }])).toBe(false);
    expect(validContextPatch(patch, ['a'], [])).toBe(false);
    expect(buildClinicalContextPrompt({})).toContain('条件须确实适用于对应结果');
  });
});
