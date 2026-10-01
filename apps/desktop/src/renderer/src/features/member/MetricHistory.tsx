import { useEffect, useRef, useState } from 'react';
import { FileCheck2 } from 'lucide-react';
import type { MemberEvidenceRef, MetricSeriesDetailV2 } from '@contracts';
import { MemberTrendChart } from './MemberTrendChart.js';
import { formatResult, sortHistoryPoints } from './metric-presentation.js';

const flagLabels = { high: '偏高', low: '偏低', positive: '阳性', negative: '阴性', normal: '正常', unknown: '未标记' };

export function MetricHistory({ series, onBack, onOpenEvidence }: {
  series: MetricSeriesDetailV2[];
  onBack(): void;
  onOpenEvidence(title: string, evidence: MemberEvidenceRef): void;
}) {
  const [selectedId, setSelectedId] = useState(series[0]!.id);
  const container = useRef<HTMLElement>(null);
  useEffect(() => {
    // 从长列表进入详情时，标题和分组选择必须出现在首屏，不能沿用列表底部的位置。
    container.current?.scrollIntoView?.({ block: 'start' });
    container.current?.focus({ preventScroll: true });
  }, []);
  const selected = series.find((item) => item.id === selectedId) ?? series[0]!;
  const rows = sortHistoryPoints(series.flatMap((item) => item.tableRows.map((point) => ({ ...point, seriesId: item.id }))));
  const groupNumber = (id: string) => series.findIndex((item) => item.id === id) + 1;
  const conditions = (item: MetricSeriesDetailV2) => [
    `单位：${item.unit ?? '未记录'}`,
    `标本：${item.comparisonConditions.specimen ?? '未记录'}`,
    `方法：${item.comparisonConditions.method ?? '未记录'}`,
    `部位：${item.comparisonConditions.bodySite ?? '未记录'}`
  ].join(' · ');

  return <section ref={container} tabIndex={-1} className="member-metric-detail" aria-label={`${series[0]!.name}指标历史`}>
    <button className="text-button" onClick={onBack}>← 返回身体系统</button>
    <div className="panel__heading"><div><span className="eyebrow">指标历史</span><h2>{series[0]!.name}</h2></div><span>共 {rows.length} 条记录</span></div>
    {series.length > 1 && <div className="metric-comparison-picker">
      <p>全部历史已集中在这里。单位、标本或检测方法不同，以及条件未记录的资料，分组查看趋势，不直接连成一条线。</p>
      <label>选择趋势分组<select value={selected.id} onChange={(event) => setSelectedId(event.target.value)}>{series.map((item, index) => <option key={item.id} value={item.id}>第 {index + 1} 组 · {item.points.length} 条 · {conditions(item)}</option>)}</select></label>
    </div>}
    <p className="muted-copy">{conditions(selected)}</p>
    <MemberTrendChart series={selected} />
    {selected.trendFacts.reasons.length > 0 && <details className="analysis-boundaries"><summary>为什么这样分组</summary><p>{selected.trendFacts.reasons.join(' ')}</p></details>}
    <h3>全部历史记录</h3>
    <p className="muted-copy">最新的有日期记录排在前面；日期未明确的记录放在最后，不补时间。</p>
    <div className="metric-history-table" role="table" aria-label={`${series[0]!.name}历史记录`}>
      <div role="row" className="metric-history-table__head"><span role="columnheader">检查日期</span><span role="columnheader">结果</span><span role="columnheader">报告标记</span><span role="columnheader">原始依据</span></div>
      {rows.map((point) => {
        const sources = point.evidenceSources?.length ? point.evidenceSources : [point.evidence];
        return <div role="row" key={`${point.seriesId}-${point.id}`}>
          <span role="cell">{point.time.displayLabel}{series.length > 1 && <small className="metric-row-group">第 {groupNumber(point.seriesId)} 组</small>}</span>
          <strong role="cell">{formatResult(point.displayValue, point.unit)}</strong>
          <span role="cell">{flagLabels[point.abnormalFlag]}</span>
          <span role="cell">{sources.length === 1
            ? <button className="evidence-link" onClick={() => onOpenEvidence(`${series[0]!.name}原始依据`, sources[0]!)}><FileCheck2 size={16} /> 查看依据</button>
            : <details className="evidence-disclosure evidence-disclosure--compact"><summary>查看 {sources.length} 处依据</summary><div className="evidence-source-list">{sources.map((source, index) => <button key={`${source.id}-${index}`} className="evidence-link" onClick={() => onOpenEvidence(`${series[0]!.name}原始依据 ${index + 1}`, source)}>依据 {index + 1}</button>)}</div></details>}</span>
        </div>;
      })}
    </div>
  </section>;
}
