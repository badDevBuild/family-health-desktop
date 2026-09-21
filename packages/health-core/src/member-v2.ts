import { createHash } from 'node:crypto';
import type {
  BodySystemId,
  BodySystemRegistryItem,
  ConceptDefinition,
  ConceptMapping,
  MemberEvidenceRef,
  MetricSeriesSummary,
  TrendFacts,
  TrendPointV2
} from '@contracts';

export const MEMBER_MODEL_VERSION = 'member-v2';
export const BODY_SYSTEM_REGISTRY_VERSION = 'body-systems-v2';
export const CONCEPT_DICTIONARY_VERSION = 'concepts-v1';

export const bodySystemRegistry: readonly BodySystemRegistryItem[] = [
  { id: 'cardiovascular', version: BODY_SYSTEM_REGISTRY_VERSION, name: '心血管系统', shortName: '心血管', description: '血压、血脂、心脏与血管相关记录。', order: 10, topics: [{ id: 'blood-pressure', name: '血压', description: '收缩压、舒张压及相关记录。' }, { id: 'blood-lipids', name: '血脂', description: '胆固醇、甘油三酯及脂蛋白。' }, { id: 'cardiac', name: '心脏', description: '心率、心电与心脏影像。' }] },
  { id: 'endocrine_metabolic', version: BODY_SYSTEM_REGISTRY_VERSION, name: '内分泌与代谢系统', shortName: '内分泌 / 代谢', description: '血糖、甲状腺、尿酸和体重代谢相关记录。', order: 20, topics: [{ id: 'thyroid', name: '甲状腺', description: '甲状腺功能、抗体与影像记录。' }, { id: 'glucose-metabolism', name: '血糖代谢', description: '葡萄糖、糖化血红蛋白与胰岛素。' }, { id: 'weight-metabolism', name: '体重代谢', description: '体重、BMI 与代谢相关记录。' }] },
  { id: 'hepatobiliary', version: BODY_SYSTEM_REGISTRY_VERSION, name: '肝胆系统', shortName: '肝胆', description: '肝功能、胆红素与肝胆影像。', order: 30, topics: [] },
  { id: 'renal_urinary', version: BODY_SYSTEM_REGISTRY_VERSION, name: '肾脏与泌尿系统', shortName: '肾脏 / 泌尿', description: '肾功能、尿检和泌尿系统影像。', order: 40, topics: [] },
  { id: 'digestive', version: BODY_SYSTEM_REGISTRY_VERSION, name: '消化系统', shortName: '消化', description: '胃肠道、消化酶与相关检查。', order: 50, topics: [] },
  { id: 'respiratory', version: BODY_SYSTEM_REGISTRY_VERSION, name: '呼吸系统', shortName: '肺 / 呼吸', description: '肺部影像、肺功能和呼吸相关记录。', order: 60, topics: [] },
  { id: 'hematology_immune', version: BODY_SYSTEM_REGISTRY_VERSION, name: '血液与免疫系统', shortName: '血液 / 免疫', description: '血常规、凝血、免疫与感染相关记录。', order: 70, topics: [] },
  { id: 'musculoskeletal', version: BODY_SYSTEM_REGISTRY_VERSION, name: '肌肉骨骼系统', shortName: '肌肉 / 骨骼', description: '骨、关节和肌肉相关记录。', order: 80, topics: [] },
  { id: 'neurological', version: BODY_SYSTEM_REGISTRY_VERSION, name: '神经系统', shortName: '神经', description: '脑、神经和认知相关记录。', order: 90, topics: [] },
  { id: 'sensory_oral', version: BODY_SYSTEM_REGISTRY_VERSION, name: '感官与口腔系统', shortName: '眼耳鼻喉 / 口腔', description: '眼、耳、鼻、咽喉和口腔相关记录。', order: 100, topics: [] },
  { id: 'reproductive', version: BODY_SYSTEM_REGISTRY_VERSION, name: '生殖系统', shortName: '生殖', description: '生殖系统和相关筛查记录。', order: 110, topics: [] },
  { id: 'dermatological', version: BODY_SYSTEM_REGISTRY_VERSION, name: '皮肤系统', shortName: '皮肤', description: '皮肤、毛发和指甲相关记录。', order: 120, topics: [] }
] as const;

