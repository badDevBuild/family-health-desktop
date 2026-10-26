import type { DirectOriginalReadingResult, ObservationCandidate } from '@contracts';

type EvidenceRef = ObservationCandidate['evidence'][number];
const compact = (value: string) => value.normalize('NFKC').replace(/\s/gu, '');
// 封面可提供日期等附带信息；结果原话和具体空白字段自己的页仍必须已读取。
const requiresReadPage = (candidate: ObservationCandidate, ref: EvidenceRef, role: string) => role === 'finding' || role === 'instruction'
  || candidate.sourceBinding?.findingEvidence.some((item) => item.sourceSpanId === ref.sourceSpanId) === true;

/** 空白只保留模型明示的原件位置，不发布正常、unknown观测或推断缺失结果。 */
export function directOriginalNoResultSourceKeys(candidate: ObservationCandidate,
  reading: DirectOriginalReadingResult): string[] {
  if (candidate.value.kind !== 'unknown'
    || !['original_blank', 'not_performed', 'no_data'].includes(candidate.value.reason)
    || candidate.issues.some((issue) => issue.code.startsWith('blocking_')) || !candidate.evidence.length) return [];
  const excerptFor = (ref: EvidenceRef) => {
    const matches = reading.sourceExcerpts.filter((excerpt) => excerpt.localKey === ref.sourceSpanId);
    if (matches.length !== 1) return null;
    const excerpt = matches[0]!;
    const pages = reading.pageReadings.filter((page) => page.sourceSpanId === excerpt.pageSourceSpanId);
    if (excerpt.clarity !== 'clear' || pages.length !== 1 || (pages[0]!.status !== 'read'
      && (pages[0]!.status !== 'no_medical_content' || requiresReadPage(candidate, ref, excerpt.role)))) return null;
    if (ref.quote !== null && (!compact(ref.quote) || !compact(excerpt.quote).includes(compact(ref.quote)))) return null;
    return excerpt;
  };
  const allRefs = [...candidate.evidence, ...(candidate.sourceBinding?.headingEvidence ?? []),
    ...(candidate.sourceBinding?.findingEvidence ?? []), ...(candidate.clinicalContext?.conditions ?? [])];
  if (allRefs.some((ref) => !excerptFor(ref))) return [];
  const primaryRefs = candidate.sourceBinding?.findingEvidence ?? candidate.evidence.filter((ref) => {
    const role = excerptFor(ref)?.role;
    return role === 'finding' || role === 'instruction';
  });
  const primary = primaryRefs.filter((ref) => ref.sourceRole !== 'duplicate_source');
  if (primary.length && primary.every((ref) => {
    const role = excerptFor(ref)?.role;
    return (role === 'finding' || role === 'instruction')
      && candidate.evidence.some((evidence) => evidence.sourceSpanId === ref.sourceSpanId
        && evidence.sourceRole !== 'duplicate_source');
  })) return [...new Set(primary.map((ref) => ref.sourceSpanId))];

  // 没有结果文字时可引用模型明确绑定的字段标签；普通目录/页眉和模糊标题仍不能证明空白。
  if (candidate.value.reason !== 'original_blank' || candidate.value.rawText !== null
    || !candidate.sourceBinding || primary.length !== 1 || primaryRefs.length !== 1) return [];
  const ref = primary[0]!;
  const excerpt = excerptFor(ref);
  if (!excerpt || excerpt.role !== 'heading' || compact(excerpt.quote) !== compact(candidate.originalName)
    || ref.quote !== null && compact(ref.quote) !== compact(excerpt.quote)) return [];
  const general = candidate.evidence.filter((evidence) => evidence.sourceSpanId === ref.sourceSpanId
    && evidence.sourceRole !== 'duplicate_source');
  if (!general.length || general.some((evidence) => evidence.quote !== null
    && compact(evidence.quote) !== compact(excerpt.quote))) return [];
  return [ref.sourceSpanId];
}

