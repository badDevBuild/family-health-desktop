/**
 * 提示词公共构件。
 *
 * 所有发送给 Codex 的任务提示词都由这里的分节渲染器拼装：
 * - 说明性内容按「## 标题 + 要点」组织，模型更容易区分角色、任务、硬规则与字段说明；
 * - 数据块（SOURCE_PACKAGE / FACT_PACKAGE 等）统一放在最后，并保持 `NAME=<JSON>` 的
 *   单行格式，便于测试断言与日志脱敏时按前缀截断。
 *
 * 提示词版本号只在语义变化时递增；派生快照与任务签名都会记录它，
 * 因此递增后旧结果会被视为过期而不是幂等复用。
 */

/** 事实提取/复核提示词版本，进入任务 inputSignature。 */
export const EXTRACTION_PROMPT_VERSION = 'extract-v4';

/** 派生分析/安全复核提示词版本，写入 derived_snapshots.prompt_version。 */
export const DERIVED_PROMPT_VERSION = 'derived-v4';

/** 本地事实接纳规则版本，与 health-core 的 evaluateObservationCandidate 对齐。 */
export const ACCEPTANCE_RULES_VERSION = 'health-acceptance-v3';

/** 派生安全规则版本，与 derived-pipeline 本地拦截对齐。 */
export const DERIVED_SAFETY_RULES_VERSION = 'derived-safety-v2';

/** 成员档案 v2 的系统级综合与独立复核版本。 */
export const SYSTEM_ANALYSIS_PROMPT_VERSION = 'system-analysis-v2';
export const SYSTEM_ANALYSIS_RULES_VERSION = 'system-analysis-safety-v2';
export const MEMBER_ASSESSMENT_PROMPT_VERSION = 'member-assessment-v3';
export const MEMBER_ASSESSMENT_RULES_VERSION = 'lean-health-v3.2';
export const HEALTH_PIPELINE_VERSION = 'lean-health-v3';
export const RUNTIME_PROMPT_VERSION = 'health-runtime-v3';

export interface PromptSection {
  title: string;
  /** 每一项渲染为一行；以 "  - " 开头的项会保留为二级要点。 */
  lines: string[];
}

export interface PromptDataBlock {
  name: string;
  /** 已序列化的 JSON 字符串；调用方负责 JSON.stringify，避免这里重复序列化大对象。 */
  json: string;
}

export function promptMetaForStage(stage: 'extract' | 'analyze'): {
  promptVersion: string;
  rulesVersion: string;
} {
  return stage === 'analyze'
    ? { promptVersion: MEMBER_ASSESSMENT_PROMPT_VERSION, rulesVersion: MEMBER_ASSESSMENT_RULES_VERSION }
    : { promptVersion: EXTRACTION_PROMPT_VERSION, rulesVersion: ACCEPTANCE_RULES_VERSION };
}

function renderSection(section: PromptSection): string {
  const body = section.lines
    .map((line) => (line.startsWith('  - ') ? line : `- ${line}`))
    .join('\n');
  return `## ${section.title}\n${body}`;
}

/**
 * 把说明分节与数据块拼成最终提示词。
 * 数据块永远在说明之后，且每个数据块独占一行，避免超长 JSON 干扰说明的可读性。
 */
export function renderPrompt(input: { sections: PromptSection[]; data: PromptDataBlock[] }): string {
  const sections = input.sections.map(renderSection).join('\n\n');
  const data = input.data.map((block) => `${block.name}=${block.json}`).join('\n');
  return data.length > 0 ? `${sections}\n\n## 输入\n${data}` : sections;
}

/**
 * 报告异常标记的判定规则。
 * 提取、复核、覆盖补救与裁决四类提示词共用，保证同一份报告在多轮读取中口径一致。
 */
export const ABNORMAL_MARKER_RULES: string[] = [
  '必须结合表头判断符号含义：位于“趋势”列的 ▲、▼、━、↑、↓ 只表示与上次相比的变化，不是异常标记，reportedAbnormalFlag 必须为 null。',
  '只有报告在“提示/异常/标志”等语义明确的栏位或正文中明确写出偏高、偏低、阳性、阴性、H、L 等内容时，才能填写 reportedAbnormalFlag；不得把数值升降或超出参考范围等同于医学异常。',
  '规范写法只用：偏高、偏低、阳性、阴性、正常；报告用 H/L/↑/↓ 在“提示”列明确表示异常时按语义映射为偏高/偏低。',
  '若结合完整页面仍无法确定符号含义，为该候选添加 code=blocking_abnormal_marker_unclear 的 issue 并把 reportedAbnormalFlag 置为 null；不要猜测。'
];

