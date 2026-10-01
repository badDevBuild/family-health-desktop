import { z } from 'zod';

/** 结果的解释条件，不是新检查结果；保留原文定位，供本地复核和追溯。 */
export const clinicalContextSchema = z.object({
  version: z.literal(1),
  status: z.enum(['complete', 'unresolved']),
  conditions: z.array(z.object({
    sourceSpanId: z.string().min(1).max(160),
    quote: z.string().trim().min(1).max(2_000)
  }).strict()).max(40)
}).strict();
export type ClinicalContext = z.infer<typeof clinicalContextSchema>;

export const reportClinicalContextSchema = z.object({
  version: z.literal(1),
  items: z.array(z.object({
    observationId: z.string().min(1).max(160),
    context: clinicalContextSchema
  }).strict()).min(1)
}).strict();
export type ReportClinicalContext = z.infer<typeof reportClinicalContextSchema>;

/** 只核验引用真实性；医学上的完整性仍由读完整来源的提取/补齐步骤负责。 */
export function clinicalContextHasValidSources(
  context: ClinicalContext,
  sources: ReadonlyArray<{ id: string; quote: string | null }>,
  allowImageEvidence = false
): boolean {
  const byId = new Map(sources.map((source) => [source.id, source]));
  return context.conditions.every((condition) => {
    const source = byId.get(condition.sourceSpanId);
    return source !== undefined && (source.quote === null
      ? allowImageEvidence : source.quote.includes(condition.quote));
  });
}
