import { describe, expect, it } from 'vitest';
import { sameAdoptedActionScope } from './member-action-match.js';

describe('跨版本已采纳行动匹配', () => {
  it('稳定键和身体范围都一致才复用旧行动', () => {
    const current = { dedupeKey: 'lipid-risk-context', systemIds: ['cardiovascular'] };
    expect(sameAdoptedActionScope({
      dedupeKey: 'lipid-risk-context', relatedSystemIds: ['cardiovascular', 'endocrine_metabolic']
    }, current)).toBe(true);
    expect(sameAdoptedActionScope({
      dedupeKey: 'lipid-risk-context', relatedSystemIds: ['renal_urinary']
    }, current)).toBe(false);
    expect(sameAdoptedActionScope({
      dedupeKey: 'another-topic', relatedSystemIds: ['cardiovascular']
    }, current)).toBe(false);
    expect(sameAdoptedActionScope({
      dedupeKey: 'legacy:old-row', relatedSystemIds: ['cardiovascular']
    }, { ...current, dedupeKey: 'legacy:old-row' })).toBe(false);
    expect(sameAdoptedActionScope({
      dedupeKey: 'lipid-risk-context', relatedSystemIds: []
    }, current)).toBe(false);
  });
});
