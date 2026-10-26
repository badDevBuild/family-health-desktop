import type { HealthClaim, MemberAssessmentCandidateV3, MemberEvidenceRef } from '@contracts';

const currentHealthy = /^(?:目前|当前|现在|如今|今天|现阶段)(.{0,32}?)(正常|未见异常|无异常|无需(?:继续|再)?关注|不(?:再)?需要(?:继续)?关注)/;
const negatedAssertionLead = /(?:不代表|不能代表|不能说明|无法说明|不能据此|不能说|不能确认|无法确认|并非|不一定|是否|如果|假如|一般|通常)/;
const nonAssertionStart = /^(?:一般|通常|如果|若|当|假如|是否|请问|例如|比如|正常情况下)/;
const missingResult = /^(?:(?:目前|当前|现在|本次|这次|近期|本人|我)\s*)*(?:没有|缺少|未提供|尚未提供|未获得|尚未获得)(?:本次|这次|当前|近期|最新)?(?:的)?([\p{Script=Han}A-Za-z][\p{Script=Han}A-Za-z\d-]{1,24}?)(?:的)?(?:检查结果|检查|结果|资料)[。；;]?$/u;

function sentences(text: string): string[] {
  return text.match(/[^。；;\n]+[。；;]?/g) ?? [];
}

function isQuestion(text: string): boolean {
  return /[？?]|吗[。；;，,]?\s*$/.test(text);
}

type ExamPerformance = { key: string; performed: boolean };

/** 只识别完整日期的“已做/未做”；相对本次或普通缺资料表述仅由提示词改善，不增加处理回合。 */
function explicitExamPerformance(text: string): ExamPerformance[] {
  const matches: ExamPerformance[] = [];
  for (const sentence of sentences(text)) {
    if (isQuestion(sentence)) continue;
    for (const part of sentence.split(/[，,]/)) {
      const clause = part.trim();
      if (nonAssertionStart.test(clause)) continue;
      const match = /^(.*?)(尚未完成|没有接受|尚未接受|没有做过|尚未做过|还没做过|没有做|尚未做|还没做|未做过|没做过|未接受|未完成|未做|没做|已经接受|已经完成|已经做过|已接受|已完成|已做过|已做|接受了|完成了)([\p{Script=Han}A-Za-z\d-]{1,32}?(?:检查|检验|验光|超声|彩超|心电图|血常规|尿常规))([^。；;，,\n]*)/u.exec(clause);
      if (!match) continue;
      const [, before = '', predicate = '', exam = '', after = ''] = match;
      // 不猜多个检查的对应关系，也不把引用、条件、问题或他人的情况当成本人断言。
      if (!/^(?:因此)?(?:(?:本人|我|患者|受检者|本次|此次|这次|同次)|(?:于)?\d{4}[-年/.]\d{1,2}[-月/.]\d{1,2}日?|\s)*$/u.test(before)
        || /(?:和|与|及|或|的)/u.test(exam)
        || /^(?:的)?(?:完整)?(?:结果|报告|资料|记录|信息|数据|日期|时间|条件|参考范围|说法|判断|推断|描述)/u.test(after)) continue;
      const dates = [...before.matchAll(/(\d{4})[-年/.](\d{1,2})[-月/.](\d{1,2})日?/gu)];
      // 包括本人自述在内，“本次”都可能指过去一次就诊；不借用来源日期给正文补时间。
      if (dates.length !== 1) continue;
      const date = dates[0]!;
      const scope = `${date[1]}-${Number(date[2])}-${Number(date[3])}`;
      matches.push({ key: `${scope}:${exam}`, performed: /^(?:已|接受了|完成了)/u.test(predicate) });
    }
  }
  return matches;
}

/**
 * 新生成路径专用：只报告完整同日同检查“来源已做、正文却说未做”的可证明矛盾。
 * 泛称缺少检查、来源不够明确或时间不明仅由提示词改善，不阻断临床限制或增加回合。
 */
