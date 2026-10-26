import type {
  BodySystemId, HealthAction, HealthClaim, MemberAssessmentCandidateV3, MemberEvidenceRef,
  OverviewNode, QuestionNode, SystemNode
} from '@contracts';
import { inspectDocumentedPlanEvidence } from '@contracts';
import { findProcessNarrativeIssues } from './assessment-content-quality.js';
import { findInvalidAssessmentComparisons } from './assessment-comparisons.js';
import { findAssessmentSemanticIssues, findMissingExamScopeIssues } from './assessment-semantic-quality.js';

export const ASSESSMENT_VALIDATION_RULES_VERSION = 'assessment-validation-v43';

export interface AssessmentValidationInput {
  personId: string;
  inputSignature: string;
  mode: MemberAssessmentCandidateV3['mode'];
  requestedSystemIds: BodySystemId[];
  evidenceCatalog: MemberEvidenceRef[];
  trendIds: string[];
  catalogKnowledgeIds: string[];
  criteriaSets: Array<{
    id: string;
    sourceId: string;
    applicability: string;
    requiredCriterionIds: string[];
    verifiedRequirements: Array<{ criterionId: string; evidenceIds: string[] }>;
  }>;
}

export interface AssessmentValidationResult {
  issues: string[];
  focusedReviewReasons: string[];
}

// 仅识别面向本人直接执行的药物改变；来源事实中的剂量、检验单位及治疗讨论不据字面拒绝。
const medicationChange = '(?:停药|停用|换药|加量|减量|开始服用|改用|调整剂量)';
const medicationInstructionCue = '(?:马上|立即|现在|请|应(?:当|该)?|必须|建议你)';
const directMedicationInstructionLead = new RegExp(`${medicationInstructionCue}[^。；;，,！？!?\\n]{0,24}$`, 'i');
const directMedicationInstructionTail = /^[^。；;，,！？!?\n]{0,12}(?:即可|就行)/i;
const selfDirectedMedicationLead = /自行[^。；;，,！？!?\n]{0,12}$/i;
const negatedMedicationLead = /(不要|不得|切勿|勿|避免|禁止|不应|无需|不必|停止|(?:暂时|暂|先|尚|仍)不)([^。；;，,！？!?\n]{0,14})$|(不表示|不代表|不意味着|不说明|不能理解为|不能视为|不应理解为|不应视为)([^。；;，,！？!?\n]{0,24})$/giu;
const medicationHistoryLead = /(?:是否|有无|曾经|过去|之前|历史上)[^。；;，,！？!?\n]{0,20}$/iu;
const medicationScopeBoundary = new RegExp(`(?:但是|但|然而|不过|而是|却|随后|然后)|(?:并且|同时|、|或|和|及|并)(?=${medicationInstructionCue})`, 'u');
const coordinatedSelfDirectedMedicationLead = /^(?:\s|、|或|和|及|并|以及|并且|同时)+自行[^。；;，,！？!?\n]{0,12}$/u;
const medicationNegationPrefix = /(?:并非|并不是|不是|不能|不得|不必|不应|未必|没有|不)\s*$/u;
// “未核实”“无症状”等背景不是否定指令；只把明确否定语气再作用于指令的情况交回复核。
const nestedMedicationNegation = /(?:不(?:应|该|要|必|得|能|需|须|可|是|遵|按|再|自行|擅自|立即|马上|现在|建议)|未必|无需|无须|勿|禁止|避免)/u;
const unsourcedProbability = /(?:患病|发病|罹患|诊断|得[^。；，]{0,8}病|患[^。；，]{0,12}风险|癌症风险)[^。；，]{0,24}\d+(?:\.\d+)?\s*%/i;
const explicitDiagnosis = /(?:明确诊断|临床诊断|病理诊断|出院诊断|(?:既往|曾|历史)诊断|诊断[:：]|确诊|诊断意见[:：])/i;
const negatedOrTentative = /(?:排除|待排|待查|考虑|疑似|可能|家族史|病史自述|未确诊|不能诊断|尚不能诊断)/i;
const historicalDiagnosis = /(?:既往|既往史|既往诊断|曾诊断|病史)/i;
const otherPersonSubject = /(?:家族史|父亲|母亲|祖父|祖母|外祖父|外祖母|兄弟|姐妹|子女|配偶|亲属)/i;
const selfSubject = /(?:本人|患者|受检者|自己)/i;
// 不用固定汉字窗口截断病名前文；起点在后续按完整语气词和连接词确定。
const highConsequenceDisease = /(?:恶性肿瘤|恶性淋巴瘤|癌症|癌变|心肌梗死|急性冠脉综合征|主动脉夹层|肺栓塞|脑卒中|脑梗死|脑出血|败血症|脓毒症|急性肾衰|急性肾损伤|肝衰竭|器官衰竭)/giu;
const genericCancerMention = /[\p{Script=Han}]*?癌(?:栓)?/gu;
const assertionScopeBoundary = /(?:但是|但|然而|不过|而是|却)/gu;
// 模态否定可通过方式修饰或依据介词短语约束谓词，不按报告背景词或固定字数猜测作用域。
// 任意未知动词不作为方式修饰；依据短语遇新分支、主体或独立断言即停止，不能吞掉随后确诊。
const modalNegation = '(?:尚?不能|还不能|未能|无法|不(?:应|宜|可|该)?|未)';
const modalManner = '(?:仅|只|单独|独立|直接|立即|据此|就此|明确)(?:地)?';
const modalEvidenceBoundary = `(?:${assertionScopeBoundary.source}|并且|而且|且|并|也|`
  + `${otherPersonSubject.source}|${selfSubject.source}|`
  + '(?:已经|已|曾经|曾)(?=明确|诊断|确诊)|'
  + '发现|检出|诊断|确诊|排除|提示|考虑|怀疑|患有|罹患)';
