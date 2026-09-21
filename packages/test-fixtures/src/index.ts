import type { DashboardSnapshot } from '@contracts';

export * from './member-v2.js';

export function createDemoSnapshot(now = new Date('2026-09-17T10:30:00+08:00')): DashboardSnapshot {
  const nextRun = new Date(now);
  nextRun.setHours(20, 0, 0, 0);
  if (nextRun.getTime() <= now.getTime()) nextRun.setDate(nextRun.getDate() + 1);
  return {
    workspaceMode: 'demo',
    workspaceName: '林家的健康档案',
    account: {
      status: 'disconnected',
      displayLabel: null,
      quota: {
        status: 'unknown',
        primaryUsedPercent: null,
        secondaryUsedPercent: null,
        resetsAt: null
      },
      runtimeVersion: '0.145.0 (开发机探测)',
      lastCheckedAt: null
    },
    nextScheduledRun: nextRun.toISOString(),
    scheduleEnabled: true,
    scheduleLocalTime: '20:00',
    scheduleTimeZone: 'Asia/Shanghai',
    scheduleRevision: 1,
    queuePaused: false,
    pendingInboxCount: 3,
    openReviewCount: 1,
    persons: [
      {
        id: 'person-lin-ming',
        displayName: '林明',
        relation: '本人',
        birthYear: 1988,
        avatarInitial: '明',
        lastDocumentDate: '2026-09-12',
        documentCount: 16,
        acceptedFactCount: 48,
        pendingCount: 2,
        attentionCount: 2,
        dataQuality: 'complete',
        freshnessLabel: '资料更新至 5 天前',
        changeSummary: '新增一次年度体检，血脂与肝功能有变化',
        derivedStatus: 'current',
        assessmentSummary: '最近资料里，最值得留意的是血脂变化',
        dataRevision: '1111111111111111111111111111111111111111111111111111111111111111',
        displayRevision: 1,
        clinicalContextRevision: 2
      },
      {
        id: 'person-zhou-lan',
        displayName: '周岚',
        relation: '母亲',
        birthYear: 1962,
        avatarInitial: '岚',
        lastDocumentDate: '2026-08-28',
        documentCount: 11,
        acceptedFactCount: 31,
        pendingCount: 1,
        attentionCount: 1,
        dataQuality: 'partial',
        freshnessLabel: '资料更新至 20 天前',
        changeSummary: '有一份报告等待确认所属成员',
        derivedStatus: 'current',
        assessmentSummary: '已有报告事实和经过复核的说明',
        dataRevision: '2222222222222222222222222222222222222222222222222222222222222222',
        displayRevision: 1,
        clinicalContextRevision: 1
      },
      {
        id: 'person-lin-xiao',
        displayName: '林晓',
        relation: '女儿',
        birthYear: 2013,
        avatarInitial: '晓',
        lastDocumentDate: '2026-06-18',
        documentCount: 5,
        acceptedFactCount: 14,
        pendingCount: 0,
        attentionCount: 0,
        dataQuality: 'partial',
        freshnessLabel: '资料更新至 3 个月前',
        changeSummary: '本次没有新增资料',
        derivedStatus: 'current',
        assessmentSummary: '现有资料没有新的派生说明',
        dataRevision: '3333333333333333333333333333333333333333333333333333333333333333',
        displayRevision: 1,
        clinicalContextRevision: 0
      }
    ],
    organs: [
      { id: 'cardiovascular', personId: 'person-lin-ming', name: '心血管', status: 'attention', summary: '血脂指标较上次升高，建议结合医生意见复核。', evidenceDate: '2026-09-12', evidenceSourceSpanId: null, metricCount: 8 },
      { id: 'metabolic', personId: 'person-lin-ming', name: '代谢 / 内分泌', status: 'stable', summary: '本次血糖相关记录在报告参考范围内。', evidenceDate: '2026-09-12', evidenceSourceSpanId: null, metricCount: 7 },
      { id: 'hepatobiliary', personId: 'person-lin-ming', name: '肝胆', status: 'attention', summary: '一项酶指标轻度偏高，需要结合近期生活与用药核实。', evidenceDate: '2026-09-12', evidenceSourceSpanId: null, metricCount: 6 },
      { id: 'renal', personId: 'person-lin-ming', name: '肾脏 / 泌尿', status: 'stable', summary: '现有资料未见明显变化。', evidenceDate: '2026-09-12', evidenceSourceSpanId: null, metricCount: 5 },
      { id: 'digestive', personId: 'person-lin-ming', name: '消化', status: 'insufficient', summary: '资料不足，暂不作健康判断。', evidenceDate: null, evidenceSourceSpanId: null, metricCount: 1 },
      { id: 'hematology', personId: 'person-lin-ming', name: '血液', status: 'stable', summary: '血常规记录总体平稳。', evidenceDate: '2026-09-12', evidenceSourceSpanId: null, metricCount: 13 },
      { id: 'respiratory', personId: 'person-lin-ming', name: '肺 / 呼吸', status: 'insufficient', summary: '近两年没有新的相关报告。', evidenceDate: '2024-07-10', evidenceSourceSpanId: null, metricCount: 2 },
      { id: 'sensory', personId: 'person-lin-ming', name: '眼 / 五官', status: 'stable', summary: '现有记录没有需要立即处理的变化。', evidenceDate: '2026-09-12', evidenceSourceSpanId: null, metricCount: 4 }
    ],
    trends: [
      {
        id: 'trend-ldl',
        personId: 'person-lin-ming',
        name: '低密度脂蛋白胆固醇',
        unit: 'mmol/L',
        interpretation: '近三次记录呈上升趋势；最新值超出该次报告参考上限。',
        comparisonNote: '三次报告单位与方法一致，可以连线比较；参考范围按各次报告保存。',
        points: [
          { date: '2024-07-10', displayValue: '3.6', numericValue: 3.6, referenceLow: 0, referenceHigh: 3.4, abnormalFlag: 'high', sourceLabel: '2024 年度体检 · 第 3 页', sourceSpanId: null, documentId: null },
          { date: '2025-08-06', displayValue: '3.9', numericValue: 3.9, referenceLow: 0, referenceHigh: 3.4, abnormalFlag: 'high', sourceLabel: '2025 年度体检 · 第 4 页', sourceSpanId: null, documentId: null },
          { date: '2026-09-12', displayValue: '4.2', numericValue: 4.2, referenceLow: 0, referenceHigh: 3.4, abnormalFlag: 'high', sourceLabel: '2026 年度体检 · 第 4 页', sourceSpanId: null, documentId: null }
        ]
      },
      {
        id: 'trend-fpg',
        personId: 'person-lin-ming',
        name: '空腹血糖',
        unit: 'mmol/L',
        interpretation: '现有三次记录变化不大。',
        comparisonNote: '缺失或定性结果不会被填成 0。',
        points: [
          { date: '2024-07-10', displayValue: '5.1', numericValue: 5.1, referenceLow: 3.9, referenceHigh: 6.1, abnormalFlag: 'normal', sourceLabel: '2024 年度体检 · 第 2 页', sourceSpanId: null, documentId: null },
          { date: '2025-08-06', displayValue: '5.2', numericValue: 5.2, referenceLow: 3.9, referenceHigh: 6.1, abnormalFlag: 'normal', sourceLabel: '2025 年度体检 · 第 3 页', sourceSpanId: null, documentId: null },
          { date: '2026-09-12', displayValue: '5.3', numericValue: 5.3, referenceLow: 3.9, referenceHigh: 6.1, abnormalFlag: 'normal', sourceLabel: '2026 年度体检 · 第 3 页', sourceSpanId: null, documentId: null }
        ]
      }
    ],
    timeline: [],
    guidance: [
      { id: 'guide-1', personId: 'person-lin-ming', title: '保持规律步行', detail: '可以从每周多次、身体感觉舒适的步行开始；如运动时不适，请先咨询医生。', consultProfessional: true, evidenceCount: 2 },
      { id: 'guide-2', personId: 'person-lin-ming', title: '调整日常饮食结构', detail: '优先增加蔬菜和优质蛋白，主食按日常活动量适度调整。', consultProfessional: false, evidenceCount: 2 }
    ],
    inbox: [
      { id: 'inbox-1', displayName: '年度体检_2026.pdf', discoveredAt: '2026-09-17T01:16:00+00:00', personId: 'person-lin-ming', personLabel: '林明', status: 'queued', format: 'PDF · 12 页', sourceLabel: '林明的报告文件夹', sentToAi: false, aiTransmissionStatus: 'not_sent', inProcessingCenter: false, issue: null },
      { id: 'inbox-2', displayName: '血常规.jpg', discoveredAt: '2026-09-17T01:20:00+00:00', personId: 'person-lin-ming', personLabel: '林明', status: 'queued', format: 'JPEG', sourceLabel: '林明的报告文件夹', sentToAi: false, aiTransmissionStatus: 'not_sent', inProcessingCenter: false, issue: null },
      { id: 'inbox-3', displayName: '门诊报告.docx', discoveredAt: '2026-09-17T01:25:00+00:00', personId: null, personLabel: null, status: 'needs_review', format: 'Word', sourceLabel: '公共待归属', sentToAi: false, aiTransmissionStatus: 'not_sent', inProcessingCenter: false, issue: '文档姓名与已绑定成员无法唯一匹配' },
      { id: 'inbox-4', displayName: '2025年度体检副本.pdf', discoveredAt: '2026-09-16T06:30:00+00:00', personId: 'person-lin-ming', personLabel: '林明', status: 'duplicate', format: 'PDF · 10 页', sourceLabel: '手动导入', sentToAi: false, aiTransmissionStatus: 'not_sent', inProcessingCenter: false, issue: '内容与已保存资料相同，未重复处理' }
    ],
    jobs: [
      { id: 'job-1', batchLabel: '今天 09:40 手动处理', personLabel: '林明', stage: 'review_facts', status: 'running', completedUnits: 4, totalUnits: 10, statusText: '正在核对第 5 页，共 10 页', systemOutcomes: [], updatedAt: '2026-09-17T02:30:00+00:00', canCancel: true, canRetry: false },
      { id: 'job-2', batchLabel: '昨天 20:00 自动批次', personLabel: '周岚', stage: 'publish', status: 'succeeded', completedUnits: 8, totalUnits: 8, statusText: '已保存资料并更新说明', systemOutcomes: [], updatedAt: '2026-09-16T12:18:00+00:00', canCancel: false, canRetry: false },
      { id: 'job-3', batchLabel: '9 月 15 日自动批次', personLabel: null, stage: 'identify', status: 'waiting_user', completedUnits: 1, totalUnits: 2, statusText: '等待确认所属成员', systemOutcomes: [], updatedAt: '2026-09-15T12:06:00+00:00', canCancel: true, canRetry: false }
    ],
    reviews: [
      { id: 'review-1', personId: null, documentId: 'document-inbox-3', kind: 'person_conflict', severity: 'blocking', title: '确认门诊报告属于谁', description: '报告里的姓名与文件夹信息不能唯一匹配。确认之前不会把内容写入任何成员档案。', evidenceRefs: ['span-docx-heading'], candidateOptions: [], candidateDiffs: [], reportedName: null, reasonCodes: [], resolutionStatus: 'open' }
    ],
    actions: [
      { id: 'action-1', personId: 'person-lin-ming', title: '向医生咨询血脂变化', detail: '结合近三次 LDL 记录与本次报告参考范围，询问是否需要进一步评估。', origin: 'ai_proposed', status: 'proposed', dueDate: null, dueText: '下次就诊时', evidenceLabel: '基于 2024–2026 三次体检记录', userRevision: 1, updatedAt: '2026-09-17T02:20:00+00:00' },
      { id: 'action-2', personId: 'person-zhou-lan', title: '复查甲状腺功能', detail: '报告原文写明“建议 3 个月后复查”。', origin: 'clinician_document', status: 'planned', dueDate: '2026-11-28', dueText: '报告日期后约 3 个月', evidenceLabel: '2026-08-28 门诊报告 · 第 2 页', userRevision: 1, updatedAt: '2026-09-01T04:00:00+00:00' },
      { id: 'action-3', personId: 'person-lin-ming', title: '记录一周家庭血压', detail: '本人创建的记录计划，用于下次咨询时提供参考。', origin: 'user_created', status: 'completed', dueDate: null, dueText: null, evidenceLabel: '用户记录', userRevision: 2, updatedAt: '2026-08-20T09:00:00+00:00' }
    ],
    notes: [
      { id: 'note-1', personId: 'person-lin-ming', kind: 'medication', immutableText: '本人记录：目前在使用医生此前开具的降压药，具体剂量以药盒为准。', effectiveDate: '2026-08-20', sourceKind: 'user_reported', structuredFields: { medicationName: '降压药（名称待核实）' }, revision: 1, recordedAt: '2026-08-20T09:00:00+00:00' }
    ],
    privacyNotice: '这是纯虚构演示档案。真实资料只保存在本机工作区；获得明确授权后，必要内容才通过你的 Codex 账户发送给 OpenAI。',
    generatedAt: now.toISOString()
  };
}
