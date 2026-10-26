import { stableHash } from '@core';
import type {
  HealthAction, HealthClaim, MemberAssessmentCandidateV3, MemberEvidenceRef,
  OverviewNode, QuestionNode, SystemNode
} from '@contracts';
import {
  hasDirectMedicationChange, hasNumericSupplementDose,
  highConsequenceAssertionMentions, visibleAssessmentTextFields
} from './assessment-validation.js';
import { validAssessmentEvidenceResolution, type AssessmentEvidenceResolution } from './assessment-evidence-resolution.js';

export type AssessmentReviewBoundaryReason =
  | 'candidate_scope_changed' | 'target_missing' | 'target_ambiguous' | 'target_type_changed'
  | 'identity_changed' | 'system_scope_changed' | 'support_expanded' | 'support_empty'
  | 'counter_evidence_expanded' | 'counter_evidence_promoted' | 'trend_expanded'
  | 'knowledge_scope_expanded' | 'claim_kind_expanded' | 'disease_changed'
  | 'diagnostic_certainty_increased' | 'diagnostic_fields_inconsistent' | 'criteria_changed'
  | 'consequence_increased' | 'uncertainty_removed' | 'evidence_resolution_unproven' | 'temporal_scope_changed'
  | 'source_fact_numeric_changed' | 'numeric_fact_added' | 'time_fact_added' | 'date_scope_or_precision_changed'
  | 'action_scope_changed' | 'urgency_increased' | 'medication_instruction_changed'
  | 'source_instruction_changed'
  | 'supplement_dose_introduced' | 'system_status_changed' | 'high_consequence_assertion_expanded';

/** 回执只包含固定原因码，不携带健康正文、病名、引用值或数值。 */
export interface AssessmentReviewBoundaryResult {
  preserved: boolean;
  reasonCodes: AssessmentReviewBoundaryReason[];
}

/** 仅由同批流水线授予；不是普通 P04 目标的改状态权限。 */
export interface RebuiltSystemStatusRestoration {
  targetId: string;
  systemId: SystemNode['systemId'];
  originalStatus: 'attention' | 'monitor';
}

/** 仅由主 P04 的真实输入冻结；不会给予模型改正文、来源或补充医学依据的权限。 */
export interface ActionDependencyRebinding {
  targetId: string;
  personId: string;
  inputSignature: string;
  originalActionHash: string;
  claims: ReadonlyArray<{ id: string; inputHash: string; reviewedHash: string | null;
    sourceHashes: ReadonlyArray<{ id: string; hash: string }> }>;
}

/**
 * 这里只证明系统仍有同系统、唯一且可追溯的个人支持闭包，不判断其健康含义。
 * 是否足以恢复原关注状态，仍由同次 P04 显式复核；不能从数量、异常标记或病名猜状态。
 */
export function hasSurvivingSystemSupport(
  candidate: Pick<MemberAssessmentCandidateV3, 'claims' | 'actions'>,
  system: SystemNode,
  evidenceCatalog: readonly MemberEvidenceRef[]
): boolean {
  const claims: HealthClaim[] = [];
  const actions: HealthAction[] = [];
  for (const id of system.actionIds) {
    const matches = candidate.actions.filter((action) => action.id === id);
    if (matches.length !== 1 || !matches[0]!.systemIds.includes(system.systemId)) return false;
    actions.push(matches[0]!);
  }
  for (const id of new Set([...system.claimIds, ...actions.flatMap((action) => action.claimIds)])) {
    const matches = candidate.claims.filter((claim) => claim.id === id);
    if (matches.length !== 1 || system.claimIds.includes(id) && !matches[0]!.systemIds.includes(system.systemId)) return false;
    claims.push(matches[0]!);
  }
  const evidenceIds = [...claims.flatMap((claim) => claim.evidenceIds), ...actions.flatMap((action) => action.evidenceIds)];
  const sources = evidenceIds.map((id) => evidenceCatalog.filter((source) => source.id === id));
  // 跨系统辅助限制可进入行动闭包；本系统状态仍须有自己的个人支持锚点，不能借别的系统代言。
  const anchorEvidenceIds = new Set([...claims.filter((claim) => claim.systemIds.includes(system.systemId))
    .flatMap((claim) => claim.evidenceIds), ...actions.flatMap((action) => action.evidenceIds)]);
  return sources.length > 0 && sources.every((matches) => matches.length === 1)
    && sources.some(([source]) => source !== undefined && anchorEvidenceIds.has(source.id) && source.knowledgeId === null
      && ['observation', 'user_note', 'clinical_finding', 'source_span'].includes(source.kind)
      && Boolean(source.quote?.trim()));
}

type ClinicalNode = HealthClaim | HealthAction | OverviewNode | SystemNode | QuestionNode;
type TypedNode =
  | { type: 'claim'; value: HealthClaim } | { type: 'action'; value: HealthAction }
  | { type: 'overview'; value: OverviewNode } | { type: 'system'; value: SystemNode }
  | { type: 'question'; value: QuestionNode };

function targets(candidate: MemberAssessmentCandidateV3, id: string): TypedNode[] {
  return [
    ...(candidate.overview.id === id ? [{ type: 'overview' as const, value: candidate.overview }] : []),
    ...candidate.claims.filter((node) => node.id === id).map((value) => ({ type: 'claim' as const, value })),
    ...candidate.actions.filter((node) => node.id === id).map((value) => ({ type: 'action' as const, value })),
    ...candidate.systems.filter((node) => node.id === id).map((value) => ({ type: 'system' as const, value })),
    ...candidate.questions.filter((node) => node.id === id).map((value) => ({ type: 'question' as const, value }))
  ];
}

function sameIds(before: readonly string[], after: readonly string[]): boolean {
  return isSubset(before, after) && isSubset(after, before);
}

function isSubset(before: readonly string[], after: readonly string[]): boolean {
  const allowed = new Set(before);
  return after.every((id) => allowed.has(id));
}

/** 只补已向同次 P04 明示提供、合法复核后冻结的个人前提；不能用少量来源重合代替证明。 */
function actionDependencyRebindingPreserved(
  original: MemberAssessmentCandidateV3, reviewed: MemberAssessmentCandidateV3,
  before: HealthAction, after: HealthAction, evidenceCatalog: readonly MemberEvidenceRef[],
  permissions: readonly ActionDependencyRebinding[]
): boolean {
  const matches = permissions.filter((permission) => permission.targetId === before.id);
  const permission = matches.length === 1 ? matches[0] : undefined;
  if (!permission || permission.personId !== original.personId || permission.inputSignature !== original.inputSignature
    || permission.originalActionHash !== stableHash(before) || !isSubset(after.claimIds, before.claimIds)
    || new Set(after.claimIds).size !== after.claimIds.length) return false;
  const fixedFields = (action: HealthAction) => ({ ...action, claimIds: [], knowledgeSourceIds: [] });
  if (stableHash(fixedFields(before)) !== stableHash(fixedFields(after))) return false;
  return after.claimIds.filter((id) => !before.claimIds.includes(id)).every((id) => {
    const grants = permission.claims.filter((claim) => claim.id === id);
    const grant = grants.length === 1 ? grants[0] : undefined;
    const frozenNodes = targets(original, id);
    const finalNodes = targets(reviewed, id);
    const frozen = frozenNodes.length === 1 && frozenNodes[0]!.type === 'claim' ? frozenNodes[0]!.value : null;
    const final = finalNodes.length === 1 && finalNodes[0]!.type === 'claim' ? finalNodes[0]!.value : null;
    if (!grant || !frozen || !final || original.knowledgeSources.some((source) => source.id === id)
      || reviewed.knowledgeSources.some((source) => source.id === id)
      || stableHash(frozen) !== grant.inputHash || stableHash(final) !== grant.reviewedHash
      || frozen.evidenceIds.length === 0 || final.evidenceIds.length === 0) return false;
    const sourceIds = [...new Set([...frozen.evidenceIds, ...frozen.counterEvidenceIds])];
    return sameIds(sourceIds, grant.sourceHashes.map((source) => source.id))
      && isSubset(frozen.evidenceIds, final.evidenceIds) && isSubset(frozen.counterEvidenceIds, final.counterEvidenceIds)
      && sourceIds.every((sourceId) => {
        const sources = evidenceCatalog.filter((source) => source.id === sourceId);
        const frozenSources = grant.sourceHashes.filter((source) => source.id === sourceId);
        return sources.length === 1 && frozenSources.length === 1 && stableHash(sources[0]) === frozenSources[0]!.hash;
      });
  });
}

