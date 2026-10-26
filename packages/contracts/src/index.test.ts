import { describe, expect, it } from 'vitest';
import { localDateSchema, personSummarySchema, processNowInputSchema, reportMetadataCandidateSchema, resolveReviewInputSchema } from './index.js';
import { clinicalTimeSchema } from './member-v2.js';

describe('手动处理范围契约', () => {
  const consent = { consentVersion: 1, confirmedDataRecipient: 'OpenAI/Codex' };
  const expectedAssessmentDataRevision = 'a'.repeat(64);

  it('兼容全量和指定报告，并接受独立的指定成员综合范围', () => {
    expect(processNowInputSchema.parse(consent)).toEqual(consent);
    expect(processNowInputSchema.parse({ ...consent, documentIds: ['synthetic-document'] }).documentIds)
      .toEqual(['synthetic-document']);
    expect(processNowInputSchema.parse({ ...consent, assessmentPersonId: 'synthetic-person', expectedAssessmentDataRevision }).assessmentPersonId)
      .toBe('synthetic-person');
  });

  it('拒绝混用两种范围、非法成员标识和未定义字段', () => {
    expect(processNowInputSchema.safeParse({ ...consent, documentIds: ['synthetic-document'],
      assessmentPersonId: 'synthetic-person', expectedAssessmentDataRevision }).success).toBe(false);
    for (const assessmentPersonId of ['', ' ', ' synthetic-person', 'synthetic\nperson', 'x'.repeat(121), null, 7, []]) {
      expect(processNowInputSchema.safeParse({ ...consent, assessmentPersonId, expectedAssessmentDataRevision }).success).toBe(false);
    }
    expect(processNowInputSchema.safeParse({ ...consent, personId: 'synthetic-person' }).success).toBe(false);
  });

  it('成员与确认版本必须成对，版本只能是64位小写hex，报告路径不能带综合版本', () => {
    expect(processNowInputSchema.safeParse({ ...consent, assessmentPersonId: 'synthetic-person' }).success).toBe(false);
    expect(processNowInputSchema.safeParse({ ...consent, expectedAssessmentDataRevision }).success).toBe(false);
    expect(processNowInputSchema.safeParse({ ...consent, documentIds: ['synthetic-document'], expectedAssessmentDataRevision }).success).toBe(false);
    for (const revision of ['', 'a'.repeat(63), 'a'.repeat(65), 'A'.repeat(64), 'g'.repeat(64), null, 7]) {
      expect(processNowInputSchema.safeParse({ ...consent, assessmentPersonId: 'synthetic-person',
        expectedAssessmentDataRevision: revision }).success).toBe(false);
    }
  });
});

describe('综合更新必要性契约', () => {
  it('兼容旧快照，并区分无需、必须及可选规则更新，不复用健康结论状态', () => {
    const field = personSummarySchema.shape.assessmentRefreshStatus;
    for (const value of [undefined, 'none', 'required', 'optional_rules']) expect(field.safeParse(value).success).toBe(true);
    for (const value of [null, 'stale', 'current', 'optional', true]) expect(field.safeParse(value).success).toBe(false);
  });
});

describe('本地日期契约', () => {
  it('接受真实日历日，拒绝只是格式像日期的无效值', () => {
    expect(localDateSchema.safeParse('2024-02-29').success).toBe(true);
    expect(localDateSchema.safeParse('2025-02-29').success).toBe(false);
    expect(localDateSchema.safeParse('2026-13-40').success).toBe(false);
  });
});

