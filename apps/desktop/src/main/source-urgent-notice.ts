import type { SourceUrgentNotice } from '@contracts';
import type { AcceptedObservationSummary } from '@storage';

const RECENT_NOTICE_DAYS = 7; // 仅是界面时效门槛，不是疾病或危急值的医学判定标准。
const DAY_MS = 24 * 60 * 60 * 1_000;
const explicitUrgency = /(?:危急值|critical\s+(?:value|result)|(?:建议|请|需|需要)?(?:立即|马上|尽快)(?:就医|急诊|前往急诊|联系医生|联系医疗机构|处理|拨打\s*120|呼叫急救))/i;
const immediateCare = /(?:立即|马上)(?:就医|急诊|前往急诊|拨打\s*120|呼叫急救)/i;
const negatedUrgency = /(?:无|未见|未达到|排除|非)(?:明显)?危急值|(?:无需|不必|不需要)(?:立即|马上)(?:就医|急诊|处理)/i;

function calendarDay(value: string): number | null {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month - 1 && parsed.getUTCDate() === day
    ? parsed.getTime() : null;
}

function localDay(now: Date): number {
  return Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
}

function sourceExcerpt(observation: AcceptedObservationSummary): { sourceSpanId: string; text: string } | null {
  for (const evidence of observation.evidence) {
    if (!evidence.quote) continue; // 图像依据不凭模型转写伪造原文紧急指示。
    for (const fragment of evidence.quote.split(/[。；;！!\n]/)) {
      const text = fragment.trim();
      if (!explicitUrgency.test(text) || negatedUrgency.test(text)) continue;
      const itemNamed = observation.originalNameStatus === 'recorded'
        && text.includes(observation.originalName);
      const resultNamed = observation.rawText.length > 0 && text.includes(observation.rawText);
      if (!itemNamed || (observation.rawText.length <= 60 && !resultNamed)) continue;
      return { sourceSpanId: evidence.sourceSpanId, text: text.slice(0, 320) };
    }
  }
  return null;
}

/** 只回显近期报告原文的明确提示，不根据偏高/偏低数值自行推断急症。 */
export function buildSourceUrgentNotices(
  observations: AcceptedObservationSummary[], now: Date
): SourceUrgentNotice[] {
  const today = localDay(now);
  const notices: SourceUrgentNotice[] = [];
  const seenDocuments = new Set<string>();
  for (const observation of [...observations].sort((a, b) => (b.clinicalDate ?? '').localeCompare(a.clinicalDate ?? ''))) {
    if (!observation.clinicalDate || seenDocuments.has(observation.documentId)) continue;
    const day = calendarDay(observation.clinicalDate);
    if (day === null || day > today || (today - day) / DAY_MS > RECENT_NOTICE_DAYS) continue;
    const excerpt = sourceExcerpt(observation);
    if (!excerpt) continue;
    seenDocuments.add(observation.documentId);
    notices.push({
      id: `source-urgent:${observation.id}`,
      documentId: observation.documentId,
      sourceSpanId: excerpt.sourceSpanId,
      clinicalDate: observation.clinicalDate,
      instructionLevel: immediateCare.test(excerpt.text) ? 'immediate_care' : 'critical_result',
      itemName: observation.originalName,
      sourceLabel: observation.sourceLabel,
      sourceExcerpt: excerpt.text
    });
    if (notices.length === 3) break;
  }
  return notices;
}
