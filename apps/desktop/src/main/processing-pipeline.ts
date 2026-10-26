import { createHash } from 'node:crypto';
import { chmodSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { normalizeStoredSource, rereadStoredSourceRegion } from './source-normalization.js';
import {
  extractionResultSchema,
  extractionRepairSchema,
  assembleExtractionRepair,
  type ExtractionResult,
  type ExtractionRepairScope,
  type ExtractionRepairTarget,
  type ObservationCandidate,
  type ReportMetadataCandidate,
  type ReviewCandidateDiff,
  type SourceManifest,
  type SourceSpan
} from '@contracts';
import { calendarDateOccurrences, evaluateObservationCandidate, resolveReportSourceBinding, sourceQuoteHasReliableVisualRows, stableHash } from '@core';
import { buildPdfManifest, INGESTION_LIMITS, renderDocxImagesToFiles, renderHeicImagesToPngs, renderPdfPagesToPngs } from '@ingestion';
import type { JobExecutionGuard, WorkspaceStore } from '@storage';
import {
  ACCEPTANCE_RULES_VERSION,
  EXTRACTION_PROMPT_VERSION
} from './prompts/index.js';
import { HEALTH_MODEL_TURN_TIMEOUT_MS } from './ai-runtime-policy.js';
import { buildP01Prompt, buildP03Prompt } from './prompts/lean.js';

interface StructuredRuntime {
  runStructuredTurn(input: {
    prompt: string;
    imagePaths?: string[];
    outputSchema: Record<string, unknown>;
    allowWebSearch?: boolean;
    timeoutMs?: number;
  }): Promise<{ threadId: string; turnId: string; output: unknown }>;
}

export type ExtractionPipelineResult =
  | { status: 'published'; documentId: string; revision: number; candidateCount: number; threadId: string; turnId: string }
  | { status: 'partial'; documentId: string; revision?: number; candidateCount: number; issueId: string; reason: string;
    requiresUser: false; threadId?: string; turnId?: string }
  | { status: 'needs_review'; documentId: string; issueId: string; reason: string; requiresUser?: true;
    threadId?: string; turnId?: string };

const outputSchema = z.toJSONSchema(extractionResultSchema, { target: 'draft-7' }) as Record<string, unknown>;
const repairOutputSchema = z.toJSONSchema(extractionRepairSchema, { target: 'draft-7' }) as Record<string, unknown>;
// 身份暂停的候选尚未通过本地接纳。恢复时只省掉 P01，不能按已验证块直接纳入。
const identityPendingCheckpointSchema = z.object({
  checkpointKind: z.literal('identity_pending'),
  result: extractionResultSchema
});
type CandidateValidationFailure = {
  localKey: string;
  itemName: string;
  reasons: string[];
};
interface ImageMapping {
  imageIndex: number;
  page: number | null;
  sourceSpanIds: string[];
}

function historicalPdfSpansMatch(stored: SourceSpan[], rebuilt: SourceManifest): boolean {
  if (rebuilt.totalUnits !== stored.length || rebuilt.spans.length !== stored.length) return false;
  return stored.every((span, index) => {
    const current = rebuilt.spans[index];
    return current !== undefined
      && span.spanKind === 'page'
      && current.spanKind === 'page'
      && span.page === index + 1
      && current.page === span.page
      && span.blockId === current.blockId
      && span.lineStart === current.lineStart
      && span.lineEnd === current.lineEnd
      && span.quote === current.quote
      && span.readability === current.readability;
  });
}

type ReviewDiffField = ReviewCandidateDiff['fields'][number];

type BloodPressureKind = 'systolic' | 'diastolic';

function blockingIssueCodes(candidate: ObservationCandidate): string[] {
  return [...new Set(candidate.issues
    .map((issue) => issue.code)
    .filter((code) => code.startsWith('blocking_')))].sort();
}


function pressureKind(candidate: ObservationCandidate): BloodPressureKind | null {
  const name = `${candidate.originalName} ${candidate.standardNameCandidate ?? ''}`
    .normalize('NFKC')
    .replace(/\s+/g, ' ')
    .trim()
    .toLocaleLowerCase('zh-CN');
  if (/\b(systolic blood pressure|sbp)\b|收缩压/.test(name)) return 'systolic';
  if (/\b(diastolic blood pressure|dbp)\b|舒张压/.test(name)) return 'diastolic';
  return null;
}

function isBloodPressurePair(candidate: ObservationCandidate): boolean {
  const names = [candidate.originalName, candidate.standardNameCandidate]
    .filter((name): name is string => Boolean(name))
    .map((name) => name.normalize('NFKC').replace(/\s+/g, ' ').trim().toLocaleLowerCase('zh-CN'));
  return pressureKind(candidate) === null
    && names.some((name) => name === '血压' || /\bblood pressure\b/.test(name));
}

function pressurePair(value: ObservationCandidate['value']): [string, string] | null {
  const raw = value.rawText?.normalize('NFKC').trim() ?? '';
  const match = /^(\d{1,3}(?:\.\d+)?)\s*[/\uff0f]\s*(\d{1,3}(?:\.\d+)?)$/.exec(raw);
  return match ? [match[1]!, match[2]!] : null;
}

function normalizedPressureEvidence(
  candidate: ObservationCandidate,
  spansById: Map<string, SourceSpan>
): { evidence: ObservationCandidate['evidence']; sourceText: string } | null {
  const sourceSpans = candidate.evidence
    .map((reference) => spansById.get(reference.sourceSpanId))
    .filter((span): span is SourceSpan => Boolean(span?.quote && span.readability === 'clear'));
  if (sourceSpans.length === 0) return null;
  return {
    evidence: candidate.evidence.map((reference) => {
      const span = spansById.get(reference.sourceSpanId);
      // 已有具体引用不可被整页文字覆盖，否则结果重复出现时会丢掉位置。
      return span?.quote && span.readability === 'clear' && reference.quote === null
        ? { ...reference, quote: span.quote } : reference;
    }),
    sourceText: sourceSpans.map((span) => span.quote!).join('\n').normalize('NFKC').replace(/\s+/g, ' ')
  };
}

function sourceNamesPressureValue(sourceText: string, kind: BloodPressureKind, value: string): boolean {
  const label = kind === 'systolic' ? '(?:收缩压|systolic blood pressure|sbp)' : '(?:舒张压|diastolic blood pressure|dbp)';
  const escapedValue = value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`${label}[^0-9]{0,24}${escapedValue}(?![0-9.])`, 'i').test(sourceText);
}

function canonicalPressureCandidate(
  candidate: ObservationCandidate,
  kind: BloodPressureKind,
  evidence: ObservationCandidate['evidence'],
  derivedValue?: { decimal: string; comparator: 'eq' }
): ObservationCandidate {
  const isSystolic = kind === 'systolic';
  const value = derivedValue
    ? { kind: 'numeric' as const, rawText: derivedValue.decimal, decimal: derivedValue.decimal, comparator: derivedValue.comparator }
    : candidate.value;
  return {
    ...candidate,
    localKey: `bp-${kind}-${stableHash({
      documentId: evidence[0]?.sourceSpanId,
      clinicalDate: candidate.clinicalDate,
      value
    }).slice(0, 16)}`,
    originalName: isSystolic ? '收缩压' : '舒张压',
    standardNameCandidate: isSystolic ? '收缩压' : '舒张压',
    // 直接候选只规范名称，不改写模型从原文读到的数值、比较符或单位。
    // 复合“血压 120/80 mmHg”才会创建两个有明确来源的派生数值。
    value,
    evidence
  };
}

function mergeDuplicateCandidates(candidates: ObservationCandidate[]): ObservationCandidate[] {
  const merged = new Map<string, ObservationCandidate>();
  for (const candidate of candidates) {
    const signature = stableHash({
      originalName: normalizedComparableText(candidate.originalName),
      value: comparableValue(candidate),
      unit: normalizedComparableText(candidate.unitRaw),
      clinicalDate: candidate.clinicalDate,
      sourceSpanIds: [...new Set(candidate.evidence.map((reference) => reference.sourceSpanId))].sort()
    });
    const existing = merged.get(signature);
    if (!existing) {
      merged.set(signature, candidate);
      continue;
    }
    const issueMap = new Map([...existing.issues, ...candidate.issues].map((issue) => [`${issue.code}\u0000${issue.message}`, issue]));
    const evidenceMap = new Map(existing.evidence.map((reference) => [reference.sourceSpanId, reference]));
    for (const reference of candidate.evidence) {
      const current = evidenceMap.get(reference.sourceSpanId);
      if (!current || (reference.quote?.length ?? 0) > (current.quote?.length ?? 0)) evidenceMap.set(reference.sourceSpanId, reference);
    }
    merged.set(signature, { ...existing, issues: [...issueMap.values()], evidence: [...evidenceMap.values()] });
  }
  return [...merged.values()];
}

function calendarDateMatches(text: string): Array<{ date: string; index: number; length: number }> {
  return calendarDateOccurrences(text);
}

function labelledCalendarDateMatches(text: string, clinicalOnly = false): Array<{ date: string; index: number; length: number }> {
  return calendarDateMatches(text).flatMap((match) => {
    const prefix = text.slice(Math.max(0, match.index - 40), match.index);
    const label = (clinicalOnly
      ? /(?:检查|检验|采样|采集|采血|体检|复查|就诊|临床)\s*(?:日期|时间)\s*[：:]?\s*$/
      : /(?:检查|检验|采样|采集|采血|体检|复查|就诊|临床|报告)\s*(?:日期|时间)\s*[：:]?\s*$/).exec(prefix);
    if (!label) return [];
    const index = match.index - label[0].length;
    return [{ date: match.date, index, length: match.length + label[0].length }];
  });
}

function contextualDateEvidenceQuote(
  spanQuote: string,
  citedQuote: string,
  clinicalDate: string
): string | null {
  const quoteIndex = spanQuote.indexOf(citedQuote);
  if (quoteIndex < 0 || spanQuote.indexOf(citedQuote, quoteIndex + 1) >= 0) return null;

  const allDates = calendarDateMatches(spanQuote);
  if (allDates.length === 0) return null;
  if (allDates.every((match) => match.date === clinicalDate)) {
    const nearestDate = allDates
      .map((match) => ({ ...match, distance: Math.abs(match.index - quoteIndex) }))
      .sort((left, right) => left.distance - right.distance)[0]!;
    if (nearestDate.distance > 2_000) return null;
    const start = Math.min(nearestDate.index, quoteIndex);
    const end = Math.max(nearestDate.index + nearestDate.length, quoteIndex + citedQuote.length);
    return spanQuote.slice(start, end);
  }

  // 年度对比表通常只在表头写一次两个（或多个）日期，数据行本身不再重复日期：
  // 2023-10-08 2024-10-22 趋势 ... 体重 91 94 ▲ ...
  // 这类版面必须把“日期表头 + 当前数据行”作为一个连续证据片段，不能要求
  // 每个数据行自行重复日期；同时只在明确出现“趋势”列且距离很近时启用，
  // 避免把普通的多日期叙述误判成列式对比表。
  const trendIndex = spanQuote.lastIndexOf('趋势', quoteIndex);
  if (trendIndex >= 0 && quoteIndex - trendIndex <= 1_000) {
    const headerDates = allDates.filter((match) => (
      match.index + match.length <= trendIndex
      && trendIndex - (match.index + match.length) <= 500
    ));
    if (headerDates.length >= 2 && headerDates.some((match) => match.date === clinicalDate)) {
      const start = headerDates[0]!.index;
      return spanQuote.slice(start, quoteIndex + citedQuote.length);
    }
  }

  const nearestPrecedingDate = labelledCalendarDateMatches(spanQuote)
    .filter((match) => match.index + match.length <= quoteIndex)
    .sort((left, right) => right.index - left.index)[0];
  if (!nearestPrecedingDate || nearestPrecedingDate.date !== clinicalDate) return null;
  if (quoteIndex - (nearestPrecedingDate.index + nearestPrecedingDate.length) > 2_000) return null;
  return spanQuote.slice(nearestPrecedingDate.index, quoteIndex + citedQuote.length);
}

