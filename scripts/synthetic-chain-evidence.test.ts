import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { syntheticCurrentSymptomPresentationChecks, syntheticSourceFingerprint, syntheticTurnStage } from './synthetic-chain-evidence.js';
import { syntheticFamilyScenarios, syntheticFamilyInputHash, syntheticFamilyContentChecks, syntheticFamilyReviewDocument,
  type SyntheticFamilyCaseId } from './synthetic-family-scenarios.js';

/** 只用于测试验收器；没有模型调用，不将这些手写正文冒充真实完整链结果。 */
function familyPresentation(caseId: SyntheticFamilyCaseId): Parameters<typeof syntheticFamilyContentChecks>[1] {
  const scenario = syntheticFamilyScenarios[caseId];
  const clinicalText = caseId === 'child-vision'
    ? '孩子右眼裸眼视力0.6、左眼0.8，看黑板困难。本次未散瞳，不能直接据此配镜，需眼科进一步判断屈光状态。'
    : caseId === 'older-bp-kidney'
      ? '75岁长辈的三次诊室血压收缩压为146、150、148 mmHg，肾小球滤过率为62、60、61，波动不大。'
      : '近期低密度脂蛋白胆固醇从2.4升至3.5 mmol/L，略超参考上限。其余已检项目如血糖、血红蛋白在报告参考范围内。';
  const nextStep = caseId === 'child-vision' ? '请家长陪同孩子预约眼科，带上未散瞳检查结果讨论是否需散瞳验光。'
    : caseId === 'older-bp-kidney' ? '记录家庭血压并带上肾功能结果复诊；继续已有坐位活动，出现膝部疼痛就停下。'
      : '先把每周四次炸鸡外卖中的两次换成蒸煮菜和蔬菜，减少油炸食物，记录饮食变化，后续讨论复查血脂。';
  const systemId = caseId === 'child-vision' ? 'sensory_oral' : 'cardiovascular';
  const unitFor = (source: string) => source === '^d$' ? 'D' : source === '^mmhg$' ? 'mmHg'
    : source.includes('μ') ? 'umol/L' : source === 'ml/min' ? 'mL/min/1.73m2'
      : source === '^mmol/l$' ? 'mmol/L' : source === '^u/l$' ? 'U/L' : source === '^g/l$' ? 'g/L' : null;
  const facts = scenario.expectedFacts.map((expected, index) => ({ id: `fact-${index}`, name: expected.label,
    value: String(expected.value), unit: unitFor(expected.unitPattern), clinicalDate: expected.date }));
  return {
    personId: 'synthetic-person', processIssues: [], facts,
    snapshot: { personId: 'synthetic-person',
      overview: { id: 'overview', headline: '本次值得关注的变化', summary: clinicalText, claimIds: ['claim'], actionIds: ['action'], limitations: [] },
      systems: [{ id: 'system', systemId, status: 'monitor', headline: caseId === 'child-vision' ? '双眼视力需要进一步检查' : '血压或血脂的变化',
        summary: clinicalText, claimIds: ['claim'], actionIds: ['action'], limitations: [] }],
      claims: [{ id: 'claim', kind: 'source_fact', topicKey: 'primary', text: clinicalText, rationale: clinicalText,
        materialUncertainty: null, evidenceIds: facts.map((fact) => fact.id) }],
      actions: [{ id: 'action', title: caseId === 'child-vision' ? '安排眼科检查' : '具体下一步', why: clinicalText, firstStep: nextStep,
        caution: null, timing: '近期安排', reviewPlan: null, claimIds: ['claim'], evidenceIds: facts.map((fact) => fact.id) }], questions: [] },
    readModels: { overview: { personId: 'synthetic-person', headline: '本次值得关注的变化', overview: clinicalText,
      priorityIssues: [{ id: 'claim', title: '检查结果的变化', explanation: clinicalText, nextStep }] },
      bodyDetails: facts, eventDetails: facts.map((fact) => ({
        type: caseId === 'child-vision' ? 'other' : 'laboratory',
        time: { value: fact.clinicalDate, endValue: null, precision: 'day', role: 'exam', source: 'explicit', displayLabel: fact.clinicalDate },
        systemIds: [systemId], findings: [{ id: fact.id, label: fact.name, value: `${fact.value} ${fact.unit ?? ''}`.trim(),
          time: { value: fact.clinicalDate, endValue: null, precision: 'day', role: 'exam', source: 'explicit', displayLabel: fact.clinicalDate },
          abnormalFlag: 'unknown' }]
      })), lifestyle: { personId: 'synthetic-person', adoptedActions: scenario.existingPlan
        ? [{ title: scenario.existingPlan.title, selectedStartingOption: scenario.existingPlan.detail, status: 'active' }] : [] } }
  };
}

