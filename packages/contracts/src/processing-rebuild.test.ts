import { describe, expect, it } from 'vitest';
import { rebuildProcessingInputSchema } from './processing-rebuild.js';

describe('全量重建强确认与成员别名输入', () => {
  const personId = '10000000-0000-4000-8000-000000000001';
  const source = { documentId: '20000000-0000-4000-8000-000000000001', personId,
    sourceObjectId: '30000000-0000-4000-8000-000000000001', sha256: 'a'.repeat(64) };
  const base = { consentVersion: 1, confirmedRebuildReportResults: true, expectedSources: [source] };

  it('必须强确认报告结果从零重建，允许省略别名或明确绑定到成员', () => {
    expect(rebuildProcessingInputSchema.safeParse(base).success).toBe(true);
    expect(rebuildProcessingInputSchema.safeParse({ ...base, confirmedRebuildReportResults: false }).success).toBe(false);
    expect(rebuildProcessingInputSchema.parse({ ...base,
      confirmedPersonAliases: [{ personId, reportedName: ' 合成昵称 ' }] }).confirmedPersonAliases)
      .toEqual([{ personId, reportedName: '合成昵称' }]);
  });

  it('不接受空白、超长、重复规范名或超出批量上限的别名', () => {
    for (const aliases of [
      [{ personId, reportedName: ' ' }],
      [{ personId, reportedName: '合'.repeat(81) }],
      [{ personId, reportedName: '合成Ａ' }, { personId, reportedName: '合成A' }],
      Array.from({ length: 21 }, (_, index) => ({ personId, reportedName: `合成${index}` }))
    ]) {
      expect(rebuildProcessingInputSchema.safeParse({ ...base, confirmedPersonAliases: aliases }).success).toBe(false);
    }
  });

  it('拒绝不合法成员编号和额外字段，别名本身不能决定成员归属', () => {
    expect(rebuildProcessingInputSchema.safeParse({ ...base,
      confirmedPersonAliases: [{ personId: 'unknown', reportedName: '合成昵称' }] }).success).toBe(false);
    expect(rebuildProcessingInputSchema.safeParse({ ...base,
      confirmedPersonAliases: [{ personId, reportedName: '合成昵称', trustModelIdentity: true }] }).success).toBe(false);
  });

  it('清空本人补充和计划必须与单独强确认配对，不能只靠重建报告确认', () => {
    expect(rebuildProcessingInputSchema.safeParse({ ...base, clearPersonalData: true }).success).toBe(false);
    expect(rebuildProcessingInputSchema.safeParse({ ...base, confirmedClearPersonalData: true }).success).toBe(false);
    expect(rebuildProcessingInputSchema.safeParse({ ...base, clearPersonalData: true, confirmedClearPersonalData: true }).success).toBe(true);
    expect(rebuildProcessingInputSchema.safeParse({ ...base, clearPersonalData: false, confirmedClearPersonalData: true }).success).toBe(false);
  });

  it('可明确选择一至二十位成员，省略范围仍兼容全工作区重建', () => {
    const personIds = Array.from({ length: 20 }, (_, index) =>
      `10000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`);
    expect(rebuildProcessingInputSchema.parse(base)).not.toHaveProperty('personIds');
    expect(rebuildProcessingInputSchema.parse({ ...base, personIds: [personId] }).personIds).toEqual([personId]);
    expect(rebuildProcessingInputSchema.parse({ ...base, personIds }).personIds).toEqual(personIds);
    expect(rebuildProcessingInputSchema.parse({ ...base, personIds: [personId],
      clearPersonalData: true, confirmedClearPersonalData: true }).personIds).toEqual([personId]);
  });

  it('成员范围拒绝空集合、重复、非法编号及超过二十位，不能退化为全局清空', () => {
    const tooMany = Array.from({ length: 21 }, (_, index) =>
      `10000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`);
    for (const personIds of [[], [personId, personId], ['not-a-uuid'], tooMany]) {
      expect(rebuildProcessingInputSchema.safeParse({ ...base, personIds,
        clearPersonalData: true, confirmedClearPersonalData: true }).success).toBe(false);
    }
  });

  it('必须绑定非空且唯一的完整原件身份，拒绝缺失、非法身份和跨出所选成员的预览', () => {
    const { expectedSources: _expectedSources, ...withoutPreview } = base;
    expect(rebuildProcessingInputSchema.safeParse(withoutPreview).success).toBe(false);
    for (const expectedSources of [[], [source, source], [{ ...source, sha256: 'unknown' }],
      [{ ...source, sourceObjectId: 'unknown' }], [{ ...source, personId: 'unknown' }],
      [{ ...source, sourcePath: '/synthetic/private/source.txt' }]]) {
      expect(rebuildProcessingInputSchema.safeParse({ ...base, expectedSources }).success).toBe(false);
    }
    expect(rebuildProcessingInputSchema.safeParse({ ...base,
      personIds: ['10000000-0000-4000-8000-000000000002'] }).success).toBe(false);
  });
});
