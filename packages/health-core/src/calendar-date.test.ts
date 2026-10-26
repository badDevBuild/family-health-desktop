import { describe, expect, it } from 'vitest';
import { calendarDateOccurrences, normalizeCalendarDate } from './calendar-date.js';

describe('有依据的日历日期格式归一化', () => {
  it.each(['2026/1/10', '2026.1.10', '2026-1-10', '2026年1月10日', '２０２６／１／１０'])('统一 %s 而不改变实际日期', (value) => {
    expect(normalizeCalendarDate(value)).toBe('2026-01-10');
  });

  it.each(['2026-02-29', '2026/2/30', '2026.13.1', '2026-0-10', '2026-1-0', '2026-001-10', '2026-1/10', '2026-1-100'])('拒绝无效或不完整日期 %s', (value) => {
    expect(normalizeCalendarDate(value)).toBeNull();
  });

  it('认可闰年但不把签发和历史日期合并成检查日期', () => {
    expect(normalizeCalendarDate('2024/2/29')).toBe('2024-02-29');
    const quote = '采样日期2026/1/10；报告日期2026.1.12；历史检查2024年2月29日';
    expect(calendarDateOccurrences(quote).map((value) => value.date)).toEqual(['2026-01-10', '2026-01-12', '2024-02-29']);
    expect(normalizeCalendarDate(quote)).toBeNull();
  });

  it('归一化不会改变原文字段的证据偏移', () => {
    const quote = 'ﬀ 检查日期：２０２６／１／１０；签发日期2026-1-12';
    const dates = calendarDateOccurrences(quote);
    expect(dates.map((date) => quote.slice(date.index, date.index + date.length)))
      .toEqual(['２０２６／１／１０', '2026-1-12']);
  });

  it('明示检查时间的连续十四位数字提供日期依据，但不改变时间角色', () => {
    const quote = '检查时间\n20240229104838；报告时间：20240301105249；报告编号20240229104838';
    const dates = calendarDateOccurrences(quote);
    expect(dates.map((date) => date.date)).toEqual(['2024-02-29', '2024-03-01']);
    expect(dates.map((date) => quote.slice(date.index, date.index + date.length)))
      .toEqual(['20240229104838', '20240301105249']);
  });

  it.each([
    '20240229104838', '报告编号：20240229104838', '条码 20240229104838',
    '检查时间20230229104838', '采样时间20240230235959',
    '检查时间20240229244838', '检查时间20240229106038', '检查时间20240229104860',
    '检查时间202402291048380', '检查时间2024022910483'
  ])('不把无标签编号或无效时间作为日期：%s', (quote) => {
    expect(calendarDateOccurrences(quote)).toEqual([]);
    expect(normalizeCalendarDate(quote)).toBeNull();
  });

  it('全角时间保持原文偏移，签发与采样时间按原始顺序返回', () => {
    const quote = 'ﬀ 签发时间：２０２４０３０１００００００；采样时间20240229235959';
    const dates = calendarDateOccurrences(quote);
    expect(dates.map((date) => date.date)).toEqual(['2024-03-01', '2024-02-29']);
    expect(dates.map((date) => quote.slice(date.index, date.index + date.length)))
      .toEqual(['２０２４０３０１００００００', '20240229235959']);
  });

  it.each([
    ['3/24/2026', '2026-03-24'], ['24/3/2026', '2026-03-24'],
    ['4.30.2026', '2026-04-30'], ['30-4-2026', '2026-04-30'],
    ['１０／１０／２０２６', '2026-10-10']
  ])('年份在末尾且月日可确定时归一化：%s', (value, expected) => {
    expect(normalizeCalendarDate(value)).toBe(expected);
  });

  it.each(['3/4/2026', '12/11/2026', '2/29/2026', '13/14/2026', '24/3-2026'])('不猜歧义或无效的年末日期：%s', (value) => {
    expect(normalizeCalendarDate(value)).toBeNull();
  });

  it('仅当前日期栏目的明确格式提示可消除歧义，仍返回原文偏移', () => {
    const source = '检查日期(MM/DD/YYYY)：３／４／２０２６；签发日期(DD/MM/YYYY)：3/4/2026';
    const dates = calendarDateOccurrences(source);
    expect(dates.map((date) => date.date)).toEqual(['2026-03-04', '2026-04-03']);
    expect(dates.map((date) => source.slice(date.index, date.index + date.length))).toEqual(['３／４／２０２６', '3/4/2026']);
    expect(calendarDateOccurrences('日期格式：MDY 检查日期：3/4/2026').map((date) => date.date)).toEqual(['2026-03-04']);
    expect(calendarDateOccurrences('日期格式：DMY 检查日期：3/4/2026').map((date) => date.date)).toEqual(['2026-04-03']);
    expect(calendarDateOccurrences('检查日期(MM/DD/YYYY)：3/4/2026；签发日期：5/6/2026').map((date) => date.date)).toEqual(['2026-03-04']);
    expect(calendarDateOccurrences('MM/DD/YYYY 另一项 3/4/2026')).toEqual([]);
    expect(calendarDateOccurrences('检查日期(MM/DD/YYYY)：24/3/2026')).toEqual([]);
  });
});
