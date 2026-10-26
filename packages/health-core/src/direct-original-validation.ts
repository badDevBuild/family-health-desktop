import { extractionResultSchema, sourceManifestSchema } from '@contracts';
import type { ClinicalContext, ExtractionResult, ObservationCandidate, ReportMetadataCandidate, SourceManifest, SourceSpan } from '@contracts';
import type { AcceptanceOutcome } from './index.js';
import { createHash } from 'node:crypto';
import type { ReportSourceBindingResolution, ReportSourceUnit, ResolvedReportSourceBinding } from './report-reconciliation.js';
import { calendarDateOccurrences } from './calendar-date.js';

const clinicalRoles = new Set(['sampled', 'examined', 'encounter', 'history_quoted']);
const primaryClinicalRoles = new Set(['sampled', 'examined', 'encounter']);
// 日期/监测区间也可由模型明示为解释条件；这不赋予项目日期或报告主要日期的授权。
const conditionSourceRoles = ['finding', 'context', 'instruction', 'date'] as const;

/** 条件可复用清晰日期出处；提取、修复目标和保存层共用，避免角色门禁漂移。 */
export function isDirectOriginalConditionSourceRole(role: string): boolean {
  return conditionSourceRoles.some((allowedRole) => allowedRole === role);
}
type EvidenceRef = ObservationCandidate['evidence'][number];
interface DirectOriginalSourceSlot {
  parent: string;
  role: string;
  sourceText: string;
  rawSourceText: string;
  start: number;
  end: number;
  narrow: boolean;
}
interface DirectOriginalHeadingProof {
  parent: string;
  text: string;
  rawText: string;
  sourceText: string;
  start: number;
  end: number;
  role: string;
  wholeReference: boolean;
  trusted: boolean;
}
interface GroundedSlotRange { start: number; end: number }
interface DirectOriginalGroundedSlot {
  kind: 'table_cell' | 'labeled_component';
  parent: string;
  frame: string;
  row: GroundedSlotRange[];
  column: GroundedSlotRange[];
  axes: Array<{ kind: string; ranges: GroundedSlotRange[] }>;
  component: { kind: 'quantitative' | 'qualitative' | 'narrative'; ranges: GroundedSlotRange[] } | null;
}
interface DirectOriginalConditionProof {
  sourceSpanId: string;
  quote: string;
  parent: string;
  frame: string;
  range: GroundedSlotRange;
}
const verifiedDirectBindings = new WeakMap<ResolvedReportSourceBinding, {
  fingerprint: string;
  fieldName: string;
  originalName: string;
  parents: string[];
  slots: DirectOriginalSourceSlot[];
  strictFindingSources: boolean;
  trustedFindingSources: boolean;
  explicitHeadings: boolean;
  headings: DirectOriginalHeadingProof[];
  structuredSlot: DirectOriginalGroundedSlot | null;
  conditions: DirectOriginalConditionProof[] | null;
  // 仅同一原页真实模型回执的完整共同上下文；不写回旧来源身份，不凭JSON授予权限。
  groundingContexts: Array<{ parent: string; text: string }>;
  positionContexts: Array<{ parent: string; text: string }>;
  groundingHeadings: Array<{ parent: string; text: string }>;
}>();
const digest = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');
interface DirectOriginalReferenceRange {
  start: number;
  end: number;
  compactStart: number;
  compactEnd: number;
}

/** 只统一排版空白，不把相邻数值格或词 token 拼成一段不存在的原文。 */
function normalizedReference(value: string): { text: string; offsets: Array<{ start: number; end: number }> } {
  let text = '';
  const offsets: Array<{ start: number; end: number }> = [];
  let whitespaceStart = -1;
  let whitespaceEnd = 0;
  for (let index = 0; index < value.length;) {
    const character = String.fromCodePoint(value.codePointAt(index)!);
    for (const normalized of character.normalize('NFKC')) {
      if (/\s/u.test(normalized)) {
        if (whitespaceStart < 0) whitespaceStart = index;
        whitespaceEnd = index + character.length;
      } else {
        if (whitespaceStart >= 0 && text) { text += ' '; offsets.push({ start: whitespaceStart, end: whitespaceEnd }); }
        whitespaceStart = -1;
        text += normalized;
        for (let offset = 0; offset < normalized.length; offset += 1) offsets.push({ start: index, end: index + character.length });
      }
    }
    index += character.length;
  }
  return { text, offsets };
}
const compact = (value: string): string => normalizedReference(value).text;

/** 所有引用校验与槽位定位共用同一种连续匹配，不能各自放宽空白规则。 */
function referenceRanges(source: string, quote: string): DirectOriginalReferenceRange[] {
  const normalized = normalizedReference(source);
  const needle = compact(quote);
  if (!needle) return [];
  const ranges: DirectOriginalReferenceRange[] = [];
  for (let start = normalized.text.indexOf(needle); start >= 0; start = normalized.text.indexOf(needle, start + 1)) {
    const end = start + needle.length;
    // 窄数字/拉丁 token 也不能从更长的数值或单位中截出同字子串。
    const token = /[\p{Script=Latin}\p{N}\p{M}]/u;
    if (token.test(needle[0]!) && start > 0 && token.test(normalized.text[start - 1]!)
      || token.test(needle.at(-1)!) && end < normalized.text.length && token.test(normalized.text[end]!)) continue;
    if (/^\d/u.test(needle) && start > 0 && /[.＋+−–-]/u.test(normalized.text[start - 1]!)
      || /\d$/u.test(needle) && /^\.\d/u.test(normalized.text.slice(end))) continue;
    ranges.push({ start: normalized.offsets[start]!.start, end: normalized.offsets[end - 1]!.end,
      compactStart: start, compactEnd: end });
  }
  return ranges;
}

/** 数值分量允许原值紧邻已声明的完整单位；不改变通用引文的 token 边界。 */
function componentContainsOriginalValue(source: string, candidate: ObservationCandidate): boolean {
  if (!candidate.value.rawText) return false;
  if (referenceRanges(source, candidate.value.rawText).length > 0) return true;
  if (candidate.value.kind !== 'numeric' || !candidate.unitRaw || !numericValueConsistent(candidate)) return false;
  const raw = compact(candidate.value.rawText);
  const unit = compact(candidate.unitRaw);
  // 仅接受整个分量恰为原值和单位；不能从带不等号、前缀或更长单位的表达中截值。
  if (![`${raw}${unit}`, `${raw} ${unit}`].includes(compact(source))) return false;
  return numericValueConsistent({ ...candidate, value: { ...candidate.value, rawText: source } });
}

function primaryFindingRefs(candidate: ObservationCandidate, manifest: SourceManifest): EvidenceRef[] {
  return (candidate.sourceBinding?.findingEvidence ?? candidate.evidence.filter((ref) => {
    const role = manifest.spans.find((span) => span.id === ref.sourceSpanId)?.modelEvidence?.role;
    return role === 'finding' || role === 'instruction';
  })).filter((ref) => ref.sourceRole !== 'duplicate_source');
}

function headingRefs(candidate: ObservationCandidate, manifest: SourceManifest, storedHeadingSet = false): EvidenceRef[] {
  const explicit = candidate.sourceBinding?.headingEvidence;
  const refs = explicit && (explicit.length || storedHeadingSet) ? explicit : candidate.evidence.filter((ref) => {
    const role = manifest.spans.find((span) => span.id === ref.sourceSpanId)?.modelEvidence?.role;
    return (role === 'heading' || role === 'context') && !(candidate.clinicalContext?.conditions ?? [])
      .some((condition) => condition.sourceSpanId === ref.sourceSpanId && condition.quote === ref.quote);
  });
  return refs.filter((ref) => ref.sourceRole !== 'duplicate_source');
}

function sameText(left: string, right: string): boolean {
  return compact(left) === compact(right);
}

/** 只检查应用保存的原件来源回执，不再把 OCR 或项目词典当成医学原文判据。 */
function trustedExcerpt(span: SourceSpan | undefined, manifest: SourceManifest): span is SourceSpan {
  const evidence = span?.modelEvidence;
  const parent = evidence ? manifest.spans.find((item) => item.id === evidence.parentSourceSpanId) : undefined;
  return Boolean(span && evidence && evidence.engine === 'codex-original-reading-v1'
    && evidence.originalSha256 === manifest.sha256 && evidence.originalSourceObjectId === manifest.sourceObjectId
    && evidence.modelId && evidence.threadId && evidence.turnId
    && parent && !parent.modelEvidence && !parent.visualEvidence && parent.documentId === span.documentId
    && parent.quote === null && manifest.normalizerVersion.startsWith('direct-original-')
    && parent.page === span.page && span.spanKind === 'block'
    && span.blockId === `model-original-excerpt:${parent.id}` && span.quote?.trim());
}

/** quote=null只表示精确指向的整段模型摘录；不能从别处正文、标题或候选值补造出处。 */
export function resolveDirectOriginalWholeExcerptQuote(manifest: SourceManifest, documentId: string,
  sourceSpanId: string): string | null {
  if (!documentId.trim() || !sourceSpanId.trim() || !sourceManifestSchema.safeParse(manifest).success
    || manifest.spans.some((span) => span.documentId !== documentId)) return null;
  const sources = manifest.spans.filter((span) => span.id === sourceSpanId);
  if (sources.length !== 1) return null;
  const span = sources[0]!;
  if (!trustedExcerpt(span, manifest) || span.documentId !== documentId || span.visualEvidence
    || span.readability !== 'clear' || span.modelEvidence!.clarity !== 'clear'
    || !['finding', 'instruction', 'context', 'date', 'heading'].includes(span.modelEvidence!.role)
    || [span.modelEvidence!.modelId, span.modelEvidence!.threadId, span.modelEvidence!.turnId].some((value) => !value.trim())) return null;
  const parents = manifest.spans.filter((item) => item.id === span.modelEvidence!.parentSourceSpanId);
  if (parents.length !== 1) return null;
  const parent = parents[0]!;
  if (parent.documentId !== documentId || !['page', 'image'].includes(parent.spanKind)
    || parent.page === null || parent.page > manifest.totalUnits || !manifest.coveredUnitIndexes.includes(parent.page - 1)) return null;
  return span.quote!;
}

function evidenceProblems(refs: EvidenceRef[], manifest: SourceManifest, allowedRoles?: readonly string[]): string[] {
  const errors: string[] = [];
  for (const ref of refs) {
    const span = manifest.spans.find((item) => item.id === ref.sourceSpanId);
    if (!trustedExcerpt(span, manifest)) {
      errors.push('direct_original_evidence_mismatch');
      continue;
    }
    if (span.modelEvidence!.clarity !== 'clear') errors.push('direct_original_evidence_uncertain');
    if (allowedRoles && !allowedRoles.includes(span.modelEvidence!.role)) errors.push('direct_original_evidence_role_mismatch');
    if (ref.quote !== null && !ref.quote.trim()) errors.push('direct_original_reference_blank');
    // 这只对照模型给出的来源引用与已保存的同一引用，绝不对照本机 OCR 文本。
    if (ref.quote !== null && !sameText(span.quote!, ref.quote) && referenceRanges(span.quote!, ref.quote).length === 0) {
      errors.push('direct_original_reference_changed');
    }
  }
  return [...new Set(errors)];
}

/**
 * 日期语义与适用范围由原件模型的 metadata 绑定提供；同一 finding/instruction
 * 已完整包含该日期时，可以复用其来源，不要求再复制一段 role=date 的相同摘录。
 * 格式对照只校验模型给出的日期与其精确引用自洽，不据此推断日期角色。
 */
export function directOriginalTimeEvidenceProblems(time: ReportMetadataCandidate['times'][number],
  manifest: SourceManifest, documentId: string): string[] {
  const errors = evidenceProblems(time.evidence, manifest, ['date', 'finding', 'instruction']);
  if (time.evidence.length === 0) errors.push('direct_original_date_reference_required');
  for (const ref of time.evidence) {
    const source = resolveDirectOriginalWholeExcerptQuote(manifest, documentId, ref.sourceSpanId);
    if (source === null) { errors.push('direct_original_evidence_mismatch'); continue; }
    const role = manifest.spans.find((span) => span.id === ref.sourceSpanId)?.modelEvidence?.role;
    if (role !== 'finding' && role !== 'instruction') continue;
    const quote = ref.quote ?? source;
    const normalized = compact(quote);
    const [year, month] = time.value.split('-');
    const matches = time.precision === 'day'
      ? calendarDateOccurrences(quote).some((found) => found.date === time.value)
      : time.precision === 'month'
        ? new RegExp(`(?<!\\d)${year}(?:\\s*[-/.]\\s*0?${Number(month)}(?!\\d)|\\s*年\\s*0?${Number(month)}\\s*月)`, 'u').test(normalized)
        : new RegExp(`(?<!\\d)${year}(?!\\d)`, 'u').test(normalized);
    if (!matches) errors.push('direct_original_date_reference_inconsistent');
  }
  return [...new Set(errors)];
}

