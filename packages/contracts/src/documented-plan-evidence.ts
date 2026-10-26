import type { HealthAction } from './member-assessment-v3.js';
import type { MemberEvidenceRef } from './member-v2.js';

type ReportedPlanAction = Pick<HealthAction, 'kind' | 'timingBasis' | 'title' | 'firstStep' | 'timing' | 'evidenceIds'>;

/** 只用于声明“原报告安排”的节点；一般 AI 建议不据这些词被拦截。 */
const sourceInstruction = /医嘱|嘱|建议|请(?:于|在|到|去|带|做|复|按)|(?:应(?:当)?|需(?:要)?)(?:于|在|到|去|做|复|按|继续|定期|随访|就诊|检查|治疗)|务必|按时|门诊复评|继续(?:治疗|用药|服用)|避免|禁(?:食|饮|用)|保持|休息/;
// 识别明确行动，不把“注意到数值变化”或无关预约等事实/标题变成原安排。
const directHabitInstruction = /(?:^|[，,：:、\s])注意(?:合理|规律|适当|均衡|清淡)?(?:饮食|进食|活动|运动|休息|作息)/;
const optionalAppointmentInstruction = /(?:^|[，,：:、\s])可(?:以)?预约[^。；;，,\n]{0,30}(?:门诊|医生|医师|(?:营养科|内分泌科|全科)(?=$|[、\s]|门诊|诊室))/;
const nonDirectiveHabitOrAppointment = /(?:^|[，,：:、])\s*(?:无需|无须|不用|不必|不应|不宜|不要|不可|不需(?:要)?|(?:暂|尚)?未|(?:目前|当前)?(?:已经|已))\s*(?:注意(?:合理|规律|适当|均衡|清淡)?(?:饮食|进食|活动|运动|休息|作息)|可(?:以)?预约)/;
const conditionLead = /^\s*(?:若|如果|如(?:有|出现|仍|需|伴|发生|持续)|当(?:出现|有|发生|伴|持续|仍|需)|仅在|只有|除非)|^\s*[^。；;，,：:\n]{1,40}(?:持续|不适|异常|升高|降低|减少|偏高|偏低|阳性|阴性|需(?:要)?复查)者(?=$|[，,：:])/;
// 条件前件中的“休息”“需复查”等词不是后件；只认明确边界后直接开始的指示。
const consequentInstruction = /^\s*(?:(?:医生|医师)?(?:医嘱|嘱|建议)|请(?:于|在|到|去|带|做|复|按)|(?:应(?:当)?|需(?:要)?)(?:于|在|到|去|做|复|按|继续|定期|随访|就诊|检查|治疗)|务必|按时|门诊复评|继续(?:治疗|用药|服用)|避免|禁(?:食|饮|用)|保持|休息)/;
// “三个月后复查”可直接是原安排；单独的“甲状腺功能复查”只是项目标题，不足以证明指示。
const timedInstruction = /^\s*(?:\d{4}[-年./]\d{1,2}(?:[-月./]\d{1,2}日?)?|[\d一二两三四五六七八九十半]+\s*(?:天|日|周|星期|个月|月|年)(?:内|后|左右)?|下次|近期|尽快|立即|定期)\s*[，,]?\s*(?:复查|复诊|复测|随访)/;
const negatedPlan = /(?:未建议|不建议|未安排|未要求|无需|无须|不需(?:要)?|不用|不必|不应)[^。；，,]{0,12}(?:复查|复诊|复测|随访|就诊|检查|治疗)|(?:建议\s*不|暂不)(?:复查|复诊|复测|随访)/;
const absentPlan = /(?:暂?无|尚无|没有|并无|未(?:见|记录|记载|提供|提出)|尚未(?:记录|记载|提供|提出))[^。；，,]{0,32}(?:医嘱|(?:医生|医师)的?(?:建议|安排)|(?:复查|复诊|复测|随访|就诊|检查|治疗)的?(?:计划|安排|建议))|(?:医嘱|(?:复查|复诊|复测|随访)的?(?:计划|安排|建议))[^。；，,]{0,16}(?:未记录|未给出|未明确|未提供|暂无|尚无|没有)|(?:不是|并非|不在)[^。；，,]{0,8}(?:医嘱|医生安排)/;
const absentPlanStatus = /(?:暂未|尚未|未)(?:计划|安排)|(?:暂无|尚无|没有|无)(?:具体|明确)?的?(?:计划|安排|医嘱)/;
const datePattern = '\\d{4}[-年./]\\d{1,2}(?:[-月./]\\d{1,2}日?|月)?';
const timing = new RegExp(`(?:${datePattern}|[\\d一二两三四五六七八九十半]+\\s*(?:天|日|周|星期|个月|月|年)(?:内|后|左右)?|下次|近期|尽快|立即|定期)`, 'g');
const standaloneTiming = new RegExp(`^\\s*${timing.source}\\s*[:：]?\\s*$`);
export const DOCUMENTED_PLAN_NEUTRAL_TITLE = '报告中的医生建议';

