import { describe, expect, it } from 'vitest';
import { buildDirectOriginalReadPrompt, buildDirectOriginalRepairPrompt } from './direct-original.js';
import { DIRECT_ORIGINAL_WIRE_PROMPT_GUIDE, DIRECT_ORIGINAL_WIRE_VERSION } from '../direct-original-wire.js';
import { DIRECT_ORIGINAL_INPUT_V6_PROMPT_GUIDE, DIRECT_ORIGINAL_INPUT_V6_VERSION,
  DIRECT_ORIGINAL_INPUT_VERSION, decodeDirectOriginalInput,
  type DirectOriginalInputSection } from '../direct-original-input.js';

function repairBlock(prompt: string, section: DirectOriginalInputSection): unknown {
  const line = prompt.split('\n').find((line) => line.startsWith(`${section}=`))!;
  return decodeDirectOriginalInput(section, JSON.parse(line.slice(section.length + 1)));
}

describe('原件直读提示词', () => {
  it('表格同格与互补结果由原件锚点证明，不让新编号或阈值推导绕过校验', () => {
    for (const prompt of [buildDirectOriginalReadPrompt({}), buildDirectOriginalRepairPrompt({}, {}, [])]) {
      for (const expected of ['sourceBinding.structuredSlot', '真实行标签', '真实列头', '相同数值在不同单元格重复',
        '不能填cellId', '同一原页', '不按阈值自行推导阴性/阳性', '不同value.kind本身不证明互补',
        '同一单元格或同一分量的矛盾数值']) expect(prompt).toContain(expected);
    }
  });
  it('P01/P03明确固定wire版本、短键和presence，领域名仅说明语义且原件上下文不变', () => {
    const source = { documentId: 'synthetic-document', completeOriginal: true,
      nativeText: '合成原句：左侧未见异常 <2.50E＋02，不缩写或裁剪',
      units: Array.from({ length: 32 }, (_, index) => ({ sourceSpanId: `synthetic-page-${index + 1}`, page: index + 1 })) };
    const readPrompt = buildDirectOriginalReadPrompt(source); const repairPrompt = buildDirectOriginalRepairPrompt({}, source, []);
    for (const prompt of [readPrompt, repairPrompt]) {
      expect(prompt).toContain(DIRECT_ORIGINAL_WIRE_PROMPT_GUIDE);
      expect(prompt).toContain(DIRECT_ORIGINAL_WIRE_VERSION);
      expect(prompt).toContain('_p');
    }
    expect(readPrompt).toContain(`ORIGINAL_SOURCE_PACKAGE=${JSON.stringify(source)}`);
    expect(readPrompt).not.toContain(DIRECT_ORIGINAL_INPUT_VERSION);
    expect(readPrompt).toContain('contract必须是reading');
    expect(repairPrompt).toContain('contract必须是repair');
    expect(repairPrompt).toContain(DIRECT_ORIGINAL_INPUT_V6_PROMPT_GUIDE);
    expect(repairPrompt).toContain(`"inputVersion":"${DIRECT_ORIGINAL_INPUT_V6_VERSION}"`);
    expect(repairBlock(repairPrompt, 'ORIGINAL_SOURCE_PACKAGE')).toStrictEqual(source);
  });
  it('全报告语义与全页覆盖，不将OCR作为校验真值或暗中分成8页', () => {
    const prompt = buildDirectOriginalReadPrompt({ documentId: 'synthetic-document', units: Array.from({ length: 12 }, (_, page) => ({ page: page + 1 })) });
    expect(prompt).toContain('一次读取同一文件的全部原始页面');
    expect(prompt).toContain('没有OCR转写、旧候选或旧分析');
    expect(prompt).toContain('逐一返回全部原页骨架ID');
    expect(prompt).toContain('"page":12');
    expect(prompt).not.toContain('8页');
  });
  it('患者身份、时间角色、空白、原医生安排与病理边界均明确保留', () => {
    const prompt = buildDirectOriginalReadPrompt({});
    for (const expected of ['审核人、报告医生', '未写患者名', '签发日期不是检查日期', '历史对比表按各列日期',
      '空白、未检查、无数据不等于正常', '切缘、浸润、脉管侵犯', '报告原医生安排', 'comparator=lt', '不自行诊断']) {
      expect(prompt).toContain(expected);
    }
    expect(prompt).toContain('无需搜索互联网');
  });
  it('姓名遮挡单独记录主体不确定，不将医疗内容已读清的页面当成漏读', () => {
    for (const prompt of [buildDirectOriginalReadPrompt({}), buildDirectOriginalRepairPrompt({}, {}, [])]) {
      expect(prompt).toContain('pageReadings的完整性针对医疗内容');
      expect(prompt).toContain('subject单独保留absent或uncertain');
      expect(prompt).toContain('医疗内容实际缺失或读不清仍保留partial/unreadable');
      expect(prompt).toContain('不按已选择的成员、文件名或常识补姓名');
    }
  });
  it('原医生安排连同真实主题、完整条件及跨页栏目关系读取，不靠提取名称补主题', () => {
    for (const prompt of [buildDirectOriginalReadPrompt({}), buildDirectOriginalRepairPrompt({}, {}, [])]) {
      for (const rule of ['不能只摘“建议复查”“请到某科”等通用短句', '再靠originalName补主题',
        '实际项目标题或明确上下文绑定到sourceBinding.headingEvidence',
        '完整安排及其条件绑定到findingEvidence', '读取前后原页后保留真实跨页关联',
        '不跨栏目借用标题', '不把科普解释整体当医嘱', '不伪造主题或日期']) expect(prompt).toContain(rule);
    }
  });
  it('空白没有结果文字时明确绑定具体字段标签，不能把普通标题或读不清改成正常', () => {
    for (const prompt of [buildDirectOriginalReadPrompt({}), buildDirectOriginalRepairPrompt({}, {}, [])]) {
      for (const expected of ['unknown/original_blank', 'rawText=null', '空白字段自己的标签为role=heading',
        'originalName只使用这个原件字段标签', '显式sourceBinding.findingEvidence',
        '不把页眉、目录或泛用章节标题当成空白结果', '不凭标题推断空白',
        'not_performed/no_data仍引用原件实际写出', '读不清不是原件空白']) expect(prompt).toContain(expected);
    }
  });
  it('仅减少传输重复，仍由模型完整读取原件并保留真实结果槽和全页覆盖', () => {
    const source = { documentId: 'synthetic-document', nativeText: '合成完整原文',
      units: Array.from({ length: 32 }, (_, page) => ({ page: page + 1 })) };
    const prompt = buildDirectOriginalReadPrompt(source);
    for (const expected of ['e_1、e_2', 'c_1、c_2', '不生成UUID', '原文只在sourceExcerpts中完整记录一次',
      '引用整个摘录时quote=null', '必须保留能唯一定位该结果的窄引用原文', '不能统一改为null',
      'value.rawText仍完整保留', 'evidence至少保留一项', '另保留必需的date引用',
      'clinicalContext.conditions', '只减少重复引用和格式字符', '不删页、不删结果', '重复来源依据或覆盖清单']) {
      expect(prompt).toContain(expected);
    }
    expect(prompt).toContain(JSON.stringify(source));
  });
  it('同名项目按真实栏目和子字段定位，不靠部位或方法字段绕过来源', () => {
    for (const prompt of [buildDirectOriginalReadPrompt({}), buildDirectOriginalRepairPrompt({}, {}, [])]) {
      for (const expected of ['具体项目或子栏目', '不把复合检查的共同标题', '各自真实的栏目或段落标题依据',
        'findingEvidence分别定位具体结果', '不凭bodySite或method字段', '不为满足结构自造原文标题', '不把不同结果合并成一项']) {
        expect(prompt).toContain(expected);
      }
    }
  });
  it('同一摘录内的标题和结果由模型分别给出不重叠的完整窄引用，不让应用猜切分', () => {
    for (const prompt of [buildDirectOriginalReadPrompt({}), buildDirectOriginalRepairPrompt({}, {}, [])]) {
      for (const expected of ['同一role=finding或instruction的摘录', '唯一的窄标题原文',
        '与标题互不重叠的完整结果原文', '两者仍指向同一localKey',
        '不能以quote=null或整段引用掩盖', '删掉否定、左右侧、比较符或结果限定词',
        '应用不按originalName或数值猜切分']) expect(prompt).toContain(expected);
    }
  });
  it('重复栏目和趋势数值由模型绑定真实连续来源，保留单元格及跨页边界', () => {
    for (const prompt of [buildDirectOriginalReadPrompt({}), buildDirectOriginalRepairPrompt({}, {}, [])]) {
      for (const expected of ['包含各自区分栏目标题、中间原文和完整结果的连续局部框架',
        '不能仅创建两个内容相同的短结果摘录', '不能只因一个标题在其他位置存在',
        '可验证的栏目边界', '不拼接不连续原文', '不只引用一个裸数字',
        '保留数值之间的空格、换行及单元格边界', '数值标签重叠或被遮挡时保持unknown',
        '不能只引用末页一个短词或标点', '每页引用需在自己的真实页内唯一定位']) expect(prompt).toContain(expected);
    }
  });
  it('同值日期按各自真实角色保留，历史引用不污染独立本次日期也不升级为本次', () => {
    for (const prompt of [buildDirectOriginalReadPrompt({}), buildDirectOriginalRepairPrompt({}, {}, [])]) {
      for (const expected of ['分别保存各自独立的真实日期出处与角色',
        '不能因日期值相同就合并来源', '或把历史升级为本次',
        '只有历史出处而没有独立本次依据时', '不从文件名或旧记录补日期']) expect(prompt).toContain(expected);
    }
  });
  it('重复标题缺少独立栏目时由模型重读共同连续原文定位，不靠改名或不同值放行', () => {
    for (const prompt of [buildDirectOriginalReadPrompt({}), buildDirectOriginalRepairPrompt({}, {}, [])]) {
      for (const expected of ['两份互不相同的局部摘录不能证明', '单靠localKey不同、结果不同',
        '共同连续上下文逐字保存为一个finding或instruction摘录', '复用这个共同摘录的localKey',
        '唯一且互不重叠的完整结果引用', '必须由你重读原件取得', '不能把两份局部摘录拼接成原文',
        'headingEvidence可以为空', '不要伪造小标题', 'same_source_finding_batch_conflict',
        '不能仅据此声称原件结果有冲突', '就保持uncertain']) expect(prompt).toContain(expected);
    }
  });
  it('P03唯一一次typed目标补丁，保留完整原件及非目标', () => {
    const prompt = buildDirectOriginalRepairPrompt({ documentId: 'synthetic', originalReadingHash: 'a'.repeat(64), targets: ['value-a'] }, { nativeText: '合成全文' }, []);
    expect(prompt).toContain('唯一一次定点内容修复');
    expect(prompt).toContain('typed replace/unchanged');
    expect(prompt).toContain('originalReadingHash');
    expect(prompt).toContain('非目标由应用原样保留');
    expect(prompt).toContain('newExcerpts和newCandidates');
    expect(prompt).toContain('只能属于这个目标页');
    expect(prompt).toContain('不能仅把partial/unreadable改为read');
    expect(prompt).toContain('本轮尚未占用的全新e_/c_短编号');
    expect(prompt).toContain('不能仅把bodySite或method清空');
    expect(prompt).toContain('不能把不同结果改成相同value');
    expect(prompt).toContain('保持unchanged或uncertain');
    expect(repairBlock(prompt, 'ORIGINAL_SOURCE_PACKAGE')).toStrictEqual({ nativeText: '合成全文' });
    expect(prompt).not.toContain('生活指南');
  });
  it('P03提供只读已读目录，只补真遗漏、不靠新增候选改写旧字段或猜填遮挡范围', () => {
    const preserved = { schemaVersion: 1, targetPages: [{ pageSourceSpanId: 'page-1', candidates: [
      { localKey: 'c_1', access: 'authorized_target', targetId: 'c_1' },
      { localKey: 'c_2', access: 'immutable_non_target', value: { localKey: 'c_2', originalName: '合成既有项目' } }
    ] }], referencedExcerpts: [{ localKey: 'e_3', access: 'immutable_non_target',
      value: { localKey: 'e_3', pageSourceSpanId: 'page-2', role: 'date', quote: '合成检查时间' } }],
    reservedLocalKeys: ['page-1', 'page-2', 'e_3', 'c_1', 'c_2', 'subject', 'metadata'] };
    const prompt = buildDirectOriginalRepairPrompt({ targets: ['c_1', 'page-1'] },
      { completeOriginal: true, units: [{ sourceSpanId: 'page-1' }, { sourceSpanId: 'page-2' }] }, [], preserved);
    expect(repairBlock(prompt, 'READ_ONLY_PAGE_CONTEXT')).toStrictEqual(preserved);
    for (const expected of ['来自同一轮P01', '不是旧报告、OCR答案或新授权', 'access=immutable_non_target',
      '不能修改、删除或用newCandidates变相替换', '跨页date、heading和conditions', '不能因此扩大目标',
      'reservedLocalKeys是全局已占用', '只能使用未占用的新键', '原localKey原样引用',
      '真正未被提取的项目', '不能把目录已有字段再次当遗漏输出', '已授权candidate/excerpt目标',
      '不得通过新增同名或改名候选绕过', '不能按名称、数值、方法相近',
      '无法确认的参考范围保持unknown/uncertain', '不增加第二轮修复']) expect(prompt).toContain(expected);
  });
  it('P03按候选字段诊断回看原件，可在授权页补独立来源而不盲改混合摘录角色', () => {
    const request = { targets: [{ targetId: 'c_1', nodeType: 'candidate' }], validationDiagnostics: [{
      targetId: 'c_1', reasonCode: 'direct_original_evidence_role_mismatch',
      fieldPath: 'sourceBinding.headingEvidence[0]', sourceSpanId: 'e_1', actualRole: 'finding',
      constraint: '本候选同摘录的窄引用必须相互独立。' }] };
    const prompt = buildDirectOriginalRepairPrompt(request, {}, []);
    expect(repairBlock(prompt, 'REPAIR_REQUEST')).toStrictEqual(request);
    for (const text of ['validationDiagnostics逐项关联targetId', '该目标对象内的fieldPath',
      '候选路径相对候选，subject/metadata路径相对各自对象',
      'REFERENCE_OBLIGATION是共享来源全部引用者的保留义务', '不表示这些字段都已失败',
      '不能修好结果却破坏已有身份、日期或其他结果依据',
      '不是原件事实或改值答案', '不能把同一个全局错误码套到全部字段', '不要将整块强行改成heading',
      '再分别重绑已授权subject/metadata/候选', '空白仍留空', '不增加第二轮修复']) expect(prompt).toContain(text);
  });
  it('P01无旧候选，P03区分本轮目录与真实只读对照且仅用原件决定新读取', () => {
    const context = { schemaVersion: 1, targetPages: [], referencedExcerpts: [], reservedLocalKeys: ['c_1'],
      reconciliationDiagnostics: [{ targetId: 'c_1', nodeType: 'candidate', kind: 'value_changed',
        comparisonScope: 'stored_version', decision: 'requires_original_clarification', changedFields: ['value', 'clinicalDate'],
        comparisonRefs: ['ro_c_1'], reasonCodes: ['value_differs'] }],
      comparisonRecords: [{ localKey: 'ro_c_1', access: 'immutable_non_target', origin: 'stored_version', bindingStatus: 'unresolved',
        nodeType: 'candidate', value: { localKey: 'ro_c_1', originalName: '右侧合成结果', clinicalDate: '2025-01-02',
          value: { kind: 'numeric', rawText: '<2.50E＋02', decimal: '250', comparator: 'lt' } },
        sourceExcerpts: [{ localKey: 'ro_source_1' }], unavailableSourceRefs: ['unavailable-source'] }],
      comparisonSourceExcerpts: [{ localKey: 'ro_source_1', page: 2, quote: '右侧未见异常 <2.50E＋02；签发2025-01-03',
        role: 'finding', clarity: 'clear' }] };
    const readPrompt = buildDirectOriginalReadPrompt({});
    const prompt = buildDirectOriginalRepairPrompt({ targets: [{ targetId: 'c_1', nodeType: 'candidate' }] }, {}, [], context);
    expect(readPrompt).toContain('没有OCR转写、旧候选或旧分析供你照抄');
    for (const text of ['subject.evidence只能引用清晰的identity摘录',
      '按各自真实职责建立独立摘录', '不能为了另一结果改掉角色',
      '如果具体结果引用另一个摘录', '建立heading/context摘录',
      '不能用重复的单字或数字作为定位依据']) expect(readPrompt).toContain(text);
    expect(prompt).not.toContain('没有OCR转写、旧候选或旧分析供你照抄');
    expect(repairBlock(prompt, 'READ_ONLY_PAGE_CONTEXT')).toStrictEqual(context);
    for (const expected of ['targetPages和referencedExcerpts来自同一轮P01',
      'comparisonRecords来自真实同文件已有版本或同轮对照', '不是OCR转写或旧结论答案',
      '旧对照仅用于诊断差异，不能当作读取答案', 'comparisonScope由真实预检提供',
      '不根据reasonCodes猜测对照来源', 'reconciliationDiagnostics中的changedFields',
      'comparisonRefs帮助定位', 'bindingStatus=unresolved不表示已匹配',
      'ro_*是只读对照短编号', '不能作为目标或本轮可引用来源', '只有sourceMappings[].comparisonRecordKey专槽',
      '其他输出位置仍不得使用ro_*编号', 'candidateKey必须是本轮已授权的candidate目标',
      'comparisonRecordKey必须来自该目标reconciliationDiagnostics的comparisonRefs', 'relation=same_original_field',
      'relation=uncertain或省略', '相同candidateKey或comparisonRecordKey只能出现一次',
      '必须保持旧originalName、value、unitRaw、clinicalDate和clinicalContext原样',
      '显式sourceBinding.findingEvidence.quote再精确指向', '旧短引用必须在新框架中唯一对应',
      'comparisonSourceExcerpts是只读全局来源目录', 'sourceExcerpts只含localKey指针',
      'ro_source_*也不成为本轮可引用来源', '找不到的来源只列入unavailableSourceRefs，不造quote',
      '不得返回这些对照记录的替换补丁', '不得用newCandidates冒用或复制对照记录',
      '不得照抄对照中的旧日期、数值或单位', '旧记录本身也可能错误',
      '当前原件决定可靠的新读取', '是否替换既有记录由正式流程另行授权', '本次P03不授权覆盖既有记录',
      '无法可靠澄清时保持unchanged或uncertain', '不增加第二轮修复']) expect(prompt).toContain(expected);
  });
  it('整份报告主要日期由模型明确选择，历史趋势日期不得取首项投影为本次', () => {
    for (const prompt of [buildDirectOriginalReadPrompt({}), buildDirectOriginalRepairPrompt({}, {}, [])]) {
      for (const text of ['primaryClinicalTimeIndex', '只能指向sampled、examined或encounter',
        '旧日期必须标为history_quoted', '排在times首项', 'primaryClinicalTimeIndex=null',
        '不猜最早、最新或第一项', '主要日期不覆盖项目日期']) expect(prompt).toContain(text);
    }
  });
  it('元数据时间可复用含明确日期的真实结果框架，报告时间仍不冒充检查日期', () => {
    for (const prompt of [buildDirectOriginalReadPrompt({}), buildDirectOriginalRepairPrompt({}, {}, [])]) {
      for (const text of ['reportMetadata.times中的每条时间都必须有清晰、逐字、属于本文件且含相应日期的来源',
        '包括report_issued签发/报告时间',
        '同一完整finding或instruction摘录已经包含明确日期标签及日期时，也可直接复用',
        '必须明确该日期真实角色及与本项检查的关系',
        '跨文件日期及历史对比不能冒充本次日期', '签发/报告时间仍保留report_issued',
        '不能改为examined、补入candidate.clinicalDate或选为primaryClinicalTimeIndex',
        '没有可靠检查/采样/就诊时间时后二者保持null',
        '只有报告时间而无明确检查时间，不是报告结果无效']) expect(prompt).toContain(text);
    }
  });
});
