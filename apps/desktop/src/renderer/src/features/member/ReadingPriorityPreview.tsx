import type { BodySystemId, MemberOverviewV2 } from '@contracts';
import { assessmentOverviewText } from './assessment-overview-text.js';

/** 收起长整体说明时仍提供已发布的具体重点；不截断解释，也不另生成医学摘要。 */
export function ReadingPriorityPreview({ issues, onSelectSystem, onOpenOverview }: {
  issues: MemberOverviewV2['priorityIssues'];
  onSelectSystem?(id: BodySystemId): void;
  onOpenOverview?(): void;
}) {
  const readable = issues.map((issue) => ({ ...issue,
    title: assessmentOverviewText(issue.title).trim(),
    explanation: assessmentOverviewText(issue.explanation).trim(),
    readingContext: issue.readingContext?.map((context) => assessmentOverviewText(context).trim()).filter(Boolean)
  })).filter((issue) => issue.title);
  let ordinaryCount = 0;
  // 高影响事项不受普通项限额影响；仍沿用已发布顺序，不在展示层重新判断医学轻重。
  const visible = readable.filter((issue) => issue.isHighPriority || ordinaryCount++ < 3);
  if (visible.length === 0) return null;
  const remainingCount = readable.length - visible.length;
  return <section className="reading-priority-preview" aria-label="已发布的重点主题">
    <div className="reading-priority-preview__heading"><span className="eyebrow">先看这些重点</span></div>
    <ul className="reading-priority-preview__list">{visible.map((issue) => <li key={issue.id}>
      <article className="reading-priority-preview__item">
        <h3>{issue.title}</h3>
        {/* 旧投影没有完整解释条件时只提供主题入口，不能把孤立 explanation 当作完整解读。 */}
        {issue.readingContext !== undefined && <details className="reading-priority-preview__details">
          <summary>查看解释与适用条件</summary>
          {[...new Set([issue.explanation, ...issue.readingContext].filter(Boolean))]
            .map((context) => <p key={context}>{context}</p>)}
        </details>}
        {onSelectSystem && <button type="button" className="reading-priority-preview__action"
          aria-label={`查看完整解读：${issue.title}`} onClick={() => onSelectSystem(issue.systemId)}>
          查看完整解读<span aria-hidden="true"> ›</span>
        </button>}
      </article>
    </li>)}</ul>
    {remainingCount > 0 && <p className="reading-priority-preview__remaining">另有{remainingCount}项关注事项，见完整解读</p>}
    {!onSelectSystem && onOpenOverview && <button type="button" className="reading-priority-preview__action" onClick={() => onOpenOverview()}>查看完整整体解读</button>}
  </section>;
}