// 依据宾语必须以通用资料名词闭合；闭合后只允许方式修饰和目标谓词。
// 不以“介词后都是依据”吞掉未知动作，如“不能依据要求隐瞒确诊…”。
const modalEvidenceObject = `(?:(?!${modalEvidenceBoundary})[^。；;，,！？!?\\n])*(?:结果|资料|记录|证据|报告)`;
const modalBridge = `\\s*(?:${modalManner}\\s*)*(?:(?:凭借|凭|依据|根据|通过|基于|用|以|靠)${modalEvidenceObject}\\s*(?:来\\s*)?(?:${modalManner}\\s*)*)?`;
// “不能排除”只增加待复核方向，不授予确诊或阴性豁免；未知依据/方式也保守保留，
// 不能反过来因为宾语不在闭合资料结构内，就把原有疑似提示静默丢掉。
const exclusionBridge = `(?:(?!${modalEvidenceBoundary})[^。；;，,！？!?\\n])*`;
const cannotExcludeAssertion = `(?:${modalNegation}${exclusionBridge}排除)`;
const cannotDiagnoseAssertion = `(?:${modalNegation}${modalBridge}(?:诊断(?:为)?|确诊(?:为)?))`;
const sourceReportingVerb = '(?:记载|记录|载明|注明|写明)';
const absentSourceAssertion = `(?:尚未|还未|未曾|未能|没有|并未|未)(?:明确)?(?:提供|给出|${sourceReportingVerb})`;
const negativeHighConsequenceAssertion = `(?:${cannotDiagnoseAssertion}|${absentSourceAssertion}|(?:尚未|还未|未曾|未能|没有|并未|未|尚不能|不能|无法|不)(?:明确)?(?:发现|检出|确诊|诊断(?:为)?|${sourceReportingVerb})|并非|并不是|不是|未见|(?:已经|已|明确)排除|不支持)`;
const highConsequenceAssertion = new RegExp(`${cannotExcludeAssertion}|${negativeHighConsequenceAssertion}|待排|高度怀疑|怀疑|疑似|可能|考虑|提示|(?:明确)?(?:确诊|诊断(?:为)?)|患有|罹患|发现|检出`, 'iu');
const uncertainHighConsequenceAssertion = new RegExp(`^(?:${cannotExcludeAssertion}|待排|高度怀疑|怀疑|疑似|可能|考虑|提示)$`, 'iu');
const negativeHighConsequenceCue = new RegExp(`^(?:${negativeHighConsequenceAssertion})$`, 'iu');
const directlyNegatedDisease = /(?:已排除|明确排除|未见|无|不支持|未确诊|不能确诊|尚不能确诊)\s*$/i;
const diseaseSuffixTense = '(?:(?:现(?:在)?|目前|当前)(?:已经|已)?|已经|已)?';
const directlyNegatedDiseaseAfter = new RegExp(`^(?:的)?(?:可能(?:性)?)?${diseaseSuffixTense}(?:已排除|明确排除|未见|不支持|未确诊|尚未确诊|不能确诊|尚不能确诊)`, 'i');
const diseaseNameBoundary = /(?:但是|但|然而|不过|而是|却|以及|还有|并且|且|并|和|或|及|与)/gu;
const isCancerMention = (mention: string): boolean => /癌(?:栓)?$/u.test(mention);
// 只切掉可明确分解的句法框架，不按病名后缀、字数或医学同义关系删字。
const diseaseNameGrammarLead = new RegExp(`^(?:(?:(?:已经|已|曾经|曾|当时|明确|清楚|清晰)(?:地)?)*${sourceReportingVerb}(?:了)?`
  + `|(?:其|该)?(?:${otherPersonSubject.source}|${selfSubject.source})`
  + '|(?:是|为|患有|患|存在|发生|出现|包括|曾经|既往|当前|目前|本次|这次|被|的|和|以及|或|及|与|还有))+', 'u');

/** 通用“X癌”匹配可能包含语气前缀；只移除语法词，不推断同义病名或医学包含关系。 */
function assertedDiseaseName(mention: string): string {
  if (!isCancerMention(mention)) return mention;
  let leadEnd = 0;
  for (const assertion of mention.matchAll(new RegExp(highConsequenceAssertion.source, 'giu'))) {
    leadEnd = assertion.index + assertion[0].length;
  }
  // 连接词属于句法，不应连同前一个对象变成新病名；保留“原位/非小细胞”等病名修饰。
  for (const boundary of mention.matchAll(diseaseNameBoundary)) leadEnd = Math.max(leadEnd, boundary.index + boundary[0].length);
  // 移走主体语法词后，真实原位置仍由 start 保留；后续主体归属检查可看到“父亲/本人”。
  return mention.slice(leadEnd).replace(diseaseNameGrammarLead, '');
}

type HighConsequenceAssertionMention = { diseaseName: string; definite: boolean };
const coordinatedDiseaseLead = /^(?:\s|、|和|以及|或|及|与|还有)+$/u;
const assertionAfterDisease = new RegExp(`^\\s*(?:的)?(?:(?:仍|尚|还)(?:有)?|有)?${diseaseSuffixTense}(${highConsequenceAssertion.source})`, 'iu');
const absentSourceCue = new RegExp(`^(?:${absentSourceAssertion})$`, 'u');
const sourceObjectGrammar = /^(?:\s|了|任何|相关的?|关于|有关|针对|其|本人的?|患者的?|受检者的?|明确的|正式的|完整的|的|本次|此次)*$/u;
// “未提供 X 的诊断”中的“诊断”是缺失资料的宾语名词，不是后置确诊谓词。
// 只接受完整名词及纯并列连接；“X 现已确诊/诊断为…”仍按独立肯定谓词处理。
const diagnosticRecordNoun = '(?:的)?诊断(?:记录|资料|依据|证明|结论|意见|信息|病史)?';
const nominalDiagnosisSuffix = new RegExp(`^\\s*${diagnosticRecordNoun}\\s*$`, 'u');
const nextObjectBoundary = `(?:${assertionScopeBoundary.source}|并且|并|且|也|、|和|以及|或|及|与|还有)`;
const diagnosticRecordBeforeNextObject = new RegExp(`^\\s*${diagnosticRecordNoun}\\s*(?=${nextObjectBoundary})`, 'u');
const coordinatedDiagnosticRecordLead = new RegExp(`^(?:\\s*${diagnosticRecordNoun})?${coordinatedDiseaseLead.source.slice(1)}`, 'u');
const absentSourceAfterDiagnosticNoun = new RegExp(`^\\s*${diagnosticRecordNoun}\\s*${absentSourceAssertion}\\s*$`, 'u');
const absentRecordBeforeNextObject = new RegExp(`^\\s*${diagnosticRecordNoun}\\s*${absentSourceAssertion}\\s*(?=${nextObjectBoundary})`, 'u');

/** 只在当前分句内绑定最近谓词；前一对象的否定不能越过转折绑定到后一对象。 */
function latestPrefixAssertion(before: string): { cue: string; lead: string; objectLead: string } | null {
  const boundary = [...before.matchAll(assertionScopeBoundary)].at(-1);
  const scopedLead = before.slice(boundary ? boundary.index + boundary[0].length : 0);
  const assertion = [...scopedLead.matchAll(new RegExp(highConsequenceAssertion.source, 'giu'))].at(-1);
  return assertion ? { cue: assertion[0], lead: scopedLead.slice(0, assertion.index),
    objectLead: scopedLead.slice(assertion.index + assertion[0].length) } : null;
}

function hasOuterAssertionNegation(lead: string): boolean {
  // 否定元断言可以隔着“完全/简单/目前”等修饰语作用于整个缺资料谓词。
  // 不枚举这些修饰词；同一分句仍有外层否定或争议算子时，保守保留高影响复核。
  const scopedLead = (lead.split(new RegExp(`${assertionScopeBoundary.source}|并且|而且|且|同时`, 'u')).at(-1) ?? '')
    .replace(new RegExp(cannotExcludeAssertion, 'gu'), '');
  return /(?:并非|并不是|不是|不(?:能|可|应|宜|只|仅|止)|无法|难以)/u.test(scopedLead)
    || /非\s*$/u.test(scopedLead);
}

/** “并非未发现”不是明确阴性；不能借双重否定绕过高影响复核。 */
function isNegativeAssertion(cue: string, lead: string): boolean {
  return negativeHighConsequenceCue.test(cue) && !hasOuterAssertionNegation(lead);
}