describe('报告元数据日期契约', () => {
  const base = {
    reportKind: null, title: null, organization: null, campus: null,
    department: null, reportNumber: null, examItems: []
  };

  it('保留年/月精度并拒绝补造或无效日期', () => {
    const evidence = [{ sourceSpanId: 'span-1', quote: '2024 年' }];
    expect(reportMetadataCandidateSchema.safeParse({ ...base, times: [{ value: '2024', precision: 'year', role: 'history_quoted', evidence }] }).success).toBe(true);
    expect(reportMetadataCandidateSchema.safeParse({ ...base, times: [{ value: '2024-06', precision: 'month', role: 'examined', evidence }] }).success).toBe(true);
    expect(reportMetadataCandidateSchema.safeParse({ ...base, times: [{ value: '2024-01-01', precision: 'year', role: 'history_quoted', evidence }] }).success).toBe(false);
    expect(reportMetadataCandidateSchema.safeParse({ ...base, times: [{ value: '2024-13', precision: 'month', role: 'examined', evidence }] }).success).toBe(false);
  });

  it('只把带字段证据的检查批次号和样本号纳入元数据', () => {
    const evidence = [{ sourceSpanId: 'span-id', quote: '检查单号 E-001 样本号 S-009' }];
    expect(reportMetadataCandidateSchema.safeParse({
      ...base,
      encounterIdentifier: { value: 'E-001', evidence },
      sampleIdentifiers: [{ value: 'S-009', evidence }],
      times: []
    }).success).toBe(true);
    expect(reportMetadataCandidateSchema.safeParse({
      ...base,
      encounterIdentifier: { value: 'E-001', evidence: [] },
      sampleIdentifiers: [],
      times: []
    }).success).toBe(false);
  });
  it('主要临床时间索引保留明确未知及旧版兼容，不把负数、小数或文本当索引', () => {
    const evidence = [{ sourceSpanId: 'synthetic-date', quote: '合成检查日期' }];
    const metadata = { ...base, times: [{ value: '2025-03-04', precision: 'day', role: 'examined', evidence }] };
    expect(reportMetadataCandidateSchema.parse({ ...metadata, primaryClinicalTimeIndex: 0 }).primaryClinicalTimeIndex).toBe(0);
    expect(reportMetadataCandidateSchema.parse({ ...metadata, primaryClinicalTimeIndex: null }).primaryClinicalTimeIndex).toBeNull();
    expect(reportMetadataCandidateSchema.parse(metadata).primaryClinicalTimeIndex).toBeUndefined();
    for (const invalid of [-1, 0.5, '0', Infinity]) {
      expect(reportMetadataCandidateSchema.safeParse({ ...metadata, primaryClinicalTimeIndex: invalid }).success).toBe(false);
    }
  });
});

describe('成员时间线日期精度契约', () => {
  const base = { endValue: null, role: 'exam' as const, source: 'explicit' as const, displayLabel: '合成日期' };

  it('允许年和月精度，但拒绝值与精度不匹配', () => {
    expect(clinicalTimeSchema.safeParse({ ...base, value: '2024', precision: 'year' }).success).toBe(true);
    expect(clinicalTimeSchema.safeParse({ ...base, value: '2024-06', precision: 'month' }).success).toBe(true);
    expect(clinicalTimeSchema.safeParse({ ...base, value: '2024-06-08', precision: 'day' }).success).toBe(true);
    expect(clinicalTimeSchema.safeParse({ ...base, value: '2024-01-01', precision: 'year' }).success).toBe(false);
    expect(clinicalTimeSchema.safeParse({ ...base, value: null, precision: 'day' }).success).toBe(false);
  });
});

describe('核对操作契约', () => {
  it('改归其他成员必须同时绑定事项、资料和目标成员', () => {
    expect(resolveReviewInputSchema.safeParse({
      action: 'reassign_person', issueId: 'issue-1', documentId: 'document-1', personId: 'person-2'
    }).success).toBe(true);
    expect(resolveReviewInputSchema.safeParse({
      action: 'reassign_person', issueId: 'issue-1', documentId: 'document-1'
    }).success).toBe(false);
    expect(resolveReviewInputSchema.safeParse({
      action: 'reassign_person', issueId: 'issue-1', documentId: 'document-1', personId: 'person-2', reuseConsent: true
    }).success).toBe(false);
  });
});