export const conceptDictionary: readonly ConceptDefinition[] = [
  { id: 'loinc-like-ldl-c', version: CONCEPT_DICTIONARY_VERSION, canonicalName: '低密度脂蛋白胆固醇', aliases: ['低密度脂蛋白胆固醇', '低密度脂蛋白', 'ldl-c', 'ldlc', 'ldl'], specimen: '血清', method: null, bodySite: null, compatibleUnits: ['mmol/l', 'mg/dl'], systemLinks: [{ systemId: 'cardiovascular', relation: 'direct' }, { systemId: 'endocrine_metabolic', relation: 'context' }], topicId: 'blood-lipids' },
  { id: 'loinc-like-hdl-c', version: CONCEPT_DICTIONARY_VERSION, canonicalName: '高密度脂蛋白胆固醇', aliases: ['高密度脂蛋白胆固醇', '高密度脂蛋白', 'hdl-c', 'hdlc', 'hdl'], specimen: '血清', method: null, bodySite: null, compatibleUnits: ['mmol/l', 'mg/dl'], systemLinks: [{ systemId: 'cardiovascular', relation: 'direct' }], topicId: 'blood-lipids' },
  { id: 'loinc-like-total-cholesterol', version: CONCEPT_DICTIONARY_VERSION, canonicalName: '总胆固醇', aliases: ['总胆固醇', '胆固醇', 'tc', 'total cholesterol'], specimen: '血清', method: null, bodySite: null, compatibleUnits: ['mmol/l', 'mg/dl'], systemLinks: [{ systemId: 'cardiovascular', relation: 'direct' }], topicId: 'blood-lipids' },
  { id: 'loinc-like-triglyceride', version: CONCEPT_DICTIONARY_VERSION, canonicalName: '甘油三酯', aliases: ['甘油三酯', '甘油三脂', 'tg', 'triglyceride', 'triglycerides'], specimen: '血清', method: null, bodySite: null, compatibleUnits: ['mmol/l', 'mg/dl'], systemLinks: [{ systemId: 'cardiovascular', relation: 'direct' }], topicId: 'blood-lipids' },
  { id: 'vital-systolic-bp', version: CONCEPT_DICTIONARY_VERSION, canonicalName: '收缩压', aliases: ['收缩压', '高压', 'sbp', 'systolic blood pressure'], specimen: null, method: null, bodySite: '上臂', compatibleUnits: ['mmhg', 'kpa'], systemLinks: [{ systemId: 'cardiovascular', relation: 'direct' }], topicId: 'blood-pressure' },
  { id: 'vital-diastolic-bp', version: CONCEPT_DICTIONARY_VERSION, canonicalName: '舒张压', aliases: ['舒张压', '低压', 'dbp', 'diastolic blood pressure'], specimen: null, method: null, bodySite: '上臂', compatibleUnits: ['mmhg', 'kpa'], systemLinks: [{ systemId: 'cardiovascular', relation: 'direct' }], topicId: 'blood-pressure' },
  { id: 'thyroid-tsh', version: CONCEPT_DICTIONARY_VERSION, canonicalName: '促甲状腺激素', aliases: ['促甲状腺激素', '血清促甲状腺激素', '促甲状腺素', 'tsh'], specimen: '血清', method: null, bodySite: null, compatibleUnits: ['miu/l', 'uiu/ml', 'miu/ml'], systemLinks: [{ systemId: 'endocrine_metabolic', relation: 'direct' }], topicId: 'thyroid' },
  { id: 'thyroid-ft3', version: CONCEPT_DICTIONARY_VERSION, canonicalName: '游离三碘甲状腺原氨酸', aliases: ['游离三碘甲状腺原氨酸', '血清游离三碘甲状原氨酸', '游离t3', 'ft3'], specimen: '血清', method: null, bodySite: null, compatibleUnits: ['pmol/l', 'pg/ml'], systemLinks: [{ systemId: 'endocrine_metabolic', relation: 'direct' }], topicId: 'thyroid' },
  { id: 'thyroid-total-t3', version: CONCEPT_DICTIONARY_VERSION, canonicalName: '总三碘甲状腺原氨酸', aliases: ['总三碘甲状腺原氨酸', '血清三碘甲状腺原氨酸', '总t3', 't3'], specimen: '血清', method: null, bodySite: null, compatibleUnits: ['nmol/l', 'ng/ml'], systemLinks: [{ systemId: 'endocrine_metabolic', relation: 'direct' }], topicId: 'thyroid' },
  { id: 'thyroid-ft4', version: CONCEPT_DICTIONARY_VERSION, canonicalName: '游离甲状腺素', aliases: ['游离甲状腺素', '血清游离甲状腺素', '游离t4', 'ft4'], specimen: '血清', method: null, bodySite: null, compatibleUnits: ['pmol/l', 'ng/dl'], systemLinks: [{ systemId: 'endocrine_metabolic', relation: 'direct' }], topicId: 'thyroid' },
  { id: 'thyroid-total-t4', version: CONCEPT_DICTIONARY_VERSION, canonicalName: '总甲状腺素', aliases: ['总甲状腺素', '血清甲状腺素', '总t4', 't4'], specimen: '血清', method: null, bodySite: null, compatibleUnits: ['nmol/l', 'ug/dl', 'ng/ml'], systemLinks: [{ systemId: 'endocrine_metabolic', relation: 'direct' }], topicId: 'thyroid' },
  { id: 'thyroid-tpoab', version: CONCEPT_DICTIONARY_VERSION, canonicalName: '甲状腺过氧化物酶抗体', aliases: ['甲状腺过氧化物酶抗体', '抗甲状腺过氧化物酶抗体', 'tpoab', 'tpo-ab'], specimen: '血清', method: null, bodySite: null, compatibleUnits: ['iu/ml'], systemLinks: [{ systemId: 'endocrine_metabolic', relation: 'direct' }, { systemId: 'hematology_immune', relation: 'context' }], topicId: 'thyroid' },
  { id: 'metabolic-fasting-glucose', version: CONCEPT_DICTIONARY_VERSION, canonicalName: '空腹血糖', aliases: ['空腹血糖', '空腹葡萄糖', '空腹葡萄糖测定', 'fpg', 'fasting glucose'], specimen: '血清', method: null, bodySite: null, compatibleUnits: ['mmol/l', 'mg/dl'], systemLinks: [{ systemId: 'endocrine_metabolic', relation: 'direct' }, { systemId: 'cardiovascular', relation: 'context' }], topicId: 'glucose-metabolism' },
  { id: 'metabolic-hba1c', version: CONCEPT_DICTIONARY_VERSION, canonicalName: '糖化血红蛋白', aliases: ['糖化血红蛋白', 'hba1c', 'a1c'], specimen: '全血', method: null, bodySite: null, compatibleUnits: ['%', 'mmol/mol'], systemLinks: [{ systemId: 'endocrine_metabolic', relation: 'direct' }, { systemId: 'cardiovascular', relation: 'context' }], topicId: 'glucose-metabolism' },
  { id: 'renal-creatinine', version: CONCEPT_DICTIONARY_VERSION, canonicalName: '血清肌酐', aliases: ['血清肌酐', '血清肌酐测定', '肌酐', 'creatinine', 'scr'], specimen: '血清', method: null, bodySite: null, compatibleUnits: ['umol/l', 'mg/dl'], systemLinks: [{ systemId: 'renal_urinary', relation: 'direct' }], topicId: null }
] as const;