export function findMissingExamScopeIssues(
  candidate: MemberAssessmentCandidateV3, evidenceCatalog: readonly MemberEvidenceRef[]
): string[] {
  const issues: string[] = [];
  const byId = new Map(candidate.claims.map((claim) => [claim.id, claim]));
  const claimEvidence = (claimIds: readonly string[]) => claimIds.flatMap((id) => byId.get(id)?.evidenceIds ?? []);
  const inspect = (ownerId: string, field: string, value: string | null, evidenceIds: readonly string[]) => {
    if (!value) return;
    const sourceStatements = evidenceCatalog.filter((item) => evidenceIds.includes(item.id)
      && item.kind !== 'knowledge' && item.quote).flatMap((item) => explicitExamPerformance(item.quote!));
    if (explicitExamPerformance(value).some((statement) => !statement.performed
      && sourceStatements.some((source) => source.performed && source.key === statement.key)
      && !sourceStatements.some((source) => !source.performed && source.key === statement.key))) {
      issues.push(`missing_exam_scope:${ownerId}:${field}`);
    }
  };
  for (const node of [candidate.overview, ...candidate.systems]) {
    const evidenceIds = claimEvidence(node.claimIds);
    inspect(node.id, 'headline', node.headline, evidenceIds);
    inspect(node.id, 'summary', node.summary, evidenceIds);
    node.limitations.forEach((value, index) => inspect(node.id, `limitations[${index}]`, value, evidenceIds));
  }
  for (const claim of candidate.claims) {
    for (const field of ['title', 'text', 'rationale', 'materialUncertainty'] as const) {
      inspect(claim.id, field, claim[field] ?? null, claim.evidenceIds);
    }
  }
  for (const action of candidate.actions) {
    const evidenceIds = [...action.evidenceIds, ...claimEvidence(action.claimIds)];
    for (const field of ['title', 'why', 'firstStep', 'timing', 'reviewPlan', 'caution'] as const) {
      inspect(action.id, field, action[field], evidenceIds);
    }
  }
  for (const question of candidate.questions) {
    const evidenceIds = [...question.evidenceIds, ...claimEvidence(question.relatedClaimIds)];
    inspect(question.id, 'question', question.question, evidenceIds);
    inspect(question.id, 'whyItMatters', question.whyItMatters, evidenceIds);
  }
  return issues;
}

function isNormalDefinition(suffix: string): boolean {
  return /^(?:范围|参考范围|参考值|标准|定义|情况下)/.test(suffix);
}

/** 只识别明确的当前肯定句，不把历史报告转述、否定、提问或一般知识当成当前状态。 */
function assertsCurrentHealthy(text: string): boolean {
  return sentences(text).some((sentence) => {
    if (isQuestion(sentence)) return false;
    return sentence.split(/[，,]/).some((part) => {
      const clause = part.trim();
      const match = currentHealthy.exec(clause);
      if (!match || negatedAssertionLead.test(match[1]!)
        || /(?:不(?:是|算|属于)?|非|未|没有)\s*$/.test(match[1]!)) return false;
      // “目前知道旧结果”说的是当下知识范围，不是当下健康状态。
      // 只检查正常词之前的同分句；旧报告转述不能替后续独立当前判断提供豁免。
      if (/(?:报告|病历|来源)[^。；;\n]{0,24}(?:记载|记录|写道|写明|显示|提示)/.test(match[1]!)
        || /(?:掌握|仅知道|只知道|了解到)[^。；;\n]{0,24}(?:\d{4}|历史|既往|旧|结果|报告)/.test(match[1]!)) return false;
      return !isNormalDefinition(clause.slice(match[0].length));
    });
  });
}

/** 只采用唯一来源的完整缺项短句，不从无数值、文件名、器官关联或别的检查推断缺项。 */
function explicitMissingSubject(claim: HealthClaim, evidenceCatalog: readonly MemberEvidenceRef[]): string | null {
  const ids = [...new Set(claim.evidenceIds)];
  if (ids.length !== 1) return null;
  const evidence = evidenceCatalog.find((item) => item.id === ids[0]);
  if (!evidence || evidence.kind === 'knowledge' || !evidence.quote) return null;
  const quote = evidence.quote.trim();
  if (isQuestion(quote)) return null;
  return missingResult.exec(quote)?.[1] ?? null;
}

