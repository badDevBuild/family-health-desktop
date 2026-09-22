import type { CurrentSymptomNotice, ManualNote } from '@contracts';

const chestDiscomfort = /(?:胸痛|胸口(?:疼|痛|压迫)|胸部(?:疼痛|压迫))/;
const sweating = /(?:冷汗|大汗|出汗|冒汗)/;
const explicitNow = /(?:现在|正在|目前|此刻|今天|刚刚|仍在)/;
const ongoing = /(?:持续)/;
const historical = /(?:既往|曾经|以前|去年|往年|已缓解|已经缓解|已经好了|现已无|不再)/;
const deniedChestDiscomfort = /(?:没有|无|否认|并非|不是|未出现|不再|已无)[^。；，,]{0,8}(?:胸痛|胸口|胸部)/;
const deniedSweating = /(?:没有|无|否认|并非|不是|未出现|不再|已无)[^。；，,]{0,8}(?:冷汗|大汗|出汗|冒汗)/;
const hypothetical = /(?:如果|假如|假设|一旦)[^。；，,]{0,24}(?:胸痛|胸口|胸部|冷汗|大汗)/;
const olderDate = /(?:20\d{2}[-/]\d{1,2}(?:[-/]\d{1,2})?|20\d{2}年)/;

function localDate(value: Date): string {
  const year = value.getFullYear();
  return `${year}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`;
}

/** 只转述今天明确自述的症状组合，不用旧检验数值推断急症或病名。 */
export function buildCurrentSymptomNotices(notes: ManualNote[], now: Date): CurrentSymptomNotice[] {
  const today = localDate(now);
  const notices: CurrentSymptomNotice[] = [];
  for (const note of notes) {
    if (!['free_text', 'history'].includes(note.kind)) continue;
    const recordedAt = new Date(note.recordedAt);
    if (Number.isNaN(recordedAt.getTime()) || localDate(recordedAt) !== today
      || (note.effectiveDate !== null && note.effectiveDate !== today)) continue;
    for (const fragment of note.immutableText.split(/[。；;！!\n]/)) {
      const clause = fragment.trim();
      const currentMarker = explicitNow.exec(clause) ?? ongoing.exec(clause);
      if (!currentMarker) continue;
      // 同句先提旧史再写“现在”时，只裁决当下部分；不能让旧史否定真实的当前自述。
      const currentClause = clause.slice(currentMarker.index);
      if (!chestDiscomfort.test(currentClause) || !sweating.test(currentClause)
        || (!explicitNow.test(clause) && (historical.test(clause) || olderDate.test(clause)))
        || historical.test(currentClause) || olderDate.test(currentClause) || hypothetical.test(clause)
        || deniedChestDiscomfort.test(currentClause) || deniedSweating.test(currentClause)) continue;
      notices.push({
        id: `current-symptom:${note.id}`, noteId: note.id, recordedAt: note.recordedAt,
        sourceLabel: '本人今天补充', sourceExcerpt: clause.slice(0, 200)
      });
      break;
    }
    if (notices.length === 2) break;
  }
  return notices;
}