/** 当前病名前最近的明确主体决定归属，先前“本人”不能豁免随后出现的“父亲”。 */
function hasOtherPersonSubject(lead: string): boolean {
  const subjects = [...lead.matchAll(new RegExp(`(?:${otherPersonSubject.source}|${selfSubject.source})`, 'gi'))];
  const nearest = subjects.at(-1);
  return nearest !== undefined && otherPersonSubject.test(nearest[0]);
}

/** 只提取针对本人的肯定或疑似方向，不把家族史、明确排除或单纯病名提及当作断言。 */
export function highConsequenceAssertionMentions(text: string): HighConsequenceAssertionMention[] {
  const assertions: HighConsequenceAssertionMention[] = [];
  for (const clause of text.split(/[。；;，,！？!?\n]/)) {
    const specificMentions = [...clause.matchAll(highConsequenceDisease)].map((match) => ({
      diseaseName: match[0], start: match.index, end: match.index + match[0].length
    }));
    const cancerMentions = [...clause.matchAll(genericCancerMention)].map((match) => {
      const diseaseName = assertedDiseaseName(match[0]);
      const end = match.index + match[0].length;
      return { diseaseName, start: end - diseaseName.length, end };
    }).filter((mention) => mention.diseaseName.length > 0
      && !specificMentions.some((specific) => mention.start < specific.end && mention.end > specific.start));
    // 普通癌词前文不能吞掉同句中另一个完整病名；特定名词与通用名词分别定位后合并。
    const mentions = [...specificMentions, ...cancerMentions].sort((left, right) => left.start - right.start);
    let previousCue: string | null = null;
    let previousAbsentSource = false;
    for (const [index, mention] of mentions.entries()) {
      const { diseaseName, start, end } = mention;
      const before = clause.slice(mentions[index - 1]?.end ?? 0, start);
      const after = clause.slice(end, mentions[index + 1]?.start ?? clause.length);
      const subjectLead = clause.slice(0, start);
      if (hasOtherPersonSubject(subjectLead)) { previousCue = null; previousAbsentSource = false; continue; }
      const inheritedAbsentSource: boolean = previousAbsentSource && coordinatedDiagnosticRecordLead.test(before);
      const prefixAssertion: ReturnType<typeof latestPrefixAssertion> = inheritedAbsentSource ? null : latestPrefixAssertion(before);
      const prefixCue: string | undefined = prefixAssertion?.cue;
      // 资料缺失只绑定紧随谓词的对象或它的纯并列对象，不跨越症状、转折或新谓词。
      const absentSourceObject: boolean = prefixAssertion
        ? (absentSourceCue.test(prefixAssertion.cue) || /^(?:并非|并不是|不是)$/u.test(prefixAssertion.cue))
          && isNegativeAssertion(prefixAssertion.cue, prefixAssertion.lead)
          && sourceObjectGrammar.test(prefixAssertion.objectLead)
        : inheritedAbsentSource;
      const nominalRecordObject: boolean = nominalDiagnosisSuffix.test(after)
        || mentions[index + 1] !== undefined && diagnosticRecordBeforeNextObject.test(after);
      const recordNotAvailable: boolean = (absentSourceAfterDiagnosticNoun.test(after)
        || mentions[index + 1] !== undefined && absentRecordBeforeNextObject.test(after))
        && !hasOuterAssertionNegation(subjectLead);
      const suffixCue: string | undefined = absentSourceObject && nominalRecordObject || recordNotAvailable
        ? undefined : assertionAfterDisease.exec(after)?.[1];
      // 裸“无/有”也可能是病名修饰，不能反复删字；“并非无…”的歧义也不能当明确阴性豁免。
      const ambiguousInnerNegative = /^(?:并非|并不是|不是)$/.test(prefixCue ?? '') && diseaseName.startsWith('无');
      const prefixNegative = !ambiguousInnerNegative && (prefixAssertion
        ? isNegativeAssertion(prefixAssertion.cue, prefixAssertion.lead) : directlyNegatedDisease.test(before));
      const activePrefixCue: string | undefined = prefixNegative ? undefined : prefixCue;
      const activeSuffixCue: string | undefined = suffixCue && !isNegativeAssertion(suffixCue, '') ? suffixCue : undefined;
      // 先恢复并列对象的既有肯定/疑似方向，再处理“诊断记录未提供”，不能让缺记录覆盖确诊。
      const inheritedCue: string | null = !activePrefixCue && !suffixCue && coordinatedDiseaseLead.test(before) ? previousCue : null;
      previousAbsentSource = absentSourceObject && !activeSuffixCue;
      // 后置“X 的诊断记录尚未提供”同样陈述资料缺失；不把它改判成“X 已确诊”。
      if (!activePrefixCue && !inheritedCue && recordNotAvailable) {
        previousCue = null; previousAbsentSource = true; continue;
      }
      // 同一病名的后置排除可限定前面的诊断框架；“未发现转移”这类另一个对象的谓词不匹配此边界。
      if (directlyNegatedDiseaseAfter.test(after.trimStart())) { previousCue = null; continue; }
      // 已有阴性之后出现明确的“现已确诊/仍考虑”不能被早先的否定吞掉。
      if (prefixNegative && !activeSuffixCue) { previousCue = null; continue; }
      if (absentSourceObject && !activePrefixCue && !activeSuffixCue) { previousCue = null; continue; }
      // 纯并列连接沿用共同语气；独立“已确诊”必须按本病名的最近断言处理。
      const cue: string | null = activePrefixCue ?? activeSuffixCue ?? inheritedCue;
      previousCue = cue ?? null;
      if (!cue) continue;
      const definite = [activePrefixCue, activeSuffixCue, inheritedCue].some((item) => item !== undefined && item !== null
        && !uncertainHighConsequenceAssertion.test(item));
      assertions.push({ diseaseName, definite });
    }
  }
  return assertions;
}

export function extractHighConsequenceAssertions(text: string): string[] {
  return [...new Set(highConsequenceAssertionMentions(text).map((assertion) => assertion.diseaseName))];
}

/** 本地门禁与重点复核共用断言识别，避免两处对否定和家族史采用不同语义。 */
export function hasHighConsequenceAssertion(text: string): boolean {
  return extractHighConsequenceAssertions(text).length > 0;
}

type AssessmentVisibleNode = HealthClaim | HealthAction | OverviewNode | SystemNode | QuestionNode;

/** 本地门禁和重点复核使用同一份展示字段清单，不依赖模型自行标注严重程度。 */
export function visibleAssessmentTextFields(node: AssessmentVisibleNode): Array<{ field: string; text: string }> {
  let fields: Array<[string, string | null]>;
  if ('text' in node) {
    fields = [['title', node.title ?? null], ['text', node.text], ['rationale', node.rationale],
      ['materialUncertainty', node.materialUncertainty], ['diseaseName', node.diseaseName],
      ['changeAssessment.summary', node.changeAssessment?.summary ?? null],
      ['changeAssessment.reason', node.changeAssessment?.reason ?? null]];
  } else if ('firstStep' in node) {
    fields = [['title', node.title], ['why', node.why], ['firstStep', node.firstStep],
      ['timing', node.timing], ['reviewPlan', node.reviewPlan], ['caution', node.caution]];
  } else if ('question' in node) {
    fields = [['question', node.question], ['whyItMatters', node.whyItMatters]];
  } else {
    fields = [['headline', node.headline], ['summary', node.summary],
      ...node.limitations.map((text, index): [string, string] => [`limitations[${index}]`, text])];
  }
  return fields.flatMap(([field, text]) => text === null ? [] : [{ field, text }]);
}

