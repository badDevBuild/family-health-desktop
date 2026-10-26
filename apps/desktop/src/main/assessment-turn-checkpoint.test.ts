import { describe, expect, it } from 'vitest';
import { runCheckpointedAssessmentTurn } from './assessment-turn-checkpoint.js';

describe('综合阶段持久传输检查点', () => {
  it('回包持久化后重入不重新发送，并仍检查授权', async () => {
    let saved: unknown = null; let calls = 0; let active = true;
    const input = { signature: 'same-input-and-request', read: () => saved, save: (value: unknown) => { saved = value; },
      assertActive: () => { if (!active) throw Error('CONSENT_REVOKED'); },
      run: async () => { calls++; return { threadId: 't', turnId: 'r', output: { value: 1 } }; } };
    await expect(runCheckpointedAssessmentTurn(input)).resolves.toMatchObject({ output: { value: 1 } });
    await runCheckpointedAssessmentTurn(input);
    expect(calls).toBe(1);
    active = false;
    await expect(runCheckpointedAssessmentTurn(input)).rejects.toThrow('CONSENT_REVOKED');
  });

  it('连接失败和进程重启共享有限预算，不凭重新进入重置次数', async () => {
    let saved: unknown = null; let calls = 0;
    const input = { signature: 'request', read: () => saved, save: (value: unknown) => { saved = value; },
      assertActive: () => {}, run: async () => { calls++; throw Error('CONNECTION_LOST'); } };
    for (let i = 0; i < 3; i++) await expect(runCheckpointedAssessmentTurn(input)).rejects.toThrow('CONNECTION_LOST');
    await expect(runCheckpointedAssessmentTurn(input)).rejects.toThrow('ASSESSMENT_STAGE_TRANSPORT_RETRY_EXHAUSTED');
    expect(calls).toBe(3);
  });

  it('真实运行时附带的统计字段经过 JSON 持久化后仍可复用完整回包', async () => {
    let saved: unknown = null; let calls = 0;
    // 故意改变字段顺序，校验摘要必须针对存储的原始回包，而非 schema 投影。
    const response = { metrics: { durationMs: 20, inputTokens: 100, outputTokens: 30 },
      output: { value: 1 }, turnId: 'r', threadId: 't' };
    const input = { signature: 'request', read: () => saved,
      save: (value: unknown) => { saved = JSON.parse(JSON.stringify(value)); },
      assertActive: () => {}, run: async () => { calls++; return response; } };
    await runCheckpointedAssessmentTurn(input);
    await expect(runCheckpointedAssessmentTurn(input)).resolves.toEqual(response);
    expect(calls).toBe(1);
    // 统计字段也属于原回包的完整性校验范围，不能丢弃它再忽略摘要差异。
    (saved as { response: typeof response }).response.metrics.durationMs = 21;
    await expect(runCheckpointedAssessmentTurn(input)).rejects.toThrow('ASSESSMENT_CHECKPOINT_INVALID');
    expect(calls).toBe(1);
  });

  it('完整请求变更、回包篡改、旧结构不获复用资格', async () => {
    let saved: unknown = null;
    const input = { signature: 'v1', read: () => saved, save: (value: unknown) => { saved = value; },
      assertActive: () => {}, run: async () => ({ threadId: 't', turnId: 'r', output: { value: 1 } }) };
    await runCheckpointedAssessmentTurn(input);
    await expect(runCheckpointedAssessmentTurn({ ...input, signature: 'v2' })).rejects.toThrow('ASSESSMENT_CHECKPOINT_INVALID');
    (saved as { response: unknown }).response = { threadId: 't', turnId: 'r', output: { value: 2 } };
    await expect(runCheckpointedAssessmentTurn(input)).rejects.toThrow('ASSESSMENT_CHECKPOINT_INVALID');
    saved = { output: { value: 1 } };
    await expect(runCheckpointedAssessmentTurn(input)).rejects.toThrow('ASSESSMENT_CHECKPOINT_INVALID');
  });

  it('终态未知消耗预算，取消后不保存迟到回包', async () => {
    let saved: unknown = { version: 1, signature: 'request', attempts: 2, phase: 'in_flight', responseHash: null, response: null };
    let active = true; let writes = 0;
    const input = { signature: 'request', read: () => saved, save: (value: unknown) => { saved = value; writes++; },
      assertActive: () => { if (!active) throw Error('CANCELLED'); },
      run: async () => { active = false; return { threadId: 't', turnId: 'r', output: 1 }; } };
    await expect(runCheckpointedAssessmentTurn(input)).rejects.toThrow('CANCELLED');
    expect(writes).toBe(1);
    expect(saved).toMatchObject({ attempts: 3, phase: 'in_flight' });
  });
});
