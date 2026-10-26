import type { MetricSeriesSummary, TrendPointV2 } from '@contracts';
import { formatResult } from '@contracts';
export { formatResult } from '@contracts';

/** 只整理阅读入口，不修改事实、概念映射或严格的可比序列。 */
export function groupMetricSeries(series: MetricSeriesSummary[]) {
  const groups = new Map<string, MetricSeriesSummary[]>();
  for (const item of series) {
    const identity = item.mappingStatus === 'verified' && item.conceptId
      ? `concept:${item.conceptId}`
      : `raw:${item.name.normalize('NFKC').toLocaleLowerCase('zh-CN').replace(/\s+/g, '')}`;
    const group = groups.get(identity) ?? [];
    group.push(item);
    groups.set(identity, group);
  }
  return [...groups.values()].map((items) => {
    const points = sortHistoryPoints(items.flatMap((item) => item.points));
    const dated = points.filter((point) => point.timestamp !== null);
    const lastDate = dated[0]?.time.value ?? null;
    const latest = dated.length > 0 ? dated.filter((point) => point.time.value === lastDate) : points;
    const values = new Set(latest.map((point) => formatResult(point.displayValue, point.unit)));
    const documentLabels = new Set(points.filter(point => point.timestamp === null)
      .map(point => point.documentTime?.displayLabel).filter((label): label is string => Boolean(label)));
    const reportDatedCount = points.filter(point => point.timestamp === null && point.documentTime?.value).length;
    return {
      id: items[0]!.id,
      name: items[0]!.name,
      series: items,
      pointCount: points.length,
      latestDate: lastDate,
      dateLabel: lastDate ? `${lastDate}${latest.some(point => point.time.basis === 'report') ? ' · 按报告日期记录' : ''}`
        : (documentLabels.size === 1 && reportDatedCount === points.length
        ? [...documentLabels][0]! : reportDatedCount === points.length ? '分属不同报告，查看来源时间'
          : reportDatedCount > 0 ? '部分记录只有所属报告时间' : '检查及报告日期未记录'),
      latestValue: values.size === 1 ? [...values][0]! : dated.length > 0 ? '同日多条结果'
        : reportDatedCount > 0 ? '多条记录，详见来源时间' : '多条日期未明记录',
      description: items.length === 1 ? items[0]!.trendFacts.statement
        : `共 ${points.length} 条记录 · 分 ${items.length} 组查看趋势`,
      undatedCount: points.length - dated.length,
      reportDatedCount,
      unknownDateCount: points.length - dated.length - reportDatedCount
    };
  });
}

export function sortHistoryPoints<T extends TrendPointV2>(points: T[]): T[] {
  return [...points].sort((a, b) => (b.timestamp ?? -Infinity) - (a.timestamp ?? -Infinity)
    || a.id.localeCompare(b.id));
}

/** 仅识别明确的空白占位。阴性、未见异常、零值都是真实结果。 */
export function isUnprovidedResult(value: string): boolean {
  return /^(?:无数据|未填写|未提供(?:结果)?|未报告|未检测|未检查|未查|空白|[-—–/]+)?$/.test(value.trim());
}
