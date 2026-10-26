import { createHash } from 'node:crypto';
import type { ObservationCandidate, SourceManifest } from '@contracts';
import { calendarDateOccurrences, normalizeCalendarDate } from './calendar-date.js';
import { sourceQuoteHasReliableVisualRows } from './report-reconciliation.js';

export * from './member-v2.js';
export * from './member-action-match.js';
export * from './calendar-date.js';
export * from './report-reconciliation.js';
export * from './direct-original-validation.js';

export type AcceptanceOutcome =
  | { decision: 'accept'; warnings: string[] }
  | { decision: 'accept_with_warnings'; warnings: string[] }
  | { decision: 'needs_review'; reasons: string[] }
  | { decision: 'reject'; reasons: string[] };

export function stableHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export function validateCoverage(manifest: SourceManifest): string[] {
  const covered = new Set(manifest.coveredUnitIndexes);
  const problems: string[] = [];

  for (let index = 0; index < manifest.totalUnits; index += 1) {
    if (!covered.has(index)) problems.push(`missing_unit:${index}`);
  }

  if (covered.size !== manifest.coveredUnitIndexes.length) problems.push('duplicate_unit');
  for (const index of covered) {
    if (index < 0 || index >= manifest.totalUnits) problems.push(`invalid_unit:${index}`);
  }
  return problems;
}

function normalizeEvidenceText(value: string): string {
  return value.normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();
}

function evidenceContainsReportedText(evidence: string, reported: string): boolean {
  if (evidence.includes(reported)) return true;
  const compactEvidence = evidence.replace(/\s+/g, '');
  const compactReported = reported.replace(/\s+/g, '');
  return compactReported.length > 0 && compactEvidence.includes(compactReported);
}

function compactTextLayout(value: string): string {
  // 文字层会把表格单元格拆成多行，模型则常以分号连接各行。
  // 仅消去排版分隔符；数字中的小数点、比较符等原样保留。
  return normalizeEvidenceText(value).replace(/[\s,，;；:：。|、]/g, '');
}

function compactTextResult(value: string): string {
  const normalized = value.normalize('NFKC').toLowerCase();
  const numbers = numericOccurrences(normalized);
  let previousEnd = 0;
  const parts: string[] = [];
  for (const number of numbers) {
    parts.push(compactTextLayout(normalized.slice(previousEnd, number.start)));
    // 数值用完整 token 比较；消去排版分隔不能把“91 94”证明为“9194”，
    // 也不能丢小数点、科学计数法的指数或小于/大于符号。
    parts.push(`\u0000${number.comparator}:${number.value}\u0000`);
    previousEnd = number.end;
  }
  parts.push(compactTextLayout(normalized.slice(previousEnd)));
  return parts.join('');
}

interface TextProjectAnchor { value: string; headingOnly: boolean }

function textProjectAnchors(candidate: ObservationCandidate): TextProjectAnchor[] {
  const original = compactTextLayout(candidate.originalName);
  const shorter = original.replace(/(?:小结|检查|报告|结果)$/u, '');
  const anchors: TextProjectAnchor[] = [
    { value: original, headingOnly: false },
    ...(shorter.length >= 2 && shorter !== original ? [{ value: shorter, headingOnly: true }] : [])
  ];
  const parts = candidate.originalName.normalize('NFKC').split(/[—–:：]|\s*-\s*/u).map((part) => compactTextLayout(part));
  // 这些前缀只是应用/模型的显示命名空间，不是新的临床项目。仅允许它们
  // 绑定原文中独立出现的真实字段标题，不让“肝脏—结果”借用别科的“结果”。
  const displayNamespaces = /^(?:内镜检查|影像检查|病理检查|检验报告|检查报告|体检报告|报告|检查)$/u;
  const resultFields = /^(?:检查结论|检查所见|诊断意见|超声提示|检查结果)$/u;
  if (parts.length === 2 && displayNamespaces.test(parts[0]!) && resultFields.test(parts[1]!)) {
    anchors.push({ value: parts[1]!, headingOnly: true });
  }
  return anchors.filter((anchor) => anchor.value.length > 0);
}

function sideInName(name: string): '左' | '右' | null {
  const left = /左/.test(name);
  const right = /右/.test(name);
  return left === right ? null : left ? '左' : '右';
}

function expectedLaterality(candidate: ObservationCandidate): '左' | '右' | 'conflict' | null {
  const original = sideInName(candidate.originalName);
  const standardized = sideInName(candidate.standardNameCandidate ?? '');
  if (original && standardized && original !== standardized) return 'conflict';
  return original ?? standardized;
}

