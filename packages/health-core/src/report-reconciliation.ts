import type { ClinicalContext, ObservationCandidate, SourceManifest, SourceSpan } from '@contracts';
import { createHash } from 'node:crypto';
import { directOriginalFieldsProvenDistinct, isVerifiedDirectOriginalSourceBinding,
  sameDirectOriginalField, directOriginalHeadingAdditionProvesDuplicateSlot,
  directOriginalContainedSourceProvesDuplicateSlot,
  directOriginalExpandedFindingProvesSourceRefinement, directOriginalLegacyFieldCanUpgradeToGroundedSlot,
  directOriginalClinicalContextReferencesProvenEquivalent } from './direct-original-validation.js';

/** 来源单位由应用从已核验的原文位置派生，不由模型命名。 */
export interface ReportSourceUnit {
  sourceSpanId: string;
  page: number | null;
  spanKind: SourceSpan['spanKind'];
  blockId: string | null;
  lineStart: number | null;
  lineEnd: number | null;
  segmentStart: number;
  segmentEnd: number;
}

export interface ResolvedReportSourceBinding {
  version: 1;
  sourceObjectId: string;
  documentId: string;
  sourceSha256: string;
  normalizerVersion: string;
  // 不同 OCR 视图的文本偏移不可直接比较；跨版本必须另有可信映射。
  sourceViewId: string;
  units: ReportSourceUnit[];
  key: string;
  /** 应用根据已核验的原件模型出处生成，不接受模型或保存JSON自行声明的字段身份。 */
  directOriginalField?: { version: 1; fieldKey: string; headingKeys: string[];
    /** 保存真实模型引用供下次重证；该JSON本身不提供已核验权限。 */
    structuredSlot?: NonNullable<ObservationCandidate['sourceBinding']>['structuredSlot'] };
}

export type ReportSourceBindingResolution =
  | { status: 'resolved'; binding: ResolvedReportSourceBinding }
  | { status: 'unresolved'; reason: string };

interface IndexedText { text: string; offsets: number[] }

function indexedText(value: string, ignoreLayout = false, keepWhitespace = false): IndexedText {
  const text: string[] = [];
  const offsets: number[] = [];
  // 按原始字符映射，NFKC 展开后仍能回到原件文本的位置。
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]!.normalize('NFKC').toLowerCase();
    for (const normalized of character) {
      // | 已证明列/项目边界，不能为了定位而拼出跨列的结果。
      if ((!keepWhitespace && /\s/u.test(normalized)) || (ignoreLayout && /[,，;；:：。、]/u.test(normalized))) continue;
      text.push(normalized);
      offsets.push(index);
    }
  }
  return { text: text.join(''), offsets };
}

function matchingIntervals(source: string, cited: string, ignoreLayout = false): Array<{ start: number; end: number }> {
  const indexed = indexedText(source, ignoreLayout);
  const needle = indexedText(cited, ignoreLayout).text;
  if (!needle) return [];
  const intervals: Array<{ start: number; end: number }> = [];
  let from = 0;
  while (from < indexed.text.length) {
    const start = indexed.text.indexOf(needle, from);
    if (start < 0) break;
    intervals.push({ start: indexed.offsets[start]!, end: indexed.offsets[start + needle.length - 1]! + 1 });
    from = start + 1;
  }
  return intervals;
}

function uniqueInterval(source: string, cited: string, ignoreLayout = false): { start: number; end: number } | null {
  const intervals = matchingIntervals(source, cited, ignoreLayout);
  return intervals.length === 1 ? intervals[0]! : null;
}

/** 部分页不可读时，仅可信几何证明的独立引文可以用于来源校验。 */
export function sourceQuoteHasReliableVisualRows(span: SourceSpan, quote: string | null): boolean {
  if (span.readability !== 'partial' || !span.quote || !quote
    || !['page', 'image'].includes(span.spanKind) || !span.visualEvidence) return false;
  const visual = span.visualEvidence;
  if (!visual.rows.length) return false;
  const reconstructed = visual.rows.map((row) => row.text).join('\n');
  // 不能把与实际来源不一致的行/框元数据作为“原件证明”。
  if (indexedText(reconstructed).text !== indexedText(span.quote).text) return false;
  const interval = uniqueInterval(reconstructed, quote);
  if (!interval) return false;
  let offset = 0;
  const citedRows = visual.rows.filter((row) => {
    const start = offset;
    offset += row.text.length + 1;
    return start < interval.end && start + row.text.length > interval.start;
  });
  if (!citedRows.length || citedRows.some((row) => !row.boxes.length
    || row.boxes.some((box) => box.confidence < 0.3))) return false;
  // 无法识别的框只要落在当前行的竖直带，就可能是当前值前的否定词、
  // 左右侧或另一列。不能猜它无关；其他完全分离的行不影响该引文。
  return citedRows.every((row) => visual.omittedBoxes.every((omitted) => (
    Math.min(row.bounds[1] + row.bounds[3], omitted.bounds[1] + omitted.bounds[3])
      <= Math.max(row.bounds[1], omitted.bounds[1])
  )));
}

