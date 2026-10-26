export interface LocalVisualTextBox {
  text: string;
  confidence: number;
  /** Vision 使用左下角为原点的归一化坐标。 */
  bounds: [number, number, number, number];
}

export interface LocalVisualLayoutRow {
  text: string;
  bounds: [number, number, number, number];
  /** 每个原始文字框的位置保留，不把几何归行误作已确认事实。 */
  boxes: LocalVisualTextBox[];
}

export interface LocalVisualLayout {
  version: 'local-visual-layout-v2';
  quote: string;
  rows: LocalVisualLayoutRow[];
  warnings: string[];
}

interface LayoutCell extends LocalVisualTextBox {
  sourceBoxes: LocalVisualTextBox[];
}

type ColumnRole = 'name' | 'result' | 'unit' | 'reference' | 'history';
interface SourceColumnHeader { role: ColumnRole; box: LocalVisualTextBox }

function centerY(box: LocalVisualTextBox): number {
  return box.bounds[1] + box.bounds[3] / 2;
}

function overlapX(left: LocalVisualTextBox, right: LocalVisualTextBox): number {
  return Math.max(0, Math.min(left.bounds[0] + left.bounds[2], right.bounds[0] + right.bounds[2])
    - Math.max(left.bounds[0], right.bounds[0]));
}

function unionBounds(boxes: LocalVisualTextBox[]): [number, number, number, number] {
  const left = Math.min(...boxes.map((box) => box.bounds[0]));
  const bottom = Math.min(...boxes.map((box) => box.bounds[1]));
  const right = Math.max(...boxes.map((box) => box.bounds[0] + box.bounds[2]));
  const top = Math.max(...boxes.map((box) => box.bounds[1] + box.bounds[3]));
  return [left, bottom, right - left, top - bottom];
}

function samePhysicalRow(left: LocalVisualTextBox, right: LocalVisualTextBox): boolean {
  const overlapY = Math.max(0, Math.min(left.bounds[1] + left.bounds[3], right.bounds[1] + right.bounds[3])
    - Math.max(left.bounds[1], right.bounds[1]));
  const smallerHeight = Math.min(left.bounds[3], right.bounds[3]);
  if (smallerHeight <= 0 || overlapY / smallerHeight < 0.55) return false;
  if (Math.abs(centerY(left) - centerY(right)) > smallerHeight * 0.55) return false;
  // 同一列中的上下文字不能因另一个高文字框的桥接而变成同一行。
  const smallerWidth = Math.min(left.bounds[2], right.bounds[2]);
  return smallerWidth <= 0 || overlapX(left, right) / smallerWidth < 0.5;
}

function isResultCell(box: LocalVisualTextBox): boolean {
  return /^[↑↓个约≈\s]*(?:[<>≤≥]|<=|>=)?\s*[+-]?(?:\d+(?:[.,]\d+)?|\.\d+)|^(?:阴性|陽性|阳性|陰性|未见|正常)/u
    .test(box.text.normalize('NFKC').trim());
}

function nameContinuation(text: string): boolean {
  // 仅处理可明确是名称末尾的短片段；不把下一项目名或正文并入上一项。
  return /^(?:抗体|球蛋白抗体|过氧化物酶抗体|原氨酸|氨酸|计数)(?:\s*[(（][A-Za-z0-9\- ]{1,20}[)）])?$/u
    .test(text.normalize('NFKC').trim());
}

function headerRole(text: string): ColumnRole | null {
  const compact = text.normalize('NFKC').replace(/\s+/gu, '');
  if (/^(?:项目|项目名称|检验项目|检测项目|指标|名称|项目名|检测指标)$/u.test(compact)) return 'name';
  if (/^(?:结果|检验结果|检测结果|测定值|结果值|当前结果|本次结果|本次)$/u.test(compact)) return 'result';
  if (/^(?:单位|结果单位)$/u.test(compact)) return 'unit';
  if (/^(?:参考(?:范围|区间|值)?|正常(?:范围|值)|区间)$/u.test(compact)) return 'reference';
  if (/^\d{4}(?:年(?:\d{1,2}月(?:\d{1,2}日)?)?|[-/.]\d{1,2}(?:[-/.]\d{1,2})?)?(?:结果)?$/u.test(compact)) return 'history';
  return null;
}

function headersInRow(cells: LayoutCell[]): SourceColumnHeader[] {
  const headers = cells.flatMap((cell) => {
    const role = headerRole(cell.text);
    return role ? [{ role, box: cell }] : [];
  });
  const hasStructure = headers.some((header) => header.role === 'name' || header.role === 'result')
    || headers.filter((header) => header.role === 'history').length >= 2;
  return headers.length >= 2 && hasStructure ? headers : [];
}

