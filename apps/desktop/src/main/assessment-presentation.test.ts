import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { containsProcessNarrative, healthClaimTitle, memberAssessmentSnapshotV3Schema, type HealthAction, type HealthClaim, type MemberAssessmentSnapshotV3, type SystemNode } from '@contracts';
import { familyAssessmentNarrative, presentMemberAssessment, retainedAssessmentNarrative, retainedOverviewNarrative } from './assessment-presentation.js';

function claim(id: string, text: string): HealthClaim {
  return { id, topicKey: id, systemIds: ['cardiovascular'], kind: 'source_fact', text,
    diseaseName: null, diagnosticStatus: null, temporalStatus: 'current', evidenceIds: ['source-1'],
    counterEvidenceIds: [], trendIds: [], knowledgeBasis: 'not_applicable', knowledgeSourceIds: [],
    criteriaBasis: null, rationale: '合成原报告记载。', materialUncertainty: null, consequenceLevel: 'routine' };
}

function action(id: string, claimId: string, evidenceId = 'source-1'): HealthAction {
  return { id, dedupeKey: id, systemIds: ['cardiovascular'], claimIds: [claimId], kind: 'test_followup',
    title: '整理相关检查结果', why: '补充了解历次变化。', firstStep: '带上原报告与医生讨论。',
    timing: '下次就诊时', timingBasis: 'none', reviewPlan: null, caution: null, urgency: 'routine',
    evidenceIds: [evidenceId], knowledgeSourceIds: [] };
}

function systemSummary(item: HealthClaim, summary = item.text, limitations: string[] = item.materialUncertainty ? [item.materialUncertainty] : []): SystemNode {
  return { id: `system:${item.systemIds[0]}`, systemId: item.systemIds[0]!, status: 'monitor',
    headline: healthClaimTitle(item), summary, claimIds: [item.id], actionIds: [], limitations };
}

function fixture(): MemberAssessmentSnapshotV3 {
  return {
    schemaVersion: 3, personId: 'synthetic-person', inputSignature: 'a'.repeat(64), mode: 'full',
    requestedSystemIds: ['cardiovascular'], id: 'synthetic-snapshot', status: 'current',
    generatedAt: '2026-10-01T00:00:00Z', factRevision: 1, contextRevision: 0,
    reviewScopeSignature: 'b'.repeat(64), promptVersion: 'synthetic', rulesVersion: 'synthetic',
    modelId: 'synthetic', reasoningEffort: 'medium', validationMode: 'local_only', reviewedTargetIds: [],
    heldTargetIds: ['claim-held', 'action-held'], limitations: [], evidenceCatalog: [],
    processingPlan: { strategy: 'full', trigger: 'none', partitionCount: 0 }, knowledgeVerifications: [],
    overview: { id: 'overview', headline: '部分健康判断仍需核实',
      summary: '已接纳的报告事实和其他行动仍可查看；有部分判断暂未纳入本次总览。',
      claimIds: ['claim-first', 'claim-second'], actionIds: [], limitations: [] },
    systems: [{ id: 'system:cardiovascular', systemId: 'cardiovascular', status: 'monitor',
      headline: '部分判断仍需核实', summary: '已接纳的报告事实仍可查看；本系统有部分判断暂未纳入本次解读。',
      claimIds: ['claim-first', 'claim-second'], actionIds: [], limitations: ['部分判断因证据不足暂未发布。'] }],
    claims: [
      { ...claim('claim-first', '合成检查项目甲有变化，但不能单凭这一项确定原因。'), materialUncertainty: '检查条件尚不完整。' },
      claim('claim-second', '合成检查项目乙连续两次处于报告参考范围。')
    ], actions: [], questions: [], knowledgeSources: []
  };
}

