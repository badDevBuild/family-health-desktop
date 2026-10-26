import {
  assessmentReviewAuditEvidenceIds,
  type AssessmentRepairReplacement, type AssessmentReviewAudit,
  type AssessmentReviewAuditRecord, type MemberAssessmentCandidateV3, type MemberEvidenceRef
} from '@contracts';
import { stableHash } from '@core';

type Receipt = AssessmentReviewAuditRecord['receipt'];
type Entry = Pick<AssessmentReviewAuditRecord, 'targetId' | 'phase' | 'original' | 'replacement' | 'modelDecision' | 'receipt'>;

export function assessmentAuditNode(candidate: MemberAssessmentCandidateV3, id: string): AssessmentRepairReplacement | null {
  if (id === 'overview') return { nodeType: 'overview', value: candidate.overview };
  const claim = candidate.claims.find((item) => item.id === id);
  if (claim) return { nodeType: 'claim', value: claim };
  const action = candidate.actions.find((item) => item.id === id);
  if (action) return { nodeType: 'action', value: action };
  const system = candidate.systems.find((item) => item.id === id);
  if (system) return { nodeType: 'system', value: system };
  const question = candidate.questions.find((item) => item.id === id);
  if (question) return { nodeType: 'question', value: question };
  const knowledge = candidate.knowledgeSources.find((item) => item.id === id);
  return knowledge ? { nodeType: 'knowledge_source', value: knowledge } : null;
}

/** 只在主进程内存中收集，最终只持久化未发布/程序重建的目标，不保存完整模型响应。 */
export class AssessmentReviewAuditCollector {
  private readonly entries: Entry[] = [];
  private readonly reasons = new Map<string, Set<string>>();
  private readonly entryReasons = new Map<Entry, Set<string>>();
  private readonly latestEntries = new Map<string, Entry>();
  private readonly initial = new Map<string, AssessmentRepairReplacement>();
  private readonly initialReceipt: Receipt;
  private readonly targetReceipts = new Map<string, Receipt>();

  constructor(private readonly personId: string, private readonly inputSignature: string,
    candidate: MemberAssessmentCandidateV3, receipt: Omit<Receipt, 'outputHash'> & { output: unknown }) {
    this.initialReceipt = this.receipt(receipt);
    for (const id of ['overview', ...candidate.systems.map((item) => item.id), ...candidate.claims.map((item) => item.id),
      ...candidate.actions.map((item) => item.id), ...candidate.questions.map((item) => item.id),
      ...candidate.knowledgeSources.map((item) => item.id)]) {
      const node = assessmentAuditNode(candidate, id);
      if (node) this.initial.set(id, structuredClone(node));
    }
  }

  private receipt(receipt: Omit<Receipt, 'outputHash'> & { output: unknown }): Receipt {
    return { stage: receipt.stage, threadId: receipt.threadId, turnId: receipt.turnId, outputHash: stableHash(receipt.output) };
  }

  record(candidate: MemberAssessmentCandidateV3, phase: Entry['phase'],
    receipt: Omit<Receipt, 'outputHash'> & { output: unknown },
    results: Array<{ targetId: string; verdict: 'pass' | 'replace' | 'hold' | 'unchanged';
      reason: string; replacement: AssessmentRepairReplacement | null }>, requestedTargetIds: readonly string[] = results.map((result) => result.targetId)): void {
    const binding = this.receipt(receipt);
    requestedTargetIds.forEach((id) => this.targetReceipts.set(id, binding));
    for (const result of results) {
      const original = assessmentAuditNode(candidate, result.targetId);
      if (!original) continue;
      const entry = structuredClone({ targetId: result.targetId, phase, original,
        replacement: result.replacement, modelDecision: { verdict: result.verdict, reason: result.reason }, receipt: binding });
      this.entries.push(entry);
      this.latestEntries.set(result.targetId, entry);
    }
  }

  localReasons(ids: readonly string[], codes: readonly string[]): void {
    for (const id of ids) {
      const reasons = this.reasons.get(id) ?? new Set<string>();
      codes.forEach((code) => reasons.add(code));
      this.reasons.set(id, reasons);
      // 原因属于发生时的阶段，不能在 finalize 时反向贴给此前已接纳的替换。
      const entry = this.latestEntries.get(id);
      if (entry) {
        const ownReasons = this.entryReasons.get(entry) ?? new Set<string>();
        codes.forEach((code) => ownReasons.add(code));
        this.entryReasons.set(entry, ownReasons);
      }
    }
  }