export function hasHighConsequenceNodeAssertion(node: AssessmentVisibleNode): boolean {
  return visibleAssessmentTextFields(node).some(({ text }) => hasHighConsequenceAssertion(text));
}

function hasUnsourcedNodeProbability(node: AssessmentVisibleNode): boolean {
  return visibleAssessmentTextFields(node).some(({ text }) => unsourcedProbability.test(text));
}

/** 来源记载只覆盖对应病名，不能让同一节点夹带另一个未经核实的重大判断。 */
export function hasNovelHighConsequenceClaimAssertion(claim: HealthClaim): boolean {
  return visibleAssessmentTextFields(claim).some(({ text }) => text.split(/[。；;，,！？!?\n]/).some((clause) => {
    if (!hasHighConsequenceAssertion(clause)) return false;
    // documented 不是整节点通行证；只有明确转述原来源的对应诊断才沿用来源边界。
    const sourceAttributed = /(?:报告|病理|病历|出院|原资料|原文|来源)[^。；，,\n]{0,30}(?:记载|记录|诊断|确诊|检出)/.test(clause);
    const newDirection = /(?:尚?不能|无法|不)排除|待排|待查|怀疑|疑似|可能|考虑|再次发作|重新确诊|新近确诊/.test(clause);
    return claim.diagnosticStatus !== 'documented' || !claim.diseaseName || !sourceAttributed || newDirection
      || hasHighConsequenceAssertion(clause.replaceAll(claim.diseaseName, ''));
  }));
}

function hasOwnDocumentedDiagnosis(evidence: MemberEvidenceRef, diseaseName: string, temporalStatus: HealthClaim['temporalStatus']): boolean {
  const quote = evidence.quote ?? '';
  if (!['observation', 'clinical_finding', 'source_span'].includes(evidence.kind)) return false;
  const relevantClauses = quote.split(/[。；;，,\n]/).filter((clause) => clause.includes(diseaseName));
  return relevantClauses.some((clause) => explicitDiagnosis.test(clause)
    && !/(?:未见|未发现|无|否认|不支持|非|未诊断(?:为)?|未确诊(?:为)?)\s*$/.test(clause.slice(0, clause.indexOf(diseaseName)))
    && !(otherPersonSubject.test(clause.slice(0, clause.indexOf(diseaseName)))
      && !selfSubject.test(clause.slice(0, clause.indexOf(diseaseName))))
    && !negatedOrTentative.test(clause)
    && (!historicalDiagnosis.test(clause) || temporalStatus === 'historical'));
}

/** 否定只约束当前动作；双重否定或后续独立指令不能借前文免责声明获得豁免。 */
function hasNegatedMedicationLead(lead: string): boolean {
  const negation = [...lead.matchAll(negatedMedicationLead)].at(-1);
  if (!negation) return false;
  const scope = negation[2] ?? negation[4] ?? '';
  return !medicationNegationPrefix.test(lead.slice(0, negation.index))
    && !nestedMedicationNegation.test(scope)
    // 禁止语气后重新出现“请立即……”是新命令，不沿用“不要只记录……”的否定。
    && !(negation[1] && /\S[\s\S]*请(?:马上|立即|现在|尽快|自行|擅自|应(?:当|该)?|务必|先)*$/u.test(scope));
}

export function hasDirectMedicationChange(action: MemberAssessmentCandidateV3['actions'][number]): boolean {
  const fields = [action.title, action.why, action.firstStep, action.timing, action.reviewPlan, action.caution]
    .filter((value): value is string => value !== null);
  return fields.some((field, index) => field.split(/[。；;，,！？!?\n]/)
    .flatMap((clause) => clause.split(medicationScopeBoundary)).some((clause) => {
      const changes = [...clause.matchAll(new RegExp(medicationChange, 'gi'))];
      return changes.some((change, changeIndex) => {
        const before = clause.slice(0, change.index);
        const previous = changes[changeIndex - 1];
        const afterPrevious = previous ? before.slice(previous.index + previous[0].length) : '';
        const tail = clause.slice(change.index + change[0].length, changes[changeIndex + 1]?.index);
        // 共享“是否漏服或自行停药”的询问不被“自行”切断；显式新命令和“即可”仍重开作用域。
        const hasNewInstruction = previous && (directMedicationInstructionLead.test(afterPrevious)
          || directMedicationInstructionTail.test(tail)
          || selfDirectedMedicationLead.test(afterPrevious) && !coordinatedSelfDirectedMedicationLead.test(afterPrevious));
        const lead = hasNewInstruction ? afterPrevious : before;
        if (hasNegatedMedicationLead(lead) || medicationHistoryLead.test(lead)) return false;
        return directMedicationInstructionLead.test(lead) || directMedicationInstructionTail.test(tail)
          || (index === 0 || index === 2) && selfDirectedMedicationLead.test(lead);
      });
    }));
}

const supplementName = /(?:维生素|鱼油|补充剂|保健品|营养补充品|钙片|铁剂|辅酶|蛋白粉|叶酸|褪黑素)/i;
const supplementAmount = /(?:\d+(?:\.\d+)?|[一二两三四五六七八九十百千]+)(?:\s*[-–~～至]\s*\d+(?:\.\d+)?)?\s*(?:mcg|µg|μg|ug|mg|IU|g|毫克|微克|国际单位|克|粒|片|滴|袋)(?![a-z]|\/(?:dL|mL|L)\b)/iu;
const supplementActionVerb = /(?:开始服用|服用|口服|加量|增加|新增|添加|补充(?!品|剂)|开始)/g;
const negatedSupplementLead = /(不要|不得|切勿|勿|避免|禁止|不应|无需|不必|先不|暂不|不再|不自行|不擅自)([^。；，,]{0,24})$/i;
const evaluatedSupplementLead = /(?:讨论|评估|确认|判断|咨询|询问)[^。；，,]{0,20}(?:是否|需不需要|有无必要|有没有必要|要不要)[^。；，,]{0,12}$/;
const existingSupplementLead = /(?:如果|如若|若|如|是否|有无)[^。；，,]{0,12}(?:正在|已在|已经|已|原先|目前在)[^。；，,]{0,6}$/;
// 历史须有时态/记述谓词，单凭“原报告”等来源名词不能把当前执行命令当作旧记录。
const historicalSupplementContext = /(?:(?:既往|过去|曾经|曾|当时)(?:已|有|在|曾|经|开始|继续|长期|间断|规律)*|(?:记录|记载|提及|涉及|已有)[^。；，,]{0,16})$/u;
const referencedSupplementInstruction = /^\s*(?:按照|根据|参照|遵照|依照|依据|按)[^。；，,]*$/u;
const unsupportedSupplementLead = /(?:尚无|没有|缺乏|未有)(?:充分|足够|可靠|明确)?(?:的)?(?:依据|证据|理由)(?:支持)?(?:再|额外|直接|自行|擅自|继续)*$/u;
const foodSource = /(?:从食物|通过(?:食物|饮食)|膳食|食物中|食物获得|蔬菜|水果|牛奶|酸奶|鸡蛋|豆腐|豆制品|鱼肉|瘦肉|坚果|全谷|主食)/;
const instructionContrast = /(?:但(?:是)?|不过|然而|随后|然后|并且|同时)/;
const explicitSupplementInstructionLead = /(?:每天|每日|每周|每晚|每次|马上|立即|请|建议|应该|应当|必须|需要|要求|因此)[^。；，,]{0,16}$/;
const uncertainSupplementBenefit = /^(?:[a-zA-Z0-9-]+)?(?:并)?(?:未必|不一定|不等于|不意味着|不能|无法|不足以)(?:会|保证)?(?:有帮助|有益|有效|改善|保护|带来|解决|替代|说明|保障|降低|提高)/;

