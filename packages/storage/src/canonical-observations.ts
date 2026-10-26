import type { ReportReconciliationFact, ReportSourcePageScope, ResolvedReportSourceBinding } from '@core';
import { directOriginalAlignedSourceFramesProveSameSlot, directOriginalContainedSourceProvesDuplicateSlot,
  isVerifiedDirectOriginalSourceBinding, reportSourcePagesProvenDistinct } from '@core';

/** 这里只选择已保存修订；不合成医疗字段，也不把别名当作覆盖旧修订的权限。 */
export interface CanonicalStoredObservation {
  observationId: string;
  personId: string;
  documentId: string;
  revision: number;
  createdAt: string;
  /** 当前读取实际使用的事件日期；不可因revision日期相同而吞掉不同事件锚点。 */
  displayClinicalDate: string | null;
  acceptanceActor: string;
  userLocked: boolean;
  fact: ReportReconciliationFact;
  binding: ResolvedReportSourceBinding | null;
  contextGrounded: boolean;
  sourcePageScope?: ReportSourcePageScope | null;
}

export interface CanonicalStoredObservationSelection<T extends CanonicalStoredObservation> {
  observations: T[];
  /** 含自身映射；仅供来源追溯，不改变原ID、CAS或修订。 */
  canonicalIdByObservationId: Map<string, string>;
}

const immutableMedicalFields = ['originalName', 'rawText', 'valueKind', 'decimalValue', 'qualifier', 'unit',
  'referenceRange', 'abnormalFlag', 'specimen', 'method', 'bodySite', 'clinicalDate'] as const;

function sameImmutableMedicalFields(left: ReportReconciliationFact, right: ReportReconciliationFact): boolean {
  // 只折叠排版等价，不拼接 token、不改数字/单位/否定/左右侧；null与缺失不互换。
  const layout = (value: string) => value.replace(/[\uFF01-\uFF5E]/gu,
    (character) => String.fromCharCode(character.charCodeAt(0) - 0xFEE0)).replace(/\s+/gu, ' ').trim();
  const layoutFields = new Set(['originalName', 'rawText', 'referenceRange']);
  return immutableMedicalFields.every((field) => left[field] === right[field]
    || layoutFields.has(field) && typeof left[field] === 'string' && typeof right[field] === 'string'
      && layout(left[field]!) === layout(right[field]!));
}

/**
 * 先构造已证明同位置的竞争组，再检查完整医疗字段。
 * 无法重证的文档、非两两唯一或存在锁/人工接纳/字段冲突的竞争组保留，不按名称或同值挑赢家。
 * 有来源但未证明同槽的宽引用单独保留；折叠另一已证重复对不表示该宽引用已解决。
 */
export function selectCanonicalStoredObservations<T extends CanonicalStoredObservation>(
  entries: readonly T[]
): CanonicalStoredObservationSelection<T> {
  const canonicalIdByObservationId = new Map(entries.map((entry) => [entry.observationId, entry.observationId]));
  if (canonicalIdByObservationId.size !== entries.length) return { observations: [...entries], canonicalIdByObservationId };
  const groups = new Map<string, T[]>();
  for (const entry of entries) {
    const key = JSON.stringify([entry.personId, entry.documentId]);
    const group = groups.get(key) ?? [];
    group.push(entry); groups.set(key, group);
  }
  const hidden = new Set<string>();
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    // 未定位的既有事实仍可能是竞争旧槽；不能借已定位的另两条将它排除。
    const unlocated = group.filter((entry) => !entry.binding || entry.binding.documentId !== entry.documentId
      || !isVerifiedDirectOriginalSourceBinding(entry.binding));
    const adjacent = group.map(() => new Set<number>());
    for (let left = 0; left < group.length; left += 1) {
      for (let right = left + 1; right < group.length; right += 1) {
        const a = group[left]!; const b = group[right]!;
        if (unlocated.includes(a) || unlocated.includes(b)) continue;
        if (!directOriginalAlignedSourceFramesProveSameSlot(a.binding!, b.binding!)
          && !directOriginalContainedSourceProvesDuplicateSlot(a.binding!, b.binding!)
          && !directOriginalContainedSourceProvesDuplicateSlot(b.binding!, a.binding!)) continue;
        adjacent[left]!.add(right); adjacent[right]!.add(left);
      }
    }
    const visited = new Set<number>();
    for (let start = 0; start < group.length; start += 1) {
      if (visited.has(start)) continue;
      const component = [start]; visited.add(start);
      for (let cursor = 0; cursor < component.length; cursor += 1) {
        for (const neighbor of adjacent[component[cursor]!]!) {
          if (!visited.has(neighbor)) { visited.add(neighbor); component.push(neighbor); }
        }
      }
      if (component.length < 2 || component.some((index) =>
        component.some((other) => other !== index && !adjacent[index]!.has(other)))) continue;
      const rows = component.map((index) => group[index]!);
      if (unlocated.some((entry) => rows.some((row) =>
        !reportSourcePagesProvenDistinct(row.binding!, entry.sourcePageScope)))) continue;
      if (rows.some((entry) => entry.userLocked || entry.acceptanceActor !== 'policy'
        || !Number.isInteger(entry.revision) || entry.revision < 1)) continue;
      if (rows.some((entry) => !sameImmutableMedicalFields(rows[0]!.fact, entry.fact))) continue;
      if (rows.some((entry) => entry.displayClinicalDate !== rows[0]!.displayClinicalDate)) continue;
      const contexts = rows.filter((entry) => entry.fact.clinicalContext != null);
      if (contexts.some((entry) => JSON.stringify(entry.fact.clinicalContext) !== JSON.stringify(contexts[0]!.fact.clinicalContext))) continue;
      // 只有真正缺失的条件可投影到已存的完整有源版本；unknown/partial不能冒充缺失。
      if (contexts.length && contexts.length !== rows.length && contexts.some((entry) =>
        !entry.contextGrounded || entry.fact.clinicalContext?.status !== 'complete'
        || entry.fact.clinicalContext.conditions.length === 0)) continue;
      const eligible = contexts.length && contexts.length !== rows.length ? contexts : rows;
      const canonical = [...eligible].sort((left, right) => left.createdAt.localeCompare(right.createdAt)
        || left.observationId.localeCompare(right.observationId))[0]!;
      for (const entry of rows) {
        canonicalIdByObservationId.set(entry.observationId, canonical.observationId);
        if (entry !== canonical) hidden.add(entry.observationId);
      }
    }
  }
  return { observations: entries.filter((entry) => !hidden.has(entry.observationId)), canonicalIdByObservationId };
}