  finalize(input: { heldTargetIds: readonly string[]; rebuiltNodeIds: readonly string[];
    evidenceCatalog: readonly MemberEvidenceRef[] }): AssessmentReviewAudit {
    const held = new Set(input.heldTargetIds), rebuilt = new Set(input.rebuiltNodeIds);
    const affected = new Set([...held, ...rebuilt]);
    const evidenceIds = new Set(input.evidenceCatalog.map((item) => item.id));
    const observationIds = new Set(input.evidenceCatalog.flatMap((item) => item.observationId ? [item.observationId] : []));
    const selected = this.entries.filter((entry) => affected.has(entry.targetId));
    const finalEntries = new Map(selected.map((entry) => [entry.targetId, entry]));
    for (const id of affected) {
      if (selected.some((entry) => entry.targetId === id)) continue;
      const original = this.initial.get(id);
      if (!original) continue;
      selected.push({ targetId: id, phase: [...this.reasons.get(id) ?? []].some((reason) => reason.includes('dependency'))
        ? 'local_dependency_guard' : 'local_validation',
        original, replacement: null, modelDecision: null, receipt: this.targetReceipts.get(id) ?? this.initialReceipt });
    }
    return {
      version: 1, personId: this.personId, inputSignature: this.inputSignature,
      records: selected.map((entry) => {
        const reasons = [...(entry.modelDecision ? this.entryReasons.get(entry) : this.reasons.get(entry.targetId)) ?? []];
        const finalEntry = finalEntries.get(entry.targetId);
        // outcome 是目标最终终态；后阶段终态引用不是本阶段的拒绝，不补造本阶段校验失败。
        const finalizedInLaterStage = finalEntry !== undefined && finalEntry !== entry;
        const hasOwnLocalReasons = reasons.length > 0;
        if (finalizedInLaterStage) reasons.push(held.has(entry.targetId)
          ? finalEntry.modelDecision?.verdict === 'hold'
            ? 'target_finally_held_by_later_model_review' : 'target_finally_held_in_later_stage'
          : 'target_finally_rebuilt_in_later_stage');
        if (rebuilt.has(entry.targetId) && !reasons.length) reasons.push('local_dependency_graph_rebuilt');
        if (held.has(entry.targetId) && !reasons.length && entry.modelDecision?.verdict !== 'hold') reasons.push('local_validation_held');
        const references = [...new Set([...assessmentReviewAuditEvidenceIds(entry.original),
          ...(entry.replacement ? assessmentReviewAuditEvidenceIds(entry.replacement) : [])])];
        const observationReferences = [...new Set([entry.original, entry.replacement].flatMap((node) =>
          node?.nodeType === 'action' && node.value.sourceInstructionObservationId ? [node.value.sourceInstructionObservationId] : []))];
        const localReasonOverflow = reasons.length > 100
          ? { totalCount: reasons.length, omittedCount: reasons.length - 100, fullHash: stableHash(reasons) } : undefined;
        const record: Omit<AssessmentReviewAuditRecord, 'recordHash'> = { ...entry,
          origin: entry.modelDecision?.verdict === 'hold' ? 'model'
            : reasons.some((reason) => reason.includes('dependency') || reason.includes('premise'))
              ? 'local_dependency_guard' : hasOwnLocalReasons ? 'local_boundary_guard' : 'local_validation',
          outcome: held.has(entry.targetId) ? 'held' : 'rebuilt', localReasonCodes: reasons.slice(0, 100),
          ...(localReasonOverflow ? { localReasonOverflow } : {}),
          boundEvidenceIds: references.filter((id) => evidenceIds.has(id)),
          unboundEvidenceIds: references.filter((id) => !evidenceIds.has(id)),
          boundObservationIds: observationReferences.filter((id) => observationIds.has(id)),
          unboundObservationIds: observationReferences.filter((id) => !observationIds.has(id)) };
        return { ...record, recordHash: stableHash(record) };
      })
    };
  }
}