describe('成员综合只读摘要投影', () => {
  it('局部重建总览按不同主体系统保留完整解释与条件，不变成系统目录', () => {
    const snapshot = fixture();
    snapshot.claims = [
      { ...claim('liver', '2026年肝胆检查在该次报告参考范围内，不能据此排除所有肝胆问题。'),
        systemIds: ['hepatobiliary'], rationale: '检查范围仅包括该次报告项目。', consequenceLevel: 'important' },
      { ...claim('lipid', '本次低密度脂蛋白较前升高，需要结合总体心血管情况理解。'),
        rationale: '两次检测采用相同单位。', materialUncertainty: '单项结果不能确定心血管疾病。', consequenceLevel: 'important' },
      { ...claim('thyroid', '历次促甲状腺激素有波动，当时游离甲状腺素仍在各自参考范围内。'),
        systemIds: ['endocrine_metabolic'], temporalStatus: 'historical',
        rationale: '不同实验室采用各自参考范围。', materialUncertainty: '这些历史结果不能代替当前检查。', consequenceLevel: 'important' }
    ];
    snapshot.overview.claimIds = ['liver'];
    snapshot.systems = snapshot.claims.map((item) => ({ id: `system:${item.systemIds[0]}`,
      systemId: item.systemIds[0]!, status: 'monitor', headline: '部分判断仍需核实',
      summary: '已接纳的报告事实仍可查看；本系统有部分判断暂未纳入本次解读。',
      claimIds: [item.id], actionIds: [], limitations: [] }));
    const original = structuredClone(snapshot);
    const shown = presentMemberAssessment(snapshot);
    expect(shown.overview.headline).toBe('整体情况：3项重点，涉及3个身体系统');
    expect(shown.overview.claimIds).toEqual(['liver', 'lipid', 'thyroid']);
    for (const item of snapshot.claims) {
      expect(shown.overview.summary).toContain(healthClaimTitle(item));
      expect(shown.overview.summary).toContain(item.text);
      expect(shown.overview.summary).toContain(item.rationale);
      if (item.materialUncertainty) expect(shown.overview.summary).toContain(item.materialUncertainty);
      const detail = shown.systems.find((node) => node.claimIds.includes(item.id))!;
      expect(detail.summary).toContain(item.text);
      expect(detail.summary).toContain(item.rationale);
      if (item.materialUncertainty) expect(detail.summary).toContain(item.materialUncertainty);
    }
    expect(shown.systems[0]!.summary).toContain(snapshot.claims[0]!.text);
    expect(shown.systems[0]!.summary).not.toContain(snapshot.claims[1]!.text);
    expect(shown.overview.summary).not.toMatch(/查看「|查看完整结果与检查条件/u);
    expect(shown.presentation?.rebuiltNodeIds).toContain('overview');
    expect(shown.claims).toBe(snapshot.claims);
    expect(snapshot).toEqual(original);
    expect(presentMemberAssessment(shown)).toEqual(shown);
    expect(memberAssessmentSnapshotV3Schema.safeParse(shown).success).toBe(true);
  });

  it('旧总览即使没有过程词，也不能用一个器官的检查标题代表多个系统', () => {
    const snapshot = fixture();
    snapshot.heldTargetIds = [];
    snapshot.claims[0] = { ...snapshot.claims[0]!, systemIds: ['hepatobiliary'],
      text: '该次肝胆检查没有提示该项目异常。' };
    snapshot.overview.headline = '肝胆检查结果';
    snapshot.overview.summary = snapshot.claims[0]!.text;
    snapshot.systems[0]!.headline = '单次心血管检查需要结合检查条件理解';
    snapshot.systems[0]!.summary = snapshot.claims[1]!.text;
    snapshot.systems[0]!.claimIds = ['claim-second'];
    snapshot.systems[0]!.limitations = [];
    const shown = presentMemberAssessment(snapshot);
    expect(shown.overview.headline).toBe('整体情况：2项重点，涉及2个身体系统');
    expect(shown.overview.summary).toContain('肝胆检查结果');
    expect(shown.overview.summary).toContain('心血管检查结果');
    expect(shown.overview.summary).toContain(snapshot.claims[0]!.text);
    expect(shown.overview.summary).toContain(snapshot.claims[1]!.text);
    expect(shown.systems[0]).toBe(snapshot.systems[0]);
    const card = familyAssessmentNarrative(shown);
    expect(card).toEqual({ headline: shown.overview.headline, summary: shown.overview.summary });
    expect(card.summary).toContain('肝胆');
    expect(card.summary).toContain('心血管');
    expect(card.summary).toContain(snapshot.claims[0]!.text);
    expect(card.summary).toContain(snapshot.claims[1]!.text);
  });

  it('已有合格的多系统总体结论保留，不能被原句拼接替换', () => {
    const snapshot = fixture();
    snapshot.heldTargetIds = [];
    snapshot.claims[0]!.systemIds = ['hepatobiliary'];
    snapshot.overview = { ...snapshot.overview, headline: '血脂变化值得关注，肝胆检查未提示该项异常',
      summary: '本次血脂较前有变化；肝胆检查在该次参考范围内。两部分都只反映报告所查项目，不能排除所有疾病。' };
    snapshot.systems = [];
    expect(presentMemberAssessment(snapshot)).toBe(snapshot);
    expect(familyAssessmentNarrative(snapshot)).toBe(snapshot.overview);
  });

  it('fallback 短标题只数保留主题及主系统，正文仍逐字保留完整解释和限制', () => {
    const first = { ...claim('first', '合成主题甲有变化，但不能单凭此项确定原因。'), title: '合成主题甲',
      systemIds: ['cardiovascular', 'cardiovascular', 'endocrine_metabolic'] as HealthClaim['systemIds'],
      consequenceLevel: 'important' as const, materialUncertainty: '缺少当时症状记录，不能代表现在。' };
    const second = { ...claim('second', '合成主题乙在该次报告范围内，不能据此排除所有问题。'),
      title: '合成主题乙', consequenceLevel: 'important' as const };
    const third = { ...claim('third', '合成主题丙需结合原检查条件理解。'), title: '合成主题丙',
      systemIds: ['hepatobiliary'] as HealthClaim['systemIds'], consequenceLevel: 'important' as const };
    const sameTopic = { ...claim('related', '同一主题的常规来源事实。'), topicKey: first.topicKey,
      title: '不能重复计数的主题' };
    const systemLimit = '不同检查方法的结果不能直接比较。';
    const nodeLimit = '现有资料只覆盖已有报告，不能替代当前检查。';
    const shown = retainedOverviewNarrative([first, second, third, sameTopic], [nodeLimit], Number.POSITIVE_INFINITY, {
      systems: [systemSummary(first, first.text, [systemLimit]), systemSummary(third)], rebuiltNodeIds: ['overview']
    });
    expect(shown.headline).toBe('整体情况：3项重点，涉及2个身体系统');
    expect(shown.headline).not.toMatch(/合成主题|不能重复计数|正常|健康分/u);
    expect(shown.summary).toBe([
      '以下只概括现有检查覆盖的身体情况，不代表所有身体状况。',
      `${first.title}\n${first.text}\n${first.rationale}\n${first.materialUncertainty}\n${systemLimit}`,
      `${second.title}\n${second.text}\n${second.rationale}\n${systemLimit}`,
      `${third.title}\n${third.text}\n${third.rationale}`,
      '完整结果、判断依据和检查条件见「身体与指标」。', nodeLimit
    ].join('\n\n'));
  });

  it('fallback 没有可显示主题时不制造重点数或身体状态，仍保留适用范围', () => {
    const limitation = '没有当前检查，旧资料不能代表现在的状态。';
    const shown = retainedOverviewNarrative([], [limitation]);
    expect(shown.headline).toBe('整体健康情况');
    expect(shown.headline).not.toMatch(/\d|正常|没有问题/u);
    expect(shown.summary).toContain('只概括现有检查覆盖');
    expect(shown.summary).toContain(limitation);
    expect(shown.summary).not.toMatch(/全身正常|整体正常/u);
  });

  it('fallback 没有系统归属的主题不虚增重点或系统数，也不借已存在的系统节点凑数', () => {
    const unassigned = { ...claim('unassigned', '无归属的合成解释。'), title: '无归属主题',
      systemIds: [] as HealthClaim['systemIds'], consequenceLevel: 'high' as const };
    const unrelated = { ...claim('unrelated', '不在总览输入中的合成解释。'),
      systemIds: ['respiratory'] as HealthClaim['systemIds'] };
    const shown = retainedOverviewNarrative([unassigned], [], Number.POSITIVE_INFINITY, {
      systems: [systemSummary(unrelated)], rebuiltNodeIds: []
    });
    expect(shown.headline).toBe('整体健康情况');
    expect(shown.summary).not.toContain(unassigned.title);
    expect(shown.summary).not.toContain(unrelated.text);
  });

  it('fallback 主题和系统计数不包含未发布或无法安全显示的内容', () => {
    const snapshot = fixture();
    const visible = { ...claim('visible', '合成检查需要结合当时条件理解，不能确定全部病因。'),
      title: '可显示的合成主题', evidenceIds: ['source-visible'], consequenceLevel: 'important' as const,
      materialUncertainty: '本次未散瞳，不能据此确认屈光状态。' };
    const held = { ...claim('claim-held', '不可展示的未发布结论。'), title: '不可展示的未发布主题',
      systemIds: ['reproductive'] as HealthClaim['systemIds'], evidenceIds: ['source-held'], consequenceLevel: 'high' as const };
    const unsafe = { ...claim('unsafe', '不可脱离条件展示的结论。'), title: '不可展示的危险主题',
      systemIds: ['respiratory'] as HealthClaim['systemIds'], evidenceIds: ['source-unsafe'], consequenceLevel: 'high' as const,
      materialUncertainty: 'P03尚未完成且检查条件不完整，不能确认原因。' };
    snapshot.claims = [held, unsafe, visible];
    snapshot.systems = snapshot.claims.map((item) => systemSummary(item));
    snapshot.overview.claimIds = snapshot.claims.map((item) => item.id);
    snapshot.heldTargetIds = ['overview', held.id];
    const original = structuredClone(snapshot);
    const shown = presentMemberAssessment(snapshot);
    for (const narrative of [shown.overview, familyAssessmentNarrative(shown)]) {
      expect(narrative.headline).toBe('整体情况：1项重点，涉及1个身体系统');
      expect(narrative.summary).toContain(visible.text);
      expect(narrative.summary).toContain(visible.materialUncertainty);
      expect(narrative.summary).not.toMatch(/未发布主题|未发布结论|危险主题|脱离条件展示|P03/u);
    }
    expect(shown.claims).toEqual([visible]);
    expect(snapshot).toEqual(original);
    expect(presentMemberAssessment(shown)).toEqual(shown);
  });

  it('长高影响主体与标题同序完整进入显示概况，短ECG或PSA不能补位替代', () => {
    const snapshot = fixture();
    const lipid = { ...claim('lipid', '合成血脂记录较前变化，需要结合该次报告范围理解。'.repeat(15)),
      title: '合成血脂变化', consequenceLevel: 'important' as const,
      rationale: '两次检查的背景需要分别核实。', materialUncertainty: '不能凭单项结果确认心血管疾病。' };
    const ecg = { ...claim('ecg', '合成心电图在该次所查范围内未提示异常。'), title: '合成心电图结果' };
    const thyroid = { ...claim('thyroid', '合成甲状腺记录有波动，当时另一指标仍在该次参考范围。'.repeat(15)),
      title: '合成甲状腺变化', systemIds: ['endocrine_metabolic'] as HealthClaim['systemIds'],
      consequenceLevel: 'important' as const, rationale: '不同年份采用各自实验室的参考范围。',
      materialUncertainty: '这些历史结果不能代表当前情况，也不据此开始治疗。' };
    const psa = { ...claim('psa', '合成前列腺检查未提示该项异常。'), title: '合成前列腺结果',
      systemIds: ['reproductive'] as HealthClaim['systemIds'] };
    const liver = { ...claim('liver', '合成肝酶变化需要优先结合症状和检查背景理解。'.repeat(35)),
      title: '合成肝酶变化', systemIds: ['hepatobiliary'] as HealthClaim['systemIds'],
      consequenceLevel: 'high' as const, rationale: '不能脱离完整检查背景解读。'.repeat(60),
      materialUncertainty: '目前尚不能确定原因；不同测量条件不能直接解释成疾病加重。' };
    const held = { ...claim('claim-held', '不可恢复的旧整体断言。'), title: '不可恢复的旧整体主题',
      consequenceLevel: 'high' as const };
    snapshot.claims = [lipid, ecg, thyroid, psa, liver, held];
    snapshot.systems = [
      { ...systemSummary(lipid, ecg.text), claimIds: ['lipid', 'ecg'], limitations: ['单次检查不能代表日常情况。'] },
      systemSummary(thyroid), systemSummary(psa),
      systemSummary(liver, '不可借用的旧肝胆短概括。', ['不能根据这些记录自行调整药物。'])
    ];
    snapshot.overview = { ...snapshot.overview, headline: '不可恢复的旧整体标题', summary: held.text,
      claimIds: ['thyroid', 'lipid', 'liver', 'claim-held'], limitations: ['概况只反映已有报告检查范围。'] };
    snapshot.heldTargetIds = ['overview', 'claim-held'];
    const before = structuredClone(snapshot);
    const shown = presentMemberAssessment(snapshot);
    const display = familyAssessmentNarrative(shown);
    expect(shown.overview.headline).toBe('整体情况：3项重点，涉及3个身体系统');
    expect(display.headline).toBe(shown.overview.headline);
    expect(shown.overview.summary).toBe('理解这些检查需要结合完整检查条件，请在「身体与指标」查看完整结果与说明。');
    expect(shown.overview.summary.length).toBeLessThanOrEqual(2_000);
    expect(display.summary.length).toBeGreaterThan(2_000);
    for (const item of [liver, thyroid, lipid]) {
      expect(display.summary).toContain(item.text);
      expect(display.summary).toContain(item.rationale);
      expect(display.summary).toContain(item.materialUncertainty);
    }
    expect(display.summary.indexOf(liver.text)).toBeLessThan(display.summary.indexOf(thyroid.text));
    expect(display.summary.indexOf(thyroid.text)).toBeLessThan(display.summary.indexOf(lipid.text));
    expect(display.summary).toContain('单次检查不能代表日常情况。');
    expect(display.summary).toContain('不能根据这些记录自行调整药物。');
    expect(display.summary).toContain(snapshot.overview.limitations[0]);
    for (const excluded of [ecg, psa, held]) {
      expect(display.headline).not.toContain(excluded.title);
      expect(display.summary).not.toContain(excluded.text);
    }
    expect(display.summary).not.toMatch(/不可借用|不可恢复/u);
    expect(memberAssessmentSnapshotV3Schema.safeParse(shown).success).toBe(true);
    expect(snapshot).toEqual(before);
    expect(presentMemberAssessment(shown)).toEqual(shown);
  });

  it('同主题的长主判断不被短来源事实替代，额外高影响主题仍完整保留而不按长度筛选', () => {
    const long = { ...claim('long', '合成心血管变化需要结合完整背景理解。'.repeat(40)), title: '合成重点甲',
      topicKey: 'same-topic', consequenceLevel: 'high' as const,
      rationale: '仍缺少症状记录。', materialUncertainty: '不能单凭该项判断病因。' };
    const short = { ...claim('short', '短来源数值。'), title: '不能补位的短标题', topicKey: long.topicKey };
    const others = Array.from({ length: 4 }, (_, index) => ({ ...claim(`other-${index}`, `合成重点${index}的完整说明，不能据此确定全部原因。`),
      title: `合成额外重点${index}`, consequenceLevel: 'important' as const }));
    const display = retainedOverviewNarrative([short, ...others, long], [], Number.POSITIVE_INFINITY);
    expect(display.headline).toBe('整体情况：5项重点，涉及1个身体系统');
    expect(display.summary.indexOf(long.text)).toBeLessThan(display.summary.indexOf(others[0]!.text));
    expect(display.summary).toContain(long.materialUncertainty);
    expect(display.summary).not.toContain(short.text);
    expect(display.summary).not.toContain(short.title);
    for (const item of others) expect(display.summary).toContain(item.text);
  });

  it('常规十二系统不凑成目录，高影响主体主题仍优先且不存在的系统不被补出', () => {
    const ids = ['cardiovascular', 'endocrine_metabolic', 'hepatobiliary', 'renal_urinary', 'digestive', 'respiratory',
      'hematology_immune', 'musculoskeletal', 'neurological', 'sensory_oral', 'reproductive', 'skin'] as const;
    const claims = ids.map((systemId, index) => ({ ...claim(`item-${index}`, `合成项目${index}只反映当时所查范围，不能代表现在。`),
      title: `合成主题${index}`, systemIds: [systemId] as HealthClaim['systemIds'],
      consequenceLevel: index === 10 ? 'high' as const : 'routine' as const }));
    const shown = retainedOverviewNarrative(claims, [], 2_000, {
      systems: claims.map((item) => systemSummary(item)), rebuiltNodeIds: claims.map((item) => `system:${item.systemIds[0]}`)
    });
    expect(shown.headline).toBe('整体情况：1项重点，涉及1个身体系统');
    expect(shown.summary).toContain(claims[10]!.text);
    expect(shown.summary).not.toContain(claims[0]!.text);
    expect(shown.summary).not.toContain(claims[1]!.text);
    expect(shown.summary).not.toMatch(/查看「|合成项目11/u);
    expect(shown.summary).not.toContain('皮肤');
    expect(shown.summary).not.toMatch(/全身正常|整体正常/u);
  });

  it('概况超过旧家庭900预算时家庭与成员仍同文，完整全局条件不丢且不截句', () => {
    const ids = ['cardiovascular', 'endocrine_metabolic', 'hepatobiliary'] as const;
    const snapshot = fixture();
    snapshot.claims = ids.map((systemId, index) => ({ ...claim(`topic-${index}`, `合成主题${index}的解释。`.repeat(23)
      + '只能说明当时所查项目，不能确定全部病因。'), title: `合成主题${index}`, systemIds: [systemId] as HealthClaim['systemIds'],
      rationale: '请结合该次测量背景理解。', materialUncertainty: '旧记录不能代表现在。' }));
    snapshot.systems = snapshot.claims.map((item) => systemSummary(item));
    snapshot.overview.claimIds = snapshot.claims.map((item) => item.id);
    snapshot.overview.limitations = ['现有资料只覆盖所查项目。'.repeat(12) + '本次未散瞳，不能据此确认屈光状态。'];
    snapshot.heldTargetIds = ['overview'];
    const shown = presentMemberAssessment(snapshot);
    expect(shown.overview.summary.length).toBeGreaterThan(900);
    expect(shown.overview.summary.length).toBeLessThanOrEqual(2_000);
    expect(familyAssessmentNarrative(shown)).toEqual({ headline: shown.overview.headline, summary: shown.overview.summary });
    expect(shown.overview.summary).toContain(snapshot.overview.limitations[0]);
    for (const item of snapshot.claims) {
      expect(shown.overview.summary).toContain(item.text);
      expect(shown.overview.summary).toContain(item.materialUncertainty);
    }
  });

  it('只有长解释可用时保留一条完整主体解释与尾部条件，不用肯定开头替代完整单元', () => {
    const eye = { ...claim('eye', '这次眼部检查有变化。'), title: '眼部检查的适用范围',
      systemIds: ['sensory_oral'] as HealthClaim['systemIds'], rationale: '不同测量条件需要分别理解。'.repeat(30),
      materialUncertainty: '本次未散瞳，不能据此确认屈光状态；旧检查不能代表现在。' };
    const shown = retainedOverviewNarrative([eye], [], 2_000, { systems: [systemSummary(eye)], rebuiltNodeIds: ['system:sensory_oral'] });
    expect(shown.summary).toContain(eye.text);
    expect(shown.summary).toContain(eye.rationale);
    expect(shown.summary).toContain(eye.materialUncertainty);
    expect(shown.summary).not.toMatch(/查看「|全身正常/u);
    const tooLong = { ...eye, rationale: '完整检查前提。'.repeat(400) + '不能确认病因。' };
    const omitted = retainedOverviewNarrative([tooLong], [], 2_000, { systems: [systemSummary(tooLong)], rebuiltNodeIds: ['system:sensory_oral'] });
    expect(omitted.summary).not.toContain(eye.text);
    expect(omitted.summary).not.toContain('完整检查前提。');
    expect(omitted.headline).toBe('整体情况：1项重点，涉及1个身体系统');
  });

  it('只有眼部历史资料时总览明确范围，不推导当前全身正常', () => {
    const only = { ...claim('eye', '2025年的视力检查未散瞳，不能据此确认屈光状态。'),
      systemIds: ['sensory_oral'] as HealthClaim['systemIds'], temporalStatus: 'historical' as const,
      materialUncertainty: '没有当前散瞳验光结果。' };
    const shown = retainedOverviewNarrative([only], [], 2_000, { systems: [systemSummary(only)], rebuiltNodeIds: [] });
    expect(shown.headline).toBe('整体情况：1项重点，涉及1个身体系统');
    expect(shown.summary).toContain('眼耳鼻喉 / 口腔');
    expect(shown.summary).toContain('只概括现有检查覆盖');
    expect(shown.summary).toContain(only.text);
    expect(shown.summary).toContain(only.materialUncertainty);
    expect(shown.summary).not.toMatch(/全身正常|目前视力正常/);
  });

  it('存储容量不足时不以较短其他系统换掉长主题，显示仍保留完整同序解释', () => {
    const liver = { ...claim('liver', '该次肝胆检查未提示该项异常。'), systemIds: ['hepatobiliary'] as HealthClaim['systemIds'] };
    const liverMore = Array.from({ length: 8 }, (_, index) => ({ ...liver, id: `liver-${index}`, text: `该次肝胆检查项目${index}的完整结果。` }));
    const blood = { ...claim('blood', '该次血压需要结合测量条件理解。'), materialUncertainty: '不是持续家庭测量。' };
    const long = { ...claim('long', '不可脱离条件展示的肯定结论。'), systemIds: ['endocrine_metabolic'] as HealthClaim['systemIds'],
      rationale: '必要检查条件。'.repeat(300) + '不能据此确定原因。' };
    const shown = retainedOverviewNarrative([liver, ...liverMore, blood, long], [], 900,
      { systems: [systemSummary(liver), systemSummary(blood), systemSummary(long)], rebuiltNodeIds: ['system:endocrine_metabolic'] });
    expect(shown.summary).toContain('查看完整结果与说明');
    expect(shown.summary).not.toContain(liver.text);
    expect(shown.summary).not.toContain(blood.text);
    expect(shown.summary).not.toContain(blood.materialUncertainty);
    expect(shown.summary).not.toContain(long.text);
    expect(shown.headline).toBe('整体情况：3项重点，涉及3个身体系统');
    expect(shown.summary.length).toBeLessThanOrEqual(900);
    const display = retainedOverviewNarrative([liver, ...liverMore, blood, long], [], Number.POSITIVE_INFINITY,
      { systems: [systemSummary(liver), systemSummary(blood), systemSummary(long)], rebuiltNodeIds: ['system:endocrine_metabolic'] });
    expect(display.headline).toBe(shown.headline);
    for (const item of [liver, blood, long]) {
      expect(display.summary).toContain(item.text);
      expect(display.summary).toContain(item.rationale);
    }
    expect(display.summary).toContain(blood.materialUncertainty);
    expect(display.summary).not.toContain(liverMore[0]!.text);
  });

  it('不同判断的相同未知条件各自保留，不因另一段已出现就省略必要前提', () => {
    const first = { ...claim('first', '该次眼部检查有变化。'), materialUncertainty: '检查条件尚不完整。' };
    const second = { ...claim('second', '该次内分泌检查有变化。'),
      systemIds: ['endocrine_metabolic'] as HealthClaim['systemIds'], materialUncertainty: first.materialUncertainty };
    const shown = retainedOverviewNarrative([first, second], [], 2_000,
      { systems: [systemSummary(first), systemSummary(second)], rebuiltNodeIds: [] });
    expect(shown.summary.split(first.materialUncertainty)).toHaveLength(3);
    const longLimits = retainedOverviewNarrative([first], ['必要检查范围。'.repeat(80)], 700);
    expect(longLimits.summary.length).toBeLessThanOrEqual(700);
  });

  it('以完整主体说明与否定条件形成同一家庭和成员概况，不借旧短系统摘要替换', () => {
    const snapshot = fixture();
    const eye = { ...claim('eye', '合成眼部完整说明，不应被长理由重复占满首页。'),
      title: '眼部结果需结合检查条件', systemIds: ['sensory_oral'] as HealthClaim['systemIds'],
      rationale: '测量背景会限制这次结果的适用范围。', materialUncertainty: '本次未散瞳，不能据此确认屈光状态。' };
    const blood = { ...claim('blood', '合成血常规完整说明。'), systemIds: ['hematology_immune'] as HealthClaim['systemIds'] };
    snapshot.claims = [eye, blood];
    snapshot.systems = [systemSummary(eye, '这次眼部测量有变化。'), systemSummary(blood, '这次血常规未提示所查项目异常。')];
    snapshot.overview.claimIds = ['eye', 'blood'];
    snapshot.heldTargetIds = ['overview'];
    const shown = presentMemberAssessment(snapshot);
    for (const narrative of [shown.overview, familyAssessmentNarrative(shown)]) {
      expect(narrative.summary).not.toContain('这次眼部测量有变化。');
      expect(narrative.summary).toContain(eye.materialUncertainty);
      expect(narrative.summary).toContain(blood.text);
      expect(narrative.summary).toContain(eye.rationale);
      expect(narrative.summary).toContain(eye.text);
    }
    expect(shown.claims).toBe(snapshot.claims);
    expect(shown.systems).toEqual(snapshot.systems);
  });

  it.each(['materialUncertainty', 'rationale'] as const)('未散瞳条件仅在主张 %s 中时，旧系统短摘要仍完整保留条件', (field) => {
    const snapshot = fixture();
    const condition = '本次未散瞳，不能据此确认屈光状态；旧检查不能代表现在。';
    const eye = { ...claim('eye', '合成眼部原始完整说明。'), title: '眼部检查的适用范围',
      systemIds: ['sensory_oral'] as HealthClaim['systemIds'], [field]: condition };
    snapshot.claims = [eye];
    snapshot.systems = [systemSummary(eye, '这次眼部测量有变化。', [])];
    snapshot.overview.claimIds = ['eye'];
    snapshot.heldTargetIds = ['overview'];
    const original = structuredClone(snapshot);
    const shown = presentMemberAssessment(snapshot);
    for (const narrative of [shown.overview, familyAssessmentNarrative(shown)]) {
      expect(narrative.summary).toContain(eye.text);
      expect(narrative.summary).toContain(condition);
      expect(narrative.summary.split(condition)).toHaveLength(2);
    }
    expect(shown.claims).toBe(snapshot.claims);
    expect(snapshot).toEqual(original);
    expect(presentMemberAssessment(shown)).toEqual(shown);
  });

  it('必要前提只在长理由尾部时正文完整保留，不借旧短摘要的肯定开头替换', () => {
    const snapshot = fixture();
    const eye = { ...claim('eye', '原有眼部完整解释。'), title: '眼部检查的完整说明',
      systemIds: ['sensory_oral'] as HealthClaim['systemIds'],
      rationale: '不同测量背景需要完整理解。'.repeat(40) + '本次未散瞳，不能据此确认屈光状态。' };
    const blood = { ...claim('blood', '血液检查完整解释。'), systemIds: ['hematology_immune'] as HealthClaim['systemIds'] };
    snapshot.claims = [eye, blood];
    snapshot.systems = [systemSummary(eye, '不能脱离条件摘用的肯定开头。', []),
      systemSummary(blood, '血常规未提示所查项目异常。')];
    snapshot.overview.claimIds = ['eye', 'blood'];
    snapshot.heldTargetIds = ['overview'];
    const shown = presentMemberAssessment(snapshot);
    for (const narrative of [shown.overview, familyAssessmentNarrative(shown)]) {
      expect(narrative.headline).toBe('整体情况：2项重点，涉及2个身体系统');
      expect(narrative.summary).toContain('眼部检查的完整说明');
      expect(narrative.summary).toContain(blood.text);
      expect(narrative.summary).not.toContain('不能脱离条件摘用的肯定开头');
      expect(narrative.summary).toContain(eye.text);
      expect(narrative.summary).toContain(eye.rationale);
    }
    expect(shown.claims[0]!.rationale).toBe(eye.rationale);
    expect(shown.systems[0]).toBe(snapshot.systems[0]);
  });

  it('甲状腺的次关联不能抢走血液系统自己的重要主体解释', () => {
    const thyroid = { ...claim('thyroid', '合成甲状腺详述。'), title: '甲状腺结果的完整解释',
      systemIds: ['endocrine_metabolic', 'hematology_immune'] as HealthClaim['systemIds'], consequenceLevel: 'important' as const };
    const blood = { ...claim('blood', '合成血液详述。'), systemIds: ['hematology_immune'] as HealthClaim['systemIds'],
      materialUncertainty: '不能代表其他免疫检查。', consequenceLevel: 'important' as const };
    const shown = retainedOverviewNarrative([thyroid, blood], [], 900, {
      systems: [systemSummary(thyroid), systemSummary(blood, '血常规未提示所查项目异常，不能代表其他免疫检查。')],
      rebuiltNodeIds: ['system:endocrine_metabolic']
    });
    expect(shown.headline).toBe('整体情况：2项重点，涉及2个身体系统');
    expect(shown.summary).toContain('甲状腺结果的完整解释');
    expect(shown.summary).toContain(thyroid.text);
    expect(shown.summary).toContain(`血液 / 免疫检查结果\n${blood.text}`);
    expect(shown.summary).toContain(blood.materialUncertainty);
    expect(shown.summary).not.toContain('血液 / 免疫：查看「甲状腺');
    expect(shown.summary.match(/甲状腺结果的完整解释/gu)).toHaveLength(1);
  });

  it('旧系统摘要混合另一个主系统的次关联时，只用本系统完整主体解释', () => {
    const thyroid = { ...claim('thyroid', '甲状腺相关完整解释。'), title: '甲状腺解释',
      systemIds: ['endocrine_metabolic', 'hematology_immune'] as HealthClaim['systemIds'],
      materialUncertainty: '不能凭此概括血常规。' };
    const blood = { ...claim('blood', '血常规在本次所查范围内未提示异常。'),
      systemIds: ['hematology_immune'] as HealthClaim['systemIds'], materialUncertainty: '不能代表其他免疫检查。' };
    const mixed = { ...systemSummary(blood, '不应借甲状腺解释代替血常规概况。'), claimIds: ['blood', 'thyroid'] };
    const shown = retainedOverviewNarrative([thyroid, blood], [], 2_000, { systems: [systemSummary(thyroid), mixed], rebuiltNodeIds: [] });
    expect(shown.summary).toContain(`血液 / 免疫检查结果\n${blood.text}`);
    expect(shown.summary).toContain(blood.materialUncertainty);
    expect(shown.summary).not.toContain(mixed.summary);
    expect(shown.summary).not.toContain(`血液 / 免疫：${thyroid.text}`);
  });

  it('过长旧系统摘要不被借用，高影响主体解释不被常规短结果换掉', () => {
    const liver = { ...claim('liver', '不可脱离末尾条件的肝胆长说明。'),
      systemIds: ['hepatobiliary'] as HealthClaim['systemIds'] };
    const urgent = { ...claim('urgent', '现有心血管检查需要结合症状理解，不能单凭该项确定原因。'), title: '心血管检查需重点阅读', consequenceLevel: 'high' as const };
    const blood = { ...claim('blood', '血液详细原文。'), systemIds: ['hematology_immune'] as HealthClaim['systemIds'] };
    const snapshot = fixture();
    snapshot.claims = [liver, urgent, blood];
    snapshot.systems = [systemSummary(liver, '不可单独摘用的开头。'.repeat(60) + '但不能因此排除其他病因。'),
      systemSummary(urgent, '不可恢复的旧概括。'), systemSummary(blood, '血常规在该次报告参考范围，不能说明其他检查结果。')];
    snapshot.heldTargetIds = ['overview', 'system:cardiovascular'];
    snapshot.overview.claimIds = snapshot.claims.map((item) => item.id);
    const original = structuredClone(snapshot);
    const shown = presentMemberAssessment(snapshot);
    for (const narrative of [shown.overview, familyAssessmentNarrative(shown)]) {
      expect(narrative.headline).toBe('整体情况：1项重点，涉及1个身体系统');
      expect(narrative.summary).toContain('心血管检查需重点阅读');
      expect(narrative.summary).toContain(urgent.text);
      expect(narrative.summary).not.toContain(liver.text);
      expect(narrative.summary).not.toContain(blood.text);
      expect(narrative.summary).not.toContain('血常规在该次报告参考范围，不能说明其他检查结果。');
      expect(narrative.summary).not.toContain('不可单独摘用的开头');
      expect(narrative.summary).not.toContain('不可恢复的旧概括');
    }
    expect(familyAssessmentNarrative(shown)).toEqual({ headline: shown.overview.headline, summary: shown.overview.summary });
    expect(shown.claims).toBe(snapshot.claims);
    expect(snapshot).toEqual(original);
  });

  it('被隔离主张和重建摘要不复活，合格旧摘要与另一个系统的标题分开呈现', () => {
    const snapshot = fixture();
    const held = { ...claim('claim-held', '不能进入概况的隔离正文。'), title: '不能进入概况的隔离标题' };
    const retained = { ...claim('retained', '原有完整说明。'), title: '仍可阅读的合格主题', consequenceLevel: 'important' as const };
    const blood = { ...claim('blood', '血常规详情。'), systemIds: ['hematology_immune'] as HealthClaim['systemIds'],
      consequenceLevel: 'important' as const };
    snapshot.claims = [held, retained, blood];
    snapshot.systems = [{ ...systemSummary(retained, '依赖隔离正文的旧摘要。'), claimIds: ['claim-held', 'retained'] },
      systemSummary(blood, '血常规在本次所查范围内未提示异常。')];
    snapshot.overview.claimIds = snapshot.claims.map((item) => item.id);
    const shown = presentMemberAssessment(snapshot);
    expect(shown.overview.headline).toBe('整体情况：2项重点，涉及2个身体系统');
    expect(shown.overview.summary).toContain('仍可阅读的合格主题');
    expect(shown.overview.summary).toContain(retained.text);
    expect(shown.overview.summary).toContain(blood.text);
    expect(shown.overview.summary).not.toMatch(/隔离正文|隔离标题|旧摘要/);
    expect(shown.claims.map((item) => item.id)).toEqual(['retained', 'blood']);
    expect(shown.systems[0]!.summary).toContain(retained.text);
  });

  it.each(['已经确诊鼻炎', '已经确诊胃炎'])('旧 possible 主张的矛盾或无关标题只换中性入口：%s', (title) => {
    const snapshot = fixture();
    snapshot.heldTargetIds = [];
    snapshot.claims[0] = { ...snapshot.claims[0]!, title, kind: 'diagnostic_assessment', diseaseName: '鼻炎',
      diagnosticStatus: 'possible', text: '鼻部症状可能与鼻炎有关，但尚不能确诊。',
      rationale: '还要结合发作时间、接触环境与鼻部检查。',
      materialUncertainty: '未提供鼻部查体结果，不能仅凭症状确认病因。' };
    snapshot.actions = [action('action-retained', 'claim-first')];
    for (const node of [snapshot.overview, ...snapshot.systems]) {
      node.headline = title;
      node.summary = '鼻部症状可能与鼻炎有关，但尚不能确诊；另一检查结果仍在报告范围内。';
      node.limitations = ['未提供鼻部查体结果。'];
      node.actionIds = ['action-retained'];
    }
    const before = structuredClone(snapshot);
    const shown = presentMemberAssessment(snapshot);
    expect(shown.claims[0]).toEqual({ ...before.claims[0], title: '心血管检查结果' });
    expect(shown.claims[1]).toEqual(before.claims[1]);
    expect(shown.overview.headline).toMatch(/^整体情况：/u);
    expect(shown.overview.summary).toContain(before.claims[0]!.text);
    expect(shown.overview.summary).toContain(before.claims[0]!.rationale);
    expect(shown.overview.summary).toContain(before.claims[0]!.materialUncertainty);
    expect(shown.overview.summary).toContain('未提供鼻部查体结果。');
    expect(shown.overview.summary).not.toContain(title);
    for (const node of shown.systems) {
      expect(node.headline).toBe('心血管检查结果');
      expect(node.summary).toBe(before.overview.summary);
      expect(node.limitations).toEqual(before.overview.limitations);
    }
    expect(shown.systems[0]!.status).toBe(before.systems[0]!.status);
    expect(shown.actions).toEqual(before.actions);
    expect(shown.heldTargetIds).toEqual([]);
    expect(snapshot).toEqual(before);
    expect(presentMemberAssessment(shown)).toEqual(shown);
  });

  it.each(['2021年报告记载确诊胃炎', '尚不能确诊胃炎'])('旧来源诊断或否定标题不被投影抹去：%s', (title) => {
    const snapshot = fixture();
    snapshot.heldTargetIds = [];
    snapshot.claims[0] = { ...snapshot.claims[0]!, title, kind: 'diagnostic_assessment', diseaseName: '胃炎',
      diagnosticStatus: title.startsWith('2021') ? 'documented' : 'possible', temporalStatus: 'historical',
      text: '2021年的报告描述需结合当时症状理解，不能代表现在。' };
    for (const node of [snapshot.overview, ...snapshot.systems]) {
      node.headline = title;
      node.summary = snapshot.claims[0]!.text;
      node.limitations = ['不能代表现在。'];
    }
    expect(presentMemberAssessment(snapshot)).toBe(snapshot);
  });

  it('独立短标题用于重建入口，完整长正文及临床限制只进入说明，不能复活旧结论', () => {
    const snapshot = fixture();
    const body = '眼轴是眼球前后方向的长度，比较时需要结合年龄、检查日期和测量方法。'
      + '这次检查与以前记录有差异，但本次未散瞳，不能据此确认近视程度，也不能把不同测量方法的结果直接解释成病情加重。';
    snapshot.claims[0] = { ...snapshot.claims[0]!, title: '眼部测量需结合检查条件理解', text: body,
      rationale: body, materialUncertainty: '请结合眼科记录中的测量方法和检查日期理解。' };
    snapshot.overview.headline = '不能恢复的旧标题';
    snapshot.overview.summary = '不能恢复的旧概括';
    snapshot.heldTargetIds.push('overview');
    const shown = presentMemberAssessment(snapshot);
    expect(shown.overview.headline).toBe('整体情况：1项重点，涉及1个身体系统');
    expect(shown.overview.summary).toContain('眼部测量需结合检查条件理解');
    expect(shown.overview.summary).toContain(body);
    expect(shown.overview.summary).toContain(snapshot.claims[0]!.materialUncertainty);
    expect(shown.systems[0]!.summary).toContain(body);
    expect(shown.systems[0]!.summary).toContain('请结合眼科记录中的测量方法和检查日期理解');
    expect(shown.overview.summary).not.toContain('不能恢复');
    expect(shown.claims[0]!.text).toBe(body);
    expect(presentMemberAssessment(shown)).toEqual(shown);
  });

  it('旧主张没有短标题时用主题入口，仍展示完整正文而不是截取第一句', () => {
    const first = claim('legacy', '本次检查甲有变化。还要结合检测方法，不能单凭这次结果确定原因。');
    const shown = retainedAssessmentNarrative([first]);
    expect(shown.headline).toBe('心血管检查结果');
    expect(shown.summary).toContain(first.text);
    expect(shown.summary).toContain(first.rationale);
  });

  it.each(['semantic', 'held'] as const)('同源过程混合句和%s隔离节点的依赖传播必须收敛', (kind) => {
    const snapshot = fixture();
    snapshot.heldTargetIds = kind === 'held' ? ['claim-second'] : [];
    snapshot.overview.limitations = [];
    snapshot.systems[0]!.limitations = [];
    snapshot.claims[0]!.materialUncertainty = 'P03尚未完成且本次未散瞳，不能据此确认近视程度。';
    snapshot.claims[1] = { ...snapshot.claims[1]!, temporalStatus: 'historical', text: '目前血压正常。' };
    // 子进程设硬超时：若集合传播再次不收敛，单个回归失败而不会卡住整个测试进程。
    const script = `import { register } from 'tsx/esm/api';
      register({ tsconfig: 'tsconfig.node.json' });
      const { presentMemberAssessment } = await import('./apps/desktop/src/main/assessment-presentation.ts');
      const result = presentMemberAssessment(${JSON.stringify(snapshot)});
      console.log(JSON.stringify({ claims: result.claims.length, actions: result.actions.length }));`;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      cwd: process.cwd(), encoding: 'utf8', timeout: 5_000
    });
    expect(result.error?.message, result.stderr).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ claims: 0, actions: 0 });
  });

  it('旧总览的视图过程分句不再进入摘要，但相邻医学限制和原快照完整保留', () => {
    const snapshot = fixture();
    const clinical = '2025年影像完整结果尚未确认，病因及是否持续未知。旧报告不能代表今天的状态。';
    snapshot.overview.limitations = [`${clinical}小结仍可用于分析。部分已保存事实尚未归入系统视图，总览已纳入其中可确定的重要内容。`];
    const original = structuredClone(snapshot);
    const shown = presentMemberAssessment(snapshot);
    expect(shown.overview.summary).toContain(clinical);
    expect(shown.overview.summary).not.toMatch(/小结仍可用于分析|归入系统视图|总览已纳入/);
    expect(shown.claims).toEqual(snapshot.claims);
    expect(shown.overview.headline).toMatch(/^整体情况：/u);
    expect(shown.systems[0]!.summary).toContain(snapshot.claims[0]!.text);
    expect(presentMemberAssessment(shown)).toEqual(shown);
    expect(snapshot).toEqual(original);
  });

  it('事实排在第一时摘要保留完整结果和同源白话解释，行动在自己的区域保留', () => {
    const snapshot = fixture();
    snapshot.claims[0] = { ...claim('claim-first', '2025年6月10日促甲状腺激素为6.8 mIU/L，高于当次参考范围。'),
      temporalStatus: 'historical', rationale: '以该次报告数值和参考范围为依据。', materialUncertainty: '这是一年前的检查，不代表现在的结果。' };
    snapshot.claims[1] = { ...claim('claim-second', '促甲状腺激素是身体催促甲状腺分泌激素的信号，单次偏高不能确定激素不足。'),
      kind: 'interpretation', temporalStatus: 'historical', materialUncertainty: '缺少同期游离甲状腺素结果。' };
    snapshot.claims.push({ ...claim('claim-held', '不得恢复的判断。'), evidenceIds: ['source-held'] },
      { ...claim('claim-other', '另一系统的独立解释。'), kind: 'interpretation', systemIds: ['respiratory'], evidenceIds: ['source-other'] });
    snapshot.actions = [{ ...action('action-visible', 'claim-second'), firstStep: '先查看2025年6月以后的甲状腺功能结果。',
      timing: '下次就诊讨论时', reviewPlan: '拿到结果后再讨论是否需要检查。', caution: '不要自行开始或调整药物。' },
      { ...action('action-held', 'claim-held', 'source-held'), firstStep: '不得恢复的行动。' },
      { ...action('action-other', 'claim-other', 'source-other'), firstStep: '另一系统的安排。' }];
    snapshot.overview.actionIds = ['action-visible', 'action-held'];
    snapshot.systems[0]!.actionIds = ['action-visible', 'action-held', 'action-other'];
    snapshot.systems[0]!.status = 'insufficient';
    snapshot.systems[0]!.limitations = ['尚不清楚是否正在服药。'];
    const original = JSON.stringify(snapshot);
    const shown = presentMemberAssessment(snapshot);
    expect(shown.overview.headline).toBe('整体情况：2项重点，涉及2个身体系统');
    expect(shown.overview.summary).toContain('肺 / 呼吸检查结果');
    expect(shown.overview.summary).toContain('另一系统的独立解释。');
    for (const node of [shown.systems[0]!]) {
      expect(node.summary).toContain(snapshot.claims[0].text);
      expect(node.summary).toContain(snapshot.claims[1].text);
      expect(node.summary).toContain('不代表现在');
      expect(node.summary).toContain('缺少同期游离甲状腺素');
      expect(node.summary).not.toContain('先查看2025年6月以后的');
      expect(node.summary).not.toContain('不得恢复');
    }
    expect(shown.systems[0]!.headline).toBe(healthClaimTitle(snapshot.claims[0]));
    expect(shown.systems[0]!.summary).not.toContain('另一系统');
    expect(shown.actions[0]).toEqual(snapshot.actions[0]);
    expect(shown.overview.actionIds).toEqual(['action-visible']);
    expect(shown.systems[0]!.summary).toContain('尚不清楚是否正在服药');
    expect(shown.systems[0]!.status).toBe('insufficient');
    expect(shown.presentation?.version).toBe('result-summary-v14');
    expect(memberAssessmentSnapshotV3Schema.safeParse(shown).success).toBe(true);
    expect(presentMemberAssessment(shown)).toEqual(shown);
    expect(JSON.stringify(snapshot)).toBe(original);
  });

  it('其他日期性质或其他个人依据的解释不借来补首条事实', () => {
    const first = { ...claim('first', '2025年的检查甲偏高。'), temporalStatus: 'historical' as const };
    const other = { ...claim('other', '不得借用的解释。'), kind: 'interpretation' as const };
    expect(retainedAssessmentNarrative([first, other]).summary).toBe(`${first.text}\n${first.rationale}`);
    expect(retainedAssessmentNarrative([first, { ...other, temporalStatus: 'historical', evidenceIds: ['other-source'] }]).summary).toBe(`${first.text}\n${first.rationale}`);
  });

  it('只命中一个节点主张但另有跨节点依赖的行动不进入摘要', () => {
    const first = claim('first', '检查甲需要关注。');
    const crossNodeAction = { ...action('cross-node', first.id), claimIds: [first.id, 'not-in-node'], firstStep: '不可借用的跨节点行动。' };
    expect(retainedAssessmentNarrative([first], [crossNodeAction]).summary).toBe(`${first.text}\n${first.rationale}`);
  });

  it('报告中的历史医生安排不从原始记录提升为新的摘要行动', () => {
    const first = { ...claim('first', '2025年的检查甲偏高。'), temporalStatus: 'historical' as const };
    for (const oldPlan of [
      { ...action('old-plan', first.id), kind: 'documented_plan' as const },
      { ...action('old-plan', first.id), kind: 'test_followup' as const, timingBasis: 'documented' as const }
    ]) expect(retainedAssessmentNarrative([first], [{ ...oldPlan, firstStep: '2025年当时的医生安排。' }]).summary).toBe(`${first.text}\n${first.rationale}`);
  });

  it('解释与否定条件、行动与安全提醒超容量时整组留在详情，不能只摘肯定句或第一步', () => {
    const first = claim('first', '检查甲偏高。');
    const explanation = { ...claim('explanation', '不可单独摘用的解释。'), kind: 'interpretation' as const,
      materialUncertainty: '完整条件。'.repeat(399) };
    const next = { ...action('next', first.id), firstStep: '不可单独摘用的第一步。', caution: '完整提醒。'.repeat(399) };
    const narrative = retainedAssessmentNarrative([first, explanation], [next]);
    expect(narrative.summary).toBe(`${first.text}\n${first.rationale}`);
    expect(narrative.summary).not.toContain('不可单独摘用');
  });

  it('首条事实及节点的必要限制过长时改为完整结果入口，不显示脱离条件的健康结论', () => {
    const first = { ...claim('first', '脱离条件不能单独展示的结论。'), materialUncertainty: '必要条件。'.repeat(399) };
    const narrative = retainedAssessmentNarrative([first], [], ['另一项必要检查条件。']);
    expect(narrative.headline).toBe('相关检查记录');
    expect(narrative.summary).toContain('完整检查条件');
    expect(narrative.summary).not.toContain(first.text);
  });

  it('没有额外解释与行动时保留事实与原有理由，不生成新的依据套话', () => {
    const first = claim('first', '2025年检查甲为5.2 mmol/L。');
    expect(retainedAssessmentNarrative([first])).toEqual({ headline: healthClaimTitle(first), summary: `${first.text}\n${first.rationale}` });
  });

  it('仅在原有理由中记载的检查条件不能被忽略，也不被容量不足截断', () => {
    const first = { ...claim('first', '这次眼部测量有变化。'),
      rationale: '本次未散瞳，不能据此确认近视程度。' };
    expect(retainedAssessmentNarrative([first]).summary).toBe(`${first.text}\n${first.rationale}`);
    const long = { ...first, rationale: '完整检查条件。'.repeat(400) + '不能据此确认近视程度。' };
    expect(retainedAssessmentNarrative([long]).headline).toBe('相关检查记录');
  });

  it('旧的历史判断不能冒充现在正常，但同源合格历史结果和存档保持不变', () => {
    const snapshot = fixture();
    snapshot.heldTargetIds = [];
    snapshot.claims[0] = { ...claim('claim-first', '目前血压正常，不需要继续关注。'), temporalStatus: 'historical',
      materialUncertainty: '只有2022年的记录，不能说明现在的血压。' };
    snapshot.claims[1] = { ...claim('claim-second', '2022年血压在当次报告参考范围内，不代表现在。'), temporalStatus: 'historical' };
    snapshot.actions = [action('action-dependent', 'claim-first')];
    snapshot.systems[0]!.actionIds = ['action-dependent'];
    const original = JSON.stringify(snapshot);
    const shown = presentMemberAssessment(snapshot);
    expect(shown.claims.map((item) => item.id)).toEqual(['claim-second']);
    expect(shown.actions).toEqual([]);
    expect(shown.overview.headline).toMatch(/^整体情况：/u);
    expect(shown.systems[0]!.summary).toContain(snapshot.claims[1].text);
    expect(shown.overview.summary).not.toContain('目前血压正常');
    expect(shown.systems[0]!.status).toBe('insufficient');
    expect(JSON.stringify(snapshot)).toBe(original);
    expect(presentMemberAssessment(shown)).toEqual(shown);
  });

  it('同项目明确未知不能展示成正常，其他独立已知结果不变', () => {
    const snapshot = fixture();
    snapshot.heldTargetIds = [];
    snapshot.evidenceCatalog = [{ id: 'source-1', kind: 'user_note', documentId: null, sourceSpanId: null,
      eventId: null, observationId: null, knowledgeId: null, label: '合成补充', locator: null,
      quote: '目前没有血压检查结果。' }];
    snapshot.claims[0] = { ...claim('claim-first', '目前血压正常。'),
      materialUncertainty: '当前血压尚不能确定，因为缺少这次检查结果。' };
    snapshot.claims[1] = { ...claim('claim-second', '2025年低密度脂蛋白在当次参考范围内。'), evidenceIds: ['source-2'] };
    const shown = presentMemberAssessment(snapshot);
    expect(shown.claims.map((item) => item.id)).toEqual(['claim-second']);
    expect(shown.overview.headline).toMatch(/^整体情况：/u);
    expect(shown.systems[0]!.summary).toContain(snapshot.claims[1].text);
    expect(shown.overview.summary).not.toContain('目前血压正常');
  });

  it('旧正文里的 UUID 或文件定位不能夹在健康解释中展示，原始档案不改写', () => {
    const snapshot = fixture();
    snapshot.claims[0]!.text = '成员3fa85f64-5717-4562-b3fc-2c963f66afa6的血压为110/71 mmHg。';
    snapshot.claims[1]!.evidenceIds = ['source-2'];
    const original = JSON.stringify(snapshot);
    const shown = presentMemberAssessment(snapshot);
    expect(shown.claims.map((item) => item.id)).toEqual(['claim-second']);
    expect(containsProcessNarrative(shown.overview.headline)).toBe(false);
    expect(JSON.stringify(snapshot)).toBe(original);
  });

  it('合格历史主张不能被汇总升级成现在正常，只重建摘要而保留主张', () => {
    const snapshot = fixture();
    snapshot.heldTargetIds = [];
    snapshot.claims.forEach((item) => { item.temporalStatus = 'historical'; });
    snapshot.claims[0]!.text = '2022年血压在当次参考范围内，不代表现在。';
    snapshot.overview.headline = '目前血压正常。';
    snapshot.overview.summary = '目前无需继续关注。';
    const shown = presentMemberAssessment(snapshot);
    expect(shown.claims).toBe(snapshot.claims);
    expect(shown.overview.headline).toMatch(/^整体情况：/u);
    expect(shown.claims[0]!.text).toBe(snapshot.claims[0]!.text);
    expect(shown.overview.summary).toContain(snapshot.claims[0]!.text);
    expect(shown.overview.summary).not.toContain('目前无需继续关注');
    expect(shown.presentation?.rebuiltNodeIds).toContain('overview');
  });

  it('只有明确未知主张时不能沿用没有问题的状态，不删除未知条件', () => {
    const snapshot = fixture();
    snapshot.heldTargetIds = [];
    snapshot.evidenceCatalog = [{ id: 'source-1', kind: 'user_note', documentId: null, sourceSpanId: null,
      eventId: null, observationId: null, knowledgeId: null, label: '合成补充', locator: null,
      quote: '目前没有血压检查结果。' }];
    snapshot.claims = [{ ...claim('claim-first', '当前血压尚不能确定。'),
      materialUncertainty: '当前血压尚不能确定，因为缺少这次检查结果。' }];
    snapshot.systems[0]!.claimIds = ['claim-first'];
    snapshot.systems[0]!.status = 'no_signal_in_scope';
    const shown = presentMemberAssessment(snapshot);
    expect(shown.claims).toBe(snapshot.claims);
    expect(shown.systems[0]!.status).toBe('insufficient');
    expect(shown.systems[0]!.headline).toBe(healthClaimTitle(snapshot.claims[0]!));
    expect(shown.systems[0]!.summary).toContain('当前血压尚不能确定。');
  });

  it('旧快照直接显示保留的具体解读；不改存档、引用、模型版本或执行路径', () => {
    const snapshot = fixture();
    const before = JSON.stringify(snapshot);
    const presented = presentMemberAssessment(snapshot);
    expect(presented.overview.headline).toBe('整体情况：1项重点，涉及1个身体系统');
    expect(presented.overview.summary).toContain('心血管检查结果');
    expect(presented.overview.summary).toContain(snapshot.claims[0]!.text);
    expect(presented.systems[0]!.summary).toContain(snapshot.claims[0]!.text);
    expect(presented.systems[0]!.summary).toContain('检查条件尚不完整。');
    expect(presented.systems[0]!.summary).not.toContain(snapshot.claims[1]!.text);
    expect(presented.claims[1]!.text).toBe(snapshot.claims[1]!.text);
    expect(presented.systems[0]!.limitations).toEqual([]);
    expect(presented.presentation?.rebuiltNodeIds).toEqual(['overview', 'system:cardiovascular']);
    expect(memberAssessmentSnapshotV3Schema.safeParse(presented).success).toBe(true);
    expect(presented.claims).toBe(snapshot.claims);
    expect(presented.evidenceCatalog).toBe(snapshot.evidenceCatalog);
    expect(presented.heldTargetIds).toBe(snapshot.heldTargetIds);
    expect(JSON.stringify(snapshot)).toBe(before);
    expect(presentMemberAssessment(presented)).toEqual(presented);
  });

  it('只有行动被排除也能从原有判断恢复摘要，不沿用可能包含被排除建议的旧摘要', () => {
    const snapshot = fixture();
    snapshot.heldTargetIds = ['action-held'];
    expect(presentMemberAssessment(snapshot).systems[0]!.headline).toBe(healthClaimTitle(snapshot.claims[0]!));
  });

  it('不恢复被隔离或不存在的节点，不把另一个系统的判断借过来填空', () => {
    const snapshot = fixture();
    snapshot.claims.push(claim('claim-held', '不得重新展示的内容。'));
    snapshot.systems[0]!.claimIds = ['claim-held', 'missing'];
    const presented = presentMemberAssessment(snapshot);
    expect(presented.systems[0]!.headline).toBe('相关检查记录');
    expect(presented.systems[0]!.summary).not.toContain('不得重新展示');
    expect(presented.systems[0]!.summary).not.toContain(snapshot.claims[0]!.text);
  });

  it('其他系统的有效摘要与健康状态不受局部隔离影响', () => {
    const snapshot = fixture();
    snapshot.systems.push({ ...snapshot.systems[0]!, id: 'system:respiratory', systemId: 'respiratory',
      status: 'no_signal_in_scope', headline: '合成呼吸检查未提示问题', summary: '这是原有有效摘要。', limitations: [] });
    const presented = presentMemberAssessment(snapshot);
    expect(presented.systems[1]).toBe(snapshot.systems[1]);
    expect(presented.systems[1]!.status).toBe('no_signal_in_scope');
  });

  it('摘要容量不足时整条留在详情，绝不截掉尾部否定或不确定条件', () => {
    const snapshot = fixture();
    snapshot.claims[0]!.materialUncertainty = '合成条件。'.repeat(397);
    snapshot.claims[1]!.text = '前文。'.repeat(400) + '但不能据此确诊。';
    const presented = presentMemberAssessment(snapshot);
    expect(presented.systems[0]!.summary).toContain('完整检查条件');
    expect(presented.claims[0]!.materialUncertainty).toBe(snapshot.claims[0]!.materialUncertainty);
    expect(presented.claims[1]!.text).toBe(snapshot.claims[1]!.text);
    expect(memberAssessmentSnapshotV3Schema.safeParse(presented).success).toBe(true);
  });

  it('正文摘要不因子串相似删掉否定相反的条件', () => {
    const snapshot = fixture();
    snapshot.claims[0]!.text = '本次不符合参考条件。';
    snapshot.claims[0]!.materialUncertainty = '符合参考条件。';
    expect(presentMemberAssessment(snapshot).systems[0]!.summary).toContain('符合参考条件。');
  });

  it('无局部隔离且没有过程文案的正常结果完全不变', () => {
    const snapshot = fixture();
    snapshot.heldTargetIds = [];
    snapshot.overview = { ...snapshot.overview, headline: '检查甲有变化', summary: '请结合检查甲的条件理解。' };
    snapshot.systems = [{ ...snapshot.systems[0]!, headline: '检查甲有变化', summary: '请结合检查甲的条件理解。', limitations: [] }];
    expect(presentMemberAssessment(snapshot)).toBe(snapshot);
  });

  it('未 held 的旧结果也清理动态过程表达，保留数值、否定和检查条件且不改来源档案', () => {
    const snapshot = fixture();
    snapshot.heldTargetIds = [];
    snapshot.claims[0] = { ...snapshot.claims[0]!,
      text: '已接纳的空腹血糖 5.2 mmol/L，仍不能说明长期血糖水平。',
      rationale: '采用输入的体重指数趋势事实。',
      materialUncertainty: '尚未提供用药及症状信息；两次检测条件不一致，不能直接比较。' };
    snapshot.overview = { ...snapshot.overview,
      headline: snapshot.claims[0]!.text,
      summary: '经模型核对，空腹血糖 5.2 mmol/L。两次检测条件不一致，不能直接比较。' };
    snapshot.systems = [{ ...snapshot.systems[0]!, headline: snapshot.claims[0]!.text,
      summary: snapshot.overview.summary, limitations: ['部分判断因证据不足暂未发布。', '尚未提供当前用药信息。'] }];
    snapshot.evidenceCatalog = [{ id: 'source-1', kind: 'observation', observationId: 'observation-1',
      eventId: null, documentId: 'document-1', sourceSpanId: 'span-1', knowledgeId: null,
      label: '合成原报告', locator: '2025-06-10', quote: '原图核对：空腹血糖 5.2 mmol/L。' }];
    const before = JSON.stringify(snapshot);
    const presented = presentMemberAssessment(snapshot);
    expect(presented.claims[0]!.text).toContain('空腹血糖 5.2 mmol/L');
    expect(presented.claims[0]!.text).toContain('仍不能说明长期血糖水平');
    expect(presented.claims[0]!.text).not.toContain('已接纳');
    expect(presented.claims[0]!.rationale).not.toContain('采用输入');
    expect(presented.claims[0]!.materialUncertainty).toBe(snapshot.claims[0]!.materialUncertainty);
    expect(presented.systems[0]!.summary).toContain('空腹血糖 5.2 mmol/L');
    expect(presented.systems[0]!.summary).not.toContain('模型核对');
    expect(presented.systems[0]!.limitations).toEqual(['尚未提供当前用药信息。']);
    expect(presented.presentation?.rebuiltNodeIds).toEqual([]);
    expect(presented.evidenceCatalog).toBe(snapshot.evidenceCatalog);
    expect(JSON.stringify(snapshot)).toBe(before);
    expect(presentMemberAssessment(presented)).toEqual(presented);
    expect(memberAssessmentSnapshotV3Schema.safeParse(presented).success).toBe(true);
  });

  it('旧行动和重要未知也经过同一投影，临床复查和用药条件不会被当成处理过程', () => {
    const snapshot = fixture();
    snapshot.actions = [{ id: 'action-visible', dedupeKey: 'followup', systemIds: ['cardiovascular'],
      claimIds: ['claim-first'], kind: 'test_followup', title: '经模型复核，复查相关检查',
      why: '两次检查条件不同，不能直接比较。', firstStep: '整理既往检查日期和当时用药情况。',
      timing: '下次就诊时', timingBasis: 'none', reviewPlan: '向医生说明是否空腹及用药情况。',
      caution: '不要自行调整药物。', urgency: 'routine', evidenceIds: ['source-1'], knowledgeSourceIds: [] }];
    snapshot.questions = [{ id: 'question-visible', question: '经模型复核，目前是否仍在服药？',
      whyItMatters: '用药会影响这次检查结果的解释。', relatedClaimIds: ['claim-first'], evidenceIds: ['source-1'] }];
    const presented = presentMemberAssessment(snapshot);
    expect(presented.actions[0]!.title).toBe('复查相关检查');
    expect(presented.actions[0]!.why).toBe(snapshot.actions[0]!.why);
    expect(presented.actions[0]!.caution).toBe('不要自行调整药物。');
    expect(presented.questions[0]!.question).toBe('目前是否仍在服药？');
    expect(presented.questions[0]!.whyItMatters).toBe(snapshot.questions[0]!.whyItMatters);
  });

  it.each(['current', 'stale'] as const)('无法精确分离临床限制的%s旧结果不删条件后留下肯定结论，原始依据仍在', (status) => {
    const snapshot = fixture();
    snapshot.status = status;
    snapshot.heldTargetIds = [];
    snapshot.claims[0]!.materialUncertainty = 'P03尚未完成且本次未散瞳，不能据此确认近视程度。';
    snapshot.claims.push({ ...claim('claim-independent', '2025年肺部检查报告未提示该项异常。'),
      systemIds: ['respiratory'], evidenceIds: ['source-independent'] });
    snapshot.systems[0]!.status = 'no_signal_in_scope';
    snapshot.systems.push({ ...snapshot.systems[0]!, id: 'system:respiratory', systemId: 'respiratory',
      headline: '2025年肺部检查报告未提示该项异常。', summary: '仍需结合当前症状理解。',
      claimIds: ['claim-independent'], limitations: [] });
    snapshot.actions = [action('action-dependent', 'claim-first'), action('action-same-source', 'claim-second'),
      { ...action('action-independent', 'claim-independent', 'source-independent'), systemIds: ['respiratory'] }];
    snapshot.systems[0]!.actionIds = ['action-dependent', 'action-same-source'];
    snapshot.overview.actionIds = ['action-dependent'];
    snapshot.questions = [{ id: 'question-dependent', question: '是否还有其他症状？',
      whyItMatters: '症状影响理解。', relatedClaimIds: ['claim-first'], evidenceIds: ['source-1'] }];
    snapshot.evidenceCatalog = [{ id: 'source-1', kind: 'source_span', observationId: null, eventId: null,
      documentId: 'synthetic-document', sourceSpanId: 'synthetic-span', knowledgeId: null,
      label: '合成验光报告', locator: '第1页', quote: '本次未散瞳，不能据此确认近视程度。' }];
    const before = JSON.stringify(snapshot);
    const presented = presentMemberAssessment(snapshot);
    expect(presented.claims.map((claim) => claim.id)).toEqual(['claim-independent']);
    expect(presented.actions.map((action) => action.id)).toEqual(['action-independent']);
    expect(presented.questions).toEqual([]);
    expect(presented.systems[0]!.claimIds).toEqual([]);
    expect(presented.systems[0]!.status).toBe('insufficient');
    expect(presented.systems[0]!.headline).toBe('相关检查记录');
    expect(presented.systems[1]).toBe(snapshot.systems[1]);
    expect(presented.evidenceCatalog).toBe(snapshot.evidenceCatalog);
    expect(presented.evidenceCatalog[0]!.quote).toContain('未散瞳');
    expect(presented.heldTargetIds).toBe(snapshot.heldTargetIds);
    expect(containsProcessNarrative(presented.systems[0]!.summary)).toBe(false);
    expect(JSON.stringify(snapshot)).toBe(before);
    expect(presentMemberAssessment(presented)).toEqual(presented);
    expect(memberAssessmentSnapshotV3Schema.safeParse(presented).success).toBe(true);
  });

  it('系统摘要自身的混合临床限制不能单独删掉并继续显示本范围正常', () => {
    const snapshot = fixture();
    snapshot.heldTargetIds = [];
    snapshot.systems[0]!.status = 'no_signal_in_scope';
    snapshot.systems[0]!.headline = '本次眼部检查未提示问题';
    snapshot.systems[0]!.summary = '可以继续按日常习惯用眼。';
    snapshot.systems[0]!.limitations = ['本次未散瞳与P04处于同一条记录，但不能据此确认近视程度。'];
    const presented = presentMemberAssessment(snapshot);
    expect(presented.claims).toEqual([]);
    expect(presented.systems[0]!.status).toBe('insufficient');
    expect(presented.systems[0]!.headline).toBe('相关检查记录');
    expect(presented.systems[0]!.summary).not.toContain('继续按日常习惯');
    expect(snapshot.systems[0]!.limitations[0]).toContain('未散瞳');
  });

  it('不把纯过程行动改写成一个新建议，也不显示夹带过程的提问', () => {
    const snapshot = fixture();
    snapshot.actions = [{ ...action('action-unreadable', 'claim-first'),
      caution: '模型复核尚未完成但目前用药未知，不能自行调整药物。' },
    { ...action('action-process', 'claim-second'), firstStep: 'P04已通过。' }];
    snapshot.questions = [{ id: 'question-unreadable', question: 'P03尚未完成且目前是否用药未知？',
      whyItMatters: '用药影响理解。', relatedClaimIds: ['claim-first'], evidenceIds: ['source-1'] }];
    const presented = presentMemberAssessment(snapshot);
    expect(presented.actions).toEqual([]);
    expect(presented.questions).toEqual([]);
    expect(presented.claims).toBe(snapshot.claims);
    expect(snapshot.actions[0]!.caution).toContain('不能自行调整药物');
  });
});