/**
 * 标题可以是同一模型摘录内独立的窄原句，不要求模型重复造一段来源。
 * 例外只针对本候选已明示的同摘录结果；不拿其他项目、数值或名称猜标题归属。
 */
export function isDirectOriginalHeadingReferenceValid(candidate: ObservationCandidate, manifest: SourceManifest,
  ref: EvidenceRef): boolean {
  const documentId = manifest.spans[0]?.documentId;
  if (!documentId || typeof ref.sourceSpanId !== 'string'
    || ref.quote !== null && typeof ref.quote !== 'string') return false;
  const source = resolveDirectOriginalWholeExcerptQuote(manifest, documentId, ref.sourceSpanId);
  if (source === null || evidenceProblems([ref], manifest).length > 0) return false;
  const span = manifest.spans.find((item) => item.id === ref.sourceSpanId)!;
  const role = span.modelEvidence!.role;
  if (role === 'heading' || role === 'context') return true;
  if (!['finding', 'instruction'].includes(role) || ref.sourceRole === 'duplicate_source'
    || typeof ref.quote !== 'string' || !ref.quote.trim()
    || !candidate.sourceBinding?.headingEvidence.some((heading) => heading.sourceSpanId === ref.sourceSpanId
      && heading.quote === ref.quote && heading.sourceRole !== 'duplicate_source')) return false;
  // 完整槽位已将真实行/列/轴标签与本候选结果在同页上下文内对齐；标签摘录可独立于结果摘录。
  // 只复用那个经过核验的精确锚点，不把任意 finding/context 或模型展示名变成标题。
  const slot = candidate.sourceBinding.structuredSlot;
  const labelRefs = slot ? [...slot.rowEvidence, ...slot.columnEvidence, ...slot.axes.flatMap((axis) => axis.evidence)] : [];
  if (labelRefs.some((anchor) => anchor.sourceSpanId === ref.sourceSpanId && anchor.quote === ref.quote
    && anchor.sourceRole !== 'duplicate_source') && resolvedSlotHeadingRange(candidate, manifest, ref)) return true;
  const headingRange = uniqueReferenceRange(source, ref.quote);
  const wholeLength = compact(source).length;
  if (!headingRange || headingRange.compactStart === 0 && headingRange.compactEnd === wholeLength) return false;
  const findings = candidate.sourceBinding.findingEvidence.filter((finding) => finding.sourceSpanId === ref.sourceSpanId
    && finding.sourceRole !== 'duplicate_source');
  if (findings.length === 0) return false;
  // 同一候选若还声明了覆盖标题的结果范围，不能挑另一个不相交范围来掩盖重叠。
  return findings.every((finding) => {
    if (typeof finding.quote !== 'string' || !finding.quote.trim()
      || evidenceProblems([finding], manifest, ['finding', 'instruction']).length > 0) return false;
    const range = findingReferenceRange(candidate, manifest, finding);
    return Boolean(range && !(range.compactStart === 0 && range.compactEnd === wholeLength)
      && (headingRange.compactEnd <= range.compactStart || range.compactEnd <= headingRange.compactStart));
  });
}

function headingEvidenceProblems(candidate: ObservationCandidate, refs: EvidenceRef[], manifest: SourceManifest): string[] {
  return [...new Set(refs.flatMap((ref) => {
    const errors = evidenceProblems([ref], manifest);
    if (isDirectOriginalHeadingReferenceValid(candidate, manifest, ref)) return errors;
    const role = manifest.spans.find((span) => span.id === ref.sourceSpanId)?.modelEvidence?.role;
    if (role && !['heading', 'context'].includes(role)) errors.push('direct_original_evidence_role_mismatch');
    else if (errors.length === 0) errors.push('direct_original_evidence_mismatch');
    return errors;
  }))];
}

/** 主要日期由模型明示，应用只检查索引、角色和同原件出处，不读关键词或替项目补日期。 */
function primaryClinicalTimeProblems(metadata: ReportMetadataCandidate, manifest: SourceManifest, documentId: string): string[] {
  const selected = metadata.primaryClinicalTimeIndex;
  if (selected === null) return [];
  if (selected === undefined) {
    // 旧单一当前日期回执可以兼容；多个不同当前日期必须由模型选，不按早晚或数组顺序猜。
    const distinctCurrentDates = new Set(metadata.times.filter((time) => primaryClinicalRoles.has(time.role)).map((time) => time.value));
    return distinctCurrentDates.size > 1 ? ['direct_original_primary_clinical_time_required'] : [];
  }
  const time = metadata.times[selected];
  if (!Number.isInteger(selected) || selected < 0 || !time || !primaryClinicalRoles.has(time.role)
    || directOriginalTimeEvidenceProblems(time, manifest, documentId).length > 0
    || time.evidence.some((ref) => manifest.spans.find((span) => span.id === ref.sourceSpanId)?.documentId !== documentId)) {
    return ['direct_original_primary_clinical_time_invalid'];
  }
  return [];
}

/** 数值的 JSON 表达自洽检查；数值属于哪个项目、单位和左右侧由模型直接读原件判断。 */
function numericValueConsistent(candidate: ObservationCandidate): boolean {
  if (candidate.value.kind !== 'numeric') return true;
  const normalizedRaw = candidate.value.rawText.normalize('NFKC').trim();
  const normalizeNumber = (value: string): string => value.trim().replace(/[−–]/gu, '-');
  // 只允许比较符、指数符附近的排版空格；不能把两个独立数字 token “1 2”拼成12。
  const parseNumber = (value: string): RegExpExecArray | null =>
    /^(<=|>=|≤|≥|<|>|=)?\s*([+-]?\s*(?:\d+(?:\.\d*)?|\.\d+))(?:\s*[eE]\s*([+-]?\d+))?$/u.exec(normalizeNumber(value));
  let match = parseNumber(normalizedRaw);
  // 原串本来已是一个完整数值时，后面的数学/比较符校验必须直接决定结果；
  // 不能因 decimal 不符，再把 unit="2" 当尾缀将“12”改读成“1”。
  if (!match) {
    const unit = candidate.unitRaw?.normalize('NFKC').trim();
    if (!unit) return false;
    // 这里只许可通用单位表达式的字面字符，不按项目或单位词典猜含义。
    // 近似、范围等结果限定符即使被放进 unitRaw，也不能随单位一起被隔离。
    const punctuation = unit.replace(/[\p{L}\p{N}\p{M}\s]/gu, '');
    if ([...punctuation].some((character) => !'%‰°/*^().[]{}·⋅×+−–-'.includes(character))
      || !/[\p{L}%‰°]/u.test(unit)
      || /\.{2,}/u.test(unit)
      || /[<>=!≠≤≥±]/u.test(unit)
      || /(?:不|无|未|非|否|正|负|阴性|阳性|异常)|\b(?:not|no|none|negative|positive|normal|undetectable)\b/iu.test(unit)
      || /^[+\-.−–]/u.test(unit)
      || /[+\-−–]\s*$/u.test(unit)
      || /^[eE](?:\s*[+-]?\s*\d|\s*$)/u.test(unit)
      || !normalizedRaw.endsWith(unit)) return false;
    const prefix = normalizedRaw.slice(0, -unit.length);
    // 数字开头的单位表达式只接受清晰分隔的完整表达式；不吞独立数字或指数片段。
    if (/^\d/u.test(unit) && (!/\s$/u.test(prefix) || /\s/u.test(unit) || !/[*/^×·⋅]/u.test(unit))) return false;
    match = parseNumber(prefix);
  }
  if (!match) return false;
  const comparators = { '<': 'lt', '<=': 'lte', '≤': 'lte', '>': 'gt', '>=': 'gte', '≥': 'gte', '=': 'eq' } as const;
  const comparator = comparators[match[1] as keyof typeof comparators] ?? 'eq';
  const canonical = (coefficient: string, exponent = '0'): string => {
    const negative = coefficient.startsWith('-');
    const absolute = coefficient.replace(/^[+-]/u, '');
    const fractionLength = absolute.includes('.') ? absolute.length - absolute.indexOf('.') - 1 : 0;
    const digits = absolute.replace('.', '').replace(/^0+/u, '');
    if (!digits) return '0';
    const trailingZeros = digits.length - digits.replace(/0+$/u, '').length;
    return `${negative ? '-' : ''}${digits.replace(/0+$/u, '')}:${BigInt(fractionLength) - BigInt(exponent) - BigInt(trailingZeros)}`;
  };
  return canonical(match[2]!.replace(/^([+-])\s+/u, '$1'), match[3]) === canonical(candidate.value.decimal)
    && comparator === candidate.value.comparator;
}

export interface DirectOriginalAcceptanceOptions {
  personConsistent: boolean;
  overwritesUserLockedValue: boolean;
  reportMetadata?: ReportMetadataCandidate | null;
}

/** 仅把异常标志的明确协议别写投影为枚举；不解释正负号、强弱等级或任何结果值。 */
export function normalizedDirectOriginalAbnormalFlag(value: string | null): 'high' | 'low' | 'positive' | 'negative' | 'normal' | 'unknown' | null | undefined {
  if (value === null) return null;
  const aliases: Record<string, 'high' | 'low' | 'positive' | 'negative' | 'normal' | 'unknown'> = {
    high: 'high', h: 'high', '↑': 'high', '偏高': 'high', '升高': 'high',
    low: 'low', l: 'low', '↓': 'low', '偏低': 'low', '降低': 'low',
    positive: 'positive', '阳性': 'positive', negative: 'negative', '阴性': 'negative',
    normal: 'normal', '正常': 'normal', unknown: 'unknown'
  };
  return aliases[value.normalize('NFKC').trim().toLowerCase()];
}

/** 仅包含本地标识、字段路径和技术约束，不复制原文、检查名称或结果。 */
export interface DirectOriginalCandidateDiagnostic {
  targetId: string;
  reasonCode: string;
  fieldPath: string;
  sourceSpanId?: string;
  actualRole?: string | null;
  allowedRoles?: string[];
  constraint: string;
}

export function evaluateDirectOriginalObservationCandidate(
  candidate: ObservationCandidate, manifest: SourceManifest, options: DirectOriginalAcceptanceOptions
): AcceptanceOutcome {
  if (!options.personConsistent) return { decision: 'needs_review', reasons: ['person_conflict'] };
  if (options.overwritesUserLockedValue) return { decision: 'needs_review', reasons: ['overwrite_protected'] };
  if (candidate.value.kind === 'unknown') return { decision: 'reject', reasons: ['value_unknown'] };
  if (!candidate.value.rawText.trim()) return { decision: 'reject', reasons: ['direct_original_result_blank'] };
  const findings = primaryFindingRefs(candidate, manifest);
  const errors = [...evidenceProblems(candidate.evidence, manifest),
    ...evidenceProblems(candidate.sourceBinding?.findingEvidence ?? [], manifest, ['finding', 'instruction']),
    ...evidenceProblems(findings, manifest, ['finding', 'instruction']),
    ...headingEvidenceProblems(candidate, candidate.sourceBinding?.headingEvidence ?? [], manifest)];
  if (candidate.sourceBinding?.structuredSlot && !resolveGroundedSlot(candidate, manifest)) {
    errors.push('direct_original_structured_slot_invalid');
  }
  for (const condition of candidate.clinicalContext?.conditions ?? []) {
    errors.push(...evidenceProblems([condition], manifest, conditionSourceRoles));
  }
  if (findings.length === 0) errors.push('direct_original_finding_source_required');
  if (!numericValueConsistent(candidate)) errors.push('direct_original_numeric_representation_conflict');
  // 符号含义由模型直接读原件判断；应用只确保JSON用了可持久化的枚举，不能把“↑”静默存成unknown。
  if (normalizedDirectOriginalAbnormalFlag(candidate.reportedAbnormalFlag) === undefined) {
    errors.push('direct_original_abnormal_representation_conflict');
  }
  if (candidate.clinicalDate !== null) {
    const dates = options.reportMetadata?.times.filter((time) => time.value === candidate.clinicalDate
      && time.precision === 'day' && clinicalRoles.has(time.role)) ?? [];
    if (!dates.some((time) => directOriginalTimeEvidenceProblems(time, manifest, manifest.spans[0]?.documentId ?? '').length === 0
      && time.evidence.some((date) => candidate.evidence.some((ref) => {
        if (ref.sourceSpanId !== date.sourceSpanId || ref.sourceRole === 'duplicate_source') return false;
        const source = resolveDirectOriginalWholeExcerptQuote(manifest, manifest.spans[0]?.documentId ?? '', ref.sourceSpanId);
        if (source === null) return false;
        const sourceDates = new Set(calendarDateOccurrences(source).map(item => item.date));
        if (sourceDates.size <= 1) return true;
        // 同一历年表格摘录包含多个日期，共享片段ID不足以证明选中了同一时间列。
        const citedDates = new Set(calendarDateOccurrences(ref.quote ?? source).map(item => item.date));
        return citedDates.size === 1 && citedDates.has(candidate.clinicalDate!);
      })))) {
      errors.push('direct_original_clinical_date_source_required');
    }
  }
  if (errors.length > 0) return { decision: 'reject', reasons: [...new Set(errors)] };
  const blocking = candidate.issues.find((issue) => issue.code.startsWith('blocking_'));
  if (blocking) return { decision: 'needs_review', reasons: [blocking.code] };
  const warnings: string[] = [];
  if (candidate.reportedAbnormalFlag !== normalizedDirectOriginalAbnormalFlag(candidate.reportedAbnormalFlag)) {
    warnings.push('direct_original_abnormal_format_normalized');
  }
  if (candidate.referenceRangeRaw === null) warnings.push('reference_range_not_provided');
  if (candidate.unitRaw === null && candidate.value.kind === 'numeric') warnings.push('unit_not_provided');
  return warnings.length === 0 ? { decision: 'accept', warnings } : { decision: 'accept_with_warnings', warnings };
}

