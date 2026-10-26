export type CalendarDateOccurrence = { date: string; index: number; length: number };

function isoCalendarDate(year: number, month: number, day: number): string | null {
  // 不让 Date 自动把 2 月 30 日等无效日期滚到下个月。
  if (year < 1000 || year > 9999 || month < 1 || month > 12 || day < 1 || day > 31) return null;
  const value = new Date(Date.UTC(year, month - 1, day));
  if (value.getUTCFullYear() !== year || value.getUTCMonth() !== month - 1 || value.getUTCDate() !== day) return null;
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

export function calendarDateOccurrences(source: string): CalendarDateOccurrence[] {
  // 只统一日期的写法，不推断它是检查日、签发日还是历史日期。
  // 保留原文偏移，供上游按栏目/日期角色绑定，不能因全角归一化破坏证据定位。
  const offsets: number[] = [];
  let normalized = '';
  let originalOffset = 0;
  for (const character of source) {
    const normalizedCharacter = character.normalize('NFKC');
    for (let index = 0; index < normalizedCharacter.length; index += 1) offsets.push(originalOffset);
    normalized += normalizedCharacter;
    originalOffset += character.length;
  }
  offsets.push(source.length);

  const pattern = /(?<!\d)(\d{4})(?:\s*([-/.])\s*(\d{1,2})\s*\2\s*(\d{1,2})|\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日)(?!\d)/g;
  const matches: CalendarDateOccurrence[] = [];
  for (const match of normalized.matchAll(pattern)) {
    const date = isoCalendarDate(Number(match[1]), Number(match[3] ?? match[5]), Number(match[4] ?? match[6]));
    if (!date || match.index === undefined) continue;
    const index = offsets[match.index]!;
    const end = offsets[match.index + match[0].length]!;
    matches.push({ date, index, length: end - index });
  }
  // 年份在末尾的写法只接受可唯一确定的月日顺序。双字段均不超过
  // 12 时，必须在同一日期栏目明确标出格式，不能按地区或模型猜测。
  const yearLastPattern = /(?<!\d)(\d{1,2})\s*([-/.])\s*(\d{1,2})\s*\2\s*(\d{4})(?!\d)/g;
  for (const match of normalized.matchAll(yearLastPattern)) {
    if (match.index === undefined) continue;
    const first = Number(match[1]);
    const second = Number(match[3]);
    const year = Number(match[4]);
    const prefix = normalized.slice(Math.max(0, match.index - 96), match.index).split(/[\r\n;；|]/u).at(-1) ?? '';
    const mdyHint = /(?:日期格式\s*[：:]?\s*(?:mdy|mm\s*[/.-]\s*dd\s*[/.-]\s*yyyy)|[（(]\s*mm\s*[/.-]\s*dd\s*[/.-]\s*yyyy\s*[）)])[\p{Script=Han} \t:：()（）-]*$/iu.test(prefix);
    const dmyHint = /(?:日期格式\s*[：:]?\s*(?:dmy|dd\s*[/.-]\s*mm\s*[/.-]\s*yyyy)|[（(]\s*dd\s*[/.-]\s*mm\s*[/.-]\s*yyyy\s*[）)])[\p{Script=Han} \t:：()（）-]*$/iu.test(prefix);
    const dates = [
      ...(!dmyHint && (mdyHint || second > 12 || first === second) ? [isoCalendarDate(year, first, second)] : []),
      ...(!mdyHint && (dmyHint || first > 12 || first === second) ? [isoCalendarDate(year, second, first)] : [])
    ].filter((date): date is string => date !== null);
    const uniqueDates = [...new Set(dates)];
    if (uniqueDates.length !== 1 || (mdyHint && dmyHint)) continue;
    const index = offsets[match.index]!;
    const end = offsets[match.index + match[0].length]!;
    matches.push({ date: uniqueDates[0]!, index, length: end - index });
  }
  // 部分医院把检查时间写为 yyyyMMddHHmmss。只在明确的日期/时间栏目后
  // 解析这类连续数字；报告编号、条码和无标签的长数字不能成为日期依据。
  const compactTimestamp = /(?:检查|检验|采样|采集|采血|体检|复查|就诊|临床|报告|签发|出具|打印|审核|出生|生日)(?:日期|时间)\s*[：:]?\s*(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(?!\d)/g;
  for (const match of normalized.matchAll(compactTimestamp)) {
    const date = isoCalendarDate(Number(match[1]), Number(match[2]), Number(match[3]));
    if (!date || match.index === undefined
      || Number(match[4]) > 23 || Number(match[5]) > 59 || Number(match[6]) > 59) continue;
    const timestampIndex = match.index + match[0].length - 14;
    const index = offsets[timestampIndex]!;
    const end = offsets[timestampIndex + 14]!;
    matches.push({ date, index, length: end - index });
  }
  return matches.sort((left, right) => left.index - right.index);
}

export function normalizeCalendarDate(value: string): string | null {
  const trimmed = value.trim();
  const matches = calendarDateOccurrences(trimmed);
  const match = matches[0];
  return matches.length === 1 && match?.index === 0 && match.length === trimmed.length ? match.date : null;
}