/** 沿用原门禁：原支持来源必须全部明确属于分析当日，不能靠撤掉旧来源改成当下。 */
function supportsReferenceDate(evidenceIds: readonly string[], catalog: readonly MemberEvidenceRef[], referenceDate: string): boolean {
  return evidenceIds.length > 0 && evidenceIds.every((id) => {
    const sources = catalog.filter((source) => source.id === id);
    if (sources.length !== 1) return false;
    const source = sources[0]!;
    const dates = [...`${source.locator ?? ''} ${source.quote ?? ''}`.matchAll(/(\d{4})[-/年](\d{1,2})[-/月](\d{1,2})(?:日)?/g)]
      .map((date) => `${date[1]}-${date[2]!.padStart(2, '0')}-${date[3]!.padStart(2, '0')}`);
    return dates.length > 0 && dates.every((date) => date === referenceDate);
  });
}

function normalizeDates(text: string): string {
  const normalized = text.normalize('NFKC');
  let cursor = 0;
  const parts: string[] = [];
  for (const date of calendarDateTokens(normalized)) {
    parts.push(normalized.slice(cursor, date.start), date.canonical);
    cursor = date.end;
  }
  return parts.join('') + normalized.slice(cursor);
}

/** 带数字的项目/分类标识不是检验结果；仍以完整标识检查来源，不丢弃其医学含义。 */
function numericIdentifiers(text: string): string[] {
  return [...text.matchAll(/(?<![A-Za-z0-9])[A-Za-z][A-Za-z0-9]*(?:-[A-Za-z0-9]+)*(?![A-Za-z0-9])/g)]
    .map((match) => match[0]).filter((identifier) => /\d/.test(identifier));
}

function withoutNumericIdentifiers(text: string): string {
  return text.replace(/(?<![A-Za-z0-9])[A-Za-z][A-Za-z0-9]*(?:-[A-Za-z0-9]+)*(?![A-Za-z0-9])/g,
    (identifier) => /\d/.test(identifier) ? ' '.repeat(identifier.length) : identifier);
}

function numericLiterals(text: string): string[] {
  return (withoutNumericIdentifiers(normalizeDates(text)).match(/\d+(?:\.\d+)?/g) ?? []).map(canonicalDecimalDisplay);
}

/** 只去除十进制小数尾零，不经过浮点计算，不作量级换算、四舍五入或丢掉正负号。 */
function canonicalDecimalDisplay(value: string): string {
  return value.replace(/(\.\d*?[1-9])0+(?=[Ee]|$)/u, '$1').replace(/\.0+(?=[Ee]|$)/u, '');
}

interface CalendarDateToken {
  start: number;
  end: number;
  text: string;
  canonical: string;
  precision: 'year' | 'month' | 'day' | 'month_day';
}

/**
 * 先消费最长日期形状，再作日历校验；非法长串不能回退成内部年份或月日。
 * 无年份的中文月日只证明可能的日历日期，不补年份；二月二十九日也不推断闰年。
 */
function calendarDateTokens(text: string): CalendarDateToken[] {
  const tokens: CalendarDateToken[] = [];
  const shapes = /\d+(?:[-/]\d+(?:[-/]\d+)?|年(?:\d+月(?:\d+日?)?)?|月\d+日)/gu;
  for (const shape of text.matchAll(shapes)) {
    const start = shape.index;
    const end = start + shape[0].length;
    // 序数时程、ASCII标识/数值粘连及尚未消费完的日期形状不是独立日历 token。
    // 词法边界也保护带符号的指数尾部，不把数字片段当成可撤回日期。
    if (/(?:[年月日]|[A-Za-z0-9_][.+/−-]*)$/u.test(text.slice(0, start)) || /第\s*$/u.test(text.slice(0, start))
      || /^[A-Za-z0-9_年月日]|^[.+/−-]+[A-Za-z0-9_]/u.test(text.slice(end))) continue;
    const full = /^(\d{4})(?:[-/](\d{1,2})(?:[-/](\d{1,2}))?|年(?:(\d{1,2})月(?:(\d{1,2})日?)?)?)$/u.exec(shape[0]);
    const monthDay = /^(\d{1,2})月(\d{1,2})日$/u.exec(shape[0]);
    if (!full && !monthDay) continue;
    const year = full ? Number(full[1]) : null;
    const monthText = full ? full[2] ?? full[4] : monthDay![1];
    const dayText = full ? full[3] ?? full[5] : monthDay![2];
    const month = monthText === undefined ? null : Number(monthText);
    const day = dayText === undefined ? null : Number(dayText);
    if (year !== null && year < 1 || month !== null && (month < 1 || month > 12)) continue;
    const leap = year === null || year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    const days = month === null ? 0 : [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1]!;
    if (day !== null && (day < 1 || day > days)) continue;
    const precision = year === null ? 'month_day' : day !== null ? 'day' : month !== null ? 'month' : 'year';
    const canonical = precision === 'day'
      ? `${full![1]}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}` : shape[0];
    tokens.push({ start, end, text: shape[0], canonical, precision });
  }
  return tokens;
}

/** 叙事中的连续年份共用末尾“年”；仅用于解释，不用于来源事实的日期擦除权限。 */
function narrativeCalendarDateTokens(text: string): CalendarDateToken[] {
  const tokens = calendarDateTokens(text);
  const sequence = /\d{4}年?(?:\s*(?:至|到|和|及|以及|、|与|—|–|~|～)\s*\d{4}年?)+年/gu;
  for (const match of text.matchAll(sequence)) {
    const start = match.index, end = start + match[0].length;
    if (/(?:[年月日]|[A-Za-z0-9_][.+/−-]*)$/u.test(text.slice(0, start)) || /第\s*$/u.test(text.slice(0, start))
      || /^[A-Za-z0-9_年月日]|^[.+/−-]+[A-Za-z0-9_]/u.test(text.slice(end))) continue;
    for (const year of match[0].matchAll(/\d{4}/gu)) {
      const offset = start + year.index;
      if (Number(year[0]) > 0 && !tokens.some((token) => token.start <= offset && token.end > offset)) {
        tokens.push({ start: offset, end: offset + year[0].length, text: year[0], canonical: `${year[0]}年`, precision: 'year' });
      }
    }
  }
  return tokens.sort((left, right) => left.start - right.start);
}

function calendarFact(token: CalendarDateToken): string {
  if (token.precision === 'day') return `date:${token.canonical}`;
  const digits = token.text.match(/\d+/gu) ?? [];
  return `date:${token.precision}:${digits.map((value, index) => index === 0 && token.precision !== 'month_day'
    ? value : value.padStart(2, '0')).join('-')}`;
}

/** 仅掩去已严格识别的日期；年月、年份和无年份月日均不冒充检验数值。 */
function withoutCalendarDates(text: string): string {
  const normalized = normalizeDates(text);
  let cursor = 0;
  const parts: string[] = [];
  for (const date of calendarDateTokens(normalized)) {
    parts.push(normalized.slice(cursor, date.start), ' '.repeat(date.end - date.start));
    cursor = date.end;
  }
  return parts.join('') + normalized.slice(cursor);
}