/** 否定和评估只约束当前动作，不能替后面的独立服用指令背书。 */
function supplementVerbContext(clause: string, match: RegExpMatchArray, previousEnd: number): {
  lead: string; negated: boolean; evaluated: boolean; existing: boolean;
} {
  const lead = clause.slice(previousEnd, match.index).split(instructionContrast).at(-1) ?? '';
  const instruction = explicitSupplementInstructionLead.test(lead) || referencedSupplementInstruction.test(lead);
  const unsupported = unsupportedSupplementLead.exec(lead);
  const absenceIsNegated = unsupported !== null
    && /(?:并非|不是|不表示|不代表|不能说|不应说)\s*$/u.test(lead.slice(0, unsupported.index));
  const negation = negatedSupplementLead.exec(lead);
  const prohibition = negation !== null && !medicationNegationPrefix.test(lead.slice(0, negation.index))
    && !nestedMedicationNegation.test(negation[2] ?? '');
  return { lead, negated: prohibition || !instruction && unsupported !== null && !absenceIsNegated,
    evaluated: evaluatedSupplementLead.test(lead),
    existing: existingSupplementLead.test(lead) || !instruction && historicalSupplementContext.test(lead) };
}

/** “开始”必须有补充剂对象；开始日常选择、记录或食物搭配不是开始服用。 */
function hasSupplementObject(action: HealthAction, verb: string, tail: string, lead: string, field: string, clauseLead: string): boolean {
  // 通过食物补充营养不等于服用产品；后续“并且新增”的独立动作不会继承此食物语境。
  if (verb === '补充' && foodSource.test(lead)
    && !/(?:补充剂|保健品|营养补充品|钙片|铁剂|鱼油|褪黑素|蛋白粉|辅酶)/.test(tail)) return false;
  if (verb === '补充' && /^(?:方案|安排|计划|需要|必要性|需求|适应证)/.test(tail)) return false;
  if (verb === '补充' && /^的(?:依据|证据|理由|适应证|必要性)/.test(tail)) return false;
  // “医生安排的营养补充不要自行停用”中补充是既有安排的名词，不是新增服用动作。
  // 只识别本名词后的不擅改提醒；后续独立服用指令仍逐动作核对。
  if (verb === '补充' && /(?:医生|医师|营养师)[^。；，,]{0,8}(?:安排|指导)[^。；，,]{0,4}的营养$/.test(lead)
    && /^(?:不要|不得|切勿|不应)[^。；，,]{0,6}(?:自行|擅自)(?:停用|中断|调整|改变)/.test(tail)
    && !explicitSupplementInstructionLead.test(clauseLead)
    && !/(?:开始服用|服用|口服|加量|增加|新增|添加|开始)/.test(clauseLead)) return false;
  // 标题中的“维生素D补充”只是主题名；“每天补充”仍是执行句。
  if (field === 'title' && verb === '补充' && tail.trim() === ''
    && !/(?:每天|每日|每周|每晚|每次|请|应当|应该|必须|建议|开始|需|要)/.test(lead)) return false;
  const named = supplementName.exec(tail);
  if (named) {
    const afterName = tail.slice(named.index + named[0].length);
    // 补充的是资料或清单，不是给本人补充产品。
    if (!/^(?:[a-zA-Z0-9-]+)?(?:的|相关)?(?:清单|列表|名称|信息|说明|标签|资料|记录|成分)/.test(afterName)) return true;
  }
  const supplementContext = supplementName.test(action.title) || action.lifestyleDomain === 'supplements';
  return supplementContext && /^(?:开始服用|服用|口服|加量|补充)$/.test(verb)
    && !foodSource.test(tail) && !/(?:清单|信息|资料|记录|成分)/.test(tail);
}

/** 描述添加产品未必有效，不等于要求添加；只识别当前对象后的效果否定。 */
function isUncertainSupplementBenefit(lead: string, tail: string): boolean {
  if (explicitSupplementInstructionLead.test(lead)) return false;
  const named = supplementName.exec(tail);
  return named !== null && uncertainSupplementBenefit.test(tail.slice(named.index + named[0].length));
}

/** 数字补充剂建议按影响进入重点复核；浓度单位和“不新增”的一般提醒不算剂量。 */
export function hasNumericSupplementDose(action: HealthAction): boolean {
  const namedSupplement = supplementName.test(action.title);
  return visibleAssessmentTextFields(action).some(({ text }) => text.split(/[。；;，,\n]/).some((clause) => {
    if (!supplementAmount.test(clause)) return false;
    // 食物份量不是补充剂剂量；同句明确口服补充剂仍核对，不能用“配牛奶”掩盖剂量。
    if (foodSource.test(clause) && !supplementName.test(clause) && !/(?:服用|口服|剂量|用量)/.test(clause)) return false;
    const dosing = /(?:服用|口服|补充|剂量|用量|每天|每日|每周|每次|每晚|\/天|\/日|\/次)/i.test(clause);
    if (!dosing || !(supplementName.test(clause) || namedSupplement
      || action.lifestyleDomain === 'supplements' && /(?:服用|口服|补充|剂量|用量)/.test(clause))) return false;
    return [...clause.matchAll(new RegExp(supplementAmount.source, supplementAmount.flags + 'g'))].some((amount) => {
      const verbs = [...clause.slice(0, amount.index).matchAll(supplementActionVerb)];
      const last = verbs.at(-1);
      const previous = verbs.at(-2);
      return !last || !supplementVerbContext(clause, last, previous ? previous.index + previous[0].length : 0).negated;
    });
  }));
}

/** 无缺乏或个体适应证的一般建议不能直接开始补充，即使未写具体剂量。 */
function hasNewSupplementRecommendation(action: HealthAction): boolean {
  return visibleAssessmentTextFields(action).some(({ field, text }) => text.split(/[。；;，,\n]/).some((clause) => {
      const verbs = [...clause.matchAll(supplementActionVerb)];
      return verbs.some((match, index) => {
        const previous = verbs[index - 1];
        const context = supplementVerbContext(clause, match, previous ? previous.index + previous[0].length : 0);
        const tail = clause.slice(match.index + match[0].length, verbs[index + 1]?.index ?? clause.length);
        const clauseLead = clause.slice(0, match.index).split(instructionContrast).at(-1) ?? '';
        return !context.negated && !context.evaluated && !context.existing
          && !isUncertainSupplementBenefit(context.lead, tail)
          && hasSupplementObject(action, match[0], tail, context.lead, field, clauseLead);
      });
    }));
}

