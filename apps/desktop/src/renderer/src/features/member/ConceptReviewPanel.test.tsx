// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ConceptReviewBundle } from '@contracts';
import { ConceptReviewPanel } from './ConceptReviewPanel.js';

const bundle: ConceptReviewBundle = {
  personId: 'person-1',
  dictionaryVersion: 'concepts-v1',
  catalog: [{
    id: 'thyroid-tsh', version: 'concepts-v1', canonicalName: '促甲状腺激素',
    aliases: ['TSH'], specimen: '血清', compatibleUnits: ['miu/l'],
    systemLinks: [{ systemId: 'endocrine_metabolic', relation: 'direct' }]
  }],
  items: [{
    observationId: 'observation-1', rawName: '院内简称 X', displayValue: '6.2', unit: 'mIU/L', clinicalDate: '2026-09-18',
    mapping: { rawName: '院内简称 X', normalizedName: '院内简称 X', conceptId: null, canonicalName: null, status: 'unmapped', confidence: 0, reasons: ['词典中没有精确映射。'] },
    mappingVersion: 'concepts-v1', correctedAt: null, canUndo: false,
    evidence: { id: 'evidence-1', kind: 'observation', observationId: 'observation-1', eventId: null, documentId: 'document-1', sourceSpanId: 'span-1', knowledgeId: null, label: '合成报告', locator: '第 1 页', quote: '院内简称 X 6.2 mIU/L' }
  }, {
    observationId: 'observation-2', rawName: 'TSH', displayValue: '2.1', unit: 'mIU/L', clinicalDate: '2025-09-18',
    mapping: { rawName: 'TSH', normalizedName: '促甲状腺激素', conceptId: 'thyroid-tsh', canonicalName: '促甲状腺激素', status: 'verified', confidence: 1, reasons: ['名称精确匹配。'] },
    mappingVersion: 'user:correction-1', correctedAt: '2026-09-18T00:00:00.000Z', canUndo: true,
    evidence: { id: 'evidence-2', kind: 'observation', observationId: 'observation-2', eventId: null, documentId: 'document-2', sourceSpanId: 'span-2', knowledgeId: null, label: '合成报告', locator: '第 2 页', quote: 'TSH 2.1 mIU/L' }
  }]
};

afterEach(cleanup);

describe('ConceptReviewPanel', () => {
  it('默认收起高级整理，打开后显示待整理与已修正项目并能保存或撤销', () => {
    const onSave = vi.fn();
    const onUndo = vi.fn();
    render(<ConceptReviewPanel bundle={bundle} busyObservationId={null} onSave={onSave} onUndo={onUndo} onOpenEvidence={vi.fn()} />);

    expect(screen.queryByText('院内简称 X')).toBeNull();
    expect(screen.getByText('发现指标名称或趋势分组不对？')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '打开高级整理' }));
    expect(screen.getByRole('button', { name: '收起高级整理' })).toBeTruthy();
    expect(screen.getByText('院内简称 X')).toBeTruthy();
    expect(screen.getByText('TSH')).toBeTruthy();
    const selectors = screen.getAllByRole('combobox');
    fireEvent.change(selectors[0]!, { target: { value: 'thyroid-tsh' } });
    fireEvent.click(screen.getAllByRole('button', { name: '保存归类' })[0]!);
    expect(onSave).toHaveBeenCalledWith({
      personId: 'person-1', observationId: 'observation-1', conceptId: 'thyroid-tsh', reason: '用户在指标整理页确认概念归类'
    });
    fireEvent.click(screen.getByRole('button', { name: '撤销上次修正' }));
    expect(onUndo).toHaveBeenCalledWith('observation-2');
  });
});
