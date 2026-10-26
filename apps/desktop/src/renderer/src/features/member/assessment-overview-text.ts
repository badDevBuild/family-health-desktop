import { presentAssessmentText } from '@contracts';

/** 派生正文只显示安全 HTTPS 引用的完整标签；来源仍由既有医学来源入口提供。 */
export function assessmentOverviewText(value: string | null | undefined): string {
  const text = presentAssessmentText(value ?? '').text;
  // 不解析 HTML，不创建点击入口；非支持协议、图片或不完整 Markdown 保持纯文本。
  return text.replace(/(?<!!)\[([^\]\n]+)\]\((https:\/\/[^\s<>()]+)\)/gu, (original, label: string, url: string) => {
    try {
      const parsed = new URL(url);
      return parsed.protocol === 'https:' && parsed.hostname && !parsed.username && !parsed.password ? label : original;
    } catch {
      return original;
    }
  });
}
