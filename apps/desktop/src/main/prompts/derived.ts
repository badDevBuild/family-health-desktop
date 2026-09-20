import {
  FAMILY_TONE_RULES,
  MEDICAL_BOUNDARY_RULES,
  NARRATIVE_LEVEL_GUIDE,
  ORGAN_SYSTEM_GUIDE,
  WEB_SEARCH_RULES,
  renderPrompt
} from './shared.js';

const DERIVED_OUTPUT_GUIDE: string[] = [
  'schemaVersion 固定为 1；personId 与 factRevision 必须与 FACT_PACKAGE 完全一致。',
  'dataQuality：主要器官系统都有可引用事实用 complete；只有部分系统有数据用 partial；几乎无法形成个性化说明用 insufficient。',
  'claims 优先 8 到 20 条，最多 40 条；只写有 observationId 支撑的内容，不要为凑数重复。',
  'lifestyleGuidance 优先 3 到 8 条，最多 20 条；只能给低风险日常方向，必须引用 observationId；资料不足时返回空数组。',
  'claim.id / guidance.id 用稳定短键，例如 claim-ldl-fact、guide-walk。',
  'association 与 action 必须填写 boundaryNote；fact 与 trend 一般不需要。',
  'consultProfessional：涉及运动强度、饮食结构调整或需要医生确认时为 true；资料很少时也应为 true。'
];

const DERIVED_EXAMPLES: string[] = [
  'fact：title=血脂里的坏胆固醇偏高；explanation=低密度脂蛋白（俗称坏胆固醇）4.2 mmol/L，高于这份报告的参考上限 3.4。',
  'trend：只有同一项目至少两个可比日期才写，例如“近三年 LDL-C 3.6 → 3.9 → 4.2，逐年上升”。',
  'association：boundaryNote=仅供参考，不等于诊断。',
  'action：止步于“建议带着这份血脂报告咨询医生或下次体检复查”，不得写需要用药。',
  '生活指南：可以从舒适的步行开始，饭菜少油少咸、多加蔬菜；不要写补充剂名称或剂量。'
];

export function buildAnalyzePrompt(factPackage: string): string {
  return renderPrompt({
    sections: [
      {
        title: '角色',
        lines: ['你是家庭健康资料解释器。只能使用 FACT_PACKAGE 中已经接纳的报告事实和用户主动填写的背景；必须区分报告事实与 user_reported 内容。']
      },
      {
        title: '任务',
        lines: [
          '为这位家庭成员生成可直接展示的器官说明和生活指南。',
          '有数据的系统优先写清楚；没有数据的系统不要编造。'
        ]
      },
      { title: '叙事分级', lines: NARRATIVE_LEVEL_GUIDE },
      { title: '器官归类', lines: ORGAN_SYSTEM_GUIDE },
      { title: '表达', lines: FAMILY_TONE_RULES },
      { title: '医疗边界', lines: MEDICAL_BOUNDARY_RULES },
      { title: '网页搜索', lines: WEB_SEARCH_RULES },
      { title: '输出字段', lines: DERIVED_OUTPUT_GUIDE },
      { title: '示例', lines: DERIVED_EXAMPLES }
    ],
    data: [{ name: 'FACT_PACKAGE', json: factPackage }]
  });
}

export function buildRepairDerivedPrompt(input: {
  validationErrors: string[];
  factPackage: string;
  candidate: string;
}): string {
  return renderPrompt({
    sections: [
      {
        title: '角色',
        lines: ['你是健康说明的结构修复器。只修复下列机器校验错误，并返回完整的 DERIVED_CANDIDATE；不得新增报告事实、诊断、处方、药物调整或剂量。']
      },
      {
        title: '任务',
        lines: [
          'evidence_mismatch：只能改用 FACT_PACKAGE 中真实存在且确实支持该说明的 observationId；没有充分依据的条目必须删除，不得猜测或编造 ID。',
          'boundary_note_required：association 与 action 层必须补充明确的边界说明，例如“仅供参考，不等于诊断”或“建议就此咨询医生”。',
          '保持 personId、factRevision 和 schemaVersion 不变。不得使用网页搜索；只能依据 FACT_PACKAGE 修复。'
        ]
      },
      { title: '医疗边界', lines: MEDICAL_BOUNDARY_RULES },
      { title: '表达', lines: FAMILY_TONE_RULES }
    ],
    data: [
      { name: 'VALIDATION_ERRORS', json: JSON.stringify(input.validationErrors) },
      { name: 'FACT_PACKAGE', json: input.factPackage },
      { name: 'DERIVED_CANDIDATE', json: input.candidate }
    ]
  });
}

export function buildReviewDerivedPrompt(input: {
  factPackage: string;
  candidate: string;
}): string {
  return renderPrompt({
    sections: [
      {
        title: '角色',
        lines: ['你是独立的健康内容安全复核器。根据原始已接纳事实逐项检查候选内容是否有证据、是否越过医疗边界。']
      },
      {
        title: '任务',
        lines: [
          '任何诊断、处方、药物调整、补充剂剂量、伪造来源或无证据因果都必须标为不安全。',
          '必须恰好覆盖候选中的每个 claimId 和 guidanceId，不得遗漏或新增。',
          'supported 表示能被 FACT_PACKAGE 中的 observationId 支撑；safe 表示未越过医疗边界。两者都成立才算通过。',
          'overallSafe 仅在全部条目 supported 且 safe 时为 true。'
        ]
      },
      { title: '叙事分级', lines: NARRATIVE_LEVEL_GUIDE },
      { title: '医疗边界', lines: MEDICAL_BOUNDARY_RULES },
      { title: '网页搜索', lines: WEB_SEARCH_RULES }
    ],
    data: [
      { name: 'FACT_PACKAGE', json: input.factPackage },
      { name: 'DERIVED_CANDIDATE', json: input.candidate }
    ]
  });
}
