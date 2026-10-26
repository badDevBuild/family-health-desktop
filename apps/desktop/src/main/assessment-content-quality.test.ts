import { describe, expect, it } from 'vitest';
import type { MemberAssessmentCandidateV3 } from '@contracts';
import { containsEditorialInstruction, containsProcessNarrative, memberAssessmentCandidateV3Schema, presentAssessmentText } from '@contracts';
import { findProcessNarrativeIssues } from './assessment-content-quality.js';

function candidate(): MemberAssessmentCandidateV3 {
  return {
    schemaVersion: 3, personId: 'synthetic-person', inputSignature: 'a'.repeat(64), mode: 'full',
    requestedSystemIds: ['cardiovascular'],
    overview: { id: 'overview', headline: '这次血脂结果值得留意',
      summary: '低密度脂蛋白负责运送胆固醇；这次结果高于报告范围，先整理既往结果供就诊讨论。',
      claimIds: ['claim:lipids'], actionIds: ['action:followup'], limitations: ['只有一次结果，不能说明长期变化。'] },
    systems: [{ id: 'system:cardiovascular', systemId: 'cardiovascular', status: 'attention',
      headline: '低密度脂蛋白高于报告范围', summary: '这是血液中运送胆固醇的一类颗粒；这次结果值得结合其他资料看。',
      claimIds: ['claim:lipids'], actionIds: ['action:followup'], limitations: [] }],
    claims: [{ id: 'claim:lipids', topicKey: 'lipids', systemIds: ['cardiovascular'], kind: 'interpretation',
      text: '2026-09-21 LDL-C 4.2 mmol/L，高于这份报告的参考上限3.4。',
      diseaseName: null, diagnosticStatus: null, temporalStatus: 'current', evidenceIds: ['source-1'],
      counterEvidenceIds: [], trendIds: [], knowledgeBasis: 'model_general', knowledgeSourceIds: [],
      criteriaBasis: null, rationale: '报告提供了结果和参考范围。',
      materialUncertainty: '只有一次结果，尚不能说明目前是否持续偏高。', consequenceLevel: 'routine' }],
    actions: [{ id: 'action:followup', dedupeKey: 'lipid-followup', systemIds: ['cardiovascular'],
      claimIds: ['claim:lipids'], kind: 'test_followup', title: '整理既往结果', why: '看看这是否是持续的变化。',
      firstStep: '带上既往血脂报告，与医生讨论复查安排。', timing: '下次就诊时', timingBasis: 'none',
      reviewPlan: '获得新结果后与医生讨论。', caution: '不要自行停药。', urgency: 'routine',
      evidenceIds: ['source-1'], knowledgeSourceIds: [] }],
    questions: [{ id: 'question:fasting', question: '采血前是否空腹？',
      whyItMatters: '采血条件会影响部分血脂指标的理解。', relatedClaimIds: ['claim:lipids'], evidenceIds: ['source-1'] }],
    knowledgeSources: []
  };
}

