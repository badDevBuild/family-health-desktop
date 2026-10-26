import type { DirectOriginalReadingResult } from '@contracts';
import type { DirectOriginalCandidateDiagnostic } from '@core';

const compact = (value: string) => value.normalize('NFKC').replace(/\s+/gu, '');

/**
 * 只解释主体来源的缺口及共享摘录的保留义务，不判断成员归属，也不修改接纳结果。
 * 引文的比较沿用既有来源门禁；不按姓名、检查内容或绑定成员猜测身份。
 */
export function diagnoseDirectOriginalSubjectSources(reading: DirectOriginalReadingResult,
  options: { protectedSourceKeys?: ReadonlySet<string> } = {}): DirectOriginalCandidateDiagnostic[] {
  const subject = reading.extraction.subject;
  // 原件未提供主体时，用户已选成员仍是合法入口；不能要求模型补造姓名或来源。
  if (subject.confidence === 'absent') return [];

  const diagnostics: DirectOriginalCandidateDiagnostic[] = [];
  const add = (reasonCode: string, fieldPath: string, constraint: string,
    reference?: { sourceSpanId: string; actualRole: string | null }) => {
    diagnostics.push({ targetId: 'subject', reasonCode, fieldPath,
      ...(reference ? { ...reference, allowedRoles: ['identity'] } : {}), constraint });
  };

  if (subject.confidence === 'uncertain') {
    add('SUBJECT_IDENTITY_UNCERTAIN', 'confidence',
      '主体识别仍不确定。仅依据已授权原页区分患者与工作人员；不能用绑定成员或显示名称补答案，无法确认时保留不确定状态。');
  } else if (!subject.reportedName?.trim()) {
    add('SUBJECT_REPORTED_NAME_REQUIRED', 'reportedName',
      'confidence 为 explicit 时须有原件明确提供的患者姓名；请重读已授权原页，不能从绑定成员或显示名称反推，无法确认时不得维持 explicit。');
  }

  if (subject.confidence === 'explicit' && subject.evidence.length === 0) {
    add('SUBJECT_EVIDENCE_REQUIRED', 'evidence',
      'explicit 主体须明确引用当前原件的清晰 identity 摘录；请重读已授权原页建立引用，不能借用检查结果或按绑定成员补造身份。');
  }

  subject.evidence.forEach((ref, index) => {
    const path = `evidence[${index}]`;
    // 不使用 find 或展示姓名兜底；同 key 多个摘录不能证明引用唯一。
    const sources = reading.sourceExcerpts.filter((source) => source.localKey === ref.sourceSpanId);
    if (sources.length !== 1) {
      add(sources.length ? 'SUBJECT_SOURCE_AMBIGUOUS' : 'SUBJECT_SOURCE_MISSING', `${path}.sourceSpanId`,
        '主体引用必须唯一指向当前原件中的一个 identity 摘录；请从已授权原页建立独立来源并重绑，不能借用同名或其他报告的摘录。',
        { sourceSpanId: ref.sourceSpanId, actualRole: null });
      return;
    }
    const source = sources[0]!;
    const reference = { sourceSpanId: source.localKey, actualRole: source.role };
    if (source.clarity !== 'clear') add('SUBJECT_SOURCE_NOT_CLEAR', `${path}.sourceSpanId`,
      '主体引用的摘录须为 clarity=clear；请重读该授权原页，无法明确识别患者时保留不确定状态，不能仅修改 clarity 标签放行。', reference);
    if (source.role !== 'identity') add('SUBJECT_SOURCE_ROLE_NOT_ALLOWED', `${path}.sourceSpanId`,
      '主体证据只能指向 identity 角色。若同一原页同时包含身份和检查结果，须分别建立清晰摘录并分别绑定，不能将身份来源整块改为 finding 而丢失主体依据。', reference);
    if (!compact(source.quote)) add('SUBJECT_SOURCE_QUOTE_EMPTY', `${path}.sourceSpanId`,
      '主体来源摘录须含原件明确提供的非空身份文字，不能以空摘录或绑定成员名称替代原件来源。', reference);
    if (ref.quote !== null && !compact(ref.quote)) add('SUBJECT_REFERENCE_QUOTE_EMPTY', `${path}.quote`,
      'quote 应为所指同一 identity 摘录内的非空连续引用；null 仅表示引用该摘录整段，不能使用空白字符串。', reference);
    else if (ref.quote !== null && !compact(source.quote).includes(compact(ref.quote))) {
      add('SUBJECT_REFERENCE_NOT_IN_SOURCE', `${path}.quote`,
        '主体 quote 须与所指同一 identity 摘录相等或为其连续子串；不能改写、拼接、借用其他摘录或根据显示姓名补造引文。', reference);
    }
  });

  // 只有现有主体本身有效时，才附加保留义务；这不是新的失败原因。
  if (subject.confidence === 'explicit' && diagnostics.length === 0) {
    subject.evidence.forEach((ref, index) => {
      if (!options.protectedSourceKeys?.has(ref.sourceSpanId)) return;
      const source = reading.sourceExcerpts.filter((item) => item.localKey === ref.sourceSpanId)[0]!;
      add('SUBJECT_REFERENCE_OBLIGATION', `evidence[${index}].sourceSpanId`,
        '该目标摘录同时承载当前有效主体的身份依据。修复时须保留其清晰 identity 角色及主体引用；如需拆分检查结果，应从同一已授权原页独立新增 identity 摘录并重绑 subject.evidence，不能把整块改成 finding 而丢失身份依据。',
        { sourceSpanId: source.localKey, actualRole: source.role });
    });
  }
  return diagnostics;
}
