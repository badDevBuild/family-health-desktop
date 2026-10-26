import { createHash } from 'node:crypto';
import type { HealthAction, HealthClaim, HealthEventDetailV2, MemberAssessmentSnapshotV3 } from '@contracts';

export const SYNTHETIC_REFERENCE_DATE = '2026-09-22';
type ExpectedFact = { label: string; namePattern: string; value: number; unitPattern: string; date: string };
type FamilyScenario = {
  filename: string; sha256: string;
  member: { displayName: string; relation: string; birthYear: number };
  notes: Array<{ kind: 'history' | 'constraint' | 'free_text'; text: string; date: string;
    fields: Record<string, string> }>;
  existingPlan: { title: string; detail: string; dueDate: null; dueText: string } | null;
  expectedFacts: ExpectedFact[];
  primarySystem: string; topicPattern: string;
  humanReviewQuestions: string[];
};

/** 独立编造的家庭场景；没有从个人工作区复制任何数值、日期或原文。 */
export const syntheticFamilyScenarios: Record<'child-vision' | 'older-bp-kidney' | 'adult-recent-change', FamilyScenario> = {
  'child-vision': {
    filename: 'full-chain-child-vision.txt', sha256: '6ada2f40e5a966407d697fd8d894c9554908643f75c550656a3e23b79e6d3237',
    member: { displayName: '虚构儿童甲', relation: '孩子', birthYear: 2015 },
    notes: [{ kind: 'history', date: '2026-09-14', fields: { reporter: 'parent' },
      text: '家长补充：孩子最近看教室黑板不清楚，目前没有眼镜；没有突然视力下降、眼痛或复视。家长会陪同就诊，本次电脑验光确实没有散瞳。' }],
    existingPlan: null,
    expectedFacts: [
      { label: '右眼裸眼视力', namePattern: '右.*视力|视力.*右', value: 0.6, unitPattern: '.*', date: '2026-09-12' },
      { label: '左眼裸眼视力', namePattern: '左.*视力|视力.*左', value: 0.8, unitPattern: '.*', date: '2026-09-12' },
      { label: '右眼球镜', namePattern: '右.*球镜|球镜.*右', value: -0.75, unitPattern: '^d$', date: '2026-09-12' },
      { label: '左眼球镜', namePattern: '左.*球镜|球镜.*左', value: -0.5, unitPattern: '^d$', date: '2026-09-12' }
    ],
    primarySystem: 'sensory_oral', topicPattern: '视力|眼|屈光|验光',
    humanReviewQuestions: ['左右眼数值有没有串眼？未散瞳是否解释为结果的限制，而不是配镜处方？',
      '是否向家长说明看黑板困难的下一步，而不是只重复检查数字？', '有没有把未散瞳结果直接说成已确诊近视，或忽略家长已经回答的内容？']
  },
  'older-bp-kidney': {
    filename: 'full-chain-older-bp-kidney.txt', sha256: 'cd9417e6f62aa682e9088893412ef652746bbe088fa351d434e9df5c5f2e5920',
    member: { displayName: '虚构长辈乙', relation: '父亲', birthYear: 1951 },
    notes: [{ kind: 'constraint', date: '2026-09-11', fields: {},
      text: '本人补充：双膝活动时疼痛，连续走路超过10分钟就不舒服；没有近期跌倒。已有每天晚饭后坐位舒缓活动8分钟的计划，希望保留，不想改成跑步或长距离快走。' }],
    existingPlan: { title: '晚饭后坐位舒缓活动', detail: '每天晚饭后坐位舒缓活动8分钟；出现膝痛就停下，不跑步，不做长距离快走。',
      dueDate: null, dueText: '每天晚饭后' },
    expectedFacts: [
      ...[['2026-03-12', 146, 86, 94, 62], ['2026-06-18', 150, 88, 96, 60], ['2026-09-10', 148, 84, 95, 61]]
        .flatMap((row) => {
          const [date, systolic, diastolic, creatinine, egfr] = row as [string, number, number, number, number];
          return [
            { label: `${date}收缩压`, namePattern: '收缩压', value: systolic, unitPattern: '^mmhg$', date },
            { label: `${date}舒张压`, namePattern: '舒张压', value: diastolic, unitPattern: '^mmhg$', date },
            { label: `${date}肌酐`, namePattern: '肌酐', value: creatinine, unitPattern: '^(u|μ|µ)mol/l$', date },
            { label: `${date}肾小球滤过率`, namePattern: '肾小球滤过率|egfr', value: egfr, unitPattern: 'ml/min', date }
          ];
        })
    ],
    primarySystem: 'cardiovascular', topicPattern: '血压|收缩压',
    humanReviewQuestions: ['是否区分多次诊室血压与家庭血压，并准确描述肾功能小幅波动而非捏造持续恶化？',
      '运动或生活建议是否适合75岁、膝部疼痛、走路10分钟受限的人？',
      '已有坐位活动计划是否保留且不重复推销为一条新计划？血压和肾功能的下一步是否具体？']
  },
  'adult-recent-change': {
    filename: 'full-chain-adult-recent-change.txt', sha256: 'f72067dfc6bac1bc0f7cceb4ca1b7d57bb8afd657692dbafee4475ef1b3d5f07',
    member: { displayName: '虚构成人丙', relation: '本人', birthYear: 1988 },
    notes: [{ kind: 'free_text', date: '2026-09-18',
      fields: { questionId: 'synthetic-adult-known-background', assessmentSnapshotId: 'synthetic-prior-question' },
      text: '补充问题：你是否吸烟、正在使用调脂药，最近饮食有什么变化？\n本人回答：我从不吸烟，目前没有使用调脂药；最近两个月工作忙，晚餐由家中做饭改为每周四次炸鸡外卖，没有其他已知改变。' }],
    existingPlan: null,
    expectedFacts: [
      { label: '前次LDL', namePattern: '低密度脂蛋白|ldl', value: 2.4, unitPattern: '^mmol/l$', date: '2026-07-20' },
      { label: '近期LDL', namePattern: '低密度脂蛋白|ldl', value: 3.5, unitPattern: '^mmol/l$', date: '2026-09-15' },
      { label: '空腹血糖', namePattern: '空腹.*血糖|空腹.*葡萄糖', value: 4.8, unitPattern: '^mmol/l$', date: '2026-09-15' },
      { label: '谷丙转氨酶', namePattern: '谷丙|丙氨酸.*转氨酶|alt', value: 22, unitPattern: '^u/l$', date: '2026-09-15' },
      { label: '血红蛋白', namePattern: '血红蛋白|hgb', value: 145, unitPattern: '^g/l$', date: '2026-09-15' }
    ],
    primarySystem: 'cardiovascular', topicPattern: '低密度|ldl|血脂|胆固醇',
    humanReviewQuestions: ['是否将本次小幅LDL变化作为重点，并把其余已检项目的正常范围说清楚而不泛化为全身健康？',
      '是否使用已回答的外卖习惯给出可执行下一步，且不把饮食直接断言为唯一原因？',
      '是否仍重复问吸烟、调脂药或近期饮食？是否无依据地扩大到多种疾病或危言耸听？']
  }
};
export type SyntheticFamilyCaseId = keyof typeof syntheticFamilyScenarios;
export function isSyntheticFamilyCase(value: string): value is SyntheticFamilyCaseId {
  return Object.hasOwn(syntheticFamilyScenarios, value);
}
export function syntheticFamilyInputHash(caseId: SyntheticFamilyCaseId): string {
  return createHash('sha256').update(JSON.stringify({ referenceDate: SYNTHETIC_REFERENCE_DATE,
    ...syntheticFamilyScenarios[caseId] })).digest('hex');
}