export interface DirectOriginalFieldReview {
  fieldPath: string;
  reasonCodes: string[];
  evidence: EvidenceRef[];
}
export type DirectOriginalFieldAdmissionReview =
  | { kind: 'candidate'; original: ObservationCandidate; fields: DirectOriginalFieldReview[] }
  | { kind: 'metadata'; original: ReportMetadataCandidate; fields: DirectOriginalFieldReview[] };

/**
 * 正式字段级验收投影：原候选不变；调用方必须把 reviews 与原候选一起持久保存。
 * 只隔离未证实的日期字段及独立 role=date 引用，结果、栏目、槽位和条件从不降级。
 */
export function projectDirectOriginalCandidateFields(candidate: ObservationCandidate, manifest: SourceManifest,
  options: DirectOriginalAcceptanceOptions): { candidate: ObservationCandidate; reviews: DirectOriginalFieldReview[] } {
  if (candidate.clinicalDate === null) return { candidate, reviews: [] };
  const initial = evaluateDirectOriginalObservationCandidate(candidate, manifest, options);
  if (initial.decision !== 'reject' || !initial.reasons.includes('direct_original_clinical_date_source_required')) {
    return { candidate, reviews: [] };
  }
  const coreReferences = [...(candidate.sourceBinding?.findingEvidence ?? primaryFindingRefs(candidate, manifest)),
    ...(candidate.sourceBinding?.headingEvidence ?? []), ...(candidate.clinicalContext?.conditions ?? []),
    ...(candidate.sourceBinding?.structuredSlot ? [
      ...candidate.sourceBinding.structuredSlot.contextEvidence, ...candidate.sourceBinding.structuredSlot.rowEvidence,
      ...candidate.sourceBinding.structuredSlot.columnEvidence,
      ...candidate.sourceBinding.structuredSlot.axes.flatMap((axis) => axis.evidence),
      ...(candidate.sourceBinding.structuredSlot.component?.evidence ?? [])
    ] : [])];
  const dateRefs = candidate.evidence.filter((ref) => {
    const span = manifest.spans.find((item) => item.id === ref.sourceSpanId);
    // 只有可确认属于当前原件的独立日期摘录才可隔离，未知/跨文件引用不能猜成无关信息。
    return trustedExcerpt(span, manifest) && span.modelEvidence!.role === 'date'
      && !coreReferences.some((core) => core.sourceSpanId === ref.sourceSpanId);
  });
  const projected = { ...candidate, clinicalDate: null, evidence: candidate.evidence.filter((ref) => !dateRefs.includes(ref)) };
  if (!projected.evidence.length) return { candidate, reviews: [] };
  const outcome = evaluateDirectOriginalObservationCandidate(projected, manifest, options);
  if (outcome.decision !== 'accept' && outcome.decision !== 'accept_with_warnings') return { candidate, reviews: [] };
  return { candidate: projected, reviews: [{ fieldPath: 'clinicalDate',
    reasonCodes: ['direct_original_clinical_date_unverified'], evidence: dateRefs.length ? dateRefs : candidate.evidence }] };
}

/** 报告标题/机构与时间单独验收，坏辅助字段不能抹去其余有效元数据；原 metadata 另存审计。 */
export function projectDirectOriginalMetadataFields(metadata: ReportMetadataCandidate | null | undefined,
  manifest: SourceManifest, documentId: string): { metadata: ReportMetadataCandidate | null; reviews: DirectOriginalFieldReview[] } {
  if (!metadata) return { metadata: null, reviews: [] };
  const projected = structuredClone(metadata);
  const reviews: DirectOriginalFieldReview[] = [];
  const fields = ['reportKind', 'title', 'organization', 'campus', 'department', 'reportNumber',
    'encounterIdentifier'] as const;
  for (const key of fields) {
    const field = metadata[key];
    const reasons = field ? evidenceProblems(field.evidence, manifest) : [];
    if (!field || !reasons.length) continue;
    projected[key] = null;
    reviews.push({ fieldPath: `reportMetadata.${key}`, reasonCodes: ['direct_original_metadata_field_unverified', ...reasons],
      evidence: field.evidence });
  }
  for (const key of ['sampleIdentifiers', 'examItems'] as const) {
    const list = metadata[key];
    if (!list) continue;
    projected[key] = list.filter((field, index) => {
      const reasons = evidenceProblems(field.evidence, manifest);
      if (!reasons.length) return true;
      reviews.push({ fieldPath: `reportMetadata.${key}[${index}]`,
        reasonCodes: ['direct_original_metadata_field_unverified', ...reasons], evidence: field.evidence });
      return false;
    });
  }
  const keptIndexes: number[] = [];
  projected.times = metadata.times.filter((time, index) => {
    const reasons = directOriginalTimeEvidenceProblems(time, manifest, documentId);
    if (!reasons.length) { keptIndexes.push(index); return true; }
    reviews.push({ fieldPath: `reportMetadata.times[${index}]`,
      reasonCodes: ['direct_original_metadata_time_unverified', ...reasons], evidence: time.evidence });
    return false;
  });
  if (metadata.primaryClinicalTimeIndex !== undefined && metadata.primaryClinicalTimeIndex !== null) {
    const newIndex = keptIndexes.indexOf(metadata.primaryClinicalTimeIndex);
    projected.primaryClinicalTimeIndex = newIndex >= 0 ? newIndex : null;
  }
  const primaryIssues = primaryClinicalTimeProblems(projected, manifest, documentId);
  if (primaryIssues.length) {
    projected.primaryClinicalTimeIndex = null;
    reviews.push({ fieldPath: 'reportMetadata.primaryClinicalTimeIndex',
      reasonCodes: ['direct_original_metadata_time_unverified', ...primaryIssues],
      evidence: metadata.times.flatMap((time) => time.evidence) });
  }
  return { metadata: projected, reviews };
}

/**
 * 解释现有接纳门禁的失败位置，不另行判断是否可接纳。
 * 所有引用仍调用与 evaluate 相同的证据校验；诊断不能新增许可或改写候选。
 */
export function diagnoseDirectOriginalObservationCandidate(
  candidate: ObservationCandidate, manifest: SourceManifest, options: DirectOriginalAcceptanceOptions
): DirectOriginalCandidateDiagnostic[] {
  const outcome = evaluateDirectOriginalObservationCandidate(candidate, manifest, options);
  if (outcome.decision === 'accept' || outcome.decision === 'accept_with_warnings') return [];
  const reasons = new Set(outcome.reasons);
  const diagnostics: DirectOriginalCandidateDiagnostic[] = [];
  const referenceConstraints: Record<string, string> = {
    direct_original_evidence_mismatch: '引用必须指向当前原件中具备有效文件、原页和模型读取回执的同一摘录，不能借用另一文件或无效来源。',
    direct_original_evidence_uncertain: '引用的模型摘录 clarity 必须为 clear；不能把不清晰来源作为已确认结果。',
    direct_original_evidence_role_mismatch: '引用角色必须符合该字段的来源职责，不能仅因文本相同就跨角色借用。',
    direct_original_reference_blank: 'quote 只能为有效非空引用或明确的整段 null 引用，不能使用空白字符串。',
    direct_original_reference_changed: 'quote 必须与所指向的同一摘录相等或为其连续子串，不能改写引用或借用其他摘录的文字。'
  };
  const addReference = (ref: EvidenceRef, fieldPath: string, allowedRoles?: readonly string[], heading = false) => {
    const errors = heading ? headingEvidenceProblems(candidate, [ref], manifest)
      : evidenceProblems([ref], manifest, allowedRoles);
    const actualRole = manifest.spans.find((span) => span.id === ref.sourceSpanId)?.modelEvidence?.role ?? null;
    const narrowHeading = heading && (actualRole === 'finding' || actualRole === 'instruction');
    for (const reasonCode of errors) {
      if (!reasons.has(reasonCode)) continue;
      diagnostics.push({ targetId: candidate.localKey, reasonCode, fieldPath, sourceSpanId: ref.sourceSpanId, actualRole,
        // finding/instruction 的标题复用是窄范围证明，不是额外开放一个通用标题角色。
        ...(!narrowHeading && allowedRoles ? { allowedRoles: [...allowedRoles] } : {}),
        constraint: narrowHeading && reasonCode === 'direct_original_evidence_role_mismatch'
          ? 'finding/instruction 仅可由本候选 sourceBinding.headingEvidence 显式以非 duplicate_source 复用为标题：须为本候选已完整核验 structuredSlot 中的精确行、列或轴锚点，或至少一条本候选非 duplicate_source findingEvidence 与标题指向同一摘录；后一情形标题须是唯一非整段窄范围，所有结果引用须唯一且非整段，标题不能与其中任何一个结果范围重叠；其他候选或其他摘录不能单独提供此证明，展示名称或未核验槽位也不能替代证明。'
          : referenceConstraints[reasonCode]! });
    }
  };
  candidate.evidence.forEach((ref, index) => addReference(ref, `evidence[${index}]`));
  candidate.sourceBinding?.findingEvidence.forEach((ref, index) =>
    addReference(ref, `sourceBinding.findingEvidence[${index}]`, ['finding', 'instruction']));
  candidate.sourceBinding?.headingEvidence.forEach((ref, index) =>
    addReference(ref, `sourceBinding.headingEvidence[${index}]`, ['heading', 'context'], true));
  candidate.clinicalContext?.conditions.forEach((ref, index) =>
    addReference(ref, `clinicalContext.conditions[${index}]`, conditionSourceRoles));
  const structuredSlot = candidate.sourceBinding?.structuredSlot;
  if (structuredSlot) {
    // 同一个解析器给出失败锚点和真实角色约束，避免修复提示与接纳门禁各说一套。
    if (reasons.has('direct_original_structured_slot_invalid')) resolveGroundedSlot(candidate, manifest, diagnostics);
  }
  // 无显式 binding 时，finding 由原有 evidence 按同一规则选择；保持原数组下标用于修复定位。
  if (!candidate.sourceBinding) {
    const findings = new Set(primaryFindingRefs(candidate, manifest));
    candidate.evidence.forEach((ref, index) => {
      if (findings.has(ref)) addReference(ref, `evidence[${index}]`, ['finding', 'instruction']);
    });
  }
  const scalarConstraints: Record<string, { fieldPath: string; constraint: string }> = {
    person_conflict: { fieldPath: '$', constraint: '报告主体必须通过既有成员归属流程确认，不能由候选字段或显示名反推。' },
    overwrite_protected: { fieldPath: '$', constraint: '不得覆盖已由用户锁定的结果；须保留原有结果并使用正式修正流程。' },
    value_unknown: { fieldPath: 'value.kind', constraint: '未知或原件未填写的结果不能作为已确认观测接纳，不能补成正常或编造数值。' },
    direct_original_result_blank: { fieldPath: 'value.rawText', constraint: '已确认结果须保留非空原始表达；原件空白不能补成正常结果。' },
    direct_original_finding_source_required: { fieldPath: candidate.sourceBinding ? 'sourceBinding.findingEvidence' : 'evidence',
      constraint: '本候选须有至少一条非 duplicate_source 的有效 finding/instruction 结果引用，标题、日期或身份来源不能单独充当检查结果。' },
    direct_original_numeric_representation_conflict: { fieldPath: 'value',
      constraint: 'rawText、decimal、comparator 与独立 unitRaw 的数值表达必须自洽，须保留不等号和科学计数法边界，不能拼接独立数字。' },
    direct_original_structured_slot_invalid: { fieldPath: 'sourceBinding.structuredSlot',
      constraint: '表格或分量槽位须由同一原页的清晰共同上下文及唯一真实行、列、轴引用证明；不能用自造编号、结果值或展示名代替锚点。table_cell须有独立行列，labeled_component须有独立且含原始结果的分量引用；真实同格矛盾不能拆成两个分量。' },
    direct_original_abnormal_representation_conflict: { fieldPath: 'reportedAbnormalFlag',
      constraint: '异常标记须使用既有 high/low/positive/negative/normal/unknown 枚举或 null；含义由模型读原件判断，不能将原符号静默丢为 unknown。' },
    direct_original_clinical_date_source_required: { fieldPath: 'clinicalDate',
      constraint: '非空临床日期须对应报告 metadata 中具有有效出处的日精度 sampled/examined/encounter/history_quoted 日期，并与本候选 evidence 共享该日期来源；不能用签发日期或猜测补齐。' }
  };
  for (const reasonCode of reasons) {
    if (diagnostics.some((diagnostic) => diagnostic.reasonCode === reasonCode)) continue;
    const scalar = scalarConstraints[reasonCode];
    const issueIndex = candidate.issues.findIndex((issue) => issue.code === reasonCode && issue.code.startsWith('blocking_'));
    diagnostics.push({ targetId: candidate.localKey, reasonCode,
      fieldPath: scalar?.fieldPath ?? (issueIndex >= 0 ? `issues[${issueIndex}].code` : '$'),
      constraint: scalar?.constraint ?? '既有阻断事项须通过原定修复流程核实，不得仅删除阻断标记或放宽来源规则。' });
  }
  return [...new Map(diagnostics.map((diagnostic) => [JSON.stringify(diagnostic), diagnostic])).values()];
}

