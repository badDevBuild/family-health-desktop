import { stableHash } from '@core';
import { z } from 'zod';

const checkpointSchema = z.object({
  version: z.literal(1), signature: z.string(), attempts: z.number().int().min(1).max(3),
  phase: z.enum(['in_flight', 'transport_unknown', 'response_saved']),
  responseHash: z.string().nullable(),
  response: z.object({ threadId: z.string().min(1), turnId: z.string().min(1), output: z.unknown() }).nullable()
});
type TurnResponse = { threadId: string; turnId: string; output: unknown };

/** 持久化完整请求的传输预算和回包；恢复时仍由原流水线重新做契约、来源及依赖校验。 */
export async function runCheckpointedAssessmentTurn(input: {
  signature: string;
  read: () => unknown;
  save: (state: z.infer<typeof checkpointSchema>) => void;
  assertActive: () => void;
  run: () => Promise<TurnResponse>;
}): Promise<TurnResponse> {
  input.assertActive();
  const raw = input.read();
  const parsed = raw === null || raw === undefined ? null : checkpointSchema.safeParse(raw);
  if (parsed && (!parsed.success || parsed.data.signature !== input.signature)) {
    throw new Error('ASSESSMENT_CHECKPOINT_INVALID');
  }
  const prior = parsed?.success ? parsed.data : null;
  if (prior?.phase === 'response_saved') {
    // schema 仅验证必需结构；其投影会删除 metrics 等运行时字段并重排键。
    // 摘要必须核对原始持久回包，才能既复用完整结果，也继续拒绝任何内容篡改。
    const response = (raw as z.infer<typeof checkpointSchema>).response;
    if (!response || !Object.hasOwn(response, 'output') || prior.responseHash !== stableHash(response)) {
      throw new Error('ASSESSMENT_CHECKPOINT_INVALID');
    }
    input.assertActive();
    return response;
  }
  // 进程在发送后退出时，旧 in_flight 属于终态未知，仍消耗一次传输预算。
  if ((prior?.attempts ?? 0) >= 3) throw new Error('ASSESSMENT_STAGE_TRANSPORT_RETRY_EXHAUSTED');
  const active: z.infer<typeof checkpointSchema> = { version: 1, signature: input.signature,
    attempts: (prior?.attempts ?? 0) + 1, phase: 'in_flight', response: null, responseHash: null };
  input.save(active);
  input.assertActive();
  let result: TurnResponse;
  try {
    result = await input.run();
  } catch (error) {
    // 撤权/关闭后的迟到回调不再写缓存；原取消异常由执行门禁给出。
    input.assertActive();
    input.save({ ...active, phase: 'transport_unknown' });
    throw error;
  }
  input.assertActive();
  if (!result.threadId || !result.turnId || !Object.hasOwn(result, 'output')) throw new Error('ASSESSMENT_TURN_RECEIPT_INVALID');
  // 先存实际回包再解码或应用。后段失败重进本步骤只重校验，不再请求一次 P02/P04。
  input.save({ ...active, phase: 'response_saved', response: result, responseHash: stableHash(result) });
  return result;
}
