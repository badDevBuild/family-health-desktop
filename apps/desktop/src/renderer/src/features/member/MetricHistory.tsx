import { useEffect, useRef, useState } from 'react';
import { FileCheck2 } from 'lucide-react';
import type { MemberEvidenceRef, MetricSeriesDetailV2 } from '@contracts';
import { MemberTrendChart } from './MemberTrendChart.js';
import { formatResult, sortHistoryPoints } from './metric-presentation.js';
import { memberText, reportDateLabel, uniqueMemberTexts } from './member-content.js';

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
  const referenceRange = (point: MetricSeriesDetailV2['tableRows'][number]) => {
    if (point.referenceLow !== null && point.referenceHigh !== null) return `报告参考范围：${formatResult(`${point.referenceLow}–${point.referenceHigh}`, point.unit)}`;
    if (point.referenceHigh !== null) return `报告参考上限：${formatResult(String(point.referenceHigh), point.unit)}`;
    if (point.referenceLow !== null) return `报告参考下限：${formatResult(String(point.referenceLow), point.unit)}`;
    return '报告未记录参考范围';
  };
  const limitations = uniqueMemberTexts(selected.trendFacts.reasons, [memberText(selected.trendFacts.statement)]);

  return <section ref={container} tabIndex={-1} className="member-metric-detail" aria-label={`${series[0]!.name}指标历史`}>
    <button className="text-button" onClick={onBack}>← 返回身体系统</button>
    <div className="panel__heading"><div><span className="eyebrow">指标历史</span><h2>{series[0]!.name}</h2></div><span>共 {rows.length} 条记录</span></div>
    {series.length > 1 && <div className="metric-comparison-picker">
      <p>单位、标本或检测方法不同，或检测条件未记录的结果，分组查看，不能直接比较。</p>
      <label>选择趋势分组<select value={selected.id} onChange={(event) => setSelectedId(event.target.value)}>{series.map((item, index) => <option key={item.id} value={item.id}>第 {index + 1} 组 · {item.points.length} 条 · {item.unit ?? '单位未记录'}</option>)}</select></label>
    </div>}
    <details className="analysis-boundaries"><summary>{series.length > 1 ? '为什么分开比较' : '查看检测条件'}</summary><p>单位、标本、检测方法和部位会影响结果能否直接比较。条件未记录的结果保留在历史表格中。</p>{series.map((item, index) => <p key={item.id}>{series.length > 1 ? `第 ${index + 1} 组：` : ''}{conditions(item)}</p>)}</details>
    <MemberTrendChart series={selected} />
    {limitations.length > 0 && <details className="analysis-boundaries"><summary>理解这些变化时需注意</summary>{limitations.map((text) => <p key={text}>{text}</p>)}</details>}
    <h3>全部历史记录</h3>
    <p className="muted-copy">优先按检查日期排列；单项日期未明确时，按有依据的报告日期记录并标注。历史对照使用自己的日期，仍未对应的保留说明。</p>
    <div className="metric-history-table" role="table" aria-label={`${series[0]!.name}历史记录`}>
      <div role="row" className="metric-history-table__head"><span role="columnheader">日期与报告时间</span><span role="columnheader">结果</span><span role="columnheader">报告标记</span><span role="columnheader">原始依据</span></div>
      {rows.map((point) => {
        const sources = point.evidenceSources?.length ? point.evidenceSources : [point.evidence];
        return <div role="row" key={`${point.seriesId}-${point.id}`}>
          <span role="cell">{reportDateLabel(point.time.value ? point.time.displayLabel : point.documentTime?.displayLabel ?? point.time.displayLabel)}{!point.time.value && point.documentTime && <small className="metric-row-group">单项检查日期尚未对应</small>}{series.length > 1 && <small className="metric-row-group">第 {groupNumber(point.seriesId)} 组</small>}</span>
          <span role="cell"><strong>{formatResult(point.displayValue, point.unit)}</strong><small className="metric-row-group">{referenceRange(point)}</small></span>
          <span role="cell">{flagLabels[point.abnormalFlag]}</span>
          <span role="cell">{sources.length === 1
            ? <button className="evidence-link" onClick={() => onOpenEvidence(`${series[0]!.name}原始依据`, sources[0]!)}><FileCheck2 size={16} /> 查看依据</button>
            : <details className="evidence-disclosure evidence-disclosure--compact"><summary>查看 {sources.length} 处依据</summary><div className="evidence-source-list">{sources.map((source, index) => <button key={`${source.id}-${index}`} className="evidence-link" onClick={() => onOpenEvidence(`${series[0]!.name}原始依据 ${index + 1}`, source)}>依据 {index + 1}</button>)}</div></details>}</span>
        </div>;
      })}
    </div>
  </section>;
}