/** 报告级技术门禁：检查完整页覆盖、来源及日期角色；不将局部候选问题升级为全报告失败。 */
export function validateDirectOriginalExtraction(extraction: ExtractionResult, manifest: SourceManifest,
  options: { subjectPolicy?: 'require_source_identity' | 'user_assigned'; allowedPrimarySourceSpanIds?: string[] } = {}): string[] {
  if (!extractionResultSchema.safeParse(extraction).success || !sourceManifestSchema.safeParse(manifest).success) {
    return ['direct_original_structure_invalid'];
  }
  const errors: string[] = [];
  const documentId = manifest.spans[0]?.documentId;
  if (!documentId || extraction.documentId !== documentId || manifest.spans.some((span) => span.documentId !== documentId)) {
    errors.push('direct_original_document_mismatch');
  }
  const allPrimary = manifest.spans.filter((span) => !span.modelEvidence && !span.visualEvidence);
  const allowed = options.allowedPrimarySourceSpanIds;
  if (allowed && (!allowed.length || new Set(allowed).size !== allowed.length
    || allowed.some(id => !allPrimary.some(span => span.id === id)))) errors.push('direct_original_page_scope_invalid');
  const primary = allowed ? allPrimary.filter(span => allowed.includes(span.id)) : allPrimary;
  const coverage = new Set(extraction.coveredSourceSpanIds);
  if (coverage.size !== extraction.coveredSourceSpanIds.length
    || primary.some((span) => !coverage.has(span.id))
    || [...coverage].some((id) => !primary.some((span) => span.id === id))) errors.push('direct_original_page_coverage_incomplete');
  if (new Set(manifest.coveredUnitIndexes).size !== manifest.totalUnits
    || manifest.coveredUnitIndexes.some((index) => index < 0 || index >= manifest.totalUnits)) {
    errors.push('direct_original_preparation_coverage_incomplete');
  }
  // 用户明确归属只替代“这份资料属于谁”的证明，不替代任何医疗结果、日期或元数据的来源。
  // 主体原始读取仍原样保留，调用者可另记非阻断说明；默认入口继续验证原件身份。
  if (options.subjectPolicy !== 'user_assigned') {
    if (extraction.subject.confidence === 'explicit') {
      if (!extraction.subject.reportedName || extraction.subject.evidence.length === 0) errors.push('direct_original_subject_source_required');
      errors.push(...evidenceProblems(extraction.subject.evidence, manifest, ['identity']));
    } else if (extraction.subject.reportedName !== null) errors.push('direct_original_subject_confidence_conflict');
  }
  const metadata = extraction.reportMetadata;
  if (metadata) {
    const fields = [metadata.reportKind, metadata.title, metadata.organization, metadata.campus, metadata.department, metadata.reportNumber,
      metadata.encounterIdentifier, ...(metadata.sampleIdentifiers ?? []), ...metadata.examItems].filter((field) => field != null);
    for (const field of fields) errors.push(...evidenceProblems(field.evidence, manifest));
    for (const time of metadata.times) errors.push(...directOriginalTimeEvidenceProblems(time, manifest, extraction.documentId));
    errors.push(...primaryClinicalTimeProblems(metadata, manifest, extraction.documentId));
  }
  if (new Set(extraction.candidates.map((candidate) => candidate.localKey)).size !== extraction.candidates.length) {
    errors.push('direct_original_candidate_key_duplicate');
  }
  return [...new Set(errors)];
}

/** 只定位引用自身的唯一连续范围，不根据结果数值或展示名猜位置。 */
function uniqueReferenceRange(source: string, quote: string | null): DirectOriginalReferenceRange | null {
  if (quote === null) return { start: 0, end: source.length, compactStart: 0, compactEnd: compact(source).length };
  const ranges = referenceRanges(source, quote);
  return ranges.length === 1 ? ranges[0]! : null;
}

/**
 * 原件模型明示表格坐标；本机只验证同页来源、完整上下文与锚点的关系，不识别医学内容。
 * 数字本身可在不同单元格重复，字段身份由真实行/列/轴引用形成，而不是数值或自造编号。
 */
function resolveGroundedSlot(candidate: ObservationCandidate, manifest: SourceManifest,
  diagnostics?: DirectOriginalCandidateDiagnostic[]): DirectOriginalGroundedSlot | null {
  const slot = candidate.sourceBinding?.structuredSlot;
  if (!slot) return null;
  const prefix = 'sourceBinding.structuredSlot';
  const anchorRoles = ['finding', 'instruction', 'context', 'heading', 'date'];
  const contextRoles = ['finding', 'instruction', 'context'];
  const componentRoles = ['finding', 'instruction'];
  const fail = (path: string, constraint: string, ref?: EvidenceRef, allowedRoles?: readonly string[]): null => {
    diagnostics?.push({ targetId: candidate.localKey, reasonCode: 'direct_original_structured_slot_invalid',
      fieldPath: path, ...(ref ? { sourceSpanId: ref.sourceSpanId,
        actualRole: manifest.spans.find((span) => span.id === ref.sourceSpanId)?.modelEvidence?.role ?? null } : {}),
      ...(allowedRoles ? { allowedRoles: [...allowedRoles] } : {}), constraint });
    return null;
  };
  const checkedSpan = (ref: EvidenceRef, path: string, allowedRoles: readonly string[]): SourceSpan | null => {
    if (ref.sourceRole === 'duplicate_source') return fail(path,
      '槽位锚点必须是本字段的主要来源，不能用另一处重复来源代替。', ref, allowedRoles);
    if (evidenceProblems([ref], manifest, allowedRoles).length
      || resolveDirectOriginalWholeExcerptQuote(manifest, manifest.spans[0]?.documentId ?? '', ref.sourceSpanId) === null) {
      return fail(path, '引用须指向当前原件同一清晰摘录，quote须是原文连续引用，角色须符合本字段的 allowedRoles；请重读原页补充合适来源，不要改写原结果。', ref, allowedRoles);
    }
    return manifest.spans.find((span) => span.id === ref.sourceSpanId)!;
  };
  if (slot.contextEvidence.length !== 1) return fail(`${prefix}.contextEvidence`, '必须提供一条完整且可唯一定位的共同表格或分量上下文。');
  if (!slot.rowEvidence.length) return fail(`${prefix}.rowEvidence`, '须提供共同上下文中的真实行或项目标签引用，不能用展示名称代替。');
  if (slot.kind === 'table_cell' && !slot.columnEvidence.length) return fail(`${prefix}.columnEvidence`, '表格单元格须提供独立列标签引用。');
  if (slot.kind === 'labeled_component' && !slot.component) return fail(`${prefix}.component`, '分量槽位须提供独立结果分量及原文引用。');
  if (new Set(slot.axes.map((axis) => axis.kind)).size !== slot.axes.length) return fail(`${prefix}.axes`, '同一轴类型不能重复；每个轴值仍须有真实原文锚点。');
  const contextRef = slot.contextEvidence[0]!;
  const contextPath = `${prefix}.contextEvidence[0]`;
  const contextSpan = checkedSpan(contextRef, contextPath, contextRoles);
  if (!contextSpan) return null;
  const contextRange = uniqueReferenceRange(contextSpan.quote!, contextRef.quote);
  if (!contextRange) return fail(contextPath,
    `共同上下文存在 ${referenceRanges(contextSpan.quote!, contextRef.quote ?? '').length} 个连续位置；请补全能区分章节或重复表格的原文上下文，不能选择第一个位置。`, contextRef, contextRoles);
  const frame = compact(contextSpan.quote!.slice(contextRange.start, contextRange.end));
  const parent = JSON.stringify([contextSpan.modelEvidence!.parentSourceSpanId, contextSpan.page]);
  // 只用于已声明的行/列/轴标签：中文短表头不是另一个较长中文表头中的字串。
  // 不修改一般来源匹配，也不进行分词、同义词归并或按候选数值选择位置。
  const labelRanges = (source: string, quote: string): DirectOriginalReferenceRange[] => {
    const normalized = compact(source); const needle = compact(quote); const han = /\p{Script=Han}/u;
    return referenceRanges(source, quote).filter((range) =>
      !(han.test(needle[0]!) && range.compactStart > 0 && han.test(normalized[range.compactStart - 1]!))
      && !(han.test(needle.at(-1)!) && range.compactEnd < normalized.length && han.test(normalized[range.compactEnd]!)));
  };
  const rangesFor = (refs: EvidenceRef[], path: string, allowedRoles = anchorRoles, label = true,
    containingRanges?: GroundedSlotRange[]): GroundedSlotRange[] | null => {
    const ranges: GroundedSlotRange[] = [];
    for (const [index, ref] of refs.entries()) {
      const fieldPath = `${path}[${index}]`;
      const span = checkedSpan(ref, fieldPath, allowedRoles);
      if (!span) return null;
      if (JSON.stringify([span.modelEvidence!.parentSourceSpanId, span.page]) !== parent) return fail(fieldPath,
        '锚点必须与共同上下文属于同一原件原页，不能借用其他页的同字标签。', ref, allowedRoles);
      const quote = ref.quote ?? span.quote!;
      const matches = label ? labelRanges : referenceRanges;
      let sourceRanges = ref.quote === null ? [uniqueReferenceRange(span.quote!, null)!] : matches(span.quote!, quote);
      // 已明确选择的完整上下文可把大摘录中的重复标签限制在该真实章节内。
      const contextInSource = uniqueReferenceRange(span.quote!, frame);
      if (contextInSource) sourceRanges = sourceRanges.filter((range) => contextInSource.compactStart <= range.compactStart
        && range.compactEnd <= contextInSource.compactEnd);
      let frameRanges = matches(frame, quote);
      // 分量只可在该候选已引用的实际结果内定位；若结果本身重复或只给裸值，仍不能唯一定位。
      if (containingRanges) frameRanges = frameRanges.filter((range) => containingRanges.some((scope) =>
        scope.start <= range.compactStart && range.compactEnd <= scope.end));
      const sourceInContext = uniqueReferenceRange(frame, span.quote!);
      if (contextInSource) sourceRanges = sourceRanges.filter((range) => frameRanges.some((selected) =>
        range.compactStart === contextInSource.compactStart + selected.compactStart
        && range.compactEnd === contextInSource.compactStart + selected.compactEnd));
      else if (sourceInContext) sourceRanges = sourceRanges.filter((range) => frameRanges.some((selected) =>
        selected.compactStart === sourceInContext.compactStart + range.compactStart
        && selected.compactEnd === sourceInContext.compactStart + range.compactEnd));
      if (sourceRanges.length !== 1) return fail(fieldPath,
        `锚点在其来源的已选上下文内有 ${sourceRanges.length} 个完整引用位置；请补充包含章节、行列或轴标签的连续出处，不得以结果数值或候选顺序挑选位置。`, ref, allowedRoles);
      // 独立锚点摘录可提供真实定位背景；必须整体唯一嵌入，不能只凭短标签猜位置。
      if (sourceInContext) frameRanges = frameRanges.filter((range) =>
        range.compactStart === sourceInContext.compactStart + sourceRanges[0]!.compactStart
        && range.compactEnd === sourceInContext.compactStart + sourceRanges[0]!.compactEnd);
      if (frameRanges.length !== 1) return fail(fieldPath,
        `锚点在共同上下文中有 ${frameRanges.length} 个可证明位置；须补充能唯一对应的真实行列背景或缩小完整上下文，不能取第一个匹配。`, ref, allowedRoles);
      const range = frameRanges[0]!;
      // 整张表或整行共同背景不是行、列或结果分量本身的锚点。
      if (range.compactStart === 0 && range.compactEnd === frame.length) return fail(fieldPath,
        '共同上下文整段不能同时充当行、列、轴或结果分量；请引用其中真实的独立标签或分量。', ref, allowedRoles);
      if (ranges.some((previous) => previous.start === range.compactStart && previous.end === range.compactEnd)) return fail(fieldPath,
        '同一字段的多个锚点引用不能重复指向相同位置。', ref, allowedRoles);
      ranges.push({ start: range.compactStart, end: range.compactEnd });
    }
    return ranges.sort((a, b) => a.start - b.start || a.end - b.end);
  };
  const row = rangesFor(slot.rowEvidence, `${prefix}.rowEvidence`);
  const column = rangesFor(slot.columnEvidence, `${prefix}.columnEvidence`);
  if (!row || !column) return null;
  if (row.some((a) => column.some((b) => a.start < b.end && b.start < a.end))) return fail(`${prefix}.columnEvidence[0]`,
    '行锚点与列锚点必须互不重叠，不能把同一短语同时声明成行和列。', slot.columnEvidence[0], anchorRoles);
  const axes: DirectOriginalGroundedSlot['axes'] = [];
  for (const [index, axis] of slot.axes.entries()) {
    const ranges = rangesFor(axis.evidence, `${prefix}.axes[${index}].evidence`);
    if (!ranges) return null;
    if (!ranges.length) return fail(`${prefix}.axes[${index}].evidence`, '轴值必须有共同上下文中的真实标签引用。');
    axes.push({ kind: axis.kind, ranges });
  }
  axes.sort((a, b) => a.kind.localeCompare(b.kind));
  const findingRanges: GroundedSlotRange[] = [];
  for (const [index, ref] of primaryFindingRefs(candidate, manifest).entries()) {
    const span = manifest.spans.find((item) => item.id === ref.sourceSpanId);
    const path = `sourceBinding.findingEvidence[${index}]`;
    if (!span?.modelEvidence || JSON.stringify([span.modelEvidence.parentSourceSpanId, span.page]) !== parent) return fail(path,
      '结果引用必须与槽位上下文属于同一原页。', ref, componentRoles);
    const source = ref.quote ?? span.quote!;
    const ranges = referenceRanges(frame, source);
    if (!ranges.length) return fail(path, '共同上下文必须完整包含本候选的结果引用；请补充合适上下文，不能改写结果。', ref, componentRoles);
    findingRanges.push(...ranges.map((range) => ({ start: range.compactStart, end: range.compactEnd })));
  }
  if (!findingRanges.length) return fail('sourceBinding.findingEvidence', '槽位必须有共同上下文中的主要结果引用。');
  let component: DirectOriginalGroundedSlot['component'] = null;
  if (slot.component) {
    const expectedKind = { quantitative: 'numeric', qualitative: 'qualitative', narrative: 'text' } as const;
    const ranges = rangesFor(slot.component.evidence, `${prefix}.component.evidence`, componentRoles, false, findingRanges);
    if (!ranges) return null;
    if (expectedKind[slot.component.kind] !== candidate.value.kind) return fail(`${prefix}.component.kind`, '分量类别须与原始结果的 numeric/qualitative/text 类型对应。');
    if (!ranges.length) return fail(`${prefix}.component.evidence`, '分量须有独立结果引用。');
    if (ranges.some((part) => row.some((anchor) => part.start < anchor.end && anchor.start < part.end)
      || !findingRanges.some((finding) => finding.start <= part.start && part.end <= finding.end))) return fail(
      `${prefix}.component.evidence[0]`, '结果分量须位于结果引用内且不覆盖项目行标签；不能把整行冒充独立分量。', slot.component.evidence[0], componentRoles);
    if (!candidate.value.rawText || !slot.component.evidence.some((ref) => {
        const span = manifest.spans.find((item) => item.id === ref.sourceSpanId)!;
        return componentContainsOriginalValue(ref.quote ?? span.quote!, candidate);
      })) return fail(`${prefix}.component.evidence[0]`, '分量引用必须保留本候选原始结果，不能从阈值推导或用相反定性替换原文。', slot.component.evidence[0], componentRoles);
    component = { kind: slot.component.kind, ranges };
  }
  return { kind: slot.kind, parent, frame, row, column, axes, component };
}

