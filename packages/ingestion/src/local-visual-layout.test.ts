import { describe, expect, it } from 'vitest';
import { reconstructLocalVisualLayout, type LocalVisualTextBox } from './local-visual-layout.js';

const box = (text: string, x: number, y: number, width = 0.18, height = 0.025): LocalVisualTextBox => ({
  text, confidence: 0.9, bounds: [x, y, width, height]
});

describe('本地视觉依据的受控行列恢复', () => {
  it('输入顺序不可靠时按同一实际行恢复名称、结果、单位，真正下一项仍换行', () => {
    const lines = [box('7.2', 0.5, 0.60), box('U/L', 0.65, 0.70), box('合成项目乙', 0.08, 0.60),
      box('18', 0.5, 0.70), box('合成项目甲', 0.08, 0.70), box('U/L', 0.65, 0.60)];
    const result = reconstructLocalVisualLayout(lines);
    expect(result.quote).toBe('合成项目甲 18 U/L\n合成项目乙 7.2 U/L');
    expect(result.rows).toHaveLength(2);
    expect(result.rows.flatMap((row) => row.boxes)).toHaveLength(lines.length);
    expect(result.rows[0]?.boxes.find((item) => item.text === '18')?.bounds).toEqual([0.5, 0.70, 0.18, 0.025]);
  });

  it('恢复同一左列的两行名称，不把夹在阅读顺序中的数值插入名称', () => {
    const continuation = box('抗体', 0.08, 0.684, 0.08);
    const lines = [continuation, box('合成受体', 0.08, 0.72, 0.22), box('<0.72', 0.5, 0.705, 0.12, 0.028),
      box('IU/L', 0.65, 0.705, 0.1, 0.028)];
    const result = reconstructLocalVisualLayout(lines);
    expect(result.quote).toBe('合成受体抗体 <0.72 IU/L');
    expect(result.rows[0]?.boxes).toHaveLength(4);
    expect(result.rows[0]?.boxes.find((item) => item.text === '抗体')?.bounds).toEqual(continuation.bounds);
  });

  it('不跨过两个不同的结果行拼名称，也不合并独立下一项目', () => {
    const lines = [box('合成受体', 0.08, 0.72), box('2.4', 0.5, 0.72),
      box('抗体', 0.08, 0.684), box('3.8', 0.5, 0.684), box('合成项目乙', 0.08, 0.63), box('4.1', 0.5, 0.63)];
    const result = reconstructLocalVisualLayout(lines);
    expect(result.quote).toBe('合成受体 2.4\n抗体 3.8\n合成项目乙 4.1');
  });

  it('没有明确对应结果的名称续行保持原样，不猜下一行归属', () => {
    const result = reconstructLocalVisualLayout([box('合成受体', 0.08, 0.72), box('抗体', 0.08, 0.684)]);
    expect(result.quote).toBe('合成受体\n抗体');
  });

  it('上一结果只与上一名称基线对齐时，不把下方空白短项目拼入上一名称', () => {
    const result = reconstructLocalVisualLayout([box('合成受体', 0.08, 0.72), box('18', 0.5, 0.72),
      box('抗体', 0.08, 0.684)]);
    expect(result.quote).toBe('合成受体 18\n抗体');
  });

  it('一个较高的文字框不会将同列两项通过重叠关系桥接到一起', () => {
    const result = reconstructLocalVisualLayout([box('合成项目甲', 0.08, 0.72), box('18', 0.5, 0.69, 0.18, 0.07),
      box('合成项目乙', 0.08, 0.69)]);
    expect(result.rows.find((row) => row.text.includes('合成项目甲'))?.text).not.toContain('合成项目乙');
  });

  it('文字框同时能归属两行时单独保留，并明确布局关联有歧义', () => {
    const result = reconstructLocalVisualLayout([box('合成项目甲', 0.08, 0.72),
      box('合成项目乙', 0.08, 0.709), box('18', 0.5, 0.714, 0.18, 0.028)]);
    expect(result.warnings).toContain('local_visual_layout_ambiguous_row_binding');
    expect(result.rows.find((row) => row.text.includes('18'))?.text).toBe('18');
  });

  it('同列重叠文字框不拼成一个新的来源句子', () => {
    const result = reconstructLocalVisualLayout([box('合成项目甲 18', 0.08, 0.72, 0.6), box('另一识别', 0.08, 0.72)]);
    expect(result.rows).toHaveLength(2);
  });

  it('布局密度超过本机预算时保留全部文字与原位置，不猜行关联', () => {
    const lines = Array.from({ length: 2_001 }, () => box('合成内容', 0.08, 0.72));
    const result = reconstructLocalVisualLayout(lines);
    expect(result.rows).toHaveLength(lines.length);
    expect(result.rows.every((row) => row.boxes.length === 1)).toBe(true);
    expect(result.warnings).toContain('local_visual_layout_not_reconstructed_within_budget');
  });

  it('只重排版，不改写科学计数法、比较符、否定词和复合单位', () => {
    const result = reconstructLocalVisualLayout([box('合成核酸', 0.08, 0.72), box('<2.50E＋02', 0.5, 0.72, 0.17),
      box('copies/mL', 0.72, 0.72, 0.15), box('局部结果', 0.08, 0.64), box('未见异常', 0.5, 0.64),
      box('合成血流', 0.08, 0.56), box('约29cm/s', 0.5, 0.56)]);
    expect(result.quote).toBe('合成核酸 <2.50E＋02 copies/mL\n局部结果 未见异常\n合成血流 约29cm/s');
  });

  it('仅顶部有表头时也保留结果与参考列边界，不重复伪造表头原文', () => {
    const result = reconstructLocalVisualLayout([box('项目', 0.02, 0.8, 0.12), box('结果', 0.35, 0.8, 0.1),
      box('单位', 0.55, 0.8, 0.1), box('参考范围', 0.72, 0.8, 0.2),
      box('合成项目甲', 0.02, 0.72, 0.22), box('18.2', 0.35, 0.72, 0.12), box('U/L', 0.55, 0.72, 0.1),
      box('3.0-9.0', 0.72, 0.72, 0.2)]);
    expect(result.quote).toBe('项目 结果 单位 参考范围\n合成项目甲 18.2 U/L | 3.0-9.0');
    expect(result.quote.match(/参考范围/gu)).toHaveLength(1);
  });

  it('结果列空白时不把参考列里的单个数值借给项目', () => {
    const result = reconstructLocalVisualLayout([box('项目', 0.02, 0.8, 0.12), box('结果', 0.35, 0.8, 0.1),
      box('单位', 0.55, 0.8, 0.1), box('参考值', 0.72, 0.8, 0.2),
      box('合成项目甲', 0.02, 0.72, 0.22), box('U/L', 0.55, 0.72, 0.1), box('3.0', 0.72, 0.72, 0.2)]);
    expect(result.quote).toBe('项目 结果 单位 参考值\n合成项目甲 U/L | 3.0');
  });

  it('无表头的独立参考范围单元格也不能并入首个结果', () => {
    const result = reconstructLocalVisualLayout([box('合成项目甲', 0.02, 0.72, 0.22),
      box('18.2', 0.35, 0.72, 0.12), box('U/L', 0.55, 0.72, 0.1), box('3.0-9.0', 0.72, 0.72, 0.2)]);
    expect(result.quote).toBe('合成项目甲 18.2 U/L | 3.0-9.0');
  });

  it('同高双栏项目隔离，不允许甲项目借乙项目的数值', () => {
    const result = reconstructLocalVisualLayout([box('合成项目甲', 0.02, 0.72, 0.2), box('18.2 U/L', 0.25, 0.72, 0.2),
      box('合成项目乙', 0.52, 0.72, 0.2), box('7.1 U/L', 0.75, 0.72, 0.2)]);
    expect(result.quote).toBe('合成项目甲 18.2 U/L | 合成项目乙 7.1 U/L');
  });

  it('科学计数单位不是第二结果，但未知第二数字列仍隔离', () => {
    const result = reconstructLocalVisualLayout([box('合成项目甲', 0.02, 0.72, 0.2), box('4.8', 0.3, 0.72, 0.1),
      box('10^9/L', 0.45, 0.72, 0.15), box('8.0', 0.7, 0.72, 0.1)]);
    expect(result.quote).toBe('合成项目甲 4.8 10^9/L | 8.0');
  });

  it('跨年度表格不把两个年份列当成同一个当前结果', () => {
    const result = reconstructLocalVisualLayout([box('项目', 0.02, 0.8, 0.12), box('2023年', 0.35, 0.8, 0.1),
      box('2025年', 0.65, 0.8, 0.1), box('合成项目甲', 0.02, 0.72, 0.22),
      box('18.2', 0.35, 0.72, 0.12), box('7.1', 0.65, 0.72, 0.12)]);
    expect(result.quote).toBe('项目 2023年 2025年\n合成项目甲 | 18.2 | 7.1');
  });

  it('完整临床日期作列标题时也不能混成一个当前结果', () => {
    const result = reconstructLocalVisualLayout([box('项目', 0.02, 0.8, 0.12), box('2023-11-08', 0.35, 0.8, 0.2),
      box('2025年12月16日', 0.65, 0.8, 0.25), box('合成项目甲', 0.02, 0.72, 0.22),
      box('18.2', 0.35, 0.72, 0.12), box('7.1', 0.65, 0.72, 0.12)]);
    expect(result.quote).toBe('项目 2023-11-08 2025年12月16日\n合成项目甲 | 18.2 | 7.1');
  });

  it('同一OCR框内的后续范围也不证明为前面的结果', () => {
    const result = reconstructLocalVisualLayout([box('合成项目甲 18.2 U/L 3.0-9.0', 0.02, 0.72, 0.9)]);
    expect(result.quote).toBe('合成项目甲 18.2 U/L | 3.0-9.0');
  });
});
