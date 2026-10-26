import { describe, expect, it } from 'vitest';
import type { HealthAction, HealthClaim, MemberEvidenceRef } from '@contracts';
import {
  buildIndependentHabitEvidencePermission, findIndependentHabitRepairCandidateIds, isIndependentHabitRepairReplacement,
  type IndependentHabitRepairCandidateInput, type IndependentHabitRepairEvidenceScope
} from './assessment-independent-habit-repair.js';

function evidence(overrides: Partial<MemberEvidenceRef> = {}): MemberEvidenceRef {
  return { id: 'synthetic-source', kind: 'observation', observationId: 'synthetic-observation',
    eventId: 'synthetic-event', documentId: 'synthetic-document', sourceSpanId: 'synthetic-span', knowledgeId: null,
    label: '合成资料', locator: '合成页1', quote: '本人补充：平时吃蔬菜较少。', ...overrides };
}

function claim(overrides: Partial<HealthClaim> = {}): HealthClaim {
  return { id: 'synthetic-surviving-claim', topicKey: 'synthetic-context', systemIds: ['endocrine_metabolic'],
    kind: 'source_fact', text: '本人记录平时吃蔬菜较少。', diseaseName: null, diagnosticStatus: null,
    temporalStatus: 'current', evidenceIds: ['synthetic-source'], counterEvidenceIds: [], trendIds: [],
    knowledgeBasis: 'not_applicable', knowledgeSourceIds: [], criteriaBasis: null,
    rationale: '合成生活记录。', materialUncertainty: null, consequenceLevel: 'routine', ...overrides };
}

function action(overrides: Partial<HealthAction> = {}): HealthAction {
  return { id: 'synthetic-action', dedupeKey: 'synthetic-diet-action', systemIds: ['endocrine_metabolic'],
    claimIds: ['synthetic-held-claim'], kind: 'habit', lifestyleDomain: 'diet', lifestyleBasis: 'personalized',
    title: '调整三餐搭配', why: '结合原判断和饮食记录调整三餐。', firstStep: '午餐先加一份蔬菜。',
    timing: '从这周开始尝试。', timingBasis: 'practical_trial', reviewPlan: '一周后回看是否容易坚持。',
    caution: '若已有医生要求的饮食限制，遵循原安排。', urgency: 'routine', evidenceIds: ['synthetic-source'],
    knowledgeSourceIds: ['synthetic-knowledge'], ...overrides };
}

function selectionInput(overrides: Partial<IndependentHabitRepairCandidateInput> = {}): IndependentHabitRepairCandidateInput {
  return { candidate: { claims: [claim()], actions: [action()] }, heldClaimIds: ['synthetic-held-claim'],
    heldActionIds: [], evidenceCatalog: [evidence()], ...overrides };
}

function rewrittenAction(overrides: Partial<HealthAction> = {}): HealthAction {
  return action({ claimIds: [], why: '本人饮食记录中蔬菜较少，可先从容易坚持的搭配开始。', ...overrides });
}

