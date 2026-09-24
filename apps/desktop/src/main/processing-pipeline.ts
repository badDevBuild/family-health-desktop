import { createHash } from 'node:crypto';
import { chmodSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import {
  extractionResultSchema,
  type ExtractionResult,
  type ObservationCandidate,
  type ReportMetadataCandidate,
  type ReviewCandidateDiff,
  type SourceManifest,
  type SourceSpan
} from '@contracts';
import { evaluateObservationCandidate, stableHash } from '@core';
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
  | { status: 'needs_review'; documentId: string; issueId: string; reason: string; threadId?: string; turnId?: string };

const outputSchema = z.toJSONSchema(extractionResultSchema, { target: 'draft-7' }) as Record<string, unknown>;
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
      return span?.quote && span.readability === 'clear' ? { ...reference, quote: span.quote } : reference;
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
  const matches: Array<{ date: string; index: number; length: number }> = [];
  const pattern = /(?<!\d)(\d{4})\s*(?:([-/.])\s*(\d{1,2})\s*\2\s*(\d{1,2})|年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日?)(?!\d)/g;
  for (const match of text.matchAll(pattern)) {
    const year = Number(match[1]);
    const month = Number(match[3] ?? match[5]);
    const day = Number(match[4] ?? match[6]);
    const parsed = new Date(Date.UTC(year, month - 1, day));
    if (parsed.getUTCFullYear() !== year || parsed.getUTCMonth() !== month - 1 || parsed.getUTCDate() !== day) continue;
    matches.push({
      date: `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
      index: match.index,
      length: match[0].length
    });
  }
  return matches;
}

function labelledCalendarDateMatches(text: string): Array<{ date: string; index: number; length: number }> {
  const matches: Array<{ date: string; index: number; length: number }> = [];
  const pattern = /(?:检查|检验|采样|采集|体检|就诊|临床|报告)\s*日期\s*[：:]?\s*((?<!\d)(\d{4})\s*(?:([-/.])\s*(\d{1,2})\s*\3\s*(\d{1,2})|年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日?)(?!\d))/g;
  for (const match of text.matchAll(pattern)) {
    const year = Number(match[2]);
    const month = Number(match[4] ?? match[6]);
    const day = Number(match[5] ?? match[7]);
    const parsed = new Date(Date.UTC(year, month - 1, day));
    if (parsed.getUTCFullYear() !== year || parsed.getUTCMonth() !== month - 1 || parsed.getUTCDate() !== day) continue;
    matches.push({
      date: `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
      index: match.index,
      length: match[0].length
    });
  }
  return matches;
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

function previousPageSummaryDateEvidence(
  candidate: ObservationCandidate,
  currentSpan: SourceSpan,
  citedQuote: string,
  clinicalDate: string,
  sourceSpans: SourceSpan[]
): ObservationCandidate['evidence'][number] | null {
  if (currentSpan.spanKind !== 'page' || currentSpan.page === null || !currentSpan.quote) return null;
  const currentQuoteIndex = currentSpan.quote.indexOf(citedQuote);
  if (currentQuoteIndex < 0 || currentQuoteIndex > 300) return null;

  // PDF 分页可能把一个科室小结切到下一页开头：上一页保留“甲状腺彩超 + 检查日期 +
  // 检查正文”，下一页只剩“小结 ...”。仅对明确以“小结”结尾的中文项目名、且小结
  // 位于下一页开头时，才允许从紧邻上一页补充日期证据，避免跨科室误绑定。
  const sectionName = candidate.originalName.normalize('NFKC').replace(/\s+/g, '').replace(/小结$/, '');
  if (sectionName === candidate.originalName.normalize('NFKC').replace(/\s+/g, '') || sectionName.length < 2) return null;

  const previousSpans = sourceSpans.filter((span) => (
    span.documentId === currentSpan.documentId
    && span.spanKind === 'page'
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
  const matchingDates = labelledCalendarDateMatches(previousQuote).filter((match) => (
    match.date === clinicalDate
    && match.index >= sectionOriginalIndex
    && match.index - sectionOriginalIndex <= 500
  ));
  if (matchingDates.length !== 1) return null;
  return {
    sourceSpanId: previousSpan.id,
    quote: previousQuote.slice(sectionOriginalIndex)
  };
}

function strengthenUnambiguousClinicalDateEvidence(
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
      const strengthenedQuote = contextualDateEvidenceQuote(span.quote, reference.quote, clinicalDate);
      if (strengthenedQuote) return [{ ...reference, quote: strengthenedQuote }];
      const previousPageEvidence = previousPageSummaryDateEvidence(
        candidate,
        span,
        reference.quote,
        clinicalDate,
        sourceSpans
      );
      return previousPageEvidence ? [reference, previousPageEvidence] : [reference];
    });
    const uniqueEvidence = [...new Map(evidence.map((reference) => (
      [`${reference.sourceSpanId}\u0000${reference.quote ?? ''}`, reference] as const
    ))).values()];
    return { ...candidate, evidence: uniqueEvidence };
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

function normalizeCandidates(candidates: ObservationCandidate[], sourceSpans: SourceSpan[]): ObservationCandidate[] {
  return strengthenUnambiguousClinicalDateEvidence(
    expandAbbreviatedEvidenceQuotes(normalizeBloodPressureCandidates(candidates
      .filter((candidate) => !(candidate.value.kind === 'unknown'
        && candidate.value.rawText === null
        && candidate.issues.length === 0
        && /空白|未填写|未填|空栏|未记录/.test(candidate.value.reason)))
      .map(normalizeModelEntities), sourceSpans), sourceSpans),
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
    return outcome.decision === 'accept' || outcome.decision === 'accept_with_warnings'
      ? []
      : [{ localKey: candidate.localKey, itemName: candidate.originalName, reasons: outcome.reasons }];
  });
}


function normalizedPersonName(value: string): string {
  return value.normalize('NFKC').replace(/[\s·•・·]/g, '').toLocaleLowerCase('zh-CN');
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
  const trustedAssignment = bundle.personAssignmentBasis === 'user_selected'
    || bundle.personAssignmentBasis === 'folder_binding'
    || bundle.personAssignmentBasis === 'identity_confirmed';
  // 没有姓名或只是模糊读取时，可以沿用用户明确归属。
  // 但模型已在图像来源上给出明确姓名时，即使没有本地文字层，
  // 也必须比较并把异名交给用户核对，不能把“无法文字验证”当成“没有冲突”。
  if (!subjectEvidenceIsValid(result, bundle) && !subjectEvidenceReferencesKnownSource(result, bundle)) return trustedAssignment;
  const expectedName = bundle.confirmedReportedName ?? bundle.personDisplayName;
  return normalizedPersonName(result.subject.reportedName!) === normalizedPersonName(expectedName);
}

function conflictingReportedName(
  result: ExtractionResult,
  bundle: ReturnType<WorkspaceStore['getDocumentExtractionBundle']>
): string | null {
  if ((!subjectEvidenceIsValid(result, bundle) && !subjectEvidenceReferencesKnownSource(result, bundle)) || !result.subject.reportedName) return null;
  const expectedName = bundle.confirmedReportedName ?? bundle.personDisplayName;
  return normalizedPersonName(result.subject.reportedName) === normalizedPersonName(expectedName)
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

function reviewedSubjectsAreConsistent(subjects: ExtractionResult['subject'][]): boolean {
  const names = new Set(subjects
    .filter((subject) => subject.confidence === 'explicit' && subject.reportedName)
    .map((subject) => normalizedPersonName(subject.reportedName!)));
  return names.size <= 1;
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


function evidenceIsConfinedToChunk(result: ExtractionResult, expectedSpanIds: string[]): boolean {
  const expected = new Set(expectedSpanIds);
  return result.subject.evidence.every((ref) => expected.has(ref.sourceSpanId))
    && result.candidates.every((candidate) => candidate.evidence.every((ref) => expected.has(ref.sourceSpanId)))
    && reportMetadataEvidence(result.reportMetadata).every((ref) => expected.has(ref.sourceSpanId));
}

function needsVisualEvidence(span: SourceSpan): boolean {
  return span.readability !== 'clear' || !span.quote;
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
    totalUnits: bundle.manifest.totalUnits,
    chunkUnitCount: spans.length,
    spans: spans.map((span) => ({
      sourceSpanId: span.id,
      page: span.page,
      blockId: span.blockId,
      lineStart: span.lineStart,
      lineEnd: span.lineEnd,
      quote: span.quote,
      readability: span.readability
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
  const firstEvidence = candidate.evidence.find((reference) => reference.sourceRole !== 'duplicate_source')
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
    evidence: candidate.evidence
  };
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
    let bundle = this.store.getDocumentExtractionBundle(documentId);
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
    // 在输入预算允许时保持整篇处理，以便模型联系摘要、检验页与结论页。
    // 只有视觉页数、片段数或字节预算触发硬限制时才保护性分块。
    const chunks = partitionSourceSpans(bundle.manifest.spans);
    const acceptedCandidates: ObservationCandidate[] = [];
    const coveredSourceSpanIds: string[] = [];
    const subjects: ExtractionResult['subject'][] = [];
    const metadata: Array<ReportMetadataCandidate | null | undefined> = [];
    const extractionTurnIds: string[] = [];
    const unresolved: Array<{ candidate: ObservationCandidate; reasons: string[] }> = [];
    const uncoveredSpanIds: string[] = [];
    let lastReceipt: { threadId: string; turnId: string } | null = null;
    let temporaryRoot: string | null = null;
    const absorbChunk = (extracted: ExtractionResult, expectedSpanIds: string[]): boolean => {
      const expected = new Set(expectedSpanIds);
      if (extracted.subject.evidence.some((ref) => !expected.has(ref.sourceSpanId))) return false;
      const failures = candidateValidationFailures(extracted, bundle);
      const missing = expectedSpanIds.filter((id) => !extracted.coveredSourceSpanIds.includes(id));
      const outOfChunk = extracted.candidates.filter((candidate) => candidate.evidence.some((ref) => !expected.has(ref.sourceSpanId)));
      const failedKeys = new Set([...failures.map((failure) => failure.localKey), ...outOfChunk.map((candidate) => candidate.localKey)]);
      acceptedCandidates.push(...extracted.candidates.filter((candidate) => !failedKeys.has(candidate.localKey)));
      for (const failure of failures) {
        const candidate = extracted.candidates.find((item) => item.localKey === failure.localKey);
        if (candidate) unresolved.push({ candidate, reasons: failure.reasons });
      }
      unresolved.push(...outOfChunk.map((candidate) => ({ candidate, reasons: ['EVIDENCE_OUTSIDE_CHUNK'] })));
      uncoveredSpanIds.push(...missing);
      coveredSourceSpanIds.push(...extracted.coveredSourceSpanIds.filter((id) => expected.has(id)));
      subjects.push(extracted.subject);
      metadata.push(reportMetadataEvidence(extracted.reportMetadata).every((ref) => expected.has(ref.sourceSpanId))
        ? extracted.reportMetadata : null);
      return true;
    };
    try {
      for (const [chunkIndex, spans] of chunks.entries()) {
        const expectedSpanIds = spans.map((span) => span.id);
        const checkpointSignature = stableHash({
          documentId, sourceSha256: bundle.manifest.sha256,
          normalizerVersion: bundle.manifest.normalizerVersion,
          promptVersion: EXTRACTION_PROMPT_VERSION,
          rulesVersion: ACCEPTANCE_RULES_VERSION,
          chunkIndex,
          spans: spans.map((span) => ({ id: span.id, quote: span.quote, readability: span.readability }))
        });
        const checkpoint = this.executionGuard
          ? this.store.getExtractionChunkCheckpoint(this.executionGuard, documentId, checkpointSignature)
          : null;
        if (checkpoint) {
          const parsedCheckpoint = extractionResultSchema.safeParse(checkpoint.output);
          if (!parsedCheckpoint.success || parsedCheckpoint.data.documentId !== documentId
            || !subjectIsConsistent(parsedCheckpoint.data, bundle)
            || !evidenceIsConfinedToChunk(parsedCheckpoint.data, expectedSpanIds)
            || !absorbChunk(parsedCheckpoint.data, expectedSpanIds)) {
            throw new Error('EXTRACTION_CHUNK_CHECKPOINT_INVALID');
          }
          lastReceipt = { threadId: checkpoint.threadId, turnId: checkpoint.turnId };
          extractionTurnIds.push(checkpoint.extractionTurnId);
          continue;
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
        const generated = await this.runTurn(documentId, 'extract', {
          prompt: buildP01Prompt({
            personId: bundle.personId, displayName: bundle.personDisplayName,
            note: '显示名只用于归属核对，不能作为报告身份来源。'
          }, JSON.parse(sourcePackage)),
          imagePaths, outputSchema, allowWebSearch: false, timeoutMs: HEALTH_MODEL_TURN_TIMEOUT_MS
        });
        lastReceipt = { threadId: generated.threadId, turnId: generated.turnId };
        let effectiveReceipt = lastReceipt;
        extractionTurnIds.push(generated.turnId);
        const parsed = extractionResultSchema.safeParse(generated.output);
        if (!parsed.success || parsed.data.documentId !== documentId) {
          return this.needsReview(documentId, 'field_conflict', expectedSpanIds, 'EXTRACTION_SCHEMA_INVALID',
            generated.threadId, generated.turnId);
        }
        let extracted: ExtractionResult = {
          ...parsed.data,
          candidates: scopeCandidateKeys(normalizeCandidates(parsed.data.candidates, spans), chunkIndex)
        };
        if (!subjectIsConsistent(extracted, bundle)) {
          const reportedName = conflictingReportedName(extracted, bundle);
          return this.needsReview(documentId, reportedName ? 'person_conflict' : 'field_conflict',
            extracted.subject.evidence.map((item) => item.sourceSpanId), 'PERSON_IDENTITY_NOT_CONFIRMED',
            generated.threadId, generated.turnId, undefined, reportedName ?? undefined);
        }
        const missing = expectedSpanIds.filter((id) => !extracted.coveredSourceSpanIds.includes(id));
        const failures = candidateValidationFailures(extracted, bundle);
        if (missing.length > 0 || failures.length > 0 || !evidenceIsConfinedToChunk(extracted, expectedSpanIds)) {
          const expected = new Set(expectedSpanIds);
          const outsideKeys = extracted.candidates.filter((candidate) => candidate.evidence.some((ref) => !expected.has(ref.sourceSpanId)))
            .map((candidate) => candidate.localKey);
          const targetKeys = new Set([...failures.map((failure) => failure.localKey), ...outsideKeys]);
          const repairRequest = {
            stage: 'extraction',
            targets: [...targetKeys, ...missing],
            allowedPaths: [
              ...[...targetKeys].map((key) => 'candidates:' + key),
              ...missing.map((id) => 'candidates:add-from:' + id),
              ...(missing.length > 0 ? ['coveredSourceSpanIds'] : [])
            ],
            issues: [
              ...failures.flatMap((failure) => failure.reasons.map((reason) => failure.localKey + ':' + reason)),
              ...missing.map((id) => 'uncovered_source_span:' + id),
              ...outsideKeys.map((key) => `evidence_outside_chunk:${key}`),
              ...(extracted.subject.evidence.some((ref) => !expected.has(ref.sourceSpanId)) ? ['subject_evidence_outside_chunk'] : []),
              ...(reportMetadataEvidence(extracted.reportMetadata).some((ref) => !expected.has(ref.sourceSpanId)) ? ['metadata_evidence_outside_chunk'] : [])
            ],
            originalCandidateHash: stableHash(extracted)
          };
          const repairedTurn = await this.runTurn(documentId, 'extraction_repair', {
            prompt: buildP03Prompt(repairRequest, JSON.parse(sourcePackage), extracted),
            imagePaths, outputSchema, allowWebSearch: false, timeoutMs: HEALTH_MODEL_TURN_TIMEOUT_MS
          });
          lastReceipt = { threadId: repairedTurn.threadId, turnId: repairedTurn.turnId };
          const repairedParsed = extractionResultSchema.safeParse(repairedTurn.output);
          if (repairedParsed.success && repairedParsed.data.documentId === documentId
            && subjectIsConsistent(repairedParsed.data, bundle)
            && evidenceIsConfinedToChunk(repairedParsed.data, expectedSpanIds)) {
            const repaired: ExtractionResult = {
              ...repairedParsed.data,
              candidates: scopeCandidateKeys(normalizeCandidates(repairedParsed.data.candidates, spans), chunkIndex)
            };
            const oldByKey = new Map(extracted.candidates.map((candidate) => [candidate.localKey, candidate]));
            const newByKey = new Map(repaired.candidates.map((candidate) => [candidate.localKey, candidate]));
            const preserved = stableHash(extracted.subject) === stableHash(repaired.subject)
              && stableHash(extracted.reportMetadata ?? null) === stableHash(repaired.reportMetadata ?? null)
              && oldByKey.size === extracted.candidates.length
              && newByKey.size === repaired.candidates.length
              && [...oldByKey].every(([key, candidate]) => {
                const next = newByKey.get(key);
                return next && (targetKeys.has(key) || stableHash(candidate) === stableHash(next));
              })
              && [...newByKey].every(([key, candidate]) => oldByKey.has(key)
                || missing.some((id) => candidate.evidence.some((ref) => ref.sourceSpanId === id)));
            if (preserved) {
              extracted = repaired;
              effectiveReceipt = { threadId: repairedTurn.threadId, turnId: repairedTurn.turnId };
            }
          }
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
            extractionTurnId: generated.turnId
          });
        }
        if (temporaryRoot) rmSync(join(temporaryRoot, chunkDirectory), { recursive: true, force: true });
      }
    } finally {
      if (temporaryRoot) rmSync(temporaryRoot, { recursive: true, force: true });
    }
    if (!lastReceipt) throw new Error('EXTRACTION_RECEIPT_MISSING');
    if (acceptedCandidates.length === 0) {
      return this.needsReview(documentId, 'coverage_gap', uncoveredSpanIds.length ? uncoveredSpanIds : bundle.manifest.spans.map((span) => span.id),
        'NO_ACCEPTABLE_FACTS', lastReceipt.threadId, lastReceipt.turnId,
        unresolved.map((item) => item.candidate));
    }
    const reviewed: ExtractionResult = {
      schemaVersion: 1, documentId, subject: aggregateReviewedSubject(subjects),
      reportMetadata: aggregateReportMetadata(metadata),
      coveredSourceSpanIds: [...new Set(coveredSourceSpanIds)], candidates: acceptedCandidates
    };
    const reviewRef = 'lean-extract:' + stableHash(extractionTurnIds);
    const accepted: Array<ReturnType<typeof candidateToObservation>> = [];
    for (const candidate of reviewed.candidates) {
      const outcome = evaluateObservationCandidate(candidate, bundle.manifest, {
        personConsistent: reviewedSubjectsAreConsistent(subjects), overwritesUserLockedValue: false
      });
      if (outcome.decision !== 'accept' && outcome.decision !== 'accept_with_warnings') {
        unresolved.push({ candidate, reasons: outcome.reasons });
        continue;
      }
      const inputSignature = stableHash({ documentId, manifestSha256: bundle.manifest.sha256, candidate });
      const acceptanceId = this.store.saveAcceptanceDecision({
        method: 'auto', actor: 'policy', rulesVersion: ACCEPTANCE_RULES_VERSION,
        inputSignature, outputHash: stableHash({ candidate, outcome }), reviewRef, decision: outcome.decision
      });
      accepted.push(candidateToObservation(candidate, acceptanceId, documentId));
    }
    if (accepted.length === 0) {
      return this.needsReview(documentId, 'field_conflict', bundle.manifest.spans.map((span) => span.id),
        'NO_ACCEPTABLE_FACTS', lastReceipt.threadId, lastReceipt.turnId,
        unresolved.map((item) => item.candidate));
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
      summary: '从 1 份资料接纳 ' + accepted.length + ' 条有来源事实',
      reportMetadata: reviewed.reportMetadata ?? null,
      observations: accepted,
      ...(this.executionGuard ? { executionGuard: this.executionGuard } : {})
    });
    if (unresolved.length > 0 || uncoveredSpanIds.length > 0) {
      this.store.saveExtractionReviewIssue({
        documentId,
        ...(this.executionGuard ? { jobId: this.executionGuard.jobId, attemptId: this.executionGuard.attemptId } : {}),
        stage: 'extract', kind: unresolved.length > 0 ? 'field_conflict' : 'coverage_gap',
        severity: 'warning', preserveDocumentStatus: true,
        evidenceRefs: [...new Set([
          ...uncoveredSpanIds,
          ...unresolved.flatMap((item) => item.candidate.evidence.map((ref) => ref.sourceSpanId))
        ])],
        candidateOptions: unresolved.map((item) => item.candidate),
        reasonCodes: [...new Set([
          ...uncoveredSpanIds.map((id) => 'UNCOVERED_SPAN:' + id),
          ...unresolved.flatMap((item) => item.reasons)
        ])]
      });
    }
    // 整份事实已提交后不再需要带原文的块级恢复记录；失败重试仍保留未提交块。
    if (this.executionGuard) this.store.clearExtractionChunkCheckpoints(this.executionGuard, documentId);
    return { status: 'published', documentId, revision: publication.revision, candidateCount: accepted.length,
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
    }
  ): ExtractionPipelineResult {
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
      reasonCodes: [reason]
    });
    return {
      status: 'needs_review', documentId, issueId, reason,
      ...(threadId ? { threadId } : {}),
      ...(turnId ? { turnId } : {})
    };
  }
}