function previousPageSectionDateEvidence(
  candidate: ObservationCandidate,
  currentSpan: SourceSpan,
  citedQuote: string,
  clinicalDate: string,
  sourceSpans: SourceSpan[]
): ObservationCandidate['evidence'][number] | null {
  const hasPageLocator = (span: SourceSpan) => ['page', 'image'].includes(span.spanKind) && span.page !== null;
  if (!hasPageLocator(currentSpan) || !currentSpan.quote) return null;
  const currentQuoteIndex = currentSpan.quote.indexOf(citedQuote);
  if (currentQuoteIndex < 0 || currentQuoteIndex > 300
    || currentSpan.quote.indexOf(citedQuote, currentQuoteIndex + 1) >= 0) return null;

  // 分页既可能切开“小结”，也可能把章节标题/检查日期与正文分在两页。
  // 只补齐紧邻上一页同一章节的日期，不从下一科室或签发/历史日期反推。
  const compact = (value: string) => value.normalize('NFKC').replace(/\s+/g, '');
  const originalName = compact(candidate.originalName);
  const sectionName = originalName.replace(/小结$/, '');
  const isSummary = sectionName !== originalName;
  if (sectionName.length < 2 || !/^[\p{Script=Han}]+$/u.test(sectionName)) return null;
  const currentPrefix = currentSpan.quote.slice(0, currentQuoteIndex).normalize('NFKC');
  if (/历次|历史|往年|年度对比|跨年|趋势/.test(`${currentPrefix}${citedQuote}`)) return null;
  const currentContext = compact(`${currentPrefix}${citedQuote}`);
  const currentNameIndex = currentContext.indexOf(sectionName);
  if (!isSummary && currentNameIndex < 0) return null;
  if (isSummary && !compact(citedQuote).startsWith('小结')
    && !compact(citedQuote).startsWith(originalName)
    && !compact(currentPrefix).endsWith('小结')) return null;
  // 页码/登记号和重复表头不表示新章节；除此之外的前置正文不视为页首续文。
  const escapedName = sectionName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const continuationPrefix = compact(currentPrefix
    .replace(/(?:登记流水号|登记编号|报告编号)\s*[：:]?\s*[A-Za-z0-9_-]+/g, '')
    .replace(/^\s*\d{1,4}(?:\s|$)/, ''))
    .replace(/(?:项目名称|检查结果|单位|参考值|参考范围|提示|续页|小结)/g, '')
    .replace(new RegExp(escapedName, 'g'), '');
  if (continuationPrefix) return null;
  if (!isSummary && currentNameIndex >= 0) {
    const beforeName = currentContext.slice(0, currentNameIndex)
      .replace(/(?:登记流水号|登记编号|报告编号)[：:]?[A-Za-z0-9_-]+/, '')
      .replace(/^\d{1,4}/, '')
      .replace(/(?:项目名称|检查结果|单位|参考值|参考范围|提示|续页)/g, '');
    if (beforeName) return null;
  }

  const previousSpans = sourceSpans.filter((span) => (
    span.documentId === currentSpan.documentId
    && hasPageLocator(span)
    && span.page === currentSpan.page! - 1
    && span.readability === 'clear'
    && Boolean(span.quote)
  ));
  if (previousSpans.length !== 1) return null;
  const previousSpan = previousSpans[0]!;
  const previousQuote = previousSpan.quote!;
  const compactCharacters: string[] = [];
  const originalOffsets: number[] = [];
  for (let index = 0; index < previousQuote.length; index += 1) {
    const character = previousQuote[index]!;
    if (/\s/.test(character)) continue;
    compactCharacters.push(character);
    originalOffsets.push(index);
  }
  const compactQuote = compactCharacters.join('').normalize('NFKC');
  const sectionIndex = compactQuote.lastIndexOf(sectionName);
  if (sectionIndex < 0 || compactQuote.indexOf(sectionName) !== sectionIndex) return null;
  const sectionOriginalIndex = originalOffsets[sectionIndex];
  if (sectionOriginalIndex === undefined) return null;
  const sectionTail = previousQuote.slice(sectionOriginalIndex);
  if (/历次|历史|往年|年度对比|跨年|趋势/.test(sectionTail)) return null;
  const sectionDates = labelledCalendarDateMatches(previousQuote, true)
    .filter((match) => match.index >= sectionOriginalIndex);
  if (sectionDates.length !== 1 || sectionDates[0]!.date !== clinicalDate) return null;
  const matchingDate = sectionDates[0]!;
  // 日期必须紧跟相同章节标题。允许“肝胆脾胰”与标题“肝胆脾胰彩超”的
  // 明确检查形式后缀，不做器官别名或语义猜测。
  const sectionSuffix = compact(previousQuote.slice(sectionOriginalIndex, matchingDate.index)).slice(sectionName.length);
  if (!/^(?:彩超|超声|超声检查|彩色多普勒超声|检查)?$/.test(sectionSuffix)) return null;
  const followingText = previousQuote.slice(matchingDate.index + matchingDate.length);
  if (/[\p{Script=Han}]{1,8}科(?:室)?(?:\s|[：:])/u.test(followingText)) return null;
  return {
    sourceSpanId: previousSpan.id,
    quote: sectionTail
  };
}

export function strengthenUnambiguousClinicalDateEvidence(
  candidates: ObservationCandidate[],
  sourceSpans: SourceSpan[]
): ObservationCandidate[] {
  const spansById = new Map(sourceSpans.map((span) => [span.id, span]));
  return candidates.map((candidate) => {
    const clinicalDate = candidate.clinicalDate;
    if (!clinicalDate) return candidate;
    const evidence = candidate.evidence.flatMap((reference) => {
      if (reference.quote && calendarDateMatches(reference.quote).some((match) => match.date === clinicalDate)) {
        return [reference];
      }
      const span = spansById.get(reference.sourceSpanId);
      if (!span?.quote || span.readability !== 'clear' || !reference.quote) return [reference];
      const previousPageEvidence = previousPageSectionDateEvidence(
        candidate, span, reference.quote, clinicalDate, sourceSpans
      );
      // 跨页小结位于下一页开头时，当前页后半段的日期通常属于下一个科室。
      if (previousPageEvidence) return [reference, previousPageEvidence];
      const strengthenedQuote = contextualDateEvidenceQuote(span.quote, reference.quote, clinicalDate);
      if (strengthenedQuote) return candidate.sourceBinding
        ? [reference, { ...reference, quote: strengthenedQuote }]
        : [{ ...reference, quote: strengthenedQuote }];
      return [reference];
    });
    const uniqueEvidence = [...new Map(evidence.map((reference) => (
      [`${reference.sourceSpanId}\u0000${reference.quote ?? ''}`, reference] as const
    ))).values()];
    return { ...candidate, evidence: uniqueEvidence };
  });
}

function inheritReportClinicalDate(
  candidates: ObservationCandidate[],
  sourceSpans: SourceSpan[],
  reportMetadata: ReportMetadataCandidate | null | undefined
): ObservationCandidate[] {
  const spansById = new Map(sourceSpans.map((span) => [span.id, span]));
  const reportTimes = reportMetadata?.times.filter((time) => (
    time.precision === 'day' && ['sampled', 'examined', 'encounter'].includes(time.role)
  )) ?? [];
  const dates = [...new Set(reportTimes.map((time) => time.value))];
  // 同一报告出现不同检查日时，不能把其中一个日期套到所有项目上。
  if (dates.length !== 1) return candidates;
  const reportDate = dates[0]!;
  const reportYear = reportDate.slice(0, 4);
  const nonClinicalDates = (span: SourceSpan): Set<string> => {
    const quote = span.quote ?? '';
    const proven = new Set<string>();
    for (const match of calendarDateMatches(quote)) {
      const prefix = quote.slice(Math.max(0, match.index - 40), match.index).normalize('NFKC').replace(/\s+/g, '');
      // 签发/打印/审核的日期不表示另一次检查，不能因此拒绝后页继承检查日。
      if (/(?:报告|签发|出具|打印|审核|出生|生日)(?:\s*(?:日期|时间))?\s*[：:]?\s*$/.test(prefix)) proven.add(match.date);
    }
    for (const time of reportMetadata?.times ?? []) {
      if (time.role !== 'history_quoted' || !/历次|历史|对比|既往|往年/.test(quote)) continue;
      if (time.evidence.some((reference) => (
        reference.sourceSpanId === span.id && Boolean(reference.quote)
        && quote.includes(reference.quote!)
        && calendarDateMatches(reference.quote!).some((match) => match.date === time.value)
      ))) proven.add(time.value);
    }
    return proven;
  };
  const hasCompetingClinicalDate = (span: SourceSpan): boolean => {
    const quote = span.quote ?? '';
    const nonClinical = nonClinicalDates(span);
    return calendarDateMatches(quote).some((match) => {
      if (match.date === reportDate) return false;
      const prefix = quote.slice(Math.max(0, match.index - 40), match.index).normalize('NFKC').replace(/\s+/g, '');
      // 同一个日期也可能在签发和另一章节检查中同时出现，不能按日期值全局消歧。
      const explicitlyClinical = /(?:检查|检验|采样|采集|采血|体检|复查|就诊|临床)\s*(?:日期|时间)\s*[：:]?\s*$/.test(prefix);
      return explicitlyClinical || !nonClinical.has(match.date);
    });
  };
  const hasCompetingFullReportDate = sourceSpans.some((span) => {
    const quote = span.quote;
    if (!quote) return false;
    const nonClinical = nonClinicalDates(span);
    if (hasCompetingClinicalDate(span)) return true;
    // 历史页本身不能继承当前日期；已明确标记的历史日期也不构成另一次本次检查。
    // 没有完整日期角色依据的跨年度内容仍保留歧义，交给局部修复而不是猜年份。
    if (/历次|跨年|年度对比|历史结果/.test(quote) && nonClinical.size === 0) return true;
    return [...quote.matchAll(/(?<!\d)((?:19|20)\d{2})(?:\s*年度|\s*年)?(?!\d)/g)]
      .some((match) => match[1] !== reportYear && ![...nonClinical].some((date) => date.startsWith(match[1]!)));
  });
  // 模型的元数据可能漏掉后续块、章节或年度对比中的日期。只有整份报告的所有
  // 可读片段都没有第二个检查日期或无法解释的年份时，才允许把
  // 首页日期继承给无日期候选。不能证明是同一次检查，就保留空值。
  if (hasCompetingFullReportDate) return candidates;
  const dateEvidence = reportTimes
    .flatMap((time) => time.evidence)
    .find((reference) => {
      const span = spansById.get(reference.sourceSpanId);
      return span?.readability === 'clear'
        && Boolean(span.quote && reference.quote && span.quote.includes(reference.quote))
        && calendarDateMatches(reference.quote ?? '').some((match) => match.date === reportDate);
    });
  if (!dateEvidence) return candidates;

  return candidates.map((candidate) => {
    if (candidate.clinicalDate && candidate.clinicalDate !== reportDate) return candidate;
    const citedSpans = candidate.evidence
      .map((reference) => spansById.get(reference.sourceSpanId))
      .filter((span): span is SourceSpan => Boolean(span?.quote && span.readability === 'clear'));
    if (citedSpans.length === 0) return candidate;
    // 历次结果、跨年对比或页面自身的其他日期必须按列/章节核对，不能继承封面日期。
    if (citedSpans.some((span) => (
      hasCompetingClinicalDate(span)
      || /历次|跨年|年度对比|历史结果/.test(span.quote ?? '')
    ))) return candidate;
    if (candidate.evidence.some((reference) => (
      reference.sourceSpanId === dateEvidence.sourceSpanId
      && reference.quote === dateEvidence.quote
    ))) return candidate.clinicalDate ? candidate : { ...candidate, clinicalDate: reportDate };
    return {
      ...candidate,
      clinicalDate: reportDate,
      evidence: [...candidate.evidence, dateEvidence]
    };
  });
}

function expandAbbreviatedEvidenceQuotes(
  candidates: ObservationCandidate[],
  sourceSpans: SourceSpan[]
): ObservationCandidate[] {
  const spansById = new Map(sourceSpans.map((span) => [span.id, span]));
  return candidates.map((candidate) => ({
    ...candidate,
    evidence: candidate.evidence.map((reference) => {
      const citedQuote = reference.quote;
      const span = spansById.get(reference.sourceSpanId);
      if (!citedQuote || !span?.quote || span.readability !== 'clear' || span.quote.includes(citedQuote)) return reference;
      const parts = citedQuote.split(/(?:…|\.\.\.)/).map((part) => part.trim()).filter(Boolean);
      if (parts.length !== 2) return reference;
      const [prefix, suffix] = parts as [string, string];
      const prefixIndex = span.quote.indexOf(prefix);
      if (prefixIndex < 0 || span.quote.indexOf(prefix, prefixIndex + 1) >= 0) return reference;
      const suffixIndex = span.quote.indexOf(suffix, prefixIndex + prefix.length);
      if (suffixIndex < 0) return reference;
      const nextSectionDate = labelledCalendarDateMatches(span.quote)
        .find((match) => match.index > prefixIndex + prefix.length);
      const sectionEnd = nextSectionDate?.index ?? span.quote.length;
      if (suffixIndex + suffix.length > sectionEnd) return reference;
      const repeatedSuffixIndex = span.quote.indexOf(suffix, suffixIndex + 1);
      if (repeatedSuffixIndex >= 0 && repeatedSuffixIndex < sectionEnd) return reference;
      const expanded = span.quote.slice(prefixIndex, suffixIndex + suffix.length);
      return expanded.length <= 2_000 ? { ...reference, quote: expanded } : reference;
    })
  }));
}

function relocateUnambiguousEvidenceRefs(
  candidates: ObservationCandidate[],
  sourceSpans: SourceSpan[]
): ObservationCandidate[] {
  const spansById = new Map(sourceSpans.map((span) => [span.id, span]));
  const compact = (value: string): string => value.normalize('NFKC').replace(/\s+/g, '');
  const relocate = (references: ObservationCandidate['evidence']): ObservationCandidate['evidence'] => (
    references.map((reference) => {
      if (!reference.quote || compact(reference.quote).length < 6) return reference;
      const existing = spansById.get(reference.sourceSpanId);
      if (existing?.readability === 'clear' && existing.quote
        && compact(existing.quote).includes(compact(reference.quote))) return reference;
      const matches = sourceSpans.filter((span) => (
        span.readability === 'clear' && Boolean(span.quote)
        && compact(span.quote!).includes(compact(reference.quote!))
      ));
      // 只有报告内唯一一处能逐字对上时才改来源定位；同值重复绝不猜页码。
      return matches.length === 1 ? { ...reference, sourceSpanId: matches[0]!.id } : reference;
    })
  );
  return candidates.map((candidate) => ({
    ...candidate,
    evidence: relocate(candidate.evidence),
    ...(candidate.sourceBinding ? { sourceBinding: {
      headingEvidence: relocate(candidate.sourceBinding.headingEvidence),
      findingEvidence: relocate(candidate.sourceBinding.findingEvidence)
    } } : {})
  }));
}

function normalizeCandidates(
  candidates: ObservationCandidate[],
  sourceSpans: SourceSpan[],
  reportMetadata?: ReportMetadataCandidate | null
): ObservationCandidate[] {
  return strengthenUnambiguousClinicalDateEvidence(
    inheritReportClinicalDate(expandAbbreviatedEvidenceQuotes(relocateUnambiguousEvidenceRefs(normalizeBloodPressureCandidates(candidates
      .map(normalizeModelEntities), sourceSpans), sourceSpans), sourceSpans), sourceSpans, reportMetadata),
    sourceSpans
  );
}