/** 先按原始词法分隔识别日期，再映射到忽略空白的正文偏移，避免日期与相邻指标名被人为粘连。 */
function compactTextWithCalendarDates(text: string): { text: string; dates: CalendarDateToken[] } {
  const normalized = text.normalize('NFKC');
  const dates: CalendarDateToken[] = [];
  let compact = '';
  let cursor = 0;
  for (const date of calendarDateTokens(normalized)) {
    compact += normalized.slice(cursor, date.start).replace(/\s+/g, '');
    const start = compact.length;
    compact += date.canonical;
    dates.push({ ...date, start, end: compact.length, text: date.canonical });
    cursor = date.end;
  }
  compact += normalized.slice(cursor).replace(/\s+/g, '');
  return { text: compact, dates };
}

function nonDateNumericLiterals(text: string): string[] {
  return (withoutNumericIdentifiers(withoutCalendarDates(text)).match(/\d+(?:\.\d+)?/g) ?? []).map(canonicalDecimalDisplay);
}

/**
 * 组合语法只识别“事件日期尚未确定”这类时间限定，不接受附带疾病、用药或新数值的句子。
 * 事件名称必须原已出现；通用指代词不承担临床归属，不能据此创造新的事件或日期角色。
 */
function isDateUncertaintyClause(clause: string, originalText: string, reportSources: readonly MemberEvidenceRef[]): boolean {
  const text = clause.normalize('NFKC').replace(/^[\s。；;，,]+|[\s。；;，,]+$/g, '');
  const uncertain = '(?:(?:目前|当前|现在|暂时|暂|尚|仍|还)?(?:未能|无法|不能|未|不|难以)'
    + '(?:可靠地|可靠|准确地|准确|清楚地|清楚)?(?:确认|确定|明确|核实|辨认)|不明|未知|未明)';
  const event = '([\\p{Script=Han}A-Za-z ]{0,24}?)(?:日期|时间)';
  const match = new RegExp(`^(?:${event}${uncertain}|${uncertain}${event})$`, 'u').exec(text);
  if (!match) return false;
  // 指代词只在主题开头，精度修饰只在日期名词前；不能在病名或临床正文中任意删词。
  const label = (match[1] ?? match[2] ?? '').replace(/\s+/g, '')
    .replace(/^(?:(?:(?:该|本)(?:次|项|份)?|此次|这次|这份|对应|上述|原|所述|当时)(?:的)?)+/u, '')
    .replace(/(?:的)?(?:具体|相关|确切|准确|实际|完整)(?:的)?$/u, '')
    .replace(/的$/u, '');
  const original = originalText.normalize('NFKC').replace(/\s+/g, '');
  if (label.length === 0 || original.includes(label)) return true;
  // 当前支持文档是“报告”的来源锚；中性文档类型可与报告指代组合，不据此创造病名或事件。
  if (reportSources.length === 0) return false;
  if (label === '报告') return true;
  const reportType = /^(病理|检验|化验|影像|超声|内镜|检查|体检|心电图|放射)(?:检查)?报告$/u.exec(label)?.[1];
  return reportType !== undefined && (original.includes(reportType)
    || reportSources.some((source) => source.label.normalize('NFKC').replace(/\s+/g, '').includes(reportType)));
}

/** 原有不确定说明逐字保留，只能前置或追加一个纯时间不确定限定。 */
function dateUncertaintyPreserved(before: HealthClaim, after: HealthClaim, evidenceCatalog: readonly MemberEvidenceRef[]): boolean {
  if (after.materialUncertainty === null) return false;
  const sources = before.evidenceIds.map((id) => evidenceCatalog.filter((source) => source.id === id));
  const reportSources = sources.every((matches) => matches.length === 1) ? sources.flat().filter((source) =>
    source.knowledgeId === null && source.documentId && source.quote?.trim()
    && ['observation', 'clinical_finding', 'source_span'].includes(source.kind)) : [];
  const uncertain = (clause: string) => isDateUncertaintyClause(clause, before.text, reportSources);
  if (before.materialUncertainty === null) return uncertain(after.materialUncertainty);
  if (before.materialUncertainty === after.materialUncertainty) {
    return after.materialUncertainty.split(/[。；;]/u).some(uncertain);
  }
  return after.materialUncertainty.startsWith(before.materialUncertainty)
    && uncertain(after.materialUncertainty.slice(before.materialUncertainty.length))
    || after.materialUncertainty.endsWith(before.materialUncertainty)
      && uncertain(after.materialUncertainty.slice(0, -before.materialUncertainty.length));
}

/**
 * 每个删除区间都锚定原有日期，元数据角色只有带“的”的完整时间修饰语才能一并撤回。
 * 临床事件、时序条件、否定和标点不在区间内；不按“日期附近若干字”猜可删内容。
 */
function nonDateClinicalTextPreserved(before: string, after: string): boolean {
  const originalText = compactTextWithCalendarDates(before);
  const finalText = compactTextWithCalendarDates(after);
  const original = originalText.text;
  const final = finalText.text;
  if (final.length > original.length) return false;
  const deletions = new Map<number, Set<number>>();
  const originalDates = originalText.dates;
  const finalDates = finalText.dates;
  const originalDateStarts = new Map(originalDates.map((date) => [date.start, date]));
  const finalDateStarts = new Map(finalDates.map((date) => [date.start, date]));
  const originalDateOffsets = new Set(originalDates.flatMap((date) =>
    Array.from({ length: date.end - date.start }, (_, offset) => date.start + offset)));
  const finalDateOffsets = new Set(finalDates.flatMap((date) =>
    Array.from({ length: date.end - date.start }, (_, offset) => date.start + offset)));
  const add = (start: number, end: number) => {
    const ends = deletions.get(start) ?? new Set<number>();
    ends.add(end);
    deletions.set(start, ends);
  };
  const addTemporalModifier = (start: number, end: number) => {
    // 否定/条件可能辖制后面的签发谓词或报告指代。只保留字面算子仍可能改变其对象，
    // 因此同一子句有这类控制时不授予整段撤回权限；只删日期的既有路径不受影响。
    const clausePrefix = original.slice(0, start).split(/[。；;，,：:]/u).at(-1) ?? '';
    if (/(?:不|未|非|没有|无|若|如果|假如|除非|只要|只有|一旦|当)/u.test(clausePrefix)) return;
    add(start, end);
  };
  const metadataRole = '(?:签发|出具|打印|审核|签署|发布)';
  for (const date of originalDates) {
    const { start, end } = date;
    add(start, end);
    if (original[end] === '的') addTemporalModifier(start, end + 1);
    // 纯文档时间名词可随完整日期撤回；手术、检查和术后等临床角色不在这套语法内。
    const suffix = new RegExp(`^(?:(?:所)?${metadataRole}|报告(?:时期|时间|日期))的`, 'u').exec(original.slice(end));
    if (suffix) {
      addTemporalModifier(start, end + suffix[0].length);
      if (start > 0 && /[于在]/u.test(original[start - 1]!)) addTemporalModifier(start - 1, end + suffix[0].length);
    }
    const prefix = new RegExp(`${metadataRole}于$`, 'u').exec(original.slice(0, start));
    if (prefix && original[end] === '的') addTemporalModifier(prefix.index, end + 1);
  }
  // 日期只能按完整 token 原样保留或撤回；token 内部不能逐字复制，目标 token 也不能由碎片拼成。
  const reachable: Array<Set<number> | undefined> = [];
  reachable[0] = new Set([0]);
  const reach = (sourceOffset: number, targetOffset: number) => {
    const offsets = reachable[sourceOffset] ?? new Set<number>();
    offsets.add(targetOffset);
    reachable[sourceOffset] = offsets;
  };
  for (let index = 0; index < original.length; index += 1) {
    for (const target of reachable[index] ?? []) {
      for (const end of deletions.get(index) ?? []) reach(end, target);
      const date = originalDateStarts.get(index);
      const retained = finalDateStarts.get(target);
      if (date && retained?.text === date.text && retained.precision === date.precision) reach(date.end, retained.end);
      if (!originalDateOffsets.has(index) && !finalDateOffsets.has(target)
        && original[index] === final[target]) reach(index + 1, target + 1);
    }
  }
  return reachable[original.length]?.has(final.length) ?? false;
}