// 只挡明确声称个人检查/疾病的文字，不把“若已有医生限制”这种条件提示当作既定背景。
const generalLifestylePersonalAssertion = /(?:(?:你|您|本人|患者|受检者)(?:的)?(?:当前|目前|已经|已|有|存在|检查|报告)|(?:你|您|本人|患者|受检者)(?:的)?(?:(?!(?:你|您|本人|患者|受检者))[^。；，,]){0,20}?(?:升高|偏高|降低|偏低|超重|肥胖|确诊|患有)|(?:检查|报告|检验)(?:结果)?(?:显示|提示|证实|证明|发现)|(?:由于|因为|鉴于|针对|考虑到)[^。；，,]{0,28}(?:升高|偏高|降低|偏低|超重|肥胖|高血压|糖尿病|肾功能|肝功能|确诊|诊断)|(?:已确诊|已患有|确诊为)[^。；，,]{1,15})/;
const noPersonalConclusionLead = /(?:(?:没有|尚无|缺少|缺乏|尚未提供|未提供)[^。；，,]{0,8}(?:资料|证据|信息|结果)[^。；，,]{0,6}(?:显示|证明|证实|表明|说明|支持|认定)|不代表|不足以(?:说明|证明|认定)|(?:不能|无法)(?:据此|由此|仅据此|仅凭(?:这些|现有)(?:资料|检查))?(?:说明|证明|认定|判断|确定|断定))(?:(?!(?:你|您|本人|患者|受检者))[^。；，,]){0,8}$/;
const generalLifestyleMedicalDirection = /(?:复查|就诊|就医|接受[^。；，,]{0,8}检查|开始服用|口服|停药|停用|换药|加量|减量|调整剂量|治疗目标|降至[^。；，,]{0,8}\d)/;
const medicalVisitArrangement = /(?:(?:预约|安排|前往|去)[^。；，,]{0,12}(?:门诊|医生|医院|检查|复诊|眼科|内分泌科)|(?:门诊|眼科|复诊)[^。；，,]{0,10}预约)/;

/** 既有就诊场景中的清单或讨论不是新增医疗安排；预约、前往和复查仍需个人依据。 */
function hasGeneralLifestyleMedicalDirection(text: string): boolean {
  return text.split(/[。；;，,\n]/).some((clause) => medicalVisitArrangement.test(clause)
    || [...clause.matchAll(new RegExp(generalLifestyleMedicalDirection.source, 'g'))].some((match) => {
      if (['开始服用', '口服'].includes(match[0])) {
        const previous = [...clause.slice(0, match.index).matchAll(supplementActionVerb)].at(-1);
        const context = supplementVerbContext(clause, match, previous ? previous.index + previous[0].length : 0);
        if (context.negated || context.evaluated || context.existing) return false;
      }
      if (!['就诊', '就医'].includes(match[0])) return true;
      const lead = clause.slice(0, match.index);
      const tail = clause.slice(match.index + match[0].length);
      const incidental = (/^(?:时|期间)/.test(tail)
        && !/(?:预约|安排|前往|到|去|尽快|近期|下周|明天)[^。；，,]{0,10}$/.test(lead))
        // 整理本人习惯供已有的下次就诊了解，是记录用途，不是要求新增就诊。
        || /(?:供|用于)(?:下次|今后|以后)?$/.test(lead) && /^(?:了解|参考|核对)/.test(tail);
      return !incidental;
    }));
}

/** 条件提示不证明本人患病；只豁免该分句，后续独立肯定句仍需个人依据。 */
function hasGeneralLifestylePersonalAssertion(action: HealthAction): boolean {
  // 先分开转折，再匹配断言，避免一个贪婪匹配吞掉“缺证据，但你已确诊”的后半句。
  return visibleAssessmentTextFields(action).some(({ text }) => text.split(/[。；;，,！？!?\n]/)
    .flatMap((clause) => clause.split(instructionContrast)).some((clause) => (
    [...clause.matchAll(new RegExp(generalLifestylePersonalAssertion.source, 'g'))].some((match, index, matches) => {
      const lead = clause.slice(0, match.index);
      const conditional = /^\s*(?:例如[：:]?\s*)?(?:如果|如若|倘若|假如|若)/.test(lead)
        && !/(?:但(?:是)?|不过|然而|实际上|事实上)/.test(lead);
      const previous = matches[index - 1];
      const localLead = clause.slice(previous ? previous.index + previous[0].length : 0, match.index)
        .split(instructionContrast).at(-1) ?? '';
      // “没有资料说明本人已患病”只是拒绝作判断；不让这个框架覆盖后面的肯定句。
      return !conditional && !noPersonalConclusionLead.test(localLead);
    })
  )));
}

/** 一般生活起点只豁免个人依据要求，既有医嘱、治疗建议和个体判断仍走原门禁。 */
export function isGeneralLowRiskLifestyleAction(action: HealthAction): boolean {
  if (!action.lifestyleDomain || action.lifestyleBasis !== 'general' || action.kind !== 'habit'
    || action.urgency !== 'routine' || !['none', 'practical_trial'].includes(action.timingBasis)
    || action.claimIds.length !== 0 || action.evidenceIds.length !== 0
    || hasDirectMedicationChange(action) || hasHighConsequenceNodeAssertion(action)
    || hasNumericSupplementDose(action) || hasNewSupplementRecommendation(action)
    || hasGeneralLifestylePersonalAssertion(action)) return false;
  const coreFields = [action.title, action.why, action.firstStep, action.timing, action.reviewPlan]
    .filter((value): value is string => value !== null);
  return !coreFields.some(hasGeneralLifestyleMedicalDirection);
}

/** 症状出现后的停止活动和就医是安全停止语句，不是新增定期检查或治疗安排。 */
function isSymptomSafetyCaution(text: string): boolean {
  return !/(?:复查|预约|安排|前往|检查|用药|服用|剂量|治疗|定期|每周|每月|下周|明天|三个月后)/.test(text)
    && /^(?:(?:若|如果|如|一旦)?(?:出现|有))[^。；;]{0,36}(?:胸痛|呼吸困难|晕厥|明显不适|严重不适|不适|症状)[^。；;]{0,36}(?:就医|就诊)[。.!！]?$/u.test(text.trim());
}

/**
 * 新字段含医疗方向时，允许原样保留既有安全条件并追加独立的非医疗限制。
 * 这里只为既有医疗提醒授予窄例外；普通说明继续由原检查和完整 P04 核实。
 */