export function scopeCandidateKeys(candidates: ObservationCandidate[], chunkIndex: number): ObservationCandidate[] {
  const prefix = `chunk-${chunkIndex + 1}-`;
  return candidates.map((candidate) => {
    // localKey 是模型在当前块内的临时别名。进入应用后立即换成
    // “文档块 + 原别名”生成的稳定引用，避免跨块同名项目相互覆盖。
    if (candidate.localKey.startsWith(prefix) && /^chunk-\d+-[a-f0-9]{24}$/.test(candidate.localKey)) return candidate;
    return {
      ...candidate,
      localKey: `${prefix}${stableHash({ chunkIndex, modelLocalKey: candidate.localKey }).slice(0, 24)}`
    };
  });
}

function decodeModelEntities(value: string): string {
  return value
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&#39;', "'")
    .replaceAll('&amp;', '&');
}

function normalizeModelEntities(candidate: ObservationCandidate): ObservationCandidate {
  const value = candidate.value.rawText === null
    ? candidate.value
    : { ...candidate.value, rawText: decodeModelEntities(candidate.value.rawText) };
  const decodeNullable = (text: string | null) => text === null ? null : decodeModelEntities(text);
  return {
    ...candidate,
    originalName: decodeModelEntities(candidate.originalName),
    standardNameCandidate: decodeNullable(candidate.standardNameCandidate),
    value,
    unitRaw: decodeNullable(candidate.unitRaw),
    referenceRangeRaw: decodeNullable(candidate.referenceRangeRaw),
    reportedAbnormalFlag: decodeNullable(candidate.reportedAbnormalFlag),
    specimen: decodeNullable(candidate.specimen),
    method: decodeNullable(candidate.method),
    bodySite: decodeNullable(candidate.bodySite)
  };
}

export function normalizeBloodPressureCandidates(
  candidates: ObservationCandidate[],
  sourceSpans: SourceSpan[]
): ObservationCandidate[] {
  const spansById = new Map(sourceSpans.map((span) => [span.id, span]));
  const direct: ObservationCandidate[] = [];
  const derived: ObservationCandidate[] = [];

  for (const candidate of candidates) {
    const evidence = normalizedPressureEvidence(candidate, spansById);
    const kind = pressureKind(candidate);
    if (kind && candidate.value.kind === 'numeric' && evidence
      && sourceNamesPressureValue(evidence.sourceText, kind, candidate.value.decimal)) {
      direct.push(canonicalPressureCandidate(candidate, kind, evidence.evidence));
      continue;
    }

    const pair = isBloodPressurePair(candidate) ? pressurePair(candidate.value) : null;
    const hasMmhg = normalizedComparableText(candidate.unitRaw) === 'mmhg' || Boolean(evidence && /\bmm\s*hg\b/i.test(evidence.sourceText));
    const pairHasExactComparator = candidate.value.kind !== 'numeric' || candidate.value.comparator === 'eq';
    if (pair && pairHasExactComparator && evidence && hasMmhg
      && sourceNamesPressureValue(evidence.sourceText, 'systolic', pair[0])
      && sourceNamesPressureValue(evidence.sourceText, 'diastolic', pair[1])) {
      derived.push(canonicalPressureCandidate(candidate, 'systolic', evidence.evidence, { decimal: pair[0], comparator: 'eq' }));
      derived.push(canonicalPressureCandidate(candidate, 'diastolic', evidence.evidence, { decimal: pair[1], comparator: 'eq' }));
      continue;
    }
    direct.push(candidate);
  }
  return mergeDuplicateCandidates([...direct, ...derived]);
}

function normalizedComparableText(value: string | null): string | null {
  return value === null ? null : decodeModelEntities(value).normalize('NFKC').replace(/\s+/g, ' ').trim().toLocaleLowerCase('zh-CN');
}

function normalizedComparableMethod(value: string): string {
  const normalized = normalizedComparableText(value)!.replace(/检查$/u, '');
  if (/(?:彩超|超声|b\s*超|ultrasound|sonograph|doppler)/i.test(normalized)) return 'ultrasound';
  if (/^(?:幽门螺杆?菌)?尿素酶抗体$/u.test(normalized)) return 'urease-antibody';
  return normalized;
}

function isNormalLikeText(value: string | null): boolean {
  return /^(?:正常|未见异常|无异常|阴性|negative|normal|no abnormality(?: detected)?)$/i
    .test(normalizedComparableText(value) ?? '');
}

function normalizedComparableAbnormalFlag(candidate: ObservationCandidate): string | null {
  const flag = normalizedComparableText(candidate.reportedAbnormalFlag);
  if (flag && isNormalLikeText(flag)) return 'normal-like';
  if (flag === null && candidate.value.kind !== 'numeric' && isNormalLikeText(candidate.value.rawText)) return 'normal-like';
  return flag;
}


function comparableValue(candidate: ObservationCandidate): unknown {
  if (candidate.value.kind === 'numeric') {
    const numeric = Number(candidate.value.decimal);
    return {
      kind: candidate.value.kind,
      decimal: Number.isFinite(numeric) ? numeric : candidate.value.decimal,
      comparator: candidate.value.comparator
    };
  }
  if (candidate.value.kind === 'text') {
    return { kind: candidate.value.kind, rawText: normalizedComparableText(candidate.value.rawText) };
  }
  if (candidate.value.kind === 'qualitative') {
    return {
      kind: candidate.value.kind,
      rawText: normalizedComparableText(candidate.value.rawText),
      category: normalizedComparableText(candidate.value.category)
    };
  }
  return {
    kind: candidate.value.kind,
    rawText: normalizedComparableText(candidate.value.rawText)
  };
}

function candidateValuesConflict(first: ObservationCandidate, second: ObservationCandidate): boolean {
  if (first.value.kind !== second.value.kind) return true;
  if (first.value.kind === 'qualitative' && second.value.kind === 'qualitative') {
    if (normalizedComparableText(first.value.rawText) !== normalizedComparableText(second.value.rawText)) return true;
    if (first.value.category === null || second.value.category === null) return false;
    return normalizedComparableText(first.value.category) !== normalizedComparableText(second.value.category);
  }
  return stableHash(comparableValue(first)) !== stableHash(comparableValue(second));
}

function candidateConflictFields(first: ObservationCandidate, second: ObservationCandidate): ReviewDiffField[] {
  const fields: ReviewDiffField[] = [];
  const compareText = (
    field: Exclude<ReviewDiffField, 'presence' | 'value' | 'issues'>,
    firstValue: string | null,
    secondValue: string | null,
    allowOneSided = false
  ) => {
    if (allowOneSided && (firstValue === null || secondValue === null)) return;
    if (normalizedComparableText(firstValue) !== normalizedComparableText(secondValue)) fields.push(field);
  };

  compareText('originalName', first.originalName, second.originalName);
  // standardNameCandidate 是模型给出的展示别名，不是报告原始事实；只要原项目名一致，
  // 两轮使用不同标准名不应阻断整份报告。
  if (candidateValuesConflict(first, second)) fields.push('value');
  compareText('unitRaw', first.unitRaw, second.unitRaw);
  compareText('referenceRangeRaw', first.referenceRangeRaw, second.referenceRangeRaw);
  if (normalizedComparableAbnormalFlag(first) !== normalizedComparableAbnormalFlag(second)) {
    fields.push('reportedAbnormalFlag');
  }
  compareText('specimen', first.specimen, second.specimen, true);
  if (first.method !== null && second.method !== null
    && normalizedComparableMethod(first.method) !== normalizedComparableMethod(second.method)) {
    fields.push('method');
  }
  if (first.bodySite !== null && second.bodySite !== null
    && normalizedComparableBodySite(first.bodySite) !== normalizedComparableBodySite(second.bodySite)) {
    fields.push('bodySite');
  }
  compareText('clinicalDate', first.clinicalDate, second.clinicalDate, true);

  const firstIssueCodes = blockingIssueCodes(first);
  const secondIssueCodes = blockingIssueCodes(second);
  if (stableHash(firstIssueCodes) !== stableHash(secondIssueCodes)) fields.push('issues');
  return fields;
}

function normalizedComparableBodySite(value: string): string {
  // “甲状腺”与“甲状腺实质”描述的是同一检查部位；只去掉末尾的泛化组织词，
  // 不改动左/右等方向信息，避免把真正不同的部位合并。
  return normalizedComparableText(value)!.replace(/(?:实质|结)$/u, '');
}

/**
 * 独立复核用于发现临床事实冲突，而不是要求两轮输出的证据摘录和可选元数据逐字一致。
 * 一侧缺少标本、方法、部位或日期时，后续证据规则仍会逐项校验第二轮候选，因此不阻断。
 */
export function compareIndependentExtractions(
  first: ExtractionResult,
  second: ExtractionResult
): { compatible: boolean; differences: ReviewCandidateDiff[] } {
  const unmatchedSecond = new Set(second.candidates.map((_, index) => index));
  const differences: ReviewCandidateDiff[] = [];

  for (const firstCandidate of first.candidates) {
    const sameName = [...unmatchedSecond].filter((index) => (
      normalizedComparableText(second.candidates[index]!.originalName) === normalizedComparableText(firstCandidate.originalName)
    ));
    if (sameName.length === 0) {
      differences.push({
        localKey: firstCandidate.localKey,
        itemName: firstCandidate.originalName,
        fields: ['presence'],
        firstCandidate,
        secondCandidate: null
      });
      continue;
    }

    const ranked = sameName
      .map((index) => ({ index, fields: candidateConflictFields(firstCandidate, second.candidates[index]!) }))
      .sort((a, b) => a.fields.length - b.fields.length || a.index - b.index);
    const match = ranked[0]!;
    unmatchedSecond.delete(match.index);
    if (match.fields.length > 0) {
      const reviewedCandidate = second.candidates[match.index]!;
      differences.push({
        localKey: reviewedCandidate.localKey,
        itemName: reviewedCandidate.originalName,
        fields: match.fields,
        firstCandidate,
        secondCandidate: reviewedCandidate
      });
    }
  }

  for (const index of unmatchedSecond) {
    const candidate = second.candidates[index]!;
    differences.push({
      localKey: candidate.localKey,
      itemName: candidate.originalName,
      fields: ['presence'],
      firstCandidate: null,
      secondCandidate: candidate
    });
  }
  return { compatible: differences.length === 0, differences };
}

/**
 * 证据来源不是医学事实差异，但不能因此只保留第二轮的一处引用。
 * 仅当两轮都唯一地对齐到同一个候选时合并证据；“重复来源”角色则要求
 * 两轮对同一 sourceSpanId 和同一依据类型都做出明确判定。
 * 同日、同名、同数值的两次独立采样会有多个可对齐对象，因而不会进入合并。
 */
export function mergeIndependentlyConfirmedEvidence(
  first: ExtractionResult,
  second: ExtractionResult
): ExtractionResult {
  const compatibleFirstIndexes = second.candidates.map((secondCandidate) => first.candidates
    .map((firstCandidate, index) => ({ firstCandidate, index }))
    .filter(({ firstCandidate }) => (
      normalizedComparableText(firstCandidate.originalName) === normalizedComparableText(secondCandidate.originalName)
      && candidateConflictFields(firstCandidate, secondCandidate).length === 0
    ))
    .map(({ index }) => index));
  const compatibleSecondCounts = first.candidates.map((firstCandidate) => second.candidates.filter((secondCandidate) => (
    normalizedComparableText(firstCandidate.originalName) === normalizedComparableText(secondCandidate.originalName)
    && candidateConflictFields(firstCandidate, secondCandidate).length === 0
  )).length);

  return {
    ...second,
    candidates: second.candidates.map((secondCandidate, secondIndex) => {
      const firstIndexes = compatibleFirstIndexes[secondIndex]!;
      if (firstIndexes.length !== 1 || compatibleSecondCounts[firstIndexes[0]!] !== 1) return secondCandidate;
      const firstCandidate = first.candidates[firstIndexes[0]!]!;
      const firstDuplicateClaims = new Set(firstCandidate.evidence.flatMap((reference) => (
        reference.sourceRole === 'duplicate_source' && reference.duplicateBasis
          ? [`${reference.sourceSpanId}\u0000${reference.duplicateBasis}`]
          : []
      )));
      const secondDuplicateClaims = new Set(secondCandidate.evidence.flatMap((reference) => (
        reference.sourceRole === 'duplicate_source' && reference.duplicateBasis
          ? [`${reference.sourceSpanId}\u0000${reference.duplicateBasis}`]
          : []
      )));
      const jointlyConfirmedDuplicates = new Set(
        [...firstDuplicateClaims].filter((claim) => secondDuplicateClaims.has(claim))
      );
      const merged = [...new Map(
        [...secondCandidate.evidence, ...firstCandidate.evidence].map((reference) => {
          const claim = reference.duplicateBasis
            ? `${reference.sourceSpanId}\u0000${reference.duplicateBasis}`
            : null;
          const duplicateConfirmed = claim !== null && jointlyConfirmedDuplicates.has(claim);
          return [
            `${reference.sourceSpanId}\u0000${reference.quote ?? ''}`,
            {
              sourceSpanId: reference.sourceSpanId,
              quote: reference.quote,
              sourceRole: duplicateConfirmed ? 'duplicate_source' as const : 'primary' as const,
              duplicateBasis: duplicateConfirmed ? reference.duplicateBasis ?? null : null
            }
          ] as const;
        })
      ).values()];
      return { ...secondCandidate, evidence: merged };
    })
  };
}

function candidateValidationFailures(
  result: ExtractionResult,
  bundle: ReturnType<WorkspaceStore['getDocumentExtractionBundle']>
): CandidateValidationFailure[] {
  return result.candidates.flatMap((candidate) => {
    const outcome = evaluateObservationCandidate(candidate, bundle.manifest, {
      personConsistent: subjectIsConsistent(result, bundle),
      overwritesUserLockedValue: false
    });
    if (outcome.decision !== 'accept' && outcome.decision !== 'accept_with_warnings') {
      return [{ localKey: candidate.localKey, itemName: candidate.originalName, reasons: outcome.reasons }];
    }
    const binding = resolveReportSourceBinding(candidate, bundle.manifest);
    return binding.status === 'resolved' ? []
      : [{ localKey: candidate.localKey, itemName: candidate.originalName,
        reasons: [`source_binding_${binding.reason}`] }];
  });
}

