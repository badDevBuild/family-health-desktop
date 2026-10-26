import { describe, expect, it } from 'vitest';
import { assertDirectOriginalPromptBudget, DIRECT_ORIGINAL_PROMPT_MAX_BYTES } from './direct-original-extraction.js';

describe('整份原件提示词的本地字节预算', () => {
  it('现有 256 KiB 限额不因表示优化放宽，等于预算时逐字返回', () => {
    expect(DIRECT_ORIGINAL_PROMPT_MAX_BYTES).toBe(262_144);
    const prompt = 'x'.repeat(DIRECT_ORIGINAL_PROMPT_MAX_BYTES);
    expect(assertDirectOriginalPromptBudget(prompt)).toBe(prompt);
  });

  it('多一个字节明确拒绝，不截断或自动拆段', () => {
    expect(() => assertDirectOriginalPromptBudget('x'.repeat(DIRECT_ORIGINAL_PROMPT_MAX_BYTES + 1)))
      .toThrow('DIRECT_ORIGINAL_CONTEXT_LIMIT_EXCEEDED');
  });

  it('按 UTF-8 而非字符数检查，原文、比较符和日期角色不改写', () => {
    const prompt = '合成原句：左侧；<2.50E＋02；sampled；未散瞳';
    const bytes = Buffer.byteLength(prompt, 'utf8');
    expect(bytes).toBeGreaterThan(prompt.length);
    expect(assertDirectOriginalPromptBudget(prompt, bytes)).toBe(prompt);
    expect(() => assertDirectOriginalPromptBudget(prompt, bytes - 1)).toThrow('DIRECT_ORIGINAL_CONTEXT_LIMIT_EXCEEDED');
  });

  it.each([0, -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])('不接受无效预算 %s', (budget) => {
    expect(() => assertDirectOriginalPromptBudget('合成请求', budget)).toThrow('DIRECT_ORIGINAL_PROMPT_BUDGET_INVALID');
  });
});
