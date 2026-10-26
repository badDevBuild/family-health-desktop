import { describe, expect, it } from 'vitest';
import type { ExtractionResult } from '@contracts';
import { buildP01Prompt, buildP02Prompt, buildP03Prompt, buildP04Prompt, HEALTH_RUNTIME_PROMPT_V3 } from './lean.js';
import { FAMILY_TONE_RULES, RUNTIME_PROMPT_VERSION } from './shared.js';
import { ASSESSMENT_VALIDATION_RULES_VERSION } from '../assessment-validation.js';
import {
  ACCEPTANCE_RULES_VERSION,
  DERIVED_PROMPT_VERSION,
  EXTRACTION_PROMPT_VERSION,
  MEMBER_ASSESSMENT_PROMPT_VERSION,
  MEMBER_ASSESSMENT_RULES_VERSION,
  buildAdjudicateAbnormalFlagsPrompt,
  buildAdjudicateFactDifferencesPrompt,
  buildAnalyzePrompt,
  buildExtractPrompt,
  buildRecoverCoveragePrompt,
  buildRepairFactValidationPrompt,
  buildRepairDerivedPrompt,
  buildReviewDerivedPrompt,
  buildReviewSystemAnalysisPrompt,
  buildReviewFactsPrompt,
  buildSystemAnalysisPrompt,
  promptMetaForStage
} from './index.js';

const sourcePackage = JSON.stringify({
  documentId: 'doc-1',
  spans: [{ sourceSpanId: 'span-visual-1', quote: 'LDL-C 4.2' }]
});

const extraction: ExtractionResult = {
  schemaVersion: 1,
  documentId: 'doc-1',
  subject: { reportedName: null, evidence: [], confidence: 'absent' },
  coveredSourceSpanIds: ['span-visual-1'],
  candidates: []
};

function instructionPart(prompt: string): string {
  const marker = '\n\n## 输入\n';
  const index = prompt.indexOf(marker);
  expect(index).toBeGreaterThan(0);
  return prompt.slice(0, index);
}

