import { describe, expect, it } from 'vitest';
import { healthClaimSchema, healthClaimTitle, type HealthClaim } from './member-assessment-v3.js';

function claim(overrides: Partial<HealthClaim> = {}): HealthClaim {
  return {
    id: 'synthetic-claim', topicKey: 'example', systemIds: ['cardiovascular'], kind: 'source_fact',
    text: '报告记录了当次检查结果，缺少后续记录，不能据此判断现在的情况。',
    diseaseName: null, diagnosticStatus: null, temporalStatus: 'historical', evidenceIds: ['synthetic-source'],
    counterEvidenceIds: [], trendIds: [], knowledgeBasis: 'not_applicable', knowledgeSourceIds: [],
    criteriaBasis: null, rationale: '只有一份旧报告。', materialUncertainty: '没有近期结果。',
    consequenceLevel: 'routine', ...overrides
  };
}

describe('健康主题标题', () => {
  it('旧结果兼容中性主题，不能截断或覆盖完整结论', () => {
    const original = claim();
    expect(healthClaimSchema.safeParse(original).success).toBe(true);
    expect(healthClaimTitle(original)).toBe('心血管检查结果');
    expect(original.text).toBe('报告记录了当次检查结果，缺少后续记录，不能据此判断现在的情况。');
    expect(healthClaimTitle(claim({ systemIds: [] }))).toBe('健康检查结果');
  });

  it('新结果保留独立短标题及正文条件，不从病名生成肯定诊断', () => {
    const value = claim({ title: '旧心血管检查结果', diseaseName: '合成病名', diagnosticStatus: 'undetermined' });
    expect(healthClaimTitle(value)).toBe('旧心血管检查结果');
    expect(healthClaimTitle({ ...value, title: undefined })).toBe('心血管检查结果');
    expect(healthClaimSchema.safeParse({ ...value, title: '字'.repeat(81) }).success).toBe(false);
    expect(healthClaimSchema.safeParse({ ...value, title: '  ' }).success).toBe(false);
  });
});
