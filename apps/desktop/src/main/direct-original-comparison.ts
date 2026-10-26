import type { DirectOriginalReadingResult, DirectOriginalRepairTarget, ObservationCandidate,
  ReportMetadataCandidate, SourceSpan } from '@contracts';
import { stableHash } from '@core';
import type { DirectOriginalAdmissionComparisonRecord, DirectOriginalAdmissionPreview } from '@storage';

interface ComparisonSource {
  localKey: string;
  page: number | null;
  quote: string | null;
  role: string;
  clarity: 'clear' | 'uncertain';
}

interface ComparisonRecord {
  localKey: string;
  access: 'immutable_non_target';
  origin: 'stored_version' | 'current_reading';
  bindingStatus: 'resolved' | 'unresolved';
  nodeType: 'candidate' | 'metadata';
  value: ObservationCandidate | { times: ReportMetadataCandidate['times']; clinicalDate?: string | null; reportDate?: string | null };
  sourceExcerpts: Array<{ localKey: string }>;
  unavailableSourceRefs: string[];
}

interface ReconciliationDiagnostic {
  targetId: string;
  nodeType: 'candidate' | 'metadata';
  kind: 'reconciliation' | 'batch_conflict' | 'report_date';
  comparisonScope: string;
  decision: string;
  reasonCodes: string[];
  changedFields: string[];
  comparisonRefs: string[];
  times?: ReportMetadataCandidate['times'];
}

export interface DirectOriginalRepairComparisonContext {
  reconciliationDiagnostics: ReconciliationDiagnostic[];
  comparisonRecords: ComparisonRecord[];
  comparisonSourceExcerpts: ComparisonSource[];
  reservedLocalKeys: string[];
}

/** 仅留在主进程的旧记录能力；绝不能展开到模型只读目录。 */
export interface DirectOriginalSourceRefinementTarget {
  comparisonRecordKey: string;
  candidateKey: string;
  recordId: string;
  recordRevision: number;
  recordHash: string;
}

function remapSourceReferences<T>(value: T, alias: (sourceId: string) => string): T {
  if (Array.isArray(value)) return value.map((item) => remapSourceReferences(item, alias)) as T;
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key,
    key === 'sourceSpanId' && typeof item === 'string' ? alias(item) : remapSourceReferences(item, alias)])) as T;
}

