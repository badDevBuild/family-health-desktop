import { types } from 'node:util';
import { DIRECT_ORIGINAL_WIRE_KEY_MAP } from './direct-original-wire.js';

/** 仅 P03 输入表示升级；原件、领域数据、断点及输出 wire 契约保持不变。 */
export const DIRECT_ORIGINAL_INPUT_VERSION = 'direct-original-repair-input-v5' as const;
export const DIRECT_ORIGINAL_INPUT_V6_VERSION = 'direct-original-repair-input-v6' as const;
export const DIRECT_ORIGINAL_INPUT_SECTIONS = ['REPAIR_REQUEST', 'ORIGINAL_SOURCE_PACKAGE',
  'TARGET_ITEMS', 'READ_ONLY_PAGE_CONTEXT'] as const;
export type DirectOriginalInputSection = typeof DIRECT_ORIGINAL_INPUT_SECTIONS[number];

const extraKeys = Object.freeze({ sourceObjectId: 'so', originalSha256: 'os', totalUnits: 'tu', completeOriginal: 'fo',
  readingScope: 'rsc', existingResultsPolicy: 'erp', baseAuditId: 'bai',
  units: 'us', images: 'im', nativeText: 'tx', convertedViewSha256: 'vh', conversionWarnings: 'cw',
  page: 'p', inputKind: 'ik', mediaType: 'mt', sha256: 'sh', width: 'w', height: 'h', imageIndex: 'ix',
  targets: 'tg', allowedPageSourceSpanIds: 'ap', targetPages: 'tp', referencedExcerpts: 'rx', reservedLocalKeys: 'rl', access: 'ax',
  reconciliationDiagnostics: 'rd', comparisonRecords: 'cr', comparisonScope: 'cp', decision: 'dc', changedFields: 'ch',
  comparisonRefs: 'rf', origin: 'or', bindingStatus: 'bt', reasonCodes: 'rc', unavailableSourceRefs: 'ur', reportDate: 'rpd',
  comparisonSourceExcerpts: 'cx', validationDiagnostics: 'vd', reasonCode: 'rcd', fieldPath: 'fp',
  actualRole: 'ar', allowedRoles: 'alr', constraint: 'cst', actualPageStatus: 'aps',
  validationConstraints: 'vct', constraintRef: 'ctr' });
export const DIRECT_ORIGINAL_INPUT_KEY_MAP: Readonly<Record<string, string>> = Object.freeze({
  ...DIRECT_ORIGINAL_WIRE_KEY_MAP, ...extraKeys });
const reverseKeys: Readonly<Record<string, string>> = Object.freeze(Object.fromEntries(
  Object.entries(DIRECT_ORIGINAL_INPUT_KEY_MAP).map(([key, alias]) => [alias, key])));
if (Object.keys(reverseKeys).length !== Object.keys(DIRECT_ORIGINAL_INPUT_KEY_MAP).length
  || Object.values(DIRECT_ORIGINAL_INPUT_KEY_MAP).some((alias) => Object.hasOwn(DIRECT_ORIGINAL_INPUT_KEY_MAP, alias))) {
  throw new Error('DIRECT_ORIGINAL_INPUT_MAPPING_INVALID');
}