/**
 * 只允许模型撤回部分或全部完整日期，其他日期原样保留；不能改精度、改日期、重组或改派事件。
 * 除原日期及其肯定的纯文档元数据时间修饰语外，正文逐字（仅忽略空白及等价字符）相同；
 * 其他医学/来源字段相同，且保留明确时间不确定。否定、条件和临床操作不随角色词撤回。
 * 这不是日期推断：移除后的事实仍须经过完整医学校验和同次 P04 语义复核。
 */
function sourceFactDateErasurePreserved(before: HealthClaim, after: HealthClaim, evidenceCatalog: readonly MemberEvidenceRef[]): boolean {
  if (before.kind !== 'source_fact' || after.kind !== 'source_fact' || after.temporalStatus !== 'uncertain'
    || calendarDateTokens(normalizeDates(before.text)).length === 0
    || !dateUncertaintyPreserved(before, after, evidenceCatalog)) return false;
  if (!nonDateClinicalTextPreserved(before.text, after.text)) return false;
  const fixedFields = (claim: HealthClaim) => ({ ...claim, text: '', temporalStatus: 'uncertain', materialUncertainty: null });
  return stableHash(fixedFields(before)) === stableHash(fixedFields(after));
}

/** 只合并确定等价的书写，不把大小写可能改变SI量级的前缀或换算关系当作排版。 */
function canonicalNumericUnit(raw: string): string {
  const unit = raw.normalize('NFKC').replace(/\s+/g, '').replace(/[µμ]/g, 'u');
  if (/^(?:mmol|umol|nmol|pmol)\/[lL]$/.test(unit)
    || /^(?:mg|ug|ng)\/(?:[dD][lL]|m[lL]|[lL])$/.test(unit)
    || /^(?:m|u)?[iI][uU](?:\/(?:m[lL]|[lL]))?$/.test(unit)
    || /^mm[hH][gG]$/.test(unit) || /^m[lL]$/.test(unit)) return unit.toLowerCase();
  if (unit === 'mcg') return 'ug';
  return unit;
}

/** 数字、比较符、科学计数法和完整单位一起保护；日期不能拆开重组。 */
function numericFacts(node: ClinicalNode, omitCalendarDates = false): string[] {
  return visibleAssessmentTextFields(node).flatMap(({ text }) => {
    const normalized = normalizeDates(text);
    const dates = 'kind' in node && node.kind === 'source_fact'
      ? calendarDateTokens(normalized) : narrativeCalendarDateTokens(normalized);
    let cursor = 0;
    const pieces: string[] = [];
    for (const date of dates) {
      pieces.push(normalized.slice(cursor, date.start), ' '.repeat(date.end - date.start));
      cursor = date.end;
    }
    const withoutDates = withoutNumericIdentifiers(pieces.join('') + normalized.slice(cursor));
    const numbers = [...withoutDates.matchAll(/(?<comparison><=|>=|[<>≤≥=])?\s*(?<value>[+−-]?\d+(?:\.\d+)?(?:[eE][+−-]?\d+)?)(?:\s*(?<unit>%|[A-Za-zµμ]+(?:\s*\/\s*[A-Za-zµμ]+)*|[年月日天周次岁粒片滴袋克]))?/g)]
      .map((match) => {
        const comparison = (match.groups?.comparison ?? '').replace('≤', '<=').replace('≥', '>=');
        const value = canonicalDecimalDisplay(match.groups!.value!.replace('−', '-').replace('e', 'E'));
        return `${comparison}${value}${canonicalNumericUnit(match.groups?.unit ?? '')}`;
      });
    return [...(omitCalendarDates ? [] : dates.map(calendarFact)), ...numbers];
  });
}

function visibleNumericIdentifiers(node: ClinicalNode): string[] {
  return visibleAssessmentTextFields(node).flatMap(({ text }) => numericIdentifiers(normalizeDates(text)));
}

function relativeTimeFacts(node: ClinicalNode): string[] {
  return visibleAssessmentTextFields(node).flatMap(({ text }) => text.match(
    /(?:今天|今日|昨天|昨日|明天|明日|本周|下周|上周|本月|下月|上月|今年|明年|去年|[一二两三四五六七八九十百]+(?:个)?(?:小时|天|周|月|年)(?:内|后|前|一次|左右)?)/g
  ) ?? []);
}

/** 明确的就医指令也有紧急程度，不能只保留 urgency 标签而升级正文。 */
function textUrgency(node: ClinicalNode): number {
  const text = visibleAssessmentTextFields(node).map((field) => field.text).join('。');
  if (/(?:立即|马上|即刻|立刻)(?:就医|就诊|前往医院|到医院|处理)|(?:前往|去|到|接受)?(?:急诊|急救)|拨打(?:当地)?(?:120|急救电话)/.test(text)) return 3;
  return /尽快(?:就医|就诊|复诊|检查|联系医生)/.test(text) ? 2 : 0;
}

/** 否定的安全提醒也须保留其条件；不能因它不是执行停药的指令便丢掉范围保护。 */
function hasNegatedMedicationReminder(text: string): boolean {
  return text.split(/[。；;，,！？!?\n]/).some((clause) =>
    /(?:不要|不得|切勿|勿|避免|禁止|不应|不宜|不能|不足以|不必|无需|不因|不(?=自行|擅自))/u.test(clause)
    && (medicationOperation.test(clause) || medicationChangeOperation.test(clause) || medicationSchedule.test(clause)));
}

function medicationInstructions(node: ClinicalNode): Array<{ field: string; text: string; retainOnRemoval?: boolean }> {
  const isOperation = (text: string) => hasMedicationOperation(text)
    || hasNegatedMedicationReminder(text) || hasDirectMedicationChange({
    id: node.id, dedupeKey: 'boundary-check', systemIds: [], claimIds: [],
    kind: 'treatment_discussion', title: '', why: '', firstStep: text, timing: null, timingBasis: 'none',
    reviewPlan: null, caution: null, urgency: 'routine', evidenceIds: [], knowledgeSourceIds: []
  });
  // 比较操作所在的完整句法单元。逗号、条件、否定、剂量、时程及同句并列动作不拆开，
  // 独立的解释句不再冻结整段。冒号前已有完整操作而后仅是说明时，说明可单独核对。
  // “条件：操作”不能使用这个分离，前置独立条件句也必须与操作一起保留。
  // 只绑定条件关系、适用谓词或明确的执行限定；“尚未提供”本身只是背景断言，
  // 不能因为与操作同段就冻结。名词主语的“某类人不适用”同样是作用域。
  const carriesScope = (statement: string) => /(?:如果|如若|倘若|假如|只有|除非|若|例外|除外|适用|仅限|只限|禁忌|禁用)/u.test(statement)
    || /(?:前|后|时|期间|阶段)(?:(?:才|方|仅|只|再)|$)/u.test(statement)
    || /(?:这(?:一|个|项|种)?|该|以上|上述|下句|前述)[^。；;]{0,24}(?:不(?:宜|应|要|能|得|表示|代表|是|可|再|必)|并非|尚未|未经|无(?:需|须|法))[^。；;]{0,12}(?:执行|操作|安排|允许|医嘱)/u.test(statement);
  // 剂型是名词，不等于给药动词。其历史记录及相连的否定推论仍独立保留，
  // 但不冻结同句其他测量解释；真实操作的完整逗号/条件单元继续使用上面的路径。
  const independentExplanation = (statement: string) => {
    // 只分离完整的非操作推论说明。任何条件、时态、治疗角色或决策都保守留在背景签名内；
    // 不靠“缺失/阴性”等关键词推定可删，也不把未知前件一概当成独立说明。
    if (isOperation(statement) || carriesScope(statement) || medicationNominalForm.test(statement)
      || medicationDose.test(statement) || medicationStatusContext.test(statement) || medicationFutureContext.test(statement)
      || /(?:治疗|处置|方案|医嘱|执行|操作|请|建议|必须|应该|应当|可以|需要|允许)/u.test(statement)) return false;
    return /^[^。；;，,：:]+(?:不等于|不代表|不能(?:直接)?说明|不足以(?:直接)?说明)[^。；;，,：:]+$/u.test(statement);
  };
  return visibleAssessmentTextFields(node).flatMap(({ field, text }) => {
    const statements = text.split(/[。；;！？!?\n]+/u).map((value) => value.trim()).filter(Boolean);
    return statements.flatMap((statement, index) => {
      const clauses = statement.split(/[，,]/u).map((value) => value.trim()).filter(Boolean);
      const nominalIndex = clauses.findIndex((clause) => medicationNominalForm.test(clause));
      const nominal = nominalIndex < 0 ? [] : [{ field, retainOnRemoval: true,
        // 名词记录起点之后完整保留，不再按否定或时态词形挑选尾句；无法证明独立的前件同样保留。
        text: [...statements.slice(0, index).filter((value) => !independentExplanation(value)),
          clauses.filter((value, valueIndex) => valueIndex >= nominalIndex || !independentExplanation(value)).join('，'),
          ...statements.slice(index + 1)].join('。') }];
      if (!isOperation(statement)) return nominal;
      const colon = statement.search(/[：:]/u);
      const instruction = colon >= 0 && isOperation(statement.slice(0, colon))
        && !isOperation(statement.slice(colon + 1)) && !carriesScope(statement.slice(colon + 1))
        ? statement.slice(0, colon) : statement;
      const context = statements.slice(0, index).filter((prior) => !isOperation(prior) && carriesScope(prior));
      const condition = context.length ? `${context.join('。')}。` : '';
      const following: string[] = [];
      for (const statement of statements.slice(index + 1)) {
        // 同一操作后的范围可隔着解释句出现；跳过解释而不丢掉随后的人群/条件限定。
        // 下一项实际操作有自己的作用域，不将两项操作的签名混在一起。
        if (isOperation(statement)) break;
        if (carriesScope(statement)) following.push(statement);
      }
      return [...nominal, { field, text: `${condition}${instruction}${following.length ? `。${following.join('。')}` : ''}` }];
    });
  });
}