export type SyntheticAcceptedFact = { id: string; name: string; value: string; unit: string | null; clinicalDate: string | null };
type FamilyClaim = Pick<HealthClaim, 'id' | 'kind' | 'topicKey' | 'text' | 'rationale' | 'materialUncertainty' | 'evidenceIds'>;
type FamilyAction = Pick<HealthAction, 'id' | 'title' | 'why' | 'firstStep' | 'caution' | 'timing' | 'reviewPlan' | 'claimIds' | 'evidenceIds'
  | 'lifestyleDomain' | 'lifestyleBasis'>;
export type SyntheticFamilyPresentation = {
  personId: string; claims: FamilyClaim[]; actions: FamilyAction[];
  overview: MemberAssessmentSnapshotV3['overview']; systems: MemberAssessmentSnapshotV3['systems'];
  questions: Array<{ question: string }>;
};
export type SyntheticFamilyReadModels = {
  overview: { personId: string; headline: string; overview: string;
    priorityIssues: Array<{ id: string; title: string; explanation: string; nextStep: string | null }> };
  bodyDetails: unknown[]; eventDetails: Array<Pick<HealthEventDetailV2, 'findings' | 'time' | 'systemIds' | 'type'>>;
  lifestyle: { personId: string; adoptedActions: Array<{ title: string; selectedStartingOption: string; status: string }> };
};
export type SyntheticContentCheck = { id: string; expected: string; observed: unknown; passed: boolean };
const textOf = (values: Array<string | null | undefined>) => values.filter(Boolean).join('\n');
const numericTokens = (value: string) => (value.match(/[-+]?\d+(?:\.\d+)?/g) ?? []).map(Number);
const pattern = (source: string) => new RegExp(source, 'iu');