/** 只传真实参与对账的同原件内容；永久记录/来源 ID、路径与运行收据不进入模型输入。 */
export function buildDirectOriginalRepairComparison(input: {
  reading: DirectOriginalReadingResult;
  originalSha256: string;
  sourceObjectId: string;
  targets: readonly DirectOriginalRepairTarget[];
  mappedSourceIds: ReadonlyMap<string, string>;
  reservedLocalKeys: readonly string[];
  preview: DirectOriginalAdmissionPreview | null;
}): { context: DirectOriginalRepairComparisonContext; refinementTargets: DirectOriginalSourceRefinementTarget[] } {
  const reserved = new Set(input.reservedLocalKeys);
  let recordIndex = 0;
  let sourceIndex = 0;
  const nextKey = (kind: 'record' | 'source') => {
    let key: string;
    do { key = kind === 'record' ? `ro_record_${++recordIndex}` : `ro_source_${++sourceIndex}`; } while (reserved.has(key));
    reserved.add(key);
    return key;
  };
  const comparisonRecords: ComparisonRecord[] = [];
  const comparisonSourceExcerpts: ComparisonSource[] = [];
  const refinementTargets: DirectOriginalSourceRefinementTarget[] = [];
  const recordAliases = new Map<string, string>();
  const sourceAliases = new Map<string, string>();
  const withinOriginal = (spans: readonly SourceSpan[]) => spans.length > 0 && spans.every((span) =>
    span.documentId === input.reading.documentId && (!span.modelEvidence || span.modelEvidence.originalSha256 === input.originalSha256
      && span.modelEvidence.originalSourceObjectId === input.sourceObjectId));
  const sources = (spans: readonly SourceSpan[]) => {
    const byId = new Map(spans.map((span) => [span.id, span]));
    const unavailable = new Set<string>();
    const alias = (sourceId: string) => {
      const span = byId.get(sourceId);
      const key = stableHash({ sourceId, source: span ? { page: span.page, quote: span.quote,
        role: span.modelEvidence?.role ?? 'untyped', readability: span.readability } : null });
      let localKey = sourceAliases.get(key);
      if (!localKey) {
        localKey = nextKey('source'); sourceAliases.set(key, localKey);
        if (span) comparisonSourceExcerpts.push({ localKey, page: span.page, quote: span.quote,
          role: span.modelEvidence?.role ?? 'untyped', clarity: span.readability === 'clear' ? 'clear' : 'uncertain' });
      }
      if (!span) unavailable.add(localKey);
      return localKey;
    };
    const refs = spans.map((span) => ({ localKey: alias(span.id) }));
    return { alias, refs, unavailable };
  };
  const addRecord = (record: DirectOriginalAdmissionComparisonRecord): string | null => {
    if (!withinOriginal(record.sourceSpans)) return null;
    const key = stableHash({ origin: record.origin, recordId: record.recordId,
      candidate: record.candidate, sourceSpans: record.sourceSpans });
    const previous = recordAliases.get(key);
    if (previous) return previous;
    const localKey = nextKey('record');
    const source = sources(record.sourceSpans);
    const value = remapSourceReferences({ ...record.candidate, localKey }, source.alias);
    comparisonRecords.push({ localKey, access: 'immutable_non_target', origin: record.origin,
      bindingStatus: record.bindingStatus, nodeType: 'candidate', value,
      sourceExcerpts: source.refs, unavailableSourceRefs: [...source.unavailable] });
    recordAliases.set(key, localKey);
    return localKey;
  };
  const candidateTargets = new Set(input.targets.filter((target) => target.nodeType === 'candidate').map((target) => target.targetId));
  const reconciliationDiagnostics: ReconciliationDiagnostic[] = [];
  for (const held of input.preview?.held ?? []) {
    if (!candidateTargets.has(held.candidate.localKey) || !held.diagnostic) continue;
    const comparisonRefs = held.diagnostic.comparisons.map(addRecord).filter((ref): ref is string => ref !== null);
    for (const record of held.diagnostic.comparisons) {
      const comparisonRecordKey = recordAliases.get(stableHash({ origin: record.origin, recordId: record.recordId,
        candidate: record.candidate, sourceSpans: record.sourceSpans }));
      if (record.origin !== 'stored_version' || record.bindingStatus !== 'resolved' || !comparisonRecordKey
        || !('recordRevision' in record) || typeof record.recordRevision !== 'number' || !Number.isSafeInteger(record.recordRevision)
        || record.recordRevision < 1 || !('recordHash' in record) || typeof record.recordHash !== 'string'
        || !/^[a-f0-9]{64}$/u.test(record.recordHash)) continue;
      const target = { comparisonRecordKey, candidateKey: held.candidate.localKey, recordId: record.recordId,
        recordRevision: record.recordRevision, recordHash: record.recordHash };
      if (!refinementTargets.some((item) => stableHash(item) === stableHash(target))) refinementTargets.push(target);
    }
    reconciliationDiagnostics.push({ targetId: held.candidate.localKey, nodeType: 'candidate', kind: held.diagnostic.kind,
      comparisonScope: held.diagnostic.comparisonScope, decision: held.diagnostic.decision,
      reasonCodes: [...held.reasons, ...(comparisonRefs.length !== held.diagnostic.comparisons.length ? ['comparison_source_unavailable'] : [])],
      changedFields: [...held.diagnostic.changedFields], comparisonRefs });
  }
  if (input.targets.some((target) => target.nodeType === 'metadata' && target.targetId === 'metadata')) {
    const currentIds = new Map([...input.mappedSourceIds].map(([localKey, permanentId]) => [permanentId, localKey]));
    for (const diagnostic of input.preview?.reportDiagnostics ?? []) {
      const comparisonRefs: string[] = [];
      // 共享事件的另一份原件不属于本文件事实重核的发送范围，不能顺带发送它的日期或正文。
      for (const record of diagnostic.comparisons.filter((record) => record.origin === 'stored_version')) {
        if (record.sourceDocumentId !== input.reading.documentId || record.sourceSha256 !== input.originalSha256
          || !withinOriginal(record.sourceSpans)) continue;
        const key = stableHash(record);
        let localKey = recordAliases.get(key);
        if (!localKey) {
          localKey = nextKey('record');
          const source = sources(record.sourceSpans);
          const value = remapSourceReferences({ times: record.times,
            ...(record.clinicalDate === undefined ? {} : { clinicalDate: record.clinicalDate }),
            ...(record.reportDate === undefined ? {} : { reportDate: record.reportDate }) }, source.alias);
          comparisonRecords.push({ localKey, access: 'immutable_non_target', origin: 'stored_version',
            bindingStatus: 'unresolved', nodeType: 'metadata', value,
            sourceExcerpts: source.refs, unavailableSourceRefs: [...source.unavailable] });
          recordAliases.set(key, localKey);
        }
        comparisonRefs.push(localKey);
      }
      reconciliationDiagnostics.push({ targetId: 'metadata', nodeType: 'metadata', kind: 'report_date',
        comparisonScope: diagnostic.scope, decision: 'unresolved', reasonCodes: [...diagnostic.reasonCodes], changedFields: [],
        comparisonRefs, times: remapSourceReferences(diagnostic.current, (id) => currentIds.get(id) ?? id) });
    }
  }
  return { context: { reconciliationDiagnostics, comparisonRecords, comparisonSourceExcerpts, reservedLocalKeys: [...reserved] },
    refinementTargets };
}