/**
 * 八大器官系统的口径说明。派生分析按此归类，看板器官卡片直接消费 organId。
 */
export const ORGAN_SYSTEM_GUIDE: string[] = [
  'cardiovascular 心血管：血压、心率、血脂（总胆固醇/LDL-C/HDL-C/甘油三酯）、心电图、心脏/颈动脉超声。',
  'metabolic 代谢与内分泌：血糖、糖化血红蛋白、尿酸、甲状腺功能与超声、体重/BMI/腰围/体脂。',
  'hepatobiliary 肝胆：肝功能（ALT/AST/GGT/胆红素）、乙肝相关、肝胆脾胰超声、脂肪肝。',
  'renal 肾脏与泌尿：肌酐、尿素、eGFR、尿常规、泌尿系超声、前列腺。',
  'digestive 消化：胃肠镜、幽门螺杆菌、胃蛋白酶原、消化道病理、肿瘤标志物中与消化道相关的项目。',
  'hematology 血液：血常规、铁代谢、凝血、血型。',
  'respiratory 呼吸：胸片/胸部 CT、肺结节、肺功能、气道相关。',
  'sensory 眼与五官：视力、验光、眼压、眼底、眼轴、听力、口腔、鼻咽喉。',
  '同一指标可与多个系统相关时，放在最直接相关的一个系统下，必要时在另一系统的小结里提及，不要重复成条。'
];

/**
 * 四级叙事分级。与产品“LLM 叙事表达分级”一致，分析与安全复核共用同一口径。
 */
export const NARRATIVE_LEVEL_GUIDE: string[] = [
  'fact 事实层：复述报告事实。先用一句日常语言解释术语，再给数值与参考范围，例如“低密度脂蛋白（俗称坏胆固醇）4.2 mmol/L，高于报告参考上限 3.4”。',
  'trend 趋势层：只有同一项目有至少 2 个不同日期、单位一致、参考范围口径可比时才写，例如“近三年 LDL-C 3.6 → 3.9 → 4.2，逐年上升”。不同医院或不同参考范围的结果不直接比高低；带比较符（<、>）的值不伪造精确趋势；日期未知的值不进入趋势。',
  'association 关联层：跨指标/跨系统的关联提示，必须写明“仅供参考”，例如“结合血压偏高与体重偏重，心血管方面的整体情况值得关注（仅供参考）”。不得把关联写成因果或诊断。',
  'action 行动层：给出安全、具体、低负担的下一步，可以包括生活方式起点、记录方法、复查或就医准备，并说明为什么、先做什么、何时回看；不得下诊断、开药、调整药物或给剂量。'
];

/**
 * 面向家庭成员的表达约束。所有派生内容（分析、生活指南、修复）共用。
 */
export const FAMILY_TONE_RULES: string[] = [
  '读者是这位成员本人和家人，可能是 60 岁以上、不了解医学的老人：用平静、尊重、日常的语言，专业术语先用白话解释再给数值。',
  '只呈现最终结论，不叙述工作过程：不要写“经核对”“模型判断”“系统检测到”“两轮读取”之类的话。',
  '不用无证据的恐吓性措辞，也不用空洞安慰；若资料本身出现需要及时就医的明确线索，要用平静、直接、可行动的方式说清楚。',
  '说明中不得出现姓名、内部 ID、文件名或本机路径。'
];

/**
 * 网页搜索的隐私与用途边界。仅在 allowWebSearch=true 的阶段使用。
 */
export const WEB_SEARCH_RULES: string[] = [
  '只用于核对通用医学背景（例如某指标的含义、常见参考范围的口径），不用于查找任何个人。',
  '搜索词必须去标识化：不得包含姓名、完整日期、报告原文、内部 ID，或可唯一识别个人的组合信息（例如“某年某月某医院某项检查某数值”）。',
  '网页内容只能支持通用医学知识，不能替代或修改 FACT_PACKAGE 中的个人报告事实。只有确实打开并核对过的 HTTPS 来源才可写入 generalKnowledgeEvidence；不得编造 URL、标题、机构或适用范围。'
];

/**
 * 派生阶段绝对禁止事项。分析、修复、安全复核共用同一清单，本地规则会再次拦截。
 */
export const MEDICAL_BOUNDARY_RULES: string[] = [
  '不得诊断疾病，不得出现“你有/患有/确诊/诊断为 …”一类判断，不得给出风险分期或概率。',
  '不得建议开始、停止、调整任何药物、补充剂、中药或保健品，不得出现任何剂量（如 20 mg、1000 IU）。',
  '不得编造指南、研究、机构、数字、URL，或 FACT_PACKAGE 中不存在的事实。'
];
