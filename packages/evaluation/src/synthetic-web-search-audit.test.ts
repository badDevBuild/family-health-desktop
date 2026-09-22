import { describe, expect, it } from 'vitest';
import { completedSyntheticSearchAction, syntheticQueryMatchKinds } from './synthetic-web-search-audit.js';

describe('纯合成 Web Search 发送后观察', () => {
  it('兼容 App Server 的 queries 数组与旧式 query 字段', () => {
    expect(completedSyntheticSearchAction({ id: 'one', type: 'webSearch', action: {
      type: 'search', queries: ['LDL cholesterol guidance', 'lipid guideline']
    } })).toEqual({ id: 'one', queries: ['LDL cholesterol guidance', 'lipid guideline'] });
    expect(completedSyntheticSearchAction({ id: 'two', type: 'webSearch', action: {
      type: 'search', query: 'general medical question'
    } })).toEqual({ id: 'two', queries: ['general medical question'] });
    expect(completedSyntheticSearchAction({ id: 'three', type: 'webSearch', action: {
      type: 'search', queries: [], query: 'fallback medical question'
    } })).toEqual({ id: 'three', queries: ['fallback medical question'] });
  });

  it('查询正文不可见时返回 null，不把无法观察冒充安全', () => {
    expect(completedSyntheticSearchAction({ id: 'one', type: 'webSearch', action: {
      type: 'search', queries: null, query: null
    } })).toEqual({ id: 'one', queries: null });
    expect(completedSyntheticSearchAction({ id: 'two', type: 'webSearch', action: {
      type: 'search', queries: []
    } })).toEqual({ id: 'two', queries: null });
    expect(completedSyntheticSearchAction({ id: 'three', type: 'webSearch', action: { type: 'openPage' } })).toBeNull();
  });

  it('只回报虚构个人片段的命中类别，不回报原始查询文本', () => {
    expect(syntheticQueryMatchKinds(
      ['synthetic-person-a024 LDL-C 4.1', '2025-09-21 lipid information'],
      'synthetic-person-a024', [{ clinicalDate: '2025-09-21', rawValue: '4.1' }]
    )).toEqual(['member_id', 'clinical_date', 'measurement_value']);
    expect(syntheticQueryMatchKinds(
      ['general lipid guideline'], 'synthetic-person-a024', [{ clinicalDate: '2025-09-21', rawValue: '4.1' }]
    )).toEqual([]);
    expect(syntheticQueryMatchKinds(
      ['version 14.1 lipid guidance'], 'synthetic-person-a024', [{ clinicalDate: '2025-09-21', rawValue: '4.1' }]
    )).toEqual([]);
  });
});