const inputPromptGuideLines = [
  `以下四个 P03 数据块均为 {inputVersion:"${DIRECT_ORIGINAL_INPUT_VERSION}",section,payload}；section必须与块标签一致。`,
  '这四块是独立inputVersion表示，先按固定映射理解原canonical语义；payload使用固定属性名映射及下述无损目录，复用上文输出wire的固定短键，下列附加输入键也固定一对一。所有原句、ID、比较符、日期角色、null、空数组、数组顺序及重复来源均原样保留。',
  '输入没有output的_p规则，不补缺省槽；输入字段缺失仍表示未提供，显式null仍是null。不要把输入封装当作新授权；只读权限、目标集合及保留编号与原领域数据完全相同。',
  '只接受本版本及固定映射，拒绝未知inputVersion或长短属性名混用；字段内的原字符串和comparisonScope值不得改写或推断。',
  'comparisonSourceExcerpts是只读全局来源目录；comparisonRecords的sourceExcerpts仅保存localKey指针。ro_*不授权本轮医学来源或目标；只有输出sourceMappings[].comparisonRecordKey专槽可指出本轮已列出的旧记录，只声明同字段关系，不能复制旧值或引用旧来源。',
  '仅REPAIR_REQUEST可含validationConstraints只读字符串目录；存在目录时，每条validationDiagnostics的constraintRef是从0开始的整数下标，读取该目录原字符串即为本条完整constraint，不可与内联constraint混用。目录只合并完全相同字符串，不能按reasonCode猜测约束；不改变诊断顺序、原句、权限或修复目标。目录和引用仅用于输入传输，canonical诊断仍为完整constraint。',
  '每块可另含valueTable和objectShapes，均只在本块有效。{_ref:N}整体等于valueTable第N项（从0开始），是原JSON子树的逐字复用，不新增来源或目标；valueTable内不再使用_ref。{_row:[N,...单元格]}整体等于objectShapes第N项列头与后续单元格按位置组成的对象，列头是固定短键，属性顺序保持原样，单元格数量必须与列头相同。先还原_row和_ref，再理解固定短键及诊断约束；目录中原句不可摘要或推断。目录仅消除相同表示，不合并医学记录、不扩大readonly权限，输出不能使用这些输入专槽。',
  `附加输入属性名→短键：${JSON.stringify(extraKeys)}`,
  '输出仍只返回既定wireVersion/contract/payload，遵循输出schema及_p；不要把inputVersion或section混入输出。'
];
export const DIRECT_ORIGINAL_INPUT_PROMPT_GUIDE = inputPromptGuideLines.join('\n');
export const DIRECT_ORIGINAL_INPUT_V6_PROMPT_GUIDE = [
  `以下四个 P03 数据块均为 {inputVersion,section,payload}；section必须与块标签一致。inputVersion只能是"${DIRECT_ORIGINAL_INPUT_VERSION}"或"${DIRECT_ORIGINAL_INPUT_V6_VERSION}"，按每块声明的版本还原，块内不可混用表示。`,
  ...inputPromptGuideLines.slice(1, 6),
  '每块可另含valueTable和objectShapes，均只在本块有效。v5的{_ref:N}整体等于valueTable第N项，{_row:[N,...单元格]}整体等于objectShapes第N项列头与单元格按位置组成的对象。v6只把这两种标记改为["v",N]和["r",N,...单元格]，N均从0开始，列头仍是固定短键，属性顺序和单元格数量必须与列头一致。v6中原数据数组若首项恰为字符串r、v或a，使用["a",...原数组项]转义；只去掉这一层a，再逐项读取原数组，不把恢复出的整个原数组重新解释成标记。其他普通数组原样逐项读取，原字符串不解释为标记。objectShapes列头和valueTable最外层是目录结构，不按标签数组解释，只有目录条目递归使用本版表示。v6块内禁止v5的_ref/_row对象标记。valueTable内不得再引用目录；先还原行、引用和数组转义，再理解固定短键及诊断约束。所有目录只逐字复用相同JSON子树，不合并医学记录，不新增来源或目标，不扩大readonly权限；目录中原句不可摘要或推断，输出不能使用这些输入专槽。',
  ...inputPromptGuideLines.slice(7)
].join('\n');

export interface DirectOriginalInputEnvelope {
  inputVersion: typeof DIRECT_ORIGINAL_INPUT_VERSION;
  section: DirectOriginalInputSection;
  payload: unknown;
  valueTable?: unknown[];
  objectShapes?: string[][];
}
export interface DirectOriginalInputEnvelopeV6 extends Omit<DirectOriginalInputEnvelope, 'inputVersion'> {
  inputVersion: typeof DIRECT_ORIGINAL_INPUT_V6_VERSION;
}

