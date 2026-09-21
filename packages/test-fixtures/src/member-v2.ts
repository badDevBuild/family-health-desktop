/**
 * 成员健康档案 v2 的纯虚构纵向样本。
 * 这些数据只用于测试术语、时间、去重和趋势规则，不包含真实个人信息。
 */
export const cardiovascularLongitudinalFixture = [
  { id: 'cv-ldl-2022', personId: 'person-fixture', rawName: 'LDL-C', standardName: '低密度脂蛋白胆固醇', rawText: '3.1', numericValue: 3.1, comparator: 'eq', unit: 'mmol/L', referenceLow: 0, referenceHigh: 3.4, abnormalFlag: 'normal', clinicalDate: '2022-02-10', dateRole: 'specimen', specimen: '血清', method: '酶法', bodySite: null, documentId: 'doc-cv-2022', sourceSpanId: 'span-cv-2022', sourceLabel: '2022 年体检' },
  { id: 'cv-ldl-2024', personId: 'person-fixture', rawName: '低密度脂蛋白', standardName: null, rawText: '3.6', numericValue: 3.6, comparator: 'eq', unit: 'mmol/L', referenceLow: 0, referenceHigh: 3.4, abnormalFlag: 'high', clinicalDate: '2024-08-18', dateRole: 'specimen', specimen: '血清', method: '酶法', bodySite: null, documentId: 'doc-cv-2024', sourceSpanId: 'span-cv-2024', sourceLabel: '2024 年体检' },
  { id: 'cv-ldl-2026', personId: 'person-fixture', rawName: '低密度脂蛋白胆固醇', standardName: null, rawText: '4.2', numericValue: 4.2, comparator: 'eq', unit: 'mmol/L', referenceLow: 0, referenceHigh: 3.4, abnormalFlag: 'high', clinicalDate: '2026-09-12', dateRole: 'specimen', specimen: '血清', method: '酶法', bodySite: null, documentId: 'doc-cv-2026', sourceSpanId: 'span-cv-2026', sourceLabel: '2026 年体检' }
] as const;

export const thyroidAliasFixture = [
  { id: 'thyroid-tsh-1', personId: 'person-fixture', rawName: 'TSH', standardName: null, rawText: '4.8', numericValue: 4.8, comparator: 'eq', unit: 'mIU/L', referenceLow: 0.27, referenceHigh: 4.2, abnormalFlag: 'high', clinicalDate: '2024-05-01', dateRole: 'specimen', specimen: '血清', method: '化学发光', bodySite: null, documentId: 'doc-thyroid-1', sourceSpanId: 'span-thyroid-1', sourceLabel: '甲状腺功能检查' },
  { id: 'thyroid-tsh-2', personId: 'person-fixture', rawName: '血清促甲状腺激素', standardName: null, rawText: '3.9', numericValue: 3.9, comparator: 'eq', unit: 'mIU/L', referenceLow: 0.27, referenceHigh: 4.2, abnormalFlag: 'normal', clinicalDate: '2025-05-01', dateRole: 'specimen', specimen: '血清', method: '化学发光', bodySite: null, documentId: 'doc-thyroid-2', sourceSpanId: 'span-thyroid-2', sourceLabel: '甲状腺功能复查' },
  { id: 'thyroid-ft4', personId: 'person-fixture', rawName: 'FT4', standardName: null, rawText: '15.2', numericValue: 15.2, comparator: 'eq', unit: 'pmol/L', referenceLow: 12, referenceHigh: 22, abnormalFlag: 'normal', clinicalDate: '2025-05-01', dateRole: 'specimen', specimen: '血清', method: '化学发光', bodySite: null, documentId: 'doc-thyroid-2', sourceSpanId: 'span-thyroid-ft4', sourceLabel: '甲状腺功能复查' },
  { id: 'thyroid-t4', personId: 'person-fixture', rawName: 'T4', standardName: null, rawText: '8.8', numericValue: 8.8, comparator: 'eq', unit: 'ng/mL', referenceLow: 4.5, referenceHigh: 12, abnormalFlag: 'normal', clinicalDate: '2025-05-01', dateRole: 'specimen', specimen: '血清', method: '化学发光', bodySite: null, documentId: 'doc-thyroid-2', sourceSpanId: 'span-thyroid-t4', sourceLabel: '甲状腺功能复查' }
] as const;

export const multiFileEncounterFixture = {
  event: { id: 'event-checkup-2026', title: '2026 年度体检', clinicalDate: '2026-09-12' },
  documents: [
    { id: 'doc-checkup-main', displayName: '体检总报告.pdf', sourceHash: 'fixture-hash-main' },
    { id: 'doc-checkup-lab', displayName: '检验明细.pdf', sourceHash: 'fixture-hash-lab' },
    { id: 'doc-checkup-copy', displayName: '检验明细副本.pdf', sourceHash: 'fixture-hash-lab' }
  ],
  historicalColumns: [
    { label: '上次', clinicalDate: '2025-08-06', value: '3.9' },
    { label: '本次', clinicalDate: '2026-09-12', value: '4.2' }
  ]
} as const;

export const mixedConflictLongReportFixture = {
  documentId: 'doc-long-mixed',
  pageCount: 42,
  facts: [
    { localKey: 'fact-agreed', reviewA: '5.2', reviewB: '5.2', expected: 'auto_accept' },
    { localKey: 'fact-symbol-only', reviewA: { value: '5.2', abnormal: 'normal' }, reviewB: { value: '5.2', abnormal: 'high' }, expected: 'adjudicate_flag' },
    { localKey: 'fact-core-conflict', reviewA: '107', reviewB: '170', expected: 'needs_user_review' }
  ],
  coveredPages: Array.from({ length: 42 }, (_, index) => index + 1)
} as const;
