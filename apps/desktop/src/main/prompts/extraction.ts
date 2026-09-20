import type { ExtractionResult, ReviewCandidateDiff } from '@contracts';
import { ABNORMAL_MARKER_RULES, renderPrompt, type PromptSection } from './shared.js';

const EXTRACTION_HARD_RULES: string[] = [
  '只提取 SOURCE_PACKAGE 中明确出现的事实；看不清、截断或对不上时用 unknown，不得编造值、单位、日期或成员身份。',
  '不诊断、不推测未写出的结论、不提供处方或用药建议。',
  '每个候选的 evidence 只能引用本块 sourceSpanId；quote 必须是该 span.quote 的连续子串，并尽量同时包含项目名与结果。',
  'imageInputs 的 imageIndex 与随请求附带的图片顺序一一对应；图片来自原报告、PDF 对应页渲染或 DOCX 嵌入图，不是额外来源。',
  'coveredSourceSpanIds 必须逐一列出本块全部来源片段，即使某片段没有可提取指标也不能省略。'
];

const EXTRACTION_FIELD_GUIDE: string[] = [
  'schemaVersion 固定为 1；documentId 必须与 SOURCE_PACKAGE.documentId 完全一致。',
  'subject：报告明示姓名时 confidence=explicit，reportedName 逐字摘录并给出 evidence；找不到姓名时 reportedName=null、confidence=absent、evidence=[]；看见疑似姓名但无法确认时 confidence=uncertain。不得根据目标成员显示名反推。',
  'localKey：本块内稳定可读的短键，例如 ldl-c、收缩压；不要用随机 UUID。同一指标在本块只出现一次。',
  'originalName 用报告原文；standardNameCandidate 填通用中文或常见缩写（如 LDL-C），不确定则 null。',
  'value.kind：数字用 numeric（decimal 不含千分位和单位，comparator 默认 eq，原文有 < > 时用 lt/gt）；阴阳性/等级用 qualitative；叙述结论用 text；看不清用 unknown 并填写 reason。',
  'unitRaw、referenceRangeRaw、specimen、method、bodySite：原文没有则 null，不要补全。',
  'clinicalDate 只填 YYYY-MM-DD 真实日历日。年度对比表若只在表头写日期，把当前结果列对应的日期填到该行；跨页“××小结”可把上一页同科室标题附近的日期作为额外 evidence。对不上则 null。',
  '血压写成 120/80 时可作为一个候选 originalName=血压；不要输出互相矛盾的收缩压/舒张压。',
  'issues 只在无法确定时添加。符号含义不清时 code=blocking_abnormal_marker_unclear。'
];

const EXTRACTION_EXAMPLES: string[] = [
  '趋势列：表头为“2023-10-08 2024-10-22 趋势”，数据行“体重 91 94 ▲”。体重候选 clinicalDate 用 2024-10-22，reportedAbnormalFlag=null，因为 ▲ 位于趋势列。',
  '提示列：LDL-C 4.20 mmol/L，参考 0-3.37，提示列写 H 或偏高。reportedAbnormalFlag=偏高。',
  'subject：页眉写“姓名：张三”，subject.reportedName=张三，confidence=explicit，evidence.quote 含“姓名：张三”。'
];

function extractionSections(input: {
  role: string;
  task: string[];
  extraRules?: string[];
}): PromptSection[] {
  return [
    { title: '角色', lines: [input.role] },
    { title: '任务', lines: input.task },
    { title: '硬规则', lines: [...EXTRACTION_HARD_RULES, ...(input.extraRules ?? [])] },
    { title: '异常标记', lines: ABNORMAL_MARKER_RULES },
    { title: '字段说明', lines: EXTRACTION_FIELD_GUIDE },
    { title: '示例', lines: EXTRACTION_EXAMPLES }
  ];
}

export function buildExtractPrompt(input: {
  personDisplayName: string;
  sourcePackage: string;
}): string {
  return renderPrompt({
    sections: extractionSections({
      role: '你是健康报告事实提取器。只提取来源中明确出现的事实，不诊断、不推测、不提供处方。',
      task: [
        `目标成员显示名为“${input.personDisplayName}”，只用于核对，不得据此填写 subject。`,
        '通读本块 SOURCE_PACKAGE 与附带图片，返回完整候选集合和覆盖清单。'
      ]
    }),
    data: [{ name: 'SOURCE_PACKAGE', json: input.sourcePackage }]
  });
}

export function buildReviewFactsPrompt(input: {
  sourcePackage: string;
  candidateToReview: string;
}): string {
  return renderPrompt({
    sections: extractionSections({
      role: '你是独立事实复核器。重新阅读本块原始来源，并返回你核实后的完整候选集合。',
      task: [
        '只保留来源明确支持且引用本块有效 sourceSpanId 的事实；不得因为前一份候选存在就默认接受。',
        'CANDIDATE_TO_REVIEW 仅供对照，不是正确答案。'
      ]
    }),
    data: [
      { name: 'SOURCE_PACKAGE', json: input.sourcePackage },
      { name: 'CANDIDATE_TO_REVIEW', json: input.candidateToReview }
    ]
  });
}