function invalid(): never { throw new Error('DIRECT_ORIGINAL_INPUT_INVALID'); }
function record(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || types.isProxy(value) || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return (prototype === Object.prototype || prototype === null) && Object.getOwnPropertySymbols(value).length === 0;
}
function sectionValid(section: unknown): section is DirectOriginalInputSection {
  return typeof section === 'string' && DIRECT_ORIGINAL_INPUT_SECTIONS.some((item) => item === section);
}
function rootShape(section: DirectOriginalInputSection, value: unknown): boolean {
  if (types.isProxy(value)) return false;
  return section === 'TARGET_ITEMS' ? Array.isArray(value)
    : section === 'READ_ONLY_PAGE_CONTEXT' ? value === null || record(value) : record(value);
}

const transportOnlyKeys = new Set(['validationConstraints', 'constraintRef']);

/** 先经过安全结构复制，再将同一请求内完全相同的诊断约束存放一处；不修改任何文本。 */
function poolValidationConstraints(section: DirectOriginalInputSection, payload: unknown): unknown {
  if (section !== 'REPAIR_REQUEST' || !record(payload) || !Array.isArray(payload.vd) || !payload.vd.length
    || payload.vd.some((item) => !record(item) || typeof item.cst !== 'string')) return payload;
  const constraints: string[] = [];
  const indexes = new Map<string, number>();
  const diagnostics = payload.vd.map((item: Record<string, unknown>) => {
    const constraint = item.cst as string;
    if (!indexes.has(constraint)) {
      indexes.set(constraint, constraints.length);
      constraints.push(constraint);
    }
    // 在原属性位置换键，使还原后的属性顺序也与原对象一致。
    return Object.fromEntries(Object.entries(item).map(([key, value]) => key === 'cst' ? ['ctr', indexes.get(constraint)!] : [key, value]));
  });
  return { ...payload, vd: diagnostics, vct: constraints };
}

function noTransportFields(value: unknown): void {
  if (Array.isArray(value)) { value.forEach(noTransportFields); return; }
  if (!record(value)) return;
  for (const [key, child] of Object.entries(value)) {
    if (transportOnlyKeys.has(key)) invalid();
    noTransportFields(child);
  }
}

/** 只还原合法目录；禁止悬空引用、混合表示、目录遗漏/重复，以及传输字段进入领域对象。 */
function restoreValidationConstraints(section: DirectOriginalInputSection, value: unknown, expandedBytes = 0): unknown {
  let restored = value;
  if (record(value) && Object.hasOwn(value, 'validationConstraints')) {
    const constraints = value.validationConstraints;
    const diagnostics = value.validationDiagnostics;
    if (section !== 'REPAIR_REQUEST' || !Array.isArray(constraints) || !constraints.length
      || constraints.some((item) => typeof item !== 'string') || new Set(constraints).size !== constraints.length
      || !Array.isArray(diagnostics) || !diagnostics.length) invalid();
    const used = new Set<number>();
    const restoredDiagnostics = diagnostics.map((item) => {
      if (!record(item) || Object.hasOwn(item, 'constraint') || !Object.hasOwn(item, 'constraintRef')) invalid();
      const index = item.constraintRef;
      if (typeof index !== 'number' || !Number.isSafeInteger(index) || index < 0 || index >= constraints.length) invalid();
      expandedBytes += byteLength(constraints[index]!);
      if (expandedBytes > maximumExpandedBytes) invalid();
      used.add(index);
      return Object.fromEntries(Object.entries(item).map(([key, child]) => key === 'constraintRef' ? ['constraint', constraints[index]] : [key, child]));
    });
    if (used.size !== constraints.length) invalid();
    restored = Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'validationConstraints')
      .map(([key, child]) => [key, key === 'validationDiagnostics' ? restoredDiagnostics : child]));
  }
  noTransportFields(restored);
  return restored;
}

