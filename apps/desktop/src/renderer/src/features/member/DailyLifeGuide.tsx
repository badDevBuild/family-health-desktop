import type { ReactNode } from 'react';
import { Activity, Eye, Leaf, Moon, Utensils } from 'lucide-react';
import { dailyLifeDomains, type DailyLifeItem } from './daily-life-content.js';
import { memberText } from './member-content.js';

export function DailyLifeGuide({ items, stale, hasAdvice, hasPlans, renderItem, medicalAdvice, plans, questions }: {
  items: DailyLifeItem[];
  stale: boolean;
  hasAdvice: boolean;
  hasPlans: boolean;
  onRefresh(): void;
  renderItem(item: DailyLifeItem, index: number): ReactNode;
  medicalAdvice?: ReactNode;
  plans?: ReactNode;
  questions?: ReactNode;
}) {
  const missingDomains = dailyLifeDomains.filter((domain) => !items.some((item) => item.domain === domain.id));
  const otherItems = items.filter((item) => item.domain === 'other');
  const eligiblePriorities = items.filter((item) => item.proposal?.status !== 'dismissed' && memberText(item.title));
  const dailyPriorities: DailyLifeItem[] = [];
  const selectedDomains = new Set<DailyLifeItem['domain']>();
  // 首页入口先覆盖不同生活主题，完整建议仍按原主题、原顺序保留在下方。
  for (const item of eligiblePriorities) {
    if (selectedDomains.has(item.domain)) continue;
    dailyPriorities.push(item);
    selectedDomains.add(item.domain);
    if (dailyPriorities.length === 3) break;
  }
  if (dailyPriorities.length < 3) {
    const selectedItems = new Set(dailyPriorities);
    dailyPriorities.push(...eligiblePriorities.filter((item) => !selectedItems.has(item)).slice(0, 3 - dailyPriorities.length));
  }
  const openTopic = (domain: string) => {
    const topic = document.getElementById(`daily-life-${domain}`);
    topic?.focus({ preventScroll: true });
    topic?.scrollIntoView({ block: 'start' });
  };
  const domainIcons = { diet: Utensils, activity: Activity, sleep: Moon, supplements: Leaf, daily_routine: Eye };
  return <div className="daily-life-guide">
    <section className="panel daily-life-hero">
      <span className="eyebrow">日常生活</span>
      <h2>{stale && hasAdvice ? '此前的生活建议' : !hasAdvice && hasPlans ? '暂时没有新的行动建议' : '把健康建议放进每天的生活'}</h2>
      <p>{stale ? '这些建议仍可回看。更新健康解读后，再将新的建议加入计划；自己的计划和进度仍保留。' : '从饮食、运动、睡眠和日常照顾一起看，选择适合自己的做法。'}</p>
      <nav className="daily-life-navigation" aria-label="五类日常生活建议">{dailyLifeDomains.map((domain) => {
        const Icon = domainIcons[domain.id];
        const count = items.filter((item) => item.domain === domain.id).length;
        return <button key={domain.id} aria-label={`${domain.title} ${count > 0 ? `${count} 项建议` : '尚无建议'}`} onClick={() => openTopic(domain.id)}><Icon size={22} aria-hidden="true" /><strong>{domain.title}</strong><span>{count > 0 ? `${count} 项建议` : '尚无建议'}</span></button>;
      })}</nav>
      {dailyPriorities.length > 0 && <div className="daily-life-priorities"><h3>先从这些小事开始</h3><ol>{dailyPriorities.map((item) => <li key={item.id}><button onClick={() => openTopic(item.domain)}>{dailyLifeDomains.find((domain) => domain.id === item.domain)?.title ?? '其他日常建议'}：{memberText(item.title)}</button></li>)}</ol></div>}
      {missingDomains.length > 0 && <div className="daily-life-update" role="status"><p>{missingDomains.map((domain) => domain.title).join('、')}方面本次暂未发布可采用的建议。已有报告和建议仍保留；没有可靠建议时保持空白，不需要重复确认或重新上传。</p></div>}
    </section>
    <div className="daily-life-sections">{dailyLifeDomains.map((domain) => {
      const domainItems = items.filter((item) => item.domain === domain.id);
      return <section className="panel daily-life-topic" id={`daily-life-${domain.id}`} key={domain.id} tabIndex={-1} aria-label={domain.title}>
        <div className="panel__heading"><div><h3>{domain.title}</h3><p>{domain.description}</p></div></div>
        {domainItems.length > 0 ? <div className="member-proposal-list">{domainItems.map(renderItem)}</div> : <p className="daily-life-empty">目前还没有这一部分的建议。</p>}
      </section>;
    })}</div>
    {otherItems.length > 0 && <section className="panel daily-life-topic" id="daily-life-other" tabIndex={-1}><h3>其他日常建议</h3><div className="member-proposal-list">{otherItems.map(renderItem)}</div></section>}
    {medicalAdvice}
    {plans}
    {questions}
  </div>;
}
