import type { BodySystemId, SystemEvidenceBundle } from '@contracts';

export const SYSTEM_KNOWLEDGE_VERSION = 'controlled-knowledge-2026-09-21-v1';

type KnowledgeEntry = SystemEvidenceBundle['knowledge'][number] & {
  systemIds: BodySystemId[] | 'all';
};

/**
 * 系统分析只读取这份经过代码审查的通用知识。
 * 个人报告与通用知识分开：这些条目不包含姓名、医院、检查日期或个人数值。
 */
const KNOWLEDGE_CATALOG: KnowledgeEntry[] = [
  {
    id: 'knowledge-lab-results-context',
    version: SYSTEM_KNOWLEDGE_VERSION,
    title: '检验结果需要结合参考范围、方法和个人背景理解',
    content: '单次检验不能提供完整的健康图景。高于或低于报告参考范围不必然等于疾病，在范围内也不能保证整体健康。不同实验室的方法、参考范围和单位可能不同，历史比较应优先使用可比的结果。阳性、阴性或不确定结果应按该检查在寻找什么来理解，不能统一当作好或坏。',
    applicability: '适用于解释常规检验、定性结果和跨时间比较；不提供个体诊断或通用数值阈值。',
    sourceOrganization: 'MedlinePlus / U.S. National Library of Medicine',
    sourceUrl: 'https://medlineplus.gov/lab-tests/how-to-understand-your-lab-results/',
    reviewedAt: '2026-09-21',
    supportedScope: '支持参考范围、检验方法、单位、定性结果与整体背景的通用解释边界。',
    systemIds: 'all'
  },
  {
    id: 'knowledge-dyslipidemia-personalized-context',
    version: SYSTEM_KNOWLEDGE_VERSION,
    title: '血脂解读和管理需结合更广泛的个人风险背景',
    content: '血脂管理不只看一个 LDL-C 数值，还需结合非 HDL-C、甘油三酯、年龄、糖尿病、慢性肾病、既往心血管事件和家族史等背景。应先说明历次血脂结果的方向与可比性，再决定是否需要更进一步的个人化评估。',
    applicability: '用于成人血脂检查的通用解释。不在本应用内计算风险百分比、设定治疗目标或给出用药指令。',
    sourceOrganization: 'American Heart Association',
    sourceUrl: 'https://professional.heart.org/en/science-news/2026-guideline-on-the-management-of-dyslipidemia',
    reviewedAt: '2026-09-21',
    supportedScope: '支持将血脂结果放在个人化心血管风险背景中解读，不支持应用自行下诊断或处方。',
    systemIds: ['cardiovascular', 'endocrine_metabolic']
  },
  {
    id: 'knowledge-physical-activity-tailoring',
    version: SYSTEM_KNOWLEDGE_VERSION,
    title: '身体活动建议必须按年龄、慢性病和身体限制调整',
    content: '身体活动建议对儿童、成人、老年人、孕期及产后人群，以及有慢性病或残障的人并不相同。不满足通用建议时，从能安全完成的少量活动开始仍然可能有益；存在运动限制、术后状态或症状时需降低个体化程度并先确认安全边界。',
    applicability: '只用于生成渐进、可调整的活动起点；若缺少年龄、症状或身体限制背景，不给出个体化强度处方。',
    sourceOrganization: 'World Health Organization',
    sourceUrl: 'https://www.who.int/publications-detail-redirect/9789240015128',
    reviewedAt: '2026-09-21',
    supportedScope: '支持活动建议按人群和身体限制分层，以及采用渐进起点。',
    systemIds: 'all'
  }
];

export function knowledgeForSystem(systemId: BodySystemId): SystemEvidenceBundle['knowledge'] {
  return KNOWLEDGE_CATALOG
    .filter((entry) => entry.systemIds === 'all' || entry.systemIds.includes(systemId))
    .map(({ systemIds: _systemIds, ...entry }) => entry);
}