function compact(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase('zh-CN').replace(/[\s_()（）\-—–]/g, '');
}

export function normalizeUnit(value: string | null): string | null {
  if (!value) return null;
  const normalized = value.normalize('NFKC').toLocaleLowerCase('zh-CN')
    .replace(/[µμ]/g, 'u')
    .replace(/[×*]/g, 'x')
    .replace(/\s+/g, '');
  const aliases: Record<string, string> = {
    '毫摩尔/升': 'mmol/l', 'mmol／l': 'mmol/l',
    '毫克/分升': 'mg/dl', 'mg／dl': 'mg/dl',
    '微摩尔/升': 'umol/l', 'umol／l': 'umol/l',
    '千帕': 'kpa', '毫米汞柱': 'mmhg'
  };
  return aliases[normalized] ?? normalized;
}

export function mapConcept(input: {
  rawName: string;
  standardName?: string | null;
  specimen?: string | null;
  method?: string | null;
  bodySite?: string | null;
  unit?: string | null;
}): ConceptMapping {
  const rawName = compact(input.rawName);
  const candidateName = input.standardName ? compact(input.standardName) : null;
  const rawExact = conceptDictionary.find((definition) => definition.aliases.some((alias) => compact(alias) === rawName));
  const candidateExact = candidateName
    ? conceptDictionary.find((definition) => definition.aliases.some((alias) => compact(alias) === candidateName))
    : undefined;
  const exact = rawExact ?? candidateExact;
  if (!exact) {
    return {
      rawName: input.rawName,
      normalizedName: input.standardName?.trim() || input.rawName.trim(),
      conceptId: null,
      canonicalName: null,
      status: 'unmapped',
      confidence: 0,
      reasons: ['术语词典中没有经过验证的精确映射；原始名称仍会保留。']
    };
  }

  const unit = normalizeUnit(input.unit ?? null);
  const unitKnownButIncompatible = Boolean(unit && exact.compatibleUnits.length > 0 && !exact.compatibleUnits.includes(unit));
  const specimenConflict = Boolean(input.specimen && exact.specimen && compact(input.specimen) !== compact(exact.specimen));
  const candidateOnly = !rawExact && Boolean(candidateExact);
  const candidateConflictsWithRaw = Boolean(rawExact && candidateExact && rawExact.id !== candidateExact.id);
  if (candidateOnly || candidateConflictsWithRaw || unitKnownButIncompatible || specimenConflict) {
    return {
      rawName: input.rawName,
      normalizedName: exact.canonicalName,
      conceptId: exact.id,
      canonicalName: exact.canonicalName,
      status: 'proposed',
      confidence: 0.65,
      reasons: [
        ...(candidateOnly ? ['只有模型候选名命中词典；原报告名称尚未核实为同一概念。'] : []),
        ...(candidateConflictsWithRaw ? ['原报告名称与模型候选名指向不同概念。'] : []),
        ...(unitKnownButIncompatible ? [`单位 ${input.unit} 与已验证定义不一致。`] : []),
        ...(specimenConflict ? [`标本 ${input.specimen} 与已验证定义不一致。`] : [])
      ]
    };
  }
  return {
    rawName: input.rawName,
    normalizedName: exact.canonicalName,
    conceptId: exact.id,
    canonicalName: exact.canonicalName,
    status: 'verified',
    confidence: 1,
    reasons: ['名称与经过验证的术语别名精确匹配。']
  };
}