function textProjectWindows(candidate: ObservationCandidate, citedText: string[], allowAcrossReferences: boolean): string[] {
  // 原报告项目名优先于模型给出的标准名。只有从这个项目标题开始，
  // 到下一项同级标题前的文字，才可用于证明该项目的文字结果。
  const anchors = textProjectAnchors(candidate);
  const allSources = allowAcrossReferences ? [citedText.join('\n')] : citedText;
  const windows: string[] = [];

  for (const source of allSources) {
    const normalized = source.normalize('NFKC').toLowerCase();
    const compactCharacters: string[] = [];
    const originalOffsets: number[] = [];
    for (let index = 0; index < normalized.length; index += 1) {
      const character = normalized[index]!;
      // | 是本地几何布局证明的列/项目边界，不能跨它拼出项目标题。
      if (/[\s,，;；:：。、]/u.test(character)) continue;
      compactCharacters.push(character);
      originalOffsets.push(index);
    }
    const compact = compactCharacters.join('');
    const matchingAnchors = anchors.filter((anchor) => compact.includes(anchor.value));
    if (matchingAnchors.length === 0) continue;
    const matchedAnchor = matchingAnchors[0]!;
    let offset = 0;
    while (offset < compact.length) {
      const start = compact.indexOf(matchedAnchor.value, offset);
      if (start < 0) break;
      const anchorStart = originalOffsets[start] ?? 0;
      const afterAnchor = (originalOffsets[start + matchedAnchor.value.length - 1] ?? anchorStart) + 1;
      if (matchedAnchor.headingOnly
        && (!/(?:^|[\r\n;；。])\s*$/u.test(normalized.slice(0, anchorStart))
          || !/^(?:[ \t]*[:：]|[ \t]+\S|[ \t]*\r?\n|[ \t]*$)/u.test(normalized.slice(afterAnchor)))) {
        offset = start + matchedAnchor.value.length;
        continue;
      }
      // 完整结果有时是“未见某项目”“否认某症状”，限定词在项目词
      // 前面。只保留紧邻项目的同句限定词，不跨换行、列或另一项目补文。
      const qualifierPrefix = /(?:(?:不能排除|不排除|未发现|未见|否认|考虑|疑似|可能|倾向|提示|待排|可疑|轻微|轻度|中度|重度|明显|弱|强|无|未|不)[ \t]*)+$/u
        .exec(normalized.slice(0, anchorStart))?.[0] ?? '';
      const originalStart = anchorStart - qualifierPrefix.length;
      const remainder = normalized.slice(afterAnchor);
      const nextHeader = /(?:^|[\r\n;；。])\s*[^\r\n;；:：。]{2,28}?(?:小结|检查|结论|报告|结果|彩超|所见|意见|提示)(?=[:：]|\r?\n|$|[ \t]+\S)/mu.exec(remainder);
      // 有些 PDF 把整页展成一行，真实科室栏目会连续重复两次再跟
      // 检查日期。只识别这个明确结构或独立行标题，不从正文提及科室切段。
      const departments = '心血管内科|神经内科|耳鼻喉科|口腔科|皮肤科|内科|外科|眼科|妇科|男科';
      const nextDepartment = new RegExp(`(?:^|\\s)(${departments})\\s+\\1\\s+(?:检查日期|检查结果|检查所见|小结)|(?:^|[\\r\\n;；。])\\s*(?:${departments})(?=[:：]|\\r?\\n|$)`, 'mu').exec(remainder);
      const columnBoundary = remainder.indexOf('|');
      const endOffset = Math.min(nextHeader?.index ?? remainder.length, nextDepartment?.index ?? remainder.length,
        columnBoundary >= 0 ? columnBoundary : remainder.length);
      const originalEnd = afterAnchor + endOffset;
      windows.push(normalized.slice(originalStart, originalEnd));
      offset = start + matchedAnchor.value.length;
    }
  }
  return [...new Set(windows)];
}

function textResultSupported(candidate: ObservationCandidate, citedText: string[], controlledContext: string[]): boolean {
  if (candidate.value.kind !== 'text' && candidate.value.kind !== 'qualitative') return false;
  const reported = normalizeEvidenceText(candidate.value.rawText);
  if (!reported) return true;

  // 含数字的文字也允许换行/分号等排版等价，但数值 token 和比较符不变；
  // 不把任意不同引用中的数字跨项目拼接。
  const hasNumber = /\d/.test(reported);
  const raw = compactTextResult(reported);
  const side = expectedLaterality(candidate);
  if (side === 'conflict') return false;
  const sources = [...textProjectWindows(candidate, citedText, !hasNumber), ...controlledContext];
  const rawSide = /左/.test(raw) === /右/.test(raw)
    ? null
    : /左/.test(raw) ? '左' : '右';
  const protectedPrefixes = [
    '不能排除', '不排除', '未见', '否认', '考虑', '疑似', '可能', '倾向', '提示',
    '待排', '可疑', '轻微', '轻度', '中度', '重度', '明显', '弱', '强', '无', '未', '不'
  ];

  for (const source of sources) {
    const compact = compactTextResult(source);
    const leadingQualifier = /^(?:(?:不能排除|不排除|未发现|未见|否认|考虑|疑似|可能|倾向|提示|待排|可疑|轻微|轻度|中度|重度|明显|弱|强|无|未|不))+/u.exec(compact)?.[0] ?? '';
    const qualifiedAnchor = leadingQualifier ? textProjectAnchors(candidate)
      .find((anchor) => compact.startsWith(`${leadingQualifier}${anchor.value}`)) : undefined;
    let start = compact.indexOf(raw);
    while (start >= 0) {
      const prefix = compact.slice(0, start);
      const qualifierOmitted = protectedPrefixes.some((word) => prefix.endsWith(word))
        || Boolean(qualifiedAnchor && start < leadingQualifier.length + qualifiedAnchor.value.length
          && !raw.startsWith(leadingQualifier));
      const leftAt = prefix.lastIndexOf('左');
      const rightAt = prefix.lastIndexOf('右');
      const nearestSide = leftAt === rightAt ? null : leftAt > rightAt ? '左' : '右';
      if (!qualifierOmitted && (!side || rawSide === side || (rawSide === null && nearestSide === side))) return true;
      start = compact.indexOf(raw, start + 1);
    }
  }
  return false;
}

