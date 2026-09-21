import { z } from 'zod';

// 建议本身是否采纳由 lifestyle proposal status 单独表达；这里仅描述用户行动的生命周期。
// 两个页面必须共用同一契约，避免全局事项写入的状态令成员计划无法读取。
export const actionStatusValues = [
  'proposed',
  'discussed',
  'planned',
  'in_progress',
  'paused',
  'completed',
  'dismissed'
] as const;

export const actionStatusSchema = z.enum(actionStatusValues);
export type ActionStatus = z.infer<typeof actionStatusSchema>;