export function buildRecoverCoveragePrompt(input: {
  stage: 'extract' | 'review_facts';
  sourcePackage: string;
  expectedSpanIds: string[];
  missingSpanIds: string[];
  previousResult: ExtractionResult;
  candidateToReview?: ExtractionResult;
}): string {
  const isReview = input.stage === 'review_facts';
  return renderPrompt({
    sections: extractionSections({
      role: isReview
        ? '你是独立事实复核器。请重新通读这份完整来源包，独立返回核实后的完整候选集合。'
        : '你是健康报告事实提取器。请重新通读这份完整来源包，只提取来源明确支持的事实。',
      task: [
        '上一次返回的 coveredSourceSpanIds 不完整。这是覆盖清单补救，不是只检查缺失片段；必须重新结合整篇上下文处理。',
        'coveredSourceSpanIds 必须逐一包含 REQUIRED_SOURCE_SPAN_IDS 中的每一个 ID，即使某片段没有可提取指标也不能省略。'
      ]
    }),
    data: [
      { name: 'REQUIRED_SOURCE_SPAN_IDS', json: JSON.stringify(input.expectedSpanIds) },
      { name: 'PREVIOUSLY_MISSING_SOURCE_SPAN_IDS', json: JSON.stringify(input.missingSpanIds) },
      { name: 'PREVIOUS_RESULT', json: JSON.stringify(input.previousResult) },
      ...(input.candidateToReview
        ? [{ name: 'CANDIDATE_TO_REVIEW', json: JSON.stringify(input.candidateToReview) }]
        : []),
      { name: 'SOURCE_PACKAGE', json: input.sourcePackage }
    ]
  });
}

export function buildAdjudicateAbnormalFlagsPrompt(input: {
  sourcePackage: string;
  expectedSpanIds: string[];
  differences: ReviewCandidateDiff[];
  first: ExtractionResult;
  second: ExtractionResult;
}): string {
  return renderPrompt({
    sections: extractionSections({
      role: '你是健康报告事实分歧裁决器。两次完整读取只在“报告异常标记”上不一致，请直接查看原始来源和表头后独立裁决。',
      task: [
        '必须返回完整候选集合，但只裁决 TARGET_DIFFS 指定候选的 reportedAbnormalFlag，其他事实不得改动。',
        '若符号只表示趋势，将 reportedAbnormalFlag 设为 null；若原文明确表示异常，规范填写偏高、偏低、阳性、阴性或正常。',
        '若结合完整页面仍无法确定，为对应候选添加 code=blocking_abnormal_marker_unclear 的 issue；不要猜测。',
        'coveredSourceSpanIds 必须逐一包含 REQUIRED_SOURCE_SPAN_IDS 中的每一个 ID。'
      ]
    }),
    data: [
      { name: 'REQUIRED_SOURCE_SPAN_IDS', json: JSON.stringify(input.expectedSpanIds) },
      { name: 'TARGET_DIFFS', json: JSON.stringify(input.differences) },
      { name: 'FIRST_EXTRACTION', json: JSON.stringify(input.first) },
      { name: 'INDEPENDENT_REVIEW', json: JSON.stringify(input.second) },
      { name: 'SOURCE_PACKAGE', json: input.sourcePackage }
    ]
  });
}

export function buildAdjudicateFactDifferencesPrompt(input: {
  sourcePackage: string;
  differences: ReviewCandidateDiff[];
}): string {
  return renderPrompt({
    sections: extractionSections({
      role: '你是健康报告事实分歧裁决器。两次完整读取已经完成，请直接查看原始来源，一次性裁决全部核心差异。',
      task: [
        'TARGET_DIFFS 中每项都有从 0 开始的 differenceIndex，以及 firstCandidate / secondCandidate 两个既有选项。',
        '每个 differenceIndex 必须恰好返回一个决定：first 表示采用 firstCandidate，second 表示采用 secondCandidate；只有一侧候选确实不属于报告事实时才可选 omit。',
        '不得创建第三个数值、日期、单位或结论。若原图和文字仍不足以判断，选择 unresolved，不要猜测。',
        '方法名称、科室简称、标准名称或“正常”标记的写法差异不应改变报告事实；数值、单位、日期、阳性/异常结论和左右侧差异必须根据原始来源裁决。',
        '返回 FACT_DIFF_ADJUDICATION，覆盖 TARGET_DIFFS 的每个 differenceIndex，不得遗漏或新增。'
      ]
    }),
    data: [
      {
        name: 'TARGET_DIFFS',
        json: JSON.stringify(input.differences.map((difference, differenceIndex) => ({ differenceIndex, ...difference })))
      },
      { name: 'SOURCE_PACKAGE', json: input.sourcePackage }
    ]
  });
}

export function buildRepairFactValidationPrompt(input: {
  sourcePackage: string;
  validationErrors: Array<{ localKey: string; itemName: string; reasons: string[] }>;
  candidate: ExtractionResult;
}): string {
  return renderPrompt({
    sections: extractionSections({
      role: '你是健康报告事实证据修复器。两次读取和分歧裁决已经完成；请根据原始来源一次性修复全部本地证据校验错误。',
      task: [
        '只允许修改 VALIDATION_ERRORS 指定候选的证据摘录、来源引用、日期、单位或结果绑定；其他候选必须原样保留。',
        '不得为了通过校验而编造来源。原始来源不支持的候选应保留并添加 blocking_source_unclear，不得擅自改成另一个医学事实。',
        '返回完整的 EXTRACTION_CANDIDATE，coveredSourceSpanIds 必须继续完整覆盖本块。'
      ]
    }),
    data: [
      { name: 'VALIDATION_ERRORS', json: JSON.stringify(input.validationErrors) },
      { name: 'EXTRACTION_CANDIDATE', json: JSON.stringify(input.candidate) },
      { name: 'SOURCE_PACKAGE', json: input.sourcePackage }
    ]
  });
}