const failures = (caseId: SyntheticFamilyCaseId, input: Parameters<typeof syntheticFamilyContentChecks>[1]) =>
  syntheticFamilyContentChecks(caseId, input).filter((check) => !check.passed).map((check) => check.id);

describe('纯合成完整链证据', () => {
  it('新生活指南必须覆盖五域并区分通用与个性化，旧验收不因缺领域失败', () => {
    const input = familyPresentation('adult-recent-change');
    expect(failures('adult-recent-change', input)).toEqual([]);
    input.requireDailyLife = true;
    expect(failures('adult-recent-change', input)).toEqual(expect.arrayContaining(['daily-life:diet', 'daily-life:sleep']));
    for (const domain of ['diet', 'activity', 'sleep', 'supplements', 'daily_routine'] as const) {
      input.snapshot.actions.push({ id: `daily-${domain}`, title: `日常建议-${domain}`,
        why: '这是说明一般生活习惯的低风险建议，不假定个人缺乏或已有疾病。',
        firstStep: '先观察并记录现有生活习惯，选择一项能持续做的小调整。',
        timing: null, reviewPlan: null, caution: null, claimIds: [], evidenceIds: [],
        lifestyleDomain: domain, lifestyleBasis: 'general' });
    }
    expect(failures('adult-recent-change', input)).toEqual([]);
    input.snapshot.actions.at(-1)!.evidenceIds = ['fact-0'];
    expect(failures('adult-recent-change', input)).toContain('daily-life-general-separated');
  });

  it.each(['child-vision', 'older-bp-kidney', 'adult-recent-change'] as const)('%s 固定文本与背景指纹不漂移，最低内容断言有独立正例', (caseId) => {
    const scenario = syntheticFamilyScenarios[caseId];
    expect(createHash('sha256').update(readFileSync(join(process.cwd(), 'packages/evaluation/fixtures', scenario.filename))).digest('hex'))
      .toBe(scenario.sha256);
    expect(syntheticFamilyInputHash(caseId)).toMatch(/^[a-f0-9]{64}$/);
    expect(syntheticFamilyInputHash(caseId)).toBe(syntheticFamilyInputHash(caseId));
    expect(failures(caseId, familyPresentation(caseId))).toEqual([]);
  });

  it('数值、左右侧、日期和单位必须绑定同一个事实，展示也不能漏掉已接纳数值', () => {
    const child = familyPresentation('child-vision');
    child.facts[0]!.clinicalDate = '2026-09-13';
    child.facts[1]!.name = '右眼视力';
    child.facts[2]!.unit = 'mm';
    expect(failures('child-vision', child)).toEqual(expect.arrayContaining([
      'fact:右眼裸眼视力', 'fact:左眼裸眼视力', 'fact:右眼球镜'
    ]));
    const hidden = familyPresentation('adult-recent-change');
    hidden.readModels.bodyDetails = [];
    hidden.readModels.eventDetails = [];
    expect(failures('adult-recent-change', hidden)).toContain('display:近期LDL');
    const elder = familyPresentation('older-bp-kidney');
    elder.facts.find((fact) => fact.name === '2026-03-12收缩压')!.value = '148';
    expect(failures('older-bp-kidney', elder)).toContain('fact:2026-03-12收缩压');
  });

  it('身体页有日期也不能掩盖检查详情混用日期，眼科设备词不能归神经', () => {
    const adult = familyPresentation('adult-recent-change');
    adult.readModels.eventDetails[1]!.findings[0]!.time.value = '2026-07-20';
    expect(failures('adult-recent-change', adult)).toContain('event-date:近期LDL');
    expect(failures('adult-recent-change', adult)).not.toContain('display:近期LDL');
    const child = familyPresentation('child-vision');
    child.readModels.eventDetails[2]!.systemIds.push('neurological');
    expect(failures('child-vision', child)).toContain('eye-examination-system');
  });

  it('眼科系统正确也不能掩盖把视力或验光误标成实验室检验', () => {
    const child = familyPresentation('child-vision');
    child.readModels.eventDetails[0]!.type = 'laboratory';
    expect(failures('child-vision', child)).toContain('eye-examination-system');
  });

  it('仅已发布或无过程词不能替代有内容的总览、系统解释和可执行下一步', () => {
    const input = familyPresentation('adult-recent-change');
    input.readModels.overview.overview = '已经处理完成。';
    input.snapshot.systems[0]!.headline = '部分判断仍需核实';
    input.snapshot.systems[0]!.summary = '已有资料可查看。';
    input.snapshot.actions[0]!.firstStep = '注意健康。';
    expect(failures('adult-recent-change', input)).toEqual(expect.arrayContaining([
      'topic-in-result-not-process', 'concrete-linked-next-step', 'answered-background-used'
    ]));
    const unlinked = familyPresentation('child-vision');
    unlinked.snapshot.overview.actionIds = [];
    unlinked.snapshot.systems[0]!.actionIds = [];
    expect(failures('child-vision', unlinked)).toContain('concrete-linked-next-step');
  });

  it('原报告的关键就诊或记录安排不能被生活建议代替，也不能只留在候选数组', () => {
    const child = familyPresentation('child-vision');
    child.snapshot.actions[0]!.firstStep = '由家长与老师沟通，安排在能看清黑板的位置，改善视力困难对学习的影响。';
    expect(failures('child-vision', child)).toContain('reported-eye-care-action-visible');
    const older = familyPresentation('older-bp-kidney');
    older.snapshot.actions[0]!.firstStep = '带上肾功能结果复诊；继续已有坐位活动，出现膝部疼痛就停下。';
    expect(failures('older-bp-kidney', older)).toContain('reported-bp-recording-action-visible');
    const hidden = familyPresentation('child-vision');
    hidden.snapshot.overview.actionIds = [];
    hidden.snapshot.systems[0]!.actionIds = [];
    expect(failures('child-vision', hidden)).toContain('reported-eye-care-action-visible');
  });

  it('未散瞳条件不能只藏在来源或静态输入里，已有家长回答不能重复询问', () => {
    const input = familyPresentation('child-vision');
    const removeCondition = (text: string) => text.replace(/未散瞳/g, '检查');
    input.readModels.overview.overview = removeCondition(input.readModels.overview.overview);
    input.snapshot.systems[0]!.summary = removeCondition(input.snapshot.systems[0]!.summary);
    input.snapshot.claims[0]!.text = removeCondition(input.snapshot.claims[0]!.text);
    input.snapshot.claims[0]!.rationale = removeCondition(input.snapshot.claims[0]!.rationale);
    input.snapshot.actions[0]!.why = removeCondition(input.snapshot.actions[0]!.why);
    input.snapshot.actions[0]!.firstStep = removeCondition(input.snapshot.actions[0]!.firstStep);
    input.snapshot.questions = [{ question: '这次是否散瞳？孩子有没有戴眼镜？' }];
    expect(failures('child-vision', input)).toEqual(expect.arrayContaining([
      'non-cycloplegic-limitation-visible', 'known-child-answers-not-reasked'
    ]));
  });

  it.each([
    '9月12日之后是否已完成眼科检查或散瞳验光？',
    '2026-09-12检查之后有没有接受散瞳验光？',
    '2026年9月12日之后是否已预约散瞳验光？',
    '是否需要安排散瞳验光？'
  ])('原检查之后的新检查完成或安排状态不是重复已知回答：%s', (question) => {
    const child = familyPresentation('child-vision');
    child.snapshot.questions = [{ question }];
    expect(failures('child-vision', child)).toEqual([]);
  });

  it.each([
    '9月12日这次验光是否散瞳？',
    '本次散瞳了？',
    '9月12日之后是否散瞳？',
    '9月12日以后是否散瞳？',
    '9月12日之后是否已完成眼科检查或散瞳验光？本次是否散瞳？',
    '9月12日之后是否已完成眼科检查或散瞳验光，本次是否散瞳？',
    '9月12日之后是否已完成眼科检查或散瞳验光并请确认本次是否散瞳？',
    '9月12日之后是否已完成眼科检查或散瞳验光以及孩子有没有戴眼镜？',
    '孩子有没有戴眼镜，之后再去眼科？',
    '孩子有没有戴眼镜并准备下次眼科就诊？',
    '准备下次眼科就诊前，请确认原检查有没有散瞳？'
  ])('后续时间词或安排不能掩盖对原检查和已有眼镜情况的重复询问：%s', (question) => {
    const child = familyPresentation('child-vision');
    child.snapshot.questions = [{ question }];
    expect(failures('child-vision', child)).toContain('known-child-answers-not-reasked');
  });

  it('长辈已有计划不能覆盖、丢失或按从未开始重新推荐，膝部限制必须进入行动', () => {
    const input = familyPresentation('older-bp-kidney');
    input.readModels.lifestyle.adoptedActions[0]!.selectedStartingOption = '每天跑步30分钟';
    input.snapshot.actions[0]!.firstStep = '记录血压，开始每天跑步30分钟。';
    expect(failures('older-bp-kidney', input)).toEqual(expect.arrayContaining([
      'knee-limited-action', 'existing-plan-preserved', 'existing-plan-acknowledged'
    ]));
  });

  it.each([
    '在白天常活动的位置放好水杯，按口渴和日常需要分次喝水。',
    '睡前避免剧烈运动，夜间起身时先坐稳再站起，并保持通道照明。',
    '不跑步或长距离快走，睡前留一段安静时间。'
  ])('饮水位置和运动限制不是新增运动负荷：%s', (firstStep) => {
    const input = familyPresentation('older-bp-kidney');
    input.snapshot.actions.push({ ...input.snapshot.actions[0]!, id: 'routine', title: '日常安排',
      why: '规律的生活安排便于维持进食和休息，不假定本人已有睡眠问题。',
      firstStep, lifestyleDomain: 'daily_routine', lifestyleBasis: 'general', claimIds: [], evidenceIds: [] });
    input.snapshot.overview.actionIds.push('routine');
    expect(failures('older-bp-kidney', input)).toEqual([]);
  });

  it.each([
    { firstStep: '开始每天跑步30分钟。', lifestyleDomain: undefined },
    { firstStep: '开始每天跑步30分钟。', lifestyleDomain: 'daily_routine' as const },
    { firstStep: '每天做长距离快走40分钟。', lifestyleDomain: 'daily_routine' as const },
    { firstStep: '不要跑步，但每天做长距离快走40分钟。', lifestyleDomain: 'daily_routine' as const }
  ])('旧建议或错标日常领域仍不能隐藏不适配的运动：$firstStep / $lifestyleDomain', ({ firstStep, lifestyleDomain }) => {
    const input = familyPresentation('older-bp-kidney');
    input.snapshot.actions.push({ ...input.snapshot.actions[0]!, id: 'unsafe-movement', title: '新增安排',
      why: '希望通过增加日常运动时间改善身体状态。', firstStep, caution: null, lifestyleDomain });
    input.snapshot.overview.actionIds.push('unsafe-movement');
    expect(failures('older-bp-kidney', input)).toContain('knee-limited-action');
  });

  it('活动元数据即使没有运动关键词也必须核对个人限制', () => {
    const input = familyPresentation('older-bp-kidney');
    input.snapshot.actions.push({ ...input.snapshot.actions[0]!, id: 'movement', title: '新的安排',
      why: '按新的安排增加每日练习时间，不说明本人已经提供的限制。',
      firstStep: '本周先每天增加十分钟，并在一周后回看是否容易坚持。', caution: null, lifestyleDomain: 'activity' });
    input.snapshot.overview.actionIds.push('movement');
    expect(failures('older-bp-kidney', input)).toContain('knee-limited-action');
  });

  it('正文承认并保留适配的既有计划时，不强制重复生成运动行动', () => {
    const input = familyPresentation('older-bp-kidney');
    input.snapshot.actions[0]!.firstStep = '记录家庭血压，复诊时一并查看血压和肾功能结果。';
    input.snapshot.claims[0]!.text += '本人有膝痛和步行受限，继续已有的坐位舒缓活动，膝痛就停止。';
    expect(failures('older-bp-kidney', input)).toEqual([]);
    input.readModels.lifestyle.adoptedActions = [];
    expect(failures('older-bp-kidney', input)).toContain('knee-limited-action');
  });

  it('近期单项变化不能变成同主题重复重点，也不能再次询问已知的生活背景', () => {
    const input = familyPresentation('adult-recent-change');
    input.snapshot.claims.push({ ...input.snapshot.claims[0]!, id: 'claim-again', kind: 'interpretation' });
    input.readModels.overview.priorityIssues.push({ ...input.readModels.overview.priorityIssues[0]!, id: 'claim-again' });
    input.snapshot.questions = [{ question: '你是否吸烟或正在使用调脂药，近期饮食有什么变化？' }];
    expect(failures('adult-recent-change', input)).toEqual(expect.arrayContaining([
      'recent-change-prioritized', 'known-adult-answers-not-reasked'
    ]));
  });

  it('允许合法的保留条件和新问题，跨成员投影与过程正文仍会失败', () => {
    const input = familyPresentation('adult-recent-change');
    input.snapshot.claims[0]!.materialUncertainty = '单次变化不能独立确诊，个人目标还需结合其他风险因素。';
    input.snapshot.questions = [{ question: '家族中是否有早发心血管病史？' }, { question: '是否有降脂药过敏史？' }];
    expect(failures('adult-recent-change', input)).toEqual([]);
    const child = familyPresentation('child-vision');
    child.snapshot.questions = [{ question: '下次是否已预约散瞳验光？' }];
    expect(failures('child-vision', child)).toEqual([]);
    input.readModels.overview.personId = 'another-member';
    input.processIssues = ['overview:包含模型复核过程'];
    expect(failures('adult-recent-change', input)).toEqual(expect.arrayContaining(['member-isolation', 'no-process-narrative']));
  });

  it('自动全过也仍生成未人工评审的完整正文材料，不声明临床或视觉验收', () => {
    const input = familyPresentation('child-vision');
    const checks = syntheticFamilyContentChecks('child-vision', input);
    const document = syntheticFamilyReviewDocument('child-vision', checks, input.snapshot, input.readModels);
    expect(checks.every((check) => check.passed)).toBe(true);
    expect(document).toContain('人工内容评审：NOT_REVIEWED');
    expect(document).toContain('未散瞳');
    expect(document).toContain('0.6');
    expect(document).toContain('截图及交互是否可用：待验证');
    expect(document).toContain(input.snapshot.actions[0]!.firstStep);
  });

  it('虚构当日胸痛终态必须保留当前症状、急救行动与首屏入口，只有发布状态不足以通过', () => {
    const snapshot = {
      evidenceCatalog: [{ id: 'note', kind: 'user_note', locator: '2026-09-22', quote: '本人今天自述持续胸痛并伴出汗。' }],
      claims: [{ id: 'symptoms', kind: 'source_fact', temporalStatus: 'current', text: '本人今天持续胸痛并伴出汗。', evidenceIds: ['note'] }],
      actions: [{ id: 'emergency', kind: 'seek_care', urgency: 'emergency', evidenceIds: ['note'] }],
      overview: { claimIds: ['symptoms'], actionIds: ['emergency'] },
      systems: [{ systemId: 'cardiovascular', claimIds: ['symptoms'], actionIds: ['emergency'] }]
    };
    expect(Object.values(syntheticCurrentSymptomPresentationChecks(snapshot, '2026-09-22'))).toEqual([true, true, true, true]);
    expect(syntheticCurrentSymptomPresentationChecks({ ...snapshot, claims: [], actions: [] }, '2026-09-22'))
      .toEqual({ currentSymptomFactVisible: false, emergencyActionVisible: false,
        overviewPrioritizesCurrentSymptoms: false, cardiovascularPrioritizesCurrentSymptoms: false });
    expect(syntheticCurrentSymptomPresentationChecks({ ...snapshot, claims: snapshot.claims.map((claim) =>
      ({ ...claim, temporalStatus: 'historical' })) }, '2026-09-22').currentSymptomFactVisible).toBe(false);
    expect(syntheticCurrentSymptomPresentationChecks({ ...snapshot, overview: { claimIds: [], actionIds: [] } }, '2026-09-22')
      .overviewPrioritizesCurrentSymptoms).toBe(false);
  });

  it('区分正式综合、条件补齐、定向修复与重点复核', () => {
    expect(syntheticTurnStage('P01', '\nSOURCE_PACKAGE={}')).toBe('P01');
    expect(syntheticTurnStage('P02', '\nASSESSMENT_REQUEST={}')).toBe('P02');
    expect(syntheticTurnStage('P02', '\nCLINICAL_CONTEXT_INPUT={}')).toBe('prepare_clinical_context');
    expect(syntheticTurnStage('P01', '\nREPAIR_REQUEST={}')).toBe('P01_P03');
    expect(syntheticTurnStage('P02', '\nREPAIR_REQUEST={}')).toBe('P02_P03');
    expect(syntheticTurnStage('P02', '\nREVIEW_REQUEST={}')).toBe('P04');
  });

  it('源码指纹确定且能识别未提交代码变动，不读取数据目录或测试内容', () => {
    const root = mkdtempSync(join(tmpdir(), 'fhd-synthetic-source-test-'));
    try {
      for (const path of ['apps/desktop/src/main', 'apps/desktop/src/renderer/src',
        'packages/contracts/src', 'packages/health-core/src', 'packages/storage/src',
        'packages/ingestion/src', 'packages/codex-adapter/src', 'packages/workflow/src', 'scripts', 'data']) {
        mkdirSync(join(root, path), { recursive: true });
      }
      const source = join(root, 'apps/desktop/src/main/example.ts');
      writeFileSync(source, 'export const value = 1;');
      writeFileSync(join(root, 'scripts/run-lean-v3-full-chain-synthetic.ts'), '// script');
      writeFileSync(join(root, 'scripts/synthetic-chain-evidence.ts'), '// helper');
      writeFileSync(join(root, 'scripts/synthetic-family-scenarios.ts'), '// family cases');
      writeFileSync(join(root, 'data/private-report.txt'), 'not part of source fingerprint');
      writeFileSync(join(root, 'apps/desktop/src/main/example.test.ts'), '// excluded test');
      const first = syntheticSourceFingerprint(root);
      expect(first.fileCount).toBe(4);
      expect(syntheticSourceFingerprint(root)).toEqual(first);
      writeFileSync(source, 'export const value = 2;');
      expect(syntheticSourceFingerprint(root).sha256).not.toBe(first.sha256);
    } finally {
      // 仅清理该用例创建的明确临时目录，不触碰仓库或用户资料。
      rmSync(root, { recursive: true, force: true });
    }
  });
});