export interface DocumentedPlanEvidenceCheck {
  required: boolean;
  /** 只在完整指示和时间均有来源时返回；标题不参与原医嘱正文的证明。 */
  evidence: MemberEvidenceRef[];
  unsupportedField: 'source' | 'firstStep' | 'timing' | null;
  titleSupported: boolean;
}

/** 只拆显式来源归因外壳，不删除行动动词、否定、条件或外壳外的执行内容。 */
function unwrapInstruction(text: string): { body: string; attributionDate: string | null } {
  let body = text.normalize('NFKC').trim();
  // 兼容已有合法的带报告准备外壳；不能吞掉“带上其他检查”等额外要求。
  body = body.replace(/^带上(?:既往)?报告\s*[,，]\s*/, '');
  // 来源行首日期属于记录背景；只认日期后紧接医生归因，不把普通执行日期移走。
  const datedSource = body.match(new RegExp(`^(${datePattern}|\\d{4})\\s+(?=(?:医生|医师)(?:建议|医嘱|嘱))`));
  if (datedSource) body = body.slice(datedSource[0].length);
  const attribution = body.match(new RegExp(`^(?:按照|依照|遵照|根据|按)?(${datePattern})?(?:原报告|报告)(?:中)?(?:的)?(?:原)?(?:医生|医师)?(?:建议|安排|医嘱)?\\s*[:：]?\\s*`));
  const attributionDate = attribution?.[1] ?? datedSource?.[1] ?? null;
  if (attribution) body = body.slice(attribution[0].length);
  else body = body.replace(/^(?:按照|依照|遵照|根据|按)原(?:安排|建议|医嘱)\s*[:：]?\s*/, '');
  body = body.replace(/^(?:医生|医师)?(?:建议|医嘱|嘱)\s*[:：]?\s*/, '');
  return { body, attributionDate };
}