describe('独立日常行动补救候选', () => {
  it('历史补充背景与没有依据新增的语句不会将独立生活建议当成新增服用', () => {
    const original = action({ lifestyleDomain: 'supplements', title: '整理营养产品记录',
      why: '旧资料已有营养补充文字，目前没有依据再额外添加合成保健品。', firstStep: '整理目前产品标签和饮食记录。' });
    const replacement = { ...original, claimIds: [],
      why: '诊疗意见涉及营养补充及膳食，目前尚无依据额外添加合成保健品。' };
    expect(isIndependentHabitRepairReplacement(original, replacement)).toBe(true);
    for (const why of ['旧资料记录曾服用合成保健品。', '过去服用合成保健品。', '原报告记载曾服用合成维生素。']) {
      expect(isIndependentHabitRepairReplacement(original, { ...replacement, why }), why).toBe(true);
    }
    for (const why of ['尚无依据额外添加合成保健品，但是现在请服用合成保健品。',
      '旧资料已有营养补充文字，因此建议每天服用合成保健品。',
      '按照原报告继续服用合成保健品。',
      '根据原记录开始服用合成保健品。',
      '参照过去的安排开始服用合成维生素。',
      '并非不要补充合成维生素。',
      '并非没有依据额外添加合成保健品。',
      '请补充合成维生素 800 IU。']) {
      expect(isIndependentHabitRepairReplacement(original, { ...replacement, why }), why).toBe(false);
    }
  });

  it('保留有自身个人依据的旧行动，但不修改旧行动或删除失效引用', () => {
    const input = selectionInput();
    const before = structuredClone(input);
    expect(findIndependentHabitRepairCandidateIds(input)).toEqual(['synthetic-action']);
    expect(input).toEqual(before);
    expect(input.candidate.actions[0]!.claimIds).toEqual(['synthetic-held-claim']);
  });

  it('自身依据为空时仍可凭有效且未隔离的关联主张进入补救', () => {
    const input = selectionInput({ candidate: { claims: [claim()], actions: [action({ evidenceIds: [],
      claimIds: ['synthetic-held-claim', 'synthetic-surviving-claim'] })] } });
    expect(findIndependentHabitRepairCandidateIds(input)).toEqual(['synthetic-action']);
  });

  it.each(['missing', 'held', 'unsupported'] as const)('不把%s关联主张当作仍有效依据', (caseName) => {
    const input = selectionInput({ candidate: { claims: caseName === 'missing' ? [] : [claim({
      evidenceIds: caseName === 'unsupported' ? ['synthetic-missing-source'] : ['synthetic-source'] })],
    actions: [action({ evidenceIds: [], claimIds: ['synthetic-held-claim', 'synthetic-surviving-claim'] })] },
    heldClaimIds: caseName === 'held' ? ['synthetic-held-claim', 'synthetic-surviving-claim'] : ['synthetic-held-claim'] });
    expect(findIndependentHabitRepairCandidateIds(input)).toEqual([]);
  });

  it.each(['knowledge', 'event_metadata', 'missing', 'unlocated', 'empty_note'] as const)(
    '不把%s引用当作可靠个人依据', (caseName) => {
      const reference = caseName === 'missing' ? evidence({ id: 'synthetic-unrelated' })
        : caseName === 'unlocated' ? evidence({ documentId: null, sourceSpanId: null })
          : caseName === 'empty_note' ? evidence({ kind: 'user_note', quote: '  ' })
            : evidence({ kind: caseName });
      expect(findIndependentHabitRepairCandidateIds(selectionInput({ evidenceCatalog: [reference] }))).toEqual([]);
    }
  );

  it('允许有不可变正文的本人补充及可定位的整段原文引用', () => {
    expect(findIndependentHabitRepairCandidateIds(selectionInput({ evidenceCatalog: [evidence({
      kind: 'user_note', documentId: null, sourceSpanId: null, observationId: null })] }))).toEqual(['synthetic-action']);
    expect(findIndependentHabitRepairCandidateIds(selectionInput({ evidenceCatalog: [evidence({ quote: null })] })))
      .toEqual(['synthetic-action']);
  });

  it('知识来源不能伪装成可定位的个人依据', () => {
    expect(findIndependentHabitRepairCandidateIds(selectionInput({ evidenceCatalog: [evidence({
      knowledgeId: 'synthetic-knowledge' })] }))).toEqual([]);
  });

  it.each([
    ['显式隔离', {}, ['synthetic-action']],
    ['非日常行动', { kind: 'test_followup' }, []],
    ['非普通时效', { urgency: 'urgent' }, []],
    ['直改药', { firstStep: '请开始服用阿托伐他汀。' }, []],
    ['高后果断言', { why: '目前高度怀疑肺癌。' }, []],
    ['数字补充剂', { lifestyleDomain: 'supplements', firstStep: '每日补充维生素D 1000 IU。' }, []],
    ['原文医嘱绑定', { sourceInstructionObservationId: 'synthetic-observation' }, []],
    ['未受隔离主张影响', { claimIds: ['synthetic-surviving-claim'] }, []]
  ] as Array<[string, Partial<HealthAction>, string[]]>)('%s不能使用此补救通道', (_label, overrides, heldActionIds) => {
    expect(findIndependentHabitRepairCandidateIds(selectionInput({ candidate: { claims: [claim()],
      actions: [action(overrides)] }, heldActionIds }))).toEqual([]);
  });

  it('按候选原顺序返回去重 ID', () => {
    expect(findIndependentHabitRepairCandidateIds(selectionInput({ candidate: { claims: [],
      actions: [action({ id: 'synthetic-second' }), action(), action()] } })))
      .toEqual(['synthetic-second', 'synthetic-action']);
  });
});