function resultInterval(source: string, candidate: ObservationCandidate, findingSourceSpanId: string): { start: number; end: number } | null {
  if (!candidate.value.rawText) return null;
  const intervals = matchingIntervals(source, candidate.value.rawText, true);
  if (candidate.value.kind !== 'numeric') return intervals.length === 1 ? intervals[0]! : null;
  // 显式绑定时只按已核验的原文栏目引用排除标题内数字，不能由模型
  // 的展示/候选名称决定定位。旧契约没有分离栏目时才保守使用原名。
  const headingQuotes = candidate.sourceBinding
    ? candidate.sourceBinding.headingEvidence.filter((reference) => reference.sourceSpanId === findingSourceSpanId)
      .map((reference) => reference.quote).filter((quote): quote is string => quote !== null)
    : [candidate.originalName];
  const actualHeadingIntervals = headingQuotes.flatMap((quote) => matchingIntervals(source, quote))
    // 模型声明“这是标题”并不能改变它的原文角色。只有紧引用开头的
    // 实际标题区间可以排除标签数字；后方任意结果不能被标成标题后移除。
    .filter((heading) => {
      if (!candidate.sourceBinding) return true;
      if (source.slice(0, heading.start).trim() !== '') return false;
      const unit = indexedText(candidate.unitRaw ?? '').text.replace(/[μµ]/gu, 'u').replace(/[×*]/gu, 'x');
      const headingText = indexedText(source.slice(heading.start, heading.end)).text.replace(/[μµ]/gu, 'u').replace(/[×*]/gu, 'x');
      // 引文开头也可能是第一个测量结果；包含该结果单位的区间不能
      // 被模型改称标题后移除。确有单位标注的标题可收紧 finding 引用消歧。
      return !unit || !headingText.includes(unit);
    });
  const findings = intervals.filter((interval) => {
    // 只排除原文已经证明的标签区间，标签文字不进入永久编号。
    if (actualHeadingIntervals.some((heading) => heading.start <= interval.start && heading.end >= interval.end)) return false;
    const before = source.slice(0, interval.start).slice(-1);
    const after = source.slice(interval.end, interval.end + 2);
    // 防止 B12 中的 12 或 120 中的 20 被当成独立结果。
    if (/[\da-z.]/iu.test(before) || /^(?:\d|\.\d|[eE][+-]?\d)/u.test(after)) return false;
    return true;
  });
  return findings.length === 1 ? findings[0]! : null;
}