/** 兼容只需要可发送目录的调用方；本机修订能力由独立返回值持有。 */
export function buildDirectOriginalRepairComparisonContext(input: Parameters<typeof buildDirectOriginalRepairComparison>[0]):
  DirectOriginalRepairComparisonContext { return buildDirectOriginalRepairComparison(input).context; }

/** 只读对照编号不是新目标，也不能被补漏当作本轮真实来源或候选身份。 */
export function assertNoReadOnlyComparisonReferences(value: unknown, context: DirectOriginalRepairComparisonContext): void {
  const ids = new Set([...context.comparisonRecords.map((record) => record.localKey),
    ...context.comparisonSourceExcerpts.map((source) => source.localKey),
    ...context.comparisonRecords.flatMap((record) => record.unavailableSourceRefs)]);
  // 兼容原P01已经存在的任意键，但不能在P03伪造未分配的只读命名空间。
  const originalIds = new Set(context.reservedLocalKeys.filter((id) => !ids.has(id)));
  const visit = (item: unknown, path: Array<string | number> = []): void => {
    if (Array.isArray(item)) { item.forEach((child, index) => visit(child, [...path, index])); return; }
    if (!item || typeof item !== 'object') return;
    for (const [key, child] of Object.entries(item)) {
      if (key === 'comparisonRecordKey') {
        const mapping = item as { candidateKey?: unknown };
        const allowed = path.length === 2 && path[0] === 'sourceMappings' && typeof path[1] === 'number'
          && typeof child === 'string' && context.comparisonRecords.some((record) => record.localKey === child
            && record.origin === 'stored_version' && record.nodeType === 'candidate')
          && context.reconciliationDiagnostics.some((diagnostic) => diagnostic.targetId === mapping.candidateKey
            && diagnostic.nodeType === 'candidate' && diagnostic.comparisonRefs.includes(child));
        if (!allowed) throw new Error('DIRECT_ORIGINAL_READ_ONLY_COMPARISON_REFERENCE');
      }
      if (['localKey', 'targetId', 'sourceSpanId', 'pageSourceSpanId', 'candidateKey'].includes(key)
        && typeof child === 'string' && (ids.has(child) || child.startsWith('ro_') && !originalIds.has(child))) {
        throw new Error('DIRECT_ORIGINAL_READ_ONLY_COMPARISON_REFERENCE');
      }
      visit(child, [...path, key]);
    }
  };
  visit(value);
}
