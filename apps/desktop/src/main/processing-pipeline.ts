import { createHash } from 'node:crypto';
import { chmodSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import {
  extractionResultSchema,
  type ExtractionResult,
  type ObservationCandidate,
  type ReviewCandidateDiff,
  type SourceManifest,
  type SourceSpan
} from '@contracts';
import { evaluateObservationCandidate, stableHash } from '@core';
import { buildPdfManifest, INGESTION_LIMITS, renderDocxImagesToFiles, renderHeicImagesToPngs, renderPdfPagesToPngs } from '@ingestion';
import type { JobExecutionGuard, WorkspaceStore } from '@storage';

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

  const nearestPrecedingDate = labelledCalendarDateMatches(spanQuote)
    .filter((match) => match.index + match.length <= quoteIndex)
    .sort((left, right) => right.index - left.index)[0];
  if (!nearestPrecedingDate || nearestPrecedingDate.date !== clinicalDate) return null;
  if (quoteIndex - (nearestPrecedingDate.index + nearestPrecedingDate.length) > 2_000) return null;
  return spanQuote.slice(nearestPrecedingDate.index, quoteIndex + citedQuote.length);
}

function strengthenUnambiguousClinicalDateEvidence(
  candidates: ObservationCandidate[],
  sourceSpans: SourceSpan[]
): ObservationCandidate[] {
  const spansById = new Map(sourceSpans.map((span) => [span.id, span]));
  return candidates.map((candidate) => {
    const clinicalDate = candidate.clinicalDate;
    if (!clinicalDate) return candidate;
    const evidence = candidate.evidence.map((reference) => {
      if (reference.quote && calendarDateMatches(reference.quote).some((match) => match.date === clinicalDate)) {
        return reference;
      }
      const span = spansById.get(reference.sourceSpanId);
      if (!span?.quote || span.readability !== 'clear' || !reference.quote) return reference;
      const strengthenedQuote = contextualDateEvidenceQuote(span.quote, reference.quote, clinicalDate);
      return strengthenedQuote ? { ...reference, quote: strengthenedQuote } : reference;
    });
    return { ...candidate, evidence };
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
    expandAbbreviatedEvidenceQuotes(normalizeBloodPressureCandidates(candidates.map(normalizeModelEntities), sourceSpans), sourceSpans),
    sourceSpans
  );
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
  const normalized = normalizedComparableText(value)!;
  if (/(?:彩超|超声|b\s*超|ultrasound|sonograph|doppler)/i.test(normalized)) return 'ultrasound';
  return normalized;
}

function isOptionalNormalSummary(candidate: ObservationCandidate): boolean {
  const name = normalizedComparableText(candidate.originalName) ?? '';
  if (!/(?:小结|总结|结论|印象|summary|impression)$/.test(name)) return false;
  if (candidate.reportedAbnormalFlag !== null
    && !/^(?:正常|未见异常|无异常|normal|no abnormality)$/.test(normalizedComparableText(candidate.reportedAbnormalFlag) ?? '')) {
    return false;
  }
  if (candidate.value.kind !== 'qualitative' && candidate.value.kind !== 'text') return false;
  return /^(?:未见异常|无异常|正常|no abnormality detected|normal)$/.test(
    normalizedComparableText(candidate.value.rawText) ?? ''
  );
}

function isOptionalEmptyUnknown(candidate: ObservationCandidate): boolean {
  return candidate.value.kind === 'unknown'
    && !(candidate.value.rawText ?? '').trim()
    && candidate.reportedAbnormalFlag === null
    && !candidate.issues.some((issue) => issue.code.startsWith('blocking_'));
}

function isOmittableOneSidedCandidate(candidate: ObservationCandidate): boolean {
  return isOptionalNormalSummary(candidate) || isOptionalEmptyUnknown(candidate);
}

function omitOmittableOneSidedCandidates(
  first: ExtractionResult,
  second: ExtractionResult
): { first: ExtractionResult; second: ExtractionResult } {
  const firstNames = new Set(first.candidates.map((candidate) => normalizedComparableText(candidate.originalName)));
  const secondNames = new Set(second.candidates.map((candidate) => normalizedComparableText(candidate.originalName)));
  return {
    first: {
      ...first,
      candidates: first.candidates.filter((candidate) => (
        !isOmittableOneSidedCandidate(candidate) || secondNames.has(normalizedComparableText(candidate.originalName))
      ))
    },
    second: {
      ...second,
      candidates: second.candidates.filter((candidate) => (
        !isOmittableOneSidedCandidate(candidate) || firstNames.has(normalizedComparableText(candidate.originalName))
      ))
    }
  };
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
    rawText: normalizedComparableText(candidate.value.rawText),
    reason: normalizedComparableText(candidate.value.reason)
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
  compareText('standardNameCandidate', first.standardNameCandidate, second.standardNameCandidate);
  if (candidateValuesConflict(first, second)) fields.push('value');
  compareText('unitRaw', first.unitRaw, second.unitRaw);
  compareText('referenceRangeRaw', first.referenceRangeRaw, second.referenceRangeRaw);
  compareText('reportedAbnormalFlag', first.reportedAbnormalFlag, second.reportedAbnormalFlag);
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
  return normalizedComparableText(value)!.replace(/实质$/u, '');
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

function hasCompleteCoverage(result: ExtractionResult, expectedSpanIds: string[]): boolean {
  const covered = new Set(result.coveredSourceSpanIds);
  return covered.size === result.coveredSourceSpanIds.length
    && covered.size === expectedSpanIds.length
    && expectedSpanIds.every((id) => covered.has(id));
}

function evidenceIsConfinedToChunk(result: ExtractionResult, expectedSpanIds: string[]): boolean {
  const expected = new Set(expectedSpanIds);
  return result.subject.evidence.every((ref) => expected.has(ref.sourceSpanId))
    && result.candidates.every((candidate) => candidate.evidence.every((ref) => expected.has(ref.sourceSpanId)));
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
  const firstEvidence = candidate.evidence[0];
  if (!firstEvidence) throw new Error('CANDIDATE_EVIDENCE_REQUIRED');
  const decimalValue = candidate.value.kind === 'numeric' ? candidate.value.decimal : null;
  const qualifier = candidate.value.kind === 'numeric'
    ? candidate.value.comparator
    : candidate.value.kind === 'qualitative' ? candidate.value.category : null;
  return {
    conceptKey: candidate.standardNameCandidate ?? candidate.originalName,
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

  private async recoverIncompleteCoverage(input: {
    documentId: string;
    stage: 'extract' | 'review_facts';
    sourcePackage: string;
    imagePaths: string[];
    expectedSpanIds: string[];
    previousResult: ExtractionResult;
    candidateToReview?: ExtractionResult;
  }): Promise<{ result: ExtractionResult; threadId: string; turnId: string }> {
    const covered = new Set(input.previousResult.coveredSourceSpanIds);
    const missingSpanIds = input.expectedSpanIds.filter((id) => !covered.has(id));
    const turn = await this.runTurn(input.documentId, input.stage, {
      prompt: [
        input.stage === 'extract'
          ? '你是健康报告事实提取器。请重新通读这份完整来源包，只提取来源明确支持的事实。'
          : '你是独立事实复核器。请重新通读这份完整来源包，独立返回核实后的完整候选集合。',
        '上一次返回的 coveredSourceSpanIds 不完整。这是覆盖清单补救，不是只检查缺失片段；必须重新结合整篇上下文处理。',
        '只引用 SOURCE_PACKAGE 中的 sourceSpanId，不诊断、不推测、不提供处方。',
        'coveredSourceSpanIds 必须逐一包含 REQUIRED_SOURCE_SPAN_IDS 中的每一个 ID，即使某片段没有可提取指标也不能省略。',
        'imageInputs 的 imageIndex 与随请求附带的图片顺序一一对应。',
        `REQUIRED_SOURCE_SPAN_IDS=${JSON.stringify(input.expectedSpanIds)}`,
        `PREVIOUSLY_MISSING_SOURCE_SPAN_IDS=${JSON.stringify(missingSpanIds)}`,
        `PREVIOUS_RESULT=${JSON.stringify(input.previousResult)}`,
        ...(input.candidateToReview ? [`CANDIDATE_TO_REVIEW=${JSON.stringify(input.candidateToReview)}`] : []),
        `SOURCE_PACKAGE=${input.sourcePackage}`
      ].join('\n'),
      imagePaths: input.imagePaths,
      outputSchema,
      allowWebSearch: false,
      timeoutMs: 600_000
    });
    return {
      result: extractionResultSchema.parse(turn.output),
      threadId: turn.threadId,
      turnId: turn.turnId
    };
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
    const reviewedCandidates: ObservationCandidate[] = [];
    const coveredSourceSpanIds: string[] = [];
    const reviewReceipts: Array<{ extractTurnId: string; reviewTurnId: string }> = [];
    const reviewedSubjects: ExtractionResult['subject'][] = [];
    const pendingCandidateDiffs: ReviewCandidateDiff[] = [];
    let lastReceipt: { threadId: string; turnId: string } | null = null;
    let temporaryRoot: string | null = null;
    try {
      for (const [chunkIndex, spans] of chunks.entries()) {
        const imagePaths: string[] = [];
        const imageMappings: ImageMapping[] = [];
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
            outputDirectory: join(temporaryRoot, `chunk-${chunkIndex + 1}`),
            imageIndexes: spans.map((span) => span.page!)
          });
          for (const [imageIndex, image] of rendered.entries()) {
            imagePaths.push(image.path);
            imageMappings.push({
              imageIndex,
              page: image.imageIndex,
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
              outputDirectory: join(temporaryRoot, `chunk-${chunkIndex + 1}`),
              pageNumbers: visualPages
            });
            for (const [imageIndex, page] of rendered.entries()) {
              imagePaths.push(page.path);
              imageMappings.push({
                imageIndex,
                page: page.page,
                sourceSpanIds: visualSpans.filter((span) => span.page === page.page).map((span) => span.id)
              });
            }
          }
        } else if (isDocx) {
          const visualSpans = spans.filter((span) => span.spanKind === 'image');
          const indexedSpans = visualSpans.map((span) => {
            const matched = /^image-(\d+)$/.exec(span.blockId ?? '');
            if (!matched) return null;
            return { span, imageIndex: Number(matched[1]) };
          });
          if (indexedSpans.some((entry) => entry === null)) {
            return this.needsReview(documentId, 'coverage_gap', visualSpans.map((span) => span.id), 'DOCX_IMAGE_LOCATOR_MISSING');
          }
          if (indexedSpans.length > 0) {
            temporaryRoot ??= mkdtempSync(join(tmpdir(), 'family-health-docx-'));
            chmodSync(temporaryRoot, 0o700);
            const rendered = await renderDocxImagesToFiles({
              bytes: readFileSync(bundle.sourcePath),
              outputDirectory: join(temporaryRoot, `chunk-${chunkIndex + 1}`),
              imageIndexes: indexedSpans.map((entry) => entry!.imageIndex)
            });
            for (const [imageIndex, image] of rendered.entries()) {
              imagePaths.push(image.path);
              imageMappings.push({
                imageIndex,
                page: null,
                sourceSpanIds: indexedSpans.filter((entry) => entry!.imageIndex === image.imageIndex).map((entry) => entry!.span.id)
              });
            }
          }
        }
        const sourcePackage = buildSourcePackage(bundle, spans, imageMappings);
        if (Buffer.byteLength(sourcePackage, 'utf8') > INGESTION_LIMITS.maxSourcePackageBytes) {
          throw new Error('SOURCE_PACKAGE_LIMIT_EXCEEDED');
        }
        const expectedSpanIds = spans.map((span) => span.id);
        let extract = await this.runTurn(documentId, 'extract', {
          prompt: [
            '你是健康报告事实提取器。只提取来源中明确出现的事实，不诊断、不推测、不提供处方。',
            `目标成员显示名为“${bundle.personDisplayName}”。必须单独返回 subject：报告明示姓名时逐字引用证据；未找到时标记 absent；不得根据目标成员反推姓名。`,
            '每个候选必须只引用本块 sourceSpanId；看不清时使用 unknown，不得编造值、单位、日期或成员身份。',
            'imageInputs 的 imageIndex 与随请求附带的图片顺序一一对应；图片来自原报告、PDF 对应页渲染或 DOCX 嵌入图，不是额外来源。',
            'coveredSourceSpanIds 必须逐一列出你实际检查过的本块全部来源片段，即使某片段没有可提取指标也不能省略。',
            `SOURCE_PACKAGE=${sourcePackage}`
          ].join('\n'),
          imagePaths,
          outputSchema,
          timeoutMs: 600_000
        });
        let extracted = extractionResultSchema.parse(extract.output);
        if (extracted.documentId !== documentId) throw new Error('EXTRACTION_DOCUMENT_MISMATCH');
        if (!hasCompleteCoverage(extracted, expectedSpanIds) && evidenceIsConfinedToChunk(extracted, expectedSpanIds)) {
          const recovered = await this.recoverIncompleteCoverage({
            documentId,
            stage: 'extract',
            sourcePackage,
            imagePaths,
            expectedSpanIds,
            previousResult: extracted
          });
          extracted = recovered.result;
          extract = { ...extract, threadId: recovered.threadId, turnId: recovered.turnId, output: recovered.result };
          if (extracted.documentId !== documentId) throw new Error('EXTRACTION_DOCUMENT_MISMATCH');
        }
        if (!hasCompleteCoverage(extracted, expectedSpanIds) || !evidenceIsConfinedToChunk(extracted, expectedSpanIds)) {
          return this.needsReview(documentId, 'coverage_gap', expectedSpanIds, 'EXTRACTION_COVERAGE_INCOMPLETE', extract.threadId, extract.turnId);
        }
        if (!subjectIsConsistent(extracted, bundle)) {
          const reportedName = conflictingReportedName(extracted, bundle);
          return this.needsReview(
            documentId,
            reportedName ? 'person_conflict' : 'field_conflict',
            extracted.subject.evidence.map((item) => item.sourceSpanId),
            'PERSON_IDENTITY_NOT_CONFIRMED',
            extract.threadId,
            extract.turnId,
            undefined,
            reportedName ?? undefined
          );
        }
        const normalizedExtracted: ExtractionResult = {
          ...extracted,
          candidates: normalizeCandidates(extracted.candidates, spans)
        };

        let review = await this.runTurn(documentId, 'review_facts', {
          prompt: [
            '你是独立事实复核器。重新阅读本块原始来源，并返回你核实后的完整候选集合。',
            '只保留来源明确支持且引用本块有效 sourceSpanId 的事实；不得因为前一份候选存在就默认接受。',
            'imageInputs 的 imageIndex 与随请求附带的图片顺序一一对应。',
            'coveredSourceSpanIds 必须逐一列出你实际检查过的本块全部来源片段。',
            `SOURCE_PACKAGE=${sourcePackage}`,
            `CANDIDATE_TO_REVIEW=${JSON.stringify(normalizedExtracted)}`
          ].join('\n'),
          imagePaths,
          outputSchema,
          timeoutMs: 600_000
        });
        let reviewed = extractionResultSchema.parse(review.output);
        lastReceipt = { threadId: review.threadId, turnId: review.turnId };
        if (reviewed.documentId !== documentId) throw new Error('REVIEW_DOCUMENT_MISMATCH');
        if (!hasCompleteCoverage(reviewed, expectedSpanIds) && evidenceIsConfinedToChunk(reviewed, expectedSpanIds)) {
          const recovered = await this.recoverIncompleteCoverage({
            documentId,
            stage: 'review_facts',
            sourcePackage,
            imagePaths,
            expectedSpanIds,
            previousResult: reviewed,
            candidateToReview: normalizedExtracted
          });
          reviewed = recovered.result;
          review = { ...review, threadId: recovered.threadId, turnId: recovered.turnId, output: recovered.result };
          lastReceipt = { threadId: recovered.threadId, turnId: recovered.turnId };
          if (reviewed.documentId !== documentId) throw new Error('REVIEW_DOCUMENT_MISMATCH');
        }
        if (!hasCompleteCoverage(reviewed, expectedSpanIds) || !evidenceIsConfinedToChunk(reviewed, expectedSpanIds)) {
          return this.needsReview(documentId, 'coverage_gap', expectedSpanIds, 'REVIEW_COVERAGE_INCOMPLETE', review.threadId, review.turnId);
        }
        if (!subjectIsConsistent(reviewed, bundle)) {
          const reportedName = conflictingReportedName(reviewed, bundle);
          return this.needsReview(
            documentId,
            reportedName ? 'person_conflict' : 'field_conflict',
            reviewed.subject.evidence.map((item) => item.sourceSpanId),
            'PERSON_IDENTITY_NOT_CONFIRMED',
            review.threadId,
            review.turnId,
            undefined,
            reportedName ?? undefined
          );
        }
        const normalizedReviewed: ExtractionResult = {
          ...reviewed,
          candidates: normalizeCandidates(reviewed.candidates, spans)
        };
        const aligned = omitOmittableOneSidedCandidates(normalizedExtracted, normalizedReviewed);
        const comparison = compareIndependentExtractions(aligned.first, aligned.second);
        if (!comparison.compatible) {
          const reviewedKeys = new Set(aligned.second.candidates.map((candidate) => candidate.localKey));
          const missingCandidates = aligned.first.candidates.filter((candidate) => (
            !reviewedKeys.has(candidate.localKey)
            && comparison.differences.some((difference) => difference.localKey === candidate.localKey && difference.fields.includes('presence'))
          ));
          const reviewCandidates = [...aligned.second.candidates, ...missingCandidates];
          // 先完整读完后续块，再一次性交给用户核对。这样人工修正的是
          // 整份报告的完整候选集，不会把中间一块误当成整篇并提前提交。
          reviewedCandidates.push(...(reviewCandidates.length > 0 ? reviewCandidates : aligned.first.candidates));
          pendingCandidateDiffs.push(...comparison.differences);
          reviewedSubjects.push(aligned.second.subject);
          coveredSourceSpanIds.push(...aligned.second.coveredSourceSpanIds);
          reviewReceipts.push({ extractTurnId: extract.turnId, reviewTurnId: review.turnId });
          if (temporaryRoot) rmSync(join(temporaryRoot, `chunk-${chunkIndex + 1}`), { recursive: true, force: true });
          continue;
        }
        reviewedCandidates.push(...aligned.second.candidates);
        reviewedSubjects.push(aligned.second.subject);
        coveredSourceSpanIds.push(...aligned.second.coveredSourceSpanIds);
        reviewReceipts.push({ extractTurnId: extract.turnId, reviewTurnId: review.turnId });
        if (temporaryRoot) rmSync(join(temporaryRoot, `chunk-${chunkIndex + 1}`), { recursive: true, force: true });
      }
    } finally {
      if (temporaryRoot) rmSync(temporaryRoot, { recursive: true, force: true });
    }
    if (!lastReceipt) throw new Error('EXTRACTION_RECEIPT_MISSING');
    if (reviewedCandidates.length === 0) {
      return this.needsReview(documentId, 'coverage_gap', coveredSourceSpanIds, 'NO_EXTRACTABLE_FACTS_CONFIRMED', lastReceipt.threadId, lastReceipt.turnId);
    }
    const manifestSpanIds = bundle.manifest.spans.map((span) => span.id);
    const uniqueCoveredSpanIds = [...new Set(coveredSourceSpanIds)];
    const coverageComplete = uniqueCoveredSpanIds.length === manifestSpanIds.length
      && manifestSpanIds.every((spanId) => uniqueCoveredSpanIds.includes(spanId));
    if (!coverageComplete) {
      return this.needsReview(
        documentId,
        'coverage_gap',
        manifestSpanIds,
        'DOCUMENT_COVERAGE_INCOMPLETE',
        lastReceipt.threadId,
        lastReceipt.turnId
      );
    }
    if (pendingCandidateDiffs.length > 0) {
      return this.needsReview(
        documentId,
        'field_conflict',
        manifestSpanIds,
        'INDEPENDENT_REVIEW_MISMATCH',
        lastReceipt.threadId,
        lastReceipt.turnId,
        reviewedCandidates,
        undefined,
        pendingCandidateDiffs,
        {
          coverageComplete: true,
          coveredSourceSpanIds: uniqueCoveredSpanIds,
          manifestSpanIds,
          chunkCount: chunks.length
        }
      );
    }
    const reviewed: ExtractionResult = {
      schemaVersion: 1,
      documentId,
      subject: aggregateReviewedSubject(reviewedSubjects),
      coveredSourceSpanIds: uniqueCoveredSpanIds,
      candidates: reviewedCandidates
    };
    const reviewRef = `chunk-review:${stableHash(reviewReceipts)}`;

    const accepted: Array<ReturnType<typeof candidateToObservation>> = [];
    for (const candidate of reviewed.candidates) {
      const outcome = evaluateObservationCandidate(candidate, bundle.manifest, {
        personConsistent: reviewedSubjectsAreConsistent(reviewedSubjects),
        overwritesUserLockedValue: false
      });
      const inputSignature = stableHash({ documentId, manifestSha256: bundle.manifest.sha256, candidate });
      const outputHash = stableHash({ candidate, outcome });
      const acceptanceId = this.store.saveAcceptanceDecision({
        method: 'auto',
        actor: 'policy',
        rulesVersion: 'health-acceptance-v2',
        inputSignature,
        outputHash,
        reviewRef,
        decision: outcome.decision
      });
      if (outcome.decision === 'reject' || outcome.decision === 'needs_review') {
        return this.needsReview(
          documentId,
          outcome.decision === 'reject' ? 'field_conflict' : 'coverage_gap',
          candidate.evidence.map((ref) => ref.sourceSpanId),
          outcome.decision === 'reject' ? outcome.reasons.join(',') : outcome.reasons.join(','),
          lastReceipt.threadId,
          lastReceipt.turnId,
          reviewed.candidates,
          undefined,
          outcome.decision === 'reject'
            ? [{ localKey: candidate.localKey, itemName: candidate.originalName, fields: ['issues'] }]
            : undefined
        );
      }
      accepted.push(candidateToObservation(candidate, acceptanceId, documentId));
    }

    const expectedRevision = this.store.getFactRevision(bundle.personId);
    const publication = this.store.publishFacts({
      personId: bundle.personId,
      documentId,
      documentCommitKey: stableHash({
        documentId,
        sourceSha256: bundle.manifest.sha256,
        normalizerVersion: bundle.manifest.normalizerVersion,
        extractionSchemaVersion: reviewed.schemaVersion,
        rulesVersion: 'health-acceptance-v2'
      }),
      expectedRevision,
      changeSetHash: stableHash({ documentId, reviewed, rulesVersion: 'health-acceptance-v2' }),
      summary: `从 1 份资料接纳 ${accepted.length} 条有来源事实`,
      observations: accepted,
      ...(this.executionGuard ? { executionGuard: this.executionGuard } : {})
    });
    return { status: 'published', documentId, revision: publication.revision, candidateCount: accepted.length, threadId: lastReceipt.threadId, turnId: lastReceipt.turnId };
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