describe('独立日常行动补救替换权限', () => {
  it('允许同一行动据原有依据重写解释，并删除失效关联', () => {
    const original = action();
    const replacement = rewrittenAction();
    expect(isIndependentHabitRepairReplacement(original, replacement)).toBe(true);
    expect(original.claimIds).toEqual(['synthetic-held-claim']);
  });

  it.each([
    { claimIds: [] }, { evidenceIds: [] }, { knowledgeSourceIds: [] },
    { lifestyleBasis: undefined }, { claimIds: [], evidenceIds: [], knowledgeSourceIds: [], lifestyleBasis: undefined }
  ])('仅移除依据元数据不算补救：%j', (overrides) => {
    expect(isIndependentHabitRepairReplacement(action(), action(overrides))).toBe(false);
  });

  it('空白、标点、全半角及不可见字符变更不算展示内容改写', () => {
    expect(isIndependentHabitRepairReplacement(action(), action({
      title: ' 调整三餐搭配！\u200b', firstStep: '午餐先加一份蔬菜!', claimIds: []
    }))).toBe(false);
    expect(isIndependentHabitRepairReplacement(action({ firstStep: '午餐加1份蔬菜。' }), action({
      firstStep: '午餐加１份蔬菜!', claimIds: []
    }))).toBe(false);
  });

  it.each([
    ['节点 ID', { id: 'synthetic-new-action' }],
    ['行动类型', { kind: 'test_followup' }],
    ['类别', { lifestyleDomain: 'activity' }],
    ['个体依据标签', { lifestyleBasis: 'general' }],
    ['遗漏个体依据标签', { lifestyleBasis: undefined }],
    ['去重键', { dedupeKey: 'synthetic-new-key' }],
    ['系统范围', { systemIds: ['cardiovascular'] }],
    ['时效依据', { timingBasis: 'guideline' }],
    ['更高时效', { urgency: 'soon' }],
    ['新增主张引用', { claimIds: ['synthetic-new-claim'] }],
    ['新增个人依据', { evidenceIds: ['synthetic-new-source'] }],
    ['新增知识依据', { knowledgeSourceIds: ['synthetic-new-knowledge'] }],
    ['新增原文医嘱绑定', { sourceInstructionObservationId: 'synthetic-observation' }],
    ['新增复查安排', { firstStep: '三个月后复查肝功能。' }],
    ['注意栏新增复查安排', { caution: '三个月后复查肝功能。' }],
    ['注意栏新增定期就诊', { caution: '如有不适，每周就医。' }],
    ['新增无剂量补充剂', { firstStep: '每天服用鱼油。' }],
    ['直改药', { firstStep: '请开始服用阿托伐他汀。' }],
    ['高后果断言', { caution: '目前高度怀疑肺癌。' }],
    ['数字补充剂', { title: '维生素D', firstStep: '每日补充维生素D 1000 IU。' }]
  ] as Array<[string, Partial<HealthAction>]>)('不允许改写时改变%s', (_label, overrides) => {
    expect(isIndependentHabitRepairReplacement(action(), rewrittenAction(overrides))).toBe(false);
  });

  it('不能把原有个体医疗指令保留后降为一般建议', () => {
    const original = action({ firstStep: '三个月后复查甲状腺功能。' });
    expect(isIndependentHabitRepairReplacement(original, rewrittenAction({ firstStep: original.firstStep,
      evidenceIds: [], knowledgeSourceIds: [], lifestyleBasis: 'general' }))).toBe(false);
  });

  it('旧行动原本有原文医嘱绑定时不能借独立习惯通道改写', () => {
    expect(isIndependentHabitRepairReplacement(action({ sourceInstructionObservationId: 'synthetic-observation' }),
      rewrittenAction({ sourceInstructionObservationId: 'synthetic-observation' }))).toBe(false);
  });

  it('说明记录供下次就诊了解不是新增医疗安排，仍允许真正的饮食改写', () => {
    expect(isIndependentHabitRepairReplacement(action(), rewrittenAction({
      why: '本人饮食记录中蔬菜较少；记录目前习惯供下次就诊了解。'
    }))).toBe(true);
  });

  it('保留已有安全提示；原本为空时可新增症状出现后的安全停止提示', () => {
    expect(isIndependentHabitRepairReplacement(action({ caution: '如有胸痛，请停止活动并就医。' }),
      rewrittenAction({ caution: '如有胸痛，请停止活动并就医。' }))).toBe(true);
    expect(isIndependentHabitRepairReplacement(action({ caution: null }), rewrittenAction({
      caution: '如出现胸痛，请停止活动并就医。'
    }))).toBe(true);
  });

  it('系统数组顺序变化不扩大授权范围', () => {
    expect(isIndependentHabitRepairReplacement(action({ systemIds: ['endocrine_metabolic', 'cardiovascular'] }),
      rewrittenAction({ systemIds: ['cardiovascular', 'endocrine_metabolic'] }))).toBe(true);
  });

  it('此门禁不替代后续依赖与真实依据校验', () => {
    // 保留失效引用的草稿仍可能是一次真实改写；主流程必须拒绝尚未修好的依赖。
    expect(isIndependentHabitRepairReplacement(action(), rewrittenAction({
      claimIds: ['synthetic-held-claim'] }))).toBe(true);
  });
});