const medicationChangeOperation = /(?:停药|停用|停服|换药|加量|减量|增量|调整剂量|开始服用|改用|(?:增加|减少|调整|改变)[^。；;，,！？!?\n]{0,6}(?:剂量|药量)|(?:剂量|药量)[^。；;，,！？!?\n]{0,6}(?:增加|减少|调整|改变))/u;
const medicationNominalForm = /(?:口服|注射)(?:液(?!体)|剂(?!量))/u;
const medicationAdministration = /(?:服用|服药|用药|口服(?!液(?!体)|剂(?!量))|注射(?!液(?!体)|剂(?!量))|给药|使用药物)/gu;
const medicationOperation = /(?:停药|停用|停服|换药|加量|减量|增量|调整剂量|开始服用|改用|服用|服药|用药|口服(?!液(?!体)|剂(?!量))|注射(?!液(?!体)|剂(?!量))|给药|使用药物)/u;
const medicationDose = /(?:\d+(?:\.\d+)?|[一二两三四五六七八九十百千]+)\s*(?:mcg|µg|μg|ug|mg|IU|g|毫克|微克|国际单位|克|粒|片|滴|袋|次)(?![a-z]|\/(?:dL|mL|L)\b)/iu;
// 给药时间/频次本身就是操作结构，即使省略药名或“建议”等前缀也须保护。
const medicationSchedule = /(?:(?:每隔|每|隔)(?:[一二两三四五六七八九十\d]+)?(?:天|日|周|月|小时)(?:[一二两三四五六七八九十\d]+次)?|(?:早|午|晚|晨|睡|餐|饭)(?:前|后)?|早晚|按需|按时)(?:各)?\s*(?:服(?!装|饰)|用药|口服(?!液(?!体)|剂(?!量))|注射(?!液(?!体)|剂(?!量))|给药)/u;
const medicationDecisionLead = /(?:请|必须|应该|应当|建议|需要|宜|可以|可|应|要)(?:(?:你|您|先|立即|现在|自行|擅自|开始|继续|恢复|直接|暂停|尽快|按医嘱|根据医嘱)){0,3}$/u;
const medicationFutureContext = /(?:下次|将来|以后|今后|未来|准备|打算|计划|接下来)/u;
const medicationStatusContext = /(?:正在|已在|已经|目前|当前|现在|曾经|既往|过去|以前|之前|原来|原先|(?:检查|检测|采样|抽血|采血)(?:当时|时|前))/u;

/** 状态问题只询问已有情况；疑问句里的未来方案、决策、剂量或独立操作不获豁免。 */
function isMedicationStatusQuestion(clause: string): boolean {
  return /(?:是否|有无|有没有|哪些|什么|哪种|吗)/u.test(clause)
    && medicationStatusContext.test(clause) && !medicationFutureContext.test(clause)
    && !medicationChangeOperation.test(clause) && !medicationSchedule.test(clause)
    && [...clause.matchAll(medicationAdministration)].every((match) =>
      !medicationDecisionLead.test(clause.slice(0, match.index)));
}

/** 自述既有状态是待复核的事实转述，不是给药指令；后续独立命令仍按各自分句检查。 */
function isReportedMedicationState(clause: string): boolean {
  const report = /(?:自述|(?:本人|患者|用户)(?:表示|反馈|报告))/u.exec(clause);
  if (!report) return false;
  const statement = clause.slice(report.index + report[0].length);
  // 不为条件、决策、剂量、频次或变更行为授予背景豁免，来源相符性仍由完整 P04 核对。
  if (/(?:请|建议|必须|应该|应当|需要|可以|务必|宜|若|如果|除非|只有|是否|有无|不要|不得|切勿|禁止|因此|然后|并且|即可|应|需|要)/u.test(clause)
    || medicationFutureContext.test(clause) || medicationChangeOperation.test(clause)
    || medicationSchedule.test(clause) || medicationDose.test(clause)) return false;
  return [...statement.matchAll(medicationAdministration)].length === 1;
}

/**
 * 服药情况、既有治疗背景以及药物影响的说明不等于给药。
 * 仅将名词性/解释性出现判为背景；停换药、频次、决策及否定提醒仍独立检查。
 */
function isMedicationBackgroundMention(clause: string, match: RegExpMatchArray): boolean {
  const before = clause.slice(0, match.index);
  const after = clause.slice(match.index! + match[0].length);
  if (medicationDecisionLead.test(before) || medicationFutureContext.test(clause)) return false;
  // “检查前用药……尚未提供”是在描述缺失背景，不是要求用药。
  // 按完整缺失陈述的语法判定，不为新背景名词不断追加白名单；任何独立动作、剂量和频次
  // 仍由 hasMedicationOperation 的前置检查拦住，疑问或决策结构也不能借此通过。
  if (!/(?:请|应|需|要|可|宜|必须|建议|是否|有无)/u.test(after)
    && /^[\p{Script=Han}A-Za-z\s]{0,24}(?:尚未提供|未提供|未记录|未说明|不详|未知|缺失|不完整|尚不完整|待补充|待确认)[。]?$/u.test(after)) return true;
  return /^(?:(?:和|与|及|以及)[\p{Script=Han}A-Za-z]{1,16})?(?:情况|背景|状态|史|记录|信息|依从性|与否)/u.test(after)
    || /^(?:药物)?(?:可能|或许|也|可|会|能|可能会)*(?:影响|干扰|改变(?:检测|检验|检查)?结果|与[^。；;，,！？!?\n]{0,12}(?:有关|相关))/u.test(after);
}