const minimumPoolBytes = 12;
const maximumExpandedBytes = 64 * 1024 * 1024;
const valueRefKey = '_ref';
const objectRowKey = '_row';
const byteLength = (value: unknown) => Buffer.byteLength(JSON.stringify(value), 'utf8');

/** 只复用完整相同的 JSON 子树；目录不嵌套引用，属性顺序不同的对象不会合并。 */
function poolRepeatedValues(payload: unknown, subtreeFirst = false): { payload: unknown; valueTable?: unknown[] } {
  const counts = new Map<string, { value: unknown; bytes: number; count: number }>();
  const visit = (value: unknown): void => {
    if (typeof value === 'string' || value !== null && typeof value === 'object') {
      const text = JSON.stringify(value); const bytes = Buffer.byteLength(text);
      if (bytes >= minimumPoolBytes) {
        const item = counts.get(text);
        if (item) item.count++; else counts.set(text, { value, bytes, count: 1 });
      }
    }
    if (Array.isArray(value)) value.forEach(visit);
    else if (record(value)) Object.values(value).forEach(visit);
  };
  visit(payload);
  const indexes = new Map<string, number>(); const values: unknown[] = []; const uses: number[] = [];
  const replace = (value: unknown, allowReference = true): { value: unknown; hasReference: boolean } => {
    const text = JSON.stringify(value); const item = counts.get(text);
    const canPool = allowReference && item && item.count > 1 && (item.count - 1) * item.bytes - item.count * 12 > 0;
    const reference = () => {
      let index = indexes.get(text);
      if (index === undefined) { index = values.length; indexes.set(text, index); values.push(value); uses.push(0); }
      uses[index]!++;
      return { value: { [valueRefKey]: index }, hasReference: true };
    };
    if (!subtreeFirst && canPool) return reference();
    let hasReference = false;
    const child = (entry: unknown, canReference = true) => {
      const result = replace(entry, canReference);
      hasReference ||= result.hasReference;
      return result.value;
    };
    const replaced = Array.isArray(value) ? value.map((entry) => child(entry))
      : record(value) ? Object.fromEntries(Object.entries(value).map(([key, entry]) => [key,
        // _row 的直接数组是结构槽，解码器须先检查它；仅单元格和整行对象可引用。
        child(entry, key !== objectRowKey)])) : value;
    // 子目录一旦被引用，父节点便保持内联；表项始终是原始子树，绝不嵌套 _ref。
    if (subtreeFirst && !hasReference && canPool) return reference();
    return { value: replaced, hasReference };
  };
  const replaced = replace(payload).value;
  // 父对象被复用后，子树的有效出现次数可能变少；不发送单次或负收益目录项。
  const kept = new Map<number, number>(); const valueTable: unknown[] = [];
  values.forEach((value, index) => {
    const count = uses[index]!;
    if (count > 1 && (count - 1) * byteLength(value) - count * byteLength({ [valueRefKey]: valueTable.length }) > 0) {
      kept.set(index, valueTable.length); valueTable.push(value);
    }
  });
  if (!valueTable.length) return { payload };
  const compact = (value: unknown): unknown => {
    if (record(value) && Object.hasOwn(value, valueRefKey)) {
      const index = value[valueRefKey] as number;
      return kept.has(index) ? { [valueRefKey]: kept.get(index)! } : values[index];
    }
    if (Array.isArray(value)) return value.map(compact);
    return record(value) ? Object.fromEntries(Object.entries(value).map(([key, child]) => [key, compact(child)])) : value;
  };
  const result = { payload: compact(replaced), valueTable };
  return byteLength(result) < byteLength({ payload }) ? result : { payload };
}