/** 栏目和结果定位同样受原件范围约束，不能通过新增绑定引用绕过证据栅栏。 */
function candidateSourceReferences(candidate: ObservationCandidate): ObservationCandidate['evidence'] {
  return [...candidate.evidence, ...(candidate.sourceBinding?.headingEvidence ?? []),
    ...(candidate.sourceBinding?.findingEvidence ?? []), ...(candidate.clinicalContext?.conditions ?? [])];
}

/** 公共身份、日期与条件可跨页，具体结果仍必须落在本轮授权输出位置。 */
function candidateIsInOutputScope(candidate: ObservationCandidate, expected: Set<string>, manifest: SourceManifest): boolean {
  const allowed = new Set(manifest.spans.map((span) => span.id));
  if (candidateSourceReferences(candidate).some((ref) => !allowed.has(ref.sourceSpanId))) return false;
  const output = new Set([...expected, ...manifest.spans.filter((span) => span.blockId?.startsWith('local-vision-region:')
    && expected.has(span.blockId.slice('local-vision-region:'.length))).map((span) => span.id)]);
  const findingReferences = candidate.sourceBinding?.findingEvidence.filter((ref) => ref.sourceRole !== 'duplicate_source');
  if (findingReferences) return findingReferences.length > 0 && findingReferences.every((ref) => output.has(ref.sourceSpanId));
  const binding = resolveReportSourceBinding(candidate, manifest);
  // 旧候选无显式 findingEvidence 时，来源绑定只取真实结果，忽略引用中的日期与章节条件。
  return binding.status === 'resolved' ? binding.binding.units.length > 0
    && binding.binding.units.every((unit) => output.has(unit.sourceSpanId))
    : candidate.evidence.some((ref) => output.has(ref.sourceSpanId));
}


function normalizedPersonName(value: string): string {
  return value.normalize('NFKC').replace(/[\s·•・·]/g, '').toLocaleLowerCase('zh-CN');
}

function subjectEvidenceNamesOnlyReportStaff(
  result: ExtractionResult,
  bundle: ReturnType<WorkspaceStore['getDocumentExtractionBundle']>
): boolean {
  const name = result.subject.reportedName?.normalize('NFKC').replace(/\s+/g, '');
  if (!name || result.subject.evidence.length === 0) return false;
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const patientLabel = new RegExp(`(?:患者姓名|病人姓名|受检者姓名|受检人姓名|就诊人姓名|体检人姓名|患者|病人|受检者|受检人|就诊人|体检人)[:：]?${escapedName}`);
  const genericNameLabel = new RegExp(`(?:^|[,，;；|])姓名[:：]?${escapedName}`);
  const staffLabel = new RegExp(`(?:报告者|报告人|报告医生|报告医师|审核人|审核者|检验者|检验人|申请医生|签发人|录入人|操作者)(?:姓名)?[:：]?${escapedName}`);
  const spans = new Map(bundle.manifest.spans.map((span) => [span.id, span]));
  return result.subject.evidence.every((reference) => {
    const span = spans.get(reference.sourceSpanId);
    if (!span || !reference.quote) return false;
    const quote = reference.quote?.normalize('NFKC').replace(/\s+/g, '') ?? '';
    if (span.quote) {
      const source = span.quote.normalize('NFKC').replace(/\s+/g, '');
      if (!source.includes(quote) || patientLabel.test(source) || genericNameLabel.test(source)) return false;
    }
    return staffLabel.test(quote) && !patientLabel.test(quote) && !genericNameLabel.test(quote);
  });
}

function subjectEvidenceIsValid(
  result: ExtractionResult,
  bundle: ReturnType<WorkspaceStore['getDocumentExtractionBundle']>
): boolean {
  if (result.subject.confidence !== 'explicit' || !result.subject.reportedName || result.subject.evidence.length === 0) return false;
  const spans = new Map(bundle.manifest.spans.map((span) => [span.id, span]));
  return result.subject.evidence.every((reference) => {
    const span = spans.get(reference.sourceSpanId);
    if (!span || !span.quote || !reference.quote) return false;
    const source = span.quote.normalize('NFKC').replace(/\s+/g, ' ').trim();
    const quote = reference.quote.normalize('NFKC').replace(/\s+/g, ' ').trim();
    return source.includes(quote) && normalizedPersonName(quote).includes(normalizedPersonName(result.subject.reportedName!));
  });
}

function subjectEvidenceReferencesKnownSource(
  result: ExtractionResult,
  bundle: ReturnType<WorkspaceStore['getDocumentExtractionBundle']>
): boolean {
  if (result.subject.confidence !== 'explicit' || !result.subject.reportedName || result.subject.evidence.length === 0) return false;
  const knownSpanIds = new Set(bundle.manifest.spans.map((span) => span.id));
  return result.subject.evidence.every((reference) => knownSpanIds.has(reference.sourceSpanId));
}

function subjectIsConsistent(
  result: ExtractionResult,
  bundle: ReturnType<WorkspaceStore['getDocumentExtractionBundle']>
): boolean {
  // 手动上传或已确认归属由用户决定；原报告姓名仍按来源保留，不反向更改成员。
  if (bundle.personAssignmentBasis === 'user_selected' || bundle.personAssignmentBasis === 'identity_confirmed') return true;
  const trustedAssignment = bundle.personAssignmentBasis === 'folder_binding';
  // 报告者、审核人等工作人员姓名不是受检者身份；用户已选成员时不据此产生身份冲突。
  if (subjectEvidenceNamesOnlyReportStaff(result, bundle)) return trustedAssignment;
  // 目录自动归属仍需比较原件中明确识别的姓名；没有可核实姓名时可沿用目录绑定。
  if (!subjectEvidenceIsValid(result, bundle) && !subjectEvidenceReferencesKnownSource(result, bundle)) return trustedAssignment;
  const acceptedNames = [bundle.personDisplayName, bundle.confirmedReportedName, ...bundle.confirmedPersonAliases]
    .filter((name): name is string => Boolean(name));
  return acceptedNames.some((name) => normalizedPersonName(result.subject.reportedName!) === normalizedPersonName(name));
}

function conflictingReportedName(
  result: ExtractionResult,
  bundle: ReturnType<WorkspaceStore['getDocumentExtractionBundle']>
): string | null {
  if (bundle.personAssignmentBasis === 'user_selected' || bundle.personAssignmentBasis === 'identity_confirmed') return null;
  if (subjectEvidenceNamesOnlyReportStaff(result, bundle)) return null;
  if ((!subjectEvidenceIsValid(result, bundle) && !subjectEvidenceReferencesKnownSource(result, bundle)) || !result.subject.reportedName) return null;
  const acceptedNames = [bundle.personDisplayName, bundle.confirmedReportedName, ...bundle.confirmedPersonAliases]
    .filter((name): name is string => Boolean(name));
  return acceptedNames.some((name) => normalizedPersonName(result.subject.reportedName!) === normalizedPersonName(name))
    ? null
    : result.subject.reportedName;
}

function aggregateReviewedSubject(subjects: ExtractionResult['subject'][]): ExtractionResult['subject'] {
  const explicit = subjects.find((subject) => subject.confidence === 'explicit' && subject.reportedName);
  if (explicit) {
    const evidence = new Map(explicit.evidence.map((reference) => [reference.sourceSpanId, reference]));
    for (const subject of subjects) {
      if (subject.confidence !== 'explicit' || !subject.reportedName
        || normalizedPersonName(subject.reportedName) !== normalizedPersonName(explicit.reportedName!)) continue;
      for (const reference of subject.evidence) evidence.set(reference.sourceSpanId, reference);
    }
    return { ...explicit, evidence: [...evidence.values()] };
  }
  return subjects.find((subject) => subject.confidence === 'uncertain')
    ?? subjects[0]
    ?? { reportedName: null, evidence: [], confidence: 'absent' };
}

function reviewedSubjectsAreConsistent(
  subjects: ExtractionResult['subject'][],
  bundle: ReturnType<WorkspaceStore['getDocumentExtractionBundle']>
): boolean {
  if (bundle.personAssignmentBasis === 'user_selected' || bundle.personAssignmentBasis === 'identity_confirmed') return true;
  const names = new Set(subjects
    .filter((subject) => subject.confidence === 'explicit' && subject.reportedName)
    .map((subject) => normalizedPersonName(subject.reportedName!)));
  const confirmed = new Set([bundle.personDisplayName, bundle.confirmedReportedName, ...bundle.confirmedPersonAliases]
    .filter((name): name is string => Boolean(name)).map(normalizedPersonName));
  return names.size <= 1 || [...names].every((name) => confirmed.has(name));
}

function reportMetadataEvidence(metadata: ReportMetadataCandidate | null | undefined) {
  if (!metadata) return [];
  return [
    metadata.reportKind,
    metadata.title,
    metadata.organization,
    metadata.campus,
    metadata.department,
    metadata.reportNumber,
    metadata.encounterIdentifier,
    ...(metadata.sampleIdentifiers ?? []),
    ...metadata.examItems,
    ...metadata.times
  ].flatMap((field) => field?.evidence ?? []);
}

type MetadataTimeFailure = { index: number; reasons: string[]; sourceSpanIds: string[] };

export function reportMetadataTimeFailures(
  metadata: ReportMetadataCandidate | null | undefined,
  spans: SourceSpan[]
): MetadataTimeFailure[] {
  const byId = new Map(spans.map((span) => [span.id, span]));
  const compact = (value: string) => value.normalize('NFKC').replace(/\s+/g, '');
  return (metadata?.times ?? []).flatMap((time, index) => {
    const sourceSpanIds = time.evidence.map((reference) => reference.sourceSpanId);
    const sourceProven = time.evidence.every((reference) => {
      const span = byId.get(reference.sourceSpanId);
      return Boolean(span && (span.readability === 'clear' || sourceQuoteHasReliableVisualRows(span, reference.quote))
        && span.quote && reference.quote
        && compact(span.quote).includes(compact(reference.quote)));
    });
    if (!sourceProven) return [{ index, sourceSpanIds, reasons: ['metadata_date_evidence_not_proven'] }];
    const quotedSources = time.evidence.map((reference) => reference.quote!);
    const dateProven = quotedSources.some((quote) => {
      if (time.precision === 'day') return calendarDateMatches(quote).some((match) => match.date === time.value);
      if (calendarDateMatches(quote).some((match) => match.date.startsWith(time.value))) return true;
      const [year, month] = time.value.split('-');
      const expression = time.precision === 'year'
        ? `(?<![0-9])${year}(?![0-9])`
        : `(?<![0-9])${year}\\s*(?:年|[-/.])\\s*0?${Number(month)}(?:\\s*月|(?![0-9]))`;
      return new RegExp(expression, 'u').test(quote.normalize('NFKC'));
    });
    if (!dateProven) return [{ index, sourceSpanIds, reasons: ['metadata_date_not_in_evidence'] }];
    const clinicalRole = ['sampled', 'examined', 'encounter'].includes(time.role);
    if ((clinicalRole || time.role === 'report_issued') && time.precision === 'day') {
      const occurrences = quotedSources.flatMap((quote) => calendarDateMatches(quote)
        .filter((match) => match.date === time.value)
        .map((match) => {
          const prefix = compact(quote.slice(Math.max(0, match.index - 40), match.index));
          if (/(?:报告|签发|出具|打印|审核)\s*(?:日期|时间)?\s*[：:]?\s*$/.test(prefix)) return 'report';
          if (/(?:出生|生日)\s*(?:日期|时间)?\s*[：:]?\s*$/.test(prefix)) return 'birth';
          if (/(?:检查|检验|采样|采集|采血|体检|复查|就诊|临床)\s*(?:日期|时间)?\s*[：:]?\s*$/.test(prefix)) return 'clinical';
          return 'unlabelled';
        }));
      // 只有来源角色明示矛盾时阻断。页脚仅有日期、没有标签时仍可由
      // 模型结合完整报告定位角色；真实日期本身已经与独立源逐值核验。
      const roleProven = occurrences.some((role) => role === 'unlabelled'
        || (clinicalRole ? role === 'clinical' : role === 'report'));
      if (!roleProven) return [{ index, sourceSpanIds, reasons: ['metadata_date_role_mismatch'] }];
    }
    return [];
  });
}

export function provenReportMetadata(
  metadata: ReportMetadataCandidate | null | undefined,
  spans: SourceSpan[]
): ReportMetadataCandidate | null | undefined {
  if (!metadata) return metadata;
  const failedIndexes = new Set(reportMetadataTimeFailures(metadata, spans).map((failure) => failure.index));
  return { ...metadata, times: metadata.times.filter((_, index) => !failedIndexes.has(index)) };
}

function aggregateReportMetadata(items: Array<ReportMetadataCandidate | null | undefined>): ReportMetadataCandidate | null {
  const present = items.filter((item): item is ReportMetadataCandidate => Boolean(item));
  if (present.length === 0) return null;
  const firstField = (key: 'reportKind' | 'title' | 'organization' | 'campus' | 'department' | 'reportNumber' | 'encounterIdentifier') => (
    present.find((item) => item[key] !== null)?.[key] ?? null
  );
  const unique = <T>(values: T[]) => [...new Map(values.map((value) => [stableHash(value), value])).values()];
  return {
    reportKind: firstField('reportKind'),
    title: firstField('title'),
    organization: firstField('organization'),
    campus: firstField('campus'),
    department: firstField('department'),
    reportNumber: firstField('reportNumber'),
    encounterIdentifier: firstField('encounterIdentifier'),
    sampleIdentifiers: unique(present.flatMap((item) => item.sampleIdentifiers ?? [])),
    examItems: unique(present.flatMap((item) => item.examItems)),
    times: unique(present.flatMap((item) => item.times))
  };
}