/** 活动领域直接核对；其他领域和旧建议只在确实安排运动负荷时核对，不能靠错标领域绕过。 */
function prescribesMovement(action: FamilyAction): boolean {
  if (action.lifestyleDomain === 'activity') return true;
  return textOf([action.title, action.firstStep]).split(/[，,。；;\n]|(?:但|不过|而是|改为|改做|换成)/u).some((clause) => {
    const movement = /跑步|慢跑|快走|步行|散步|走路|骑行|游泳|运动|锻炼|活动/u.exec(clause);
    if (!movement) return false;
    // “避免剧烈活动”“不跑步或长距离快走”是限制，不是新增运动安排。
    const throughMovement = clause.slice(0, movement.index + movement[0].length);
    if (/(?:不要|不必|无需|无须|避免|减少|暂停|停止|不能|不应|不宜|不建议|不得|禁止|不(?:做|进行|增加|开始|跑|快走|步行|运动|锻炼|活动)).{0,20}$/u.test(throughMovement)) return false;
    // “在常活动的位置放水杯”没有运动做法、频次或时长，不应要求它重复说明膝痛。
    return /开始|增加|安排|进行|坚持|尝试|继续|保持|每天|每日|每周|每次|长距离|\d+\s*(?:分钟|小时|公里|千米|步)/u.test(clause);
  });
}