/** “未提供 A、B 及检测前用药”中的并列宾语不能在顿号处丢掉缺失谓词。 */
function isMissingMedicationObjectList(clause: string): boolean {
  const match = /^(?:但|不过|然而)?(?:(?:本次|当前|目前|现有)(?:资料|报告)?(?:中)?|(?:资料|报告)(?:中)?)?(?:尚未提供|未提供|未记录|未说明|缺少|缺乏)(?<objects>[\p{Script=Han}A-Za-z、\s]+)$/u.exec(clause.trim());
  if (!match?.groups) return false;
  const objects = match.groups.objects!;
  // 仅有名词性宾语列表；决策、未来动作、条件及否定提醒不借缺失前缀取得豁免。
  if (/(?:请|应|需|要|可|宜|必须|建议|先|立即|马上|自行|擅自|开始|继续|恢复|暂停|如果|除非|只有|不要|不得|切勿|禁止|因此|然后|并且)/u.test(objects)
    || medicationFutureContext.test(objects) || medicationChangeOperation.test(objects)
    || medicationSchedule.test(objects) || medicationDose.test(objects)) return false;
  const mentions = [...objects.matchAll(medicationAdministration)];
  return mentions.length > 0 && mentions.every((mention) => {
    // 给药动词必须是完整宾语的末尾，不能把“用药治疗…”等独立动作吞掉。
    const tail = objects.slice(mention.index! + mention[0].length);
    return /^(?:(?:、|以及|及|和|与)[\p{Script=Han}A-Za-z\s]+)?$/u.test(tail)
      && !/(?:、|以及|及|和|与)/u.test(tail.replace(/^(?:、|以及|及|和|与)/u, ''));
  });
}

function hasMedicationOperation(text: string): boolean {
  return text.split(/[。；;，,！？!?\n]/u).some((list) => {
    if (isMissingMedicationObjectList(list)) return false;
    return list.split('、').some((clause) => {
      if (/(?:按|遵照|依照)(?:原)?医嘱(?:使用|服用|给药|执行)/u.test(clause)
        || medicationChangeOperation.test(clause) || medicationSchedule.test(clause)
        || medicationOperation.test(clause) && medicationDose.test(clause)) return true;
      if (isMedicationStatusQuestion(clause) || isReportedMedicationState(clause)) return false;
      return [...clause.matchAll(medicationAdministration)].some((match) => !isMedicationBackgroundMention(clause, match));
    });
  });
}

/**
 * “不因单次结果自行改变处理”的背景和禁令分开保存，但不把任意条件句缩成最短停药子句。
 * 只解析无并列/条件分句的完整句；否定、单次范围及整个自行/擅自动作后缀仍逐字保护。
 */
function singleResultMedicationReminder(text: string): { lead: string; scope: string; background: string; instruction: string } | null {
  const match = /^(?<lead>不(?:应|要|得)?因(?:为)?(?<scope>单次|一次))(?<background>[^。；;，,！？!?\n]+?)(?<instruction>(?:自行|擅自)[^。；;，,！？!?\n]+[。]?)$/u.exec(text);
  return match?.groups ? { lead: match.groups.lead!, background: match.groups.background!,
    scope: match.groups.scope!, instruction: match.groups.instruction! } : null;
}

/** 只有独立的检验测量值可去掉细节；剂量、疗程、症状及就医条件不属于此处背景。 */
function isMeasurementValueBackground(text: string): boolean {
  return /^(?:<=|>=|[<>≤≥=])?\s*[+−-]?\d+(?:\.\d+)?(?:[eE][+−-]?\d+)?(?:\s*(?:%|mmHg|(?:[munpµμ]?mol|[munµμ]?g)\/(?:[dD]?[lL]|m[lL])|(?:m|u|µ|μ)?[iI][uU]\/(?:m[lL]|[lL])|m[lL]\/min(?:\/1\.73m[2²])?))?$/u.test(text.trim());
}

/** 封闭的通用测量名词语法；任意汉字、括号或新前缀不能隐藏症状、条件和动作。 */
function isQualitativeMeasurementBackground(text: string): boolean {
  return /^(?:(?:检测|检验|检查|化验|测量))?(?:指标|数值|结果)(?:轻(?:度)?(?:偏)?[高低]|偏[高低]|异常|波动|变化)$/u.test(text);
}

/**
 * 裸数值本身不能推出高低。只重用原节点另一个独立说明中已有的完整范围和定性，
 * 且整个说明字段只能是这条测量描述；不能从条件句、并列句或复核新增说明中摘取授权。
 */
function hasPriorIndependentMeasurementDescription(node: ClinicalNode, editedField: string, scope: string, background: string): boolean {
  const description = `${scope}${background}`;
  return visibleAssessmentTextFields(node).some(({ field, text }) => field !== editedField
    && (field === 'why' || field === 'rationale')
    && [description, `${description}。`, `对应${description}`, `对应${description}。`].includes(text.trim()));
}

function sameMedicationInstruction(node: ClinicalNode, before: { field: string; text: string }, after: { field: string; text: string }): boolean {
  if (before.field !== after.field) return false;
  if (before.text === after.text) return true;
  const prior = singleResultMedicationReminder(before.text);
  const current = singleResultMedicationReminder(after.text);
  return prior !== null && current !== null && prior.lead === current.lead
    && prior.instruction === current.instruction && isMeasurementValueBackground(prior.background)
    && isQualitativeMeasurementBackground(current.background)
    && hasPriorIndependentMeasurementDescription(node, before.field, current.scope, current.background);
}

function medicationInstructionChanged(before: ClinicalNode, after: ClinicalNode): boolean {
  const prior = medicationInstructions(before);
  const current = medicationInstructions(after);
  if (current.some((instruction) => !prior.some((original) => sameMedicationInstruction(before, original, instruction)))) return true;
  // 上述窄豁免不能顺带删除禁令、否定或完整字段；不能因删后不再命中动作识别而绕过。
  const afterFields = medicationInstructions(after);
  return prior.some((instruction) => (instruction.retainOnRemoval || hasNegatedMedicationReminder(instruction.text))
    && !afterFields.some((field) => sameMedicationInstruction(before, instruction, field)));
}

function diagnosticStatusNarrowed(before: HealthClaim, after: HealthClaim): boolean {
  if (before.diagnosticStatus === after.diagnosticStatus) return true;
  if (after.diagnosticStatus === null) return after.kind !== 'diagnostic_assessment';
  if (before.diagnosticStatus === null) return false;
  // documented 与 criteria_met 的依据不同，不能当成同级状态互换。
  const narrower: Record<NonNullable<HealthClaim['diagnosticStatus']>, NonNullable<HealthClaim['diagnosticStatus']>[]> = {
    documented: ['likely', 'possible', 'undetermined'], criteria_met: ['likely', 'possible', 'undetermined'],
    likely: ['possible', 'undetermined'], possible: ['undetermined'], undetermined: []
  };
  return narrower[before.diagnosticStatus].includes(after.diagnosticStatus);
}

function claimKindNarrowed(before: HealthClaim['kind'], after: HealthClaim['kind']): boolean {
  const allowed: Record<HealthClaim['kind'], HealthClaim['kind'][]> = {
    source_fact: ['source_fact'], trend: ['trend', 'source_fact'],
    interpretation: ['interpretation', 'source_fact'],
    diagnostic_assessment: ['diagnostic_assessment', 'interpretation', 'source_fact']
  };
  return allowed[before].includes(after);
}

function knowledgeNarrowed(before: HealthClaim, after: HealthClaim, suppliedKnowledgeIds: readonly string[]): boolean {
  if (after.knowledgeSourceIds.some((id) => !before.knowledgeSourceIds.includes(id) && !suppliedKnowledgeIds.includes(id))) return false;
  return before.knowledgeBasis === after.knowledgeBasis
    || after.knowledgeSourceIds.length === 0 && after.criteriaBasis === null
      && (after.knowledgeBasis === 'not_applicable'
        || after.knowledgeBasis === 'model_general' && ['catalog', 'retrieved'].includes(before.knowledgeBasis));
}

/**
 * P04 的替换权限门禁，不能代替完整 schema、医学语义、来源证明或复核回执校验。
 * 只允许原目标内降低断言、删除不适用引用和措辞纠错；不从相同 ID 推导新编辑权限。
 */
