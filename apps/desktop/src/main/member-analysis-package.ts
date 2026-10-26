import { metricSeriesSummarySchema, type MemberEvidencePackageV3 } from '@contracts';
import { createMemberEvidenceTransport, aliasMemberEvidenceReferences,
  restoreMemberEvidenceReferences } from './member-evidence-transport.js';

type Fact = MemberEvidencePackageV3['facts'][number];
type AnalysisFact = Omit<Fact, 'clinicalContext' | 'evidenceIds' | 'systemIds' | 'sourceKind'> & {
  conditions: string[];
  contextStatus: 'complete' | 'unresolved' | 'legacy';
};
type SourceIndex = Pick<MemberEvidencePackageV3['evidenceCatalog'][number],
  'id' | 'kind' | 'observationId' | 'documentId' | 'knowledgeId'>;

/** 个人结果引用事实编号；事实到原件的多对多关系只留在本地。 */
export interface MemberAnalysisPackage extends Omit<MemberEvidencePackageV3, 'facts' | 'evidenceCatalog'> {
  analysisFormat: 'member-analysis-v2';
  factSourceKind: 'report';
  facts: AnalysisFact[];
  systemGroups: Array<{ systemIds: Fact['systemIds']; observationIds: string[] }>;
  evidenceCatalog: SourceIndex[];
  sourceContext: Array<{ observationIds: string[]; quote: string }>;
}

export function buildMemberAnalysisPackage(input: MemberEvidencePackageV3,
  analysisSourceCatalog: readonly MemberEvidencePackageV3['evidenceCatalog'][number][] = input.evidenceCatalog): MemberAnalysisPackage {
  const facts = new Map(input.facts.map((fact) => [fact.observationId, fact]));
  const systemGroups = new Map<string, MemberAnalysisPackage['systemGroups'][number]>();
  for (const fact of input.facts) {
    const key = JSON.stringify(fact.systemIds);
    const group = systemGroups.get(key) ?? { systemIds: [...fact.systemIds], observationIds: [] };
    group.observationIds.push(fact.observationId);
    systemGroups.set(key, group);
  }
  const context = new Map<string, MemberAnalysisPackage['sourceContext'][number]>();
  const retainContext = (quote: string | null, observationId: string | null) => {
    if (!quote?.trim() || !observationId || !facts.has(observationId)) return;
    // 已完成语义条件提取后，不再用字符串是否相同决定是否重发原文。
    if (facts.get(observationId)!.clinicalContext?.status === 'complete') return;
    const existing = context.get(quote) ?? { observationIds: [], quote };
    if (!existing.observationIds.includes(observationId)) existing.observationIds.push(observationId);
    context.set(quote, existing);
  };
  // 综合传输沿用整理条件后的原始引用；本机核对实体化的全文不能变成新增上下文。
  for (const evidence of analysisSourceCatalog) retainContext(evidence.quote, evidence.observationId);
  const trends: MemberEvidencePackageV3['trends'] = [];
  for (const trend of input.trends) {
    const parsed = metricSeriesSummarySchema.safeParse(trend.payload);
    if (!parsed.success || parsed.data.points.some((point) => {
      const fact = facts.get(point.observationId);
      return !fact || fact.rawValue !== point.displayValue || (fact.clinicalDate ?? fact.effectiveTime?.value ?? null) !== point.time.value
        || fact.reportedAbnormalFlag !== point.abnormalFlag;
    })) {
      // 未知/冲突的结构不能当作冗余删除；保持显式回退，供模型保留不确定性。
      trends.push(structuredClone(trend));
      continue;
    }
    const series = parsed.data;
    for (const point of series.points) {
      for (const evidence of [point.evidence, ...(point.evidenceSources ?? [])]) retainContext(evidence.quote, point.observationId);
    }
    if (series.points.length < 2 && series.points.every((point) => point.time.role === 'unknown'
      && ['explicit', 'unknown'].includes(point.time.source) && point.time.endValue === null
      && point.time.precision === (point.time.value ? 'day' : 'unknown'))) continue;
    trends.push({ id: trend.id, systemIds: [...trend.systemIds], payload: {
      name: series.name, conceptId: series.conceptId, mappingStatus: series.mappingStatus, unit: series.unit,
      trendFacts: structuredClone(series.trendFacts),
      points: series.points.map((point) => {
        const fact = facts.get(point.observationId)!;
        // 只省略与事实字段严格等价的副本；归一化差异、可比性和日期性质不靠猜测裁剪。
        const rawNumber = fact.valueKind === 'numeric' && /^-?\d+(?:\.\d+)?$/.test(fact.rawValue)
          ? Number(fact.rawValue) : null;
        return { observationId: point.observationId,
          ...(rawNumber !== point.numericValue ? { numericValue: point.numericValue } : {}),
          ...(fact.qualifier !== point.comparator ? { comparator: point.comparator } : {}),
          ...(fact.unit !== point.unit ? { unit: point.unit } : {}),
          referenceLow: point.referenceLow, referenceHigh: point.referenceHigh,
          comparable: point.comparable, comparabilityReasons: [...point.comparabilityReasons],
          duplicateSourceCount: point.duplicateSourceCount ?? 0,
          time: { endValue: point.time.endValue, precision: point.time.precision,
            role: point.time.role, source: point.time.source, ...(point.time.basis ? { basis: point.time.basis } : {}) }
        };
      })
    } });
  }
  return {
    ...structuredClone(input), analysisFormat: 'member-analysis-v2', factSourceKind: 'report',
    systemGroups: [...systemGroups.values()],
    facts: input.facts.map(({ clinicalContext, evidenceIds: _evidence, systemIds: _systems,
      sourceKind: _sourceKind, ...fact }) => ({ ...structuredClone(fact),
      conditions: [...new Set((clinicalContext?.conditions ?? []).map((condition) => condition.quote))],
      contextStatus: clinicalContext?.status ?? 'legacy'
    })),
    evidenceCatalog: input.evidenceCatalog.filter((ref) => ref.kind !== 'observation')
      .map(({ id, kind, observationId, documentId, knowledgeId }) => ({ id, kind, observationId, documentId, knowledgeId })),
    trends, sourceContext: [...context.values()]
  };
}