function roleForCell(cell: LayoutCell, headers: SourceColumnHeader[]): ColumnRole | null {
  const distances = headers.map((header) => ({ header, distance: Math.abs(header.box.bounds[0] - cell.bounds[0]) }))
    .sort((left, right) => left.distance - right.distance);
  if (!distances[0] || distances[1] && distances[1].distance - distances[0].distance < 0.01) return null;
  return distances[0].header.role;
}

function looksLikeUnit(text: string): boolean {
  const compact = text.normalize('NFKC').replace(/\s+/gu, '');
  return /^(?:%|bpm|mmhg|kg|g|cm|mm|m|l|ml|fl|iu|u|[x×*]?10\^?-?\d+\/l|(?:[munpkµμ]?(?:g|mol)|[kmuµμ]?iu|[muµμ]?u|copies|ng|pg|mm|cm|m)(?:\/(?:l|ml|dl|s|min|kg|24h))|次\/分|厘米|毫米|千克|公斤)$/iu
    .test(compact);
}

function isRangeCell(text: string): boolean {
  return /^(?:[+-]?(?:\d+(?:\.\d+)?|\.\d+)\s*(?:-|~|～|至|—|–)\s*[+-]?(?:\d+(?:\.\d+)?|\.\d+))/u
    .test(text.normalize('NFKC').trim());
}

function serializeRow(cells: LayoutCell[], headers: SourceColumnHeader[]): string {
  let primaryResultSeen = false;
  let primaryNameSeen = false;
  const pieces: string[] = [];
  for (const cell of cells) {
    const role = headers.length > 0 ? roleForCell(cell, headers) : null;
    const resultCell = role !== 'unit' && isResultCell(cell) && !looksLikeUnit(cell.text);
    const protectedColumn = role === 'reference' || role === 'history';
    // 表头只在原位置保留。这里只序列化其证明的列边界，不把“参考范围”
    // 等标签伪造为每一行的报告原文，也不把参考值当成另一份结果证据。
    const nextName = role === 'name' || role === null && !resultCell && !looksLikeUnit(cell.text)
      && /[\p{Script=Han}]{2,}|[a-z]{2,}/iu.test(cell.text);
    let boundary = protectedColumn || isRangeCell(cell.text) || resultCell && primaryResultSeen
      || headers.length > 0 && role === null && resultCell;
    if (nextName && primaryNameSeen && primaryResultSeen) {
      boundary = true;
      primaryResultSeen = false;
      primaryNameSeen = false;
    }
    if (boundary && pieces.length > 0) pieces.push('|');
    const range = /[+-]?(?:\d+(?:\.\d+)?|\.\d+)\s*(?:-|~|～|至|—|–)\s*[+-]?(?:\d+(?:\.\d+)?|\.\d+)/u.exec(cell.text);
    const inlineRangeAfterNumber = range && range.index > 0 && /\d/u.test(cell.text.slice(0, range.index));
    pieces.push(inlineRangeAfterNumber
      ? `${cell.text.slice(0, range.index).trimEnd()} | ${cell.text.slice(range.index)}` : cell.text);
    if (!protectedColumn && !isRangeCell(cell.text)) {
      if (role === 'name' || !primaryNameSeen && !resultCell && !looksLikeUnit(cell.text)) primaryNameSeen = true;
      if (resultCell) primaryResultSeen = true;
    }
  }
  return pieces.join(' ');
}

function joinWrappedNames(input: LocalVisualTextBox[]): LayoutCell[] {
  const consumed = new Set<number>();
  const combined: LayoutCell[] = [];
  for (let index = 0; index < input.length; index += 1) {
    if (consumed.has(index)) continue;
    const upper = input[index]!;
    if (!/[\p{Script=Han}]{2,}/u.test(upper.text) || isResultCell(upper)) {
      combined.push({ ...upper, sourceBoxes: [upper] });
      continue;
    }
    const matches = input.flatMap((lower, lowerIndex) => {
      if (lowerIndex === index || consumed.has(lowerIndex) || !nameContinuation(lower.text)) return [];
      const gap = upper.bounds[1] - (lower.bounds[1] + lower.bounds[3]);
      const minHeight = Math.min(upper.bounds[3], lower.bounds[3]);
      if (centerY(lower) >= centerY(upper) || gap < -minHeight * 0.15 || gap > minHeight * 0.8) return [];
      if (Math.abs(upper.bounds[0] - lower.bounds[0]) > Math.min(0.025, minHeight * 0.8)) return [];
      const minWidth = Math.min(upper.bounds[2], lower.bounds[2]);
      if (minWidth <= 0 || overlapX(upper, lower) / minWidth < 0.8) return [];
      const bounds = unionBounds([upper, lower]);
      const resultCells = input.filter((cell, cellIndex) => cellIndex !== index && cellIndex !== lowerIndex
        && cell.bounds[0] >= bounds[0] + bounds[2]
        && centerY(cell) >= bounds[1] && centerY(cell) <= bounds[1] + bounds[3]
        && isResultCell(cell));
      const labelMidpoint = (centerY(upper) + centerY(lower)) / 2;
      // 数值应位于这两行名称的中部。仅与上一名称基线对齐时，下面的短词
      // 也可能是一个空白项目，不能仅凭“在下一行”把它接到上一结果。
      if (!resultCells.some((cell) => Math.abs(centerY(cell) - labelMidpoint) <= minHeight * 0.4)) return [];
      // 可以有同一行的结果和参考值，但不能越过两行不同结果。
      if (resultCells.length === 0 || resultCells.slice(1).some((cell) => (
        !samePhysicalRow(resultCells[0]!, cell)
      ))) return [];
      const interveningLabel = input.some((cell, cellIndex) => cellIndex !== index && cellIndex !== lowerIndex
        && Math.abs(cell.bounds[0] - upper.bounds[0]) <= 0.025
        && centerY(cell) < centerY(upper) && centerY(cell) > centerY(lower));
      if (interveningLabel) return [];
      return [{ lowerIndex, lower, bounds }];
    });
    if (matches.length !== 1) {
      combined.push({ ...upper, sourceBoxes: [upper] });
      continue;
    }
    const match = matches[0]!;
    consumed.add(match.lowerIndex);
    combined.push({ text: `${upper.text.trim()}${match.lower.text.trim()}`,
      confidence: Math.min(upper.confidence, match.lower.confidence), bounds: match.bounds,
      sourceBoxes: [upper, match.lower] });
  }
  return combined;
}