export function inspectAssessmentReviewBoundary(
  original: MemberAssessmentCandidateV3,
  reviewed: MemberAssessmentCandidateV3,
  targetId: string,
  evidenceCatalog: readonly MemberEvidenceRef[],
  referenceDate: string,
  suppliedKnowledgeIds: readonly string[] = [],
  rebuiltSystemStatusRestorations: readonly RebuiltSystemStatusRestoration[] = [],
  actionDependencyRebindings: readonly ActionDependencyRebinding[] = [],
  evidenceResolutions: readonly AssessmentEvidenceResolution[] = [],
  evidenceResolutionTargetIds: readonly string[] = []
): AssessmentReviewBoundaryResult {
  const reasons = new Set<AssessmentReviewBoundaryReason>();
  const add = (condition: boolean, reason: AssessmentReviewBoundaryReason) => { if (condition) reasons.add(reason); };
  const result = (): AssessmentReviewBoundaryResult => ({ preserved: reasons.size === 0, reasonCodes: [...reasons] });
  add(original.personId !== reviewed.personId || original.inputSignature !== reviewed.inputSignature
    || original.mode !== reviewed.mode || !sameIds(original.requestedSystemIds, reviewed.requestedSystemIds), 'candidate_scope_changed');
  const beforeTargets = targets(original, targetId);
  const afterTargets = targets(reviewed, targetId);
  add(beforeTargets.length === 0 || afterTargets.length === 0, 'target_missing');
  add(beforeTargets.length > 1 || afterTargets.length > 1
    || original.knowledgeSources.some((node) => node.id === targetId)
    || reviewed.knowledgeSources.some((node) => node.id === targetId), 'target_ambiguous');
  if (beforeTargets.length !== 1 || afterTargets.length !== 1) return result();
  const beforeTarget = beforeTargets[0]!;
  const afterTarget = afterTargets[0]!;
  add(beforeTarget.type !== afterTarget.type, 'target_type_changed');
  if (beforeTarget.type !== afterTarget.type) return result();
  const before = beforeTarget.value;
  const after = afterTarget.value;
  const evidenceResolution = validAssessmentEvidenceResolution(original, reviewed, targetId, evidenceCatalog, evidenceResolutions);
  add(evidenceResolutionTargetIds.includes(targetId) && !evidenceResolution, 'evidence_resolution_unproven');
  const supportPreserved = (oldIds: readonly string[], newIds: readonly string[]) =>
    isSubset([...oldIds, ...evidenceResolution?.reboundEvidenceIds ?? []], newIds);
  add(before.id !== after.id || after.id !== targetId, 'identity_changed');

  if ('text' in before && 'text' in after) {
    add(before.topicKey !== after.topicKey, 'identity_changed');
    add(!sameIds(before.systemIds, after.systemIds), 'system_scope_changed');
    add(!supportPreserved(before.evidenceIds, after.evidenceIds), 'support_expanded');
    add(after.evidenceIds.length === 0, 'support_empty');
    add(!isSubset(before.counterEvidenceIds, after.counterEvidenceIds), 'counter_evidence_expanded');
    add(after.evidenceIds.some((id) => before.counterEvidenceIds.includes(id) && !before.evidenceIds.includes(id)), 'counter_evidence_promoted');
    add(!isSubset(before.trendIds, after.trendIds), 'trend_expanded');
    add(!knowledgeNarrowed(before, after, suppliedKnowledgeIds), 'knowledge_scope_expanded');
    add(!claimKindNarrowed(before.kind, after.kind), 'claim_kind_expanded');
    add(after.diseaseName !== before.diseaseName && after.diseaseName !== null, 'disease_changed');
    add(!diagnosticStatusNarrowed(before, after), 'diagnostic_certainty_increased');
    add(after.kind === 'diagnostic_assessment'
      ? !after.diseaseName || after.diagnosticStatus === null
      : after.diseaseName !== null || after.diagnosticStatus !== null || after.criteriaBasis !== null, 'diagnostic_fields_inconsistent');
    // 只允许连同标准结论一起撤除整份标准；保留 criteria_met 时，条件不得删改。
    add(stableHash(before.criteriaBasis) !== stableHash(after.criteriaBasis)
      && !(before.criteriaBasis !== null && after.criteriaBasis === null && after.diagnosticStatus !== 'criteria_met'), 'criteria_changed');
    const consequence = { routine: 0, important: 1, high: 2 };
    add(consequence[after.consequenceLevel] > consequence[before.consequenceLevel], 'consequence_increased');
    add(before.materialUncertainty !== null && after.materialUncertainty === null, 'uncertainty_removed');
    // 可以纠正同一组来源的解释，但不能悄悄删除变化判断，或换入其他时期的个人资料。
    add(Boolean(before.changeAssessment) && !after.changeAssessment, 'uncertainty_removed');
    if (after.changeAssessment) {
      add(!isSubset([...after.evidenceIds, ...after.counterEvidenceIds],
        [...after.changeAssessment.currentEvidenceIds, ...after.changeAssessment.previousEvidenceIds]), 'support_expanded');
    }
    add(before.temporalStatus !== after.temporalStatus
      && after.temporalStatus !== 'uncertain'
      && !(after.temporalStatus === 'current' && supportsReferenceDate(before.evidenceIds, evidenceCatalog, referenceDate)), 'temporal_scope_changed');
    // 完整数字顺序仍受保护；只有“纯日期擦除+明确时间不确定”取得窄收窄证明。
    // 换年月、改派事件、删除医学事实或改变任一来源字段都不能取得该证明。
    const sourceNumericChanged = before.kind === 'source_fact'
      && stableHash(numericLiterals(before.text)) !== stableHash(numericLiterals(after.text));
    const sourceNonDateNumericChanged = stableHash(nonDateNumericLiterals(before.text))
      !== stableHash(nonDateNumericLiterals(after.text));
    add(sourceNumericChanged && !sourceNonDateNumericChanged && !sourceFactDateErasurePreserved(before, after, evidenceCatalog), 'date_scope_or_precision_changed');
    add(sourceNumericChanged && sourceNonDateNumericChanged, 'source_fact_numeric_changed');
  } else if ('firstStep' in before && 'firstStep' in after) {
    add(before.dedupeKey !== after.dedupeKey, 'identity_changed');
    add(!sameIds(before.systemIds, after.systemIds), 'system_scope_changed');
    add(before.kind !== after.kind || before.timingBasis !== after.timingBasis
      || before.lifestyleDomain !== after.lifestyleDomain || before.lifestyleBasis !== after.lifestyleBasis, 'action_scope_changed');
    add(before.sourceInstructionObservationId !== after.sourceInstructionObservationId
      || (before.sourceInstructionObservationId !== undefined || after.sourceInstructionObservationId !== undefined)
        && before.firstStep !== after.firstStep, 'source_instruction_changed');
    const claimSupportExpanded = !isSubset(before.claimIds, after.claimIds);
    add(claimSupportExpanded && !actionDependencyRebindingPreserved(original, reviewed, before, after,
      evidenceCatalog, actionDependencyRebindings) || !supportPreserved(before.evidenceIds, after.evidenceIds), 'support_expanded');
    const generalHabit = before.claimIds.length + before.evidenceIds.length === 0
      && before.kind === 'habit' && after.kind === 'habit' && before.urgency === 'routine' && after.urgency === 'routine'
      && before.lifestyleBasis === 'general' && after.lifestyleBasis === 'general'
      && before.lifestyleDomain !== undefined && before.lifestyleDomain === after.lifestyleDomain
      && ['none', 'practical_trial'].includes(after.timingBasis) && after.knowledgeSourceIds.length === 0;
    add(after.claimIds.length + after.evidenceIds.length === 0 && !generalHabit, 'support_empty');
    add(!isSubset(before.knowledgeSourceIds, after.knowledgeSourceIds), 'knowledge_scope_expanded');
    const urgency = { routine: 0, soon: 1, urgent: 2, emergency: 3 };
    add(urgency[after.urgency] > urgency[before.urgency], 'urgency_increased');
    add(hasNumericSupplementDose(after) && !hasNumericSupplementDose(before), 'supplement_dose_introduced');
  } else if ('question' in before && 'question' in after) {
    add(!isSubset(before.relatedClaimIds, after.relatedClaimIds) || !supportPreserved(before.evidenceIds, after.evidenceIds), 'support_expanded');
    add(after.relatedClaimIds.length + after.evidenceIds.length === 0, 'support_empty');
  } else if ('actionIds' in before && 'actionIds' in after) {
    add(!isSubset(before.claimIds, after.claimIds) || !isSubset(before.actionIds, after.actionIds), 'support_expanded');
    add(after.claimIds.length + after.actionIds.length === 0, 'support_empty');
    if ('systemId' in before && 'systemId' in after) {
      add(before.systemId !== after.systemId, 'system_scope_changed');
      const restorations = rebuiltSystemStatusRestorations.filter((item) => item.targetId === targetId);
      const restoration = restorations.length === 1 ? restorations[0] : undefined;
      const restoresReviewedConcern = before.status === 'insufficient' && restoration?.systemId === before.systemId
        && restoration.originalStatus === after.status && hasSurvivingSystemSupport(reviewed, after, evidenceCatalog);
      add(before.status !== after.status && !restoresReviewedConcern, 'system_status_changed');
    }
  }

  const urgency = { routine: 0, soon: 1, urgent: 2, emergency: 3 };
  const retainedActionIds = 'actionIds' in before && 'actionIds' in after
    ? before.actionIds.filter((id) => after.actionIds.includes(id)) : [];
  const priorUrgency = Math.max(textUrgency(before), 'urgency' in before ? urgency[before.urgency] : 0,
    ...original.actions.filter((action) => retainedActionIds.includes(action.id)).map((action) => urgency[action.urgency]));
  add(textUrgency(after) > priorUrgency, 'urgency_increased');
  add(medicationInstructionChanged(before, after), 'medication_instruction_changed');
  // 只补原有引用已明示的完整日期，不把反证数值借成支持结果，也不补医疗期限。
  const referenceIds = 'evidenceIds' in before ? [...before.evidenceIds,
    ...('counterEvidenceIds' in before ? before.counterEvidenceIds : [])]
    : 'actionIds' in before && 'actionIds' in after ? [
      ...original.claims.filter((claim) => before.claimIds.includes(claim.id) && after.claimIds.includes(claim.id))
        .flatMap((claim) => [...claim.evidenceIds, ...claim.counterEvidenceIds]),
      ...original.actions.filter((action) => before.actionIds.includes(action.id) && after.actionIds.includes(action.id))
        .flatMap((action) => action.evidenceIds)
    ] : [];
  const narrativeDateProjection = 'text' in before && before.kind === 'interpretation' || 'actionIds' in before;
  const sourceNumbers = evidenceCatalog.filter((source) => referenceIds.includes(source.id)).flatMap((source) =>
    calendarDateTokens(normalizeDates(`${source.locator ?? ''} ${source.quote ?? ''}`)).flatMap((date) => {
      const exact = calendarFact(date);
      if (!narrativeDateProjection || date.precision === 'month_day') return date.precision === 'day' ? [exact] : [];
      const year = date.text.slice(0, 4);
      const month = date.precision === 'day' ? date.canonical.slice(5, 7) : date.text.match(/\d+/gu)?.[1]?.padStart(2, '0');
      return [exact, `date:year:${year}`, ...(month ? [`date:month:${year}-${month}`] : [])];
    }));
  // 完整节点hash、同次来源及逐字字段形状均已锁定时，栏目原话中的方法编号不是新增测量值。
  // 仅从这两次数值比较排除该字段的变化；正文、来源事实和用药操作仍走原门禁。
  const afterForNumericComparison = evidenceResolution?.preservesSourceUncertainty
    && 'materialUncertainty' in before && 'materialUncertainty' in after
    ? { ...after, materialUncertainty: before.materialUncertainty } : after;
  const maskContextQuotes = (value: ClinicalNode): ClinicalNode => {
    if (!('text' in value) || !evidenceResolution?.contextQuotes?.length) return value;
    const projected = structuredClone(value);
    for (const { field, quote } of evidenceResolution.contextQuotes) {
      if (field === 'changeAssessment.reason') {
        if (projected.changeAssessment) projected.changeAssessment.reason = projected.changeAssessment.reason.replace(quote, '');
      } else if (field === 'materialUncertainty') projected.materialUncertainty = projected.materialUncertainty?.replace(quote, '') ?? null;
      else projected.rationale = projected.rationale.replace(quote, '');
    }
    return projected;
  };
  const numericFactAdded = !isSubset([...numericFacts(maskContextQuotes(before)), ...sourceNumbers], numericFacts(maskContextQuotes(afterForNumericComparison)));
  const nonDateNumericFactAdded = !isSubset(numericFacts(maskContextQuotes(before), true), numericFacts(maskContextQuotes(afterForNumericComparison), true));
  add(numericFactAdded && !nonDateNumericFactAdded, 'date_scope_or_precision_changed');
  add(numericFactAdded && nonDateNumericFactAdded, 'numeric_fact_added');
  // 只为原支持中仍保留的、唯一且真实的个人来源补全名称，不从反证、知识或新引用借标识。
  // 来源内出现某个数字结果仍不授权把该结果添进正文；这里只处理完整的项目/分类名称。
  const retainedEvidenceIds = 'evidenceIds' in before && 'evidenceIds' in after
    ? before.evidenceIds.filter((id) => after.evidenceIds.includes(id)) : [];
  const sourceIdentifiers = retainedEvidenceIds.flatMap((id) => {
    const matches = evidenceCatalog.filter((source) => source.id === id);
    const source = matches.length === 1 ? matches[0] : undefined;
    return source && ['observation', 'clinical_finding', 'source_span'].includes(source.kind)
      && source.documentId && source.sourceSpanId && source.knowledgeId === null
      ? numericIdentifiers(normalizeDates(source.quote ?? '')) : [];
  });
  const beforeIdentifiers = visibleNumericIdentifiers(maskContextQuotes(before));
  const afterIdentifiers = visibleNumericIdentifiers(maskContextQuotes(after));
  add(!isSubset([...beforeIdentifiers, ...sourceIdentifiers], afterIdentifiers)
    || beforeIdentifiers.some((identifier) => !afterIdentifiers.includes(identifier))
      && afterIdentifiers.some((identifier) => !beforeIdentifiers.includes(identifier)), 'numeric_fact_added');
  add(!isSubset(relativeTimeFacts(before), relativeTimeFacts(after)), 'time_fact_added');
  const assertions = (node: ClinicalNode) => visibleAssessmentTextFields(node).filter(({ field }) => field !== 'diseaseName')
    .flatMap(({ text }) => highConsequenceAssertionMentions(text));
  const priorDirections = assertions(before);
  // 只能从保留下来的原关联主张取得既有方向，已撤除的主张不能继续替正文背书。
  const relatedIds = (node: ClinicalNode): string[] => 'claimIds' in node ? node.claimIds
    : 'relatedClaimIds' in node ? node.relatedClaimIds : [];
  const retainedClaims = relatedIds(before).filter((id) => relatedIds(after).includes(id));
  for (const claim of original.claims.filter((node) => retainedClaims.includes(node.id)
    && node.kind === 'diagnostic_assessment' && node.diagnosticStatus !== null)) {
    priorDirections.push(...assertions(claim).map((assertion) => ({ ...assertion,
      definite: assertion.definite && (claim.diagnosticStatus === 'documented' || claim.diagnosticStatus === 'criteria_met') })));
  }
  add(assertions(after).some((assertion) => !priorDirections.some((prior) => prior.diseaseName === assertion.diseaseName
    && (!assertion.definite || prior.definite))), 'high_consequence_assertion_expanded');
  return result();
}