function acknowledgesUnknown(claim: HealthClaim, subject: string): boolean {
  if (!claim.materialUncertainty) return false;
  // subject 只含汉字、字母、数字和连字符，无需将任意原文拼进正则。
  const unknown = new RegExp('^(?:(?:目前|当前|现在|本人|本次|这次)\\s*)*' + subject
    + '(?:的)?(?:检查结果|检查|结果|状态|情况)?(?:尚|还|仍|暂)?(?:不能确定|无法确定|不能判断|无法判断|未知|不明确|不清楚)');
  return sentences(claim.materialUncertainty).some((sentence) => !isQuestion(sentence)
    && sentence.split(/[，,]/).some((part) => unknown.test(part.trim())));
}

function clearlyUnknownSubject(claim: HealthClaim, evidenceCatalog: readonly MemberEvidenceRef[]): string | null {
  const subject = explicitMissingSubject(claim, evidenceCatalog);
  return subject && acknowledgesUnknown(claim, subject) ? subject : null;
}

function assertsNormalAbout(text: string, subject: string, requirePersonalLead: boolean): boolean {
  const normal = new RegExp('^(?:(?:目前|当前|现在|今天|本人|我|我的|你|你的|您|您的|本次|这次)\\s*)*'
    + subject + '(?:的)?(?:检查结果|检验结果|检查|检验|结果|状态|情况)?(?:目前|当前|现在)?'
    + '(?:为|是|属于|仍|已|均|都)?(正常|未见异常|无异常)');
  return sentences(text).some((sentence) => !isQuestion(sentence)
    && sentence.split(/[，,]/).some((part) => {
      const clause = part.trim();
      if (nonAssertionStart.test(clause)
        || requirePersonalLead && !/^(?:目前|当前|现在|今天|本人|我|你|您|本次|这次)/.test(clause)) return false;
      const match = normal.exec(clause);
      return Boolean(match && !isNormalDefinition(clause.slice(match[0].length)));
    }));
}

/**
 * 标题只检查明确的诊断断言，不用疾病词典猜病名，也不把“考虑 X”当成确诊。
 * 每个独立分句分别识别否定/条件；前一分句的“可能”不能替后一“已确诊”背书。
 */
