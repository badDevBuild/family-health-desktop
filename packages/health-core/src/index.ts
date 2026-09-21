import { createHash } from 'node:crypto';
import type { ObservationCandidate, SourceManifest } from '@contracts';

export * from './member-v2.js';

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

function evidenceQuoteMatchesSource(source: string, cited: string): boolean {
  if (source.includes(cited)) return true;
  const compactSource = source.replace(/\s+/g, '');
  const compactCited = cited.replace(/\s+/g, '');
  return compactCited.length > 0 && compactSource.includes(compactCited);
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
      if (suffixIndex >= 0 && suffixIndex - prefixEnd <= 80) {
        const valueStart = suffixIndex + suffix.length;
        const originalStart = valueStart > 0 ? (originalOffsets[valueStart - 1] ?? text.length - 1) + 1 : 0;
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

function explicitUnitsInEvidence(text: string): string[] {
  const matches = text.match(/(?:x10\^?-?\d+\/?l|10\^?-?\d+\/?l|mmhg|kpa|(?:m|u|n|p)?mol\/?l|mg\/?d?l|ng\/?ml|pg\/?ml|miu\/?ml|miu\/?l|iu\/?ml|iu\/?l|u\/?l|g\/?l|bpm|次\/?分|厘米|毫米|千克|公斤|kg|cm|fl|pg|mm|%|\/hp)/gi) ?? [];
  return matches.map(normalizedUnit);
}

type EvidenceComparator = 'eq' | 'lt' | 'lte' | 'gt' | 'gte';

function primaryMeasurementClause(text: string): string {
  // 一个引用片段可能同时包含多个指标。逗号之后若开始下一个项目，
  // 不能把后一项的数值或定性结果借给当前项。参考范围也不是检验结果。
  const firstClause = text.split(/[,\uff0c]/, 1)[0] ?? text;
  const referenceMarker = firstClause.search(/(?:\u53c2\u8003(?:\u8303\u56f4|\u503c|\u533a\u95f4)?|\u6b63\u5e38\u8303\u56f4|\u8303\u56f4)\s*[:\uff1a]?/i);
  return referenceMarker >= 0 ? firstClause.slice(0, referenceMarker) : firstClause;
}

function numericOccurrences(text: string): Array<{ value: number; comparator: EvidenceComparator; start: number; end: number }> {
  const occurrences: Array<{ value: number; comparator: EvidenceComparator; start: number; end: number }> = [];
  const pattern = /(<=|>=|\u2264|\u2265|<|>|\u5c0f\u4e8e|\u5927\u4e8e|\u4e0d\u9ad8\u4e8e|\u4e0d\u4f4e\u4e8e)?\s*(-?(?:\d+(?:\.\d+)?|\.\d+))/gi;
  for (const match of text.matchAll(pattern)) {
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
    const value = Number(match[2]);
    if (!Number.isFinite(value) || match.index === undefined) continue;
    occurrences.push({ value, comparator, start: match.index, end: match.index + match[0].length });
  }
  return occurrences;
}

function evidenceContentProblems(candidate: ObservationCandidate, manifest: SourceManifest): string[] {
  const spans = new Map(manifest.spans.map((span) => [span.id, span]));
  const problems: string[] = [];
  const supportedText: string[] = [];
  const bindingText: string[] = [];
  for (const reference of candidate.evidence) {
    const span = spans.get(reference.sourceSpanId);
    if (!span) continue;
    if (span.quote && span.readability === 'clear') {
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
    }
  }
  if (candidate.value.kind === 'numeric' && supportedText.length > 0) {
    const expected = Number(candidate.value.decimal);
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
        const nextNumber = following.search(/-?(?:\d+(?:\.\d+)?|\.\d+)/);
        const localSuffix = nextNumber >= 0 ? following.slice(0, nextNumber) : following;
        const localUnits = explicitUnitsInEvidence(localSuffix);
        if (localUnits.length > 0) return localUnits.includes(expectedUnit);
        const allUnits = explicitUnitsInEvidence(text);
        return allUnits.length === 0 || (new Set(allUnits).size === 1 && allUnits[0] === expectedUnit);
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
    const valueWindows = measurementWindows.length > 0 ? measurementWindows : supportedText;
    if ((raw || category) && !valueWindows.some((text) => (
      (raw && evidenceContainsReportedText(text, raw))
      || (category && evidenceContainsReportedText(text, category))
    ))) {
      problems.push('reported_value_not_in_evidence');
    }
  }
  if (candidate.value.kind === 'text' && supportedText.length > 0) {
    const raw = normalizeEvidenceText(candidate.value.rawText);
    if (raw && !supportedText.some((text) => evidenceContainsReportedText(text, raw))) {
      problems.push('reported_value_not_in_evidence');
    }
  }
  if (candidate.clinicalDate && supportedText.length > 0) {
    const [year, month, day] = candidate.clinicalDate.split('-').map(Number);
    const dateForms = [
      candidate.clinicalDate,
      `${year}/${String(month).padStart(2, '0')}/${String(day).padStart(2, '0')}`,
      `${year}.${String(month).padStart(2, '0')}.${String(day).padStart(2, '0')}`,
      `${year}年${month}月${day}日`
    ].map(normalizeEvidenceText);
    if (!supportedText.some((text) => dateForms.some((form) => text.includes(form)))) {
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

  const knownSpans = new Set(manifest.spans.map((span) => span.id));
  const invalidEvidence = candidate.evidence.filter((ref) => !knownSpans.has(ref.sourceSpanId));
  if (invalidEvidence.length > 0) {
    return { decision: 'reject', reasons: ['evidence_mismatch'] };
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
  if (candidate.value.kind === 'unknown') warnings.push('value_unknown');

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
