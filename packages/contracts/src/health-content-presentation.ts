/** 正文投影只移除明确的软件处理表达，不推断或改写任何健康结论。 */
export interface PresentedAssessmentText {
  text: string;
  changed: boolean;
  processOnly: boolean;
}

/** URL 路径不是自然语言正文；这里只分离语法，不提升链接的来源可信度。 */
function protectSourceUrls(value: string): { text: string; restore: (text: string) => string } {
  // 标记不复用正文已有字符，避免把用户的普通括注误当成可跳过的内容。
  let marker = '\uE000';
  while (value.includes(marker)) marker += '\uE000';
  const urls: string[] = [];
  const text = value.replace(/(?<![a-z\d+.-])https?:\/\/(?:\[[a-f\d:.%]+\]|[^\s<>"'“”‘’（）[\]，。；！？：])+/giu, (candidate: string, offset: number) => {
    // Markdown 的结束括号不属于 URL；URL 自身的成对括号（如指南年份）保留。
    let depth = 0;
    let end = candidate.length;
    for (let index = 0; index < candidate.length; index += 1) {
      if (candidate[index] === '(') depth += 1;
      if (candidate[index] === ')') {
        if (depth === 0) { end = index; break; }
        depth -= 1;
      }
    }
    const explicitTarget = /\]\(\s*$/u.test(value.slice(0, offset)) && candidate[end] === ')'
      || value[offset - 1] === '<' && value[offset + end] === '>';
    if (!explicitTarget) {
      // 裸链接与正文共用一行时，句读后的文字仍需检查；复杂 URL 可用明确的链接边界。
      const punctuation = candidate.slice(0, end).search(/[,;!]/u);
      if (punctuation !== -1) end = punctuation;
      // 冒号可用于端口，只有 authority 之后的冒号才作为裸链接的正文边界。
      const authorityStart = candidate.indexOf('://') + 3;
      const pathOffset = candidate.slice(authorityStart, end).search(/[/?#]/u);
      if (pathOffset !== -1) {
        const pathStart = authorityStart + pathOffset;
        const colon = candidate.indexOf(':', pathStart);
        if (colon !== -1 && colon < end) end = colon;
        const sentencePeriod = candidate.slice(pathStart, end).search(/\.(?=\p{Script=Han})/u);
        if (sentencePeriod !== -1) end = pathStart + sentencePeriod;
      }
    }
    const source = candidate.slice(0, end);
    try {
      const url = new URL(source);
      if (!/^https?:\/\/[^/]/iu.test(source) || !url.hostname) return candidate;
    } catch { return candidate; }
    const index = urls.push(source) - 1;
    return `${marker}${index}\uE001${candidate.slice(end)}`;
  });
  return {
    text,
    restore: (result) => result.replace(new RegExp(`${marker}(\\d+)\uE001`, 'gu'), (token, index: string) => urls[Number(index)] ?? token)
  };
}

/** 新生成正文的编辑口吻检查；不接入旧正文清理，避免删掉同句的诊断限制。 */
export function containsEditorialInstruction(value: string): boolean {
  const instructions = value.matchAll(/(?:不能|不应|不宜|不要|不得|应当|应该|应|需要|建议|请)(?:直接)?(?:把|将)([^。；;，,\n]{1,80}?)(?:写成|写为|改写成|改写为|表述成|表述为|描述成|描述为|包装成)([^。；;，,\n]+)/gu);
  for (const [, object = '', target = ''] of instructions) {
    // 写病情记录、就诊提纲是用户行动；只定位编辑正文或把依据改写成健康结论。
    if (/^(?:这段|此段|该段|正文|标题)/u.test(object)
      || /(?:读数|结果|数值|验光|缺项|检查|资料)/u.test(object)
        && /(?:确诊|诊断|检查正常|结果正常|结果异常)/u.test(target)) return true;
  }
  return /(?:^|[。；;，,\n])\s*(?:此处|这里|正文|标题|这段(?:文字|内容))[^。；;，,\n]{0,12}(?:应|需|要|不要|不能|不应|不宜)(?:当|该)?(?:写成|写为|改写|表述为|描述为)/u.test(value);
}

// 这些词必须具有工程语境；“复查”“资料不足”“未散瞳”等临床条件不属于此类。
const processPatterns: readonly RegExp[] = [
  /(?<![a-z\d])P0[1-4](?![a-z\d])/i,
  /(?:schemaVersion|inputSignature|sourceSpanId|observationId|documentId|claimIds?|actionIds?|heldTargetIds?|reviewedTargetIds|reasonCodes?|factRevision|contextRevision|reviewScopeSignature|promptVersion|rulesVersion|validationMode|processingPlan|knowledgeVerifications|diagnosticStatus|knowledgeBasis|needs_review|no_signal_in_scope|local_only|model_cited|contextStatus|coveredSourceSpanIds|TrendFacts)/i,
  /(?:member-assessment|health-acceptance|lean-health|assessment-validation|extract|derived|system-analysis)-v\d+(?:\.\d+)*/i,
  /(?:claim|action|question|system|observation|document|evidence|person|node|ref\d*)[:_-][a-z\d][a-z\d:_-]*/i,
  /(?:MD5|SHA-?256|哈希|校验和|JSON\s*(?:schema|契约|校验)|CAS\s*(?:冲突|校验)|token\s*(?:数|限额|消耗)|input[_ ]?signature)/i,
  /(?:\bfile:[^\s]|\/(?:Users|home|private|tmp|workspace|workspaces|Volumes|Applications|Library|mnt)\/|\b[a-z]:[\\/][^\s])/i,
  // 对象 UUID 与原件文件名是来源定位信息，不应夹在健康解读正文里。
  /(?<![a-f\d])[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}(?![a-f\d])/i,
  /[^\s/\\<>:"“”'‘’（）()，,。；;!?！？]+\.(?:pdf|png|jpe?g|webp|tiff?|heic|docx?|txt|csv)(?![a-z\d])/i,
  /(?:模型|\bAI\b|\bagent\b|代理|程序|流水线|管道|后台)[^。；，,\n]{0,18}(?:核对|复核|核验|验证|校验|提取|解析|发布|重跑|处理|失败|报错|重试|读取|生成|隔离|接纳|判断|推理|检查通过|自检)/iu,
  /(?<![\p{Script=Han}])(?:应用|系统)(?:的)?(?:已|未|尚未|仍|正在|自动|将|会|可以|可|不能|无法|等待|尚待|仍待|暂未){0,3}(?:核对|复核|核验|验证|校验|提取|解析|发布|重跑|处理|失败|报错|重试|读取|生成|隔离|接纳|判断|推理|检查通过|自检)/iu,
  /(?:核对|复核|核验|校验|验证)[^。；，,\n]{0,12}(?:模型|应用|系统|程序|两轮|两次读取)/i,
  /(?:两轮|两次|首次|第二轮|独立)(?:读取|提取|模型复核)|(?:本地(?:校验|核验|验证|解析|处理)|自动接纳|已接纳|未接纳|已入库|未入库|已入档|事实接纳|只读投影|局部隔离)/,
  /(?:主张|节点|候选|输入签名|规则版本|处理状态)[^。；，,\n]{0,18}(?:核对|复核|核验|验证|校验|通过|失败|一致|发布|隔离)/,
  /(?:采用|使用|根据)输入(?:的|中(?:提供的)?)?[^。；，,:：\n]{0,30}(?:趋势事实|TrendFacts|事实包|证据包)/i,
  /(?:程序|模型|软件)(?:提供|计算|算出|生成)的?(?:前后)?(?:差值|变化量|趋势|比较结果)/,
  /(?:本轮|本次分析|本次综合|本次解读)[^。；，,\n]{0,24}(?:诊断标准|标准匹配)/,
  /(?:部分|这部分|该条|本条|本次|本系统|本轮|另有|其他|相关)?(?:健康)?(?:判断|主张|内容|项目|结果|解读)[^。；，,\n]{0,18}(?:暂未发布|尚未发布|未发布|尚未纳入|未纳入|未展示|被隔离)/,
  /(?:暂未|尚未|未)(?:按|经过|通过)?(?:当前|新|旧版|新版)?(?:规则|流程|版本)[^。；，,\n]{0,18}(?:核对|复核|综合|更新)|(?:旧版|新版)(?:解读|建议|综合)(?:已恢复|恢复|尚待复核|待复核|仅供参考)|(?:按新规则|重新综合|刷新综合)/,
  /(?:等待|待|尚待|仍待)(?:模型|系统|程序|应用)(?:处理|复核|核验|确认)|(?:应用|模型)(?:尚未|未)(?:核对|打开|核验)(?:网页)?正文/,
  /(?:^|[。；，,:：\n])\s*(?:事实进入(?:新|当前)流程|独立复核(?:尚未|未)完成|(?:模型)?证据匹配(?:尚未|未)完成|(?:暂未|尚未)发布)\s*(?:$|[。；，,:：])/,
  /(?:^|[。；，,:：\n])\s*(?:词典中(?:没|尚未|未)有精确映射|名称精确匹配)\s*(?:$|[。；，,:：])/,
  /(?:^|[。；，,:：\n])\s*未给(?:无日期|缺少日期)记录补(?:时间|日期)\s*(?:$|[。；，,:：])/,
  /^\s*(?:报告事实|已有(?:的)?检查结果|原始依据)(?:和其他行动)?(?:仍|还)?可(?:以)?查看\s*[。；，,]?\s*$/,
  // 编辑者证明“可以保留原文”的说明不是给家人的建议；只删独立完整分句。
  /^\s*(?:原)?报告中有明确的(?:肯定)?安排\s*[。；，,]?\s*$/,
  /^\s*(?:可|可以|应|应当)按原文保留\s*[。；，,]?\s*$/,
  /(?:^|[。；，,:：\n])\s*(?:经(?:过)?核对|已通过(?:本地)?(?:校验|验证)|(?:处理|核验|验证)(?:状态|说明|记录)|解读待完善|部分解读|部分(?:健康)?判断仍需核实)\s*(?:$|[。；，,:：])/,
  /^(?:已|已经)?(?:逐页|逐份)(?:核对|核验|复核)(?:过)?(?:原图|原始图像|原报告|报告原图)\s*[。；，,]?\s*$/,
  /^(?:已|已经|现已)?(?:纠正|修正|更正)(?:了)?(?:此前|之前|先前|原先)(?:的)?(?:识别|解析|提取|归属|日期绑定)(?:错误|误差)\s*[。；，,]?\s*$/,
  /^(?:此前|之前|先前|原先)(?:把|将)[^。；，,\n]{1,30}(?:识别|解析|提取)(?:成|为|错)[^。；，,\n]{1,30}\s*[。；，,]?\s*$/,
  /^\s*(?:现已|已经|已)(?:更正|纠正|修正)(?:识别错误)?\s*[。；，,]?\s*$/,
  /^\s*(?:证据(?:已|已经)?验证完整|本轮检查全部通过)\s*[。；，,]?\s*$/,
  /^\s*(?:经(?:过)?)?(?:模型|应用|系统|程序)(?:的)?(?:核对|复核|核验|验证|校验)(?:已完成|通过)?\s*[。；，,]?\s*$/,
  // 只匹配完整的软件展示分句，不将“影像未确认”或身体系统的医学解释当作过程。
  /^\s*(?:报告)?小结(?:仍|还)?可(?:以)?用于(?:本次)?(?:分析|解读)\s*[，,。！？!?；;]*\s*$/,
  /^\s*(?:部分|其他|相关)?(?:已保存的?|已接纳的?)?(?:报告)?事实(?:尚未|暂未|仍未|未|已经|已)(?:归入|纳入)(?:身体)?系统视图\s*[，,。！？!?；;]*\s*$/,
  /^\s*(?:本次|当前)?(?:健康)?总览(?:已经|已)(?:纳入|归入)(?:其中)?(?:可|可以)(?:确定|确认)(?:的)?(?:重要)?(?:内容|项目|事实)\s*[，,。！？!?；;]*\s*$/
];

const processPrefixes: readonly RegExp[] = [
  // 只移除计算来源标签，差值、方向、单位和相邻临床限制原样保留。
  /^\s*(?:程序|模型|软件)(?:提供|计算|算出|生成)的?(?=(?:前后)?(?:差值|变化量|趋势|比较结果))/,
  /^\s*P0[1-4]\s*(?:重点|独立)?\s*(?:复核|校验|核验|验证)?\s*(?:结果)?\s*(?:显示|表明|提示|确认|发现|[:：])\s*[:：，,]?\s*/i,
  /^\s*(?:(?:采用|使用|根据)输入(?:的|中(?:提供的)?)?|程序提供的)[^。；，,:：\n]{0,30}(?:趋势事实|TrendFacts|事实包|证据包)(?:显示|表明|可见)\s*[:：，,]?\s*/i,
  /^\s*(?:经(?:过)?(?:本地|模型|系统|应用)?(?:核对|复核|核验|验证|校验)|(?:根据|经过|通过)?(?:模型|\bAI\b|\bagent\b|应用|系统|程序)(?:的)?(?:核对|复核|核验|验证|校验|提取|分析|检测)(?:结果)?(?:显示|提示|确认|发现)?|(?:已通过|通过了?)(?:本地|模型|应用|系统)?(?:核对|复核|核验|验证|校验))\s*[，,:：]\s*/i,
  /^\s*(?:模型(?:认为|判断(?:为)?|推测|已确认)|(?:应用|系统|程序)(?:检测到|发现|认为)|经核对(?:可见|发现|确认))\s*[:：，,]?\s*/i
];

export function containsProcessNarrative(value: string): boolean {
  const text = protectSourceUrls(value).text;
  const matches = (fragment: string) => processPrefixes.some((pattern) => pattern.test(fragment))
    || processPatterns.some((pattern) => pattern.test(fragment));
  // 精确的纯过程短句可以嵌在临床长句中；先定位分句，不放宽到吞掉整条解释。
  return matches(text) || text.split(/[，,。！？!?；;\n]/).some(matches);
}

function processFragmentLead(value: string): string {
  return value.trimStart().replace(/^(?:该|本|这(?:条|个|部分)?|当前|此前)(?=主张|节点|候选|模型|程序|规则|流程|处理)/, '');
}

const purePhaseStatus = /^\s*P0[1-4]\s*(?:(?:重点|独立)?(?:复核|校验|核验|验证)|生成|提取|分析)?\s*(?:已通过|通过|未通过|已完成|完成|未完成|尚未完成|待完成|等待复核|等待处理)\s*[，,。！？!?；;]*\s*$/i;

function canDiscardProcessFragment(value: string): boolean {
  const leading = processFragmentLead(value);
  // 工程起头并不证明整分句都是过程；未能精确剥离时保留混合句，交给新正文门禁修复。
  if (/(?:且|同时|但|不过|以及|而)/.test(value)) return false;
  if (/^P0[1-4]/i.test(leading)) return purePhaseStatus.test(leading);
  const pureKnownMessage = /^(?:模型仍无法判断符号含义|本地(?:校验|核验|验证)(?:通过|未通过|失败|(?:问题|错误)(?:数)?(?:为|是)?\s*\d+))\s*[，,。！？!?；;]*\s*$/;
  if (pureKnownMessage.test(leading)) return true;
  // 只有命中覆盖完整片段，或后面仅有内部键值时才能删。命中工程前缀不能吞掉后续临床句。
  return processPatterns.some((pattern) => {
    const match = pattern.exec(leading);
    if (match?.index !== 0) return false;
    const suffix = leading.slice(match[0].length);
    return /^[\s，,。！？!?；;]*$/.test(suffix)
      || pattern === processPatterns[1] && /^(?:=|[:：])\s*[a-z\d:_-]+\s*[，,。！？!?；;]*\s*$/i.test(suffix);
  });
}

function cleanProcessFragments(value: string): string {
  const fragments = value.match(/[^，,。！？!?；;\n]+[，,。！？!?；;]*|\n+/g) ?? [];
  const retained: string[] = [];
  for (const fragment of fragments) {
    if (/^\n+$/.test(fragment)) { retained.push(fragment); continue; }
    let cleaned = fragment;
    let removedPrefix = false;
    // 工程标签后可能跟着数值或临床条件，先去标签；标签后的纯处理状态才单独移除。
    for (const prefix of processPrefixes) {
      const next = cleaned.replace(prefix, '');
      removedPrefix ||= next !== cleaned;
      cleaned = next;
    }
    cleaned = cleaned.replace(/(?:已接纳|已入库|已入档)的?/g, '');
    if (removedPrefix && /^\s*(?:已通过|通过|未通过|已完成|完成|未完成|尚未完成|待完成|成功|失败|一致)\s*[，,。！？!?；;]*\s*$/.test(cleaned)) continue;
    if (containsProcessNarrative(cleaned) && canDiscardProcessFragment(cleaned)) continue;
    // 工程词只出现在临床句中间且不能精确拆开时，保留原句；不能凭词命中删除前置条件或数值。
    if (/^\s*[，,:：。；;]?\s*$/.test(cleaned)) continue;
    // 任何保留下来的否定/限制都不因之前删除过工程句而被推定成“无指代”的过程说明。
    retained.push(cleaned);
  }
  return retained.join('').replace(/^[\s，,:：。；;]+|[\s，,:：；;]+$/g, '').trim();
}

function cleanProcessAnnotations(value: string): string {
  // 先处理最内层括注，工程括注绝不能连带吞掉括号之前的临床结果。
  let result = value;
  for (;;) {
    const next = result.replace(/[（(]([^（）()]*)[）)]/g, (annotation: string, body: string) => {
      if (!containsProcessNarrative(body)) return annotation;
      const cleaned = cleanProcessFragments(body);
      return cleaned ? `${annotation[0]}${cleaned}${annotation.at(-1)}` : '';
    });
    if (next === result) return result;
    result = next;
  }
}

/**
 * 兼容旧快照的纯文本展示函数。逐分句删除工程内容，避免把同一句中的数字、
 * 否定、时间或“未散瞳”等临床限制一并吞掉；不截断原有临床句子或生成替代结论。
 */
export function presentAssessmentText(value: string): PresentedAssessmentText {
  const sourceUrls = protectSourceUrls(value);
  if (!containsProcessNarrative(sourceUrls.text)) return { text: value, changed: false, processOnly: false };
  const text = sourceUrls.restore(cleanProcessFragments(cleanProcessAnnotations(sourceUrls.text)));
  return { text, changed: text !== value, processOnly: text.length === 0 && value.trim().length > 0 };
}
