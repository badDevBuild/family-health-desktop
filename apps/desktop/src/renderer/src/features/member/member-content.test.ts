import { describe, expect, it } from 'vitest';
import { presentAssessmentText, type HealthAction, type HealthEventV2, type InboxItem, type MemberEvidenceRef, type MemberAssessmentSnapshotV3 } from '@contracts';
import { bodySystemRegistry } from '@core';
import { actionStatusLabel, additionalMemberText, adoptedActionTitle, bodySystemNames, documentStatusLabel, eventSourceGroups, memberActionFirstStep, memberEventSummary, memberText, reportAdviceSource, reportDates, reportPlanSource, savedActionTitle, uniqueMemberTexts } from './member-content.js';

describe('成员内容展示辅助', () => {
  it('派生正文复用安全引用标签化，完整保留条件、否定、左右侧、数值和段落', () => {
    const text = '左眼 0.8、右眼 1.0，参见[检查条件与限制](https://example.com/conditions)。\n[未散瞳，不能确认屈光状态](https://example.com/limitations)；结果 <0.1，仍需结合当时用药。';
    expect(memberText(text)).toBe('左眼 0.8、右眼 1.0，参见检查条件与限制。\n未散瞳，不能确认屈光状态；结果 <0.1，仍需结合当时用药。');
    expect(additionalMemberText(text, [])).toBe('左眼 0.8、右眼 1.0，参见检查条件与限制。\n\n未散瞳，不能确认屈光状态；结果 <0.1，仍需结合当时用药。');
  });

  it.each([
    '<img src=x onerror=alert(1)>', '![原图](https://example.com/image)', '[资料](javascript:alert(1))',
    '[本机](file:///tmp/report)', '[HTTP](http://example.com/source)', '[认证](https://user:pass@example.com/source)',
    '[未完成](https://example.com/source\n不能说明没有问题。'
  ])('派生正文不解释 HTML、图片、非法协议、认证 URL 或不完整 Markdown：%s', (text) => {
    expect(memberText(text)).toBe(text);
    expect(memberText(null)).toBe('');
    expect(memberText(undefined)).toBe('');
  });

  it('组合内容沿用既有过程清理的标点行为，图片标签及后续医学限制不丢失', () => {
    const text = '<img src=x onerror=alert(1)>\n![原图](https://example.com/image)\n[本机](file:///tmp/report)\n不能说明没有问题。';
    // 路径触发的旧过程分句清理会去掉 !；本轮不改写该契约，也不将结果解释成 HTML 或图片。
    expect(presentAssessmentText(text).text).toBe(text.replace('![原图]', '[原图]'));
    expect(memberText(text)).toBe(text.replace('![原图](https://example.com/image)', '原图'));
  });

  it('引用显示整理只用于 AI 行动标题，本人和原医生安排的相同文字保持原样', () => {
    const title = '参照[检查条件](https://example.com/conditions)，没有不适时不要自行提前安排。';
    expect(savedActionTitle(title, 'ai_proposed')).toBe('参照检查条件，没有不适时不要自行提前安排。');
    expect(savedActionTitle(title, 'user_created')).toBe(title);
    expect(savedActionTitle(title, 'clinician_document')).toBe(title);
    expect(adoptedActionTitle({ title, proposalId: null, assessmentDedupeKey: 'source-arrangement' })).toBe(title);
  });

  it('原句绑定的医生安排完整保留，派生做法才整理引用显示', () => {
    const firstStep = '参照[报告中的安排](https://example.com/source)，若持续不适请三天内复查；没有不适时无需自行提前。';
    expect(memberActionFirstStep({ kind: 'documented_plan', sourceInstructionObservationId: 'source-instruction', firstStep })).toBe(firstStep);
    expect(memberActionFirstStep({ kind: 'test_followup', firstStep })).toBe('参照报告中的安排，若持续不适请三天内复查；没有不适时无需自行提前。');
  });

  it('只整理 AI 派生的行动标题，不改写本人安排或医生原文', () => {
    const text = '经模型核对，未散瞳，不能据此确认屈光状态。';
    expect(savedActionTitle(text, 'ai_proposed')).toBe('未散瞳，不能据此确认屈光状态。');
    expect(savedActionTitle(text, 'user_created')).toBe(text);
    expect(savedActionTitle(text, 'clinician_document')).toBe(text);
    expect(savedActionTitle('P03验证通过。', 'ai_proposed')).toBe('已保存的行动安排');
    expect(adoptedActionTitle({ title: text, proposalId: null, assessmentDedupeKey: null })).toBe(text);
    expect(adoptedActionTitle({ title: text, proposalId: 'known-proposal' })).toBe('未散瞳，不能据此确认屈光状态。');
    expect(adoptedActionTitle({ title: text, proposalId: null, assessmentDedupeKey: 'known-assessment' })).toBe(text);
  });

  it.each([
    '未散瞳且P03确认可以继续运动，仍需结合用药情况。',
    '用药情况未记录且依据成员 123e4567-e89b-12d3-a456-426614174000 安排活动。',
    '未散瞳且参考 /Volumes/健康/检查记录 调整做法。',
    '用药情况未知且参考 C:/reports/checkup 调整做法。',
    '未散瞳且参考 2025体检.pdf 安排下一步。'
  ])('无法安全剥离的 AI 混合标题不当作做法，同句本人及医生原文保留：%s', (text) => {
    expect(savedActionTitle(text, 'ai_proposed')).toBe('已有行动记录，安排前需确认依据');
    expect(savedActionTitle(text, 'user_created')).toBe(text);
    expect(savedActionTitle(text, 'clinician_document')).toBe(text);
    expect(adoptedActionTitle({ title: text, proposalId: 'known-proposal' })).toBe('已有行动记录，安排前需确认依据');
  });

  it('附件按真实文件和位置归并，全部引用仍保留，未知页码不被补造', () => {
    const refs = Array.from({ length: 71 }, (_, index) => ({ id: `ref-${index}`, documentId: 'report', sourceSpanId: `span-${index}`, locator: index < 35 ? '第1页' : '第2页' })) as MemberEvidenceRef[];
    const groups = eventSourceGroups(refs);
    expect(groups).toHaveLength(2);
    expect(groups.flatMap((group) => group.sources)).toEqual(refs);
    const noPages = refs.map((ref) => ({ ...ref, locator: null }));
    expect(eventSourceGroups(noPages)).toHaveLength(1);
    expect(eventSourceGroups(noPages)[0]!.sources.every((source) => source.locator === null)).toBe(true);
    expect(eventSourceGroups([{ ...refs[0]!, documentId: null }, { ...refs[1]!, documentId: null }])).toHaveLength(2);
  });

  it('检查摘要保留历史结果事实，去掉拆分记录的工程过程', () => {
    expect(memberEventSummary('本次检查有记录。报告中另有历史对比结果，已与本次检查分开。'))
      .toBe('本次检查有记录。原报告还含历史对比结果。');
    expect(memberEventSummary('检测方法不同，暂不能直接比较。')).toBe('检测方法不同，暂不能直接比较。');
  });
  it('同一句只呈现一次，新增临床条件保留', () => {
    const headline = '这个指标比上次高。';
    expect(additionalMemberText('这个指标比上次高。未记录当时是否服药，不能确定变化原因。', [headline]))
      .toBe('未记录当时是否服药，不能确定变化原因。');
    expect(uniqueMemberTexts(['未散瞳，不能据此确认屈光状态。', '未散瞳，不能据此确认屈光状态。', '检测方法不同，暂不能直接比较。']))
      .toEqual(['未散瞳，不能据此确认屈光状态。', '检测方法不同，暂不能直接比较。']);
  });

  it.each([
    ['血糖 5.2 mmol/L。', '血糖 52 mmol/L。'],
    ['结果 <0.1。', '结果 0.1。'],
    ['结果 <0.1。', '结果 ≤0.1。'],
    ['不符合参考条件。', '符合参考条件。'],
    ['尚不能确认这项变化。', '能确认这项变化。'],
    ['检查结果已记录。', '检查结果已记录，未提供当时的用药信息。'],
    ['结果 5 mg/L。', '结果 5 Mg/L。'],
    ['结果 5×10⁹/L。', '结果 5×109/L。']
  ])('不同数值、符号、否定与新增条件不去重：%s / %s', (previous, next) => {
    expect(additionalMemberText(next, [previous])).toBe(next);
    expect(uniqueMemberTexts([previous, next])).toEqual([previous, next]);
  });

  it('只删除相同的完整句子，段落里的已知句子也只出现一次', () => {
    expect(additionalMemberText('检查条件未记录。需要结合本人情况。', ['这次检查有记录。检查条件未记录。']))
      .toBe('需要结合本人情况。');
    expect(additionalMemberText('检查条件未记录。', ['检查条件未记录'])).toBe('');
    expect(additionalMemberText('检查条件未记录？', ['检查条件未记录。'])).toBe('检查条件未记录？');
  });

  it('正文去重保留分段，医学限制和完整行动提醒不压成一团', () => {
    const finding = '2025年TSH高于该次报告范围。';
    const condition = '尚未提供当时的用药信息，不能说明今天仍持续偏高。';
    const action = '下一步：就诊时带上既往报告。不要自行开始或调整处方药。';
    expect(additionalMemberText(`${finding}\n${condition}\n\n${action}`, [finding]))
      .toBe(`${condition}\n\n${action}`);
    expect(additionalMemberText(`${condition}\n\n${condition}\n${action}`, []))
      .toBe(`${condition}\n\n${action}`);
  });

  it('十二个身体系统都有中文名称', () => {
    expect(bodySystemRegistry).toHaveLength(12);
    for (const system of bodySystemRegistry) {
      expect(bodySystemNames[system.id]).toMatch(/[\u4e00-\u9fff]/);
      expect(bodySystemNames[system.id]).not.toContain(system.id);
    }
  });

  it('所有原始资料状态都使用中文', () => {
    const statuses: InboxItem['status'][] = ['queued', 'needs_review', 'duplicate', 'blocked', 'processing', 'completed', 'ignored', 'stabilizing', 'discovered'];
    for (const status of statuses) expect(documentStatusLabel(status)).toMatch(/[\u4e00-\u9fff]/);
    expect(actionStatusLabel('planned')).toBe('已计划');
    expect(actionStatusLabel('建议，尚未加入我的计划')).toBe('尚未加入计划');
    expect(actionStatusLabel('unknown-status')).toBe('未注明进度');
  });

  it('医生建议日期来自其检查事件，不拿今天或其他报告的日期替代', () => {
    const events = [
      { id: 'event-old', documentIds: ['doc-1'], time: { value: '2024-05-01', displayLabel: '2024-05-01' } },
      { id: 'event-new', documentIds: ['doc-1'], time: { value: '2026-06-01', displayLabel: '2026-06-01' } },
      { id: 'event-unknown', documentIds: ['doc-2'], time: { value: null, displayLabel: '日期不明' } }
    ] as HealthEventV2[];
    const dates = reportDates(events);
    expect(dates['doc-1']).toBeUndefined();
    expect(dates['doc-2']).toBeUndefined();
    const evidence = { id: 'source', kind: 'clinical_finding', eventId: 'event-old', documentId: 'doc-1', label: '原体检报告' } as MemberEvidenceRef;
    expect(reportAdviceSource([evidence], dates)).toBe('2024-05-01 · 原体检报告');
    expect(reportAdviceSource([{ ...evidence, eventId: null }], dates)).toBe('日期未记录 · 原体检报告');
    expect(reportAdviceSource([], dates)).toBe('来源日期未记录');
  });

  it('只有具体安排原文和真实检查日期同时存在时，才能标作报告中的医生建议', () => {
    const action = { kind: 'documented_plan' as const, timingBasis: 'documented' as const, title: '三个月后复查血脂', firstStep: '复查血脂', timing: '三个月后', evidenceIds: ['source'] };
    const evidence = { id: 'source', kind: 'clinical_finding', eventId: 'exam', documentId: 'report', sourceSpanId: 'span', label: '体检报告', quote: '医生建议：三个月后复查血脂。' } as MemberEvidenceRef;
    expect(reportPlanSource(action, [evidence], { exam: '2024-05-01' })).toBe('2024-05-01 · 体检报告');
    expect(reportPlanSource(action, [evidence], {})).toBeNull();
    expect(reportPlanSource(action, [{ ...evidence, quote: '血脂检查结果已记录。' }], { exam: '2024-05-01' })).toBeNull();
    expect(reportPlanSource(action, [{ ...evidence, sourceSpanId: null }], { exam: '2024-05-01' })).toBeNull();
  });

  it('原句绑定行动需同一已发布复核上下文，不经旧措辞门禁，也不从无效新路径降回旧证明', () => {
    const firstStep = '医生安排：若合成不适持续，四周之后到合成门诊评估。没有新不适时无需自行提前检查。';
    const action: HealthAction = { id: 'synthetic-action', dedupeKey: 'synthetic', kind: 'documented_plan',
      systemIds: [], claimIds: [], title: '报告中的医生建议', why: '合成说明', firstStep, timing: null,
      timingBasis: 'none', reviewPlan: null, caution: null, urgency: 'routine', evidenceIds: ['source'], knowledgeSourceIds: [],
      sourceInstructionObservationId: 'synthetic-observation' };
    const source: MemberEvidenceRef = { id: 'source', kind: 'observation', observationId: 'synthetic-observation',
      eventId: 'exam', documentId: 'report', sourceSpanId: 'span', knowledgeId: null, label: '合成报告', locator: '第1页',
      quote: `合成栏目。${firstStep}` };
    const assessment: MemberAssessmentSnapshotV3 = { schemaVersion: 3, inputSignature: 'a'.repeat(64), mode: 'full', requestedSystemIds: [],
      id: 'synthetic-snapshot', personId: 'synthetic-person', status: 'current',
      overview: { id: 'overview', headline: '合成总览', summary: '合成说明', claimIds: [], actionIds: [action.id], limitations: [] },
      claims: [], systems: [], questions: [], knowledgeSources: [], factRevision: 1, contextRevision: 0,
      reviewScopeSignature: 'b'.repeat(64), generatedAt: '2026-01-01T00:00:00Z', promptVersion: 'synthetic', rulesVersion: 'synthetic',
      modelId: 'synthetic', reasoningEffort: 'medium', limitations: [], knowledgeVerifications: [],
      processingPlan: { strategy: 'full', trigger: 'none', partitionCount: 0 },
      actions: [action], validationMode: 'local_and_focused_review', reviewedTargetIds: [action.id], heldTargetIds: [],
      evidenceCatalog: [source] };
    expect(reportPlanSource(action, [source], { exam: '2026-01-01' }, assessment)).toBe('2026-01-01 · 合成报告');
    expect(reportPlanSource(action, [source], {}, assessment)).toBeNull();
    expect(reportPlanSource(action, [source], { exam: '2026-01-01' })).toBeNull();
    expect(reportPlanSource({ ...action, firstStep: firstStep.replace('无需', '需要') }, [source], { exam: '2026-01-01' }, assessment)).toBeNull();
    assessment.reviewedTargetIds = [];
    expect(reportPlanSource(action, [source], { exam: '2026-01-01' }, assessment)).toBeNull();
  });
});
