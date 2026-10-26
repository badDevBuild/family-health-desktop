import { describe, expect, it } from 'vitest';
import { directOriginalDateReadingSchema, inspectDirectOriginalDateConsensus,
  type DirectOriginalDateReading } from './direct-original-date-reading.js';

const scope = { documentId: 'synthetic-document', pageIds: ['page-a', 'page-b'],
  factScopeIds: ['fact_1', 'fact_2'], acceptedReportedNames: ['合成成员', '合成别名'] };
function reading(): DirectOriginalDateReading { return { schemaVersion: 1, documentId: scope.documentId,
  subject: { reportedName: '合成成员', confidence: 'explicit', evidence: [
    { pageSourceSpanId: 'page-a', quote: '姓名：合成成员', clarity: 'clear' }] },
  dates: [{ localKey: 'exam', value: '2027-04-05', role: 'examined', pageSourceSpanId: 'page-a',
    quote: '检查日期：2027年4月5日', clarity: 'clear', factScopeIds: ['fact_1', 'fact_2'] }], primaryClinicalDateKey: 'exam' }; }
const inspect = (a: DirectOriginalDateReading, b = reading()) => inspectDirectOriginalDateConsensus(a, b, scope);
describe('完整原件日期双盲共识契约', () => {
  it('日期、角色、页和同组关联一致才给日期赋值；没有签发日期不制造签发日', () => {
    const result = inspect(reading()); expect(result.issues).toEqual([]);
    expect(result.assignments).toHaveLength(2); expect(result.issued).toBeNull();
  });
  it('两个已确认别名可以独立出现在同一原件，不能从显示名补证', () => {
    const a = reading(); a.subject.reportedName = '合成别名'; a.subject.evidence[0]!.quote = '姓名：合成别名';
    expect(inspect(a).issues).toEqual([]);
  });
  it.each(['absent', 'uncertain', 'masked', 'different', 'no_evidence', 'unclear_evidence', 'quote_mismatch'] as const)(
    '用户明确归属时%s主体不阻断日期共识，也不把原件身份改成已确认', (mode) => {
      const a = reading();
      if (mode === 'absent' || mode === 'uncertain') a.subject = { reportedName: null, confidence: mode, evidence: [] };
      if (mode === 'masked' || mode === 'different') {
        a.subject.reportedName = mode === 'masked' ? '*成员' : '另一合成成员';
        a.subject.evidence[0]!.quote = `患者姓名：${a.subject.reportedName}`;
      }
      if (mode === 'no_evidence') a.subject.evidence = [];
      if (mode === 'unclear_evidence') a.subject.evidence[0]!.clarity = 'uncertain';
      if (mode === 'quote_mismatch') a.subject.evidence[0]!.quote = '原件患者身份未能读取';
      const b = structuredClone(a); const before = structuredClone({ a, b });
      const result = inspectDirectOriginalDateConsensus(a, b, { ...scope, subjectPolicy: 'user_assigned' });
      expect(result.issues).toEqual([]);
      expect(result.assignments).toHaveLength(2);
      expect(result.primary?.value).toBe('2027-04-05');
      expect({ a, b }).toEqual(before);
      expect(inspect(a, b).issues).toContain('date_blind_subject_unproven');
    });
  it.each(['subject_page', 'date_page', 'document', 'date_value', 'date_quote', 'role', 'scope'] as const)(
    '用户明确归属不能绕过%s来源及日期门禁', (mode) => {
      const a = reading(); const d = a.dates[0]!;
      a.subject = { reportedName: null, confidence: 'uncertain', evidence: [] };
      if (mode === 'subject_page') a.subject.evidence = [{ pageSourceSpanId: 'foreign-page', quote: '合成身份', clarity: 'uncertain' }];
      if (mode === 'date_page') d.pageSourceSpanId = 'foreign-page';
      if (mode === 'document') a.documentId = 'foreign-document';
      if (mode === 'date_value') { d.value = '2028-04-05'; d.quote = '检查日期：2028-04-05'; }
      if (mode === 'date_quote') d.quote = '检查日期：2028-04-05';
      if (mode === 'role') d.role = 'report_issued';
      if (mode === 'scope') d.factScopeIds = ['foreign-fact'];
      const result = inspectDirectOriginalDateConsensus(a, reading(), { ...scope, subjectPolicy: 'user_assigned' });
      expect(result.issues.length).toBeGreaterThan(0);
      expect(result.issues).not.toContain('date_blind_subject_unproven');
    });
  it.each(['document', 'subject', 'foreign_name', 'subject_page', 'date_page', 'unknown_scope', 'duplicate_key',
    'missing_scope', 'duplicate_scope', 'null_date', 'unknown_role', 'history', 'unclear', 'empty_quote',
    'quote_date_mismatch', 'different_date', 'different_role', 'different_page', 'primary_wrong_group'] as const)('%s 不得产生可提交的共识', (mode) => {
    const a = reading(); const d = a.dates[0]!;
    if (mode === 'document') a.documentId = 'other-document';
    if (mode === 'subject') a.subject.confidence = 'absent';
    if (mode === 'foreign_name') { a.subject.reportedName = '未授权主体'; a.subject.evidence[0]!.quote = '姓名：未授权主体'; }
    if (mode === 'subject_page') a.subject.evidence[0]!.pageSourceSpanId = 'other-page';
    if (mode === 'date_page') d.pageSourceSpanId = 'other-page';
    if (mode === 'unknown_scope') d.factScopeIds.push('foreign-fact');
    if (mode === 'duplicate_key') a.dates.push({ ...d });
    if (mode === 'missing_scope') d.factScopeIds.pop();
    if (mode === 'duplicate_scope') d.factScopeIds.push('fact_1');
    if (mode === 'null_date') d.value = null;
    if (mode === 'unknown_role') d.role = 'unknown';
    if (mode === 'history') d.role = 'history_quoted';
    if (mode === 'unclear') d.clarity = 'uncertain';
    if (mode === 'empty_quote') d.quote = null;
    if (mode === 'quote_date_mismatch') d.quote = '检查日期：2028年4月5日';
    if (mode === 'different_date') { d.value = '2028-04-05'; d.quote = '检查日期：2028年4月5日'; }
    if (mode === 'different_role') d.role = 'sampled';
    if (mode === 'different_page') d.pageSourceSpanId = 'page-b';
    if (mode === 'primary_wrong_group') { a.dates.push({ ...d, localKey: 'other', pageSourceSpanId: 'page-b', factScopeIds: [] }); a.primaryClinicalDateKey = 'other'; }
    expect(inspect(a).issues.length).toBeGreaterThan(0);
  });
  it('同日期/角色/页按全组或按每个事实分组，以及数组重排不改变共识', () => {
    const a = reading(); a.dates[0]!.factScopeIds = ['fact_1'];
    a.dates.push({ ...a.dates[0]!, localKey: 'other', factScopeIds: ['fact_2'] }); a.dates.reverse();
    expect(inspect(a).issues).toEqual([]);
    expect(inspectDirectOriginalDateConsensus(reading(), a, scope).issues).toEqual([]);
  });
  it('签发日必须两读都明确且同页一致', () => {
    const a = reading(); a.dates.push({ ...a.dates[0]!, localKey: 'issued', role: 'report_issued',
      quote: '签发日期：2027-04-05', factScopeIds: [] });
    expect(inspect(a).issues).toContain('date_blind_issued_date_disagrees');
    expect(inspect(a, structuredClone(a)).issued?.value).toBe('2027-04-05');
  });
  it.each(['检查时间：20270405060708', '检查日期：２０２７／４／５', '检查日期：5-4-2027（日期格式 DMY）'])('沿用已有日期格式校验：%s', (quote) => {
    const a = reading(); a.dates[0]!.quote = quote;
    if (quote.includes('DMY')) expect(inspect(a).issues).toContain('date_blind_date_quote_inconsistent');
    else expect(inspect(a).issues).toEqual([]);
  });
  it('结构不接受医疗值或不合法日历日', () => {
    expect(directOriginalDateReadingSchema.safeParse({ ...reading(), medicalValue: '不允许' }).success).toBe(false);
    const a = reading(); a.dates[0]!.value = '2027-02-30'; expect(directOriginalDateReadingSchema.safeParse(a).success).toBe(false);
  });
});