function numericUnitInterval(source: string, interval: { start: number; end: number }, unitRaw: string | null): { start: number; end: number } | null {
  const indexed = indexedText(source.slice(interval.start, interval.end), false, true);
  const unitRanges: Array<{ start: number; end: number }> = [];
  if (unitRaw) {
    // 只排除 unitRaw 已在这个实际引用中完整出现的单位范围，
    // 不枚举单位、不把任意第二个数字猜成指数或参考值。
    const unitSource = indexedText(source.slice(interval.start, interval.end));
    const normalizedUnitSource = unitSource.text.replace(/[μµ]/gu, 'u').replace(/[×*]/gu, 'x');
    const normalizedUnit = indexedText(unitRaw).text.replace(/[μµ]/gu, 'u').replace(/[×*]/gu, 'x');
    let from = 0;
    while (normalizedUnit && from < normalizedUnitSource.length) {
      const start = normalizedUnitSource.indexOf(normalizedUnit, from);
      if (start < 0) break;
      const end = start + normalizedUnit.length;
      const before = normalizedUnitSource[start - 1] ?? '';
      const after = normalizedUnitSource[end] ?? '';
      // 必须是完整单位，不能从 kg/m2 借 m2 或从完整单位截取前缀。
      if (!/[a-zμµ/._^]/iu.test(before) && !/[\da-zμµ/._^]/iu.test(after)) {
        unitRanges.push({ start: unitSource.offsets[start]!, end: unitSource.offsets[end - 1]! + 1 });
      }
      from = start + 1;
    }
  }
  const tokens = [...indexed.text.matchAll(/[+-]?(?:(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?/gu)]
    .filter((token) => {
      const start = indexed.offsets[token.index!]!;
      const end = indexed.offsets[token.index! + token[0].length - 1]! + 1;
      return !unitRanges.some((unit) => unit.start <= start && unit.end >= end);
    });
  if (tokens.length !== 1) return null;
  const token = tokens[0]!;
  return { start: interval.start + indexed.offsets[token.index!]!,
    end: interval.start + indexed.offsets[token.index! + token[0].length - 1]! + 1 };
}

function isDelimiter(source: string, index: number): boolean {
  const character = source[index]!;
  if (/[\r\n|。；;]/u.test(character)) return true;
  // 同段的不同观察可由真实逗号分隔；数字内部的千位逗号不能切开。
  return /[,，]/u.test(character) && !(/\d/u.test(source[index - 1] ?? '') && /\d/u.test(source[index + 1] ?? ''));
}

function sourceSegments(source: string, interval: { start: number; end: number }): Array<{ start: number; end: number }> {
  const segments: Array<{ start: number; end: number }> = [];
  let start = 0;
  for (let index = 0; index <= source.length; index += 1) {
    if (index !== source.length && !isDelimiter(source, index)) continue;
    let meaningfulStart = start;
    let meaningfulEnd = index;
    while (meaningfulStart < meaningfulEnd && /\s/u.test(source[meaningfulStart]!)) meaningfulStart += 1;
    while (meaningfulEnd > meaningfulStart && /\s/u.test(source[meaningfulEnd - 1]!)) meaningfulEnd -= 1;
    if (meaningfulStart < meaningfulEnd && meaningfulStart < interval.end && meaningfulEnd > interval.start) {
      segments.push({ start: meaningfulStart, end: meaningfulEnd });
    }
    start = index + 1;
  }
  return segments;
}

function unitKey(unit: ReportSourceUnit): string {
  return JSON.stringify([unit.page, unit.spanKind, unit.blockId, unit.lineStart, unit.lineEnd,
    unit.sourceSpanId, unit.segmentStart]);
}

/**
 * 只负责定位，不代替数值/单位/否定词等接纳校验。
 * 栏目证据不参与身份；整页依据须缩到唯一的实际发现位置，否则保留疑点。
 */
export function resolveReportSourceBinding(candidate: ObservationCandidate, manifest: SourceManifest): ReportSourceBindingResolution {
  const spans = new Map(manifest.spans.map((span) => [span.id, span]));
  const findingEvidence = candidate.sourceBinding?.findingEvidence
    ?? candidate.evidence.filter((reference) => reference.sourceRole !== 'duplicate_source');
  if (!findingEvidence.length) return { status: 'unresolved', reason: 'finding_evidence_missing' };
  const explicitReferences = [...(candidate.sourceBinding?.headingEvidence ?? []), ...(candidate.sourceBinding?.findingEvidence ?? [])];
  if (explicitReferences.some((reference) => !candidate.evidence.some((attached) => {
    if (attached.sourceSpanId !== reference.sourceSpanId) return false;
    if (attached.quote === reference.quote) return true;
    const span = spans.get(reference.sourceSpanId);
    // 已校验的同一连续长摘录可包含标题/发现短摘录，无须机械重复。
    // 不跨 span、不同位置或多份摘录拼接，也不让未核验长引文提供出处。
    return Boolean(span?.quote && attached.quote && reference.quote
      && (span.readability === 'clear' || sourceQuoteHasReliableVisualRows(span, attached.quote))
      && indexedText(span.quote).text.includes(indexedText(attached.quote).text)
      && indexedText(attached.quote).text.includes(indexedText(reference.quote).text));
  }))) return { status: 'unresolved', reason: 'source_binding_evidence_not_attached' };
  for (const reference of candidate.sourceBinding?.headingEvidence ?? []) {
    const span = spans.get(reference.sourceSpanId);
    if (!span?.quote || !reference.quote || !indexedText(span.quote).text.includes(indexedText(reference.quote).text)) {
      return { status: 'unresolved', reason: 'heading_evidence_unverified' };
    }
    const reliableContainingQuote = candidate.evidence.some((attached) => attached.sourceSpanId === reference.sourceSpanId
      && attached.quote && indexedText(attached.quote).text.includes(indexedText(reference.quote!).text)
      && sourceQuoteHasReliableVisualRows(span, attached.quote));
    if (span.readability !== 'clear' && !sourceQuoteHasReliableVisualRows(span, reference.quote) && !reliableContainingQuote) {
      return { status: 'unresolved', reason: 'heading_evidence_unverified' };
    }
  }

  const units: ReportSourceUnit[] = [];
  for (const reference of findingEvidence) {
    const span = spans.get(reference.sourceSpanId);
    if (!span || span.readability === 'unreadable' || !span.quote
      || (span.readability === 'partial' && !sourceQuoteHasReliableVisualRows(span, reference.quote))) {
      if (!candidate.sourceBinding) continue;
      return { status: 'unresolved', reason: 'finding_source_unreadable' };
    }
    const source = span.quote;
    const citedInterval = reference.quote === null ? { start: 0, end: source.length }
      : uniqueInterval(source, reference.quote);
    if (!citedInterval) {
      if (!candidate.sourceBinding) continue;
      return { status: 'unresolved', reason: 'finding_quote_not_unique' };
    }

    const cited = source.slice(citedInterval.start, citedInterval.end);
    let locatedResult = resultInterval(cited, candidate, span.id);
    if (locatedResult) {
      locatedResult = { start: citedInterval.start + locatedResult.start, end: citedInterval.start + locatedResult.end };
    } else if (candidate.sourceBinding && reference.quote !== null
      && !['page', 'image'].includes(span.spanKind)
      && sourceSegments(source, citedInterval).length === 1) {
      // 已经具体到独立来源单位的显式绑定可保留空白或排版等价结果。
      // 是否真为空白及结果语义仍须经过独立接纳校验。
      locatedResult = citedInterval;
    } else {
      // 旧 evidence 混有日期和章节条件；只有实际对应结果的引用参与来源身份。
      if (!candidate.sourceBinding) continue;
      return { status: 'unresolved', reason: 'finding_result_not_unique' };
    }
    // 数值的物理 token 是同一行内的字段位置：血压两个分量或并排指标
    // 不会因为共用一行而变成同项。token 内容本身不进入身份。
    const numericInterval = candidate.value.kind === 'numeric' ? numericUnitInterval(source, locatedResult, candidate.unitRaw) : null;
    if (candidate.value.kind === 'numeric' && !numericInterval) return { status: 'unresolved', reason: 'finding_numeric_token_ambiguous' };
    const segments = numericInterval ? [numericInterval] : sourceSegments(source, locatedResult);
    if (!segments.length) return { status: 'unresolved', reason: 'finding_position_missing' };
    for (const segment of segments) {
      units.push({ sourceSpanId: span.id, page: span.page, spanKind: span.spanKind, blockId: span.blockId,
        lineStart: span.lineStart, lineEnd: span.lineEnd, segmentStart: segment.start, segmentEnd: segment.end });
    }
  }
  if (!units.length) return { status: 'unresolved', reason: 'finding_result_not_unique' };
  const uniqueUnits = [...new Map(units.map((unit) => [unitKey(unit), unit])).values()]
    .sort((left, right) => unitKey(left).localeCompare(unitKey(right)));
  const documentIds = new Set(uniqueUnits.map((unit) => spans.get(unit.sourceSpanId)!.documentId));
  if (documentIds.size !== 1 || candidate.sourceBinding?.headingEvidence.some((reference) =>
    !documentIds.has(spans.get(reference.sourceSpanId)!.documentId))) return { status: 'unresolved', reason: 'finding_scope_mismatch' };
  const documentId = [...documentIds][0]!;
  // 同一个发现被跨引文引用时仍然只对应同一组位置。名称、结果文字及 localKey 均不进入 key。
  const key = JSON.stringify([manifest.sourceObjectId, manifest.sha256, documentId,
    manifest.id, uniqueUnits.map(unitKey)]);
  return { status: 'resolved', binding: { version: 1, sourceObjectId: manifest.sourceObjectId,
    documentId,
    sourceSha256: manifest.sha256, normalizerVersion: manifest.normalizerVersion,
    sourceViewId: manifest.id, units: uniqueUnits, key } };
}

export interface ReportReconciliationFact {
  // 仅用于显示与审计，不参与事实身份或语义相等。
  originalName?: string;
  valueKind: ObservationCandidate['value']['kind'];
  rawText: string;
  decimalValue: string | null;
  qualifier: string | null;
  unit: string | null;
  referenceRange: string | null;
  abnormalFlag?: string | null;
  specimen?: string | null;
  method?: string | null;
  bodySite?: string | null;
  clinicalDate: string | null;
  clinicalContext?: ClinicalContext | null;
}

export interface BoundReportFact {
  // 调用方回执 ID；不是事实身份。
  recordId: string;
  fact: ReportReconciliationFact;
  binding: ResolvedReportSourceBinding | null;
  /** 应用从现存原件引用重建的页范围；不是模型自报页码。缺失/未知继续保护全原件。 */
  sourcePageScope?: ReportSourcePageScope | null;
}
export interface ReportSourcePageScope {
  documentId: string;
  sourceObjectId: string;
  sourceSha256: string;
  pages: number[];
}

export function reportSourcePagesProvenDistinct(binding: ResolvedReportSourceBinding,
  scope: ReportSourcePageScope | null | undefined): boolean {
  return Boolean(scope && isVerifiedDirectOriginalSourceBinding(binding)
    && scope.documentId === binding.documentId && scope.sourceObjectId === binding.sourceObjectId
    && scope.sourceSha256 === binding.sourceSha256 && scope.pages.length > 0
    && scope.pages.every((page) => Number.isInteger(page) && page > 0)
    && binding.units.length > 0 && binding.units.every((unit) => unit.page !== null
      && Number.isInteger(unit.page) && unit.page > 0 && !scope.pages.includes(unit.page)));
}

/** 只代表应用已核验回执后的单次显式来源映射，不提供医疗值、日期或条件修正权限。 */
export interface DirectOriginalSourceRefinementProof {
  readonly incomingRecordId: string;
  readonly existingRecordId: string;
}

const verifiedSourceRefinementProofs = new WeakSet<DirectOriginalSourceRefinementProof>();
const sourceRefinementFingerprints = new WeakMap<DirectOriginalSourceRefinementProof, { incoming: string; existing: string }>();
const sourceRefinementMedicalFields = ['originalName', 'valueKind', 'rawText', 'decimalValue', 'qualifier', 'unit',
  'referenceRange', 'abnormalFlag', 'specimen', 'method', 'bodySite', 'clinicalDate'] as const;
const boundFactFingerprint = (record: BoundReportFact): string => createHash('sha256').update(JSON.stringify(record)).digest('hex');

function sourceRefinementMedicalFieldsUnchanged(incoming: BoundReportFact, existing: BoundReportFact): boolean {
  if (!sourceRefinementMedicalFields.every((field) => (incoming.fact[field] ?? null) === (existing.fact[field] ?? null))) return false;
  const nextContext = incoming.fact.clinicalContext ?? null;
  const oldContext = existing.fact.clinicalContext ?? null;
  if (JSON.stringify(nextContext) === JSON.stringify(oldContext)) return true;
  return Boolean(nextContext && oldContext && incoming.binding && existing.binding
    && directOriginalClinicalContextReferencesProvenEquivalent(incoming.binding, existing.binding, nextContext, oldContext));
}

/**
 * 只能在应用核验同原件、旧行CAS和真实P03回执后调用；JSON或模型自述不能恢复这个证明。
 * 核心仍核对可信原句/栏目及所有原始医疗字段，不能以同名同值构造映射。
 */
export function createDirectOriginalSourceRefinementProof(incoming: BoundReportFact,
  existing: BoundReportFact): DirectOriginalSourceRefinementProof | null {
  if (!incoming.recordId.trim() || !existing.recordId.trim() || incoming.recordId === existing.recordId
    || !incoming.binding || !existing.binding || !sourceRefinementMedicalFieldsUnchanged(incoming, existing)
    || !(directOriginalExpandedFindingProvesSourceRefinement(incoming.binding, existing.binding)
      || directOriginalLegacyFieldCanUpgradeToGroundedSlot(incoming.binding, existing.binding))) return null;
  const proof = Object.freeze({ incomingRecordId: incoming.recordId, existingRecordId: existing.recordId });
  verifiedSourceRefinementProofs.add(proof);
  sourceRefinementFingerprints.set(proof, { incoming: boundFactFingerprint(incoming), existing: boundFactFingerprint(existing) });
  return proof;
}

function sourceRefinementProofMatches(proof: DirectOriginalSourceRefinementProof,
  incoming: BoundReportFact, existing: BoundReportFact): boolean {
  if (!verifiedSourceRefinementProofs.has(proof) || proof.incomingRecordId !== incoming.recordId
    || proof.existingRecordId !== existing.recordId || !incoming.binding || !existing.binding) return false;
  const fingerprints = sourceRefinementFingerprints.get(proof);
  return fingerprints?.incoming === boundFactFingerprint(incoming) && fingerprints.existing === boundFactFingerprint(existing)
    && sourceRefinementMedicalFieldsUnchanged(incoming, existing)
    && (directOriginalExpandedFindingProvesSourceRefinement(incoming.binding, existing.binding)
      || directOriginalLegacyFieldCanUpgradeToGroundedSlot(incoming.binding, existing.binding));
}

export interface ReportReconciliationOptions {
  /** 跨 OCR/来源视图的等价必须由调用方按原件位置及完整证据唯一核验。 */
  sameSourceUnit?: (incoming: ResolvedReportSourceBinding, existing: ResolvedReportSourceBinding) => boolean;
  /** 跨视图的新槽位须由受控原件几何或唯一精确位置证明与旧槽位分离，不能按名称/数值推断。 */
  sourcePositionsProvenDisjoint?: (incoming: ResolvedReportSourceBinding, existing: ResolvedReportSourceBinding) => boolean;
  /** 新日期须有明确检查日期角色的依据，不能以签发日期或首页猜测补齐。 */
  canRefineClinicalDate?: (incoming: BoundReportFact, existing: BoundReportFact) => boolean;
  /** 仅补旧记录缺失的条件；调用方须证明同一可信来源槽、清晰原件引用及非用户锁定。 */
  canRefineClinicalContext?: (incoming: BoundReportFact, existing: BoundReportFact) => boolean;
  /** 仅补旧缺失栏目；核心仍要求真实共同窄槽与全部医疗字段不变，调用方另查写入权限。 */
  canRefineSourceBinding?: (incoming: BoundReportFact, existing: BoundReportFact) => boolean;
  /** 真实P03显式旧行映射的进程内证明；不能由JSON、回调或几何宽松匹配替代。 */
  sourceRefinementProofs?: readonly DirectOriginalSourceRefinementProof[];
}

export interface ReportReconciliationDecision {
  decision: 'addition' | 'duplicate' | 'enrichment' | 'conflict' | 'unresolved';
  existingRecordIds: string[];
  changedFields: string[];
  reasonCodes: string[];
}

function normalizedText(value: string | null | undefined): string {
  return (value ?? '').normalize('NFKC').replace(/\s+/gu, ' ').trim().toLowerCase();
}

function normalizedDecimal(value: string | null): string {
  if (value === null) return '';
  const negative = value.startsWith('-');
  const unsigned = negative ? value.slice(1) : value;
  const [integer, fraction = ''] = unsigned.split('.');
  const whole = (integer ?? '').replace(/^0+(?=\d)/u, '');
  const fractional = fraction.replace(/0+$/u, '');
  const zero = (whole === '0' || whole === '') && fractional === '';
  return `${negative && !zero ? '-' : ''}${whole}${fractional ? `.${fractional}` : ''}`;
}

function contextSemantics(context: ClinicalContext | null | undefined): string {
  if (!context) return '';
  return JSON.stringify([context.status, [...new Set(context.conditions.map((condition) => normalizedText(condition.quote)))].sort()]);
}

function abnormalFlagSemantics(value: string | null | undefined): string {
  const normalized = normalizedText(value);
  const aliases: Record<string, string> = {
    high: 'high', h: 'high', '偏高': 'high', '升高': 'high', '↑': 'high',
    low: 'low', l: 'low', '偏低': 'low', '降低': 'low', '↓': 'low',
    positive: 'positive', '+': 'positive', '阳性': 'positive',
    negative: 'negative', '-': 'negative', '阴性': 'negative',
    normal: 'normal', '正常': 'normal', '未见异常': 'normal', unknown: 'unknown'
  };
  return aliases[normalized] ?? (normalized || 'unknown');
}

/** 不改单位/比较符/否定词/左右侧，也不把标准名当作证据。 */
export function reportFactSemantics(fact: ReportReconciliationFact): Record<string, string> {
  return {
    valueKind: fact.valueKind,
    value: fact.valueKind === 'numeric' ? normalizedDecimal(fact.decimalValue) : normalizedText(fact.rawText),
    // 数字相同也不能消掉“约”“未检出”等原文限定；计数法排版本身不改变数值。
    valueModifier: fact.valueKind === 'numeric'
      ? (normalizedText(fact.rawText).match(/未检出|未检测到|未见|阴性|阳性|不确定|不详|大约|约|≈|~|about|approximately/gu) ?? []).join('|') : '',
    qualifier: normalizedText(fact.qualifier),
    unit: normalizedText(fact.unit).replace(/[μµ]/gu, 'u'),
    referenceRange: normalizedText(fact.referenceRange),
    abnormalFlag: abnormalFlagSemantics(fact.abnormalFlag),
    specimen: normalizedText(fact.specimen), method: normalizedText(fact.method), bodySite: normalizedText(fact.bodySite),
    clinicalDate: fact.clinicalDate ?? '', clinicalContext: contextSemantics(fact.clinicalContext)
  };
}

export function candidateToReconciliationFact(candidate: ObservationCandidate): ReportReconciliationFact {
  return { originalName: candidate.originalName, valueKind: candidate.value.kind, rawText: candidate.value.rawText ?? '',
    decimalValue: candidate.value.kind === 'numeric' ? candidate.value.decimal : null,
    qualifier: candidate.value.kind === 'numeric' ? candidate.value.comparator
      : candidate.value.kind === 'qualitative' ? candidate.value.category : null,
    unit: candidate.unitRaw, referenceRange: candidate.referenceRangeRaw,
    abnormalFlag: candidate.reportedAbnormalFlag, specimen: candidate.specimen, method: candidate.method,
    bodySite: candidate.bodySite, clinicalDate: candidate.clinicalDate, clinicalContext: candidate.clinicalContext ?? null };
}

function sameOrigin(left: ResolvedReportSourceBinding, right: ResolvedReportSourceBinding): boolean {
  return left.sourceObjectId === right.sourceObjectId && left.documentId === right.documentId && left.sourceSha256 === right.sourceSha256;
}

function overlappingPositions(left: ResolvedReportSourceBinding, right: ResolvedReportSourceBinding): boolean {
  return left.units.some((a) => right.units.some((b) => a.sourceSpanId === b.sourceSpanId
    && a.segmentStart < b.segmentEnd && b.segmentStart < a.segmentEnd));
}

/** 通用的逐项对账；一次内容冲突是结构化业务结果，不是数据库或任务异常。 */
export function reconcileReportFact(incoming: BoundReportFact, existing: ReadonlyArray<BoundReportFact>,
  options: ReportReconciliationOptions = {}): ReportReconciliationDecision {
  const result = (decision: ReportReconciliationDecision['decision'], ids: string[] = [], fields: string[] = [], reasons: string[] = []): ReportReconciliationDecision =>
    ({ decision, existingRecordIds: ids, changedFields: fields, reasonCodes: reasons });
  if (!incoming.binding) return result('unresolved', [], [], ['source_binding_unresolved']);
  const binding = incoming.binding;
  if (binding.directOriginalField && !isVerifiedDirectOriginalSourceBinding(binding)) {
    return result('unresolved', [], [], ['direct_original_binding_unverified']);
  }
  const invalidDirect = existing.filter((record) => record.binding && sameOrigin(binding, record.binding) && record.binding.directOriginalField
    && !isVerifiedDirectOriginalSourceBinding(record.binding));
  if (invalidDirect.length) return result('unresolved', invalidDirect.map((record) => record.recordId), [], ['direct_original_binding_unverified']);
  const mixed = existing.filter((record) => record.binding && sameOrigin(binding, record.binding)
    && Boolean(binding.directOriginalField) !== Boolean(record.binding.directOriginalField));
  if (mixed.length) return result('unresolved', mixed.map((record) => record.recordId), [], ['source_binding_requires_unique_mapping']);
  const incomingSemantics = reportFactSemantics(incoming.fact);
  const explicitSourceRefinement = (record: BoundReportFact): boolean =>
    (options.sourceRefinementProofs ?? []).some((proof) => sourceRefinementProofMatches(proof, incoming, record));
  const identicalHeadingAddition = (record: BoundReportFact): boolean => {
    if (!record.binding || !directOriginalHeadingAdditionProvesDuplicateSlot(binding, record.binding)) return false;
    const oldSemantics = reportFactSemantics(record.fact);
    return Object.keys(incomingSemantics).every((field) => incomingSemantics[field] === oldSemantics[field]);
  };
  // 引用由整行收窄到同一字段，仅在所有原始医疗字段逐字一致时判重；不授予补日期或覆盖权限。
  const identicalContainedSource = (record: BoundReportFact): boolean => Boolean(record.binding
    && (directOriginalContainedSourceProvesDuplicateSlot(binding, record.binding)
      || directOriginalContainedSourceProvesDuplicateSlot(record.binding, binding))
    && (['originalName', 'valueKind', 'rawText', 'decimalValue', 'qualifier', 'unit', 'referenceRange',
      'abnormalFlag', 'specimen', 'method', 'bodySite', 'clinicalDate'] as const)
      .every((field) => incoming.fact[field] === record.fact[field])
    && JSON.stringify(incoming.fact.clinicalContext) === JSON.stringify(record.fact.clinicalContext));
  const matches = existing.filter((record) => record.binding && sameOrigin(binding, record.binding)
    && (binding.key === record.binding.key || sameDirectOriginalField(binding, record.binding) || identicalHeadingAddition(record)
      || identicalContainedSource(record)
      || explicitSourceRefinement(record)
      || !directOriginalFieldsProvenDistinct(binding, record.binding)
        && options.sameSourceUnit?.(binding, record.binding) === true));
  if (matches.length > 1) return result('unresolved', matches.map((match) => match.recordId), [], ['source_binding_ambiguous']);
  if (!matches.length) {
    // 无旧绑定不能凭标题或同值认定新增；同来源的旧事实须先完成可靠定位。
    const uncertain = existing.filter((record) => (!record.binding && !reportSourcePagesProvenDistinct(binding, record.sourcePageScope)) || (record.binding && sameOrigin(binding, record.binding)
      && !directOriginalFieldsProvenDistinct(binding, record.binding)
      && (isVerifiedDirectOriginalSourceBinding(binding) && isVerifiedDirectOriginalSourceBinding(record.binding)
        && binding.units.some((a) => record.binding!.units.some((b) => a.page === b.page))
        || binding.sourceViewId !== record.binding.sourceViewId
        && binding.units.some((a) => record.binding!.units.some((b) => a.page === b.page))
        && options.sourcePositionsProvenDisjoint?.(binding, record.binding) !== true
        || (binding.sourceViewId === record.binding.sourceViewId && overlappingPositions(binding, record.binding)))));
    if (uncertain.length) return result('unresolved', uncertain.map((record) => record.recordId), [], ['source_binding_requires_unique_mapping']);
    return result('addition');
  }
  const matched = matches[0]!;
  if (explicitSourceRefinement(matched)) {
    const competingOldSlots = existing.filter((record) => record !== matched && record.binding && matched.binding
      && sameOrigin(record.binding, matched.binding) && (record.binding.key === matched.binding.key
        || sameDirectOriginalField(record.binding, matched.binding)
        // 历史引用数组可能重复保存同一槽，也可能各只保留不同的短frame。
        // 其他旧原句同样能落入本次新槽时仍有竞争，不能用recordId、名称或值挑一个放行。
        || directOriginalExpandedFindingProvesSourceRefinement(binding, record.binding)
        || directOriginalLegacyFieldCanUpgradeToGroundedSlot(binding, record.binding)));
    if (competingOldSlots.length) return result('unresolved', [matched.recordId, ...competingOldSlots.map((record) => record.recordId)],
      [], ['source_binding_ambiguous']);
  }
  const existingSemantics = reportFactSemantics(matched.fact);
  const changedFields = Object.keys(incomingSemantics).filter((field) => incomingSemantics[field] !== existingSemantics[field]);
  if (!changedFields.length) {
    // 来源补充不借语义归一化改写名称、原值或单位等既有字段；普通判重仍保持原兼容性。
    const unchangedMedicalFields = (['originalName', 'valueKind', 'rawText', 'decimalValue', 'qualifier', 'unit',
      'referenceRange', 'abnormalFlag', 'specimen', 'method', 'bodySite', 'clinicalDate'] as const)
      .every((field) => (incoming.fact[field] ?? null) === (matched.fact[field] ?? null));
    if (unchangedMedicalFields && (identicalHeadingAddition(matched) || explicitSourceRefinement(matched))
      && options.canRefineSourceBinding?.(incoming, matched) === true) {
      return result('enrichment', [matched.recordId], ['sourceBinding']);
    }
    return result('duplicate', [matched.recordId]);
  }
  if (changedFields.length === 1 && changedFields[0] === 'clinicalDate') {
    if (matched.fact.clinicalDate === null && incoming.fact.clinicalDate !== null) {
      return options.canRefineClinicalDate?.(incoming, matched) === true
        ? result('enrichment', [matched.recordId], changedFields)
        : result('unresolved', [matched.recordId], changedFields, ['clinical_date_enrichment_unproven']);
    }
    if (incoming.fact.clinicalDate === null && matched.fact.clinicalDate !== null) {
      return result('duplicate', [matched.recordId], changedFields, ['existing_clinical_date_retained']);
    }
  }
  if (changedFields.length === 1 && changedFields[0] === 'clinicalContext'
    && (!matched.fact.clinicalContext || matched.fact.clinicalContext.conditions.length === 0)
    && incoming.fact.clinicalContext?.status === 'complete'
    && incoming.fact.clinicalContext.conditions.length > 0
    && incoming.fact.clinicalContext.conditions.every((condition) => condition.quote.trim().length > 0)) {
    // 缺失条件可独立补回，不覆盖旧非空条件；日期或其他语义同时变化仍走冲突，不能借此回调绕过。
    return options.canRefineClinicalContext?.(incoming, matched) === true
      ? result('enrichment', [matched.recordId], changedFields)
      : result('unresolved', [matched.recordId], changedFields, ['clinical_context_enrichment_unproven']);
  }
  return result('conflict', [matched.recordId], changedFields, ['same_source_finding_semantic_conflict']);
}