function preservesCautionWithAdditionalLimit(caution: string | null, originalCaution: string): boolean {
  if (caution === originalCaution) return true;
  if (!caution?.startsWith(originalCaution)) return false;
  const suffix = caution.slice(originalCaution.length);
  if (!/[。.!！？?]\s*$/u.test(originalCaution) && !/^\s*[。.!！？?\n]/u.test(suffix)) return false;
  const statements = suffix.split(/[。.!！？?\n]/u).map((statement) => statement.trim()).filter(Boolean);
  return statements.length > 0 && statements.every((statement) => !hasGeneralLifestyleMedicalDirection(statement)
    && /(?:不|未|尚无|仅|只|无法|不能|勿|避免)/u.test(statement)
    // 新增说明不能撤销原安全条件；实际医学独立性仍由 P04 核实。
    && !/(?:但|不过|然而|相反|忽略|作废|取消|无[需须]|不必|不用|不再(?:需要|适用|遵守|执行)|不需要(?:遵守|遵循|执行))/u.test(statement));
}

/** 关联主张可以作为待复核的个人依据，但只适用于常规、非医疗的个性化生活习惯。 */
export function isReviewablePersonalizedHabit(action: HealthAction, originalCaution?: string | null): boolean {
  if (action.kind !== 'habit' || action.lifestyleBasis !== 'personalized' || !action.lifestyleDomain
    || action.urgency !== 'routine' || !['none', 'practical_trial'].includes(action.timingBasis)
    || action.sourceInstructionObservationId !== undefined
    || hasDirectMedicationChange(action) || hasHighConsequenceNodeAssertion(action)
    || hasNumericSupplementDose(action) || hasNewSupplementRecommendation(action)) return false;
  const coreFields = [action.title, action.why, action.firstStep, action.timing, action.reviewPlan]
    .filter((value): value is string => value !== null);
  return !coreFields.some(hasGeneralLifestyleMedicalDirection)
    && (!action.caution || !hasGeneralLifestyleMedicalDirection(action.caution) || isSymptomSafetyCaution(action.caution)
      || Boolean(originalCaution?.trim() && preservesCautionWithAdditionalLimit(action.caution, originalCaution)));
}

/** 仅已定位的个人原文可进入习惯依据核对；目录标签和通用知识均不能替代。 */
export function isLocatedPersonalHabitEvidence(reference: MemberEvidenceRef): boolean {
  if (reference.knowledgeId !== null) return false;
  if (reference.kind === 'user_note') return Boolean(reference.quote?.trim());
  return ['observation', 'clinical_finding', 'source_span'].includes(reference.kind)
    && Boolean(reference.documentId?.trim() && reference.sourceSpanId?.trim()
      && (reference.quote?.trim() || reference.observationId?.trim()));
}

/** 仅归一化可由同一候选字段确定的结构信息，不推断病名、证据或医学确定性。 */
export function normalizeAssessmentStructuralFields(candidate: MemberAssessmentCandidateV3): MemberAssessmentCandidateV3 {
  return {
    ...candidate,
    systems: candidate.systems.map((system) => ({ ...system, id: `system:${system.systemId}` })),
    claims: candidate.claims.map((claim) => claim.diagnosticStatus !== null && claim.diseaseName !== null
      && claim.kind === 'interpretation' ? { ...claim, kind: 'diagnostic_assessment' } : claim)
  };
}