/** 完整槽位已证明的标签位置可复用于标题；仍按完整frame映射回原始引用偏移。 */
function resolvedSlotHeadingRange(candidate: ObservationCandidate, manifest: SourceManifest,
  ref: EvidenceRef): DirectOriginalReferenceRange | null {
  const declared = candidate.sourceBinding?.structuredSlot;
  if (!declared || ref.quote === null || ref.sourceRole === 'duplicate_source'
    || ![...declared.rowEvidence, ...declared.columnEvidence, ...declared.axes.flatMap((axis) => axis.evidence)]
      .some((anchor) => anchor.sourceSpanId === ref.sourceSpanId && anchor.quote === ref.quote
        && anchor.sourceRole !== 'duplicate_source')) return null;
  const proof = resolveGroundedSlot(candidate, manifest);
  const span = manifest.spans.find((item) => item.id === ref.sourceSpanId);
  if (!proof || !span?.modelEvidence || JSON.stringify([span.modelEvidence.parentSourceSpanId, span.page]) !== proof.parent) return null;
  const aligned = alignDirectOriginalFrames(proof.frame, compact(span.quote!));
  if (!aligned) return null;
  const anchors = [...proof.row, ...proof.column, ...proof.axes.flatMap((axis) => axis.ranges)];
  const ranges = referenceRanges(span.quote!, ref.quote).filter((range) => anchors.some((anchor) =>
    anchor.start + aligned.leftOffset === range.compactStart + aligned.rightOffset
    && anchor.end + aligned.leftOffset === range.compactEnd + aligned.rightOffset));
  return ranges.length === 1 ? ranges[0]! : null;
}

type GroundedSlotRelation = 'same' | 'distinct' | 'complementary' | 'unknown';
function groundedSlotRelation(left: DirectOriginalGroundedSlot, right: DirectOriginalGroundedSlot): GroundedSlotRelation {
  if (left.parent !== right.parent) return 'distinct';
  const frame = alignDirectOriginalFrames(left.frame, right.frame);
  if (!frame) return 'unknown';
  const move = (ranges: GroundedSlotRange[], offset: number) => ranges.map((range) =>
    ({ start: range.start + offset, end: range.end + offset }));
  const compare = (a: GroundedSlotRange[], b: GroundedSlotRange[]): 'same' | 'disjoint' | 'unknown' => {
    const first = move(a, frame.leftOffset); const second = move(b, frame.rightOffset);
    if (digest(first) === digest(second)) return 'same';
    return first.length && second.length && first.every((x) => second.every((y) => x.end <= y.start || y.end <= x.start))
      ? 'disjoint' : 'unknown';
  };
  const row = compare(left.row, right.row); const column = compare(left.column, right.column);
  const axisKinds = new Set([...left.axes, ...right.axes].map((axis) => axis.kind));
  const axes = [...axisKinds].map((kind) => {
    const a = left.axes.find((axis) => axis.kind === kind); const b = right.axes.find((axis) => axis.kind === kind);
    return a && b ? compare(a.ranges, b.ranges) : 'unknown';
  });
  // 轴名只是类型；每个不同值仍须由共同上下文内互不重叠的真实出处证明。
  const dimensions = [row, column, ...axes];
  // 一个有实际坐标的维度已互斥，就不可能是同一单元格；另一维度缺失不抹掉这个证明。
  if (dimensions.includes('disjoint')) return 'distinct';
  if (dimensions.some((value) => value !== 'same')) return 'unknown';
  if (!left.component || !right.component) return 'same';
  const component = compare(left.component.ranges, right.component.ranges);
  if (component === 'same') return 'same';
  if (component === 'disjoint' && new Set([left.component.kind, right.component.kind]).size === 2
    && [left.component.kind, right.component.kind].every((kind) => ['quantitative', 'qualitative'].includes(kind))) return 'complementary';
  return 'unknown';
}

/**
 * 重复结果只可在真实栏目所辖的连续原文中唯一定位。
 * 栏目须在同原页、同 finding 全文中唯一出现；其后至下一个可信标题（或摘录末尾）才是该栏范围。
 * 不从候选名称、结果值、原文语义或其他候选猜标题，也不拼接跨页摘录。
 */
function findingReferenceRange(candidate: ObservationCandidate, manifest: SourceManifest, ref: EvidenceRef): DirectOriginalReferenceRange | null {
  const span = manifest.spans.find((item) => item.id === ref.sourceSpanId);
  if (!span?.quote) return null;
  const unique = uniqueReferenceRange(span.quote, ref.quote);
  if (unique || ref.quote === null) return unique;
  const ranges = referenceRanges(span.quote, ref.quote);
  if (ranges.length === 0 || resolveDirectOriginalWholeExcerptQuote(manifest, span.documentId, span.id) === null) return null;
  const documentId = span.documentId;
  const parentId = span.modelEvidence?.parentSourceSpanId;
  const selected: DirectOriginalReferenceRange[] = [];
  for (const heading of headingRefs(candidate, manifest)) {
    const source = manifest.spans.find((item) => item.id === heading.sourceSpanId);
    if (!source || source.modelEvidence?.parentSourceSpanId !== parentId || source.page !== span.page) continue;
    const sourceQuote = resolveDirectOriginalWholeExcerptQuote(manifest, documentId, heading.sourceSpanId);
    if (sourceQuote === null || evidenceProblems([heading], manifest).length > 0) return null;
    const role = source.modelEvidence!.role;
    if (!['heading', 'context'].includes(role) && !(source.id === span.id && ['finding', 'instruction'].includes(role)
      && typeof heading.quote === 'string' && candidate.sourceBinding?.headingEvidence.some((item) =>
        item.sourceSpanId === heading.sourceSpanId && item.quote === heading.quote && item.sourceRole !== 'duplicate_source'))) return null;
    const sourceRange = uniqueReferenceRange(sourceQuote, heading.quote);
    if (!sourceRange) return null;
    const range = uniqueReferenceRange(span.quote, sourceQuote.slice(sourceRange.start, sourceRange.end));
    if (!range || range.compactStart === 0 && range.compactEnd === compact(span.quote).length) return null;
    selected.push(range);
  }
  if (selected.length === 0) return null;
  const start = Math.max(...selected.map((range) => range.compactEnd));
  let end = compact(span.quote).length;
  for (const heading of manifest.spans) {
    if (heading.modelEvidence?.role !== 'heading' || heading.modelEvidence.parentSourceSpanId !== parentId
      || heading.page !== span.page || resolveDirectOriginalWholeExcerptQuote(manifest, documentId, heading.id) === null) continue;
    const range = uniqueReferenceRange(span.quote, heading.quote);
    if (range && range.compactStart >= start) end = Math.min(end, range.compactStart);
  }
  const scoped = ranges.filter((range) => start <= range.compactStart && range.compactEnd <= end);
  return scoped.length === 1 ? scoped[0]! : null;
}

/** 标记只由本进程真实出处解析产生。保存JSON、克隆或修改标记不提供字段分离权限。 */
export function isVerifiedDirectOriginalSourceBinding(binding: ResolvedReportSourceBinding): boolean {
  return Boolean(binding.directOriginalField && verifiedDirectBindings.get(binding)?.fingerprint === digest(binding));
}

/**
 * 仅重现历史删空白算法的身份摘要，供保存层对旧完整对象做精确比较。
 * 定位、原件/角色/清晰度和原始 offsets 必须已由当前规则重证；返回值不带本进程来源权限。
 * 旧空白规则不得用于查找引用、接受 token 拼接或为新绑定提供授权。
 */
export function projectDirectOriginalLegacyWhitespaceBindingIdentity(
  binding: ResolvedReportSourceBinding
): ResolvedReportSourceBinding | null {
  if (!isVerifiedDirectOriginalSourceBinding(binding)) return null;
  const proof = verifiedDirectBindings.get(binding)!;
  if (proof.structuredSlot || !proof.trustedFindingSources || proof.slots.length !== binding.units.length
    || proof.headings.some((heading) => !heading.trusted)) return null;
  const legacyText = (value: string): string => value.normalize('NFKC').replace(/\s+/gu, '');
  const headingKeys = [...new Set(proof.headings.map((heading) =>
    digest([...(JSON.parse(heading.parent) as [string, number | null]), legacyText(heading.rawText)])))].sort();
  const fieldKey = digest([binding.sourceObjectId, binding.sourceSha256, binding.documentId,
    proof.parents, legacyText(proof.originalName).toLowerCase(), headingKeys]);
  const identities = proof.slots.map((slot, index) => {
    const unit = binding.units[index]!;
    return JSON.stringify([slot.parent, slot.role, legacyText(slot.rawSourceText),
      legacyText(slot.rawSourceText.slice(0, unit.segmentStart)).length,
      legacyText(slot.rawSourceText.slice(0, unit.segmentEnd)).length]);
  });
  return { ...binding, units: binding.units.map((unit) => ({ ...unit })),
    key: digest([fieldKey, [...new Set(identities)].sort()]),
    directOriginalField: { version: 1, fieldKey, headingKeys } };
}