describe('家庭健康正文与工程过程分离', () => {
  it('医学知识的外部 PDF 链接不把主张及独立行动误标成处理过程', () => {
    const value = candidate();
    const reference = '[医学知识说明](https://guidelines.example.org/downloads/pdfs/clinical-guide.pdf)';
    value.claims[0]!.text += `相关解释可参考${reference}，仍需结合个人情况理解。`;
    value.actions[0]!.why = `相关背景见${reference}，复诊时结合已有结果讨论。`;
    const before = structuredClone(value);
    expect(findProcessNarrativeIssues(value)).toEqual([]);
    expect(presentAssessmentText(value.claims[0]!.text)).toEqual({
      text: value.claims[0]!.text, changed: false, processOnly: false
    });
    // 这里只检查工程口吻，不授予知识来源可信度，也不改候选事实和行动。
    expect(value).toEqual(before);
  });

  it('外部 PDF 链接不能遮蔽同字段的真实工程口吻和裸原件文件名', () => {
    const value = candidate();
    value.claims[0]!.text = '参考[指南](https://guidelines.example.org/clinical-guide.pdf)，模型复核已通过。';
    value.actions[0]!.why = '参考[指南](https://guidelines.example.org/clinical-guide.pdf)，原结果在本人体检报告.pdf。';
    expect(findProcessNarrativeIssues(value)).toEqual([
      'process_narrative:claim:lipids:text', 'process_narrative:action:followup:why'
    ]);
  });

  it.each([
    '现有资料没有提供既往确诊记录及用药情况，不能把这些读数写成新的高血压确诊。',
    '不应将单次验光描述为近视已经确诊。',
    '不要把缺项表述成检查正常。',
    '应将这段结果改写为尚不能确定。',
    '这里应写为有待进一步确认。'
  ])('新生成正文中的编辑口吻交局部修复，不改写旧快照临床边界：%s', (text) => {
    const value = candidate();
    value.claims[0]!.text = text;
    expect(containsEditorialInstruction(text)).toBe(true);
    expect(findProcessNarrativeIssues(value)).toContain('process_narrative:claim:lipids:text');
    expect(presentAssessmentText(text)).toEqual({ text, changed: false, processOnly: false });
    expect(value.claims[0]!.text).toBe(text);
  });

  it.each([
    '这些血压读数尚不能确认是否持续偏高，需要结合规范复测和诊疗背景。',
    '没有散瞳，暂不能把这些数值当作真实近视度数或配镜处方。',
    '单次结果不能据此确定诊断，也不能排除其他原因。',
    '原报告写为“考虑甲状腺炎”，并非已经确诊。',
    '请把家庭测量结果写在记录本上，带去复诊。',
    '请把胸痛发作经过写成简短记录，交给急诊医生，不要为记录延误就医。',
    '建议将平时的症状写成就医提纲，带去给接诊医生看。',
    '请把家庭测量结果写成一份记录，复诊时交给医生。',
    '不要把仅仅猜测的诊断写成病情记录，先向医生说明实际症状。',
    '不能把药量改为自行决定的剂量。',
    '需要将以往报告交给接诊医生。'
  ])('临床限制、来源转述及实际记录行动不是编辑口吻：%s', (text) => {
    expect(containsEditorialInstruction(text)).toBe(false);
    const value = candidate();
    value.claims[0]!.text = text;
    expect(findProcessNarrativeIssues(value)).toEqual([]);
    expect(presentAssessmentText(text)).toEqual({ text, changed: false, processOnly: false });
  });

  it('编辑指令在标题、限制、理由及行动中均精确定位，不只检查主正文', () => {
    const value = candidate();
    const text = '不应将这些结果写成确诊。';
    value.overview.headline = text;
    value.systems[0]!.limitations = [text];
    value.claims[0]!.materialUncertainty = text;
    value.actions[0]!.caution = text;
    value.questions[0]!.whyItMatters = text;
    expect(findProcessNarrativeIssues(value)).toEqual([
      'process_narrative:overview:headline', 'process_narrative:system:cardiovascular:limitations[0]',
      'process_narrative:claim:lipids:materialUncertainty', 'process_narrative:action:followup:caution',
      'process_narrative:question:fasting:whyItMatters'
    ]);
  });
  it('模型候选不允许顶层 limitations 绕过节点门禁，无需扩展候选协议', () => {
    const result = memberAssessmentCandidateV3Schema.safeParse({ ...candidate(), limitations: ['P04 已通过。'] });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues).toContainEqual(expect.objectContaining({ code: 'unrecognized_keys', keys: ['limitations'] }));
    expect(memberAssessmentCandidateV3Schema.safeParse(candidate()).success).toBe(true);
  });
  it('独立短标题也进入过程文字门禁，不能用新字段绕过正文检查', () => {
    const value = candidate();
    value.claims[0]!.title = '模型复核已通过';
    expect(findProcessNarrativeIssues(value)).toContain('process_narrative:claim:lipids:title');
  });
  it.each([
    '成员3fa85f64-5717-4562-b3fc-2c963f66afa6的TSH为2.1 mIU/L。',
    '2022-体检.pdf记录TSH 2.1 mIU/L。',
    'D:/家庭资料/2022-体检.pdf记录TSH 2.1 mIU/L。',
    '/Volumes/家庭资料/2022-体检.pdf记录TSH 2.1 mIU/L。',
    'TSH 2.1 mIU/L，来源是甲功报告.PNG。'
  ])('内部定位信息不能作为健康正文发布：%s', (text) => {
    expect(containsProcessNarrative(text)).toBe(true);
    // 无法精确分开的临床句仍保留原文交给局部修复，不能删除数值后冒充通过。
    const value = candidate();
    value.claims[0]!.text = text;
    expect(findProcessNarrativeIssues(value)).toContain('process_narrative:claim:lipids:text');
  });

  it('去除独立 UUID 括注不改变检查数值、日期和临床限制', () => {
    const text = '2022-06-11 TSH 2.1 mIU/L（3fa85f64-5717-4562-b3fc-2c963f66afa6），不代表今天的甲状腺功能。';
    expect(presentAssessmentText(text).text).toBe('2022-06-11 TSH 2.1 mIU/L，不代表今天的甲状腺功能。');
    expect(containsProcessNarrative('2022-06-11 TSH 2.1 mIU/L，不能说明整体甲状腺功能正常。')).toBe(false);
  });

  it.each([
    ['老人', '膝部不适时，从可承受的短距离步行开始，若不适加重就停止并咨询医生。'],
    ['儿童', '儿童血压的理解还需要年龄、身高和规范复测，不能直接套成人范围。'],
    ['孕期', '孕周未提供，不能直接按非孕期范围理解这次促甲状腺激素结果。'],
    ['无资料', '目前没有相关检查资料，无法据此说明这个系统的状况。'],
    ['单次', '只有2025年一次结果，尚不能说明现在是否持续偏高。'],
    ['历史', '2022年报告记载“诊断为脂肪肝”；这不是今天新取得的诊断。'],
    ['局部缺口', '血液检查有清晰结果，但缺少甲状腺超声结论，不能说这部分检查整体正常。'],
    ['正常', '空腹血糖5.2 mmol/L处于这份报告的参考范围，但不能说明所有代谢检查都正常。'],
    ['特殊临床条件', '本次未散瞳，不能仅凭这次验光确认近视程度；两次检测方法不同，不直接比较。'],
    ['临床复核', '医生复核报告后安排复查；目前用药未提供，就诊时带上药盒。'],
    ['检测不可比', '检测条件不同，暂不能直接比较。'],
    ['临床时间缺口', '没有记录最近一次复查时间。'],
    ['原始记录日期限制', '2025年另有122/76 mmHg记录但临床日期未确认。'],
    ['临床括注', '本次未散瞳（医生复核：尚不能确认近视程度），应结合后续检查理解。'],
    ['身体系统', '神经系统的检查仍需结合症状和医生查体；本地医生可以协助复核结果。'],
    ['生理系统资料缺口', '内分泌系统仍需结合TSH、游离T4和症状理解，甲状腺超声完整结果尚未确认。'],
    ['生理系统正常范围', '空腹血糖5.2 mmol/L处于该次报告范围，不能据此确认内分泌系统整体正常。'],
    ['影像与历史限制', '2025年肝胆脾胰彩超未确认，升高是否持续及病因未知；不能将当时结果直接当作今天的状态。'],
    ['小结医学内容', '报告小结记载肝胆声像图未见明显异常，仍需结合症状和其他检查分析病因。'],
    ['系统性疾病', '系统性红斑狼疮的病情仍需综合判断。'],
    ['系统性疾病评估', '系统性硬化症可由医生结合症状和检查判断。'],
    ['系统治疗', '系统治疗后仍需结合症状和医生检查判断。'],
    ['药物应用', '应用药物后的变化需要医生结合复查判断。'],
    ['临床图像比较', '医生结合原图复核肺部结节，建议按原报告安排复查。'],
    ['临床原因仍待判断', '仍需综合判断血糖变化的原因。']
  ])('%s的临床解释与限制完整保留', (_label, text) => {
    expect(containsProcessNarrative(text)).toBe(false);
    expect(presentAssessmentText(text)).toEqual({ text, changed: false, processOnly: false });
  });

  it.each([
    ['经模型核对，LDL-C 4.2 mmol/L，高于参考上限3.4。', 'LDL-C 4.2 mmol/L，高于参考上限3.4。'],
    ['模型判断：只有一次TSH结果，不能说明今天的甲状腺功能。', '只有一次TSH结果，不能说明今天的甲状腺功能。'],
    ['P04复核尚未完成，检查未散瞳，不能据此确认近视。', '检查未散瞳，不能据此确认近视。'],
    ['已接纳的空腹血糖 5.2 mmol/L，仍不能说明长期血糖水平。', '空腹血糖 5.2 mmol/L，仍不能说明长期血糖水平。'],
    ['采用输入的体重指数趋势事实显示BMI由26.1升至27.4，不能单凭体重确定病因。', 'BMI由26.1升至27.4，不能单凭体重确定病因。'],
    ['LDL-C 4.2 mmol/L（P04复核已通过），但只有一次结果，不能说明当前是否持续偏高。', 'LDL-C 4.2 mmol/L，但只有一次结果，不能说明当前是否持续偏高。'],
    ['本次未散瞳（P04复核：已通过），不能据此确认近视程度。', '本次未散瞳，不能据此确认近视程度。'],
    ['LDL-C 4.2 mmol/L（P04重点复核：通过），只有一次结果，不能说明长期变化。', 'LDL-C 4.2 mmol/L，只有一次结果，不能说明长期变化。'],
    ['本次验光（P04复核：通过；未散瞳），不能据此确认近视程度。', '本次验光（未散瞳），不能据此确认近视程度。'],
    ['本次验光（未散瞳；P04重点复核：通过），不能据此确认近视程度。', '本次验光（未散瞳），不能据此确认近视程度。'],
    ['P04复核：本次未散瞳，不能据此确认近视程度。', '本次未散瞳，不能据此确认近视程度。'],
    ['本次未散瞳（P04复核：未散瞳），不能据此确认近视程度。', '本次未散瞳（未散瞳），不能据此确认近视程度。'],
    ['P04尚未完成，空腹血糖5.2 mmol/L，不代表长期血糖正常。', '空腹血糖5.2 mmol/L，不代表长期血糖正常。'],
    ['P04尚未完成，只有一次结果，这不意味着血糖一直正常。', '只有一次结果，这不意味着血糖一直正常。'],
    ['P04尚未完成，不代表身体整体正常。', '不代表身体整体正常。'],
    ['验光为-1.25 D（observation:eye-1），本次未散瞳，不能据此确认近视程度。', '验光为-1.25 D，本次未散瞳，不能据此确认近视程度。'],
    ['部分健康判断仍需核实。2025年的血脂结果高于报告范围，不能代表今天。', '2025年的血脂结果高于报告范围，不能代表今天。'],
    ['临床资料显示尚无明确原因；本地校验通过。未记录空腹条件。', '临床资料显示尚无明确原因；未记录空腹条件。'],
    ['有日期的测量值未显示持续升高，未给无日期记录补时间。', '有日期的测量值未显示持续升高'],
    ['2025年另有122/76 mmHg记录但临床日期未确认，未给无日期记录补时间。', '2025年另有122/76 mmHg记录但临床日期未确认'],
    ['已逐页核对原图，纠正了此前的识别错误。LDL-C 4.2 mmol/L，高于参考上限3.4。', 'LDL-C 4.2 mmol/L，高于参考上限3.4。'],
    ['此前把左眼结果识别成右眼，现已更正。左眼矫正视力5.0；未记录是否戴镜。', '左眼矫正视力5.0；未记录是否戴镜。'],
    ['证据已经验证完整，本轮检查全部通过。血糖5.2 mmol/L处于本次报告范围，但只有一次结果。', '血糖5.2 mmol/L处于本次报告范围，但只有一次结果。'],
    ['系统正在校验。系统性红斑狼疮的病情仍需综合判断。', '系统性红斑狼疮的病情仍需综合判断。']
  ])('删除工程片段但保留同一句里的健康内容：%s', (original, text) => {
    expect(containsProcessNarrative(original)).toBe(true);
    expect(presentAssessmentText(original)).toEqual({ text, changed: true, processOnly: false });
    expect(presentAssessmentText(text)).toEqual({ text, changed: false, processOnly: false });
  });

  it('真实总览中的完整工程分句被精确移除，原有影像、日期、数值和病因限制保留', () => {
    const clinical = '2025年肝胆脾胰彩超未确认，升高是否持续及病因未知。最近一次有明确日期的报告截至2025年12月；不能将当时结果直接当作今天的状态。2025年肝胆脾胰彩超、甲状腺彩超的完整结果及部分体检项目尚未确认；';
    const finding = '最近一次ALT和AST均超出报告参考范围，较早记录未见同样升高。';
    const original = `${clinical}小结仍可用于分析。部分已保存事实尚未归入系统视图，总览已纳入其中可确定的重要内容。${finding}`;
    const expected = `${clinical}${finding}`;
    expect(containsProcessNarrative(original)).toBe(true);
    expect(presentAssessmentText(original)).toEqual({ text: expected, changed: true, processOnly: false });
    expect(presentAssessmentText(expected)).toEqual({ text: expected, changed: false, processOnly: false });
    const value = candidate();
    value.overview.summary = original;
    expect(findProcessNarrativeIssues(value)).toEqual(['process_narrative:overview:summary']);
  });

  it.each([
    '小结仍可用于分析。',
    '报告小结还可以用于本次解读。',
    '部分已保存事实尚未归入系统视图。',
    '部分已保存的报告事实尚未纳入系统视图。',
    '其他已接纳的事实暂未归入身体系统视图。',
    '总览已纳入其中可确定的重要内容。',
    '总览已纳入其中可确认的重要内容。',
    '当前健康总览已经归入可以确认的内容。'
  ])('精确的软件视图分句不能作为健康结果发布：%s', (text) => {
    expect(containsProcessNarrative(text)).toBe(true);
    expect(presentAssessmentText(text)).toEqual({ text: '', changed: true, processOnly: true });
  });

  it.each([
    'P04 已通过，本地校验问题为0。',
    '部分判断因证据不足暂未发布。',
    '尚未按新规则复核。',
    'inputSignature=abc；system:cardiovascular；model_cited。',
    '该主张已经通过验证。',
    '模型仍无法判断符号含义。',
    '采用输入的体重指数趋势事实。',
    '已接纳的事实进入新流程。',
    '独立复核未完成。',
    '模型证据匹配未完成。',
    '尚未发布。',
    '词典中没有精确映射。',
    '名称精确匹配。',
    '未给无日期记录补时间。',
    '已接纳的报告事实和其他行动仍可查看；部分判断因证据不足暂未发布。',
    '已逐页核对原图，纠正了此前的识别错误。',
    '此前把左眼结果识别成右眼，现已更正。',
    '证据已经验证完整，本轮检查全部通过。',
    '经模型核对。'
  ])('纯处理句变为空值且不会伪造健康正常：%s', (text) => {
    expect(presentAssessmentText(text)).toEqual({ text: '', changed: true, processOnly: true });
  });

  it('空字符串保持空值，不把它变成正常或完成', () => {
    expect(presentAssessmentText('')).toEqual({ text: '', changed: false, processOnly: false });
  });

  it('计算来源不属于健康正文，移除标签时保留差值和可比条件', () => {
    const text = '程序提供的前后差值为增加1.1 mmol/L。两次检测方法未记录，不能据此判断长期趋势。';
    expect(containsProcessNarrative(text)).toBe(true);
    expect(presentAssessmentText(text)).toEqual({
      text: '前后差值为增加1.1 mmol/L。两次检测方法未记录，不能据此判断长期趋势。',
      changed: true, processOnly: false
    });
    const value = candidate();
    value.claims[0]!.text = text;
    expect(findProcessNarrativeIssues(value)).toContain('process_narrative:claim:lipids:text');
  });

  it('软件本轮的标准匹配说明交给局部修复，不删除相邻医学未知条件', () => {
    const text = '缺少尿液检查；本轮没有完整适用的诊断标准，不能确定诊断或分期。';
    expect(containsProcessNarrative(text)).toBe(true);
    // 不能精确区分限制归属时保留给修复器，不能吞掉诊断或分期边界。
    expect(presentAssessmentText(text).text).toContain('缺少尿液检查');
    expect(presentAssessmentText(text).text).toContain('不能确定诊断或分期');
    const clinical = '缺少尿液检查，现有检查尚不足以确认慢性肾病或分期。';
    expect(containsProcessNarrative(clinical)).toBe(false);
    expect(presentAssessmentText(clinical).text).toBe(clinical);
  });

  it('原安排是否可保留的编辑说明不进入健康正文，实际原建议完整保留', () => {
    const process = '报告中有明确的肯定安排，可按原文保留。';
    const advice = '报告建议记录家庭血压，复诊时一并查看血压和肾功能结果。';
    expect(containsProcessNarrative(process)).toBe(true);
    expect(presentAssessmentText(process)).toEqual({ text: '', changed: true, processOnly: true });
    expect(presentAssessmentText(`${process}${advice}`).text).toBe(advice);
    const value = candidate();
    value.claims[0]!.rationale = process;
    expect(findProcessNarrativeIssues(value)).toContain('process_narrative:claim:lipids:rationale');
    for (const clinical of [advice, '报告建议保留目前的活动计划。', '可按原文保留的安排包括记录家庭血压。']) {
      expect(containsProcessNarrative(clinical)).toBe(false);
      expect(presentAssessmentText(clinical).text).toBe(clinical);
    }
  });

  it('临床条件与工程词混在不可精确拆开的句中时，宁保留原句而不删条件', () => {
    const text = '未散瞳与P04处于同一条记录，但不能据此确认近视程度。';
    expect(containsProcessNarrative(text)).toBe(true);
    expect(presentAssessmentText(text)).toEqual({ text, changed: false, processOnly: false });
  });

  it.each([
    'P03尚未完成且本次未散瞳，不能据此确认近视程度。',
    '本次检查（P03尚未完成且本次未散瞳），不能据此确认近视程度。',
    'P03尚未完成且血糖为5.2 mmol/L，不能说明长期变化。',
    '本次检查（P03尚未完成且血糖为5.2 mmol/L），不能说明长期变化。',
    'P03尚未完成本次未散瞳，不能据此确认近视程度。',
    '模型复核尚未完成但本次未散瞳，不能据此确认近视程度。'
  ])('工程起头混合句不可精确拆开时保留临床原句：%s', (text) => {
    expect(containsProcessNarrative(text)).toBe(true);
    expect(presentAssessmentText(text)).toEqual({ text, changed: false, processOnly: false });
  });

  it.each([
    '模型仍无法判断符号含义：收缩压122 mmHg，舒张压76 mmHg。',
    '模型验证失败本次未散瞳，不能确认近视程度。'
  ])('非阶段工程起头不能整片段删除未知混合临床内容：%s', (text) => {
    expect(containsProcessNarrative(text)).toBe(true);
    expect(presentAssessmentText(text)).toEqual({ text, changed: false, processOnly: false });
  });

  it('所有用户字段均定位到所属节点和字段，保留含冒号的节点ID', () => {
    const value = candidate();
    const expected: string[] = [];
    for (const node of [value.overview, ...value.systems]) {
      for (const field of ['headline', 'summary'] as const) {
        node[field] = 'P04等待复核。';
        expected.push(`process_narrative:${node.id}:${field}`);
      }
      node.limitations = ['本地校验失败。'];
      expected.push(`process_narrative:${node.id}:limitations[0]`);
    }
    const claim = value.claims[0]!;
    for (const field of ['text', 'rationale', 'materialUncertainty', 'diseaseName'] as const) {
      claim[field] = '模型复核尚未完成。';
      expected.push(`process_narrative:${claim.id}:${field}`);
    }
    const action = value.actions[0]!;
    for (const field of ['title', 'why', 'firstStep', 'timing', 'reviewPlan', 'caution'] as const) {
      action[field] = '已通过本地校验。';
      expected.push(`process_narrative:${action.id}:${field}`);
    }
    const question = value.questions[0]!;
    for (const field of ['question', 'whyItMatters'] as const) {
      question[field] = '请核对sourceSpanId。';
      expected.push(`process_narrative:${question.id}:${field}`);
    }
    expect(findProcessNarrativeIssues(value)).toEqual(expected);
  });

  it('完整临床候选无正文门禁错误，内部字段和原始引用不当作正文', () => {
    const value = candidate();
    const original = JSON.stringify(value);
    expect(findProcessNarrativeIssues(value)).toEqual([]);
    expect(JSON.stringify(value)).toBe(original);
  });
});