/** 只凭文字框的空间关系恢复行列；不从模型候选或预期数值反推来源文字。 */
export function reconstructLocalVisualLayout(lines: LocalVisualTextBox[]): LocalVisualLayout {
  const original = lines.map((line) => ({ ...line, text: line.text.trim(), bounds: [...line.bounds] as LocalVisualTextBox['bounds'] }))
    .sort((left, right) => centerY(right) - centerY(left) || left.bounds[0] - right.bounds[0]);
  // 极密页面不进行高成本几何推断；保留每个原框，而不是丢字或猜测行绑定。
  if (original.length > 2_000) return {
    version: 'local-visual-layout-v2', quote: original.map((box) => box.text).join('\n'),
    rows: original.map((box) => ({ text: box.text, bounds: box.bounds, boxes: [box] })),
    warnings: ['local_visual_layout_not_reconstructed_within_budget']
  };
  const cells = joinWrappedNames(original).sort((left, right) => centerY(right) - centerY(left) || left.bounds[0] - right.bounds[0]);
  const grouped: LayoutCell[][] = [];
  const warnings = new Set<string>();
  const ambiguous = new Set<LayoutCell>();
  for (const cell of cells) {
    const neighbors = cells.filter((other) => other !== cell && samePhysicalRow(cell, other));
    if (neighbors.some((left, index) => neighbors.slice(index + 1).some((right) => !samePhysicalRow(left, right)))) {
      ambiguous.add(cell);
      warnings.add('local_visual_layout_ambiguous_row_binding');
    }
  }
  for (const cell of cells) {
    if (ambiguous.has(cell)) {
      grouped.push([cell]);
      continue;
    }
    const eligible = grouped.filter((row) => !row.some((other) => ambiguous.has(other))
      && row.every((other) => samePhysicalRow(cell, other)));
    if (eligible.length === 1) eligible[0]!.push(cell);
    else {
      if (eligible.length > 1) warnings.add('local_visual_layout_ambiguous_row_binding');
      grouped.push([cell]);
    }
  }
  const spatialRows = grouped.map((cellsInRow) => {
    const sorted = [...cellsInRow].sort((left, right) => left.bounds[0] - right.bounds[0]);
    const bounds = unionBounds(sorted);
    // 位置索引保留真正的原始框，而不是合并后推导出的假框。
    const boxes = sorted.flatMap((cell) => cell.sourceBoxes);
    return { cells: sorted, bounds, boxes };
  }).sort((left, right) => right.bounds[1] + right.bounds[3] / 2 - left.bounds[1] - left.bounds[3] / 2
    || left.bounds[0] - right.bounds[0]);
  let activeHeaders: SourceColumnHeader[] = [];
  const rows = spatialRows.map((row) => {
    const rowHeaders = headersInRow(row.cells);
    if (rowHeaders.length > 0) {
      activeHeaders = rowHeaders;
      warnings.add('local_visual_columns_separated_using_source_headers');
      return { text: row.cells.map((cell) => cell.text).join(' '), bounds: row.bounds, boxes: row.boxes };
    }
    // 单框段落通常是表格以外的新章节，不把上方表头无限借给后续正文。
    if (row.cells.length === 1 && row.cells[0]!.bounds[2] > 0.6 && !isResultCell(row.cells[0]!)) activeHeaders = [];
    return { text: serializeRow(row.cells, activeHeaders), bounds: row.bounds, boxes: row.boxes };
  });
  return { version: 'local-visual-layout-v2', quote: rows.map((row) => row.text).join('\n'), rows,
    warnings: [...warnings] };
}