const fallbackSystemMatchers: ReadonlyArray<[BodySystemId, RegExp]> = [
  ['cardiovascular', /血压|心率|心律|心电|胆固醇|甘油三酯|脂蛋白|ldl|hdl/i],
  ['endocrine_metabolic', /甲状腺|血糖|葡萄糖|糖化|胰岛素|体重指数|bmi|尿酸|tsh|ft3|ft4/i],
  ['hepatobiliary', /肝|胆|谷丙|谷草|转氨酶|胆红素|白蛋白|ggt|alt|ast/i],
  ['renal_urinary', /肾|尿|肌酐|尿素|egfr|前列腺|膀胱|输尿管/i],
  ['digestive', /胃|肠|幽门|便潜血|消化|胰|淀粉酶|脂肪酶/i],
  ['respiratory', /肺|呼吸|胸部|fev|fvc/i],
  ['hematology_immune', /白细胞|红细胞|血红蛋白|血小板|中性粒|淋巴|抗体|免疫/i],
  ['musculoskeletal', /骨|关节|肌肉|脊柱|颈椎|腰椎/i],
  ['neurological', /脑|神经|认知|头颅/i],
  ['sensory_oral', /视力|眼|耳|鼻|咽|喉|口腔|牙/i],
  ['reproductive', /子宫|卵巢|乳腺|宫颈|前列腺|睾丸|生殖/i],
  ['dermatological', /皮肤|皮疹|毛发|指甲/i]
];

/**
 * 使用与未映射健康事实相同的可审查关键词规则，判断一段用户文本明确涉及哪些身体系统。
 * 这不是语义猜测；无匹配时返回空集，由上层按资料类型决定是否应当全局生效。
 */
export function linkTextToSystems(text: string): BodySystemId[] {
  const normalized = text.normalize('NFKC');
  return fallbackSystemMatchers
    .filter(([, matcher]) => matcher.test(normalized))
    .map(([systemId]) => systemId);
}

