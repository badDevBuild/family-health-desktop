import { z } from 'zod';
import { clinicalContextHasValidSources, reportClinicalContextSchema,
  type MemberEvidencePackageV3, type ReportClinicalContext, type SourceSpan } from '@contracts';
import { stableHash } from '@core';
import type { JobExecutionGuard, WorkspaceStore } from '@storage';
import { buildClinicalContextPrompt } from './prompts/clinical-context.js';

export const CLINICAL_RECORD_VERSION = 'clinical-record-v1';
type Package = MemberEvidencePackageV3;
type ContextTurn = (input: { prompt: string; outputSchema: Record<string, unknown>; allowWebSearch: false }) => Promise<{ output: unknown }>;

function contextSignature(personId: string, documentId: string, facts: Package['facts'], spans: SourceSpan[]): string {
  return stableHash({ version: CLINICAL_RECORD_VERSION, personId, documentId, facts, spans });
}

/** 构建综合签名前先加载已验证缓存，使签名包含真正送入模型的条件，而非仅标记版本。 */
export function hydrateCachedClinicalRecords(store: WorkspaceStore, personId: string, evidencePackage: Package): void {
  const documents = [...new Set(evidencePackage.facts.filter((fact) => !fact.clinicalContext).map((fact) => fact.documentId))];
  for (const documentId of documents) {
    const facts = evidencePackage.facts.filter((fact) => fact.documentId === documentId && !fact.clinicalContext);
    const spans = store.getDocumentExtractionBundle(documentId).manifest.spans;
    const patch = store.getReportClinicalContext(personId, documentId, contextSignature(personId, documentId, facts, spans));
    if (!patch || !validContextPatch(patch, facts.map((fact) => fact.observationId), spans)) continue;
    for (const item of patch.items) facts.find((fact) => fact.observationId === item.observationId)!.clinicalContext = item.context;
  }
}

export function validContextPatch(patch: ReportClinicalContext, factIds: string[], spans: SourceSpan[]): boolean {
  const expected = new Set(factIds);
  return patch.items.length === expected.size && new Set(patch.items.map((item) => item.observationId)).size === expected.size
    && patch.items.every((item) => expected.has(item.observationId) && clinicalContextHasValidSources(item.context, spans))
    // 纯图像或缺失文字不能由文本补齐步骤宣称完整。
    && ((spans.length > 0 && spans.every((span) => Boolean(span.quote?.trim())))
      || patch.items.every((item) => item.context.status === 'unresolved'));
}

/** 保留条件自己的来源；综合只引用事实编号，本地将它还原为全部相关依据。 */
export function attachClinicalContextEvidence(input: Package): void {
  const known = new Set(input.evidenceCatalog.map((evidence) => evidence.id));
  for (const fact of input.facts) {
    for (const condition of fact.clinicalContext?.conditions ?? []) {
      const id = `context-${stableHash([fact.observationId, condition]).slice(0, 32)}`;
      if (!known.has(id)) {
        const source = input.evidenceCatalog.find((ref) => ref.observationId === fact.observationId);
        input.evidenceCatalog.push({ id, kind: 'observation', observationId: fact.observationId,
          documentId: fact.documentId, eventId: source?.eventId ?? null, knowledgeId: null,
          sourceSpanId: condition.sourceSpanId, label: source?.label ?? fact.originalName,
          locator: null, quote: condition.quote });
        known.add(id);
      }
      if (!fact.evidenceIds.includes(id)) fact.evidenceIds.push(id);
    }
  }
}

/** 旧报告按原文件补齐一次；缓存绑定完整事实、原件及规则版本，不绑定当次分析日期。 */
export async function prepareClinicalRecords(input: {
  store: WorkspaceStore; evidencePackage: Package; personId: string;
  factRevision: number; contextRevision: number; executionGuard?: JobExecutionGuard;
  runTurn: ContextTurn; assertActive: () => void;
}): Promise<void> {
  const { store, evidencePackage } = input;
  const documents = [...new Set(evidencePackage.facts.filter((fact) => !fact.clinicalContext).map((fact) => fact.documentId))];
  for (const documentId of documents) {
    input.assertActive();
    const facts = evidencePackage.facts.filter((fact) => fact.documentId === documentId && !fact.clinicalContext);
    const spans = store.getDocumentExtractionBundle(documentId).manifest.spans;
    const signature = contextSignature(input.personId, documentId, facts, spans);
    let patch = store.getReportClinicalContext(input.personId, documentId, signature);
    if (patch && !validContextPatch(patch, facts.map((fact) => fact.observationId), spans)) patch = null;
    if (!patch) {
      const unresolved = (): ReportClinicalContext => ({ version: 1, items: facts.map((fact) => ({
        observationId: fact.observationId, context: { version: 1, status: 'unresolved', conditions: [] }
      })) });
      if (spans.length === 0 || spans.some((span) => !span.quote?.trim())) {
        // 文本步骤不假装看过旧图像；已有事实继续参与分析，条件保持未知且来源保留。
        patch = unresolved();
      } else {
        const output = await input.runTurn({
          prompt: buildClinicalContextPrompt({ documentId,
            facts: facts.map(({ evidenceIds: _evidence, systemIds: _systems, clinicalContext: _context, ...fact }) => fact),
            sources: spans.map(({ id, quote, page }) => ({ sourceSpanId: id, page, quote })) }),
          outputSchema: z.toJSONSchema(reportClinicalContextSchema, { target: 'draft-7' }) as Record<string, unknown>,
          allowWebSearch: false
        });
        const parsed = reportClinicalContextSchema.safeParse(output.output);
        // 补充条件不合格时保留原文边界，不能抹掉可靠事实或拖垮整份成员综合。
        patch = parsed.success && validContextPatch(parsed.data, facts.map((fact) => fact.observationId), spans)
          ? parsed.data : unresolved();
      }
      input.assertActive();
      store.saveReportClinicalContext({ personId: input.personId, documentId, inputSignature: signature, context: patch,
        expectedFactRevision: input.factRevision, expectedContextRevision: input.contextRevision,
        ...(input.executionGuard ? { executionGuard: input.executionGuard } : {}) });
    }
    for (const item of patch.items) facts.find((fact) => fact.observationId === item.observationId)!.clinicalContext = item.context;
  }
  attachClinicalContextEvidence(evidencePackage);
}