function evidenceQuoteMatchesSource(source: string, cited: string): boolean {
  if (source.includes(cited)) return true;
  const compactSource = source.replace(/\s+/g, '');
  const compactCited = cited.replace(/\s+/g, '');
  return compactCited.length > 0 && compactSource.includes(compactCited);
}

function sourceQuoteInterval(source: string, quote: string): { start: number; end: number } | null {
  const normalizedSource = source.normalize('NFKC').toLowerCase();
  const compactCharacters: string[] = [];
  const originalOffsets: number[] = [];
  for (let index = 0; index < normalizedSource.length; index += 1) {
    const character = normalizedSource[index]!;
    if (/\s/u.test(character)) continue;
    compactCharacters.push(character);
    originalOffsets.push(index);
  }
  const compactSource = compactCharacters.join('');
  const compactQuote = quote.normalize('NFKC').toLowerCase().replace(/\s/gu, '');
  if (!compactQuote) return null;
  const start = compactSource.indexOf(compactQuote);
  if (start < 0 || compactSource.indexOf(compactQuote, start + 1) >= 0) return null;
  return { start: originalOffsets[start]!, end: originalOffsets[start + compactQuote.length - 1]! + 1 };
}

function sourceGapHasProjectBoundary(gap: string): boolean {
  return gap.includes('|')
    || /(?:^|[\r\n;；。])\s*[^\r\n;；:：。]{2,28}?(?:小结|检查|结论|报告|结果|彩超|所见|意见|提示)(?=[:：]|\r?\n|$|[ \t]+\S)/mu.test(gap);
}

function normalizedMeasurementNameTokens(candidate: ObservationCandidate): string[] {
  const values = [candidate.originalName, candidate.standardNameCandidate]
    .filter((value): value is string => Boolean(value))
    .map(normalizeEvidenceText);
  const tokens = new Set<string>();
  for (const value of values) {
    const compact = value.replace(/\s+/g, '');
    if (compact.length >= 2) tokens.add(compact);
    for (const token of value.match(/[a-z][a-z0-9]{1,}/g) ?? []) tokens.add(token);
    for (const token of value.match(/[\p{Script=Han}]{2,}/gu) ?? []) tokens.add(token);
  }
  return [...tokens].sort((left, right) => right.length - left.length);
}

function compoundMeasurementNameParts(candidate: ObservationCandidate): Array<{ prefix: string; suffix: string }> {
  const suffixes = ['前后径', '左右径', '上下径', '长径', '短径', '横径', '纵径', '厚径', '直径'];
  const parts = new Map<string, { prefix: string; suffix: string }>();
  for (const value of [candidate.originalName, candidate.standardNameCandidate]) {
    if (!value) continue;
    const compact = normalizeEvidenceText(value).replace(/\s+/g, '');
    const suffix = suffixes.find((candidateSuffix) => compact.endsWith(candidateSuffix));
    if (!suffix) continue;
    const prefix = compact.slice(0, -suffix.length);
    if (prefix.length < 2) continue;
    parts.set(`${prefix}\u0000${suffix}`, { prefix, suffix });
  }
  return [...parts.values()];
}

function measurementAnchorHasMatchingSide(candidate: ObservationCandidate, text: string, anchorEnd: number): boolean {
  const side = expectedLaterality(candidate);
  if (side === 'conflict') return false;
  if (!side) return true;
  // 标准名称可能省略左右侧。该简名只能在实际原文同侧栏目中定位，
  // 不能借另一侧的同名结果；列、句子和换行处结束前一部位上下文。
  const context = text.slice(0, anchorEnd).split(/[\r\n;；|。]/u).at(-1) ?? '';
  const leftAt = context.lastIndexOf('左');
  const rightAt = context.lastIndexOf('右');
  return leftAt !== rightAt && (leftAt > rightAt ? '左' : '右') === side;
}