/** 重复宽对象使用明确列头和等长单元格，不省略缺失/null，也不改写单元格。 */
function poolObjectShapes(input: { payload: unknown; valueTable?: unknown[] }): {
  payload: unknown; valueTable?: unknown[]; objectShapes?: string[][];
} {
  const shapes = new Map<string, { keys: string[]; count: number }>();
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) value.forEach(visit);
    else if (record(value) && !Object.hasOwn(value, valueRefKey)) {
      const keys = Object.keys(value);
      if (keys.length >= 3) {
        const shape = JSON.stringify(keys); const found = shapes.get(shape);
        if (found) found.count++; else shapes.set(shape, { keys, count: 1 });
      }
      Object.values(value).forEach(visit);
    }
  };
  visit(input.payload); input.valueTable?.forEach(visit);
  const objectShapes: string[][] = []; const indexes = new Map<string, number>();
  for (const [shape, item] of shapes) {
    const index = objectShapes.length; const cells = item.keys.map(() => null);
    const saving = byteLength(Object.fromEntries(item.keys.map((key) => [key, null])))
      - byteLength({ [objectRowKey]: [index, ...cells] });
    if (item.count > 1 && item.count * saving - Buffer.byteLength(shape) > 0) {
      indexes.set(shape, index); objectShapes.push(item.keys);
    }
  }
  if (!objectShapes.length) return input;
  const replace = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(replace);
    if (!record(value) || Object.hasOwn(value, valueRefKey)) return value;
    const keys = Object.keys(value); const index = indexes.get(JSON.stringify(keys));
    return index === undefined ? Object.fromEntries(keys.map((key) => [key, replace(value[key])]))
      : { [objectRowKey]: [index, ...keys.map((key) => replace(value[key]))] };
  };
  const result = { payload: replace(input.payload),
    ...(input.valueTable ? { valueTable: input.valueTable.map(replace) } : {}), objectShapes };
  return byteLength(result) < byteLength(input) ? result : input;
}

interface InputTransport {
  values: unknown[] | null;
  shapes: string[][];
  valueUses: number[];
  shapeUses: number[];
  expandedBytes: number;
}

/** 只映射 JSON 属性名，不解释字符串；重复对象可出现，但循环、稀疏数组及 getter 不可进入传输。 */
function transform(value: unknown, encode: boolean, ancestors: Set<object>, depth = 0,
  transport?: InputTransport, preserveAliases = false): unknown {
  if (depth > 128) invalid();
  if (transport) {
    transport.expandedBytes += value === null || ['string', 'boolean', 'number'].includes(typeof value)
      ? byteLength(value) + 1 : 8;
    if (transport.expandedBytes > maximumExpandedBytes) invalid();
  }
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || Object.is(value, -0)) invalid();
    return value;
  }
  if (typeof value !== 'object' || types.isProxy(value) || ancestors.has(value)) invalid();
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype || Object.getOwnPropertySymbols(value).length
        || Object.getOwnPropertyNames(value).length !== value.length + 1 || Object.keys(value).length !== value.length
        || Object.keys(value).some((key, index) => key !== String(index))) invalid();
      for (const key of Object.keys(value)) {
        const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
        if (!Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) invalid();
      }
      return value.map((item) => transform(item, encode, ancestors, depth + 1, transport, preserveAliases));
    }
    if (!record(value)) invalid();
    const keys = Object.getOwnPropertyNames(value);
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
      if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) invalid();
    }
    if (!encode && (Object.hasOwn(value, valueRefKey) || Object.hasOwn(value, objectRowKey))) {
      if (!transport || keys.length !== 1) invalid();
      if (Object.hasOwn(value, valueRefKey)) {
        const index = value[valueRefKey];
        if (!transport.values || typeof index !== 'number' || !Number.isSafeInteger(index) || Object.is(index, -0)
          || index < 0 || index >= transport.values.length) invalid();
        transport.valueUses[index]!++;
        return transform(transport.values[index], false, ancestors, depth, transport, preserveAliases);
      }
      const row = value[objectRowKey];
      // 先沿用数组安全检查，不能读取 getter、代理或稀疏单元格。
      if (types.isProxy(row) || !Array.isArray(row) || Object.getPrototypeOf(row) !== Array.prototype
        || Object.getOwnPropertySymbols(row).length || Object.getOwnPropertyNames(row).length !== row.length + 1
        || Object.keys(row).length !== row.length || Object.keys(row).some((key, index) => key !== String(index))) invalid();
      for (const key of Object.keys(row)) {
        const descriptor = Object.getOwnPropertyDescriptor(row, key)!;
        if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) invalid();
      }
      const index = row[0];
      if (typeof index !== 'number' || !Number.isSafeInteger(index) || Object.is(index, -0)
        || index < 0 || index >= transport.shapes.length || row.length !== transport.shapes[index]!.length + 1) invalid();
      transport.shapeUses[index]!++;
      const object = Object.fromEntries(transport.shapes[index]!.map((key, cell) => [key, row[cell + 1]]));
      return transform(object, false, ancestors, depth, transport, preserveAliases);
    }
    const map = encode ? DIRECT_ORIGINAL_INPUT_KEY_MAP : reverseKeys;
    const output: Record<string, unknown> = {};
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
      if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value') || !Object.hasOwn(map, key)
        || encode && transportOnlyKeys.has(key)) invalid();
      const target = preserveAliases ? key : map[key]!;
      if (Object.hasOwn(output, target)) invalid();
      if (transport) transport.expandedBytes += Buffer.byteLength(key) + 4;
      output[target] = transform(descriptor.value, encode, ancestors, depth + 1, transport, preserveAliases);
    }
    return output;
  } finally { ancestors.delete(value); }
}