function definiteTitleSubjects(title: string): Array<{ subject: string; current: boolean }> {
  const subjects: Array<{ subject: string; current: boolean }> = [];
  for (const clause of title.split(/[。；;，,\n]|但是|但|而且|并且|且/u)) {
    if (isQuestion(clause) || nonAssertionStart.test(clause.trim())) continue;
    const cue = /明确诊断(?:为)?|确诊(?:了)?(?:为)?|诊断明确|诊断[:：为]|患有|罹患/gu;
    let precedingPredicateEnd = 0;
    for (const match of clause.matchAll(cue)) {
      const before = clause.slice(0, match.index);
      // 否定只作用于当前诊断谓词；越过前一个谓词之后重新判断，不依赖穷举“却”等连接词。
      const predicateLead = clause.slice(precedingPredicateEnd, match.index);
      precedingPredicateEnd = match.index + match[0].length;
      // “仅凭这些结果”是诊断依据状语，“忽视”则是另一个谓词，不能都按任意字串豁免。
      const governedLead = predicateLead.replace(/(?:仅|只|单)?(?:凭|根据|依据)[^。；;，,]{0,20}(?:结果|资料|证据|症状|影像|检查)\s*$/u, '据此');
      if (/(?:不能|无法|没有证据|无证据|不代表|并非|未必|不一定|不是|没有|不宜|不应|不可以|未能|尚未|还未|未|否认|可能|考虑|疑似|怀疑|是否|能否)(?:已经|已|明确|据此|直接|说明|证明|确定|被|为|自己|本人|患者|你|您|是)*\s*$/u.test(governedLead)) continue;
      const after = clause.slice(match.index + match[0].length).trim();
      const subject = (after || before.replace(/(?:(?:已经|已|明确|目前|当前|现在|本次|这次)\s*)+$/u, ''))
        .replace(/^[：:\s“”「」"']+|[。\s“”「」"']+$/gu, '');
      const current = /(?:目前|当前|现在|今天|如今|现阶段|新近|刚刚|重新|再次)/u.test(before)
        && !/(?:报告|病历|来源)[^。；;，,]{0,24}(?:记载|记录|写明|写道)/u.test(before);
      if (subject) subjects.push({ subject, current });
    }
  }
  return subjects;
}

/** 已有诊断只能支持同一字面病名；不让一个 documented 项目给别的新诊断背书。 */
function hasUnsupportedDiagnosticTitle(title: string, claims: readonly HealthClaim[]): boolean {
  return definiteTitleSubjects(title).some(({ subject, current }) => {
    const supported = (value: string) => claims.some((claim) => {
      if (claim.diagnosticStatus !== 'documented' || !claim.diseaseName) return false;
      if (current && claim.temporalStatus !== 'current') return false;
      const disease = claim.diseaseName.trim();
      // 正向语序须为该病名；倒装“某年报告记载 X 已确诊”保留原年月及来源。
      return value === disease || value.endsWith(disease)
        && /^(?:\d{4}年(?:\d{1,2}月(?:\d{1,2}日)?)?|既往|历史|原|本次|这次|病历|报告|出院|临床|本人|患者|受检者|的|记载|记录|诊断|[:：\s])*$/u
          .test(value.slice(0, -disease.length));
    });
    // 先匹配完整名称，避免拆开“胃及十二指肠溃疡”这样的原有复合病名。
    return !supported(subject) && !subject.split(/以及|和|与|及|、/u).every((part) => supported(part.trim()));
  });
}

/** 可供旧快照只读投影使用；仅报告可证明矛盾，不修正时间、事实或健康结论。 */
export function findClaimSemanticIssues(
  claim: HealthClaim, evidenceCatalog: readonly MemberEvidenceRef[]
): string[] {
  const fields = [
    { text: claim.text, requirePersonalLead: false },
    { text: claim.title ?? null, requirePersonalLead: false },
    { text: claim.rationale, requirePersonalLead: true },
    { text: claim.materialUncertainty, requirePersonalLead: true },
    { text: claim.changeAssessment?.summary ?? null, requirePersonalLead: false },
    { text: claim.changeAssessment?.reason ?? null, requirePersonalLead: true }
  ].filter((value): value is { text: string; requirePersonalLead: boolean } => value.text !== null);
  const issues: string[] = [];
  if (claim.title && hasUnsupportedDiagnosticTitle(claim.title, [claim])) {
    issues.push('diagnostic_title_contradiction:' + claim.id);
  }
  if (claim.temporalStatus === 'historical' && fields.some(({ text }) => assertsCurrentHealthy(text))) {
    issues.push('historical_current_contradiction:' + claim.id);
  }
  const subject = clearlyUnknownSubject(claim, evidenceCatalog);
  if (subject && fields.some(({ text, requirePersonalLead }) => assertsNormalAbout(text, subject, requirePersonalLead))) {
    issues.push('unknown_normal_contradiction:' + claim.id);
  }
  return issues;
}

/** 汇总不能将全历史依据升级成当前状态；其他独立已知项目不因缺项被否定。 */
export function findAssessmentSemanticIssues(
  candidate: MemberAssessmentCandidateV3, evidenceCatalog: readonly MemberEvidenceRef[]
): string[] {
  const issues = candidate.claims.flatMap((claim) => findClaimSemanticIssues(claim, evidenceCatalog));
  const byId = new Map(candidate.claims.map((claim) => [claim.id, claim]));
  for (const node of [candidate.overview, ...candidate.systems]) {
    const claims = node.claimIds.map((id) => byId.get(id));
    if (claims.some((claim) => !claim)) continue;
    if (hasUnsupportedDiagnosticTitle(node.headline, claims as HealthClaim[])) {
      issues.push('diagnostic_title_contradiction:' + node.id);
    }
    if (claims.length === 0) continue;
    if (claims.every((claim) => claim!.temporalStatus === 'historical')
      && [node.headline, node.summary].some(assertsCurrentHealthy)) {
      issues.push('historical_current_contradiction:' + node.id);
    }
    const unknownSubjects = claims.map((claim) => clearlyUnknownSubject(claim!, evidenceCatalog));
    if (unknownSubjects.every(Boolean)) {
      const sameSubject = unknownSubjects.every((subject) => subject === unknownSubjects[0]);
      if ('status' in node && node.status === 'no_signal_in_scope'
        || sameSubject && [node.headline, node.summary].some((text) => assertsNormalAbout(text, unknownSubjects[0]!, false))) {
        // 合格的“未知”主张仍保留，仅重建越界的汇总或状态。
        issues.push('unknown_normal_contradiction:' + node.id);
      }
    }
  }
  return [...new Set(issues)];
}
