import { z } from 'zod';

/** 预览只暴露不可变来源身份，不把本机文件路径交给界面。 */
export const processingRebuildSourceIdentitySchema = z.object({
  documentId: z.string().uuid(),
  personId: z.string().uuid(),
  sourceObjectId: z.string().uuid(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/u)
}).strict();

export const processingRebuildExpectedSourcesSchema = z.array(processingRebuildSourceIdentitySchema).min(1)
  .refine((sources) => new Set(sources.map((source) => source.documentId)).size === sources.length,
    '重建预览中的原件不能重复');

export type ProcessingRebuildSourceIdentity = z.infer<typeof processingRebuildSourceIdentitySchema>;

/** 重建范围须由用户明确选择；原始资料和成员始终保留。 */
export const rebuildProcessingInputSchema = z.object({
  consentVersion: z.number().int().positive(),
  // 用户明确要从零验收新流程，旧报告人工核对结果同样只保留在恢复点中。
  confirmedRebuildReportResults: z.literal(true),
  // 必须与用户确认时所见的报告集合一致，不能在入口静默加入新导入原件。
  expectedSources: processingRebuildExpectedSourcesSchema,
  // 省略为全家庭；指定时清理和发送都只能发生在所选成员内。
  personIds: z.array(z.string().uuid()).min(1).max(20)
    .refine((ids) => new Set(ids).size === ids.length, '重建成员不能重复').optional(),
  // 必须显式提交 true 才能连本人补充、计划及旧处理收据一起清空。
  clearPersonalData: z.literal(true).optional(),
  confirmedClearPersonalData: z.literal(true).optional(),
  // 仅记录用户明确认定的同一人姓名，不传给模型据此反推报告归属。
  confirmedPersonAliases: z.array(z.object({
    personId: z.string().uuid(),
    reportedName: z.string().trim().min(1).max(80)
  }).strict()).max(20).refine((aliases) => new Set(aliases.map((alias) =>
    `${alias.personId}:${alias.reportedName.normalize('NFKC').replace(/\s+/g, '').toLocaleLowerCase('zh-CN')}`
  )).size === aliases.length, '同一成员的报告别名不能重复').optional()
}).strict().refine((input) => Boolean(input.clearPersonalData) === Boolean(input.confirmedClearPersonalData),
  '清空本人资料和计划必须单独明确确认')
  .refine((input) => !input.personIds || input.expectedSources.every((source) => input.personIds!.includes(source.personId)),
    '预览原件必须属于本次明确选择的成员');

export const processingRebuildReceiptSchema = z.object({
  rebuildId: z.string().uuid(),
  batchId: z.string().uuid(),
  documentCount: z.number().int().positive(),
  personCount: z.number().int().positive(),
  recoveryPointCreated: z.literal(true)
}).strict();

export type RebuildProcessingInput = z.infer<typeof rebuildProcessingInputSchema>;
export type ProcessingRebuildReceipt = z.infer<typeof processingRebuildReceiptSchema>;
