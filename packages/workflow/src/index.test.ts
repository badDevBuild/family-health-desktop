import { describe, expect, it } from 'vitest';
import { LeaseCoordinator, decideRetry, determineEligibleSlot, freezeBatch, jobInputSignature, nextScheduledRunUtc } from './index.js';

describe('每日调度', () => {
  const config = {
    id: 'daily',
    enabled: true,
    localTime: '20:00' as const,
    timeZone: 'Asia/Shanghai',
    revision: 2,
    lastSlot: null
  };

  it('时点前不运行，时点后只产生稳定 slot', () => {
    expect(determineEligibleSlot(config, new Date('2026-09-18T11:59:59Z'), true)).toBeNull();
    const slot = determineEligibleSlot(config, new Date('2026-09-18T12:00:00Z'), true);
    expect(slot).toMatchObject({ key: 'daily:2026-09-18:r2', missed: false });
    expect(determineEligibleSlot({ ...config, lastSlot: slot!.key }, new Date('2026-09-18T12:30:00Z'), true)).toBeNull();
  });

  it('空队列不建立批次', () => {
    expect(determineEligibleSlot(config, new Date('2026-09-18T13:00:00Z'), false)).toBeNull();
  });

  it('下一次运行按真实时区分钟计算，不用固定 24 小时间隔', () => {
    expect(nextScheduledRunUtc('20:00', 'Asia/Shanghai', new Date('2026-09-18T10:00:00Z')))
      .toBe('2026-09-18T12:00:00.000Z');
    expect(nextScheduledRunUtc('20:00', 'Asia/Shanghai', new Date('2026-09-18T13:00:00Z')))
      .toBe('2026-09-19T12:00:00.000Z');
  });

  it('DST 缺失时间取当日首个有效时刻，重复时间只取第一次', () => {
    expect(nextScheduledRunUtc('02:30', 'America/New_York', new Date('2026-03-08T05:00:00Z')))
      .toBe('2026-03-08T07:00:00.000Z');
    expect(nextScheduledRunUtc('01:30', 'America/New_York', new Date('2026-11-01T04:00:00Z')))
      .toBe('2026-11-01T05:30:00.000Z');
  });

  it('同一本地日期即使日程 revision 改变也不重复执行', () => {
    expect(determineEligibleSlot({ ...config, revision: 3, lastSlot: 'daily:2026-09-18:r2' }, new Date('2026-09-18T13:00:00Z'), true))
      .toBeNull();
  });

  it('批次冻结 cutoff，后到资料留在下一批', () => {
    const batch = freezeBatch({
      trigger: 'scheduled',
      slotKey: 'daily:2026-09-18:r2',
      cutoff: new Date('2026-09-18T12:00:00Z'),
      maxFiles: 100,
      sources: [
        { id: 'a', stableAt: '2026-09-18T11:59:00Z', personId: 'p1', consentValid: true },
        { id: 'b', stableAt: '2026-09-18T12:00:01Z', personId: 'p1', consentValid: true },
        { id: 'c', stableAt: '2026-09-18T11:58:00Z', personId: null, consentValid: false }
      ]
    });
    expect(batch.sourceIds).toEqual(['a']);
  });
});

describe('并发、签名与重试', () => {
  it('全局只允许一个 AI 任务，同一 source 不被手动/日程重复领取', () => {
    const leases = new LeaseCoordinator();
    expect(leases.claimAi('job-1')).toBe(true);
    expect(leases.claimAi('job-2')).toBe(false);
    expect(leases.claimSources('job-1', ['source-1'])).toBe(true);
    expect(leases.claimSources('job-2', ['source-1'])).toBe(false);
    leases.releaseAi('job-1');
    leases.releaseSources('job-1');
    expect(leases.claimAi('job-2')).toBe(true);
  });

  it('来源顺序不改变任务签名', () => {
    const base = { stage: 'extract', personId: 'p1', factRevision: 2, contextRevision: 1, promptVersion: 'v1', rulesVersion: 'v1' };
    expect(jobInputSignature({ ...base, sourceRevisionIds: ['b', 'a'] }))
      .toBe(jobInputSignature({ ...base, sourceRevisionIds: ['a', 'b'] }));
  });

  it('登录和额度错误进入等待，不循环重试', () => {
    expect(decideRetry('AUTH_EXPIRED', 0)).toEqual({ action: 'wait_auth', delayMs: null });
    expect(decideRetry('QUOTA_EXHAUSTED', 0)).toEqual({ action: 'wait_quota', delayMs: null });
    expect(decideRetry('NETWORK', 3)).toEqual({ action: 'fail', delayMs: null });
  });
});
