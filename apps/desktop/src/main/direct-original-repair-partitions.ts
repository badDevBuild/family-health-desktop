import { observationStructuredSlotEvidence, type DirectOriginalReadingResult, type DirectOriginalRepairTarget,
  type ObservationCandidate } from '@contracts';
import type { DirectOriginalCandidateDiagnostic } from '@core';
import type { DirectOriginalRepairComparisonContext } from './direct-original-comparison.js';

export type RepairReadOnlyNode<T> = { localKey: string; access: 'authorized_target'; targetId: string }
  | { localKey: string; access: 'immutable_non_target'; value: T };
export interface DirectOriginalRepairReadOnlyContext extends DirectOriginalRepairComparisonContext {
  schemaVersion: 1;
  targetPages: { pageSourceSpanId: string; candidates: RepairReadOnlyNode<ObservationCandidate>[] }[];
  referencedExcerpts: RepairReadOnlyNode<DirectOriginalReadingResult['sourceExcerpts'][number]>[];
}
export interface RepairPartitionRequest {
  schemaVersion: number; documentId: string; originalReadingHash: string; targets: DirectOriginalRepairTarget[];
  issues: string[]; validationDiagnostics: DirectOriginalCandidateDiagnostic[]; allowedPageSourceSpanIds: string[];
}
export interface DirectOriginalRepairPartition {
  targets: DirectOriginalRepairTarget[];
  request: RepairPartitionRequest;
  targetItems: Array<DirectOriginalRepairTarget & { value: unknown }>;
  context: DirectOriginalRepairReadOnlyContext;
}

const references = (candidate: ObservationCandidate) => [...candidate.evidence,
  ...(candidate.sourceBinding?.headingEvidence ?? []), ...(candidate.sourceBinding?.findingEvidence ?? []),
  ...observationStructuredSlotEvidence(candidate), ...(candidate.clinicalContext?.conditions ?? [])].map((ref) => ref.sourceSpanId);
function sourceKeys(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(sourceKeys);
  if (!value || typeof value !== 'object') return [];
  return Object.entries(value).flatMap(([key, child]) => key === 'sourceSpanId' && typeof child === 'string'
    ? [child] : sourceKeys(child));
}

/** 分包只缩小本次可改目标；完整原件仍随每包发送，原文和跨页引用不切片。 */
export function sliceDirectOriginalRepairPartition(input: {
  reading: DirectOriginalReadingResult; request: RepairPartitionRequest; context: DirectOriginalRepairReadOnlyContext;
}, targets: DirectOriginalRepairTarget[]): DirectOriginalRepairPartition {
  const { reading } = input;
  const targetIds = new Set(targets.map((target) => target.targetId));
  const excerpts = new Map(reading.sourceExcerpts.map((excerpt) => [excerpt.localKey, excerpt]));
  const candidates = new Map(reading.extraction.candidates.map((candidate) => [candidate.localKey, candidate]));
  const scopedNode = <T extends { localKey: string }>(node: T): RepairReadOnlyNode<T> => targetIds.has(node.localKey)
    ? { localKey: node.localKey, access: 'authorized_target', targetId: node.localKey }
    : { localKey: node.localKey, access: 'immutable_non_target', value: node };
  const targetPages = input.context.targetPages.filter((page) => targetIds.has(page.pageSourceSpanId)
    || page.candidates.some((node) => targetIds.has(node.localKey))).map((page) => ({
      pageSourceSpanId: page.pageSourceSpanId,
      candidates: page.candidates.map((node) => scopedNode(candidates.get(node.localKey)!))
    }));
  const includedCandidates = new Set([...targetIds, ...targetPages.flatMap((page) => page.candidates.map((node) => node.localKey))]);
  const referenced = new Set(reading.extraction.candidates.filter((candidate) => includedCandidates.has(candidate.localKey)).flatMap(references));
  for (const target of targets) {
    if (target.nodeType === 'excerpt') referenced.add(target.targetId);
    if (target.nodeType === 'page') for (const item of reading.pageReadings.find((page) => page.sourceSpanId === target.targetId)?.resultInventory ?? []) {
      referenced.add(item.sourceSpanId);
      for (const ref of item.classification?.evidence ?? []) referenced.add(ref.sourceSpanId);
      if (item.classification?.duplicateSourceSpanId) referenced.add(item.classification.duplicateSourceSpanId);
    }
    if (target.nodeType === 'metadata') sourceKeys(reading.extraction.reportMetadata).forEach((key) => referenced.add(key));
    if (target.nodeType === 'subject') sourceKeys(reading.extraction.subject).forEach((key) => referenced.add(key));
  }
  const reconciliationDiagnostics = input.context.reconciliationDiagnostics.filter((diagnostic) => targetIds.has(diagnostic.targetId));
  const recordIds = new Set(reconciliationDiagnostics.flatMap((diagnostic) => diagnostic.comparisonRefs));
  const comparisonRecords = input.context.comparisonRecords.filter((record) => recordIds.has(record.localKey));
  const comparisonSourceIds = new Set(comparisonRecords.flatMap((record) => [
    ...record.sourceExcerpts.map((ref) => ref.localKey), ...sourceKeys(record.value)]));
  return { targets, request: { ...input.request, targets,
    validationDiagnostics: input.request.validationDiagnostics.filter((diagnostic) => targetIds.has(diagnostic.targetId)) },
  targetItems: targets.map((target) => ({ ...target, value: target.nodeType === 'candidate' ? candidates.get(target.targetId)
    : target.nodeType === 'excerpt' ? excerpts.get(target.targetId) ?? null
      : target.nodeType === 'metadata' ? reading.extraction.reportMetadata ?? null
        : target.nodeType === 'subject' ? reading.extraction.subject
          : reading.pageReadings.find((page) => page.sourceSpanId === target.targetId) ?? null })),
  context: { schemaVersion: 1, targetPages,
    referencedExcerpts: reading.sourceExcerpts.filter((excerpt) => referenced.has(excerpt.localKey)).map(scopedNode),
    reconciliationDiagnostics, comparisonRecords,
    comparisonSourceExcerpts: input.context.comparisonSourceExcerpts.filter((source) => comparisonSourceIds.has(source.localKey)),
    reservedLocalKeys: input.context.reservedLocalKeys } };
}