export function selectContextSystems(input: {
  kind: 'history' | 'allergy' | 'medication' | 'self_measurement' | 'goal' | 'constraint' | 'free_text';
  text: string;
  structuredFields: Record<string, string>;
}): { systemIds: BodySystemId[]; basis: 'explicit' | 'keyword' | 'global_safety' | 'global_history' | 'unscoped' } {
  const valid = new Set(bodySystemRegistry.map((system) => system.id));
  const explicit = [...new Set([input.structuredFields.systemId, input.structuredFields.systemIds]
    .filter(Boolean)
    .join(',')
    .split(/[,;\s]+/)
    .filter((value): value is BodySystemId => valid.has(value as BodySystemId)))];
  if (explicit.length > 0) return { systemIds: explicit, basis: 'explicit' };
  // 过敏、用药和身体限制是全局安全背景。即使文本中命中了某个系统关键词，
  // 也不能把它缩小到单一系统，否则其他系统的建议可能遗漏安全限制。
  if (['allergy', 'medication', 'constraint'].includes(input.kind)) {
    return { systemIds: bodySystemRegistry.map((system) => system.id), basis: 'global_safety' };
  }
  const matched = linkTextToSystems([input.text, ...Object.values(input.structuredFields)].join(' '));
  if (matched.length > 0) return { systemIds: matched, basis: 'keyword' };
  if (['history', 'free_text'].includes(input.kind)) {
    return { systemIds: bodySystemRegistry.map((system) => system.id), basis: 'global_history' };
  }
  return { systemIds: [], basis: 'unscoped' };
}

export function linkConceptToSystems(mapping: ConceptMapping): Array<{ systemId: BodySystemId; relation: 'direct' | 'context' }> {
  const definition = mapping.status === 'verified' && mapping.conceptId
    ? conceptDictionary.find((item) => item.id === mapping.conceptId)
    : null;
  if (definition) return [...definition.systemLinks];
  // 候选映射不能按已确认概念进入正式系统分组。仍可根据原始名称做可审查的临时归类。
  const fallbackName = mapping.status === 'verified' ? mapping.normalizedName : mapping.rawName;
  return linkTextToSystems(fallbackName)
    .map((systemId) => ({ systemId, relation: 'direct' as const }));
}

/**
 * 旧版数据只保留了模型给出的标准名候选，没有保留原报告项目名。
 * 这里只用候选名恢复“可查看的背景归类”，永远不把它升格为已验证概念或直接事实。
 */
export function linkLegacyCandidateToSystems(
  mapping: ConceptMapping,
  candidateName: string | null
): Array<{ systemId: BodySystemId; relation: 'context' }> {
  if (!candidateName?.trim()) return [];
  const definition = mapping.conceptId
    ? conceptDictionary.find((item) => item.id === mapping.conceptId)
    : null;
  const systemIds = definition
    ? definition.systemLinks.map((link) => link.systemId)
    : linkTextToSystems(candidateName);
  return [...new Set(systemIds)].map((systemId) => ({ systemId, relation: 'context' as const }));
}

export interface TrendObservationInput {
  id: string;
  personId: string;
  rawName: string;
  standardName?: string | null;
  resolvedMapping?: ConceptMapping;
  rawText: string;
  numericValue: number | null;
  comparator: 'eq' | 'lt' | 'lte' | 'gt' | 'gte' | null;
  unit: string | null;
  referenceLow: number | null;
  referenceHigh: number | null;
  abnormalFlag: 'high' | 'low' | 'positive' | 'negative' | 'normal' | 'unknown';
  clinicalDate: string | null;
  dateRole?: 'specimen' | 'measurement' | 'exam' | 'report' | 'onset' | 'unknown';
  specimen: string | null;
  method: string | null;
  bodySite: string | null;
  documentId: string | null;
  sourceSpanId: string | null;
  sourceLabel: string;
  quote?: string | null;
  evidenceSources?: MemberEvidenceRef[];
  duplicateSourceCount?: number;
}

function stableId(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 24);
}

function contextKey(input: TrendObservationInput): string {
  return [normalizeUnit(input.unit), input.specimen, input.method, input.bodySite]
    .map((value) => value ? compact(value) : 'unknown')
    .join('|');
}