/** 已知的是原检查条件和当时无眼镜；明确询问之后的新检查状态不属于重复提问。 */
function reasksKnownChildAnswer(question: string, originalExamDate: string): boolean {
  const [year, month, day] = originalExamDate.split('-').map(Number);
  const originalDates = [originalExamDate, `${year}年${month}月${day}日`, `${month}月${day}日`];
  // 分句分别判断，防止一个后续安排问题掩盖同段里对原检查的重复询问。
  return question.split(/[，,。；;\n]|(?<=[？！?])|(?:并且|以及|同时|另外|而且|并)(?=.{0,16}(?:是否|有没有|有无))/u).some((clause) => {
    if (!/是否|有没有|有无|吗|[?？]/.test(clause) || !/散瞳|戴.*眼镜|有.*眼镜/.test(clause)) return false;
    const afterOriginalExam = originalDates.some((date) => {
      const start = clause.indexOf(date);
      return start >= 0 && /^(?:的)?(?:眼科)?(?:检查|验光)?(?:之后|以后|后)/.test(clause.slice(start + date.length));
    });
    const originalScope = /本次|这次|该次|当次|原(?:来的)?(?:检查|验光)/.test(clause)
      || (originalDates.some((date) => clause.includes(date)) && !afterOriginalExam);
    if (originalScope) return true;
    // 必须同时有原检查之后的时间锚点、新检查事项和完成/安排状态；“之后”本身不能豁免。
    const newExaminationStatus = afterOriginalExam && /眼科(?:检查|复查)|散瞳(?:验光|检查)|复诊/.test(clause)
      && /完成|做过|做了|接受|进行|安排|预约/.test(clause);
    if (newExaminationStatus) return false;
    const plannedCareDecision = /(?:是否|有没有|有无).{0,12}(?:预约|计划|打算|准备|安排|需要).{0,16}(?:散瞳|配镜)/.test(clause);
    if (plannedCareDecision) return false;
    if (afterOriginalExam) return true;
    const scopeBeforeQuestion = clause.slice(0, clause.search(/是否|有没有|有无|吗|[?？]/));
    return !/下次|下回|以后|后续/.test(scopeBeforeQuestion);
  });
}

