import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { extractionResultSchema, knowledgeSourceCandidateSchema, memberAssessmentCandidateV3Schema } from '@contracts';
import { toCodexOutputSchema } from './structured-output-schema.js';

function hasKey(value: unknown, target: string): boolean {
  if (Array.isArray(value)) return value.some((item) => hasKey(item, target));
  if (typeof value !== 'object' || value === null) return false;
  return Object.entries(value).some(([key, child]) => key === target || hasKey(child, target));
}

describe('toCodexOutputSchema', () => {
  it('把体检提取 Schema 中的嵌套 oneOf 转为 Codex 支持的 anyOf', () => {
    const draft7 = z.toJSONSchema(extractionResultSchema, { target: 'draft-7' }) as Record<string, unknown>;
    expect(hasKey(draft7, 'oneOf')).toBe(true);

    const compatible = toCodexOutputSchema(draft7);

    expect(hasKey(compatible, 'oneOf')).toBe(false);
    expect(hasKey(compatible, 'anyOf')).toBe(true);
    expect(hasKey(draft7, 'oneOf')).toBe(true);
  });

  it('拒绝根节点联合，避免把服务端必然拒绝的 Schema 发出去', () => {
    expect(() => toCodexOutputSchema({ oneOf: [{ type: 'object' }, { type: 'object' }] }))
      .toThrow('CODEX_OUTPUT_SCHEMA_ROOT_UNION_UNSUPPORTED');
  });

  it('移除 V3 候选 URL 的不支持 uri 格式，但保留本地 URL 校验与受支持的日期格式', () => {
    const draft7 = z.toJSONSchema(memberAssessmentCandidateV3Schema, { target: 'draft-7' }) as Record<string, unknown>;
    const compatible = toCodexOutputSchema(draft7);
    expect(JSON.stringify(draft7)).toContain('"format":"uri"');
    expect(JSON.stringify(compatible)).not.toContain('"format":"uri"');
    expect(toCodexOutputSchema({ type: 'string', format: 'date-time' })).toEqual({ type: 'string', format: 'date-time' });
    expect(knowledgeSourceCandidateSchema.safeParse({ id: 'source', title: '合成来源', organization: null,
      url: 'not-a-url', origin: 'retrieved', supports: '合成用途' }).success).toBe(false);
  });
});
