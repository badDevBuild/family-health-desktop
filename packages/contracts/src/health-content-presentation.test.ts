import { describe, expect, it } from 'vitest';
import { containsProcessNarrative, presentAssessmentText } from './health-content-presentation.js';

describe('健康正文中的外部来源链接与工程过程分离', () => {
  it.each([
    '参见[临床指南](https://medicine.example.org/downloads/pdfs/guidelines/clinical-guideline.pdf)。',
    '参见 https://medicine.example.org/downloads/pdfs/guidelines/clinical-guideline.PDF 。',
    '参考 http://medicine.example.org/guidelines/clinical-guideline.pdf 。',
    '参考[检查说明](https://medicine.example.org/guideline_(2026).pdf)。',
    '参考<https://medicine.example.org/guidelines/report.pdf>。',
    '参见[指南](https://medicine.example.org/指南/临床指南.pdf)。',
    '参见[指南](https://medicine.example.org/clinical.指南.pdf)。',
    '参见<https://medicine.example.org/clinical.指南.pdf>。',
    '参见[指南](https://medicine.example.org/clinical-guideline.pdf?sections=claim:source,documentId;P04!)。',
    '参见<https://medicine.example.org/clinical-guideline.pdf?sections=claim:source,documentId;P04!>。',
    '参见 http://medicine.example.org:8080/clinical-guideline.pdf 。',
    '参见 https://[2001:db8::1]:8080/clinical-guideline.pdf 。',
    '参见[指南](https://medicine.example.org/3fa85f64-5717-4562-b3fc-2c963f66afa6/claim:source/P04/assessment-validation-v31.pdf?documentId=source-1#inputSignature)。'
  ])('合法 HTTP(S) URL 内的 PDF、UUID、内部样式片段不冒充工程正文：%s', (text) => {
    expect(containsProcessNarrative(text)).toBe(false);
    expect(presentAssessmentText(text)).toEqual({ text, changed: false, processOnly: false });
  });

  it.each([
    '[P04复核已通过](https://medicine.example.org/clinical-guideline.pdf)。',
    '[模型复核](https://medicine.example.org/clinical-guideline.pdf)。',
    '模型复核已通过，参见[临床指南](https://medicine.example.org/clinical-guideline.pdf)。',
    '参见[临床指南](https://medicine.example.org/clinical-guideline.pdf)，原件是检查记录.pdf。',
    '参见 https://medicine.example.org/clinical-guideline.pdf, 检查记录.pdf。',
    '参见 https://medicine.example.org/clinical-guideline.pdf,模型复核已完成。',
    '参见 https://medicine.example.org/clinical-guideline.pdf;documentId=source-1。',
    '参见 https://medicine.example.org/clinical-guideline.pdf!P04复核已通过。',
    '参见 https://medicine.example.org/clinical-guideline.pdf：模型复核已完成。',
    '参见 https://medicine.example.org/clinical-guideline.pdf:documentId=source-1。',
    '参见 https://medicine.example.org/clinical-guideline.pdf.模型复核已完成。',
    '参见[本机原件](file:///Users/example/reports/clinical-guideline.pdf)。',
    '参见[本机资料](file:///shared/checkup)。',
    '参见 /Users/example/reports/clinical-guideline.pdf。',
    '参见 C:/reports/clinical-guideline.pdf。',
    '检查记录.pdf。',
    '本次检查（P04复核已通过），尚不能确认变化。',
    '参见[临床指南](https://medicine.example.org/clinical-guideline.pdf)（documentId=source-1）。',
    '参见[临床指南](https://medicine.example.org/clinical-guideline.pdf)documentId=source-1。'
  ])('链接标签、链接外正文、文件协议与本地原件定位仍检测：%s', (text) => {
    expect(containsProcessNarrative(text)).toBe(true);
  });

  it('移除独立过程句时，链接原样还原，临床日期、数值、否定与适用条件不变', () => {
    const clinical = '2026-04-12 结果 <2.00×10² IU/mL；未记录当时用药，不能确认近期变化。参见[检查条件](https://medicine.example.org/3fa85f64-5717-4562-b3fc-2c963f66afa6/clinical-guideline_(2026).pdf?documentId=source-1#P04)，若不适加重应停止运动。';
    const original = `P04复核已通过。${clinical}`;
    expect(containsProcessNarrative(original)).toBe(true);
    expect(presentAssessmentText(original)).toEqual({ text: clinical, changed: true, processOnly: false });
    expect(presentAssessmentText(clinical)).toEqual({ text: clinical, changed: false, processOnly: false });
  });

  it('清理 URL 旁的独立本机定位括注，不删除或改写 URL 中的文件名和参数', () => {
    const clinical = '未散瞳（参见[指南](https://medicine.example.org/clinical-guideline.pdf?documentId=source-1)），不能据此确认近视程度。';
    const original = `${clinical}（local-report.pdf）`;
    expect(presentAssessmentText(original)).toEqual({ text: clinical, changed: true, processOnly: false });
  });

  it('URL token 不复用原文字符，普通括号不能隐藏工程正文', () => {
    const clinical = '\uE0000\uE001 原样说明；参见 https://medicine.example.org/clinical-guideline.pdf 。';
    expect(presentAssessmentText(`P04已通过。${clinical}`)).toEqual({ text: clinical, changed: true, processOnly: false });
    expect(containsProcessNarrative('没有来源 URL（模型复核已完成）。')).toBe(true);
  });

  it('裸链接旁没有空格的临床解释、数值、条件和否定保持原样', () => {
    const text = '参见 https://medicine.example.org/clinical-guideline.pdf;2026-04-12 结果 <2.00×10² IU/mL，不代表没有感染；若持续不适应就诊。';
    expect(containsProcessNarrative(text)).toBe(false);
    expect(presentAssessmentText(`P04已通过。${text}`)).toEqual({ text, changed: true, processOnly: false });
  });

  it.each([
    'https:///Users/example/report.pdf',
    'https://[not-a-host]/report.pdf',
    'https://medicine.example.org:invalid/report.pdf'
  ])('语法无效 URL 不跳过文件名检测：%s', (text) => {
    expect(containsProcessNarrative(text)).toBe(true);
  });
});