export function encodeDirectOriginalInput(section: DirectOriginalInputSection, value: unknown): DirectOriginalInputEnvelope {
  if (!sectionValid(section) || !rootShape(section, value)) invalid();
  const payload = poolValidationConstraints(section, transform(value, true, new Set()));
  const shaped = poolObjectShapes({ payload });
  const parentFirst = poolRepeatedValues(shaped.payload);
  const subtreeFirst = poolRepeatedValues(shaped.payload, true);
  // 同一列头下比较完整平目录，保留父优先方案兜底，避免子树优先在其他形状上退化。
  const pooled = byteLength(subtreeFirst) < byteLength(parentFirst) ? subtreeFirst : parentFirst;
  return { inputVersion: DIRECT_ORIGINAL_INPUT_VERSION, section, ...pooled,
    ...(shaped.objectShapes ? { objectShapes: shaped.objectShapes } : {}) };
}

const compactTags = new Set(['r', 'v', 'a']);

/** 仅转写经过 v5 编码器检查的传输树；普通数组保留自己的层级，目录结构另行处理。 */
function compactInput(value: unknown): unknown {
  if (Array.isArray(value)) {
    const items = value.map(compactInput);
    return typeof value[0] === 'string' && compactTags.has(value[0]) ? ['a', ...items] : items;
  }
  if (!record(value)) return value;
  if (Object.hasOwn(value, valueRefKey)) return ['v', value[valueRefKey]];
  if (Object.hasOwn(value, objectRowKey)) {
    const row = value[objectRowKey] as unknown[];
    return ['r', row[0], ...row.slice(1).map(compactInput)];
  }
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, compactInput(child)]));
}

export function encodeDirectOriginalInputV6(section: DirectOriginalInputSection, value: unknown): DirectOriginalInputEnvelopeV6 {
  const envelope = encodeDirectOriginalInput(section, value);
  return { inputVersion: DIRECT_ORIGINAL_INPUT_V6_VERSION, section, payload: compactInput(envelope.payload),
    ...(envelope.valueTable ? { valueTable: envelope.valueTable.map(compactInput) } : {}),
    ...(envelope.objectShapes ? { objectShapes: envelope.objectShapes } : {}) };
}

function safeCompactArray(value: unknown): asserts value is unknown[] {
  if (types.isProxy(value) || !Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype
    || Object.getOwnPropertySymbols(value).length || Object.getOwnPropertyNames(value).length !== value.length + 1
    || Object.keys(value).length !== value.length || Object.keys(value).some((key, index) => key !== String(index))) invalid();
  for (const key of Object.keys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) invalid();
  }
}