export function isDirectOriginalExplicitNoResult(candidate: ObservationCandidate,
  reading: DirectOriginalReadingResult): boolean {
  return directOriginalNoResultSourceKeys(candidate, reading).length > 0;
}

export interface DirectOriginalNoResultDiagnostic {
  targetId: string;
  reasonCode: string;
  /** 相对候选对象的字段路径；来源标识仍用原件读取回执的 localKey。 */
  fieldPath: string;
  sourceSpanId?: string;
  actualRole?: string | null;
  allowedRoles?: string[];
  actualPageStatus?: string | null;
  constraint: string;
}

/** 仅解释既有空白判定为什么失败；不修改候选、原件回执或接纳门槛，不复制正文。 */
export function diagnoseDirectOriginalNoResult(candidate: ObservationCandidate,
  reading: DirectOriginalReadingResult): DirectOriginalNoResultDiagnostic[] {
  if (candidate.value.kind !== 'unknown'
    || !['original_blank', 'not_performed', 'no_data'].includes(candidate.value.reason)
    || directOriginalNoResultSourceKeys(candidate, reading).length > 0) return [];

  const diagnostic = (reasonCode: string, fieldPath: string, constraint: string,
    ref?: EvidenceRef, allowedRoles?: string[]): DirectOriginalNoResultDiagnostic => {
    const matches = ref ? reading.sourceExcerpts.filter((excerpt) => excerpt.localKey === ref.sourceSpanId) : [];
    const excerpt = matches.length === 1 ? matches[0]! : null;
    const pages = excerpt ? reading.pageReadings.filter((page) => page.sourceSpanId === excerpt.pageSourceSpanId) : [];
    return { targetId: candidate.localKey, reasonCode, fieldPath, constraint,
      ...(ref ? { sourceSpanId: ref.sourceSpanId, actualRole: excerpt?.role ?? null,
        actualPageStatus: pages.length === 1 ? pages[0]!.status : null } : {}),
      ...(allowedRoles ? { allowedRoles } : {}) };
  };
  const initial = candidate.issues.flatMap((issue, index) => issue.code.startsWith('blocking_')
    ? [diagnostic('NO_RESULT_BLOCKING_ISSUE', `issues[${index}].code`, '有阻断问题的候选不能保留为空白结果。')] : []);
  if (!candidate.evidence.length) initial.push(diagnostic('NO_RESULT_EVIDENCE_REQUIRED', 'evidence', '空白结果仍必须有原件来源。'));
  if (initial.length) return initial;

  const refs = (values: EvidenceRef[], fieldPath: string) => values.map((ref, index) => ({ ref, fieldPath: `${fieldPath}[${index}]` }));
  const evidence = refs(candidate.evidence, 'evidence');
  const finding = candidate.sourceBinding ? refs(candidate.sourceBinding.findingEvidence, 'sourceBinding.findingEvidence') : null;
  const allRefs = [...evidence, ...refs(candidate.sourceBinding?.headingEvidence ?? [], 'sourceBinding.headingEvidence'),
    ...(finding ?? []), ...refs(candidate.clinicalContext?.conditions ?? [], 'clinicalContext.conditions')];
  const sourceFailures = allRefs.flatMap(({ ref, fieldPath }) => {
    const matches = reading.sourceExcerpts.filter((excerpt) => excerpt.localKey === ref.sourceSpanId);
    if (!matches.length) return [diagnostic('NO_RESULT_SOURCE_MISSING', `${fieldPath}.sourceSpanId`, '来源 localKey 必须存在于本次原件读取回执。', ref)];
    if (matches.length !== 1) return [diagnostic('NO_RESULT_SOURCE_AMBIGUOUS', `${fieldPath}.sourceSpanId`, '来源 localKey 必须唯一对应一个片段。', ref)];
    const excerpt = matches[0]!;
    const failures: DirectOriginalNoResultDiagnostic[] = [];
    if (excerpt.clarity !== 'clear') failures.push(diagnostic('NO_RESULT_SOURCE_NOT_CLEAR', `${fieldPath}.sourceSpanId`, '空白来源片段必须清晰，不能由不确定转写证明空白。', ref));
    const pages = reading.pageReadings.filter((page) => page.sourceSpanId === excerpt.pageSourceSpanId);
    if (!pages.length) failures.push(diagnostic('NO_RESULT_PAGE_MISSING', `${fieldPath}.sourceSpanId`, '来源片段必须绑定本次回执中的原件页。', ref));
    else if (pages.length !== 1) failures.push(diagnostic('NO_RESULT_PAGE_AMBIGUOUS', `${fieldPath}.sourceSpanId`, '来源片段必须唯一绑定一个原件页读取状态。', ref));
    else if (pages[0]!.status !== 'read' && (pages[0]!.status !== 'no_medical_content' || requiresReadPage(candidate, ref, excerpt.role))) failures.push(diagnostic('NO_RESULT_PAGE_NOT_READ', `${fieldPath}.sourceSpanId`,
      requiresReadPage(candidate, ref, excerpt.role) ? '主要结果或具体空白字段所在原件页必须为 read，不能用 no_medical_content 页证明空白。'
        : '附带非结果引用所在原件页须为 read 或 no_medical_content，部分读取或无法读取仍不能作为可靠来源。', ref));
    if (ref.quote !== null) {
      if (!compact(ref.quote)) failures.push(diagnostic('NO_RESULT_QUOTE_EMPTY', `${fieldPath}.quote`, '引用文字不能是空白字符串；无引用文字时须明确使用 null。', ref));
      else if (!compact(excerpt.quote).includes(compact(ref.quote))) failures.push(diagnostic('NO_RESULT_QUOTE_NOT_IN_SOURCE', `${fieldPath}.quote`, '引用文字必须包含在所指向的原件来源片段中。', ref));
    }
    return failures;
  });
  if (sourceFailures.length) return sourceFailures;

  const excerptFor = (ref: EvidenceRef) => reading.sourceExcerpts.find((excerpt) => excerpt.localKey === ref.sourceSpanId)!;
  const primaryRefs = finding ?? evidence.filter(({ ref }) => ['finding', 'instruction'].includes(excerptFor(ref).role));
  const primary = primaryRefs.filter(({ ref }) => ref.sourceRole !== 'duplicate_source');
  if (!primary.length) {
    if (!candidate.sourceBinding && candidate.evidence.some((ref) => excerptFor(ref).role === 'heading')) {
      return [diagnostic('NO_RESULT_FIELD_BINDING_REQUIRED', 'sourceBinding', '普通标题不能证明结果空白；同名字段标签必须显式绑定为 findingEvidence。')];
    }
    return primaryRefs.length
      ? primaryRefs.map(({ ref, fieldPath }) => diagnostic('NO_RESULT_PRIMARY_SOURCE_REQUIRED', `${fieldPath}.sourceRole`, '空白来源至少须有一个非 duplicate_source 的主要依据。', ref))
      : [diagnostic('NO_RESULT_FINDING_EVIDENCE_REQUIRED', candidate.sourceBinding ? 'sourceBinding.findingEvidence' : 'evidence', '必须提供 finding 或 instruction 结果原话；字段标签须按显式同名空白字段规则绑定。')];
  }

  // 明确结果原话与无结果文字的同名字段是两种既有形式；不能用诊断建议互相冒充。
  if (primary.length > 1 && primary.every(({ ref }) => excerptFor(ref).role === 'heading')) {
    return [diagnostic('NO_RESULT_FIELD_SINGLE_SOURCE_REQUIRED', 'sourceBinding.findingEvidence', '字段标签形式必须只绑定一个明确的空白字段，不能以多个标题证明结果空白。', primary[0]!.ref, ['heading'])];
  }
  const headingOnly = primary.length === 1 && excerptFor(primary[0]!.ref).role === 'heading';
  if (!headingOnly) return primary.flatMap(({ ref, fieldPath }) => {
    const failures: DirectOriginalNoResultDiagnostic[] = [];
    const role = excerptFor(ref).role;
    if (role !== 'finding' && role !== 'instruction') failures.push(diagnostic('NO_RESULT_SOURCE_ROLE_NOT_ALLOWED', `${fieldPath}.sourceSpanId`,
      '结果原话须使用 finding 或 instruction；字段标签形式只能绑定唯一同名 heading。', ref, ['finding', 'instruction']));
    if (!candidate.evidence.some((item) => item.sourceSpanId === ref.sourceSpanId && item.sourceRole !== 'duplicate_source')) failures.push(diagnostic('NO_RESULT_PRIMARY_NOT_IN_EVIDENCE', `${fieldPath}.sourceSpanId`,
      '每个主要结果依据也必须出现在候选 evidence 中，且不能仅是 duplicate_source。', ref));
    return failures;
  });

  const { ref, fieldPath } = primary[0]!;
  const excerpt = excerptFor(ref);
  const fieldFailures: DirectOriginalNoResultDiagnostic[] = [];
  if (candidate.value.reason !== 'original_blank') fieldFailures.push(diagnostic('NO_RESULT_FIELD_REASON_NOT_BLANK', 'value.reason', 'not_performed 或 no_data 必须有明确结果原话，不能仅用字段标题证明。', ref, ['finding', 'instruction']));
  if (candidate.value.rawText !== null) fieldFailures.push(diagnostic('NO_RESULT_FIELD_RAW_TEXT_PRESENT', 'value.rawText', '同名字段标签形式只支持原件空白，rawText 必须为 null。', ref));
  if (!candidate.sourceBinding) fieldFailures.push(diagnostic('NO_RESULT_FIELD_BINDING_REQUIRED', 'sourceBinding', '同名字段标签必须有显式来源绑定。', ref));
  if (primaryRefs.length !== 1) fieldFailures.push(diagnostic('NO_RESULT_FIELD_SINGLE_SOURCE_REQUIRED', 'sourceBinding.findingEvidence', '字段标签形式必须仅绑定一个非重复主要来源，不能同时混入其他结果来源。', ref, ['heading']));
  if (compact(excerpt.quote) !== compact(candidate.originalName)) fieldFailures.push(diagnostic('NO_RESULT_FIELD_NAME_MISMATCH', 'originalName', '请按原件明确具体字段的完整标签及空白位置；字段标签须与 originalName 完整一致，不能省略标点、拼接标题或借用目录。', ref, ['heading']));
  if (ref.quote !== null && compact(ref.quote) !== compact(excerpt.quote)) fieldFailures.push(diagnostic('NO_RESULT_FIELD_QUOTE_NOT_EXACT', `${fieldPath}.quote`, '空白字段的绑定引用须为 null 或完整字段标签，不能只引局部文字。', ref, ['heading']));
  const general = evidence.filter(({ ref: item }) => item.sourceSpanId === ref.sourceSpanId && item.sourceRole !== 'duplicate_source');
  if (!general.length) fieldFailures.push(diagnostic('NO_RESULT_PRIMARY_NOT_IN_EVIDENCE', `${fieldPath}.sourceSpanId`, '空白字段的主要来源也必须在候选 evidence 中出现，且不能仅是 duplicate_source。', ref));
  for (const item of general) {
    if (item.ref.quote !== null && compact(item.ref.quote) !== compact(excerpt.quote)) fieldFailures.push(diagnostic('NO_RESULT_FIELD_QUOTE_NOT_EXACT', `${item.fieldPath}.quote`, '空白字段的候选 evidence 引用须为 null 或完整字段标签，不能只引局部文字。', item.ref, ['heading']));
  }
  return fieldFailures;
}