/** 共享可变来源及其全部引用者是一个原子组；只读引用可跨组复用，不扩大改写权限。 */
export function directOriginalRepairDependencyGroups(input: {
  reading: DirectOriginalReadingResult; request: RepairPartitionRequest; context: DirectOriginalRepairReadOnlyContext;
}): DirectOriginalRepairTarget[][] {
  const { reading } = input;
  const targets = input.request.targets;
  const parents = new Map(targets.map((target) => [target.targetId, target.targetId]));
  const root = (key: string): string => {
    let current = key;
    while (parents.get(current) !== current) current = parents.get(current)!;
    return current;
  };
  const join = (left: string, right: string) => {
    if (parents.has(left) && parents.has(right)) parents.set(root(right), root(left));
  };
  for (const target of targets) if (target.nodeType === 'excerpt') {
    for (const candidate of reading.extraction.candidates) if (references(candidate).includes(target.targetId)) join(target.targetId, candidate.localKey);
    if (sourceKeys(reading.extraction.subject).includes(target.targetId)) join(target.targetId, 'subject');
    if (sourceKeys(reading.extraction.reportMetadata).includes(target.targetId)) join(target.targetId, 'metadata');
    const page = reading.sourceExcerpts.find((excerpt) => excerpt.localKey === target.targetId)?.pageSourceSpanId;
    if (page) join(target.targetId, page);
  }
  for (const page of input.context.targetPages) for (const candidate of page.candidates) join(page.pageSourceSpanId, candidate.localKey);
  // 比较记录是不可变的只读依赖，允许多个包各自取得完整副本。
  // 不把共用只读对照误当成可变节点，否则常见表格的候选会全部串成超大组。
  // 所有分包回包合并后仍统一验证映射一对一、真实同格冲突及旧版本CAS。
  const groups = new Map<string, DirectOriginalRepairTarget[]>();
  for (const target of targets) {
    const key = root(target.targetId);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(target);
  }
  return [...groups.values()];
}

/** 按真实最终提示词试装箱；任何不可分依赖组过大都明确拒绝，绝不删原文凑预算。 */
export function planDirectOriginalRepairPartitions(input: {
  reading: DirectOriginalReadingResult; request: RepairPartitionRequest; context: DirectOriginalRepairReadOnlyContext;
  maxBytes: number; buildPrompt: (partition: DirectOriginalRepairPartition, index: number, total: number) => string;
}): DirectOriginalRepairPartition[] {
  if (!Number.isSafeInteger(input.maxBytes) || input.maxBytes <= 0) throw new Error('DIRECT_ORIGINAL_PROMPT_BUDGET_INVALID');
  const groups = directOriginalRepairDependencyGroups(input);
  const packets: DirectOriginalRepairPartition[] = [];
  let pending: DirectOriginalRepairTarget[] = [];
  // 总包数不超过目标数。先用最大位宽预留提示元数据，最终再逐包验证实际完整提示。
  const totalBound = input.request.targets.length;
  const fits = (targets: DirectOriginalRepairTarget[]) => Buffer.byteLength(input.buildPrompt(
    sliceDirectOriginalRepairPartition(input, targets), packets.length, totalBound), 'utf8') <= input.maxBytes;
  for (const group of groups) {
    if (pending.length && !fits([...pending, ...group])) {
      packets.push(sliceDirectOriginalRepairPartition(input, pending)); pending = [];
    }
    if (!fits(group)) throw new Error('DIRECT_ORIGINAL_CONTEXT_LIMIT_EXCEEDED');
    pending.push(...group);
  }
  if (pending.length) packets.push(sliceDirectOriginalRepairPartition(input, pending));
  for (const [index, packet] of packets.entries()) if (Buffer.byteLength(input.buildPrompt(packet, index, packets.length), 'utf8') > input.maxBytes) {
    throw new Error('DIRECT_ORIGINAL_CONTEXT_LIMIT_EXCEEDED');
  }
  return packets;
}