/** 先安全反展传输表示，不展开目录引用；所有 v5 语义、宽度和展开上限随后仍由原校验器把关。 */
function expandCompactInput(value: unknown, ancestors: Set<object>, budget: { bytes: number }, depth = 0): unknown {
  if (depth > 128) invalid();
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number') {
    if (typeof value === 'number' && (!Number.isFinite(value) || Object.is(value, -0))) invalid();
    budget.bytes += byteLength(value) + 1;
    if (budget.bytes > maximumExpandedBytes) invalid();
    return value;
  }
  if (typeof value !== 'object' || types.isProxy(value) || ancestors.has(value)) invalid();
  budget.bytes += 8;
  if (budget.bytes > maximumExpandedBytes) invalid();
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      safeCompactArray(value);
      const tag = value[0];
      if (tag === 'v') {
        if (value.length !== 2) invalid();
        const index = value[1];
        if (typeof index !== 'number' || !Number.isSafeInteger(index) || Object.is(index, -0) || index < 0) invalid();
        return { [valueRefKey]: index };
      }
      if (tag === 'r') {
        const index = value[1];
        if (value.length < 2 || typeof index !== 'number' || !Number.isSafeInteger(index) || Object.is(index, -0) || index < 0) invalid();
        return { [objectRowKey]: [index, ...value.slice(2).map((item) => expandCompactInput(item, ancestors, budget, depth + 1))] };
      }
      if (tag === 'a') {
        if (value.length < 2 || typeof value[1] !== 'string' || !compactTags.has(value[1])) invalid();
        // 只移除当前转义层；恢复出的原数组不再作为传输标记解释。
        return value.slice(1).map((item) => expandCompactInput(item, ancestors, budget, depth + 1));
      }
      return value.map((item) => expandCompactInput(item, ancestors, budget, depth + 1));
    }
    if (!record(value)) invalid();
    const keys = Object.getOwnPropertyNames(value);
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
      if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value') || key === valueRefKey || key === objectRowKey) invalid();
      budget.bytes += Buffer.byteLength(key) + 4;
      if (budget.bytes > maximumExpandedBytes) invalid();
    }
    return Object.fromEntries(keys.map((key) => [key,
      expandCompactInput(Object.getOwnPropertyDescriptor(value, key)!.value, ancestors, budget, depth + 1)]));
  } finally { ancestors.delete(value); }
}

function expandV6Envelope(section: DirectOriginalInputSection, envelope: Record<string, unknown>): DirectOriginalInputEnvelope {
  const keys = Object.getOwnPropertyNames(envelope);
  if (keys.length < 3 || keys.length > 5 || keys.some((key) => !['inputVersion', 'section', 'payload', 'valueTable', 'objectShapes'].includes(key))) invalid();
  for (const key of [...new Set(['inputVersion', 'section', 'payload', ...keys])]) {
    const descriptor = Object.getOwnPropertyDescriptor(envelope, key);
    if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) invalid();
  }
  if (envelope.section !== section) invalid();
  let valueTable: unknown[] | undefined;
  if (Object.hasOwn(envelope, 'valueTable')) {
    safeCompactArray(envelope.valueTable);
    const budget = { bytes: 0 };
    valueTable = envelope.valueTable.map((item) => expandCompactInput(item, new Set(), budget));
  }
  return { inputVersion: DIRECT_ORIGINAL_INPUT_VERSION, section,
    payload: expandCompactInput(envelope.payload, new Set(), { bytes: 0 }),
    ...(valueTable ? { valueTable } : {}),
    ...(Object.hasOwn(envelope, 'objectShapes') ? { objectShapes: envelope.objectShapes as string[][] } : {}) };
}