/** 自动检验数值绑定和用户可读语义的最低边界；仍须独立人工阅读最终正文。 */
export function syntheticFamilyContentChecks(caseId: SyntheticFamilyCaseId, input: {
  personId: string; facts: SyntheticAcceptedFact[]; snapshot: SyntheticFamilyPresentation; readModels: SyntheticFamilyReadModels;
  processIssues: string[];
  requireDailyLife?: boolean;
}): SyntheticContentCheck[] {
  const scenario = syntheticFamilyScenarios[caseId];
  const { snapshot, readModels } = input;
  const checks: SyntheticContentCheck[] = [];
  const check = (id: string, expected: string, observed: unknown, passed: boolean) => checks.push({ id, expected, observed, passed });
  const visibleIds = new Set([...snapshot.overview.actionIds, ...snapshot.systems.flatMap((system) => system.actionIds)]);
  const visibleActions = snapshot.actions.filter((action) => visibleIds.has(action.id));
  const claimIds = new Set([...snapshot.overview.claimIds, ...snapshot.systems.flatMap((system) => system.claimIds)]);
  const visibleClaims = snapshot.claims.filter((claim) => claimIds.has(claim.id));
  const actionText = textOf(visibleActions.flatMap((action) => [action.title, action.why, action.firstStep, action.caution, action.timing, action.reviewPlan]));
  const narrative = textOf([readModels.overview.headline, readModels.overview.overview,
    ...visibleClaims.flatMap((claim) => [claim.text, claim.rationale, claim.materialUncertainty]),
    ...snapshot.systems.flatMap((system) => [system.headline, system.summary, ...system.limitations]), actionText]);
  const displaySurfaces = [...readModels.bodyDetails, ...readModels.eventDetails].map((surface) => JSON.stringify(surface));
  check('member-isolation', '总览、生活页和发布内容均属于本合成成员',
    [snapshot.personId, readModels.overview.personId, readModels.lifestyle.personId],
    [snapshot.personId, readModels.overview.personId, readModels.lifestyle.personId].every((id) => id === input.personId));
  for (const expected of scenario.expectedFacts) {
    const matching = input.facts.filter((fact) => pattern(expected.namePattern).test(fact.name)
      && numericTokens(fact.value).includes(expected.value) && fact.clinicalDate === expected.date
      && pattern(expected.unitPattern).test((fact.unit ?? '').replace(/\s/g, '')));
    check(`fact:${expected.label}`, `${expected.label}=${expected.value}，日期${expected.date}，名称/单位相符`, matching, matching.length > 0);
    check(`display:${expected.label}`, '已接纳的同一条数值及其日期可从身体指标或检查详情查看',
      matching.map((fact) => fact.id), matching.some((fact) => displaySurfaces.some((surface) => surface.includes(fact.id)
        && surface.includes(expected.date) && numericTokens(surface).includes(expected.value))));
    const displayedFindings = readModels.eventDetails.flatMap((event) => event.findings)
      .filter((finding) => matching.some((fact) => fact.id === finding.id));
    check(`event-date:${expected.label}`, '检查详情逐项保留原检查日期，不能仅靠身体页日期掩盖时间线缺失',
      displayedFindings, displayedFindings.some((finding) => finding.time.value === expected.date
        && ['exam', 'measurement', 'specimen'].includes(finding.time.role)
        && numericTokens(finding.value).includes(expected.value)));
  }
  const system = snapshot.systems.find((item) => item.systemId === scenario.primarySystem);
  check('topic-in-result-not-process', '成员总览和对应系统直接说明具体身体情况，不只显示处理状态',
    { overview: readModels.overview.overview, system: system ? { headline: system.headline, summary: system.summary } : null },
    pattern(scenario.topicPattern).test(readModels.overview.overview)
      && Boolean(system && pattern(scenario.topicPattern).test(`${system.headline} ${system.summary}`)));
  const practicalActions = visibleActions.filter((action) => pattern(scenario.topicPattern).test(`${action.title} ${action.why} ${action.firstStep}`)
    && action.firstStep.length >= 12 && /记录|测量|预约|复查|就诊|检查|带上|咨询|替换|减少|选择|讨论|安排|陪同/.test(action.firstStep)
    && action.claimIds.some((id) => visibleClaims.some((claim) => claim.id === id)));
  check('concrete-linked-next-step', '有针对本案例、关联正文判断的具体下一步，不只是“注意健康”', practicalActions, practicalActions.length > 0);
  check('no-process-narrative', '最终正文不暴露模型、修复、入库或核对工作记录', input.processIssues, input.processIssues.length === 0);
  if (input.requireDailyLife) {
    // 只验收新提示词的五域产物；不会将旧快照缺失建议变成重新调用模型的生产门禁。
    const lifestyle = snapshot.actions.filter((action) => action.lifestyleDomain);
    for (const domain of ['diet', 'activity', 'sleep', 'supplements', 'daily_routine'] as const) {
      const items = lifestyle.filter((action) => action.lifestyleDomain === domain);
      check(`daily-life:${domain}`, '日常生活领域有解释和可执行做法，也可明确说明目前无须新增补充剂',
        items.map((action) => ({ title: action.title, why: action.why, firstStep: action.firstStep, basis: action.lifestyleBasis })),
        items.some((action) => action.why.length >= 12 && action.firstStep.length >= 12 && Boolean(action.lifestyleBasis)));
    }
    check('daily-life-general-separated', '通用建议不能借用个人事实或判断引用，个性化建议必须仍有报告/本人依据',
      lifestyle.map((action) => ({ id: action.id, basis: action.lifestyleBasis, claimIds: action.claimIds, evidenceIds: action.evidenceIds })),
      lifestyle.length > 0 && lifestyle.every((action) => action.lifestyleBasis === 'general'
        ? action.claimIds.length === 0 && action.evidenceIds.length === 0
        : action.lifestyleBasis === 'personalized' && action.evidenceIds.length > 0));
  }
  const questions = snapshot.questions.map((item) => item.question);
  if (caseId === 'child-vision') {
    const eyeFactIds = new Set(input.facts.filter((fact) => /视力|球镜/.test(fact.name)).map((fact) => fact.id));
    const eyeEvents = readModels.eventDetails.filter((event) => event.findings.some((finding) => eyeFactIds.has(finding.id)));
    check('eye-examination-system', '视力和电脑验光是普通眼科检查，不误标为实验室检验，也不因设备名称中的“脑”进入神经系统',
      eyeEvents.map((event) => ({ type: event.type, systemIds: event.systemIds })), eyeEvents.length > 0
        && eyeEvents.every((event) => event.type === 'other' && event.systemIds.includes('sensory_oral') && !event.systemIds.includes('neurological'))
        && !snapshot.systems.some((system) => system.systemId === 'neurological'));
    const eyeCareActions = visibleActions.filter((action) => /眼科/.test(action.firstStep)
      && /预约|安排|陪同|就诊|前往|到眼科/.test(action.firstStep));
    check('reported-eye-care-action-visible', '报告已有的眼科检查安排最终仍是一条可执行行动，课堂调整不能代替它',
      eyeCareActions, eyeCareActions.length > 0);
    const conditionStatements = [readModels.overview.overview,
      ...visibleClaims.map((claim) => textOf([claim.text, claim.rationale, claim.materialUncertainty])),
      ...snapshot.systems.map((system) => textOf([system.summary, ...system.limitations])),
      ...visibleActions.map((action) => textOf([action.why, action.firstStep, action.caution]))];
    check('non-cycloplegic-limitation-visible', '正文保留未散瞳条件，并说明不能直接据此配镜或确定屈光状态',
      conditionStatements, conditionStatements.some((statement) => /未散瞳|没有散瞳|非散瞳/.test(statement)
        && /不能|不宜|尚不能|不足以|不应|仍需|需要进一步/.test(statement) && /配镜|处方|屈光|近视|散瞳验光/.test(statement)));
    check('parent-context-used', '结合家长补充的看黑板困难，下一步适用于孩子/家长', narrative,
      /黑板/.test(narrative) && /家长|孩子|儿童|11岁/.test(actionText));
    check('known-child-answers-not-reasked', '不重复要求家长确认已有眼镜或本次是否散瞳', questions,
      !questions.some((question) => reasksKnownChildAnswer(question, scenario.expectedFacts[0]!.date)));
  } else if (caseId === 'older-bp-kidney') {
    const bpActions = visibleActions.filter((action) => /记录|测量|监测/.test(action.firstStep)
      && /家庭血压|家中.{0,10}血压|家里.{0,10}血压/.test(action.firstStep));
    check('reported-bp-recording-action-visible', '原报告的家庭血压记录安排最终仍可执行，其他肾脏检查建议不能替代它',
      bpActions, bpActions.length > 0);
    check('repeated-bp-and-kidney-explained', '正文解释多次血压与肾功能，保留诊室测量背景及长辈年龄背景', narrative,
      /血压/.test(narrative) && /肾|eGFR/i.test(narrative) && /诊室|门诊|医院/.test(narrative)
        && /多次|三次|3次|反复|持续|历次/.test(narrative) && /75|老年|长辈|高龄/.test(narrative));
    const existing = readModels.lifestyle.adoptedActions.filter((action) => action.title === scenario.existingPlan?.title);
    const movementActions = visibleActions.filter(prescribesMovement);
    const retainedMovement = textOf(existing.map((action) => action.selectedStartingOption));
    const respectsKneeLimit = (text: string) => /膝/.test(text) && /坐位|坐着|耐受|不痛|无痛|低冲击|疼痛.*停止|痛.*停/.test(text);
    check('knee-limited-action', '新增活动建议尊重膝痛限制；没有新活动建议时可直接保留原有可耐受计划',
      { movementActions, retainedMovement }, movementActions.length > 0
        ? movementActions.every((action) => respectsKneeLimit(textOf([action.why, action.firstStep, action.caution])))
        : respectsKneeLimit(retainedMovement) && /膝/.test(narrative));
    check('existing-plan-preserved', '已存在的坐位活动计划仍在生活页且内容未被覆盖', existing,
      existing.length === 1 && existing[0]?.selectedStartingOption === scenario.existingPlan?.detail
        && !['dismissed', 'completed'].includes(existing[0]?.status ?? ''));
    check('existing-plan-acknowledged', '可见正文承认已有坐位活动计划，不要求重复生成同一项行动', narrative,
      /坐位|坐着/.test(narrative) && /已有|已经|原有|现有|继续|保持|保留|正在/.test(narrative));
  } else {
    const priorities = readModels.overview.priorityIssues;
    check('recent-change-prioritized', '总览突出近期LDL变化，同一主题不重复挤占前三项', priorities,
      priorities.length > 0 && pattern(scenario.topicPattern).test(`${priorities[0]?.title} ${priorities[0]?.explanation}`)
        && new Set(priorities.map((item) => snapshot.claims.find((claim) => claim.id === item.id)?.topicKey ?? item.id)).size === priorities.length);
    check('normal-scope-explained', '正文说明其余已检项目未提示异常，同时不把全部身体判为无风险', narrative,
      /血糖|血红蛋白|转氨酶|其他.*项目|其余.*项目/.test(narrative) && /正常|范围内|未.*异常|未.*问题/.test(narrative)
        && !/全身.*完全健康|完全没有.*风险|所有.*绝对正常/.test(narrative));
    check('answered-background-used', '建议使用已回答的外卖/油炸饮食变化，给出具体替换或减少步骤', actionText,
      /外卖|炸鸡|油炸/.test(actionText) && /替换|减少|选择|改为|改成|少点|换成/.test(actionText));
    check('known-adult-answers-not-reasked', '不再询问已明确回答的吸烟、调脂药和近期饮食变化', questions,
      !questions.some((question) => /是否|有没有|有无|吗|哪些|什么|如何|\?/.test(question)
        && /吸烟|抽烟|(?:服|用|吃).*调脂药|(?:服|用|吃).*降脂药|饮食.*变化|最近.*吃|近期.*饮食/.test(question)
        && !/过敏|不良反应|计划|打算|准备|愿意|下次|以后/.test(question)));
  }
  return checks;
}