export function validateAssessmentCandidate(
  candidate: MemberAssessmentCandidateV3,
  input: AssessmentValidationInput
): AssessmentValidationResult {
  const issues: string[] = [
    ...findProcessNarrativeIssues(candidate),
    ...findInvalidAssessmentComparisons(candidate, input.evidenceCatalog),
    ...findAssessmentSemanticIssues(candidate, input.evidenceCatalog),
    ...findMissingExamScopeIssues(candidate, input.evidenceCatalog)
  ];
  const focusedReviewReasons: string[] = [];
  if (candidate.personId !== input.personId || candidate.inputSignature !== input.inputSignature
    || candidate.mode !== input.mode) issues.push('scope_mismatch');
  const expectedSystems = new Set(input.requestedSystemIds);
  const actualSystems = candidate.systems.map((system) => system.systemId);
  if (new Set(actualSystems).size !== actualSystems.length
    || actualSystems.length !== expectedSystems.size
    || actualSystems.some((system) => !expectedSystems.has(system))
    || candidate.requestedSystemIds.length !== expectedSystems.size
    || candidate.requestedSystemIds.some((system) => !expectedSystems.has(system))) issues.push('system_scope_mismatch');
  if (candidate.systems.some((system) => system.id !== `system:${system.systemId}`)) issues.push('reserved_system_id_mismatch');

  const nodes = [candidate.overview, ...candidate.systems, ...candidate.claims, ...candidate.actions, ...candidate.questions];
  const nodeIds = nodes.map((node) => node.id);
  if (new Set(nodeIds).size !== nodeIds.length) issues.push('duplicate_node_id');
  const claimIds = new Set(candidate.claims.map((claim) => claim.id));
  const actionIds = new Set(candidate.actions.map((action) => action.id));
  const evidence = new Map(input.evidenceCatalog.map((item) => [item.id, item]));
  const knowledgeIds = new Set([...input.catalogKnowledgeIds, ...candidate.knowledgeSources.map((item) => item.id)]);
  const trendIds = new Set(input.trendIds);
  const candidateKnowledgeIds = candidate.knowledgeSources.map((source) => source.id);
  if (new Set(candidateKnowledgeIds).size !== candidateKnowledgeIds.length) issues.push('duplicate_knowledge_id');
  for (const source of candidate.knowledgeSources) {
    if (source.origin === 'catalog' && !input.catalogKnowledgeIds.includes(source.id)) issues.push(`unknown_catalog_source:${source.id}`);
    if (source.origin === 'retrieved' && (!source.url?.startsWith('https://') || !source.supports)) {
      issues.push(`retrieved_source_unverifiable:${source.id}`);
    }
  }
  const validateEvidence = (owner: string, ids: string[]) => {
    for (const id of ids) if (!evidence.has(id)) issues.push(`unknown_evidence:${owner}:${id}`);
  };
  const validateClaims = (owner: string, ids: string[]) => {
    for (const id of ids) if (!claimIds.has(id)) issues.push(`unknown_claim:${owner}:${id}`);
  };
  const validateActions = (owner: string, ids: string[]) => {
    for (const id of ids) if (!actionIds.has(id)) issues.push(`unknown_action:${owner}:${id}`);
  };
  validateClaims('overview', candidate.overview.claimIds);
  validateActions('overview', candidate.overview.actionIds);
  if (hasUnsourcedNodeProbability(candidate.overview)) issues.push('unsourced_probability:overview');
  const supportedHighImpact = (node: AssessmentVisibleNode, claimIds: string[]) => {
    // 这是结构关联检查：必须逐字对应已引用且明确分型的主张正文，医学依据仍由 P04 独立核对。
    const assertedDirections = candidate.claims
      .filter((claim) => claimIds.includes(claim.id) && claim.kind === 'diagnostic_assessment'
        && claim.diagnosticStatus !== null && claim.diseaseName !== null)
      .flatMap((claim) => visibleAssessmentTextFields(claim).filter(({ field }) => field !== 'diseaseName')
        .flatMap(({ text }) => highConsequenceAssertionMentions(text).map((assertion) => ({ ...assertion,
          // 可能、倾向或未定结论不能给汇总中的确诊/已患病表达背书。
          definite: assertion.definite && (claim.diagnosticStatus === 'documented' || claim.diagnosticStatus === 'criteria_met') }))));
    return visibleAssessmentTextFields(node).every(({ text }) => highConsequenceAssertionMentions(text)
      .every((assertion) => assertedDirections.some((direction) => direction.diseaseName === assertion.diseaseName
        && (!assertion.definite || direction.definite))));
  };
  if (!supportedHighImpact(candidate.overview, candidate.overview.claimIds)) {
    issues.push('unsupported_high_impact_text:overview');
  }
  for (const system of candidate.systems) {
    validateClaims(system.id, system.claimIds);
    validateActions(system.id, system.actionIds);
    if (system.claimIds.length === 0 && system.status !== 'insufficient') issues.push(`unsupported_system_status:${system.id}`);
    if (hasUnsourcedNodeProbability(system)) issues.push(`unsourced_probability:${system.id}`);
    if (!supportedHighImpact(system, system.claimIds)) {
      issues.push(`unsupported_high_impact_text:${system.id}`);
    }
  }
  if (candidate.overview.claimIds.length === 0 && candidate.claims.length > 0) issues.push('overview_missing_claims');

  for (const claim of candidate.claims) {
    if (claim.systemIds.some((id) => !expectedSystems.has(id))) issues.push(`claim_system_outside_scope:${claim.id}`);
    validateEvidence(claim.id, [...claim.evidenceIds, ...claim.counterEvidenceIds]);
    for (const id of claim.trendIds) if (!trendIds.has(id)) issues.push(`unknown_trend:${claim.id}:${id}`);
    for (const id of claim.knowledgeSourceIds) if (!knowledgeIds.has(id)) issues.push(`unknown_knowledge:${claim.id}:${id}`);
    if (claim.evidenceIds.length === 0) issues.push(`personal_evidence_required:${claim.id}`);
    if (claim.diagnosticStatus === null) {
      if (claim.diseaseName !== null || claim.criteriaBasis !== null) issues.push(`diagnostic_fields_without_status:${claim.id}`);
      if (hasHighConsequenceNodeAssertion(claim)) issues.push(`high_impact_claim_untyped:${claim.id}`);
    } else if (!claim.diseaseName || claim.kind !== 'diagnostic_assessment') {
      issues.push(`diagnostic_fields_incomplete:${claim.id}`);
    }
    if (claim.diagnosticStatus === 'documented') {
      if (!claim.evidenceIds.some((id) => {
        const source = evidence.get(id);
        return source && hasOwnDocumentedDiagnosis(source, claim.diseaseName!, claim.temporalStatus);
      })) issues.push(`documented_source_not_proven:${claim.id}`);
    }
    if (claim.diagnosticStatus === 'criteria_met') {
      const criteria = claim.criteriaBasis;
      const supplied = input.criteriaSets.find((set) => set.id === criteria?.criteriaSetId);
      if (!criteria || !supplied || criteria.sourceId !== supplied.sourceId
        || criteria.applicability !== supplied.applicability
        || !input.catalogKnowledgeIds.includes(supplied.sourceId)
        || supplied.requiredCriterionIds.length === 0
        || !supplied.requiredCriterionIds.every((id) => criteria.requirements.some((requirement) => (
          requirement.criterionId === id && requirement.status === 'met'
          && requirement.evidenceIds.length > 0 && requirement.evidenceIds.every((evidenceId) => (
            evidence.has(evidenceId)
            && supplied.verifiedRequirements.some((verified) => verified.criterionId === id
              && verified.evidenceIds.includes(evidenceId))
          ))
        )))) {
        issues.push(`criteria_not_proven:${claim.id}`);
      }
    } else if (claim.criteriaBasis !== null) issues.push(`criteria_wrong_status:${claim.id}`);
    if ((claim.diagnosticStatus === 'likely' || claim.diagnosticStatus === 'possible')
      && claim.evidenceIds.every((id) => evidence.get(id)?.kind === 'knowledge')) {
      issues.push(`personal_diagnostic_evidence_required:${claim.id}`);
    }
    if (hasUnsourcedNodeProbability(claim)) issues.push(`unsourced_probability:${claim.id}`);
    if (claim.consequenceLevel === 'high' || hasNovelHighConsequenceClaimAssertion(claim)) {
      focusedReviewReasons.push(`high_consequence:${claim.id}`);
    }
  }

  const dedupeKeys = new Set<string>();
  for (const action of candidate.actions) {
    validateClaims(action.id, action.claimIds);
    validateEvidence(action.id, action.evidenceIds);
    for (const id of action.knowledgeSourceIds) if (!knowledgeIds.has(id)) issues.push(`unknown_knowledge:${action.id}:${id}`);
    if (action.systemIds.some((id) => !expectedSystems.has(id))) issues.push(`action_system_outside_scope:${action.id}`);
    const hasLifestyleDomain = action.lifestyleDomain !== undefined;
    const hasLifestyleBasis = action.lifestyleBasis !== undefined;
    if (hasLifestyleDomain !== hasLifestyleBasis) issues.push(`lifestyle_metadata_incomplete:${action.id}`);
    const generalLifestyle = isGeneralLowRiskLifestyleAction(action);
    if (action.lifestyleBasis === 'general' && !generalLifestyle) issues.push(`general_lifestyle_not_low_risk:${action.id}`);
    if (action.evidenceIds.length === 0 && !generalLifestyle) issues.push(`action_personal_evidence_required:${action.id}`);
    const planProof = inspectDocumentedPlanEvidence(action, input.evidenceCatalog);
    if (planProof.required) {
      const problem = planProof.unsupportedField === 'source' ? 'source_not_proven'
        : planProof.unsupportedField === 'firstStep' ? 'instruction_not_proven'
          : planProof.unsupportedField === 'timing' ? 'timing_not_proven'
            : !planProof.titleSupported ? 'title_not_supported' : null;
      if (problem) issues.push(`documented_plan_${problem}:${action.id}`);
    }
    if (dedupeKeys.has(action.dedupeKey)) issues.push(`duplicate_action_key:${action.dedupeKey}`);
    dedupeKeys.add(action.dedupeKey);
    if (hasDirectMedicationChange(action)) {
      issues.push(`direct_medication_change:${action.id}`);
    }
    if (hasUnsourcedNodeProbability(action)) issues.push(`unsourced_probability:${action.id}`);
    if (!supportedHighImpact(action, action.claimIds)) issues.push(`unsupported_high_impact_text:${action.id}`);
    if (action.urgency === 'emergency') focusedReviewReasons.push(`emergency_action:${action.id}`);
    if (hasNumericSupplementDose(action)) focusedReviewReasons.push(`numeric_supplement_dose:${action.id}`);
  }
  for (const question of candidate.questions) {
    validateClaims(question.id, question.relatedClaimIds);
    validateEvidence(question.id, question.evidenceIds);
    if (hasUnsourcedNodeProbability(question)) issues.push(`unsourced_probability:${question.id}`);
    if (!supportedHighImpact(question, question.relatedClaimIds)) issues.push(`unsupported_high_impact_text:${question.id}`);
  }
  return {
    issues: [...new Set(issues)],
    focusedReviewReasons: [...new Set(focusedReviewReasons)]
  };
}
