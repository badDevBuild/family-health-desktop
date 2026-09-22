import { describe, expect, it } from 'vitest';
import type { ManualNote } from '@contracts';
import { buildCurrentSymptomNotices } from './current-symptom-notice.js';

const today = new Date(2026, 8, 22, 12);

function note(overrides: Partial<ManualNote> = {}): ManualNote {
  return {
    id: 'synthetic-note', personId: 'synthetic-person', kind: 'free_text',
    immutableText: '我现在持续胸痛并伴冷汗。', effectiveDate: '2026-09-22',
    sourceKind: 'user_reported', structuredFields: {}, revision: 1,
    recordedAt: today.toISOString(), ...overrides
  };
}

describe('当天本人危险症状提示', () => {
  it('只回显当天明确正在发生的胸痛伴出汗，不等待模型综合', () => {
    expect(buildCurrentSymptomNotices([note()], today)).toEqual([{
      id: 'current-symptom:synthetic-note', noteId: 'synthetic-note',
      recordedAt: today.toISOString(), sourceLabel: '本人今天补充',
      sourceExcerpt: '我现在持续胸痛并伴冷汗'
    }]);
  });

  it('旧症状、旧有效日期、否认症状和单独胸痛不冒充当前组合', () => {
    const samples = [
      note({ recordedAt: new Date(2026, 8, 21, 12).toISOString(), effectiveDate: '2026-09-21' }),
      note({ effectiveDate: '2023-10-08' }),
      note({ immutableText: '我现在没有胸痛，但有冷汗。' }),
      note({ immutableText: '我今天胸痛但没有出汗。' }),
      note({ immutableText: '我今天只有胸痛。' }),
      note({ immutableText: '我现在想起去年曾胸痛并大汗。' }),
      note({ immutableText: '我现在胸痛已经缓解，刚才出汗。' }),
      note({ immutableText: '去年持续胸痛并伴大汗。' }),
      note({ immutableText: '如果现在胸痛并伴冷汗，应该怎么办？' }),
      note({ immutableText: '我现在并非胸痛，只是出冷汗。' })
    ];
    for (const sample of samples) expect(buildCurrentSymptomNotices([sample], today), sample.immutableText).toEqual([]);
  });

  it('只有有明确当前语境的自述触发，不从其他类型或不同句子的旧症状拼接', () => {
    expect(buildCurrentSymptomNotices([note({ kind: 'medication' })], today)).toEqual([]);
    expect(buildCurrentSymptomNotices([note({ immutableText: '我现在胸痛。去年常常大汗。' })], today)).toEqual([]);
    expect(buildCurrentSymptomNotices([note({ immutableText: '胸痛伴大汗，已于去年就医。' })], today)).toEqual([]);
    expect(buildCurrentSymptomNotices([note({ immutableText: '以前没有胸痛，现在持续胸痛并大汗。' })], today)).toHaveLength(1);
  });
});
