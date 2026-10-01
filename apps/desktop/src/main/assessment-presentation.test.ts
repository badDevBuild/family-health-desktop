import { describe, expect, it } from 'vitest';
import { memberAssessmentSnapshotV3Schema, type HealthClaim, type MemberAssessmentSnapshotV3 } from '@contracts';
import { presentMemberAssessment } from './assessment-presentation.js';

function claim(id: string, text: string): HealthClaim {
  return { id, topicKey: id, systemIds: ['cardiovascular'], kind: 'source_fact', text,
    diseaseName: null, diagnosticStatus: null, temporalStatus: 'current', evidenceIds: ['source-1'],
    counterEvidenceIds: [], trendIds: [], knowledgeBasis: 'not_applicable', knowledgeSourceIds: [],
    criteriaBasis: null, rationale: '合成原报告记载。', materialUncertainty: null, consequenceLevel: 'routine' };
}

function fixture(): MemberAssessmentSnapshotV3 {
  return {
    schemaVersion: 3, personId: 'synthetic-person', inputSignature: 'a'.repeat(64), mode: 'full',
    requestedSystemIds: ['cardiovascular'], id: 'synthetic-snapshot', status: 'current',
    generatedAt: '2026-10-01T00:00:00Z', factRevision: 1, contextRevision: 0,
    reviewScopeSignature: 'b'.repeat(64), promptVersion: 'synthetic', rulesVersion: 'synthetic',
    modelId: 'synthetic', reasoningEffort: 'medium', validationMode: 'local_only', reviewedTargetIds: [],
    heldTargetIds: ['claim-held', 'action-held'], limitations: [], evidenceCatalog: [],
    processingPlan: { strategy: 'full', trigger: 'none', partitionCount: 0 }, knowledgeVerifications: [],
    overview: { id: 'overview', headline: '部分健康判断仍需核实',
      summary: '已接纳的报告事实和其他行动仍可查看；有部分判断暂未纳入本次总览。',
      claimIds: ['claim-first', 'claim-second'], actionIds: [], limitations: [] },
    systems: [{ id: 'system:cardiovascular', systemId: 'cardiovascular', status: 'monitor',
      headline: '部分判断仍需核实', summary: '已接纳的报告事实仍可查看；本系统有部分判断暂未纳入本次解读。',
      claimIds: ['claim-first', 'claim-second'], actionIds: [], limitations: ['部分判断因证据不足暂未发布。'] }],
    claims: [
      { ...claim('claim-first', '合成检查项目甲有变化，但不能单凭这一项确定原因。'), materialUncertainty: '检查条件尚不完整。' },
      claim('claim-second', '合成检查项目乙连续两次处于报告参考范围。')
    ], actions: [], questions: [], knowledgeSources: []
  };
}

describe('成员综合只读摘要投影', () => {
  it('旧快照直接显示保留的具体解读；不改存档、引用、模型版本或执行路径', () => {
    const snapshot = fixture();
    const before = JSON.stringify(snapshot);
    const presented = presentMemberAssessment(snapshot);
    expect(presented.overview.headline).toBe(snapshot.claims[0]!.text);
    expect(presented.systems[0]!.summary).toContain('检查条件尚不完整。');
    expect(presented.systems[0]!.summary).toContain(snapshot.claims[1]!.text);
    expect(presented.presentation?.rebuiltNodeIds).toEqual(['overview', 'system:cardiovascular']);
    expect(memberAssessmentSnapshotV3Schema.safeParse(presented).success).toBe(true);
    expect(presented.claims).toBe(snapshot.claims);
    expect(presented.evidenceCatalog).toBe(snapshot.evidenceCatalog);
    expect(presented.heldTargetIds).toBe(snapshot.heldTargetIds);
    expect(JSON.stringify(snapshot)).toBe(before);
    expect(presentMemberAssessment(presented)).toEqual(presented);
  });

  it('只有行动被排除也能从原有判断恢复摘要，不沿用可能包含被排除建议的旧摘要', () => {
    const snapshot = fixture();
    snapshot.heldTargetIds = ['action-held'];
    expect(presentMemberAssessment(snapshot).systems[0]!.headline).toBe(snapshot.claims[0]!.text);
  });

  it('不恢复被隔离或不存在的节点，不把另一个系统的判断借过来填空', () => {
    const snapshot = fixture();
    snapshot.claims.push(claim('claim-held', '不得重新展示的内容。'));
    snapshot.systems[0]!.claimIds = ['claim-held', 'missing'];
    const presented = presentMemberAssessment(snapshot);
    expect(presented.systems[0]!.headline).toBe('暂未形成完整解读');
    expect(presented.systems[0]!.summary).not.toContain('不得重新展示');
    expect(presented.systems[0]!.summary).not.toContain(snapshot.claims[0]!.text);
  });

  it('其他系统的有效摘要与健康状态不受局部隔离影响', () => {
    const snapshot = fixture();
    snapshot.systems.push({ ...snapshot.systems[0]!, id: 'system:respiratory', systemId: 'respiratory',
      status: 'no_signal_in_scope', headline: '合成呼吸检查未提示问题', summary: '这是原有有效摘要。', limitations: [] });
    const presented = presentMemberAssessment(snapshot);
    expect(presented.systems[1]).toBe(snapshot.systems[1]);
    expect(presented.systems[1]!.status).toBe('no_signal_in_scope');
  });

  it('摘要容量不足时整条留在详情，绝不截掉尾部否定或不确定条件', () => {
    const snapshot = fixture();
    snapshot.claims[0]!.materialUncertainty = '合成条件。'.repeat(399);
    snapshot.claims[1]!.text = '前文。'.repeat(400) + '但不能据此确诊。';
    const presented = presentMemberAssessment(snapshot);
    expect(presented.systems[0]!.summary).toBe(snapshot.claims[0]!.materialUncertainty);
    expect(presented.claims[1]!.text).toBe(snapshot.claims[1]!.text);
    expect(memberAssessmentSnapshotV3Schema.safeParse(presented).success).toBe(true);
  });

  it('无局部隔离的正常结果完全不变', () => {
    const snapshot = fixture();
    snapshot.heldTargetIds = [];
    expect(presentMemberAssessment(snapshot)).toBe(snapshot);
  });
});