function measurementEvidenceWindows(candidate: ObservationCandidate, citedText: string): string[] {
  const text = citedText.normalize('NFKC').toLowerCase();
  // PDF 文字层经常会把一个名称拆出空格，因此定位名称时使用无空白副本；
  // 但截取数值窗口时必须回到原文字串，否则“91 94”会被误拼成“9194”。
  const compactCharacters: string[] = [];
  const originalOffsets: number[] = [];
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]!;
    if (/\s/.test(character)) continue;
    compactCharacters.push(character);
    originalOffsets.push(index);
  }
  const compact = compactCharacters.join('');
  const tokens = normalizedMeasurementNameTokens(candidate);
  const windows: string[] = [];
  for (const token of tokens) {
    const normalizedToken = token.replace(/\s+/g, '');
    let offset = 0;
    while (offset < compact.length) {
      const index = compact.indexOf(normalizedToken, offset);
      if (index < 0) break;
      const valueStart = index + normalizedToken.length;
      const originalStart = valueStart > 0 ? (originalOffsets[valueStart - 1] ?? text.length - 1) + 1 : 0;
      if (!measurementAnchorHasMatchingSide(candidate, text, originalStart)) {
        offset = index + Math.max(normalizedToken.length, 1);
        continue;
      }
      const remainder = text.slice(originalStart);
      const delimiterIndex = remainder.search(/[\n\r;；|]/);
      const end = delimiterIndex >= 0 ? originalStart + delimiterIndex : Math.min(text.length, originalStart + 160);
      windows.push(text.slice(originalStart, end));
      offset = index + Math.max(normalizedToken.length, 1);
    }
  }

  // 超声等报告常把同一部位的共同前缀只写一次，例如：
  // “甲状腺左侧叶前后径 15.7mm，左右径 14.8mm”。模型把第二项规范为
  // “甲状腺左侧叶左右径”是合理的，但原文不会连续出现这个完整名称。
  // 只在共同部位前缀之后很短的范围内寻找目标尺寸后缀，以免把左/右侧数值串错。
  for (const { prefix, suffix } of compoundMeasurementNameParts(candidate)) {
    let prefixOffset = 0;
    while (prefixOffset < compact.length) {
      const prefixIndex = compact.indexOf(prefix, prefixOffset);
      if (prefixIndex < 0) break;
      const prefixEnd = prefixIndex + prefix.length;
      const suffixIndex = compact.indexOf(suffix, prefixEnd);
      const originalPrefixEnd = (originalOffsets[prefixEnd - 1] ?? text.length - 1) + 1;
      const originalSuffixStart = suffixIndex >= 0 ? (originalOffsets[suffixIndex] ?? text.length) : text.length;
      // 共用前缀只能属于同一列/项目；几何已确认的 | 边界不能被
      // 省略名称的补全逻辑绕过。逗号相邻尺寸仍保留既有同部位支持。
      const crossesColumnBoundary = text.slice(originalPrefixEnd, originalSuffixStart).includes('|');
      if (suffixIndex >= 0 && suffixIndex - prefixEnd <= 80 && !crossesColumnBoundary) {
        const valueStart = suffixIndex + suffix.length;
        const originalStart = valueStart > 0 ? (originalOffsets[valueStart - 1] ?? text.length - 1) + 1 : 0;
        if (!measurementAnchorHasMatchingSide(candidate, text, originalStart)) {
          prefixOffset = prefixIndex + Math.max(prefix.length, 1);
          continue;
        }
        const remainder = text.slice(originalStart);
        const delimiterIndex = remainder.search(/[\n\r;；|]/);
        const end = delimiterIndex >= 0 ? originalStart + delimiterIndex : Math.min(text.length, originalStart + 160);
        windows.push(text.slice(originalStart, end));
      }
      prefixOffset = prefixIndex + Math.max(prefix.length, 1);
    }
  }
  return [...new Set(windows)];
}

function normalizedUnit(value: string): string {
  const normalized = value.normalize('NFKC').toLowerCase()
    .replace(/[µμ]/g, 'u')
    .replace(/[×*]/g, 'x')
    .replace(/\s+/g, '');
  const aliases: Record<string, string> = {
    '次/分': 'bpm', '次分': 'bpm', 公斤: 'kg', 千克: 'kg', 厘米: 'cm', 毫米: 'mm'
  };
  return aliases[normalized] ?? normalized;
}

function normalizedUnitEvidenceText(text: string): string {
  return text.normalize('NFKC').toLowerCase()
    .replace(/[µμ]/g, 'u').replace(/[×*]/g, 'x').replace(/[ \t]*\/[ \t]*/g, '/');
}