function verifiedSameOriginal(left: ResolvedReportSourceBinding, right: ResolvedReportSourceBinding): boolean {
  return isVerifiedDirectOriginalSourceBinding(left) && isVerifiedDirectOriginalSourceBinding(right)
    && left.sourceObjectId === right.sourceObjectId && left.sourceSha256 === right.sourceSha256
    && left.documentId === right.documentId;
}

export function sameDirectOriginalField(left: ResolvedReportSourceBinding, right: ResolvedReportSourceBinding): boolean {
  if (!verifiedSameOriginal(left, right)) return false;
  const a = verifiedDirectBindings.get(left)!.structuredSlot;
  const b = verifiedDirectBindings.get(right)!.structuredSlot;
  if (a && b) {
    const relation = groundedSlotRelation(a, b);
    if (relation === 'distinct' || relation === 'complementary') return false;
    if (relation === 'same') return true;
    return false;
  }
  if (directOriginalSourceSlotsProvenDisjoint(left, right)) return false;
  return left.directOriginalField!.fieldKey === right.directOriginalField!.fieldKey
    || sameDirectOriginalNarrowSourceSlots(left, right)
      && digest(left.directOriginalField!.headingKeys) === digest(right.directOriginalField!.headingKeys)
    || verifiedDirectBindings.get(left)!.fieldName === verifiedDirectBindings.get(right)!.fieldName
      && directOriginalAlignedSourceFramesProveSameSlot(left, right);
}

/** 仅原件明确的定量值与定性结论互补；没有双向分量出处时不豁免矛盾。 */
export function directOriginalFieldsProvenComplementary(left: ResolvedReportSourceBinding,
  right: ResolvedReportSourceBinding): boolean {
  if (!verifiedSameOriginal(left, right)) return false;
  const a = verifiedDirectBindings.get(left)!.structuredSlot;
  const b = verifiedDirectBindings.get(right)!.structuredSlot;
  return Boolean(a && b && groundedSlotRelation(a, b) === 'complementary');
}

/** 同一个唯一窄引用槽与同一栏目，不因模型改写展示名而变成另一个项目。 */
function sameDirectOriginalNarrowSourceSlots(left: ResolvedReportSourceBinding, right: ResolvedReportSourceBinding): boolean {
  const a = verifiedDirectBindings.get(left)!.slots;
  const b = verifiedDirectBindings.get(right)!.slots;
  if (!a.length || !b.length || a.some((slot) => !slot.narrow) || b.some((slot) => !slot.narrow)) return false;
  const keys = (slots: DirectOriginalSourceSlot[]): string[] => [...new Set(slots.map((slot) =>
    JSON.stringify([slot.parent, slot.sourceText, slot.start, slot.end])))].sort();
  return digest(keys(a)) === digest(keys(b));
}

interface DirectOriginalAlignedFrames {
  sourceText: string;
  leftOffset: number;
  rightOffset: number;
}

/** 完整连续frame只可唯一嵌入，不能靠共同短词、结果值或删除token边界对齐。 */
function alignDirectOriginalFrames(left: string, right: string): DirectOriginalAlignedFrames | null {
  if (left === right) return { sourceText: left, leftOffset: 0, rightOffset: 0 };
  const leftInRight = uniqueReferenceRange(right, left);
  if (leftInRight) return { sourceText: right, leftOffset: leftInRight.compactStart, rightOffset: 0 };
  const rightInLeft = uniqueReferenceRange(left, right);
  return rightInLeft ? { sourceText: left, leftOffset: 0, rightOffset: rightInLeft.compactStart } : null;
}

function uniqueDirectOriginalSlots(slots: DirectOriginalSourceSlot[]): DirectOriginalSourceSlot[] {
  return [...new Map(slots.map((slot) => [JSON.stringify([slot.parent, slot.role, slot.sourceText, slot.start, slot.end]), slot])).values()];
}

function containsAlignedRange(left: { start: number; end: number }, right: { start: number; end: number }): boolean {
  return left.start <= right.start && right.end <= left.end || right.start <= left.start && left.end <= right.end;
}

/**
 * 只签发来源位置相同证明，不读取名称或医疗字段，也不签发医疗字段覆盖权限。
 * 两次模型可能保存短行frame与整页frame；只有完整frame唯一连续嵌入、窄finding与真实栏目
 * 均能一对一映射到共同坐标，才能认同一个槽。finding只能向前补上下文，右边界须相同，
 * 不能把跨下一项目的扩写判重；标题必须在finding之前。其他扩写仍需唯一映射或保留未纳入。
 * 值、日期、左右侧和否定仍由逐项语义对账守护。
 */
export function directOriginalAlignedSourceFramesProveSameSlot(left: ResolvedReportSourceBinding,
  right: ResolvedReportSourceBinding): boolean {
  if (!verifiedSameOriginal(left, right)) return false;
  const a = verifiedDirectBindings.get(left)!;
  const b = verifiedDirectBindings.get(right)!;
  // 下游 canonical 投影也调用此证明；不能让共同整行再折叠已证明不同列的相同值。
  if (a.structuredSlot || b.structuredSlot) return Boolean(a.structuredSlot && b.structuredSlot
    && groundedSlotRelation(a.structuredSlot, b.structuredSlot) === 'same');
  if (!a.strictFindingSources || !b.strictFindingSources
    || !a.explicitHeadings || !b.explicitHeadings || !a.headings.length || !b.headings.length) return false;
  const leftSlots = uniqueDirectOriginalSlots(a.slots);
  const rightSlots = uniqueDirectOriginalSlots(b.slots);
  if (!leftSlots.length || leftSlots.length !== rightSlots.length
    || [...leftSlots, ...rightSlots].some((slot) => !slot.narrow)) return false;
  const coveredLeftHeadings = new Set<DirectOriginalHeadingProof>();
  const coveredRightHeadings = new Set<DirectOriginalHeadingProof>();
  const alignedHeadings = (headings: DirectOriginalHeadingProof[], slot: DirectOriginalSourceSlot,
    offset: number, frame: DirectOriginalAlignedFrames): Array<{ heading: DirectOriginalHeadingProof; start: number; end: number }> | null => {
    const relevant = headings.filter((heading) => heading.parent === slot.parent);
    if (!relevant.length) return null;
    const result: Array<{ heading: DirectOriginalHeadingProof; start: number; end: number }> = [];
    for (const heading of relevant) {
      if (!heading.trusted || !heading.text || heading.wholeReference && heading.role !== 'heading') return null;
      // 标题可有独立完整摘录；先对齐其完整frame，再投影已核实的子范围，不能只搜索标题短词。
      const headingFrame = alignDirectOriginalFrames(frame.sourceText, heading.sourceText);
      const common = uniqueReferenceRange(frame.sourceText, heading.text);
      if (!headingFrame || headingFrame.sourceText !== frame.sourceText || headingFrame.leftOffset !== 0
        || !common || common.compactStart !== heading.start + headingFrame.rightOffset
        || common.compactEnd !== heading.end + headingFrame.rightOffset
        || common.compactEnd > slot.start + offset) return null;
      result.push({ heading, start: common.compactStart, end: common.compactEnd });
    }
    return result;
  };
  const pairs = leftSlots.map((first) => rightSlots.flatMap((second, index) => {
    if (first.parent !== second.parent || first.role !== second.role) return [];
    let frame = alignDirectOriginalFrames(first.sourceText, second.sourceText);
    if (!frame) return [];
    // 允许真实标题frame包住短finding frame；各完整frame须形成唯一连续的包含链。
    // 没有任何现有完整frame能承载全部出处时，不拼接不同摘录来制造公共坐标。
    for (const heading of [...a.headings, ...b.headings].filter((heading) => heading.parent === first.parent)) {
      const expanded = alignDirectOriginalFrames(frame.sourceText, heading.sourceText);
      if (!expanded) return [];
      frame = { sourceText: expanded.sourceText, leftOffset: frame.leftOffset + expanded.leftOffset,
        rightOffset: frame.rightOffset + expanded.leftOffset };
    }
    if (!frame || first.end + frame.leftOffset !== second.end + frame.rightOffset || !containsAlignedRange(
      { start: first.start + frame.leftOffset, end: first.end + frame.leftOffset },
      { start: second.start + frame.rightOffset, end: second.end + frame.rightOffset })) return [];
    const leftHeadings = alignedHeadings(a.headings, first, frame.leftOffset, frame);
    const rightHeadings = alignedHeadings(b.headings, second, frame.rightOffset, frame);
    if (!leftHeadings || !rightHeadings || leftHeadings.length !== rightHeadings.length) return [];
    const matches = leftHeadings.map((heading) => rightHeadings
      .flatMap((other, headingIndex) => containsAlignedRange(heading, other) ? [headingIndex] : []));
    if (matches.some((match) => match.length !== 1) || new Set(matches.map((match) => match[0])).size !== rightHeadings.length) return [];
    return [{ index, leftHeadings, rightHeadings }];
  }));
  // 不挑第一个结果，也不以recordId或候选顺序化解一对多位置竞争。
  if (pairs.some((pair) => pair.length !== 1) || new Set(pairs.map((pair) => pair[0]!.index)).size !== rightSlots.length) return false;
  for (const [pair] of pairs) {
    pair!.leftHeadings.forEach(({ heading }) => coveredLeftHeadings.add(heading));
    pair!.rightHeadings.forEach(({ heading }) => coveredRightHeadings.add(heading));
  }
  return coveredLeftHeadings.size === a.headings.length && coveredRightHeadings.size === b.headings.length;
}

/**
 * 仅供医疗字段逐字相等后的重复记录判断，不签发覆盖、日期补齐或来源修订权限。
 * 兼容旧回执将单字段整行同时保存为标题和结果、新回执将真实前缀标签与结果分开。
 * 必须有一个完整共同来源：旧整行恰为新标题、纯分隔符及新结果，且只出现一次。
 * 旧标题若为上层章节，须由真实共同上下文证明其作用域，不能跨另一已知章节标题。
 * 有结构槽位、多来源、重复整行、附带另一项目或被截掉的结果均不能由此折叠。
 */
export function directOriginalContainedSourceProvesDuplicateSlot(incoming: ResolvedReportSourceBinding,
  existing: ResolvedReportSourceBinding): boolean {
  if (!verifiedSameOriginal(incoming, existing)) return false;
  const next = verifiedDirectBindings.get(incoming)!; const old = verifiedDirectBindings.get(existing)!;
  // 旧整行的 quote=null 是已核验整段引用，不是未知来源；仍须满足下面完整单行及唯一包含证明。
  if (next.structuredSlot || old.structuredSlot || !next.strictFindingSources || !old.trustedFindingSources
    || !next.explicitHeadings || !old.explicitHeadings || next.headings.length !== 1 || old.headings.length !== 1
    || next.slots.length !== 1 || old.slots.length !== 1) return false;
  const finding = next.slots[0]!; const previous = old.slots[0]!;
  const heading = next.headings[0]!; const previousHeading = old.headings[0]!;
  if (!finding.narrow || finding.parent !== previous.parent || finding.role !== previous.role
    || !heading.trusted || !previousHeading.trusted || heading.parent !== finding.parent
    || previousHeading.parent !== finding.parent || !heading.text) return false;
  const requiredFrames = [finding.sourceText, previous.sourceText, heading.sourceText, previousHeading.sourceText];
  let common: string | null = finding.sourceText;
  for (const source of requiredFrames.slice(1)) {
    const expanded: DirectOriginalAlignedFrames | null = common === null ? null : alignDirectOriginalFrames(common, source);
    common = expanded?.sourceText ?? null;
  }
  if (common === null) {
    // 旧章节标题与新字段前缀层级不同，只能由另一个真实整段上下文重新证明共同位置。
    // 没有共同全文时不拼接摘录；存在互不兼容的共同全文时也不任选一个放行。
    const contexts = [...new Set([...next.groundingContexts, ...old.groundingContexts]
      .filter((context) => context.parent === finding.parent
        && requiredFrames.every((source) => uniqueReferenceRange(context.text, source) !== null))
      .map((context) => context.text))];
    if (!contexts.length) return false;
    common = contexts[0]!;
    for (const context of contexts.slice(1)) {
      const expanded = alignDirectOriginalFrames(common, context);
      if (!expanded) return false;
      common = expanded.sourceText;
    }
  }
  const nextFrame = uniqueReferenceRange(common, finding.sourceText);
  const oldFrame = uniqueReferenceRange(common, previous.sourceText);
  if (!nextFrame || !oldFrame) return false;
  const currentRange = { start: finding.start + nextFrame.compactStart, end: finding.end + nextFrame.compactStart };
  const oldRange = { start: previous.start + oldFrame.compactStart, end: previous.end + oldFrame.compactStart };
  const oldText = previous.sourceText.slice(previous.start, previous.end);
  const rawOldText = previous.rawSourceText.slice(existing.units[0]!.segmentStart, existing.units[0]!.segmentEnd);
  if (/[\r\n]/u.test(rawOldText) || currentRange.end !== oldRange.end || currentRange.start <= oldRange.start) return false;
  const complete = uniqueReferenceRange(common, oldText);
  const label = uniqueReferenceRange(common, heading.text);
  if (!complete || complete.compactStart !== oldRange.start || complete.compactEnd !== oldRange.end
    || !label || label.compactStart !== oldRange.start || label.compactEnd > currentRange.start
    || !/^[\s:：=＝]*$/u.test(common.slice(label.compactEnd, currentRange.start))) return false;
  // 标题自身的完整出处也须唯一对齐，不能拿另一处相同短词作证明。
  for (const proof of [heading, previousHeading]) {
    const aligned = alignDirectOriginalFrames(common, proof.sourceText);
    const range = uniqueReferenceRange(common, proof.text);
    if (!aligned || aligned.sourceText !== common || aligned.leftOffset !== 0 || !range
      || range.compactStart !== aligned.rightOffset + proof.start
      || range.compactEnd !== aligned.rightOffset + proof.end) return false;
    if (proof === previousHeading && !(range.compactStart === oldRange.start && range.compactEnd === oldRange.end)
      && (range.compactEnd > oldRange.start || [...next.groundingHeadings, ...old.groundingHeadings]
        .filter((other) => other.parent === previous.parent && other.text !== previousHeading.text)
        .some((other) => referenceRanges(common, other.text).some((otherRange) =>
          range.compactEnd <= otherRange.compactStart && otherRange.compactStart < oldRange.start
          && otherRange.compactEnd <= oldRange.start)))) return false;
  }
  return true;
}