function parseTimestamp(date: string | null): number | null {
  if (!date) return null;
  const timestamp = Date.parse(`${date}T00:00:00Z`);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function buildTrendFacts(points: TrendPointV2[]): TrendFacts {
  const numeric = points.filter((point) => point.comparable && point.numericValue !== null && point.timestamp !== null);
  const hasUnknownContext = points.some((point) => point.comparabilityReasons.includes('comparison_context_unknown'));
  const status: TrendFacts['status'] = numeric.length < 2
    ? 'not_comparable'
    : hasUnknownContext ? 'conditional' : 'comparable';
  if (numeric.length < 2) {
    return {
      status,
      direction: 'insufficient',
      pointCount: points.length,
      usablePointCount: numeric.length,
      spanDays: null,
      firstValue: numeric[0]?.numericValue ?? null,
      latestValue: numeric.at(-1)?.numericValue ?? null,
      absoluteChange: null,
      relativeChangePercent: null,
      latestChange: null,
      segmentDirections: [],
      reportedFlagChanges: 0,
      referenceBoundaryCrossings: 0,
      reasons: ['至少需要两次可比较的带日期数值记录。'],
      statement: numeric.length === 1 ? '目前只有 1 次可比较记录，暂不能判断变化。' : '现有记录不能形成可比较的时间序列。'
    };
  }
  const first = numeric[0]!;
  const latest = numeric.at(-1)!;
  const firstValue = first.numericValue!;
  const latestValue = latest.numericValue!;
  const change = latestValue - firstValue;
  const relative = firstValue === 0 ? null : (change / Math.abs(firstValue)) * 100;
  const spanDays = Math.round((latest.timestamp! - first.timestamp!) / 86_400_000);
  const rangeState = (point: TrendPointV2): 'low' | 'within' | 'high' | 'unknown' => {
    if (point.numericValue === null) return 'unknown';
    if (point.referenceLow !== null && point.numericValue < point.referenceLow) return 'low';
    if (point.referenceHigh !== null && point.numericValue > point.referenceHigh) return 'high';
    if (point.referenceLow !== null || point.referenceHigh !== null) return 'within';
    return 'unknown';
  };
  const boundaryStates = numeric.map(rangeState);
  const boundaryCrossings = boundaryStates.slice(1).reduce((count, value, index) => {
    const previous = boundaryStates[index]!;
    return count + (value !== 'unknown' && previous !== 'unknown' && value !== previous ? 1 : 0);
  }, 0);
  const reportStates = numeric.map((point) => point.abnormalFlag);
  const reportedFlagChanges = reportStates.slice(1).reduce((count, value, index) => {
    const previous = reportStates[index]!;
    return count + (value !== 'unknown' && previous !== 'unknown' && value !== previous ? 1 : 0);
  }, 0);
  const deltas = numeric.slice(1).map((point, index) => point.numericValue! - numeric[index]!.numericValue!);
  const segmentDirections = deltas.map((delta) => delta > 0 ? 'up' as const : delta < 0 ? 'down' as const : 'flat' as const);

  let direction: TrendFacts['direction'] = 'insufficient';
  if (numeric.length >= 3) {
    if (deltas.every((delta) => delta === 0)) direction = 'stable';
    else if (deltas.every((delta) => delta > 0)) direction = 'increasing';
    else if (deltas.every((delta) => delta < 0)) direction = 'decreasing';
    else if (deltas.some((delta) => delta > 0) && deltas.some((delta) => delta < 0)) direction = 'fluctuating';
    else direction = 'mixed';
  }

  const directionText: Record<TrendFacts['direction'], string> = {
    insufficient: `已有 ${numeric.length} 次可比较记录，可查看前后变化，但不足以判断长期趋势。`,
    stable: `已有 ${numeric.length} 次可比较记录，整体变化不大。`,
    increasing: `已有 ${numeric.length} 次可比较记录，数值连续上升。`,
    decreasing: `已有 ${numeric.length} 次可比较记录，数值连续下降。`,
    fluctuating: `已有 ${numeric.length} 次可比较记录，期间有升有降。`,
    mixed: `已有 ${numeric.length} 次可比较记录，变化方向不一致。`
  };
  return {
    status,
    direction,
    pointCount: points.length,
    usablePointCount: numeric.length,
    spanDays,
    firstValue,
    latestValue,
    absoluteChange: change,
    relativeChangePercent: relative,
    latestChange: deltas.at(-1) ?? null,
    segmentDirections,
    reportedFlagChanges,
    referenceBoundaryCrossings: boundaryCrossings,
    reasons: [
      ...(hasUnknownContext ? ['部分标本、方法或部位未记录，因此比较结果需保留条件。'] : []),
      ...(numeric.length === 2 ? ['两点只能说明前后差异，不能证明长期趋势。'] : [])
    ],
    statement: directionText[direction]
  };
}

export function buildMetricSeries(observations: TrendObservationInput[]): MetricSeriesSummary[] {
  const grouped = new Map<string, { mapping: ConceptMapping; rows: TrendObservationInput[] }>();
  for (const observation of observations) {
    const mapping = observation.resolvedMapping ?? mapConcept({
      rawName: observation.rawName,
      ...(observation.standardName === undefined ? {} : { standardName: observation.standardName }),
      specimen: observation.specimen,
      method: observation.method,
      bodySite: observation.bodySite,
      unit: observation.unit
    });
    const identity = mapping.status === 'verified' && mapping.conceptId
      ? mapping.conceptId
      : `raw:${compact(mapping.rawName)}`;
    const key = `${identity}\u0000${contextKey(observation)}`;
    const current = grouped.get(key) ?? { mapping, rows: [] };
    current.rows.push(observation);
    grouped.set(key, current);
  }

  return [...grouped.entries()].map(([key, group]) => {
    const contextUnknown = group.rows.some((row) => !row.specimen || !row.method || !row.bodySite);
    const definition = group.mapping.status === 'verified' && group.mapping.conceptId
      ? conceptDictionary.find((item) => item.id === group.mapping.conceptId)
      : null;
    const requiresKnownUnit = Boolean(definition && definition.compatibleUnits.length > 0);
    const points: TrendPointV2[] = group.rows.map((row): TrendPointV2 => {
      const timestamp = parseTimestamp(row.clinicalDate);
      const evidence: MemberEvidenceRef = {
        id: `evidence-${row.sourceSpanId ?? row.id}`,
        kind: 'observation',
        observationId: row.id,
        eventId: null,
        documentId: row.documentId,
        sourceSpanId: row.sourceSpanId,
        knowledgeId: null,
        label: row.sourceLabel,
        locator: null,
        quote: row.quote ?? null
      };
      return {
        id: `point-${row.id}`,
        observationId: row.id,
        time: {
          value: row.clinicalDate,
          endValue: null,
          precision: row.clinicalDate ? 'day' : 'unknown',
          role: row.dateRole ?? 'unknown',
          source: row.clinicalDate ? 'explicit' : 'unknown',
          displayLabel: row.clinicalDate ?? '日期待确认'
        },
        timestamp,
        displayValue: row.rawText,
        numericValue: row.comparator === 'eq' ? row.numericValue : null,
        comparator: row.comparator,
        unit: normalizeUnit(row.unit),
        referenceLow: row.referenceLow,
        referenceHigh: row.referenceHigh,
        abnormalFlag: row.abnormalFlag,
        comparable: row.numericValue !== null && row.comparator === 'eq' && timestamp !== null
          && (!requiresKnownUnit || normalizeUnit(row.unit) !== null),
        comparabilityReasons: [
          ...(row.numericValue === null ? ['not_numeric'] : []),
          ...(row.comparator && row.comparator !== 'eq' ? ['bounded_value_not_exact'] : []),
          ...(timestamp === null ? ['clinical_date_unknown'] : []),
          ...(requiresKnownUnit && normalizeUnit(row.unit) === null ? ['unit_unknown_for_dimensional_concept'] : []),
          ...(contextUnknown ? ['comparison_context_unknown'] : [])
        ],
        evidence,
        evidenceSources: row.evidenceSources ?? [evidence],
        duplicateSourceCount: row.duplicateSourceCount ?? 0
      };
    }).sort((left, right) => (left.timestamp ?? Number.MAX_SAFE_INTEGER) - (right.timestamp ?? Number.MAX_SAFE_INTEGER));
    const facts = buildTrendFacts(points);
    const latest = [...points].filter((point) => point.timestamp !== null).at(-1) ?? points.at(-1);
    return {
      id: `series-${stableId(key)}`,
      conceptId: group.mapping.status === 'verified' ? group.mapping.conceptId : null,
      name: group.mapping.status === 'verified'
        ? group.mapping.canonicalName ?? group.mapping.normalizedName
        : group.mapping.rawName,
      unit: points.find((point) => point.unit)?.unit ?? null,
      latestValue: latest?.displayValue ?? null,
      latestDate: latest?.time.value ?? null,
      latestAbnormalFlag: latest?.abnormalFlag ?? 'unknown',
      mappingStatus: group.mapping.status,
      trendFacts: facts,
      points
    };
  }).sort((left, right) => left.name.localeCompare(right.name, 'zh-CN'));
}
