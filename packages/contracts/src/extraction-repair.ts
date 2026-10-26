import { z } from 'zod';
import { observationCandidateSchema, reportMetadataCandidateSchema,
  type ExtractionResult, type ObservationCandidate } from './index.js';

/** 提取补丁只返回授权目标；没有提供非目标字段的写入通道。 */
export const extractionRepairTargetSchema = z.discriminatedUnion('nodeType', [
  z.object({ nodeType: z.literal('candidate'), targetId: z.string().min(1), localKey: z.string().min(1) }).strict(),
  z.object({ nodeType: z.literal('metadata_time'), targetId: z.string().min(1), index: z.number().int().nonnegative() }).strict(),
  z.object({ nodeType: z.literal('source_coverage'), targetId: z.string().min(1), sourceSpanId: z.string().min(1) }).strict()
]);
export type ExtractionRepairTarget = z.infer<typeof extractionRepairTargetSchema>;

const unchanged = z.object({ verdict: z.literal('unchanged'), reason: z.string().trim().min(1).max(500), replacement: z.null() }).strict();
const decision = <T extends z.ZodType>(replacement: T) => z.discriminatedUnion('verdict', [
  unchanged,
  z.object({ verdict: z.literal('replace'), reason: z.string().trim().min(1).max(500), replacement }).strict()
]);
// index.ts 重导出本模块；延迟取既有schema，避免模块循环时读取未初始化绑定。
const candidateDecision = decision(z.lazy(() => observationCandidateSchema));
const timeDecision = decision(z.lazy(() => reportMetadataCandidateSchema.shape.times.element));
const coverageDecision = decision(z.object({ covered: z.literal(true), candidates: z.array(z.lazy(() => observationCandidateSchema)) }).strict());

export const extractionRepairSchema = z.object({
  schemaVersion: z.literal(1), documentId: z.string().min(1), originalCandidateHash: z.string().regex(/^[a-f0-9]{64}$/),
  results: z.array(z.union([
    z.object({ nodeType: z.literal('candidate'), targetId: z.string().min(1), decision: candidateDecision }).strict(),
    z.object({ nodeType: z.literal('metadata_time'), targetId: z.string().min(1), decision: timeDecision }).strict(),
    z.object({ nodeType: z.literal('source_coverage'), targetId: z.string().min(1), decision: coverageDecision }).strict()
  ]))
}).strict();
export type ExtractionRepairV1 = z.infer<typeof extractionRepairSchema>;

export interface ExtractionRepairScope {
  documentId: string;
  originalCandidateHash: string;
  targets: ExtractionRepairTarget[];
  allowedSourceSpanIds: string[];
  targetSourceSpanIds: string[];
}

/** 拼装是纯函数。来源真实性和医学边界仍由后续原接纳门禁检查。 */
export function assembleExtractionRepair(original: ExtractionResult, scope: ExtractionRepairScope, patch: ExtractionRepairV1):
  { ok: true; result: ExtractionResult; changedCandidateKeys: string[] } |
  { ok: false; reason: 'candidate_drift' | 'scope_violation' } {
  if (patch.documentId !== original.documentId || patch.documentId !== scope.documentId
    || patch.originalCandidateHash !== scope.originalCandidateHash) return { ok: false, reason: 'candidate_drift' };
  const targets = new Map(scope.targets.map((target) => [target.targetId, target]));
  const results = new Map(patch.results.map((result) => [result.targetId, result]));
  const originals = new Map(original.candidates.map((candidate) => [candidate.localKey, candidate]));
  if (targets.size !== scope.targets.length || results.size !== patch.results.length
    || targets.size !== results.size || originals.size !== original.candidates.length
    || [...results.keys()].some((key) => !targets.has(key))) return { ok: false, reason: 'scope_violation' };
  const allowed = new Set(scope.allowedSourceSpanIds);
  const outputSources = new Set(scope.targetSourceSpanIds);
  const referencesAllowed = (candidate: ObservationCandidate, requiredSourceId?: string) => {
    const references = [...candidate.evidence, ...(candidate.sourceBinding?.headingEvidence ?? []),
      ...(candidate.sourceBinding?.findingEvidence ?? []), ...(candidate.clinicalContext?.conditions ?? [])];
    const findings = candidate.sourceBinding?.findingEvidence ?? candidate.evidence;
    return references.every((ref) => allowed.has(ref.sourceSpanId))
      && findings.some((ref) => outputSources.has(ref.sourceSpanId) && (!requiredSourceId || ref.sourceSpanId === requiredSourceId));
  };
  const candidates = [...original.candidates];
  let reportMetadata = original.reportMetadata;
  const covered = new Set(original.coveredSourceSpanIds);
  const changedCandidateKeys: string[] = [];
  for (const [targetId, entry] of results) {
    const target = targets.get(targetId)!;
    if (entry.nodeType !== target.nodeType) return { ok: false, reason: 'scope_violation' };
    if (entry.decision.verdict === 'unchanged') continue;
    if (target.nodeType === 'candidate' && entry.nodeType === 'candidate' && entry.decision.verdict === 'replace') {
      const next = entry.decision.replacement;
      const index = candidates.findIndex((candidate) => candidate.localKey === target.localKey);
      if (index < 0 || next.localKey !== target.localKey || targetId !== target.localKey || !referencesAllowed(next)) {
        return { ok: false, reason: 'scope_violation' };
      }
      candidates[index] = next;
      changedCandidateKeys.push(next.localKey);
    } else if (target.nodeType === 'metadata_time' && entry.nodeType === 'metadata_time' && entry.decision.verdict === 'replace') {
      const next = entry.decision.replacement;
      if (!reportMetadata?.times[target.index] || !next.evidence.every((ref) => allowed.has(ref.sourceSpanId))) {
        return { ok: false, reason: 'scope_violation' };
      }
      reportMetadata = { ...reportMetadata, times: reportMetadata.times.map((time, index) => index === target.index ? next : time) };
    } else if (target.nodeType === 'source_coverage' && entry.nodeType === 'source_coverage' && entry.decision.verdict === 'replace') {
      if (covered.has(target.sourceSpanId) || !outputSources.has(target.sourceSpanId)) return { ok: false, reason: 'scope_violation' };
      for (const candidate of entry.decision.replacement.candidates) {
        if (candidates.some((old) => old.localKey === candidate.localKey) || !referencesAllowed(candidate, target.sourceSpanId)) {
          return { ok: false, reason: 'scope_violation' };
        }
        candidates.push(candidate);
        changedCandidateKeys.push(candidate.localKey);
      }
      covered.add(target.sourceSpanId);
    } else return { ok: false, reason: 'scope_violation' };
  }
  return { ok: true, result: { ...original, reportMetadata, coveredSourceSpanIds: [...covered], candidates }, changedCandidateKeys };
}