/** 只转换证据引用字段，不能替换正文、节点 ID、趋势 ID 或其他普通字符串。 */
function mapCitations<T>(input: T, mapping: ReadonlyMap<string, string[]>, key = ''): T {
  if (Array.isArray(input)) {
    if (['evidenceIds', 'counterEvidenceIds', 'currentEvidenceIds', 'previousEvidenceIds'].includes(key)) {
      return [...new Set(input.flatMap((id) => typeof id === 'string' ? mapping.get(id) ?? [id] : [id]))] as T;
    }
    return input.map((item) => mapCitations(item, mapping, key)) as T;
  }
  if (input !== null && typeof input === 'object') return Object.fromEntries(Object.entries(input)
    .map(([field, value]) => [field, mapCitations(value, mapping, field)])) as T;
  return input;
}

export function createMemberAnalysisTransport(input: MemberEvidencePackageV3,
  analysisSourceCatalog: readonly MemberEvidencePackageV3['evidenceCatalog'][number][] = input.evidenceCatalog) {
  const transport = createMemberEvidenceTransport(buildMemberAnalysisPackage(input, analysisSourceCatalog));
  const toEvidence = new Map(input.facts.map((fact) => [fact.observationId, fact.evidenceIds]));
  const toFacts = new Map<string, string[]>();
  for (const fact of input.facts) for (const id of fact.evidenceIds) {
    toFacts.set(id, [...new Set([...(toFacts.get(id) ?? []), fact.observationId])]);
  }
  return { ...transport,
    restoreOutput: <T>(output: T): T => mapCitations(restoreMemberEvidenceReferences(output, transport.referenceIds), toEvidence),
    aliasCandidate: <T>(candidate: T): T => aliasMemberEvidenceReferences(mapCitations(candidate, toFacts), transport.referenceIds)
  };
}