/**
 * 仅供全事实语义相等后的判重兼容，不提供字段覆盖、日期或条件补充权限。
 * 新增栏目必须由真实同页标题原文在共同 finding 全文中唯一定位；不拿名字/值猜映射。
 */
export function directOriginalHeadingAdditionProvesDuplicateSlot(incoming: ResolvedReportSourceBinding,
  existing: ResolvedReportSourceBinding): boolean {
  if (!verifiedSameOriginal(incoming, existing) || !sameDirectOriginalNarrowSourceSlots(incoming, existing)
    || existing.directOriginalField!.headingKeys.length !== 0 || incoming.directOriginalField!.headingKeys.length === 0) return false;
  const next = verifiedDirectBindings.get(incoming)!;
  const old = verifiedDirectBindings.get(existing)!;
  if (next.structuredSlot || old.structuredSlot) return false;
  if (!next.strictFindingSources || !old.strictFindingSources || !next.explicitHeadings
    || !next.headings.length || next.fieldName !== old.fieldName) return false;
  const slotKey = (slot: DirectOriginalSourceSlot) => JSON.stringify([slot.parent, slot.sourceText, slot.start, slot.end]);
  // 不能通过重复 finding 引用构成多对一“证明”，即使去重后范围恰好相同。
  if ([next, old].some((proof) => new Set(proof.slots.map(slotKey)).size !== proof.slots.length)) return false;
  const frames = [...new Map(next.slots.map((slot) => [JSON.stringify([slot.parent, slot.sourceText]), slot])).values()];
  return next.headings.every((heading) => {
    if (!heading.trusted || !heading.text || heading.wholeReference && heading.role !== 'heading') return false;
    const locations = frames.filter((frame) => frame.parent === heading.parent).flatMap((frame) => {
      const range = uniqueReferenceRange(frame.sourceText, heading.text);
      if (!range || range.compactStart === 0 && range.compactEnd === frame.sourceText.length) return [];
      const disjoint = next.slots.filter((slot) => slot.parent === frame.parent && slot.sourceText === frame.sourceText)
        .every((slot) => range.compactEnd <= slot.start || slot.end <= range.compactStart);
      return disjoint ? [frame] : [];
    });
    return locations.length === 1;
  });
}

/**
 * 专用显式映射的来源约束，不改变普通字段判重或几何定位。
 * 调用方仍须核验真实P03回执、旧行版本和一对一授权；这里仅证明旧原句在新原页全文中的唯一连续位置。
 */
export function directOriginalExpandedFindingProvesSourceRefinement(incoming: ResolvedReportSourceBinding,
  existing: ResolvedReportSourceBinding): boolean {
  if (!verifiedSameOriginal(incoming, existing)
    || existing.directOriginalField!.headingKeys.length !== 0 || incoming.directOriginalField!.headingKeys.length === 0) return false;
  const next = verifiedDirectBindings.get(incoming)!;
  const old = verifiedDirectBindings.get(existing)!;
  if (next.structuredSlot || old.structuredSlot) return false;
  const slotKey = (slot: DirectOriginalSourceSlot) => JSON.stringify([slot.parent, slot.sourceText, slot.start, slot.end]);
  // general evidence 与 primary finding 可保存同一引用两次；只在位置证明内合并完全相同的槽，不改历史证据。
  const uniqueSlots = (slots: DirectOriginalSourceSlot[]) => [...new Map(slots.map((slot) => [slotKey(slot), slot])).values()];
  const nextSlots = uniqueSlots(next.slots);
  const oldSlots = uniqueSlots(old.slots);
  if (!next.strictFindingSources || !old.strictFindingSources || !next.explicitHeadings || !next.headings.length
    || !nextSlots.length || nextSlots.length !== oldSlots.length || nextSlots.some((slot) => !slot.narrow)) return false;
  const used = new Set<number>();
  for (const previous of oldSlots) {
    const quote = previous.sourceText.slice(previous.start, previous.end);
    const matches = nextSlots.flatMap((slot, index) => {
      if (slot.parent !== previous.parent) return [];
      const range = uniqueReferenceRange(slot.sourceText, quote);
      return range && slot.start <= range.compactStart && range.compactEnd <= slot.end ? [index] : [];
    });
    if (matches.length !== 1 || used.has(matches[0]!)) return false;
    used.add(matches[0]!);
  }
  // 跨页栏目必须由独立、清晰的heading出处给出，不能把结果或整段context改称标题。
  return next.headings.every((heading) => heading.trusted && heading.role === 'heading' && heading.text
    && nextSlots.every((slot) => {
      if (slot.parent !== heading.parent) return true;
      if (slot.sourceText === heading.sourceText) return heading.end <= slot.start || slot.end <= heading.start;
      const headingInFinding = uniqueReferenceRange(slot.sourceText, heading.text);
      if (slot.sourceText.includes(heading.text) && !headingInFinding) return false;
      if (headingInFinding && !(headingInFinding.compactEnd <= slot.start || slot.end <= headingInFinding.compactStart)) return false;
      const findingText = slot.sourceText.slice(slot.start, slot.end);
      const findingInHeading = uniqueReferenceRange(heading.sourceText, findingText);
      if (heading.sourceText.includes(findingText) && !findingInHeading) return false;
      return !findingInHeading || findingInHeading.compactEnd <= heading.start || heading.end <= findingInHeading.compactStart;
    }));
}

/**
 * 仅供已核验真实P03一对一映射的正式 proof 路由使用，不是一般判重/跨槽覆盖许可。
 * 旧整行须在新槽位共同背景中唯一连续定位，并实际包含新槽位行标签；不按名称或值猜对应。
 * 医疗字段逐字不变、旧行CAS、用户锁和映射收据由 proof/保存层另外检查。
 */
export function directOriginalLegacyFieldCanUpgradeToGroundedSlot(incoming: ResolvedReportSourceBinding,
  existing: ResolvedReportSourceBinding): boolean {
  if (!verifiedSameOriginal(incoming, existing)) return false;
  const next = verifiedDirectBindings.get(incoming)!;
  const old = verifiedDirectBindings.get(existing)!;
  const grounded = next.structuredSlot;
  if (!grounded || old.structuredSlot || !next.trustedFindingSources || !old.trustedFindingSources
    || old.headings.some((heading) => !heading.trusted)) return false;
  const previousSlots = uniqueDirectOriginalSlots(old.slots);
  if (previousSlots.length !== 1 || previousSlots[0]!.parent !== grounded.parent) return false;
  const previous = previousSlots[0]!;
  const quote = previous.sourceText.slice(previous.start, previous.end);
  const range = uniqueReferenceRange(grounded.frame, quote);
  if (!range || !grounded.row.length || !grounded.row.every((anchor) =>
    range.compactStart <= anchor.start && anchor.end <= range.compactEnd)) return false;
  // 保留旧栏目意义；跨页或不在该表背景中的旧标题不能借新slot移到另一个章节。
  return old.headings.every((heading) => heading.parent === grounded.parent
    && uniqueReferenceRange(grounded.frame, heading.text) !== null);
}

/**
 * 仅正式来源修订可重绑条件出处；条件文本、状态、数量与顺序必须逐字不变。
 * 不能只删sourceSpanId后比较文字：每条旧/新引用还须同页、可信、完整frame唯一对齐且位置相同。
 */
export function directOriginalClinicalContextReferencesProvenEquivalent(incoming: ResolvedReportSourceBinding,
  existing: ResolvedReportSourceBinding, nextContext: ClinicalContext, oldContext: ClinicalContext): boolean {
  if (!verifiedSameOriginal(incoming, existing) || nextContext.version !== oldContext.version
    || nextContext.status !== oldContext.status || nextContext.conditions.length !== oldContext.conditions.length
    || nextContext.conditions.some((condition, index) => condition.quote !== oldContext.conditions[index]!.quote)) return false;
  const next = verifiedDirectBindings.get(incoming)!.conditions;
  const old = verifiedDirectBindings.get(existing)!.conditions;
  if (!next || !old || next.length !== nextContext.conditions.length || old.length !== oldContext.conditions.length) return false;
  const usedNext: DirectOriginalConditionProof[] = []; const usedOld: DirectOriginalConditionProof[] = [];
  const samePosition = (left: DirectOriginalConditionProof, right: DirectOriginalConditionProof): boolean => {
    if (left.parent !== right.parent) return false;
    const frame = alignDirectOriginalFrames(left.frame, right.frame);
    return Boolean(frame && left.range.start + frame.leftOffset === right.range.start + frame.rightOffset
      && left.range.end + frame.leftOffset === right.range.end + frame.rightOffset);
  };
  return next.every((condition, index) => {
    const previous = old[index]!;
    if (condition.sourceSpanId !== nextContext.conditions[index]!.sourceSpanId || condition.quote !== nextContext.conditions[index]!.quote
      || previous.sourceSpanId !== oldContext.conditions[index]!.sourceSpanId || previous.quote !== oldContext.conditions[index]!.quote
      || condition.parent !== previous.parent) return false;
    // 同页相同条件文字不等于同一位置；跨ID必须各有条件以外的真实定位背景。
    if (condition.sourceSpanId !== previous.sourceSpanId
      && (condition.range.start === 0 && condition.range.end === condition.frame.length
        || previous.range.start === 0 && previous.range.end === previous.frame.length)) return false;
    // 嵌套摘录也可能指向同一条件，不能仅靠不同frame字符串或excerpt ID冒充两处。
    if (usedNext.some((used) => samePosition(used, condition)) || usedOld.some((used) => samePosition(used, previous))) return false;
    usedNext.push(condition); usedOld.push(previous);
    return samePosition(condition, previous);
  });
}

function conditionReferenceProofs(candidate: ObservationCandidate, manifest: SourceManifest): DirectOriginalConditionProof[] | null {
  const conditions: DirectOriginalConditionProof[] = [];
  for (const condition of candidate.clinicalContext?.conditions ?? []) {
    const span = manifest.spans.find((item) => item.id === condition.sourceSpanId);
    if (!span?.modelEvidence || !isDirectOriginalConditionSourceRole(span.modelEvidence.role)
      || resolveDirectOriginalWholeExcerptQuote(manifest, manifest.spans[0]?.documentId ?? '', condition.sourceSpanId) === null) return null;
    const range = uniqueReferenceRange(span.quote!, condition.quote);
    if (!range) return null;
    conditions.push({ sourceSpanId: condition.sourceSpanId, quote: condition.quote,
      parent: JSON.stringify([span.modelEvidence.parentSourceSpanId, span.page]), frame: compact(span.quote!),
      range: { start: range.compactStart, end: range.compactEnd } });
  }
  return conditions;
}