export function syntheticFamilyReviewDocument(caseId: SyntheticFamilyCaseId, checks: SyntheticContentCheck[],
  snapshot: SyntheticFamilyPresentation, readModels: SyntheticFamilyReadModels): string {
  const scenario = syntheticFamilyScenarios[caseId];
  return `# 纯合成家庭案例：${caseId}\n\n人工内容评审：NOT_REVIEWED。自动检查不是临床有效性或家庭可用性的证明。\n\n`
    + `展示证据是正式成员页使用的服务投影，尚不代表浏览器排版已验收；请结合截图独立阅读。\n\n`
    + `## 输入与需要独立回答的问题\n\n出生年：${scenario.member.birthYear}；关系：${scenario.member.relation}。\n\n`
    + scenario.humanReviewQuestions.map((question) => `- [ ] ${question}`).join('\n')
    + `\n\n## 自动观察\n\n${checks.map((check) => `- ${check.passed ? 'PASS' : 'FAIL'} ${check.id}：${check.expected}`).join('\n')}`
    + `\n\n## 家庭成员实际读取的正文\n\n### 总览\n\n${readModels.overview.headline}\n\n${readModels.overview.overview}\n\n`
    + readModels.overview.priorityIssues.map((issue) => `#### ${issue.title}\n\n${issue.explanation}\n\n下一步：${issue.nextStep ?? '未提供'}\n`).join('\n')
    + snapshot.systems.map((system) => `### ${system.systemId}：${system.headline}\n\n${system.summary}\n\n`
      + snapshot.claims.filter((claim) => system.claimIds.includes(claim.id)).map((claim) =>
        `${claim.text}\n\n${claim.rationale}\n\n${claim.materialUncertainty ?? ''}\n`).join('\n')).join('\n')
    + `\n## 下一步与仍需补充的问题\n\n${snapshot.actions.map((action) => `### ${action.title}\n\n${textOf([action.why, action.firstStep, action.timing, action.reviewPlan, action.caution])}\n`).join('\n')}`
    + `\n${snapshot.questions.map((question) => `- ${question.question}`).join('\n') || '没有追加问题。'}\n\n`
    + `## 人工结论（由独立审阅者填写）\n\n- 是否真正解释了身体情况：待评审\n- 建议是否适配本成员：待评审\n- 条件和数值是否准确：待评审\n- 截图及交互是否可用：待验证\n- 不能只以发布成功或无过程词判定通过。\n`;
}