function instructionKey(text: string): string {
  // 保留顺序、否定、条件、数值和小数点；仅时间另行核对，功能/功保留既有窄简写。
  return text.normalize('NFKC').replace(timing, '').replace(/[\s，,。；;“”"‘’']/g, '')
    .replace(/功能/g, '功');
}

function instructionClauses(quote: string, targetKey: string): string[] {
  const completeConditional = (sentence: string): boolean => {
    const body = unwrapInstruction(sentence).body;
    return conditionLead.test(body) && body.split(/[，,：:]|则|就/).slice(1).some((part) => consequentInstruction.test(part)
      || directHabitInstruction.test(part) || optionalAppointmentInstruction.test(part) || timedInstruction.test(part));
  };
  const affirmative = (clause: string, explicitOnly = false) => (sourceInstruction.test(clause)
    || directHabitInstruction.test(clause) || optionalAppointmentInstruction.test(clause)
    || completeConditional(clause)
    || !explicitOnly && timedInstruction.test(clause)) && !negatedPlan.test(clause)
    && !absentPlan.test(clause) && !absentPlanStatus.test(clause) && !nonDirectiveHabitOrAppointment.test(clause);
  const standalonePrerequisite = (sentence: string): boolean => {
    const body = unwrapInstruction(sentence).body;
    if (standaloneTiming.test(body)) return true;
    if (!conditionLead.test(body)) return false;
    // 只按明示后件判完整条件指示；没有后件的前提优先绑定下一句，不能被宽动作词抢先。
    return !completeConditional(sentence);
  };
  const single = (sentence: string): { clause: string; complete: boolean } | null => {
    if (standalonePrerequisite(sentence)) return null;
    if (affirmative(sentence)) return { clause: sentence, complete: true };
    const parts = sentence.split(/[，,]/);
    // 只兼容独立的“暂无另一安排，医生建议…”；否定或条件长句不按逗号猜作用域。
    if (parts.length !== 2 || negatedPlan.test(sentence)
      || !/^\s*(?:暂?无|尚无|没有|并无)/.test(parts[0]!)
      || /若|如|当|除非|否则|才/.test(parts[0]!) || !absentPlan.test(parts[0]!)) return null;
    return affirmative(parts[1]!, true) ? { clause: parts[1]!, complete: false } : null;
  };
  const sentences = quote.split(/[。；;\n]/).map((sentence) => sentence.trim()).filter(Boolean);
  const units: Array<ReturnType<typeof single>> = [];
  for (let index = 0; index < sentences.length; index += 1) {
    const current = single(sentences[index]!);
    if (standalonePrerequisite(sentences[index]!)) {
      // 紧邻、明确的独立前提/期限和下一条完整指示不可拆开；不跨中性/否定句猜作用范围。
      let end = index;
      while (end + 1 < sentences.length && standalonePrerequisite(sentences[end + 1]!)) end += 1;
      const next = sentences[end + 1] ? single(sentences[end + 1]!) : null;
      if (next?.complete) {
        units.push({ clause: [...sentences.slice(index, end + 1), next.clause].join('。'), complete: true });
        index = end + 1;
      } else {
        units.push(null);
        // 条件后的“省掉另一安排”旧兼容分支也不能忽略前提。
        if (next) index = end + 1;
      }
    } else units.push(current);
  }
  const clauses = units.flatMap((unit) => unit ? [unit.clause] : []);
  // 只连用同一真实引用中相邻的完整指示，不跨部分句、中性句、否定句或另一个片段。
  for (let start = 0; start < units.length; start += 1) {
    if (!units[start]?.complete) continue;
    let joined = units[start]!.clause;
    for (let end = start + 1; end < units.length && units[end]?.complete; end += 1) {
      joined += `。${units[end]!.clause}`;
      const key = instructionKey(unwrapInstruction(joined).body);
      // 只生成与本行动相符的多句窗口，不把整页所有组合复制成新的大上下文。
      if (key.length > targetKey.length) break;
      if (key === targetKey) clauses.push(joined);
    }
  }
  return clauses;
}

function normalizeTiming(value: string): string {
  const digits: Record<string, number> = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  const normalized = value.normalize('NFKC').replace(/[一二两三四五六七八九十]+/g, (number) => {
    const [tens, units] = number.split('十');
    if (number.includes('十')) return String((tens ? digits[tens] ?? 0 : 1) * 10 + (units ? digits[units] ?? 0 : 0));
    return String(digits[number] ?? number);
  }).replace(/\s+/g, '');
  if (/^\d{4}[-年./]/.test(normalized)) {
    return normalized.replace(/年|月|日|[./]/g, '-').replace(/-$/g, '')
      .replace(/-(0+)(?=\d)/g, '-');
  }
  return normalized.replace(/星期/g, '周').replace(/个月/g, '月').replace(/天/g, '日')
    .replace(/以后|之后/g, '后');
}

/** 标题和正文共用期限位置证明；标题可以省略期限，但不能把期限移给另一项检查。 */
function timingPositionsSupported(body: string, source: string, requireComplete: boolean): boolean {
  const positions = (text: string) => [...text.matchAll(timing)].map((match) => ({
    value: normalizeTiming(match[0]), offset: instructionKey(text.slice(0, match.index)).length
  }));
  const sourcePositions = positions(unwrapInstruction(source).body);
  const bodyPositions = positions(body);
  // 多项安排不能交换期限，或把仅属于其中一项的时间变成全体通用时间。
  if (!bodyPositions.every((item) => sourcePositions.some((sourceItem) =>
    sourceItem.value === item.value && sourceItem.offset === item.offset))) return false;
  if (requireComplete && sourcePositions.length > 1 && !sourcePositions.every((sourceItem) => bodyPositions.some((item) =>
    item.value === sourceItem.value && item.offset === sourceItem.offset))) return false;
  return true;
}

function timingSupported(action: ReportedPlanAction, body: string, source: string): boolean {
  if (!timingPositionsSupported(body, source, true)) return false;
  const sourceTimes = (unwrapInstruction(source).body.match(timing) ?? []).map(normalizeTiming);
  const declared = [...body.match(timing) ?? [], ...action.timing?.match(timing) ?? []].map(normalizeTiming);
  // 正文中的期限也需证明；原文必要期限不能仅因移到另一字段而遗失。
  if (!declared.every((value) => sourceTimes.includes(value))
    || !sourceTimes.every((value) => declared.includes(value))) return false;
  if (action.timing === null) return true;
  // 非空时间字段需真实来自原句，不能把未知文本或反向指示藏在 timing 中。
  const normalized = (text: string) => text.normalize('NFKC').replace(timing, normalizeTiming)
    .replace(/[\s，,。；;“”"‘’']/g, '');
  const value = normalized(action.timing);
  return value.length > 0 && declared.length > 0 && normalized(source).includes(value);
}

/** 分开证明指示、时间和展示标题，使标题失败不会被误报为没有原医嘱。 */
export function inspectDocumentedPlanEvidence(action: ReportedPlanAction, catalog: readonly MemberEvidenceRef[]): DocumentedPlanEvidenceCheck {
  const required = action.kind === 'documented_plan' || action.timingBasis === 'documented';
  const result = (unsupportedField: DocumentedPlanEvidenceCheck['unsupportedField']): DocumentedPlanEvidenceCheck => ({
    required, evidence: [], unsupportedField, titleSupported: false
  });
  if (!required) return result(null);
  const cited = new Set(action.evidenceIds);
  const instruction = unwrapInstruction(action.firstStep);
  const key = instructionKey(instruction.body);
  const sources = catalog.filter((evidence) => cited.has(evidence.id)
    && ['observation', 'clinical_finding', 'source_span'].includes(evidence.kind)
    && evidence.documentId !== null && evidence.sourceSpanId !== null && Boolean(evidence.quote?.trim()))
    .flatMap((evidence) => instructionClauses(evidence.quote!, key).map((clause) => ({ evidence, clause })));
  if (sources.length === 0) return result('source');
  const matching = sources.filter(({ evidence, clause }) => key.length > 0
    && key === instructionKey(unwrapInstruction(clause).body)
    && (!instruction.attributionDate || catalog.some((item) => item.documentId === evidence.documentId
      && item.sourceSpanId !== null && ['observation', 'clinical_finding', 'source_span'].includes(item.kind)
      && [...item.quote?.match(timing) ?? [], ...(item.quote && unwrapInstruction(item.quote).attributionDate
        ? [unwrapInstruction(item.quote).attributionDate!] : [])]
        .some((value) => normalizeTiming(value) === normalizeTiming(instruction.attributionDate!)))));
  if (matching.length === 0) return result('firstStep');
  const proven = matching.filter(({ clause }) => timingSupported(action, instruction.body, clause));
  if (proven.length === 0) return result('timing');
  const title = unwrapInstruction(action.title);
  const titleKey = instructionKey(title.body);
  const titleSupported = action.title === DOCUMENTED_PLAN_NEUTRAL_TITLE || proven.some(({ clause }) =>
    titleKey.length > 0 && titleKey === instructionKey(unwrapInstruction(clause).body)
    && timingPositionsSupported(title.body, clause, false)
    && title.attributionDate === null);
  return { required, evidence: [...new Map(proven.map(({ evidence }) => [evidence.id, evidence])).values()],
    unsupportedField: null, titleSupported };
}

/**
 * 返回可追溯的、与本行动对应的原报告安排引用。它只证明来源有此安排，
 * 不证明安排今天仍适用；成员归属、逐字原件和临床日期由存储层继续核实。
 */
export function documentedPlanEvidence(action: ReportedPlanAction, catalog: readonly MemberEvidenceRef[]): MemberEvidenceRef[] {
  return inspectDocumentedPlanEvidence(action, catalog).evidence;
}