function unitsImmediatelyFollowingResult(text: string): string[] {
  const normalized = normalizedUnitEvidenceText(text);
  // 只有结果之后紧邻的完整文字 token 才可作为未收录单位；不会从
  // 后面另一项目名或解释句中的某个子串补单位。
  const literal = /^[ \t:：（(↑↓▲▼]*(?:-{2,}|—)?[ \t↑↓▲▼]*(x10\^?-?\d+\/?l|10\^?-?\d+\/?l|[a-z][a-z0-9._]*(?:\/[a-z][a-z0-9._]*)*|%|次\/?分|厘米|毫米|千克|公斤)(?=$|[\d \t,，;；()（）<>≤≥↑↓])/u.exec(normalized)?.[1];
  return literal ? [normalizedUnit(literal)] : [];
}

function unitsImmediatelyPrecedingResult(text: string): string[] {
  const normalized = normalizedUnitEvidenceText(text);
  // 前置单位须占据项目标题与结果之间的独立字段，不能从另一项目、
  // 参考范围或解释文字中搜一个相同单位来补齐。
  const literal = /^[ \t:：（(]*(x10\^?-?\d+\/?l|10\^?-?\d+\/?l|[a-z][a-z0-9._]*(?:\/[a-z][a-z0-9._]*)*|%|次\/?分|厘米|毫米|千克|公斤)[ \t:：)）]*$/u.exec(normalized)?.[1];
  return literal ? [normalizedUnit(literal)] : [];
}

function sharedUnitFollowingNumericCells(text: string): string[] {
  let remainder = text;
  let siblingCells = 0;
  while (remainder) {
    const units = unitsImmediatelyFollowingResult(remainder);
    // 先读完整单位，不能把 x10^9/L 的 9 当成另一个数值单元格。
    if (units.length > 0) return siblingCells > 0 ? units : [];
    const number = numericOccurrences(remainder)[0];
    if (!number) return [];
    // 对比表同一项目可共用末列单位，但中间只能是真实数值单元格及
    // 排版标记。遇到下一项目名、参考栏目或说明文字立即停止共享。
    if (!/^[ \t:：↑↓▲▼-]*$/u.test(remainder.slice(0, number.start))) return [];
    remainder = remainder.slice(number.end);
    siblingCells += 1;
  }
  return [];
}

type EvidenceComparator = 'eq' | 'lt' | 'lte' | 'gt' | 'gte';

function primaryMeasurementClause(text: string): string {
  // 一个引用片段可能同时包含多个指标。逗号之后若开始下一个项目，
  // 不能把后一项的数值或定性结果借给当前项。参考范围也不是检验结果。
  const firstClause = text.split(/[,\uff0c]/, 1)[0] ?? text;
  const referenceMarker = firstClause.search(/(?:\u53c2\u8003(?:\u8303\u56f4|\u503c|\u533a\u95f4)?|\u6b63\u5e38\u8303\u56f4|\u8303\u56f4)\s*[:\uff1a]?/i);
  return referenceMarker >= 0 ? firstClause.slice(0, referenceMarker) : firstClause;
}

function canonicalNumericToken(raw: string): string | null {
  const match = /^([+-]?)(\d+(?:\.\d+)?|\.\d+)(?:e([+-]?\d+))?$/i.exec(raw.replace(/\s+/g, ''));
  if (!match) return null;
  const [integer = '', fraction = ''] = match[2]!.split('.');
  const scientificExponent = Number(match[3] ?? '0');
  if (!Number.isSafeInteger(scientificExponent)) return null;
  const digits = `${integer}${fraction}`.replace(/^0+/, '');
  if (!digits) return '0';
  const significant = digits.replace(/0+$/, '');
  const exponent = scientificExponent - fraction.length + digits.length - significant.length;
  if (!Number.isSafeInteger(exponent)) return null;
  // 按十进制有效数字比较，不让浮点舍入或极小指数下溢把非零结果证明为 0。
  return `${match[1] === '-' ? '-' : ''}${significant}e${exponent}`;
}

function numericOccurrences(text: string): Array<{ value: string; comparator: EvidenceComparator; start: number; end: number }> {
  const occurrences: Array<{ value: string; comparator: EvidenceComparator; start: number; end: number }> = [];
  // 科学计数法必须作为完整结果读取，不能把 2.00E+02 拆成 2 和 02。
  // 指数中的排版空白可以折叠，普通相邻数值之间的空白不能折叠。
  const pattern = /(<=|>=|\u2264|\u2265|<|>|\u5c0f\u4e8e|\u5927\u4e8e|\u4e0d\u9ad8\u4e8e|\u4e0d\u4f4e\u4e8e)?\s*([+-]?(?:\d+(?:\.\d+)?|\.\d+)(?:\s*e\s*[+-]?\s*\d+)?)/gi;
  for (const match of text.matchAll(pattern)) {
    if (match.index === undefined) continue;
    const numberIndex = match.index + match[0].lastIndexOf(match[2]!);
    const preceding = text.slice(0, numberIndex);
    const following = text.slice(match.index + match[0].length);
    // 拒绝编号/残缺指数/残缺小数中的碎片；不要从不完整 token 中取一个看似合法的数字。
    if (/[a-z0-9_.]$/i.test(preceding) || /[\d.e]/i.test(following[0] ?? '')
      || /[\d.]\s*e\s*[+-]?\s*$/i.test(preceding)) continue;
    const token = (match[1] ?? '').toLowerCase();
    const comparator: EvidenceComparator = token === '<' || token === '\u5c0f\u4e8e'
      ? 'lt'
      : token === '<=' || token === '\u2264' || token === '\u4e0d\u9ad8\u4e8e'
        ? 'lte'
        : token === '>' || token === '\u5927\u4e8e'
          ? 'gt'
          : token === '>=' || token === '\u2265' || token === '\u4e0d\u4f4e\u4e8e'
            ? 'gte'
            : 'eq';
    const value = canonicalNumericToken(match[2]!);
    if (value === null) continue;
    occurrences.push({ value, comparator, start: match.index, end: match.index + match[0].length });
  }
  return occurrences;
}

function controlledUnitFollowingQuote(candidate: ObservationCandidate, sourceText: string, quote: string): string[] {
  if (candidate.value.kind !== 'numeric') return [];
  const normalizedQuote = quote.normalize('NFKC').toLowerCase();
  const numbers = numericOccurrences(normalizedQuote);
  const last = numbers.at(-1);
  if (!last || last.value !== canonicalNumericToken(candidate.value.decimal)
    || last.comparator !== candidate.value.comparator
    || !/^[\s↑↓]*$/u.test(normalizedQuote.slice(last.end))) return [];
  // 引用必须已证明当前项目的结果，而非只有一个相同数字。
  if (!measurementEvidenceWindows(candidate, quote).some((window) => numericOccurrences(primaryMeasurementClause(window))
    .some((number) => number.value === last.value && number.comparator === last.comparator))) return [];
  const normalizedSource = sourceText.normalize('NFKC').toLowerCase();
  const compactCharacters: string[] = [];
  const originalOffsets: number[] = [];
  for (let index = 0; index < normalizedSource.length; index += 1) {
    const character = normalizedSource[index]!;
    if (/\s/u.test(character)) continue;
    compactCharacters.push(character);
    originalOffsets.push(index);
  }
  const compactSource = compactCharacters.join('');
  const compactQuote = normalizedQuote.replace(/\s/gu, '');
  if (!compactQuote) return [];
  const foundUnits: string[] = [];
  let offset = 0;
  while (offset < compactSource.length) {
    const start = compactSource.indexOf(compactQuote, offset);
    if (start < 0) break;
    const end = (originalOffsets[start + compactQuote.length - 1] ?? normalizedSource.length - 1) + 1;
    const suffix = normalizedSource.slice(end).split(/[\r\n;；|,，]/u, 1)[0] ?? '';
    const localUnits = unitsImmediatelyFollowingResult(suffix);
    // 相同摘录在来源中有多个位置时，所有位置都须有唯一一致单位；
    // 不选择某个碰巧符合候选的单位以掩盖真实来源歧义。
    if (localUnits.length !== 1) return [];
    foundUnits.push(localUnits[0]!);
    offset = start + compactQuote.length;
  }
  return new Set(foundUnits).size === 1 ? [foundUnits[0]!] : [];
}

function evidenceContentProblems(candidate: ObservationCandidate, manifest: SourceManifest): string[] {
  const spans = new Map(manifest.spans.map((span) => [span.id, span]));
  const spanOrder = new Map(manifest.spans.map((span, index) => [span.id, index]));
  const problems: string[] = [];
  const supportedText: string[] = [];
  const bindingText: string[] = [];
  const orderedBindingText: Array<{ text: string; sourceText: string; sourceSpanId: string }> = [];
  for (const reference of candidate.evidence) {
    const span = spans.get(reference.sourceSpanId);
    if (!span) continue;
    if (span.quote && (span.readability === 'clear' || sourceQuoteHasReliableVisualRows(span, reference.quote))) {
      if (!reference.quote) {
        problems.push(`evidence_quote_required:${reference.sourceSpanId}`);
        continue;
      }
      const source = normalizeEvidenceText(span.quote);
      const cited = normalizeEvidenceText(reference.quote);
      if (!cited || !evidenceQuoteMatchesSource(source, cited)) {
        problems.push(`evidence_quote_mismatch:${reference.sourceSpanId}`);
        continue;
      }
      supportedText.push(cited);
      bindingText.push(reference.quote);
      orderedBindingText.push({ text: reference.quote, sourceText: span.quote, sourceSpanId: reference.sourceSpanId });
    }
  }
  if (supportedText.length === 0 && problems.length === 0) {
    // 模型对图片的自报引用不是独立证据。没有可靠文字层/本机 OCR 支持时，
    // 不能跳过日期、数值和文字结果校验后把视觉候选直接写入正式事实。
    const hasVisualSource = candidate.evidence.some((reference) => {
      const span = spans.get(reference.sourceSpanId);
      return span?.spanKind === 'image' || span?.spanKind === 'page';
    });
    problems.push(hasVisualSource ? 'image_evidence_unverified' : 'source_evidence_unverified');
  }
  if (candidate.value.kind === 'numeric' && supportedText.length > 0) {
    const expected = canonicalNumericToken(candidate.value.decimal);
    const expectedComparator = candidate.value.comparator;
    const measurementWindows = bindingText
      .flatMap((text) => measurementEvidenceWindows(candidate, text))
      .map(primaryMeasurementClause)
      .filter(Boolean);
    if (measurementWindows.length === 0) problems.push('measurement_name_not_in_evidence');
    const matchingOccurrences = measurementWindows.flatMap((text) => (
      numericOccurrences(text)
        .filter((occurrence) => occurrence.value === expected)
        .map((occurrence) => ({ text, occurrence }))
    ));
    if (matchingOccurrences.length === 0) {
      problems.push('numeric_value_not_in_evidence');
    }
    if (matchingOccurrences.length > 0
      && !matchingOccurrences.some(({ occurrence }) => occurrence.comparator === expectedComparator)) {
      problems.push('numeric_comparator_not_in_evidence');
    }
    if (candidate.unitRaw) {
      const expectedUnit = normalizedUnit(candidate.unitRaw);
      const unitBound = matchingOccurrences.some(({ text, occurrence }) => {
        const following = text.slice(occurrence.end);
        const localUnits = unitsImmediatelyFollowingResult(following);
        if (localUnits.length > 0) return localUnits.includes(expectedUnit);
        const sharedUnits = sharedUnitFollowingNumericCells(following);
        if (sharedUnits.length > 0) return sharedUnits.includes(expectedUnit);
        const precedingUnits = unitsImmediatelyPrecedingResult(text.slice(0, occurrence.start));
        if (precedingUnits.length > 0) return precedingUnits.includes(expectedUnit);
        return orderedBindingText.some((entry) => (
          controlledUnitFollowingQuote(candidate, entry.sourceText, entry.text).includes(expectedUnit)
        ));
      });
      if (matchingOccurrences.length > 0 && !unitBound) {
        problems.push('unit_not_bound_to_measurement');
      }
    }
  }
  if (candidate.value.kind === 'qualitative' && supportedText.length > 0) {
    const raw = normalizeEvidenceText(candidate.value.rawText);
    const category = candidate.value.category ? normalizeEvidenceText(candidate.value.category) : '';
    const measurementWindows = bindingText.flatMap((text) => measurementEvidenceWindows(candidate, text))
      .map(primaryMeasurementClause)
      .map(normalizeEvidenceText);
    // 纯结果摘录也必须在同一来源的当前项目窗口里；不能因项目名缺失
    // 就退回整页搜索，把参考列或相邻项目的阴阳性借过来。
    const controlledWindows = orderedBindingText.flatMap((entry) => (
      measurementEvidenceWindows(candidate, entry.sourceText).map(primaryMeasurementClause)
        .filter((window) => evidenceQuoteMatchesSource(normalizeEvidenceText(window), normalizeEvidenceText(entry.text)))
        .map(normalizeEvidenceText)
    ));
    // “内科小结”等显示名可绑定真实独立栏目，但引用本身仍须包含
    // 结果文字；只在该栏目有界范围内证明，不恢复整页搜索兜底。
    const controlledHeadingWindows = orderedBindingText.flatMap((entry) => {
      const cited = normalizeEvidenceText(entry.text);
      if (!(raw && evidenceContainsReportedText(cited, raw))
        && !(category && evidenceContainsReportedText(cited, category))) return [];
      const original = candidate.originalName.normalize('NFKC').trim().toLowerCase();
      const compoundDepartment = /^(?:心血管内科|神经内科|耳鼻喉科|口腔科|皮肤科|内科|外科|眼科|妇科|男科)(?:小结|检查)$/u.test(original);
      const displayNamespace = /^(?:内镜检查|影像检查|病理检查|检验报告|检查报告|体检报告|报告|检查)\s*[—–:：-]\s*(?:检查结论|检查所见|诊断意见|超声提示|检查结果)$/u.test(original);
      const headingSuffix = /(?:小结|检查|结论|报告|结果|彩超|所见|意见|提示)$/u.test(original);
      const escapedOriginal = original.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s*');
      const fullLineHeading = new RegExp(`^${escapedOriginal}[ \\t]*(?:[:：]|\\r?\\n)`, 'u');
      return textProjectWindows(candidate, [entry.sourceText], false)
        // 临床指标单元格继续使用逐行 measurement 窗口；不能把普通
        // “抗原 阴性；抗体 阳性”扩成整段文字而借用后项的阳性。
        .filter((window) => compoundDepartment || displayNamespace || (headingSuffix && fullLineHeading.test(window)))
        .filter((window) => evidenceQuoteMatchesSource(normalizeEvidenceText(window), cited)
          || evidenceQuoteMatchesSource(cited, normalizeEvidenceText(window)))
        .map(normalizeEvidenceText);
    });
    const qualifiedProjectWindows = orderedBindingText.flatMap((entry) => (
      textProjectWindows(candidate, [entry.sourceText], false)
        .filter((window) => /^(?:不能排除|不排除|未发现|未见|否认|考虑|疑似|可能|倾向|提示|待排|可疑|轻微|轻度|中度|重度|明显|弱|强|无|未|不)/u.test(window))
        .filter((window) => evidenceQuoteMatchesSource(normalizeEvidenceText(window), normalizeEvidenceText(entry.text)))
    ));
    const valueWindows = [...measurementWindows, ...controlledWindows, ...controlledHeadingWindows];
    if ((raw || category) && !valueWindows.some((text) => (
      (raw && evidenceContainsReportedText(text, raw))
      || (category && evidenceContainsReportedText(text, category))
    )) && !textResultSupported(candidate, [], qualifiedProjectWindows)) {
      problems.push('reported_value_not_in_evidence');
    }
  }
  if (candidate.value.kind === 'text' && supportedText.length > 0) {
    const raw = normalizeEvidenceText(candidate.value.rawText);
    // 日期等辅助引用可能追加在结果引用之后；按报告原始顺序拼接才能判断跨页小结属于哪一节。
    const orderedEntries = [...orderedBindingText].sort((left, right) => (
      (spanOrder.get(left.sourceSpanId) ?? Infinity) - (spanOrder.get(right.sourceSpanId) ?? Infinity)
      || (sourceQuoteInterval(left.sourceText, left.text)?.start ?? Infinity) - (sourceQuoteInterval(right.sourceText, right.text)?.start ?? Infinity)
    ));
    const reportOrderedQuotes = orderedEntries.map((entry, index) => {
      const previous = orderedEntries[index - 1];
      if (!previous) return entry.text;
      const interval = sourceQuoteInterval(entry.sourceText, entry.text);
      const previousInterval = sourceQuoteInterval(previous.sourceText, previous.text);
      // 分别引用两列时，不能在拼接摘录的过程中删掉来源原有的列/标题
      // 边界。这里只保留边界，不把未被引用的中间正文变成新的证据。
      if (!interval || !previousInterval) return `|\n${entry.text}`;
      const gap = entry.sourceSpanId === previous.sourceSpanId
        ? entry.sourceText.normalize('NFKC').toLowerCase().slice(previousInterval.end, interval.start)
        : `${previous.sourceText.normalize('NFKC').toLowerCase().slice(previousInterval.end)}\n${entry.sourceText.normalize('NFKC').toLowerCase().slice(0, interval.start)}`;
      return sourceGapHasProjectBoundary(gap) ? `|\n${entry.text}` : entry.text;
    });
    // 模型可以只引用结果正文，项目标题可能在同一受控来源的上一行。
    // 仅在正文已被该引用证明，且引用确实位于真实项目的有界窗口中时补
    // 标题上下文；日期引用不能借用别处结果，也不修改/补造来源原文。
    const controlledContext = orderedBindingText.flatMap((entry) => {
      if (!compactTextResult(entry.text).includes(compactTextResult(raw))) return [];
      return textProjectWindows(candidate, [entry.sourceText], false)
        .filter((window) => evidenceQuoteMatchesSource(normalizeEvidenceText(window), normalizeEvidenceText(entry.text)));
    });
    if (raw && !textResultSupported(candidate, reportOrderedQuotes, controlledContext)) {
      problems.push('reported_value_not_in_evidence');
    }
  }
  if (candidate.clinicalDate && supportedText.length > 0) {
    const expectedDate = normalizeCalendarDate(candidate.clinicalDate);
    if (!expectedDate || !supportedText.some((text) => (
      calendarDateOccurrences(text).some((occurrence) => occurrence.date === expectedDate)
    ))) {
      problems.push('clinical_date_not_in_evidence');
    }
  }
  return [...new Set(problems)];
}

export function evaluateObservationCandidate(
  candidate: ObservationCandidate,
  manifest: SourceManifest,
  options: { personConsistent: boolean; overwritesUserLockedValue: boolean }
): AcceptanceOutcome {
  if (!options.personConsistent) {
    return { decision: 'needs_review', reasons: ['person_conflict'] };
  }
  if (options.overwritesUserLockedValue) {
    return { decision: 'needs_review', reasons: ['overwrite_protected'] };
  }
  if (expectedLaterality(candidate) === 'conflict') {
    return { decision: 'reject', reasons: ['laterality_name_conflict'] };
  }

  const knownSpans = new Set(manifest.spans.map((span) => span.id));
  const invalidEvidence = candidate.evidence.filter((ref) => !knownSpans.has(ref.sourceSpanId));
  if (invalidEvidence.length > 0) {
    return { decision: 'reject', reasons: ['evidence_mismatch'] };
  }

  // 未知值是覆盖缺口，不是已知的个人健康事实；不能写成空值观测后交给综合分析。
  if (candidate.value.kind === 'unknown') {
    return { decision: 'reject', reasons: ['value_unknown'] };
  }

  const contentProblems = evidenceContentProblems(candidate, manifest);
  if (contentProblems.length > 0) {
    return { decision: 'reject', reasons: contentProblems };
  }

  const coverageProblems = validateCoverage(manifest);
  if (coverageProblems.length > 0) {
    return { decision: 'needs_review', reasons: coverageProblems };
  }

  const blockingIssue = candidate.issues.find((issue) => issue.code.startsWith('blocking_'));
  if (blockingIssue) {
    return { decision: 'needs_review', reasons: [blockingIssue.code] };
  }

  const warnings: string[] = [];
  if (candidate.referenceRangeRaw === null) warnings.push('reference_range_not_provided');
  if (candidate.unitRaw === null && candidate.value.kind === 'numeric') warnings.push('unit_not_provided');

  return warnings.length === 0
    ? { decision: 'accept', warnings }
    : { decision: 'accept_with_warnings', warnings };
}

export type JobStatus =
  | 'queued'
  | 'running'
  | 'waiting_auth'
  | 'waiting_quota'
  | 'waiting_user'
  | 'retry_wait'
  | 'succeeded'
  | 'failed'
  | 'cancelled';

const transitions: Record<JobStatus, readonly JobStatus[]> = {
  queued: ['running', 'waiting_auth', 'waiting_quota', 'waiting_user', 'cancelled'],
  running: ['retry_wait', 'succeeded', 'failed', 'cancelled', 'waiting_auth', 'waiting_quota', 'waiting_user'],
  waiting_auth: ['queued', 'cancelled'],
  waiting_quota: ['queued', 'cancelled'],
  waiting_user: ['queued', 'cancelled'],
  retry_wait: ['queued', 'failed', 'cancelled'],
  succeeded: [],
  failed: ['queued'],
  cancelled: []
};

export function canTransitionJob(from: JobStatus, to: JobStatus): boolean {
  return transitions[from].includes(to);
}

export function assertJobTransition(from: JobStatus, to: JobStatus): void {
  if (!canTransitionJob(from, to)) {
    throw new Error(`非法任务状态迁移：${from} → ${to}`);
  }
}

export type ChangeKind = 'display' | 'clinical_context' | 'new_report' | 'fact_revision' | 'model_update';

export function determineInvalidation(change: ChangeKind): {
  facts: boolean;
  trends: boolean;
  derived: boolean;
} {
  switch (change) {
    case 'display':
      return { facts: false, trends: false, derived: false };
    case 'clinical_context':
      return { facts: false, trends: false, derived: true };
    case 'new_report':
      return { facts: false, trends: true, derived: true };
    case 'fact_revision':
      return { facts: false, trends: true, derived: true };
    case 'model_update':
      return { facts: false, trends: false, derived: false };
  }
}