/** 只比较同一完整实际摘录内已唯一定位的引用范围，不拿候选结果、日期或部位猜槽位。 */
function directOriginalSourceSlotsProvenDisjoint(left: ResolvedReportSourceBinding, right: ResolvedReportSourceBinding): boolean {
  const leftProof = verifiedDirectBindings.get(left)!;
  const rightProof = verifiedDirectBindings.get(right)!;
  const a = leftProof.slots;
  const b = rightProof.slots;
  return a.length > 0 && b.length > 0 && a.every((first) => b.every((second) => {
    if (first.parent !== second.parent) return true;
    const frame = alignDirectOriginalFrames(first.sourceText, second.sourceText);
    if (frame) return first.end + frame.leftOffset <= second.start + frame.rightOffset
      || second.end + frame.rightOffset <= first.start + frame.leftOffset;
    if (!leftProof.trustedFindingSources || !rightProof.trustedFindingSources) return false;
    // 旧局部摘录与新行列槽位只在原件实际共同全文中对齐，不能拼接两个短句制造位置。
    const contexts = [...new Set([...leftProof.positionContexts, ...rightProof.positionContexts]
      .filter((context) => context.parent === first.parent && context.text.includes(first.sourceText)
        && context.text.includes(second.sourceText)).map((context) => context.text))];
    return contexts.length > 0 && contexts.every((context) => {
      const firstRange = uniqueReferenceRange(context, first.sourceText);
      const secondRange = uniqueReferenceRange(context, second.sourceText);
      // 任一真实共同全文含重复位置时不能挑另一个有利版本放行。
      return Boolean(firstRange && secondRange
        && (first.end + firstRange.compactStart <= second.start + secondRange.compactStart
          || second.end + secondRange.compactStart <= first.start + firstRange.compactStart));
    });
  }));
}

/** 同一清晰摘录可承载多个模型已明示的不同字段；不以数值、日期或localKey分字段。 */
export function directOriginalFieldsProvenDistinct(left: ResolvedReportSourceBinding, right: ResolvedReportSourceBinding): boolean {
  if (!verifiedSameOriginal(left, right)) return false;
  const leftSlot = verifiedDirectBindings.get(left)!.structuredSlot;
  const rightSlot = verifiedDirectBindings.get(right)!.structuredSlot;
  if (leftSlot && rightSlot) {
    const relation = groundedSlotRelation(leftSlot, rightSlot);
    return relation === 'distinct' || relation === 'complementary';
  }
  if (directOriginalSourceSlotsProvenDisjoint(left, right)) return true;
  // 新槽位不能让没有行列证明的旧整行自动变为另一个字段。
  if (leftSlot || rightSlot) return false;
  if (directOriginalAlignedSourceFramesProveSameSlot(left, right)) return false;
  if (sameDirectOriginalNarrowSourceSlots(left, right)) return false;
  if (left.directOriginalField!.fieldKey === right.directOriginalField!.fieldKey) return false;
  const a = verifiedDirectBindings.get(left)!;
  const b = verifiedDirectBindings.get(right)!;
  if (a.fieldName !== b.fieldName) return true;
  if (a.parents.every((parent) => !b.parents.includes(parent))) return true;
  // 已有完整frame的包含或重叠关系时，标题文字长短不同不是两个位置的证明。
  // 多次出现的frame同样不选occurrence；保留为需要唯一来源映射，而不是退回新增。
  if (a.slots.some((first) => first.narrow && b.slots.some((second) => second.narrow
    && first.parent === second.parent
    && (referenceRanges(first.sourceText, second.sourceText).length > 0
      || referenceRanges(second.sourceText, first.sourceText).length > 0)))) return false;
  // 缺少旧栏目或只新增了共同栏目的补充引用，不证明这是另一个字段。
  // 两个同名结果只有各自明确而不同的栏目锚点，才可在同页并存。
  return left.directOriginalField!.headingKeys.length > 0 && right.directOriginalField!.headingKeys.length > 0
    && left.directOriginalField!.headingKeys.every((key) => !right.directOriginalField!.headingKeys.includes(key));
}

/** 模型负责识别字段名与归属；应用以真实栏目、原页及唯一引用建立内部字段身份。 */
export function resolveDirectOriginalSourceBinding(candidate: ObservationCandidate, manifest: SourceManifest): ReportSourceBindingResolution {
  return resolveDirectOriginalSourceBindingWithRoles(candidate, manifest, false);
}

/**
 * 仅恢复已保存的完整角色集合（包括空栏目），不把历史合并证据中的条件再次猜成栏目。
 * 所有出处重新核验，完整绑定须与旧JSON逐字指纹相同；JSON本身不恢复任何proof权限。
 */
export function resolveDirectOriginalSourceBindingFromStoredRoles(candidate: ObservationCandidate,
  manifest: SourceManifest, saved: ResolvedReportSourceBinding): ReportSourceBindingResolution {
  const restored = resolveDirectOriginalSourceBindingWithRoles(candidate, manifest, true);
  if (restored.status !== 'resolved') return restored;
  const legacy = projectDirectOriginalLegacyWhitespaceBindingIdentity(restored.binding);
  return digest(restored.binding) === digest(saved) || legacy !== null && digest(legacy) === digest(saved)
    ? restored : { status: 'unresolved', reason: 'direct_original_stored_roles_changed' };
}

function resolveDirectOriginalSourceBindingWithRoles(candidate: ObservationCandidate, manifest: SourceManifest,
  storedHeadingSet: boolean): ReportSourceBindingResolution {
  const documentId = manifest.spans[0]?.documentId;
  if (!sourceManifestSchema.safeParse(manifest).success || !documentId
    || manifest.spans.some((span) => span.documentId !== documentId)) {
    return { status: 'unresolved', reason: 'direct_original_source_scope_invalid' };
  }
  const refs = primaryFindingRefs(candidate, manifest);
  const headings = headingRefs(candidate, manifest, storedHeadingSet);
  const structuredSlot = resolveGroundedSlot(candidate, manifest);
  if (candidate.sourceBinding?.structuredSlot && !structuredSlot) {
    return { status: 'unresolved', reason: 'direct_original_structured_slot_invalid' };
  }
  if (!refs.length || evidenceProblems(candidate.evidence, manifest).length > 0
    || evidenceProblems(candidate.clinicalContext?.conditions ?? [], manifest, conditionSourceRoles).length > 0
    || evidenceProblems(candidate.sourceBinding?.findingEvidence ?? [], manifest, ['finding', 'instruction']).length > 0
    || evidenceProblems(refs, manifest, ['finding', 'instruction']).length > 0
    || headingEvidenceProblems(candidate, candidate.sourceBinding?.headingEvidence ?? [], manifest).length > 0
    || headingEvidenceProblems(candidate, headings, manifest).length > 0) {
    return { status: 'unresolved', reason: 'direct_original_finding_source_required' };
  }
  const units: ReportSourceUnit[] = [];
  const identities: unknown[] = [];
  const parentKeys = new Set<string>();
  const slots: DirectOriginalSourceSlot[] = [];
  let strictFindingSources = true;
  let trustedFindingSources = true;
  for (const ref of refs) {
    const span = manifest.spans.find((item) => item.id === ref.sourceSpanId)!;
    const provenance = span.modelEvidence!;
    let range = findingReferenceRange(candidate, manifest, ref);
    // 重复裸数值可由同页真实行列锚点消歧；这里保留整段来源，不伪造字符偏移或 occurrence。
    if (!range && structuredSlot && typeof ref.quote === 'string' && referenceRanges(span.quote!, ref.quote).length > 0) {
      range = uniqueReferenceRange(span.quote!, null);
    }
    if (!range) return { status: 'unresolved', reason: 'direct_original_finding_quote_not_unique' };
    units.push({ sourceSpanId: span.id, page: span.page, spanKind: span.spanKind, blockId: span.blockId,
      lineStart: span.lineStart, lineEnd: span.lineEnd, segmentStart: range.start, segmentEnd: range.end });
    const parent = JSON.stringify([provenance.parentSourceSpanId, span.page]);
    parentKeys.add(parent);
    const sourceText = compact(span.quote!);
    identities.push([parent, provenance.role, sourceText, range.compactStart, range.compactEnd]);
    slots.push({ parent, role: provenance.role, sourceText, rawSourceText: span.quote!, start: range.compactStart, end: range.compactEnd,
      narrow: range.compactStart > 0 || range.compactEnd < sourceText.length });
    const trustedFinding = resolveDirectOriginalWholeExcerptQuote(manifest, documentId, ref.sourceSpanId) !== null;
    trustedFindingSources &&= trustedFinding;
    strictFindingSources &&= typeof ref.quote === 'string' && ref.quote.trim().length > 0 && trustedFinding;
  }
  const headingKeys: string[] = [];
  const headingProofs: DirectOriginalHeadingProof[] = [];
  for (const ref of headings) {
    const span = manifest.spans.find((item) => item.id === ref.sourceSpanId)!;
    const range = uniqueReferenceRange(span.quote!, ref.quote) ?? resolvedSlotHeadingRange(candidate, manifest, ref);
    if (!range) return { status: 'unresolved', reason: 'direct_original_heading_quote_not_unique' };
    headingKeys.push(digest([span.modelEvidence!.parentSourceSpanId, span.page,
      compact(span.quote!.slice(range.start, range.end))]));
    headingProofs.push({ parent: JSON.stringify([span.modelEvidence!.parentSourceSpanId, span.page]),
      text: compact(span.quote!.slice(range.start, range.end)), rawText: span.quote!.slice(range.start, range.end), sourceText: compact(span.quote!),
      start: range.compactStart, end: range.compactEnd, role: span.modelEvidence!.role, wholeReference: ref.quote === null,
      trusted: resolveDirectOriginalWholeExcerptQuote(manifest, documentId, ref.sourceSpanId) !== null });
  }
  const uniqueHeadingKeys = [...new Set(headingKeys)].sort();
  const fieldKey = structuredSlot
    ? digest([manifest.sourceObjectId, manifest.sha256, documentId, 'grounded-source-slot-v1', structuredSlot])
    : digest([manifest.sourceObjectId, manifest.sha256, documentId,
      [...parentKeys].sort(), compact(candidate.originalName).toLowerCase(), uniqueHeadingKeys]);
  const sourceIdentities = [...new Set(identities.map((identity) => JSON.stringify(identity)))].sort();
  const binding: ResolvedReportSourceBinding = { version: 1, sourceObjectId: manifest.sourceObjectId,
    sourceSha256: manifest.sha256, documentId, normalizerVersion: manifest.normalizerVersion,
    sourceViewId: `codex-original:${manifest.sha256}`, key: digest([fieldKey, sourceIdentities]), units,
    directOriginalField: { version: 1, fieldKey, headingKeys: uniqueHeadingKeys,
      ...(structuredSlot ? { structuredSlot: structuredClone(candidate.sourceBinding!.structuredSlot!) } : {}) } };
  const groundingContexts: Array<{ parent: string; text: string }> = [];
  const positionContexts: Array<{ parent: string; text: string }> = [];
  const groundingHeadings: Array<{ parent: string; text: string }> = [];
  // 先做纯字面候选过滤，只给有用途的完整共同全文重证回执；不按名字、数值或医学语义补出处。
  for (const span of manifest.spans) {
    if (!span.quote || !span.modelEvidence || !['finding', 'instruction', 'context'].includes(span.modelEvidence.role)) continue;
    const parent = JSON.stringify([span.modelEvidence.parentSourceSpanId, span.page]);
    if (!parentKeys.has(parent)) continue;
    const text = compact(span.quote);
    const required = slots.filter((slot) => slot.parent === parent).map((slot) => slot.sourceText);
    if (!required.length || !required.every((source) => text.includes(source))
      || resolveDirectOriginalWholeExcerptQuote(manifest, documentId, span.id) === null) continue;
    // “结果位置互斥”和“旧章节下同一字段”的证明不同。前者不要求把无关完整标题框架也嵌入表格。
    positionContexts.push({ parent, text });
    if (!headingProofs.filter((heading) => heading.parent === parent).every((heading) => text.includes(heading.sourceText))) continue;
    groundingContexts.push({ parent, text });
  }
  for (const span of manifest.spans) {
    if (!span.quote || span.modelEvidence?.role !== 'heading') continue;
    const parent = JSON.stringify([span.modelEvidence.parentSourceSpanId, span.page]);
    if (!parentKeys.has(parent)) continue;
    const text = compact(span.quote);
    if (groundingContexts.some((context) => context.parent === parent && context.text.includes(text))
      && resolveDirectOriginalWholeExcerptQuote(manifest, documentId, span.id) !== null) groundingHeadings.push({ parent, text });
  }
  verifiedDirectBindings.set(binding, { fingerprint: digest(binding), fieldName: compact(candidate.originalName).toLowerCase(),
    originalName: candidate.originalName, parents: [...parentKeys].sort(), slots, strictFindingSources, trustedFindingSources,
    explicitHeadings: Boolean(candidate.sourceBinding?.headingEvidence.some((ref) => ref.sourceRole !== 'duplicate_source')),
    headings: headingProofs, structuredSlot, conditions: conditionReferenceProofs(candidate, manifest), groundingContexts, positionContexts, groundingHeadings });
  return { status: 'resolved', binding };
}
