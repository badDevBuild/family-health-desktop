import { describe, expect, it } from 'vitest';
import { localDateSchema, reportMetadataCandidateSchema } from './index.js';
import { clinicalTimeSchema } from './member-v2.js';

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
