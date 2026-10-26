import type { ExtractionResult, ExtractionRepairTarget, ExtractionRepairV1 } from '@contracts';
import { scopeCandidateKeys } from './processing-pipeline.js';

/** 仅合成测试适配：把既有双份测试候选转换为新目标补丁，不用于正式运行时。 */
export function syntheticExtractionRepair(prompt: string, original: ExtractionResult, corrected: ExtractionResult): ExtractionRepairV1 {
  const request = JSON.parse(prompt.split('REPAIR_REQUEST=')[1]!.split('\n')[0]!) as {
    documentId: string; originalCandidateHash: string; targets: ExtractionRepairTarget[];
  };
  const candidateTarget = request.targets.find((target) => target.nodeType === 'candidate');
  const chunkIndex = candidateTarget?.nodeType === 'candidate'
    ? Number(/^chunk-(\d+)-/.exec(candidateTarget.localKey)?.[1] ?? 1) - 1 : 0;
  const old = scopeCandidateKeys(original.candidates, chunkIndex);
  const next = scopeCandidateKeys(corrected.candidates, chunkIndex);
  const items = JSON.parse(prompt.split('TARGET_ITEMS=')[1]!) as Array<{ targetId: string; value?: { originalName?: string } }>;
  return { schemaVersion: 1, documentId: request.documentId, originalCandidateHash: request.originalCandidateHash,
    results: request.targets.map((target) => {
      if (target.nodeType === 'candidate') {
        const originalName = items.find((item) => item.targetId === target.targetId)?.value?.originalName;
        const sameName = next.filter((candidate) => candidate.originalName === originalName);
        const located = next.find((candidate) => candidate.localKey === target.localKey)
          ?? (sameName.length === 1 ? sameName[0] : undefined);
        const replacement = located ? { ...located, localKey: target.localKey } : undefined;
        return { nodeType: target.nodeType, targetId: target.targetId, decision: replacement
          ? { verdict: 'replace' as const, reason: '纯合成测试原句修正', replacement }
          : { verdict: 'unchanged' as const, reason: '保留原目标，由本机规则确认空栏或保留缺口', replacement: null } };
      }
      if (target.nodeType === 'metadata_time') {
        const replacement = corrected.reportMetadata?.times[target.index];
        return { nodeType: target.nodeType, targetId: target.targetId, decision: replacement
          ? { verdict: 'replace' as const, reason: '纯合成测试时间修正', replacement }
          : { verdict: 'unchanged' as const, reason: '没有新的可靠时间', replacement: null } };
      }
      return { nodeType: target.nodeType, targetId: target.targetId, decision: corrected.coveredSourceSpanIds.includes(target.sourceSpanId)
        ? { verdict: 'replace' as const, reason: '纯合成测试来源覆盖', replacement: { covered: true as const,
          candidates: next.filter((candidate) => !old.some((previous) => previous.localKey === candidate.localKey)
            && (candidate.sourceBinding?.findingEvidence ?? candidate.evidence).some((ref) => ref.sourceSpanId === target.sourceSpanId)) } }
        : { verdict: 'unchanged' as const, reason: '仍没有完成该来源', replacement: null } };
    }) };
}
