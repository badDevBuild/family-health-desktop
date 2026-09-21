import { useMemo, useState } from 'react';
import { ChevronDown, FileCheck2, RotateCcw, Search, Tags } from 'lucide-react';
import type { ConceptReviewBundle, ConceptReviewItem, SetConceptMappingInput } from '@contracts';
import { StatusBadge } from '../../components/StatusBadge.js';

type EvidenceRequest = {
  title: string;
  label: string;
  quote: string;
  meta: string;
  sourceSpanId?: string | null;
  documentId?: string | null;
};

function mappingLabel(item: ConceptReviewItem): string {
  if (item.mapping.status === 'unmapped') return '待归类';
  return item.mapping.canonicalName ?? item.mapping.normalizedName;
}

export function ConceptReviewPanel({ bundle, busyObservationId, onSave, onUndo, onOpenEvidence }: {
  bundle: ConceptReviewBundle;
  busyObservationId: string | null;
  onSave(input: SetConceptMappingInput): void;
  onUndo(observationId: string): void;
  onOpenEvidence(request: EvidenceRequest): void;
}) {
  const [query, setQuery] = useState('');
  const [showAll, setShowAll] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const visible = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase('zh-CN');
    return bundle.items.filter((item) => {
      const matches = !normalized || `${item.rawName}${mappingLabel(item)}${item.displayValue}`.toLocaleLowerCase('zh-CN').includes(normalized);
      return matches && (showAll || item.mapping.status !== 'verified' || item.correctedAt !== null);
    });
  }, [bundle.items, query, showAll]);
  const needsReview = bundle.items.filter((item) => item.mapping.status !== 'verified').length;

  return <section className={`concept-review panel${expanded ? ' is-open' : ''}`}>
    <div className="concept-review__summary">
      <div><span className="eyebrow">高级整理 · 可选</span><h2>发现指标名称或趋势分组不对？</h2><p>只有需要修正归类时再打开。这里的操作不会改写报告原文、检查结果或单位。</p></div>
      <div className="concept-review__summary-actions">
        <StatusBadge tone={expanded && needsReview > 0 ? 'warning' : 'neutral'}>{expanded ? `${needsReview} 项未归类` : '默认收起'}</StatusBadge>
        <button className="secondary-button" aria-expanded={expanded} onClick={() => setExpanded((current) => !current)}>{expanded ? '收起高级整理' : '打开高级整理'}<ChevronDown size={17} /></button>
      </div>
    </div>
    {expanded && <div className="concept-review__content">
      <div className="concept-review__tools">
        <label className="member-search"><Search size={18} /><span className="sr-only">搜索指标整理项目</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索原名、标准名或结果" /></label>
        <button className="secondary-button" onClick={() => setShowAll((current) => !current)}>{showAll ? '只看未归类或已修正' : '查看全部指标'}</button>
      </div>
      {visible.length > 0 ? <div className="concept-review__list">{visible.map((item) => {
      const selected = drafts[item.observationId] ?? item.mapping.conceptId ?? '';
      const changed = selected !== (item.mapping.conceptId ?? '');
      const busy = busyObservationId === item.observationId;
      return <article key={item.observationId}>
        <div className="concept-review__source"><Tags size={18} /><div><strong>{item.rawName}</strong><small>{item.displayValue}{item.unit ? ` ${item.unit}` : ''} · {item.clinicalDate ?? '日期待确认'}</small></div></div>
        <label>当前归类<select value={selected} disabled={busy} onChange={(event) => setDrafts((current) => ({ ...current, [item.observationId]: event.target.value }))}><option value="">暂不归类</option>{bundle.catalog.map((concept) => <option key={concept.id} value={concept.id}>{concept.canonicalName}</option>)}</select></label>
        <div className="concept-review__meta"><StatusBadge tone={item.mapping.status === 'verified' ? 'success' : item.mapping.status === 'proposed' ? 'warning' : 'neutral'}>{item.mapping.status === 'verified' ? '已确认' : item.mapping.status === 'proposed' ? '条件不一致' : '待归类'}</StatusBadge><span>映射版本 {item.mappingVersion}</span></div>
        <p>{item.mapping.reasons.join(' ')}</p>
        <div className="concept-review__actions">
          <button className="evidence-link" onClick={() => onOpenEvidence({ title: `${item.rawName}原始依据`, label: item.evidence.label, quote: item.evidence.quote ?? '原始资料中已定位到对应依据。', meta: item.evidence.locator ?? '受控来源定位', sourceSpanId: item.evidence.sourceSpanId, documentId: item.evidence.documentId })}><FileCheck2 size={16} /> 查看原文</button>
          {item.canUndo && <button className="text-button" disabled={busy} onClick={() => onUndo(item.observationId)}><RotateCcw size={16} /> 撤销上次修正</button>}
          <button className="secondary-button" disabled={!changed || busy} onClick={() => onSave({ personId: bundle.personId, observationId: item.observationId, conceptId: selected || null, reason: '用户在指标整理页确认概念归类' })}>{busy ? '正在保存…' : '保存归类'}</button>
        </div>
      </article>;
      })}</div> : <div className="table-empty compact-empty"><Tags size={24} /><strong>{query ? '没有匹配项目' : '当前没有需要整理的指标'}</strong><span>{query ? '可以清空搜索词重试。' : '已验证别名会自动归入标准概念；不确定项目仍保留原始名称。'}</span></div>}
    </div>}
  </section>;
}
