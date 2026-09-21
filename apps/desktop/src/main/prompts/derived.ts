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
  'lifestyleGuidance 默认只突出 1 到 3 条，最多 8 条；跨身体系统的相同方向必须使用同一 dedupeKey 并合并为一条，保留全部 relatedSystemIds 和个人依据。',
  '每条生活建议必须完整填写 category、goal、rationale、steps、startingOptions、scheduleSuggestion、trackingSuggestion、constraints、uncertainties、sourceKind、relatedSystemIds；不得只给一段长文。',
  'AI 提出的具体 exercise/diet/sleep 等做法必须通过去标识化网页搜索获得至少一条 generalKnowledgeEvidence，包含实际核对过的 HTTPS 来源、机构、复核日期和它支持的范围。没有可靠一般依据时，只能 sourceKind=care_preparation，退化为记录或就医准备，不得编造生活做法。',
  'constraints 必须考虑 FACT_PACKAGE 的 userReportedNotes，儿童、孕期、术后、运动限制、用药和过敏等背景不明确时降低个体化程度并写入 uncertainties；不得直接套成人模板。',
  'claim.id / guidance.id 用稳定短键，例如 claim-ldl-fact、guide-walk。',
  'association 与 action 必须填写 boundaryNote；fact 与 trend 一般不需要。',
  'consultProfessional：涉及运动强度、饮食结构调整或需要医生确认时为 true；资料很少时也应为 true。'
];

const DERIVED_EXAMPLES: string[] = [
  'fact：title=血脂里的坏胆固醇偏高；explanation=低密度脂蛋白（俗称坏胆固醇）4.2 mmol/L，高于这份报告的参考上限 3.4。',
  'trend：只有同一项目至少两个可比日期才写，例如“近三年 LDL-C 3.6 → 3.9 → 4.2，逐年上升”。',
  'association：boundaryNote=仅供参考，不等于诊断。',
  'action：止步于“建议带着这份血脂报告咨询医生或下次体检复查”，不得写需要用药。',
  '生活指南：goal 写希望建立的习惯，steps 写具体行动，startingOptions 给较轻起点，trackingSuggestion 只要求低负担记录；不要写补充剂名称或剂量。'
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
          '对生活建议，supported 同时表示个人适用依据能被 FACT_PACKAGE 支撑，并且 generalKnowledgeEvidence 的网页来源真实存在、机构/标题/适用范围与建议一致；必须用去标识化搜索独立核对，不能只相信候选 URL。',
          'safe 表示未越过医疗边界，且没有忽略用户自述中的过敏、用药、身体限制、年龄或特殊背景。两者都成立才算通过。',
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

export function buildSystemAnalysisPrompt(evidenceBundle: string): string {
  return renderPrompt({
    sections: [
      {
        title: '角色',
        lines: ['你是家庭健康档案的身体系统整理器。只综合 SYSTEM_EVIDENCE_BUNDLE 中的本系统事实、明确选入的关联背景、用户自述、事件与程序计算的趋势。']
      },
      {
        title: '任务',
        lines: [
          '输出 schemaVersion=2的结构化系统分析；personId、systemId、inputSignature 必须与输入完全一致。',
          'headline 是这个系统的综合摘要，不得简单复制第一条事实。资料不足时可以很短，不要填充套话。',
          'keyPoints 优先说清事实、可比趋势、有边界的关联解释和待讨论问题。contextFacts 只能当背景，不得冒充本系统直接事实。',
          'evidenceIds 只能使用 directFacts/contextFacts 中 evidence.id 或 personalContext.id；trendFactIds 只能使用 trends.id。',
          '趋势只能复述 trends.trendFacts，不得重新计算百分比、方向或边界值。',
          'conflicts 列出互相矛盾的个人资料；dataGaps 只说缺什么及它限制了什么解释，不自动生成检查建议。',
          'discussionPoints 是可以带着资料与医生讨论的问题；不是诊断、治疗或处方。'
        ]
      },
      { title: '叙事分级', lines: NARRATIVE_LEVEL_GUIDE },
      { title: '表达', lines: FAMILY_TONE_RULES },
      { title: '医疗边界', lines: MEDICAL_BOUNDARY_RULES },
      {
        title: '搜索边界',
        lines: ['本任务不使用网页搜索；一般医学知识必须来自 bundle.knowledge 中已审查条目，没有时不得编造。']
      }
    ],
    data: [{ name: 'SYSTEM_EVIDENCE_BUNDLE', json: evidenceBundle }]
  });
}

export function buildReviewSystemAnalysisPrompt(input: { evidenceBundle: string; candidate: string }): string {
  return renderPrompt({
    sections: [
      {
        title: '角色',
        lines: ['你是独立的身体系统分析复核器。不得因为候选内容已经存在就默认它正确。']
      },
      {
        title: '任务',
        lines: [
          'personId、systemId、inputSignature 必须与 bundle 和 candidate 一致。',
          '逐项检查 keyPoints（itemId=其 id）、conflicts（itemId=conflict:索引）和 discussionPoints（itemId=discussion:索引），不得遗漏或新增。',
          'supported 表示引用真实存在且支持文本；safe 表示未下诊断、处方、剂量或无证据因果；trendConsistent 表示与程序给定的 TrendFacts 一致。',
          'overallSupported 只在所有必须项同时 supported、safe、trendConsistent 时为 true。',
          '本任务不使用网页搜索。'
        ]
      },
      { title: '叙事分级', lines: NARRATIVE_LEVEL_GUIDE },
      { title: '医疗边界', lines: MEDICAL_BOUNDARY_RULES }
    ],
    data: [
      { name: 'SYSTEM_EVIDENCE_BUNDLE', json: input.evidenceBundle },
      { name: 'SYSTEM_ANALYSIS_CANDIDATE', json: input.candidate }
    ]
  });
}
