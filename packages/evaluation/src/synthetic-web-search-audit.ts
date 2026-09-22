/** 仅供纯合成联网评测读取已完成的 Web Search 事件；这是发送后观察，不是发送前拦截。 */
export function completedSyntheticSearchAction(value: unknown): { id: string; queries: string[] | null } | null {
  if (!value || typeof value !== 'object') return null;
  const item = value as { id?: unknown; type?: unknown; action?: {
    type?: unknown; query?: unknown; queries?: unknown
  } };
  if (item.type !== 'webSearch' || item.action?.type !== 'search' || typeof item.id !== 'string') return null;
  const batchQueries = Array.isArray(item.action.queries)
    ? item.action.queries.filter((query): query is string => typeof query === 'string' && query.length > 0) : [];
  const queries = batchQueries.length > 0 ? batchQueries
    : typeof item.action.query === 'string' && item.action.query.length > 0 ? [item.action.query] : null;
  return { id: item.id, queries };
}

/** 只返回泄露类别，不把任何原始查询词写入回执。 */
export function syntheticQueryMatchKinds(
  queries: string[], personId: string, facts: Array<{ clinicalDate: string | null; rawValue: string }>
): Array<'member_id' | 'clinical_date' | 'measurement_value'> {
  const normalized = queries.map((query) => query.toLowerCase());
  const matches = (fragment: string | null) => {
    if (!fragment) return false;
    return normalized.some((query) => query.includes(fragment.toLowerCase()));
  };
  const matchesMeasuredValue = (value: string) => {
    if (!/^\d+(?:\.\d+)?$/.test(value)) return matches(value);
    const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const boundedValue = new RegExp(`(^|[^\\d.])${escaped}(?=$|[^\\d.])`);
    return normalized.some((query) => boundedValue.test(query));
  };
  const kinds: Array<'member_id' | 'clinical_date' | 'measurement_value'> = [];
  if (matches(personId)) kinds.push('member_id');
  if (facts.some((fact) => matches(fact.clinicalDate))) kinds.push('clinical_date');
  if (facts.some((fact) => matchesMeasuredValue(fact.rawValue))) kinds.push('measurement_value');
  return kinds;
}
