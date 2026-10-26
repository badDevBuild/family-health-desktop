import type { BodySystemId, BodySystemSummaryV2 } from '@contracts';
import { systemReadingStatus } from './system-reading-status.js';

const readingGroups = [
  { id: 'attention', title: '值得留意', description: '从需要关注或继续观察的部分读起。' },
  { id: 'reassuring', title: '本次未提示问题', description: '只说明已有检查的范围，不等于全身都正常。' },
  { id: 'recorded', title: '已有检查记录', description: '已有相关资料可查看，暂不能概括整个系统的情况。' },
  { id: 'limited', title: '尚无相关检查', description: '目前没有可展示的相关检查记录，不能据此判断是否正常。' }
] as const;

/** 只投影已发布的系统状态与相关记录范围，不从数值或缺失资料推断健康结论。 */
export function ReadingHealthMap({ systems, onSelectSystem, compact = false }: {
  systems: BodySystemSummaryV2[];
  onSelectSystem?(id: BodySystemId): void;
  compact?: boolean;
}) {
  if (systems.length === 0) return null;
  const groups = readingGroups.map((group) => ({ ...group,
    members: systems.filter((system) => systemReadingStatus(system).group === group.id)
  })).filter((group) => group.members.length > 0);
  return <section className={`reading-health-map${compact ? ' reading-health-map--compact' : ''}`} aria-label="身体情况速览">
    <div className="reading-health-map__heading"><span className="eyebrow">身体情况速览</span><p>按已有检查看，不用一个分数概括身体。</p></div>
    <div className={`reading-health-map__groups${groups.length === 4 ? ' reading-health-map__groups--four' : ''}`}>{groups.map((group) => {
      return <section className={`reading-health-map__group is-${group.id}`} key={group.id} aria-label={group.title}>
        <h3><i aria-hidden="true" />{group.title}</h3>
        <p>{group.description}</p>
        <ul>{group.members.map((system) => <li key={system.id}>{onSelectSystem
          ? <button onClick={() => onSelectSystem(system.id)} aria-label={`查看${system.shortName}：${group.title}`}>{system.shortName}<span aria-hidden="true">›</span></button>
          : <span className="reading-health-map__system">{system.shortName}</span>}</li>)}</ul>
      </section>;
    })}</div>
  </section>;
}