describe('既有关联主张的有限支持闭包权限', () => {
  function scopedInput() {
    const original = action({ evidenceIds: ['synthetic-direct-source'],
      claimIds: ['synthetic-held-claim', 'synthetic-surviving-claim'] });
    const survivingClaims = [claim({ counterEvidenceIds: ['synthetic-counter-source'] }),
      claim({ id: 'synthetic-unrelated-claim', evidenceIds: ['synthetic-unrelated-source'] })];
    const evidenceCatalog = ['synthetic-source', 'synthetic-direct-source', 'synthetic-counter-source',
      'synthetic-unrelated-source', 'synthetic-held-source'].map((id) => evidence({ id }));
    const permission = buildIndependentHabitEvidencePermission({ personId: 'synthetic-person', inputSignature: 'a'.repeat(64),
      originalAction: original, survivingClaims, heldClaimIds: ['synthetic-held-claim'], evidenceCatalog,
      suppliedEvidenceIds: ['synthetic-source', 'synthetic-direct-source', 'synthetic-counter-source',
        'synthetic-unrelated-source', 'synthetic-held-source'] });
    if (!permission) throw new Error('合成支持闭包应可建立');
    const scope: IndependentHabitRepairEvidenceScope = { permission, personId: 'synthetic-person', inputSignature: 'a'.repeat(64),
      survivingClaims, heldClaimIds: ['synthetic-held-claim'], evidenceCatalog };
    return { original, scope, replacement: rewrittenAction({ claimIds: ['synthetic-surviving-claim'] }) };
  }

  it('只允许原行动直引及原已关联存活主张的明示支持来源，且冻结完整绑定', () => {
    const { original, scope, replacement } = scopedInput();
    expect(scope.permission.allowedEvidenceIds).toEqual(['synthetic-direct-source', 'synthetic-source']);
    expect(scope.permission.claimBindings.map(({ id }) => id)).toEqual(['synthetic-surviving-claim']);
    expect(Object.isFrozen(scope.permission)).toBe(true);
    expect(Object.isFrozen(scope.permission.allowedEvidenceIds)).toBe(true);
    expect(Object.isFrozen(scope.permission.claimBindings[0])).toBe(true);
    expect(isIndependentHabitRepairReplacement(original, replacement)).toBe(false);
    expect(isIndependentHabitRepairReplacement(original, replacement, scope)).toBe(true);
  });

  it('独立改写可去掉失效系统，只保留仍有同次冻结主张支持的原系统子集', () => {
    const original = action({ systemIds: ['endocrine_metabolic', 'digestive', 'cardiovascular'],
      claimIds: ['synthetic-held-claim', 'synthetic-surviving-claim', 'synthetic-second-claim'] });
    const survivingClaims = [claim({ systemIds: ['endocrine_metabolic', 'digestive'] }),
      claim({ id: 'synthetic-second-claim', systemIds: ['cardiovascular'], evidenceIds: ['synthetic-second-source'] })];
    const evidenceCatalog = [evidence(), evidence({ id: 'synthetic-second-source' })];
    const permission = buildIndependentHabitEvidencePermission({ personId: 'synthetic-person', inputSignature: 'a'.repeat(64),
      originalAction: original, survivingClaims, heldClaimIds: ['synthetic-held-claim'], evidenceCatalog,
      suppliedEvidenceIds: evidenceCatalog.map((item) => item.id) });
    if (!permission) throw new Error('合成支持闭包应可建立');
    const scope: IndependentHabitRepairEvidenceScope = { permission, personId: 'synthetic-person', inputSignature: 'a'.repeat(64),
      survivingClaims, heldClaimIds: ['synthetic-held-claim'], evidenceCatalog };
    const replacement = rewrittenAction({ systemIds: ['endocrine_metabolic', 'cardiovascular'],
      claimIds: survivingClaims.map((item) => item.id), evidenceIds: evidenceCatalog.map((item) => item.id) });
    expect(isIndependentHabitRepairReplacement(original, replacement, scope)).toBe(true);
    expect(isIndependentHabitRepairReplacement(original, replacement)).toBe(false);
    for (const systemIds of [[], ['endocrine_metabolic'], ['digestive'], ['renal_urinary'],
      ['endocrine_metabolic', 'endocrine_metabolic']] as HealthAction['systemIds'][]) {
      expect(isIndependentHabitRepairReplacement(original, { ...replacement, systemIds }, scope), JSON.stringify(systemIds))
        .toBe(false);
    }
    expect(isIndependentHabitRepairReplacement(original, { ...replacement, claimIds: [] }, scope)).toBe(false);
    // 不改变仍有效的跨系统主张，也不允许把其无关系统移入行动范围。
    expect(scope.survivingClaims[0]!.systemIds).toEqual(['endocrine_metabolic', 'digestive']);
  });

  it('有权限时原行动直接来源也必须验证成员、输入签名和完整来源内容', () => {
    const { original, scope } = scopedInput();
    const replacement = rewrittenAction({ evidenceIds: ['synthetic-direct-source'] });
    expect(isIndependentHabitRepairReplacement(original, replacement, scope)).toBe(true);
    expect(isIndependentHabitRepairReplacement(original, replacement, { ...scope, personId: 'synthetic-other-person' })).toBe(false);
    expect(isIndependentHabitRepairReplacement(original, replacement, { ...scope, inputSignature: 'b'.repeat(64) })).toBe(false);
    expect(isIndependentHabitRepairReplacement(original, replacement, { ...scope,
      evidenceCatalog: scope.evidenceCatalog.map((item) => item.id === 'synthetic-direct-source'
        ? { ...item, quote: '另一条合成记录。' } : item) })).toBe(false);
  });

  it.each(['claim_text', 'claim_support', 'claim_counter', 'claim_removed', 'claim_held',
    'claim_duplicate', 'source_content', 'source_removed', 'source_duplicate', 'source_knowledge', 'action'] as const)(
    '%s发生变化后不能沿用已冻结的补救权限', (caseName) => {
      const { original, scope, replacement } = scopedInput();
      const next = structuredClone(scope);
      let nextOriginal = original;
      if (caseName === 'claim_text') next.survivingClaims = [claim({ text: '另一条合成生活状态。' })];
      if (caseName === 'claim_support') next.survivingClaims = [claim({ evidenceIds: ['synthetic-direct-source'] })];
      if (caseName === 'claim_counter') next.survivingClaims = [claim({ counterEvidenceIds: [] })];
      if (caseName === 'claim_removed') next.survivingClaims = [];
      if (caseName === 'claim_held') next.heldClaimIds = ['synthetic-held-claim', 'synthetic-surviving-claim'];
      if (caseName === 'claim_duplicate') next.survivingClaims = [...next.survivingClaims, claim()];
      if (caseName === 'source_content') next.evidenceCatalog = next.evidenceCatalog.map((item) => item.id === 'synthetic-source'
        ? { ...item, quote: '改变后的合成记录。' } : item);
      if (caseName === 'source_removed') next.evidenceCatalog = next.evidenceCatalog.filter((item) => item.id !== 'synthetic-source');
      if (caseName === 'source_duplicate') next.evidenceCatalog = [...next.evidenceCatalog, evidence()];
      if (caseName === 'source_knowledge') next.evidenceCatalog = next.evidenceCatalog.map((item) => item.id === 'synthetic-source'
        ? { ...item, knowledgeId: 'synthetic-knowledge' } : item);
      if (caseName === 'action') nextOriginal = { ...original, why: '改变后的原行动。' };
      expect(isIndependentHabitRepairReplacement(nextOriginal, replacement, next)).toBe(false);
    }
  );

  it.each(['synthetic-counter-source', 'synthetic-unrelated-source', 'synthetic-held-source', 'synthetic-missing-source'])(
    '不能借整成员目录直引%s', (id) => {
      const { original, scope, replacement } = scopedInput();
      expect(isIndependentHabitRepairReplacement(original, { ...replacement, evidenceIds: [id] }, scope)).toBe(false);
    }
  );

  it('既有支持未在本次目标输入明示时不能扩展直引', () => {
    const { original, scope, replacement } = scopedInput();
    const permission = buildIndependentHabitEvidencePermission({ ...scope, originalAction: original,
      suppliedEvidenceIds: ['synthetic-direct-source'] });
    expect(permission?.allowedEvidenceIds).toEqual(['synthetic-direct-source']);
    expect(isIndependentHabitRepairReplacement(original, replacement, { ...scope, permission: permission! })).toBe(false);
  });

  it('新关联、隔离支持及反证都不能独立建立权限', () => {
    const { original, scope } = scopedInput();
    for (const change of [
      { originalAction: { ...original, claimIds: ['synthetic-held-claim'] } },
      { heldClaimIds: ['synthetic-held-claim', 'synthetic-surviving-claim'] },
      { survivingClaims: [claim({ evidenceIds: [], counterEvidenceIds: ['synthetic-source'] })] }
    ]) {
      expect(buildIndependentHabitEvidencePermission({ ...scope, originalAction: original,
        suppliedEvidenceIds: ['synthetic-source'], ...change })).toBeNull();
    }
  });

  it('原关联主张已明确用同一来源支持并保留限制时，不把双角色误当成反证提升', () => {
    const { original, scope, replacement } = scopedInput();
    const survivingClaims = [claim({ evidenceIds: ['synthetic-source'], counterEvidenceIds: ['synthetic-source'] })];
    const permission = buildIndependentHabitEvidencePermission({ ...scope, originalAction: original,
      survivingClaims, suppliedEvidenceIds: ['synthetic-source'] });
    expect(permission?.allowedEvidenceIds).toEqual(['synthetic-source']);
    expect(isIndependentHabitRepairReplacement(original, replacement, { ...scope, survivingClaims, permission: permission! })).toBe(true);
  });

  it('支持闭包不能新增关联或知识依据，原安全条件仍由完整P04和边界保护', () => {
    const { original, scope, replacement } = scopedInput();
    expect(isIndependentHabitRepairReplacement(original, { ...replacement, claimIds: ['synthetic-unrelated-claim'] }, scope)).toBe(false);
    expect(isIndependentHabitRepairReplacement(original, { ...replacement, knowledgeSourceIds: ['synthetic-new-knowledge'] }, scope)).toBe(false);
    // 资格门禁不取代 P04：普通说明仍走既有规则，不能在本层新增全字段逐字约束。
    expect(isIndependentHabitRepairReplacement(original, { ...replacement,
      caution: '若已有餐食要求，遵循已有安排；资料未确认目前日常习惯。' }, scope)).toBe(true);
  });
});