describe('pipeline prompts', () => {
  it('纠正方法缺口只引用同次可定位原称，不换编号或撤销其他未知背景', () => {
    const prompt = instructionPart(buildP04Prompt({}, {}, []));
    expect(prompt).toContain('同次已提供且可定位的来源原称或完整方法原话');
    expect(prompt).toContain('不自行换写方法编号、同位素名称或新增解释数值');
    expect(prompt).toContain('仍未知的治疗经过、检测前用药及其他适用条件分别保留');
    expect(prompt).toContain('若不能确认原称的唯一来源位置，保留该条说明');
  });

  it('日期缺口局部保留说明，独立建议有一次受控的后置补救', () => {
    for (const prompt of [buildP02Prompt({}, {}), buildP03Prompt({ stage: 'assessment' }, {}, []), buildP04Prompt({}, {}, [])]) {
      expect(prompt).toContain('日期只限制真正需要该日期的判断');
      expect(prompt).toContain('非日期正文、数值、单位、比较符、部位、否定及原有限定保持原样');
      expect(prompt).toContain('temporalStatus=uncertain');
      expect(prompt).toContain('日期附属的纯文档时间修饰语');
      expect(prompt).toContain('检查、采样、手术、服药和术后条件不是纯文档时间修饰语');
      expect(prompt).toContain('未知日期说明只追加到 materialUncertainty');
      expect(prompt).toContain('不从不同文档拼接新的复合事件名称或标本、操作角色');
      expect(prompt).toContain('同一正文中其他有独立来源的日期原样保留');
      expect(prompt).toContain('没有年份的月日也属于日期');
      expect(prompt).toContain('时间角色限制必须逐字保留');
      expect(prompt).toContain('其他有独立依据的日常建议');
    }
    const repair = buildP03Prompt({ stage: 'assessment' }, {}, []);
    expect(repair).toContain('recoveryMode=late_independent_habits');
    expect(repair).toContain('不循环补救');
    expect(buildP04Prompt({}, {}, [])).toContain('不恢复此前隔离的主张或其他行动');
    expect(buildP03Prompt({ stage: 'extraction' }, {}, [])).not.toContain('后置批量补救');
  });
  it('新原安排绑定单条事实原句，语义复核核对最终依赖，不靠新增措辞例外放行', () => {
    for (const prompt of [buildP02Prompt({}, {}), buildP03Prompt({ stage: 'assessment' }, {}, []), buildP04Prompt({}, {}, [])]) {
      expect(prompt).toContain('sourceInstructionObservationId');
      expect(prompt).toContain('完整 rawValue 直接作为 firstStep');
      expect(prompt).toContain('不拆句、拼句或截断');
    }
    const focused = buildP04Prompt({}, {}, []);
    expect(focused).toContain('REVIEW_REQUEST.finalDependencyGraph=true');
    expect(focused).toContain('只删除 claimIds、改标点或保留原正文不算独立改写');
    expect(focused).toContain('不表示内容已被证明错误或安全');
    expect(focused).toContain('不要求所有病名在同一句出现');
    expect(focused).toContain('不能从共同部位、影像发现或模型 originalName 补出诊断');
    expect(focused).toContain('后续正文或前提再变，旧回执即失效');
    expect(focused).toContain('指标名称或分类标识中的数字不是新增检验结果');
    expect(focused).toContain('数值、比较符、数量级和完整单位仍保持原意');
    expect(focused).toContain('action 的 kind、timingBasis、lifestyleDomain、lifestyleBasis 是本轮冻结的行动范围');
    expect(focused).toContain('不先改分类再把它当作已复核的新行动');
  });
  it('生成与局部修正同步区分问句已知前提和真正未知，不以问号绕过个人来源', () => {
    for (const prompt of [buildP02Prompt({}, {}), buildP03Prompt({ stage: 'assessment' }, {}, []), buildP04Prompt({}, {}, [])]) {
      const instructions = instructionPart(prompt);
      expect(instructions).toContain('question 和 whyItMatters 都遵守这一规则');
      expect(instructions).toContain('不能用问句偷渡已发生事实');
      expect(instructions).toContain('操作方式、范围、部位、左右侧、日期、否定、疑似和检查条件');
      expect(instructions).toContain('不把局部操作扩成整个器官的处理');
      expect(instructions).toContain('关联主张本身不是最终事实证明');
      expect(instructions).toContain('不预设事实的中性或明确条件式问题');
      expect(instructions).toContain('这里只核对问句，不替本人回答');
    }
    const extraction = instructionPart(buildP03Prompt({ stage: 'extraction' }, {}, []));
    expect(extraction).not.toContain('## 问句的事实前提');
  });

  it('P04 所有问题在既有一次复核中核实前提，只读关联主张不变成授权目标或事实证明', () => {
    const instructions = instructionPart(buildP04Prompt({ targets: ['question-1'], reasons: ['question_premise:question-1'] },
      { readOnlyClaims: [{ id: 'claim-readonly' }] }, []));
    expect(instructions).toContain('所有临床问句统一进入本轮既有的一次复核');
    expect(instructions).toContain('不仅核对带病名或高后果词的问题');
    expect(instructions).toContain('SOURCE_CONTEXT.readOnlyClaims');
    expect(instructions).toContain('必须结合 evidenceCatalog 中实际个人来源核对');
    expect(instructions).toContain('支持、反证来源都要按各自角色读取');
    expect(instructions).toContain('不得修改只读主张、增加 targetId 或把只读内容搬成新节点');
    expect(instructions).toContain('仅在同 ID 的 question 节点内 replace');
    expect(instructions).toContain('无法据来源可靠修正时 hold');
  });

  it('分析和提取局部修复都只返回授权目标，依赖义务不会只留在权限表', () => {
    const request = { stage: 'assessment', targets: ['c_gastric', 'a_diet'], originalCandidateHash: 'a'.repeat(64),
      targetDetails: [{ targetId: 'a_diet', role: 'dependent', ownIssues: [], dependsOnIds: ['c_gastric'],
        triggerIssues: ['documented_source_not_proven:c_gastric'], remainingEvidenceIds: ['report-result'], remainingClaimIds: ['c_weight'] }] };
    const prompt = buildP03Prompt(request, { facts: [{ originalName: '内镜检查', rawValue: '胃黏膜充血，未见溃疡' }] }, [
      { targetId: 'a_diet', nodeType: 'action', value: { id: 'a_diet' } }
    ]);
    expect(prompt).toContain('TARGET_NODES=');
    expect(prompt).not.toContain('TARGET_CANDIDATE=');
    expect(prompt).toContain('MemberAssessmentRepairV1');
    expect(prompt).toContain('不返回整份 MemberAssessmentCandidateV3');
    expect(prompt).toContain('dependent 不是可忽略的权限条目');
    expect(prompt).toContain('每个 targetId 恰好一次');
    expect(prompt).toContain('originalCandidateHash 严格按 REPAIR_REQUEST 原样填写');
    expect(prompt).toContain('分析任务不能删除目标节点或借 questions 创建新 ID');
    expect(prompt).toContain('无法可靠修正时逐目标返回 unchanged 和明确 reason');
    expect(prompt).toContain('原文明确写“诊断：慢性胃炎”等肯定诊断时保留真正 documented 原诊断及时间');
    expect(prompt).toContain('不能因清除不成立的病名而机械撤掉整项饮食建议');
    expect(prompt).toContain('低密度脂蛋白胆固醇高于该次参考上限');
    expect(prompt).toContain('胃黏膜充血、水肿，未见溃疡');
    expect(prompt).toContain('鼻腔黏膜增厚');
    expect(prompt).toContain('咽部充血');
    const extractionRepair = buildP03Prompt({ stage: 'extraction', targets: ['item'] }, {}, { candidates: [] });
    expect(extractionRepair).toContain('TARGET_ITEMS=');
    expect(extractionRepair).toContain('只返回 ExtractionRepairV1');
    expect(extractionRepair).not.toContain('TARGET_CANDIDATE=');
    expect(extractionRepair).not.toContain('lifestyleDomain');
    expect(extractionRepair).not.toContain('五类日常生活');
    expect(extractionRepair).toContain('未列入目标的候选、身份和其他元数据由应用原样保留');
  });
  it('整体总结覆盖已有系统，五类日常生活在一次综合中生成，来源强弱不会混同', () => {
    const prompt = instructionPart(buildP02Prompt({}, {}));
    expect(prompt).toContain('综合所有有资料的身体系统');
    expect(prompt).toContain('不把一个“肝胆检查结果”等单系统标题当作整个人的健康总览');
    expect(prompt).toContain('已经检查且稳定或改善的方面');
    expect(prompt).toContain('diet（饮食与日常摄入）');
    expect(prompt).toContain('activity（运动与活动）');
    expect(prompt).toContain('sleep（睡眠）');
    expect(prompt).toContain('supplements（保健品与营养补充）');
    expect(prompt).toContain('daily_routine（作息与日常安排）');
    expect(prompt).toContain('不另起五轮分析');
    expect(prompt).toContain('每个领域输出至少一条有用的具体建议');
    expect(prompt).toContain('lifestyleBasis=personalized');
    expect(prompt).toContain('引用相应 evidenceIds');
    expect(prompt).toContain('kind=habit、urgency=routine、claimIds=[]、evidenceIds=[]');
    expect(prompt).toContain('不推断本人未服药');
    expect(prompt).toContain('优先从食物获得营养');
    expect(prompt).toContain('暂不新增保健品');
    expect(prompt).toContain('不新增处方，不给无依据的个体补充剂剂量');
    for (const localized of [buildP03Prompt({}, {}, {}), buildP04Prompt({}, {}, {})]) {
      expect(instructionPart(localized)).toContain('只处理已授权目标');
      expect(instructionPart(localized)).toContain('完整保留原有 lifestyleDomain/lifestyleBasis');
    }
  });
  it('一次综合的饮食建议读取消化道背景，但不把有病名的报告结果自动升级为当前确诊', () => {
    const generation = instructionPart(buildP02Prompt({}, {}));
    expect(generation).toContain('已接纳的结果可以含病名');
    expect(generation).toContain('检查结论：慢性浅表性胃炎');
    expect(generation).toContain('优先以 source_fact 按来源日期忠实转述');
    expect(generation).toContain('若原资料另有可核对的肯定诊断原句');
    expect(generation).toContain('不把真正诊断统一降级');
    expect(generation).toContain('不能为缩短篇幅改用同系统另一个较短但无关的结果');
    for (const prompt of [buildP02Prompt({}, {}), buildP03Prompt({}, {}, {}), buildP04Prompt({}, {}, {})]) {
      const instructions = instructionPart(prompt);
      expect(instructions).toContain('已接纳的胃镜/消化道结果');
      expect(instructions).toContain('出现胃部不适时按耐受调整');
      expect(instructions).toContain('不断言本人现在有症状');
      expect(instructions).toContain('没有该类个人依据时不要套用这一例子');
      expect(instructions).toContain('不要求先确认新的胃炎诊断');
    }
  });
  it('定向修复来源显示完整主题和条件，不用精简结果替代原医嘱也不扩授权范围', () => {
    const request = { stage: 'assessment', targets: ['a_report_plan'], targetDetails: [{
      targetId: 'a_report_plan', sourceQuotes: [{ evidenceId: 'ref:1', clinicalDate: '2026-01-03',
        quote: '若仍有不适：请至门诊复诊。' }]
    }] };
    const prompt = buildP03Prompt(request, {}, []);
    const instructions = instructionPart(prompt);
    expect(instructions).toContain('targetDetails.sourceQuotes');
    expect(instructions).toContain('引用同一 evidenceId');
    expect(instructions).toContain('不用 rawValue 的较短正文替换完整原句');
    expect(instructions).toContain('quote 为空的事实不会在这里补造原文');
    expect(instructions).toContain('不表示旧安排今天仍适用');
    expect(instructions).toContain('没有原期限仍为 timing=null、timingBasis=none');
    expect(instructions).toContain('不推断已经执行或仍在执行');
    expect(prompt).toContain(JSON.stringify(request));
  });
  it('综合、修复、复核统一说实际健康边界，区分资料缺口与未做检查', () => {
    for (const prompt of [buildP02Prompt({}, {}), buildP03Prompt({}, {}, {}), buildP04Prompt({}, {}, {})]) {
      const instructions = instructionPart(prompt);
      expect(instructions).toContain('正文直接解释健康意义');
      expect(instructions).toContain('不能把这些读数写成新的确诊');
      expect(instructions).toContain('不可据此删掉数值、来源、时间、诊断不确定性或临床限制');
      expect(instructions).toContain('本次资料未提供该项检查结果');
      expect(instructions).toContain('只有关联原文或本人自述明确说明未做');
      expect(instructions).toContain('不自动要求补做、重新上传或逐项确认');
    }
    const repair = instructionPart(buildP03Prompt({}, {}, {}));
    expect(repair).toContain('missing_exam_scope');
    expect(repair).toContain('不补造缺失结果');
    expect(repair).toContain('不自行增加补查任务');
  });
  it('P02、P03、P04 均区分短标题与完整医学正文', () => {
    for (const prompt of [buildP02Prompt({}, {}), buildP03Prompt({}, {}, {}), buildP04Prompt({}, {}, {})]) {
      expect(prompt).toContain('claim.title');
      expect(prompt).toContain('claim.text 保留完整发现');
      expect(prompt).toContain('不把整段判断复制成标题');
    }
    const generation = buildP02Prompt({}, {});
    expect(generation).toContain('不是全部行动的数量上限');
    expect(generation).toContain('habit/self_monitor');
    expect(generation).toContain('不重复询问已知信息');
  });

  it('影像发现不拼成documented复合诊断，局部修复完整清空诊断字段并同步有据依赖建议', () => {
    const generation = instructionPart(buildP02Prompt({}, {}));
    expect(generation).toContain('普通影像发现、检查结论或疾病相关描述不自动等于医生已明确诊断');
    expect(generation).toContain('diagnosticStatus=null、diseaseName=null、criteriaBasis=null');
    expect(generation).toContain('不得把分散发现拼成一个新的 documented 复合诊断');
    const repair = instructionPart(buildP03Prompt({
      stage: 'assessment', targets: ['claim:neck', 'action:activity', 'action:routine'],
      allowedPaths: ['node:claim:neck', 'node:action:activity', 'node:action:routine'],
      issues: ['documented_source_not_proven:claim:neck']
    }, {}, {}));
    expect(repair).toContain('documented_source_not_proven 先区分');
    expect(repair).toContain('只改 kind 而保留诊断字段不是修复');
    expect(repair).toContain('颈5/6椎间盘轻度突出（中央型）');
    expect(repair).toContain('保留完整证据、身体限制和停止条件');
    expect(repair).toContain('不得只删除 claimIds、把 personalized 改为 general');
    expect(repair).toContain('不为凑齐五域补造内容');
    expect(repair).toContain('当日常建议引用了已被隔离的判断时');
    expect(repair).toContain('不能只删除引用保留原来的高影响判断');
  });

  it('隔离后只在独立个人依据支持时实质重写同一个已有日常action，不以清空引用或general挽救旧医学前提', () => {
    const request = { stage: 'assessment', targets: ['action:synthetic-habit'],
      allowedPaths: ['node:action:synthetic-habit'], issues: ['action_claim_unknown:action:synthetic-habit'],
      targetDetails: [{ targetId: 'action:synthetic-habit', role: 'issue_owner', ownIssues: [],
        dependsOnIds: [], triggerIssues: [], remainingClaimIds: ['claim:synthetic-independent'],
        remainingEvidenceIds: ['evidence:synthetic-independent'] }] };
    const prompt = buildP03Prompt(request, { facts: [] }, [
      { targetId: 'action:synthetic-habit', nodeType: 'action', value: {
        id: 'action:synthetic-habit', dedupeKey: 'synthetic-habit', lifestyleDomain: 'diet', lifestyleBasis: 'personalized'
      } }
    ]);
    const repair = instructionPart(prompt);
    expect(prompt).toContain(JSON.stringify(request));
    expect(repair).toContain('只在原有授权目标内修复同一个已有 action，不新增 ID');
    expect(repair).toContain('先读取 remainingClaimIds/remainingEvidenceIds 对应的实际个人来源');
    expect(repair).toContain('编号存在或仍有一条引用不等于已证明独立依据');
    expect(repair).toContain('只有具备独立个人依据时，才以该依据实质重写同 ID 的完整 action');
    expect(repair).toContain('保留原有 dedupeKey、lifestyleDomain 和有依据的 lifestyleBasis=personalized');
    expect(repair).toContain('以 why 和 firstStep 为中心重写');
    expect(repair).toContain('title、timing、timingBasis、reviewPlan、caution、身体限制和停止条件');
    expect(repair).toContain('只删 claimIds/evidenceIds、改 general 标签或换同义词而保留旧医学前提');
    expect(repair).toContain('没有独立个人依据，或无法在现有授权目标内完整、可靠重写时');
    expect(repair).toContain('对该目标返回 unchanged 和具体 reason，由应用决定隔离');
    expect(repair).toContain('不改造成与个人无关的一般习惯来保留原 action');
    expect(repair).toContain('不得沿用旧文本的 pass 作为重写文本已核对的证明');
    expect(repair).toContain('常规修复最多两次 P03 和一次 P04');
    expect(repair).not.toContain('真正没有个人依据的一般习惯起点必须重写');
  });

  it('P04在既有一次复核核对重写日常action全文、独立依据、条件和时间，不凭旧hold或pass裁决', () => {
    const request = { targets: ['action:synthetic-rewritten'], reasons: ['synthetic-independent-rewrite'] };
    const prompt = buildP04Prompt(request, { evidenceCatalog: [{ evidenceId: 'evidence:synthetic', quote: '合成个人依据' }] }, [
      { targetId: 'action:synthetic-rewritten', nodeType: 'action', value: {
        id: 'action:synthetic-rewritten', kind: 'habit', urgency: 'routine', lifestyleBasis: 'personalized'
      } }
    ]);
    const review = instructionPart(prompt);
    expect(prompt).toContain(JSON.stringify(request));
    expect(review).toContain('即使标记 kind=habit、urgency=routine');
    expect(review).toContain('本轮既有一次 P04 中核对重写后的完整文本、独立个人依据、适用条件和时间');
    expect(review).toContain('title、why、firstStep、timing、timingBasis、reviewPlan、caution 及实际个人来源');
    expect(review).toContain('不只检查 claimIds/evidenceIds 是否有效或 lifestyleBasis 标签');
    expect(review).toContain('历史依据不得自动当作当前状态');
    expect(review).toContain('旧相关判断已 hold、失效引用已删除，或旧行动曾 pass，都不能证明');
    expect(review).toContain('正文各处不得残留依赖已隔离判断的疾病前提、治疗目标或医疗期限');
    expect(review).toContain('完整文本、条件、时间相称时可以 pass');
    expect(review).toContain('仅在同 ID 的完整 action 内 replace');
    expect(review).toContain('仍无支持时 hold 该目标并说明具体缺口');
    expect(review).toContain('不得因为原关联判断被 hold 就自动一并 hold 所有有独立依据的日常建议');
    expect(review).toContain('不为补齐五个领域增加目标或新 ID');
    expect(review).toContain('常规流程不新增一轮 P04');
    expect(review).toContain('## 问句前提复核');
    expect(review).toContain('## 原报告安排与本轮建议');
  });

  it('综合和单次局部修复均把原医嘱与额外就诊准备分开，不靠改标签绕过来源门禁', () => {
    const generation = instructionPart(buildP02Prompt({}, {}));
    const repair = instructionPart(buildP03Prompt({
      stage: 'assessment', targets: ['action:exam'], allowedPaths: ['node:action:exam'],
      issues: ['documented_plan_source_not_proven:action:exam']
    }, {}, {}));
    for (const instructions of [generation, repair]) {
      expect(instructions).toContain('firstStep 逐字引用或忠实保留原建议');
      expect(instructions).toContain('firstStep 保持完整 source clause，包括该前缀和完整动作');
      expect(instructions).toContain('不能为了通过校验裁剪主题、条件或更改期限');
      expect(instructions).toContain('不混入模型额外添加的检查项目、就诊准备、症状说明或时间');
      expect(instructions).toContain('原文没有期限时，timing=null、timingBasis=none');
      expect(instructions).toContain('不按分析日重新起算');
      expect(instructions).toContain('缺少期限不意味着原建议不存在');
      expect(instructions).toContain('有可靠原建议时保留其证据和行动');
      expect(instructions).toContain('不能只改 kind 或 timingBasis 绕过来源门禁');
      expect(instructions).toContain('不能自动恢复已隔离节点');
      expect(instructions).toContain('也不要求用户确认报告已写明的安排');
    }
    expect(repair).toContain('局部修复只改 allowedPaths 内的节点');
    expect(repair).toContain('不顺手改其他行动或新增行动');
    expect(repair).toContain('本轮不能新增网页检索');
  });

  it('原报告的有条件不处理是历史处理意见，不将缺日期或今日适用未知当成原安排不存在', () => {
    for (const instructions of [instructionPart(buildP02Prompt({}, {})),
      instructionPart(buildP03Prompt({ stage: 'assessment' }, {}, {})), instructionPart(buildP04Prompt({}, {}, []))]) {
      expect(instructions).toContain('无症状时无需特殊处理');
      expect(instructions).toContain('这与“原报告未给出建议”不同');
      expect(instructions).toContain('完整保留否定及适用条件');
      expect(instructions).toContain('不能据历史意见声称今天无需治疗');
      expect(instructions).toContain('已接纳原项目名只是提取字段');
      expect(instructions).toContain('模型生成的行动标题更不能充当来源');
      expect(instructions).toContain('临床日期为空时保持未知');
      expect(instructions).toContain('不按分析日重新起算');
      expect(instructions).toContain('原安排有依据但时间或今天是否执行未知时，保留原安排');
    }
  });

  it('版本号与阶段签名保持一致', () => {
    expect(EXTRACTION_PROMPT_VERSION).toBe('extract-direct-original-v23');
    expect(ACCEPTANCE_RULES_VERSION).toBe('direct-original-acceptance-v22');
    expect(DERIVED_PROMPT_VERSION).toBe('derived-v4');
    expect(promptMetaForStage('extract')).toEqual({
      promptVersion: 'extract-direct-original-v23',
      rulesVersion: ACCEPTANCE_RULES_VERSION
    });
    expect(promptMetaForStage('analyze')).toEqual({
      promptVersion: MEMBER_ASSESSMENT_PROMPT_VERSION,
      rulesVersion: MEMBER_ASSESSMENT_RULES_VERSION
    });
  });

  it('综合用报告日期理解资料所属时期，不把它补成精确检查日或要求重复确认', () => {
    const prompt = buildP02Prompt({}, { format: 'member-evidence-table-v1', data: { analysisFormat: 'member-analysis-v2' } });
    expect(prompt).toContain('facts.sourceTime');
    expect(prompt).toContain('按报告日期理解当时状态');
    expect(prompt).toContain('不是该项目被补写的精确检查日');
    expect(prompt).toContain('不能把 document 级时间套到历史列、跨文件');
    expect(prompt).toContain('没有 sourceTime 的事实仍参与综合');
    expect(prompt).toContain('facts.effectiveTime');
    expect(prompt).toContain('按报告日期记录');
    expect(prompt).toContain('缺少 effectiveTime 的历史多期记录不能套用报告日');
  });

  it('V3 提取不把覆盖用的非临床说明写成健康事实', () => {
    const prompt = buildP01Prompt({ displayName: '合成成员' }, { spans: [{ quote: '此图仅用于软件测试' }] });
    expect(prompt).toContain('软件测试声明等非临床说明不是个人健康事实');
    expect(prompt).toContain('不要为了覆盖而把它们建成“报告说明”候选');
    expect(prompt).toContain('“报告者、报告人、审核人、检验者、申请医生、签发人”等工作人员姓名绝不是 subject');
    expect(prompt).toContain('subject.evidence.quote 摘录患者身份字段的标签和姓名');
  });

  it('通用提取将栏目和具体发现分开定位，不把临时别名交给模型作为永久身份', () => {
    const extraction = buildP01Prompt({}, {});
    expect(extraction).toContain('不是永久记录编号');
    expect(extraction).toContain('headingEvidence');
    expect(extraction).toContain('findingEvidence');
    expect(extraction).toContain('不能把同栏目误作同一检查项目');
    expect(extraction).toContain('无法唯一定位时记录具体 blocking_source_binding_ambiguous');
    const repair = buildP03Prompt({ stage: 'extraction', maxRepairAttempts: 1 }, {}, {});
    expect(repair).toContain('只修复授权目标');
    expect(repair).toContain('保留完整原报告文字上下文');
    expect(repair).toContain('不生成或猜测永久记录编号');
  });

  it('V3 综合明确使用授权全历史，药物讨论标签不能豁免直接指令', () => {
    expect(MEMBER_ASSESSMENT_PROMPT_VERSION).toBe('member-assessment-v51');
    const prompt = buildP02Prompt({ newDocumentIds: ['doc-new'] }, { facts: [] });
    expect(prompt).toContain('不能只看 newDocumentIds');
    expect(prompt).toContain('不能用上次分析摘要代替历史事实');
    expect(prompt).toContain('不要仅因 systemIds 为空就丢掉事实或猜一个器官');
    expect(prompt).toContain('系统归类和视图覆盖属于应用的工作记录，不写进健康正文');
    expect(prompt).not.toContain('在总览说明系统视图的范围限制');
    expect(prompt).toContain('既往诊断可以同时使用两者');
    expect(prompt).toContain('treatment_discussion');
    expect(prompt).toContain('clinicalDate 为空不代表报告时期不存在');
    expect(prompt).toContain('不把尚未证实的日期、今天起算的期限与用药说明混成一个自由文本前提');
    expect(prompt).toContain('直接开始、停止或调整处方药');
    const focusedReview = buildP04Prompt({ targets: [] }, {}, {});
    expect(focusedReview).toContain('SOURCE_CONTEXT.factTimes');
    expect(focusedReview).toContain('不得仅 pass 后保留失效 claimIds');
    expect(focusedReview).toContain('action.type=treatment_discussion');
    expect(focusedReview).toContain('SOURCE_CONTEXT.sourceInstructions.sourceTime');
    expect(focusedReview).toContain('不能改为 examined、填入 clinicalDate');
    expect(focusedReview).toContain('clinicalDate 为空不等于已有文档时期不存在');
  });

  it('关注主题不按事实趋势解释拆散，急迫问题和必要条件仍保留', () => {
    const prompt = instructionPart(buildP02Prompt({}, {}));
    expect(prompt).toContain('topicKey 代表用户需要理解或处理的同一个健康问题');
    expect(prompt).toContain('不得仅因属于 trend/diagnostic_assessment 就加不同后缀');
    expect(prompt).toContain('分组不等于合并或改写事实');
    expect(prompt).toContain('不能仅因共用一次就诊行动就合并血压和肾功能');
    expect(prompt).toContain('急迫问题不能埋入普通解释的主题中');
    expect(prompt).toContain('overview.claimIds 按用户最值得先看的顺序排列');
  });

  it('最终健康正文规则在综合、局部修复、重点复核中一致，而非只锁单篇文案', () => {
    const prompts = [buildP02Prompt({}, {}), buildP03Prompt({}, {}, {}), buildP04Prompt({}, {}, {})];
    for (const prompt of prompts) {
      const instructions = instructionPart(prompt);
      for (const rule of FAMILY_TONE_RULES) expect(instructions).toContain(rule);
      expect(instructions).toContain('本人这次结果');
      expect(instructions).toContain('未散瞳');
      expect(instructions).toContain('过去的医嘱不是今天重新给出的建议');
      expect(instructions).toContain('不逐条重复全部 claims');
      expect(instructions).toContain('personalContext.effectiveDate');
      expect(instructions).toContain('recordedAt 只是录入时间');
      expect(instructions).toContain('检查同日自述该状态');
      expect(instructions).toContain('identity.birthYear');
      expect(instructions).toContain('不能说年龄完全未知');
      expect(instructions).toContain('通用检验说明不能冒充某个疾病方向的专门来源');
    }
    expect(buildP03Prompt({}, {}, {})).toContain('process_narrative');
    expect(HEALTH_RUNTIME_PROMPT_V3).toContain('不作新的医生确诊');
    expect(HEALTH_RUNTIME_PROMPT_V3).not.toContain('允许直接写“报告已明确诊断为……”“现有资料符合');
    expect(RUNTIME_PROMPT_VERSION).toBe('health-runtime-v4');
    expect(ASSESSMENT_VALIDATION_RULES_VERSION).toBe('assessment-validation-v43');
    expect(MEMBER_ASSESSMENT_RULES_VERSION).toBe(`lean-health-v3.61+${ASSESSMENT_VALIDATION_RULES_VERSION}`);
  });

  it('行动依赖反映真实前提，而非主题相关；同次复核必须闭合最终依赖', () => {
    const generation = instructionPart(buildP02Prompt({}, {}));
    expect(generation).toContain('action.claimIds 只放真正支撑该行动目的、做法或安全限制的主张');
    expect(generation).toContain('直接个人依据放 evidenceIds');
    expect(generation).toContain('需要的术后、用药、年龄等限制不能为减少依赖而漏掉');
    expect(generation).not.toContain('关联全部相关问题和系统');
    const review = instructionPart(buildP04Prompt({}, {}, {}));
    expect(review).toContain('pass 表示完整正文和实际依赖都可保留');
    expect(review).toContain('仍引用已 hold 主张的 action 不能 pass');
    expect(review).toContain('不能靠程序删边、general 标签或旧 pass 放行');
    expect(review).toContain('REVIEW_REQUEST.actionDependencyRebindings');
    expect(review).toContain('全部展示字段、直接 evidenceIds');
    expect(review).toContain('目标主张仅能按它自身已有权限在同次 P04 中收窄');
    expect(review).toContain('不适用于仅知识引用目标或后置独立日常建议补救');
  });

  it('完整原安排允许同一引用内的连续多句，不遗漏前提或把注意到事实改为医嘱', () => {
    for (const prompt of [buildP02Prompt({}, {}), buildP03Prompt({}, {}, {}), buildP04Prompt({}, {}, {})]) {
      const instructions = instructionPart(prompt);
      expect(instructions).toContain('注意合理饮食、适当活动，可预约相应门诊');
      expect(instructions).toContain('“注意到检查异常”仍只是发现，不是安排');
      expect(instructions).toContain('同一条真实引用中的多句完整原安排');
      expect(instructions).toContain('不得跨引用拼接、跳过中间句子、遗漏独立前提');
      expect(instructions).toContain('不只复制最后一句“建议复查”');
      expect(instructions).toContain('不要求把整段科普复制成行动');
      expect(instructions).toContain('紧邻的独立前提或期限');
    }
  });

  it('知识引用核对只纠正归属，不把个人结果变成人工确认或再次整篇分析', () => {
    const review = instructionPart(buildP04Prompt({ knowledgeOnlyTargetIds: ['claim-1'] }, {}, {}));
    expect(review).toContain('REVIEW_REQUEST.knowledgeOnlyTargetIds');
    expect(review).toContain('支持该目标的全部医学解释或行动依据');
    expect(review).toContain('其他字段必须保持原样');
    expect(review).toContain('保留原个人结论及个人依据');
    expect(review).toContain('不为仅核对引用的目标联网');
    expect(review).toContain('只放在 reason 中，不写进健康正文');
    expect(review).toContain('不能仅撤引用后继续把原决定说成有指南依据');
    for (const prompt of [buildP02Prompt({}, {}), buildP03Prompt({}, {}, {}), buildP04Prompt({}, {}, {})]) {
      expect(instructionPart(prompt)).toContain('不能用只支持其中一句的来源给整段背书');
      expect(instructionPart(prompt)).toContain('来源支持范围和个人报告依据是两回事');
    }
  });

  it('综合局部修复及重点复核只改问题字段，撤知识引用不顺手改安全提醒', () => {
    for (const prompt of [buildP03Prompt({ stage: 'assessment' }, {}, []), buildP04Prompt({}, {}, [])]) {
      const instructions = instructionPart(prompt);
      expect(instructions).toContain('完整节点替换不等于重新写整张卡片');
      expect(instructions).toContain('没有实质问题的字段逐字保留');
      expect(instructions).toContain('保留原 caution 中的完整安全提醒');
      expect(instructions).toContain('不能保留错误决定只删引用');
      expect(instructions).toContain('在 reason 说明缺口');
    }
    expect(instructionPart(buildP03Prompt({ stage: 'extraction' }, {}, [])))
      .not.toContain('## 最小字段修正');
  });

  it('提取提示词把数据块放在说明之后，并锁定关键硬规则', () => {
    const prompt = buildExtractPrompt({ personDisplayName: '测试成员', sourcePackage });
    const instructions = instructionPart(prompt);
    expect(instructions).toContain('你是健康报告事实提取器');
    expect(instructions).toContain('位于“趋势”列');
    expect(instructions).toContain('不得根据目标成员显示名反推');
    expect(instructions).toContain('每个明确日期结果列都要分别提取');
    expect(instructions).toContain('不能只保留最后一列');
    expect(instructions).toContain('只明确到年或月时保留 year/month 精度');
    expect(instructions).toContain('不能从文件名、目录、目标成员、所在地或网页推测');
    expect(instructions).not.toContain('SOURCE_PACKAGE=');
    expect(prompt).toContain('## 输入\nSOURCE_PACKAGE=');
    expect(prompt).toContain('span-visual-1');
    expect(prompt).toContain('测试成员');
  });

  it('独立复核不得把上一轮结果当成正确答案', () => {
    const prompt = buildReviewFactsPrompt({
      sourcePackage,
      candidateToReview: JSON.stringify(extraction)
    });
    expect(instructionPart(prompt)).toContain('不得因为前一份候选存在就默认接受');
    expect(prompt).toContain('CANDIDATE_TO_REVIEW=');
  });

  it('覆盖补救要求整篇重读并列出缺失片段', () => {
    const prompt = buildRecoverCoveragePrompt({
      stage: 'review_facts',
      sourcePackage,
      expectedSpanIds: ['span-visual-1', 'span-2'],
      missingSpanIds: ['span-2'],
      previousResult: extraction,
      candidateToReview: extraction
    });
    expect(instructionPart(prompt)).toContain('你是独立事实复核器');
    expect(instructionPart(prompt)).toContain('不是只检查缺失片段');
    expect(prompt).toContain('REQUIRED_SOURCE_SPAN_IDS=');
    expect(prompt).toContain('PREVIOUSLY_MISSING_SOURCE_SPAN_IDS=');
    expect(prompt).toContain('"span-2"');
  });

  it('异常标记裁决只处理目标分歧', () => {
    const prompt = buildAdjudicateAbnormalFlagsPrompt({
      sourcePackage,
      expectedSpanIds: ['span-visual-1'],
      differences: [{
        localKey: 'ldl-1',
        itemName: 'LDL-C',
        fields: ['reportedAbnormalFlag'],
        firstCandidate: null,
        secondCandidate: null
      }],
      first: extraction,
      second: extraction
    });
    expect(instructionPart(prompt)).toContain('健康报告事实分歧裁决器');
    expect(instructionPart(prompt)).toContain('位于“趋势”列');
    expect(prompt).toContain('TARGET_DIFFS=');
  });

  it('核心事实分歧一次性裁决全部目标且禁止创造第三个答案', () => {
    const prompt = buildAdjudicateFactDifferencesPrompt({
      sourcePackage,
      differences: [{
        localKey: 'ldl-1',
        itemName: 'LDL-C',
        fields: ['value'],
        firstCandidate: null,
        secondCandidate: null
      }]
    });
    const instructions = instructionPart(prompt);
    expect(instructions).toContain('一次性裁决全部核心差异');
    expect(instructions).toContain('不得创建第三个数值');
    expect(prompt).toContain('"differenceIndex":0');
  });

  it('事实证据修复一次接收全部本地校验错误且不得改动其他候选', () => {
    const prompt = buildRepairFactValidationPrompt({
      sourcePackage,
      validationErrors: [{ localKey: 'ldl-1', itemName: 'LDL-C', reasons: ['unit_not_bound_to_measurement'] }],
      candidate: extraction
    });
    const instructions = instructionPart(prompt);
    expect(instructions).toContain('一次性修复全部本地证据校验错误');
    expect(instructions).toContain('其他候选必须原样保留');
    expect(prompt).toContain('VALIDATION_ERRORS=');
  });

  it('派生分析包含器官归类、叙事分级和去标识化搜索规则', () => {
    const prompt = buildAnalyzePrompt(JSON.stringify({
      personId: 'p1',
      userReportedNotes: [{ text: '本人补充：近期作息不规律' }]
    }));
    const instructions = instructionPart(prompt);
    expect(instructions).toContain('cardiovascular 心血管');
    expect(instructions).toContain('association 关联层');
    expect(instructions).toContain('搜索词必须去标识化');
    expect(instructions).toContain('不得建议开始、停止、调整任何药物');
    expect(instructions).toContain('dedupeKey');
    expect(instructions).toContain('generalKnowledgeEvidence');
    expect(instructions).toContain('只有确实打开并核对过的 HTTPS 来源才可写入 generalKnowledgeEvidence');
    expect(instructions).toContain('goal、rationale、steps、startingOptions');
    expect(prompt).toContain('userReportedNotes');
    expect(prompt).toContain('本人补充：近期作息不规律');
  });

  it('结构修复禁止网页搜索并保留校验错误', () => {
    const prompt = buildRepairDerivedPrompt({
      validationErrors: ['evidence_mismatch:claim-1'],
      factPackage: '{}',
      candidate: '{}'
    });
    expect(instructionPart(prompt)).toContain('不得使用网页搜索');
    expect(prompt).toContain('VALIDATION_ERRORS=');
    expect(prompt).toContain('evidence_mismatch:claim-1');
  });

  it('安全复核要求逐项覆盖 claim 与 guidance', () => {
    const prompt = buildReviewDerivedPrompt({
      factPackage: '{}',
      candidate: '{"claims":[]}'
    });
    expect(instructionPart(prompt)).toContain('必须恰好覆盖候选中的每个 claimId 和 guidanceId');
    expect(instructionPart(prompt)).toContain('搜索词必须去标识化');
    expect(instructionPart(prompt)).toContain('generalKnowledgeEvidence 的网页来源真实存在、机构/标题/适用范围与建议一致');
    expect(instructionPart(prompt)).toContain('必须用去标识化搜索独立核对');
    expect(prompt).toContain('DERIVED_CANDIDATE=');
  });

  it('系统分析只使用完整证据包和程序趋势', () => {
    const prompt = buildSystemAnalysisPrompt('{"identity":{"systemId":"cardiovascular"}}');
    const instructions = instructionPart(prompt);
    expect(instructions).toContain('contextFacts 只能当背景');
    expect(instructions).toContain('只能复述 trends.trendFacts');
    expect(instructions).toContain('现在怎样、为什么、接下来怎么办');
    expect(instructions).toContain('recommendations');
    expect(instructions).toContain('本任务不使用网页搜索');
    expect(prompt).toContain('SYSTEM_EVIDENCE_BUNDLE=');
  });

  it('系统复核必须覆盖主张、矛盾和讨论点', () => {
    const prompt = buildReviewSystemAnalysisPrompt({ evidenceBundle: '{}', candidate: '{}' });
    const instructions = instructionPart(prompt);
    expect(instructions).toContain('conflict:索引');
    expect(instructions).toContain('discussion:索引');
    expect(instructions).toContain('trendConsistent');
    expect(instructions).toContain('useful');
    expect(prompt).toContain('SYSTEM_ANALYSIS_CANDIDATE=');
  });
});