function evidenceIsConfinedToChunk(result: ExtractionResult, expectedSpanIds: string[], manifest: SourceManifest): boolean {
  const expected = new Set(expectedSpanIds);
  const allowed = new Set(manifest.spans.map((span) => span.id));
  return result.subject.evidence.every((ref) => allowed.has(ref.sourceSpanId))
    && result.candidates.every((candidate) => candidateIsInOutputScope(candidate, expected, manifest))
    && result.coveredSourceSpanIds.every((id) => expected.has(id))
    && reportMetadataEvidence(result.reportMetadata).every((ref) => allowed.has(ref.sourceSpanId));
}

function needsVisualEvidence(span: SourceSpan): boolean {
  // 本机 OCR 是独立文字依据，不代替原图；模型仍需结合图像检查行列、页脚及左右侧。
  return span.spanKind === 'image' || span.readability !== 'clear' || !span.quote;
}

function estimatedSpanBytes(span: SourceSpan): number {
  return Buffer.byteLength(JSON.stringify({
    sourceSpanId: span.id,
    page: span.page,
    blockId: span.blockId,
    lineStart: span.lineStart,
    lineEnd: span.lineEnd,
    quote: span.quote,
    readability: span.readability
  }), 'utf8');
}

export function partitionSourceSpans(spans: SourceSpan[]): SourceSpan[][] {
  const chunks: SourceSpan[][] = [];
  let current: SourceSpan[] = [];
  let visualPages = new Set<number>();
  let currentBytes = 0;
  for (const span of spans) {
    // 局部重读仅增加同原页的辅助依据，不新增检查页或必提取单元。
    if (span.blockId?.startsWith('local-vision-region:')) continue;
    const spanBytes = estimatedSpanBytes(span);
    if (spanBytes > INGESTION_LIMITS.maxSourcePackageBytes / 2) throw new Error('SOURCE_SPAN_PROMPT_LIMIT_EXCEEDED');
    const nextVisualPages = new Set(visualPages);
    if (needsVisualEvidence(span) && span.page !== null) nextVisualPages.add(span.page);
    if (current.length > 0 && (
      current.length >= INGESTION_LIMITS.maxSpansPerTurn
      || nextVisualPages.size > INGESTION_LIMITS.maxVisualPagesPerTurn
      || currentBytes + spanBytes > INGESTION_LIMITS.maxSourcePackageBytes / 2
    )) {
      chunks.push(current);
      current = [];
      visualPages = new Set<number>();
      currentBytes = 0;
    }
    current.push(span);
    currentBytes += spanBytes;
    if (needsVisualEvidence(span) && span.page !== null) visualPages.add(span.page);
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

export const partitionPdfSpans = partitionSourceSpans;

function buildSourcePackage(
  bundle: ReturnType<WorkspaceStore['getDocumentExtractionBundle']>,
  spans: SourceSpan[],
  imageMappings: ImageMapping[]
): string {
  return JSON.stringify({
    documentId: bundle.documentId,
    mediaType: bundle.manifest.mediaType,
    normalizerVersion: bundle.manifest.normalizerVersion,
    totalUnits: bundle.manifest.totalUnits,
    chunkUnitCount: spans.length,
    // 分组只约束输出和本轮图像；完整报告上下文不能静默降成当前组或摘要。
    targetSourceSpanIds: spans.map((span) => span.id),
    allowedSourceSpanIds: bundle.manifest.spans.map((span) => span.id),
    contextMode: 'whole_document_text',
    visualScope: { attachedPages: imageMappings.map((mapping) => mapping.page),
      allDocumentImagesAttached: bundle.manifest.spans.filter(needsVisualEvidence)
        .every((span) => imageMappings.some((mapping) => mapping.sourceSpanIds.includes(span.id))) },
    spans: bundle.manifest.spans.map((span) => ({
      sourceSpanId: span.id,
      page: span.page,
      blockId: span.blockId,
      lineStart: span.lineStart,
      lineEnd: span.lineEnd,
      quote: span.quote,
      readability: span.readability,
      spanKind: span.spanKind
    })),
    imageInputs: imageMappings
  });
}

function normalizeReportedAbnormalFlag(value: string | null): 'high' | 'low' | 'positive' | 'negative' | 'normal' | 'unknown' {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return 'unknown';
  if (['high', 'h', '偏高', '升高', '↑'].includes(normalized)) return 'high';
  if (['low', 'l', '偏低', '降低', '↓'].includes(normalized)) return 'low';
  if (['positive', '+', '阳性'].includes(normalized)) return 'positive';
  if (['negative', '-', '阴性'].includes(normalized)) return 'negative';
  if (['normal', '正常', '未见异常'].includes(normalized)) return 'normal';
  return 'unknown';
}

function candidateToObservation(candidate: ObservationCandidate, acceptanceId: string, documentId: string) {
  const firstEvidence = candidate.sourceBinding?.findingEvidence.find((reference) => reference.sourceRole !== 'duplicate_source')
    ?? candidate.evidence.find((reference) => reference.sourceRole !== 'duplicate_source')
    ?? candidate.evidence[0];
  if (!firstEvidence) throw new Error('CANDIDATE_EVIDENCE_REQUIRED');
  const decimalValue = candidate.value.kind === 'numeric' ? candidate.value.decimal : null;
  const qualifier = candidate.value.kind === 'numeric'
    ? candidate.value.comparator
    : candidate.value.kind === 'qualitative' ? candidate.value.category : null;
  return {
    // conceptKey 暂作旧读模型的展示键；原始名与模型候选必须分开持久化。
    // 候选名不得反向改写报告原文。
    conceptKey: candidate.originalName,
    originalName: candidate.originalName,
    modelStandardNameCandidate: candidate.standardNameCandidate,
    rawText: candidate.value.rawText ?? '',
    valueKind: candidate.value.kind,
    decimalValue,
    qualifier,
    unit: candidate.unitRaw,
    referenceRange: candidate.referenceRangeRaw,
    clinicalDate: candidate.clinicalDate,
    abnormalFlag: normalizeReportedAbnormalFlag(candidate.reportedAbnormalFlag),
    documentId,
    sourceSpanId: firstEvidence.sourceSpanId,
    acceptanceId,
    specimen: candidate.specimen,
    method: candidate.method,
    bodySite: candidate.bodySite,
    clinicalContext: candidate.clinicalContext ?? null,
    evidence: candidate.evidence,
    sourceBinding: candidate.sourceBinding,
    // 完整候选供应用对账和隔离使用，不把模型临时键作为正式记录编号。
    candidate
  };
}

function sameReportFinding(old: ObservationCandidate, accepted: ObservationCandidate[], manifest: SourceManifest,
  sameSourceLocation: (previousId: string, currentId: string) => boolean = (previousId, currentId) => previousId === currentId): boolean {
  const sourceSpans = manifest.spans;
  const relocatedOld = relocateUnambiguousEvidenceRefs([old], sourceSpans)[0]!;
  const oldBinding = resolveReportSourceBinding(relocatedOld, manifest);
  if (oldBinding.status === 'resolved') {
    // 待核对线索不是已接纳事实。新结果通过全部来源校验后，按唯一的实际
    // 来源槽位结清旧线索，不因模型换了展示名或补齐日期而重复留下旧缺口。
    const matching = accepted.filter((candidate) => {
      const current = resolveReportSourceBinding(candidate, manifest);
      return current.status === 'resolved'
        && oldBinding.binding.units.length === current.binding.units.length
        && oldBinding.binding.units.every((unit) => current.binding.units.some((other) => (
          sameSourceLocation(unit.sourceSpanId, other.sourceSpanId)
          && unit.segmentStart === other.segmentStart && unit.segmentEnd === other.segmentEnd
        )));
    });
    if (matching.length === 1) return true;
  }
  // 名称或栏目在原文中唯一，也不能证明该栏目下的另一个具体发现已经补齐。
  // 旧线索无法定位或与新发现位置不同，必须保留；不能为了减少提示把缺口抹掉。
  return false;
}

function confirmedBlankOldCandidate(
  candidate: ObservationCandidate,
  allOldCandidates: ObservationCandidate[],
  newCandidates: ObservationCandidate[],
  coveredSourceSpanIds: string[],
  sourceSpans: SourceSpan[]
): boolean {
  if (candidate.value.kind !== 'unknown' || candidate.value.rawText !== null
    || candidate.issues.length > 0 || !/为空|空白|未填写/.test(candidate.value.reason)) return false;
  const compact = (value: string): string => value.normalize('NFKC').replace(/[\s（）()：:；;，,。]/g, '');
  const name = compact(candidate.originalName);
  if (!name || newCandidates.some((item) => compact(item.originalName) === name)) return false;
  const knownNames = [...new Set([...allOldCandidates, ...newCandidates]
    .map((item) => compact(item.originalName)).filter((item) => item && item !== name))];
  const byId = new Map(sourceSpans.map((span) => [span.id, span]));
  return candidate.evidence.length > 0 && candidate.evidence.every((reference) => {
    const span = byId.get(reference.sourceSpanId);
    if (!coveredSourceSpanIds.includes(reference.sourceSpanId)
      || span?.readability !== 'clear' || !span.quote || !reference.quote
      || !compact(span.quote).includes(compact(reference.quote))) return false;
    const cited = compact(reference.quote);
    const index = cited.indexOf(name);
    if (index < 0 || cited.indexOf(name, index + name.length) >= 0) return false;
    const after = index + name.length;
    const nextIndexes = knownNames.map((known) => cited.indexOf(known, after)).filter((value) => value >= 0);
    const segment = cited.slice(after, nextIndexes.length > 0 ? Math.min(...nextIndexes) : cited.length);
    // 明确空白标记可以结清。单独一行“项目：”也有可核验的空栏结构；
    // 整页 OCR 没读到内容或引用截断后的空串不能冒充原件空白。
    const blankLine = span.spanKind === 'line'
      && /^[^:：;；\n]{2,50}[:：]\s*$/u.test(span.quote.trim())
      && compact(span.quote) === name;
    return /^(?:空白|未填写|—|–|--)$/.test(segment) || blankLine;
  });
}

function sourceOnlyHasExplicitBlankResults(spans: SourceSpan[]): boolean {
  // 只处理完整、独立的空结果行。图片/OCR 没读到结果、整页空白或模型漏提取
  // 不能据此完成；这些资料仍需保留真实的来源缺口。
  return spans.length > 0 && spans.every((span) => span.spanKind === 'line'
    && span.readability === 'clear'
    && /^[^:：;；\n]{2,50}[:：]\s*(?:空白|未填写|—|–|--)?\s*$/u.test(span.quote?.trim() ?? ''));
}

export class DocumentExtractionPipeline {
  constructor(
    private readonly store: WorkspaceStore,
    private readonly runtime: StructuredRuntime,
    private readonly executionGuard?: JobExecutionGuard
  ) {}

  private async runTurn(
    documentId: string,
    stage: string,
    input: Parameters<StructuredRuntime['runStructuredTurn']>[0]
  ): ReturnType<StructuredRuntime['runStructuredTurn']> {
    if (!this.executionGuard) return this.runtime.runStructuredTurn(input);
    this.store.assertJobExecutionActive(this.executionGuard, documentId);
    const transmissionId = this.store.beginAiTransmission({ guard: this.executionGuard, documentId, stage });
    try {
      const result = await this.runtime.runStructuredTurn(input);
      this.store.assertJobExecutionActive(this.executionGuard, documentId);
      this.store.finishAiTransmission(transmissionId, 'completed');
      return result;
    } catch (error) {
      this.store.finishAiTransmission(transmissionId, 'unknown');
      throw error;
    }
  }


  async process(documentId: string): Promise<ExtractionPipelineResult> {
    const committedReviewIssue = this.store.isDocumentCommitted(documentId)
      ? this.store.listOpenExtractionReviewIssues().find((issue) => (
        issue.documentId === documentId && issue.severity === 'warning' && issue.stage === 'extract'
      ))
      : null;
    if (this.store.isDocumentCommitted(documentId) && !committedReviewIssue) {
      throw new Error('COMMITTED_DOCUMENT_REPAIR_ISSUE_REQUIRED');
    }
    let bundle = this.store.getDocumentExtractionBundle(documentId);
    // 局部重读必须升级独立图像转写；否则新校验仍反复消费丢失行列关系的旧 OCR。
    // 旧来源片段保持不可变，已接纳事实继续引用旧原句；新任务只读取新版 manifest。
    if ((bundle.manifest.mediaType.startsWith('image/') || bundle.manifest.mediaType === 'application/pdf')
      && bundle.manifest.normalizerVersion.includes('local-visual-evidence-v1')
      && !bundle.manifest.normalizerVersion.includes('local-visual-geometry-v1')) {
      const manifest = await normalizeStoredSource({ store: this.store, documentId,
        sourceObjectId: bundle.manifest.sourceObjectId, sha256: bundle.manifest.sha256,
        displayName: bundle.manifest.originalDisplayName, bytes: readFileSync(bundle.sourcePath),
        createdAt: bundle.manifest.createdAt });
      if (!manifest.normalizerVersion.includes('local-visual-geometry-v1')) {
        throw new Error('LOCAL_VISUAL_LAYOUT_UPGRADE_UNAVAILABLE');
      }
      this.store.replaceSourceManifestForReprocessing(manifest,
        this.executionGuard ? { executionGuard: this.executionGuard } : undefined);
      bundle = this.store.getDocumentExtractionBundle(documentId);
    }
    if (bundle.manifest.conversionWarnings.includes('historical_manifest_metadata_unavailable')) {
      if (bundle.manifest.mediaType !== 'application/pdf') throw new Error('LEGACY_MANIFEST_RECOVERY_UNSAFE');
      const bytes = readFileSync(bundle.sourcePath);
      const actualHash = createHash('sha256').update(bytes).digest('hex');
      if (actualHash !== bundle.manifest.sha256) throw new Error('LEGACY_PDF_SOURCE_HASH_MISMATCH');
      const rebuilt = await buildPdfManifest({
        sourceObjectId: bundle.manifest.sourceObjectId,
        documentId,
        sha256: actualHash,
        displayName: bundle.manifest.originalDisplayName,
        bytes,
        createdAt: bundle.manifest.createdAt
      });
      if (rebuilt.normalizerVersion !== bundle.manifest.normalizerVersion
        || !historicalPdfSpansMatch(bundle.manifest.spans, rebuilt)) {
        throw new Error('LEGACY_PDF_MANIFEST_RECOVERY_UNSAFE');
      }
      this.store.reconstructLegacyPdfManifest({
        documentId,
        sha256: actualHash,
        totalPages: rebuilt.totalUnits,
        normalizerVersion: rebuilt.normalizerVersion
      });
      bundle = this.store.getDocumentExtractionBundle(documentId);
    }
    const isImage = bundle.manifest.mediaType.startsWith('image/');
    const isHeic = ['image/heic', 'image/heif'].includes(bundle.manifest.mediaType);
    const isPdf = bundle.manifest.mediaType === 'application/pdf';
    const isDocx = bundle.manifest.mediaType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    if (isDocx && bundle.manifest.conversionWarnings.some((warning) => warning.startsWith('docx_embedded_image_unsupported:'))) {
      return this.needsReview(
        documentId,
        'coverage_gap',
        bundle.manifest.spans.filter((span) => span.spanKind === 'image').map((span) => span.id),
        'DOCX_IMAGE_FORMAT_UNSUPPORTED'
      );
    }
    const hasDocxVisualEvidence = isDocx && bundle.manifest.spans.some((span) => span.spanKind === 'image' && span.readability !== 'unreadable');
    if (!isImage && !isPdf && !hasDocxVisualEvidence && bundle.manifest.spans.every((span) => !span.quote)) {
      return this.needsReview(documentId, 'coverage_gap', bundle.manifest.spans.map((span) => span.id), 'SOURCE_CONTENT_UNREADABLE');
    }
    // 整份原文始终参与每次P01/P03；预算只划分输出与附图的目标范围。
    // 不能用分组结果的后续综合代替提取时的整篇上下文理解。
    const chunks = partitionSourceSpans(bundle.manifest.spans);
    const acceptedCandidates: ObservationCandidate[] = [];
    const coveredSourceSpanIds: string[] = [];
    const subjects: ExtractionResult['subject'][] = [];
    const metadata: Array<ReportMetadataCandidate | null | undefined> = [];
    const extractionTurnIds: string[] = [];
    const unresolved: Array<{ candidate: ObservationCandidate; reasons: string[] }> = [];
    const uncoveredSpanIds: string[] = [];
    const metadataUnresolvedSpanIds: string[] = [];
    const metadataUnresolvedReasons: string[] = [];
    // 恢复同一报告时可复用独立区域依据，不因模型繁忙重试反复调用本机OCR。
    let localRegionReadAttempted = bundle.manifest.spans.some((span) => span.blockId?.startsWith('local-vision-region:'));
    let lastReceipt: { threadId: string; turnId: string } | null = null;
    let temporaryRoot: string | null = null;
    const absorbChunk = (extracted: ExtractionResult, expectedSpanIds: string[]): boolean => {
      const expected = new Set(expectedSpanIds);
      const allowed = new Set(bundle.manifest.spans.map((span) => span.id));
      if (extracted.subject.evidence.some((ref) => !allowed.has(ref.sourceSpanId))) return false;
      const failures = candidateValidationFailures(extracted, bundle);
      const missing = expectedSpanIds.filter((id) => !extracted.coveredSourceSpanIds.includes(id));
      const outOfChunk = extracted.candidates.filter((candidate) => !candidateIsInOutputScope(candidate, expected, bundle.manifest));
      const failedKeys = new Set([...failures.map((failure) => failure.localKey), ...outOfChunk.map((candidate) => candidate.localKey)]);
      acceptedCandidates.push(...extracted.candidates.filter((candidate) => !failedKeys.has(candidate.localKey)));
      for (const failure of failures) {
        const candidate = extracted.candidates.find((item) => item.localKey === failure.localKey);
        if (candidate) unresolved.push({ candidate, reasons: failure.reasons });
      }
      unresolved.push(...outOfChunk.map((candidate) => ({ candidate, reasons: ['EVIDENCE_OUTSIDE_CHUNK'] })));
      uncoveredSpanIds.push(...missing);
      coveredSourceSpanIds.push(...extracted.coveredSourceSpanIds.filter((id) => expected.has(id)));
      subjects.push(subjectEvidenceNamesOnlyReportStaff(extracted, bundle)
        ? { reportedName: null, evidence: [], confidence: 'absent' }
        : extracted.subject);
      const metadataTimeFailures = reportMetadataTimeFailures(extracted.reportMetadata, bundle.manifest.spans);
      metadataUnresolvedSpanIds.push(...metadataTimeFailures.flatMap((failure) => failure.sourceSpanIds));
      metadataUnresolvedReasons.push(...metadataTimeFailures.flatMap((failure) => failure.reasons));
      metadata.push(reportMetadataEvidence(extracted.reportMetadata).every((ref) => allowed.has(ref.sourceSpanId))
        ? provenReportMetadata(extracted.reportMetadata, bundle.manifest.spans) : null);
      return true;
    };
    try {
      for (const [chunkIndex, spans] of chunks.entries()) {
        const expectedSpanIds = spans.map((span) => span.id);
        const checkpointSignature = stableHash({
          documentId, sourceSha256: bundle.manifest.sha256,
          // 独立区域是可追加的交叉核验，不改原页内容。追加不能使已完成块的恢复签名失效。
          normalizerVersion: bundle.manifest.normalizerVersion.replaceAll('+local-visual-region-v1', ''),
          promptVersion: EXTRACTION_PROMPT_VERSION,
          rulesVersion: ACCEPTANCE_RULES_VERSION,
          wholeDocumentContextHash: stableHash(bundle.manifest.spans.filter((span) => !span.blockId?.startsWith('local-vision-region:')).map((span) => ({
            id: span.id, quote: span.quote, readability: span.readability, visualEvidence: span.visualEvidence ?? null
          }))),
          chunkIndex,
          spans: spans.map((span) => ({ id: span.id, quote: span.quote, readability: span.readability }))
        });
        const checkpoint = this.executionGuard
          ? this.store.getExtractionChunkCheckpoint(this.executionGuard, documentId, checkpointSignature)
          : null;
        let pendingIdentityResult: ExtractionResult | null = null;
        if (checkpoint) {
          const pending = identityPendingCheckpointSchema.safeParse(checkpoint.output);
          if (pending.success) {
            if (pending.data.result.documentId !== documentId) throw new Error('EXTRACTION_CHUNK_CHECKPOINT_INVALID');
            pendingIdentityResult = pending.data.result;
          } else {
            const parsedCheckpoint = extractionResultSchema.safeParse(checkpoint.output);
            if (!parsedCheckpoint.success || parsedCheckpoint.data.documentId !== documentId
              || !subjectIsConsistent(parsedCheckpoint.data, bundle)
              || !evidenceIsConfinedToChunk(parsedCheckpoint.data, expectedSpanIds, bundle.manifest)
              || !absorbChunk(parsedCheckpoint.data, expectedSpanIds)) {
              throw new Error('EXTRACTION_CHUNK_CHECKPOINT_INVALID');
            }
            lastReceipt = { threadId: checkpoint.threadId, turnId: checkpoint.turnId };
            extractionTurnIds.push(checkpoint.extractionTurnId);
            continue;
          }
        }
        const imagePaths: string[] = [];
        const imageMappings: ImageMapping[] = [];
        const chunkDirectory = 'chunk-' + (chunkIndex + 1);
        if (isImage && !isHeic) {
          imagePaths.push(bundle.sourcePath);
          imageMappings.push({ imageIndex: 0, page: 1, sourceSpanIds: spans.map((span) => span.id) });
        } else if (isHeic) {
          if (spans.some((span) => span.page === null)) {
            return this.needsReview(documentId, 'coverage_gap', spans.map((span) => span.id), 'HEIC_IMAGE_LOCATOR_MISSING');
          }
          temporaryRoot ??= mkdtempSync(join(tmpdir(), 'family-health-image-'));
          chmodSync(temporaryRoot, 0o700);
          const rendered = await renderHeicImagesToPngs({
            bytes: readFileSync(bundle.sourcePath),
            outputDirectory: join(temporaryRoot, chunkDirectory),
            imageIndexes: spans.map((span) => span.page!)
          });
          for (const [imageIndex, image] of rendered.entries()) {
            imagePaths.push(image.path);
            imageMappings.push({
              imageIndex, page: image.imageIndex,
              sourceSpanIds: spans.filter((span) => span.page === image.imageIndex).map((span) => span.id)
            });
          }
        } else if (isPdf) {
          const visualSpans = spans.filter(needsVisualEvidence);
          if (visualSpans.some((span) => span.page === null)) {
            return this.needsReview(documentId, 'coverage_gap', visualSpans.map((span) => span.id), 'PDF_VISUAL_PAGE_LOCATOR_MISSING');
          }
          const visualPages = [...new Set(visualSpans.map((span) => span.page!))];
          if (visualPages.length > 0) {
            temporaryRoot ??= mkdtempSync(join(tmpdir(), 'family-health-pdf-'));
            chmodSync(temporaryRoot, 0o700);
            const rendered = await renderPdfPagesToPngs({
              bytes: readFileSync(bundle.sourcePath),
              outputDirectory: join(temporaryRoot, chunkDirectory),
              pageNumbers: visualPages
            });
            for (const [imageIndex, page] of rendered.entries()) {
              imagePaths.push(page.path);
              imageMappings.push({
                imageIndex, page: page.page,
                sourceSpanIds: visualSpans.filter((span) => span.page === page.page).map((span) => span.id)
              });
            }
          }
        } else if (isDocx) {
          const visualSpans = spans.filter((span) => span.spanKind === 'image');
          const indexedSpans = visualSpans.map((span) => {
            const matched = /^image-(\d+)$/.exec(span.blockId ?? '');
            return matched ? { span, imageIndex: Number(matched[1]) } : null;
          });
          if (indexedSpans.some((entry) => entry === null)) {
            return this.needsReview(documentId, 'coverage_gap', visualSpans.map((span) => span.id), 'DOCX_IMAGE_LOCATOR_MISSING');
          }
          if (indexedSpans.length > 0) {
            temporaryRoot ??= mkdtempSync(join(tmpdir(), 'family-health-docx-'));
            chmodSync(temporaryRoot, 0o700);
            const rendered = await renderDocxImagesToFiles({
              bytes: readFileSync(bundle.sourcePath),
              outputDirectory: join(temporaryRoot, chunkDirectory),
              imageIndexes: indexedSpans.map((entry) => entry!.imageIndex)
            });
            for (const [imageIndex, image] of rendered.entries()) {
              imagePaths.push(image.path);
              imageMappings.push({
                imageIndex, page: null,
                sourceSpanIds: indexedSpans.filter((entry) => entry!.imageIndex === image.imageIndex).map((entry) => entry!.span.id)
              });
            }
          }
        }
        const sourcePackage = buildSourcePackage(bundle, spans, imageMappings);
        if (Buffer.byteLength(sourcePackage, 'utf8') > INGESTION_LIMITS.maxSourcePackageBytes) {
          throw new Error('SOURCE_PACKAGE_LIMIT_EXCEEDED');
        }
        const generated = pendingIdentityResult && checkpoint ? {
          threadId: checkpoint.threadId, turnId: checkpoint.turnId, output: pendingIdentityResult
        } : await this.runTurn(documentId, 'extract', {
          prompt: buildP01Prompt({
            personId: bundle.personId, displayName: bundle.personDisplayName,
            note: '显示名只用于归属核对，不能作为报告身份来源。'
          }, JSON.parse(sourcePackage)),
          imagePaths, outputSchema, allowWebSearch: false, timeoutMs: HEALTH_MODEL_TURN_TIMEOUT_MS
        });
        lastReceipt = { threadId: generated.threadId, turnId: generated.turnId };
        let effectiveReceipt = lastReceipt;
        const extractionTurnId = pendingIdentityResult && checkpoint ? checkpoint.extractionTurnId : generated.turnId;
        extractionTurnIds.push(extractionTurnId);
        const parsed = extractionResultSchema.safeParse(generated.output);
        if (!parsed.success || parsed.data.documentId !== documentId) {
          return this.needsReview(documentId, 'field_conflict', expectedSpanIds, 'EXTRACTION_SCHEMA_INVALID',
            generated.threadId, generated.turnId);
        }
        let extracted: ExtractionResult = {
          ...parsed.data,
          candidates: scopeCandidateKeys(normalizeCandidates(parsed.data.candidates, bundle.manifest.spans,
            provenReportMetadata(parsed.data.reportMetadata, bundle.manifest.spans)), chunkIndex)
        };
        if (!subjectIsConsistent(extracted, bundle)) {
          if (this.executionGuard) {
            this.store.saveExtractionChunkCheckpoint({
              guard: this.executionGuard, documentId, signature: checkpointSignature,
              chunkIndex, output: { checkpointKind: 'identity_pending', result: extracted },
              threadId: generated.threadId, turnId: generated.turnId, extractionTurnId
            });
          }
          const reportedName = conflictingReportedName(extracted, bundle);
          return this.needsReview(documentId, reportedName ? 'person_conflict' : 'field_conflict',
            extracted.subject.evidence.map((item) => item.sourceSpanId), 'PERSON_IDENTITY_NOT_CONFIRMED',
            generated.threadId, generated.turnId, undefined, reportedName ?? undefined);
        }
        const missing = expectedSpanIds.filter((id) => !extracted.coveredSourceSpanIds.includes(id));
        const failures = candidateValidationFailures(extracted, bundle);
        const metadataTimeFailures = reportMetadataTimeFailures(extracted.reportMetadata, bundle.manifest.spans);
        if (missing.length > 0 || failures.length > 0 || metadataTimeFailures.length > 0
          || !evidenceIsConfinedToChunk(extracted, expectedSpanIds, bundle.manifest)) {
          const expected = new Set(expectedSpanIds);
          const outsideKeys = extracted.candidates.filter((candidate) => !candidateIsInOutputScope(candidate, expected, bundle.manifest))
            .map((candidate) => candidate.localKey);
          const targetKeys = new Set([...failures.map((failure) => failure.localKey), ...outsideKeys]);
          // 仅由已存独立原句及其几何定位选区域；候选名称/数值不能反推新OCR。
          let localReadCode: string | null = null;
          if (!localRegionReadAttempted) {
            const knownSpans = new Map(bundle.manifest.spans.map((span) => [span.id, span]));
            const region = extracted.candidates.filter((candidate) => targetKeys.has(candidate.localKey)).flatMap((candidate) => (
              candidate.sourceBinding?.findingEvidence ?? candidate.evidence
            )).flatMap((reference) => {
              const span = knownSpans.get(reference.sourceSpanId);
              if (!span?.quote || !span.visualEvidence || !reference.quote || span.blockId?.startsWith('local-vision-region:')) return [];
              const index = span.quote.indexOf(reference.quote);
              if (index < 0 || span.quote.indexOf(reference.quote, index + 1) >= 0) return [];
              const lineStart = (span.lineStart ?? 1) + span.quote.slice(0, index).split('\n').length - 1;
              const lineEnd = lineStart + reference.quote.split('\n').length - 1;
              if (lineEnd - lineStart > 7 || !span.visualEvidence.rows.some((row) => row.line === lineStart)
                || !span.visualEvidence.rows.some((row) => row.line === lineEnd)) return [];
              return [{ span, lineStart, lineEnd }];
            })[0];
            if (region) {
              localRegionReadAttempted = true;
              const reread = await rereadStoredSourceRegion({ manifest: bundle.manifest, bytes: readFileSync(bundle.sourcePath),
                displayName: bundle.manifest.originalDisplayName, sourceSpanId: region.span.id,
                lineStart: region.lineStart, lineEnd: region.lineEnd, createdAt: bundle.manifest.createdAt });
              localReadCode = reread.diagnostic.code;
              if (reread.readSpanId) {
                this.store.appendLocalVisualEvidenceForReprocessing(reread.manifest,
                  this.executionGuard ? { executionGuard: this.executionGuard } : undefined);
                bundle = this.store.getDocumentExtractionBundle(documentId);
              }
            }
          }
          const targets: ExtractionRepairTarget[] = [
            ...[...targetKeys].map((key) => ({ nodeType: 'candidate' as const, targetId: key, localKey: key })),
            ...missing.map((id) => ({ nodeType: 'source_coverage' as const, targetId: `coverage:${id}`, sourceSpanId: id })),
            ...metadataTimeFailures.map((failure) => ({ nodeType: 'metadata_time' as const,
              targetId: `reportMetadata:times:${failure.index}`, index: failure.index }))
          ];
          const scope: ExtractionRepairScope = { documentId, originalCandidateHash: stableHash(extracted), targets,
            allowedSourceSpanIds: bundle.manifest.spans.map((span) => span.id), targetSourceSpanIds: [...expectedSpanIds,
              ...bundle.manifest.spans.filter((span) => span.blockId?.startsWith('local-vision-region:')
                && expected.has(span.blockId.slice('local-vision-region:'.length))).map((span) => span.id)] };
          const repairRequest = {
            ...scope,
            stage: 'extraction',
            // 允许查看完整报告上下文，但本轮只修正既定目标和已授权来源。
            // 普通内容疑点仅重读一次，不能用反复全量复核代替接纳规则。
            maxRepairAttempts: 1,
            allowedPaths: [
              ...[...targetKeys].map((key) => 'candidates:' + key),
              ...missing.map((id) => 'candidates:add-from:' + id),
              ...(missing.length > 0 ? ['coveredSourceSpanIds'] : []),
              ...metadataTimeFailures.map((failure) => `reportMetadata.times[${failure.index}]`)
            ],
            issues: [
              ...failures.flatMap((failure) => failure.reasons.map((reason) => failure.localKey + ':' + reason)),
              ...missing.map((id) => 'uncovered_source_span:' + id),
              ...outsideKeys.map((key) => `evidence_outside_chunk:${key}`),
              ...metadataTimeFailures.flatMap((failure) => failure.reasons.map((reason) => `reportMetadata:times:${failure.index}:${reason}`)),
              ...(extracted.subject.evidence.some((ref) => !scope.allowedSourceSpanIds.includes(ref.sourceSpanId)) ? ['subject_evidence_outside_document'] : []),
              ...(reportMetadataEvidence(extracted.reportMetadata).some((ref) => !scope.allowedSourceSpanIds.includes(ref.sourceSpanId)) ? ['metadata_evidence_outside_document'] : [])
            ]
          };
          const repairImagePaths = [...imagePaths];
          const repairImageMappings = [...imageMappings];
          if (isPdf) {
            // 文字层可读不代表表格行列正确。只有出现具体绑定问题时，在同一次
            // 局部修复里补原页图；完整文字上下文仍然保留，不另起分段提取。
            const repairSpanIds = new Set([
              ...extracted.candidates.filter((candidate) => targetKeys.has(candidate.localKey))
                .flatMap((candidate) => candidate.evidence.map((reference) => reference.sourceSpanId)),
              ...missing,
              ...(extracted.reportMetadata?.times ?? []).flatMap((time) => time.evidence.map((reference) => reference.sourceSpanId))
            ]);
            const attachedPages = new Set(repairImageMappings.map((mapping) => mapping.page));
            const repairPages = [...new Set(spans
              .filter((span) => repairSpanIds.has(span.id) && span.page !== null && !attachedPages.has(span.page))
              .map((span) => span.page!))].slice(0, Math.max(0, INGESTION_LIMITS.maxVisualPagesPerTurn - repairImagePaths.length));
            if (repairPages.length > 0) {
              temporaryRoot ??= mkdtempSync(join(tmpdir(), 'family-health-pdf-'));
              chmodSync(temporaryRoot, 0o700);
              const rendered = await renderPdfPagesToPngs({
                bytes: readFileSync(bundle.sourcePath),
                outputDirectory: join(temporaryRoot, chunkDirectory, 'repair'), pageNumbers: repairPages
              });
              for (const page of rendered) {
                repairImageMappings.push({ imageIndex: repairImagePaths.length, page: page.page,
                  sourceSpanIds: spans.filter((span) => span.page === page.page).map((span) => span.id) });
                repairImagePaths.push(page.path);
              }
            }
          }
          const repairSourcePackage = buildSourcePackage(bundle, spans, repairImageMappings);
          if (Buffer.byteLength(repairSourcePackage, 'utf8') > INGESTION_LIMITS.maxSourcePackageBytes) {
            throw new Error('WHOLE_DOCUMENT_CONTEXT_LIMIT_EXCEEDED');
          }
          const targetItems = targets.map((target) => ({ ...target,
            value: target.nodeType === 'candidate' ? extracted.candidates.find((candidate) => candidate.localKey === target.localKey)
              : target.nodeType === 'metadata_time' ? extracted.reportMetadata?.times[target.index]
                : { sourceSpanId: target.sourceSpanId } }));
          const repairedTurn = await this.runTurn(documentId, 'extraction_repair', {
            prompt: buildP03Prompt(repairRequest, JSON.parse(repairSourcePackage), targetItems),
            imagePaths: repairImagePaths, outputSchema: repairOutputSchema, allowWebSearch: false, timeoutMs: HEALTH_MODEL_TURN_TIMEOUT_MS
          });
          lastReceipt = { threadId: repairedTurn.threadId, turnId: repairedTurn.turnId };
          const repairedParsed = extractionRepairSchema.safeParse(repairedTurn.output);
          const assembled = repairedParsed.success ? assembleExtractionRepair(extracted, scope, repairedParsed.data) : null;
          let repairOutcome: 'schema_invalid' | 'scope_violation' | 'candidate_drift' | 'applied' | 'still_failed'
            = !repairedParsed.success ? 'schema_invalid' : assembled && !assembled.ok ? assembled.reason : 'scope_violation';
          if (assembled?.ok && subjectIsConsistent(assembled.result, bundle)
            && evidenceIsConfinedToChunk(assembled.result, expectedSpanIds, bundle.manifest)) {
            const changed = new Set(assembled.changedCandidateKeys);
            const replacements = new Map(assembled.result.candidates.filter((candidate) => changed.has(candidate.localKey)).map((candidate) => {
              const normalized = normalizeCandidates([candidate], bundle.manifest.spans,
                provenReportMetadata(assembled.result.reportMetadata, bundle.manifest.spans));
              // 一目标只替换一候选，规范化不得扩出新的未授权对象或改修复目标键。
              const keptKey = normalized.length === 1 ? { ...normalized[0]!, localKey: candidate.localKey } : candidate;
              const isExisting = extracted.candidates.some((old) => old.localKey === candidate.localKey);
              return [candidate.localKey, isExisting ? keptKey : scopeCandidateKeys([keptKey], chunkIndex)[0]!] as const;
            }));
            // 非目标候选不再因模型回填或后处理重新计算而发生漂移。
            const proposed = assembled.result.candidates.map((candidate) => replacements.get(candidate.localKey) ?? candidate);
            if (new Set(proposed.map((candidate) => candidate.localKey)).size === proposed.length) {
              extracted = { ...assembled.result, candidates: proposed };
              effectiveReceipt = { threadId: repairedTurn.threadId, turnId: repairedTurn.turnId };
              repairOutcome = 'applied';
            }
          }
          // 空栏只能由本机真实独立来源结清，模型无权删除候选。
          extracted = { ...extracted, candidates: extracted.candidates.filter((candidate) => !confirmedBlankOldCandidate(
            candidate, extracted.candidates, extracted.candidates.filter((other) => other.localKey !== candidate.localKey),
            extracted.coveredSourceSpanIds, bundle.manifest.spans
          )) };
          const postFailures = candidateValidationFailures(extracted, bundle);
          const rejectedKeys = new Set([...postFailures.map((failure) => failure.localKey),
            ...extracted.candidates.filter((candidate) => !candidateIsInOutputScope(candidate, expected, bundle.manifest)).map((candidate) => candidate.localKey)]);
          const remainingFailureCount = rejectedKeys.size
            + reportMetadataTimeFailures(extracted.reportMetadata, bundle.manifest.spans).length
            + expectedSpanIds.filter((id) => !extracted.coveredSourceSpanIds.includes(id)).length;
          if (repairOutcome === 'applied' && remainingFailureCount > 0) repairOutcome = 'still_failed';
          this.store.saveExtractionRepairDiagnostic?.({ documentId, chunkIndex,
            triggerCodes: [...new Set([...failures.flatMap((failure) => failure.reasons.map((reason) =>
              reason.startsWith('blocking_') ? 'candidate_blocking_issue' : reason)),
              ...(localReadCode ? [localReadCode] : []),
              ...metadataTimeFailures.flatMap((failure) => failure.reasons),
              ...(missing.length ? ['uncovered_source_span'] : []), ...(outsideKeys.length ? ['evidence_outside_output_scope'] : [])])],
            targetCandidateCount: targetKeys.size, missingSourceCount: missing.length, metadataTimeTargetCount: metadataTimeFailures.length,
            outcome: repairOutcome, remainingFailureCount, acceptedCount: extracted.candidates.length - rejectedKeys.size,
            ...(this.executionGuard ? { guard: this.executionGuard } : {}) });
        }
        lastReceipt = effectiveReceipt;
        if (!absorbChunk(extracted, expectedSpanIds)) {
          return this.needsReview(documentId, 'field_conflict', expectedSpanIds,
            'SUBJECT_EVIDENCE_OUTSIDE_CHUNK', lastReceipt.threadId, lastReceipt.turnId);
        }
        if (this.executionGuard) {
          this.store.saveExtractionChunkCheckpoint({
            guard: this.executionGuard, documentId, signature: checkpointSignature,
            chunkIndex, output: extracted,
            threadId: effectiveReceipt.threadId, turnId: effectiveReceipt.turnId,
            extractionTurnId
          });
        }
        if (temporaryRoot) rmSync(join(temporaryRoot, chunkDirectory), { recursive: true, force: true });
      }
    } finally {
      if (temporaryRoot) rmSync(temporaryRoot, { recursive: true, force: true });
    }
    if (!lastReceipt) throw new Error('EXTRACTION_RECEIPT_MISSING');
    const onlyExplicitBlankResults = unresolved.length === 0 && uncoveredSpanIds.length === 0
      && metadataUnresolvedReasons.length === 0
      && sourceOnlyHasExplicitBlankResults(bundle.manifest.spans.filter((span) => !span.blockId?.startsWith('local-vision-region:')));
    if (acceptedCandidates.length === 0 && !committedReviewIssue && !onlyExplicitBlankResults) {
      return this.needsReview(documentId, 'coverage_gap', uncoveredSpanIds.length ? uncoveredSpanIds : bundle.manifest.spans.map((span) => span.id),
        'NO_ACCEPTABLE_FACTS', lastReceipt.threadId, lastReceipt.turnId,
        unresolved.map((item) => item.candidate), undefined, undefined, {
          coverageComplete: uncoveredSpanIds.length === 0,
          coveredSourceSpanIds: [...new Set(coveredSourceSpanIds)],
          manifestSpanIds: bundle.manifest.spans.filter((span) => !span.blockId?.startsWith('local-vision-region:')).map((span) => span.id), chunkCount: chunks.length
        }, [...new Set([...unresolved.flatMap((item) => item.reasons), ...metadataUnresolvedReasons])]);
    }
    const reviewedMetadata = aggregateReportMetadata(metadata);
    // 每个 P01 已读取完整报告原文与适用元数据。各组输出通过边界检查后，
    // 再按已证实的整篇日期关系补齐局部遗漏，不用晚期综合猜缺失条件。
    // 日期继承区分检查/签发/历史用途；真正不同的检查日仍保留各自来源。
    const reviewedCandidates = inheritReportClinicalDate(
      acceptedCandidates,
      bundle.manifest.spans,
      reviewedMetadata
    );
    const reviewed: ExtractionResult = {
      schemaVersion: 1, documentId, subject: aggregateReviewedSubject(subjects),
      reportMetadata: reviewedMetadata,
      coveredSourceSpanIds: [...new Set(coveredSourceSpanIds)], candidates: reviewedCandidates
    };
    const reviewRef = 'lean-extract:' + stableHash(extractionTurnIds);
    const accepted: Array<ReturnType<typeof candidateToObservation>> = [];
    const acceptedPairs: Array<{ candidate: ObservationCandidate; observation: ReturnType<typeof candidateToObservation> }> = [];
    for (const candidate of reviewed.candidates) {
      const outcome = evaluateObservationCandidate(candidate, bundle.manifest, {
        personConsistent: reviewedSubjectsAreConsistent(subjects, bundle), overwritesUserLockedValue: false
      });
      if (outcome.decision !== 'accept' && outcome.decision !== 'accept_with_warnings') {
        unresolved.push({ candidate, reasons: outcome.reasons });
        continue;
      }
      const sourceBinding = resolveReportSourceBinding(candidate, bundle.manifest);
      if (sourceBinding.status !== 'resolved') {
        unresolved.push({ candidate, reasons: [`source_binding_${sourceBinding.reason}`] });
        continue;
      }
      const inputSignature = stableHash({ documentId, manifestSha256: bundle.manifest.sha256, candidate });
      const acceptanceId = this.store.saveAcceptanceDecision({
        method: 'auto', actor: 'policy', rulesVersion: ACCEPTANCE_RULES_VERSION,
        inputSignature, outputHash: stableHash({ candidate, outcome }), reviewRef, decision: outcome.decision
      });
      const observation = candidateToObservation(candidate, acceptanceId, documentId);
      accepted.push(observation);
      acceptedPairs.push({ candidate, observation });
    }
    if (accepted.length === 0 && !committedReviewIssue && !onlyExplicitBlankResults) {
      return this.needsReview(documentId, 'field_conflict', bundle.manifest.spans.map((span) => span.id),
        'NO_ACCEPTABLE_FACTS', lastReceipt.threadId, lastReceipt.turnId,
        unresolved.map((item) => item.candidate), undefined, undefined, {
          coverageComplete: uncoveredSpanIds.length === 0,
          coveredSourceSpanIds: [...new Set(coveredSourceSpanIds)],
          manifestSpanIds: bundle.manifest.spans.map((span) => span.id), chunkCount: chunks.length
        }, [...new Set([...unresolved.flatMap((item) => item.reasons), ...metadataUnresolvedReasons])]);
    }
    if (committedReviewIssue) {
      // 旧候选仅作为待核对线索：必须由本轮模型重新提取并通过本地规则，不能只靠改版后的规则补入。

      // 首次提取和重新读取使用同一套来源对账。栏目名、日期和模型临时键
      // 均不能直接决定正式记录身份；存储事务按可信具体来源隔离真冲突。
      const acceptedForResolution = acceptedPairs.map((pair) => pair.candidate);
      const oldGapIds = [...new Set([
        ...committedReviewIssue.reasonCodes
          .filter((reason) => reason.startsWith('UNCOVERED_SPAN:'))
          .map((reason) => reason.slice('UNCOVERED_SPAN:'.length)),
        ...(committedReviewIssue.kind === 'coverage_gap' ? committedReviewIssue.evidenceRefs : [])
      ])];
      const explicitlyBlankLine = (spanId: string): boolean => {
        const span = bundle.manifest.spans.find((item) => item.id === spanId);
        return span?.spanKind === 'line' && span.readability === 'clear'
          && /^[^:：;；\n]{2,50}[:：]\s*(?:空白|未填写|—|–|--)\s*$/u.test(span.quote?.trim() ?? '');
      };
      const unresolvedOldGapIds = oldGapIds.filter((spanId) => (
        !coveredSourceSpanIds.includes(spanId)
        || (!explicitlyBlankLine(spanId)
          && !acceptedForResolution.some((candidate) => candidate.evidence.some((reference) => reference.sourceSpanId === spanId)))
      ));
      const oldRemaining = committedReviewIssue.candidateOptions.filter((candidate) => (
        !sameReportFinding(candidate, acceptedForResolution, bundle.manifest,
          (previousId, currentId) => this.store.isSameSourceLocationInDocument(previousId, currentId))
        && !confirmedBlankOldCandidate(
          candidate, committedReviewIssue.candidateOptions, reviewed.candidates,
          coveredSourceSpanIds, bundle.manifest.spans
        )
      ));
      const candidateIdentity = (candidate: ObservationCandidate): string =>
        stableHash({ localKey: candidate.localKey, candidate });
      const remainingByKey = new Map(oldRemaining.map((candidate) => [candidateIdentity(candidate), candidate]));
      for (const { candidate } of unresolved) remainingByKey.set(candidateIdentity(candidate), candidate);
      const remainingCandidates = [...remainingByKey.values()];
      const remainingEvidenceRefs = [...new Set([
        ...unresolvedOldGapIds,
        ...uncoveredSpanIds,
        ...metadataUnresolvedSpanIds,
        ...remainingCandidates.flatMap((candidate) => candidate.evidence.map((reference) => reference.sourceSpanId))
      ])];
      const remainingReasonCodes = [...new Set([
        ...(oldRemaining.length > 0 ? ['PREVIOUS_CANDIDATE_NOT_VERIFIED'] : []),
        ...unresolvedOldGapIds.map((id) => `UNCOVERED_SPAN:${id}`),
        ...unresolved.flatMap((item) => item.reasons),
        ...uncoveredSpanIds.map((id) => `UNCOVERED_SPAN:${id}`),
        ...metadataUnresolvedReasons
      ])];
      const publication = this.store.appendCommittedFacts({
        personId: bundle.personId, documentId,
        expectedRevision: this.store.getFactRevision(bundle.personId),
        summary: '重新读取报告后按具体来源对账，保留已完成的可靠结果',
        observations: acceptedPairs.map((pair) => pair.observation),
        reportMetadata: reviewed.reportMetadata ?? null,
        reviewUpdate: {
          issueId: committedReviewIssue.id,
          remainingCandidates, remainingReasonCodes, remainingEvidenceRefs
        },
        ...(this.executionGuard ? { executionGuard: this.executionGuard } : {})
      });
      if (this.executionGuard) this.store.clearExtractionChunkCheckpoints(this.executionGuard, documentId);
      return publication.reviewResolved
        ? { status: 'published', documentId, revision: publication.revision,
          candidateCount: publication.appendedCount, threadId: lastReceipt.threadId, turnId: lastReceipt.turnId }
        : { status: 'partial', documentId, revision: publication.revision,
          candidateCount: publication.appendedCount, issueId: committedReviewIssue.id,
          reason: 'REPORT_CONTENT_HELD', requiresUser: false,
          threadId: lastReceipt.threadId, turnId: lastReceipt.turnId };
    }
    const publication = this.store.publishFacts({
      personId: bundle.personId, documentId,
      documentCommitKey: stableHash({
        documentId, sourceSha256: bundle.manifest.sha256,
        normalizerVersion: bundle.manifest.normalizerVersion,
        extractionSchemaVersion: reviewed.schemaVersion, rulesVersion: ACCEPTANCE_RULES_VERSION
      }),
      expectedRevision: this.store.getFactRevision(bundle.personId),
      changeSetHash: stableHash({ documentId, reviewed, rulesVersion: ACCEPTANCE_RULES_VERSION }),
      summary: onlyExplicitBlankResults && accepted.length === 0
        ? '原报告结果栏明确空白，保留原件，未生成健康事实'
        : '从 1 份资料接纳 ' + accepted.length + ' 条有来源事实',
      reportMetadata: reviewed.reportMetadata ?? null,
      observations: accepted,
      ...(unresolved.length > 0 || uncoveredSpanIds.length > 0 || metadataUnresolvedReasons.length > 0 ? {
        unresolvedReview: {
          kind: unresolved.length > 0 ? 'field_conflict' as const : 'coverage_gap' as const,
          evidenceRefs: [...new Set([
            ...uncoveredSpanIds,
            ...metadataUnresolvedSpanIds,
            ...unresolved.flatMap((item) => item.candidate.evidence.map((ref) => ref.sourceSpanId))
          ])],
          candidateOptions: unresolved.map((item) => item.candidate),
          reasonCodes: [...new Set([
            ...uncoveredSpanIds.map((id) => 'UNCOVERED_SPAN:' + id),
            ...unresolved.flatMap((item) => item.reasons), ...metadataUnresolvedReasons
          ])]
        }
      } : {}),
      ...(this.executionGuard ? { executionGuard: this.executionGuard } : {})
    });
    // 整份事实已提交后不再需要带原文的块级恢复记录；失败重试仍保留未提交块。
    if (this.executionGuard) this.store.clearExtractionChunkCheckpoints(this.executionGuard, documentId);
    return publication.reviewIssueId
      ? { status: 'partial', documentId, revision: publication.revision,
        candidateCount: accepted.length - publication.heldCount - publication.duplicateCount,
        issueId: publication.reviewIssueId, reason: 'REPORT_CONTENT_HELD', requiresUser: false,
        threadId: lastReceipt.threadId, turnId: lastReceipt.turnId }
      : { status: 'published', documentId, revision: publication.revision,
        candidateCount: accepted.length - publication.duplicateCount,
        threadId: lastReceipt.threadId, turnId: lastReceipt.turnId };
  }

  private needsReview(
    documentId: string,
    kind: 'person_conflict' | 'field_conflict' | 'coverage_gap',
    evidenceRefs: string[],
    reason: string,
    threadId?: string,
    turnId?: string,
    candidateOptions?: ObservationCandidate[],
    reportedName?: string,
    candidateDiffs?: ReviewCandidateDiff[],
    documentRun?: {
      coverageComplete: boolean;
      coveredSourceSpanIds: string[];
      manifestSpanIds: string[];
      chunkCount: number;
    },
    additionalReasonCodes: string[] = []
  ): ExtractionPipelineResult {
    if (this.store.isDocumentCommitted(documentId)) {
      if (kind === 'person_conflict' && reportedName) {
        const issueId = this.store.saveCommittedIdentityReviewIssue({
          documentId, reportedName, evidenceRefs, reasonCodes: [reason],
          ...(this.executionGuard ? { executionGuard: this.executionGuard } : {})
        });
        return { status: 'needs_review', documentId, issueId, reason, requiresUser: true,
          ...(threadId ? { threadId } : {}), ...(turnId ? { turnId } : {}) };
      }
      const existing = this.store.listOpenExtractionReviewIssues().find((issue) => (
        issue.documentId === documentId && issue.severity === 'warning' && issue.stage === 'extract'
      ));
      if (!existing) throw new Error('COMMITTED_DOCUMENT_REPAIR_ISSUE_REQUIRED');
      if (reason === 'PERSON_IDENTITY_NOT_CONFIRMED') {
        return { status: 'needs_review', documentId, issueId: existing.id, reason, requiresUser: true,
          ...(threadId ? { threadId } : {}), ...(turnId ? { turnId } : {}) };
      }
      const bundle = this.store.getDocumentExtractionBundle(documentId);
      const candidates = [...new Map([...existing.candidateOptions, ...(candidateOptions ?? [])]
        .map((candidate) => [stableHash({ ...candidate, localKey: '' }), candidate])).values()];
      const publication = this.store.appendCommittedFacts({
        personId: bundle.personId, documentId, expectedRevision: this.store.getFactRevision(bundle.personId),
        observations: [], summary: '保留原有可靠事实，本次内容疑点暂不纳入',
        reviewUpdate: { issueId: existing.id, remainingCandidates: candidates,
          remainingReasonCodes: [...new Set([...existing.reasonCodes, reason, ...additionalReasonCodes])],
          remainingEvidenceRefs: [...new Set([...existing.evidenceRefs, ...evidenceRefs])] },
        ...(this.executionGuard ? { executionGuard: this.executionGuard } : {})
      });
      return { status: 'partial', documentId, issueId: existing.id, reason, revision: publication.revision,
        candidateCount: 0, requiresUser: false, ...(threadId ? { threadId } : {}), ...(turnId ? { turnId } : {}) };
    }
    const issueId = this.store.saveExtractionReviewIssue({
      documentId,
      ...(this.executionGuard ? { jobId: this.executionGuard.jobId, attemptId: this.executionGuard.attemptId } : {}),
      stage: candidateDiffs ? 'review_facts' : 'extract',
      kind,
      severity: 'blocking',
      evidenceRefs,
      ...(candidateOptions ? { candidateOptions } : {}),
      ...(reportedName ? { reportedName } : {}),
      ...(candidateDiffs ? { candidateDiffs } : {}),
      ...(documentRun ? { documentRun } : {}),
      reasonCodes: [...new Set([reason, ...additionalReasonCodes])]
    });
    return {
      ...(kind === 'person_conflict' || reason === 'PERSON_IDENTITY_NOT_CONFIRMED'
        ? { status: 'needs_review' as const, requiresUser: true as const }
        : { status: 'partial' as const, candidateCount: 0, requiresUser: false as const }),
      documentId, issueId, reason,
      ...(threadId ? { threadId } : {}),
      ...(turnId ? { turnId } : {})
    };
  }
}