export function decodeDirectOriginalInput(section: DirectOriginalInputSection, envelope: unknown): unknown {
  if (!sectionValid(section) || !record(envelope)) invalid();
  const version = Object.getOwnPropertyDescriptor(envelope, 'inputVersion');
  if (!version || !version.enumerable || !Object.hasOwn(version, 'value')) invalid();
  if (version.value === DIRECT_ORIGINAL_INPUT_VERSION) return decodeV5Input(section, envelope);
  if (version.value === DIRECT_ORIGINAL_INPUT_V6_VERSION) return decodeV5Input(section, expandV6Envelope(section, envelope));
  return invalid();
}

function decodeV5Input(section: DirectOriginalInputSection, envelope: unknown): unknown {
  if (!sectionValid(section) || !record(envelope)) invalid();
  const keys = Object.getOwnPropertyNames(envelope);
  if (keys.length < 3 || keys.length > 5 || keys.some((key) => !['inputVersion', 'section', 'payload', 'valueTable', 'objectShapes'].includes(key))) invalid();
  for (const key of [...new Set(['inputVersion', 'section', 'payload', ...keys])]) {
    const descriptor = Object.getOwnPropertyDescriptor(envelope, key);
    if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) invalid();
  }
  if (envelope.inputVersion !== DIRECT_ORIGINAL_INPUT_VERSION || envelope.section !== section) invalid();
  // 先借既有安全复制检查所有列头数组；不读代理、getter 或非 JSON 容器。
  const shapeValue = Object.hasOwn(envelope, 'objectShapes')
    ? (transform({ va: envelope.objectShapes }, false, new Set()) as { value: unknown }).value : [];
  if (!Array.isArray(shapeValue) || Object.hasOwn(envelope, 'objectShapes') && !shapeValue.length) invalid();
  const shapeSignatures = new Set<string>();
  for (const shape of shapeValue) {
    if (!Array.isArray(shape) || shape.length < 3 || shape.some((key) => typeof key !== 'string' || !Object.hasOwn(reverseKeys, key))
      || new Set(shape).size !== shape.length || shapeSignatures.has(JSON.stringify(shape))) invalid();
    shapeSignatures.add(JSON.stringify(shape));
  }
  const transport: InputTransport = { values: null, shapes: shapeValue as string[][],
    valueUses: [], shapeUses: shapeValue.map(() => 0), expandedBytes: 0 };
  if (Object.hasOwn(envelope, 'valueTable')) {
    const table = envelope.valueTable;
    // 目录数组也需先完整检查属性，避免 map 触发恶意 getter 或跳过稀疏槽。
    if (types.isProxy(table) || !Array.isArray(table) || Object.getPrototypeOf(table) !== Array.prototype
      || Object.getOwnPropertySymbols(table).length || Object.getOwnPropertyNames(table).length !== table.length + 1
      || !table.length || Object.keys(table).length !== table.length || Object.keys(table).some((key, index) => key !== String(index))) invalid();
    for (const key of Object.keys(table)) {
      const descriptor = Object.getOwnPropertyDescriptor(table, key)!;
      if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) invalid();
    }
    const signatures = new Set<string>();
    const values = table.map((entry) => {
      if (types.isProxy(entry) || typeof entry !== 'string' && !Array.isArray(entry) && !record(entry)) invalid();
      const restored = transform(entry, false, new Set(), 0, transport, true);
      const signature = JSON.stringify(restored);
      if (Buffer.byteLength(signature) < minimumPoolBytes || signatures.has(signature)) invalid();
      signatures.add(signature);
      return restored;
    });
    transport.values = values; transport.valueUses = values.map(() => 0); transport.expandedBytes = 0;
  }
  const decoded = transform(envelope.payload, false, new Set(), 0, transport);
  const value = restoreValidationConstraints(section, decoded, transport.expandedBytes);
  if (transport.valueUses.some((uses) => uses < 2) || transport.shapeUses.some((uses) => uses === 0)) invalid();
  if (!rootShape(section, value)) invalid();
  return value;
}
