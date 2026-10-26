import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ExtractionResult, ObservationCandidate, ReportMetadataCandidate, SourceManifest, SourceSpan } from '@contracts';
import { WorkspaceStore, type PublishFactsInput } from '@storage';
import { directOriginalFieldsProvenDistinct, directOriginalHeadingAdditionProvesDuplicateSlot,
  directOriginalExpandedFindingProvesSourceRefinement, directOriginalAlignedSourceFramesProveSameSlot,
  diagnoseDirectOriginalObservationCandidate, evaluateDirectOriginalObservationCandidate, isDirectOriginalHeadingReferenceValid,
  projectDirectOriginalCandidateFields, projectDirectOriginalMetadataFields, normalizedDirectOriginalAbnormalFlag,
  isVerifiedDirectOriginalSourceBinding,
  resolveDirectOriginalSourceBinding, resolveDirectOriginalWholeExcerptQuote, sameDirectOriginalField,
  validateDirectOriginalExtraction } from './direct-original-validation.js';
import { candidateToReconciliationFact, createDirectOriginalSourceRefinementProof, reconcileReportFact } from './report-reconciliation.js';

function fixture() {
  const page: SourceSpan = { id: 'synthetic-page', documentId: 'synthetic-doc', spanKind: 'page', page: 1,
    blockId: 'direct-original-page:1', lineStart: null, lineEnd: null, quote: null, readability: 'clear' };
  const manifest: SourceManifest = { id: 'synthetic-manifest', sourceObjectId: 'synthetic-object', sha256: 'a'.repeat(64),
    mediaType: 'application/pdf', originalDisplayName: '合成原件.pdf', totalUnits: 1, coveredUnitIndexes: [0],
    spans: [page], normalizerVersion: 'direct-original-v1', conversionWarnings: [], createdAt: '2026-01-01T00:00:00Z' };
  const excerpt = (id: string, role: NonNullable<SourceSpan['modelEvidence']>['role'], quote: string): SourceSpan => ({
    id, documentId: page.documentId, spanKind: 'block', page: 1, blockId: `model-original-excerpt:${page.id}`,
    lineStart: null, lineEnd: null, quote, readability: 'clear', modelEvidence: { version: 1, engine: 'codex-original-reading-v1',
      modelId: 'gpt-6.1-sol', threadId: 'synthetic-thread', turnId: 'synthetic-turn', originalSha256: manifest.sha256,
      originalSourceObjectId: manifest.sourceObjectId, parentSourceSpanId: page.id, inputKind: 'image', role, clarity: 'clear' }
  });
  const finding = excerpt('synthetic-finding', 'finding', '左室合成值 <3.50E＋03 cm/s');
  const date = excerpt('synthetic-date', 'date', 'Exam performed: 04/17/2026 09:15');
  const identity = excerpt('synthetic-identity', 'identity', '合成姓名');
  manifest.spans.push(finding, date, identity);
  const evidence = [{ sourceSpanId: finding.id, quote: finding.quote }, { sourceSpanId: date.id, quote: date.quote }];
  const candidate: ObservationCandidate = { localKey: 'synthetic-candidate', originalName: '左室合成值', standardNameCandidate: null,
    value: { kind: 'numeric', rawText: '<3.50E＋03', decimal: '3500', comparator: 'lt' }, unitRaw: 'cm/s',
    referenceRangeRaw: null, reportedAbnormalFlag: null, specimen: null, method: null, bodySite: null,
    clinicalDate: '2026-04-17', evidence, sourceBinding: { headingEvidence: [], findingEvidence: [evidence[0]!] }, issues: [] };
  const metadata: ReportMetadataCandidate = { reportKind: null, title: null, organization: null, campus: null,
    department: null, reportNumber: null, examItems: [], times: [{ value: '2026-04-17', precision: 'day', role: 'examined', evidence: [evidence[1]!] }] };
  const extraction: ExtractionResult = { schemaVersion: 1, documentId: page.documentId,
    subject: { reportedName: '合成姓名', confidence: 'explicit', evidence: [{ sourceSpanId: identity.id, quote: identity.quote }] },
    reportMetadata: metadata, coveredSourceSpanIds: [page.id], candidates: [candidate] };
  const options = { personConsistent: true, overwritesUserLockedValue: false, reportMetadata: metadata };
  return { page, finding, date, identity, excerpt, manifest, candidate, metadata, extraction, options };
}

function sharedHeadingFixture(role: 'finding' | 'instruction' = 'finding') {
  const f = fixture();
  const resultQuote = f.finding.quote!;
  const headingRef = { sourceSpanId: f.finding.id, quote: '合成检查栏目' };
  f.finding.quote = `${headingRef.quote}\n${resultQuote}`;
  f.finding.modelEvidence!.role = role;
  f.candidate.sourceBinding!.headingEvidence = [headingRef];
  return { ...f, headingRef, findingRef: f.candidate.sourceBinding!.findingEvidence[0]!, resultQuote };
}

describe('协议等义表示与独立字段验收', () => {
  it('同一历史表格里的日期必须引用对应时间列，不能只因共用片段ID就认成另一日期', () => {
    const f = fixture();
    f.date.quote = '历史检查 2024-04-17 / 2026-04-17';
    f.metadata.times[0]!.evidence = [{ sourceSpanId: f.date.id, quote: '2026-04-17' }];
    f.candidate.evidence[1] = { sourceSpanId: f.date.id, quote: '2024-04-17' };
    expect(evaluateDirectOriginalObservationCandidate(f.candidate, f.manifest, f.options))
      .toMatchObject({ decision: 'reject', reasons: ['direct_original_clinical_date_source_required'] });
    f.candidate.evidence[1] = { sourceSpanId: f.date.id, quote: null };
    expect(evaluateDirectOriginalObservationCandidate(f.candidate, f.manifest, f.options).decision).toBe('reject');
    f.candidate.evidence[1] = { sourceSpanId: f.date.id, quote: '2026-04-17' };
    expect(evaluateDirectOriginalObservationCandidate(f.candidate, f.manifest, f.options).decision).not.toBe('reject');
  });
  it.each([[' ↑ ', 'high'], ['Ｌ', 'low'], ['阳性', 'positive'], ['Normal', 'normal']] as const)(
    '异常标志%s只规范协议枚举并保留原候选', (flag, expected) => {
      const f = fixture(); f.candidate.reportedAbnormalFlag = flag;
      const before = structuredClone(f.candidate);
      expect(normalizedDirectOriginalAbnormalFlag(flag)).toBe(expected);
      expect(evaluateDirectOriginalObservationCandidate(f.candidate, f.manifest, f.options))
        .toMatchObject({ decision: 'accept_with_warnings', warnings: expect.arrayContaining(['direct_original_abnormal_format_normalized']) });
      expect(f.candidate).toEqual(before);
    });

  it.each(['+', '-', '±', '++', 'normal?', '未知异常'])('不猜测异常标志%s', (flag) => {
    const f = fixture(); f.candidate.reportedAbnormalFlag = flag;
    expect(normalizedDirectOriginalAbnormalFlag(flag)).toBeUndefined();
    expect(evaluateDirectOriginalObservationCandidate(f.candidate, f.manifest, f.options).decision).toBe('reject');
  });

  it('无证明的日期隔离为字段说明，可靠结果与原始日期分别保留', () => {
    const f = fixture(); f.candidate.clinicalDate = '2026-04-18';
    const before = structuredClone(f.candidate);
    const result = projectDirectOriginalCandidateFields(f.candidate, f.manifest, f.options);
    expect(result.candidate.clinicalDate).toBeNull();
    expect(result.candidate.value).toEqual(before.value);
    expect(result.candidate.sourceBinding).toEqual(before.sourceBinding);
    expect(result.reviews).toEqual([{ fieldPath: 'clinicalDate', reasonCodes: ['direct_original_clinical_date_unverified'],
      evidence: [before.evidence[1]] }]);
    expect(f.candidate).toEqual(before);
    expect(evaluateDirectOriginalObservationCandidate(result.candidate, f.manifest, f.options).decision).toBe('accept_with_warnings');
  });

  it.each(['missing', 'uncertain-result', 'condition', 'heading', 'numeric', 'blocking'] as const)(
    '日期隔离不得顺便放过%s核心问题', (mode) => {
      const f = fixture(); f.candidate.clinicalDate = '2026-04-18';
      if (mode === 'missing') f.candidate.evidence[1]!.sourceSpanId = 'unknown-excerpt';
      if (mode === 'uncertain-result') f.finding.modelEvidence!.clarity = 'uncertain';
      if (mode === 'condition') {
        f.date.modelEvidence!.clarity = 'uncertain';
        f.candidate.clinicalContext = { version: 1, status: 'complete',
          conditions: [{ sourceSpanId: f.date.id, quote: f.date.quote! }] };
      }
      if (mode === 'heading') f.candidate.sourceBinding!.headingEvidence = [{ sourceSpanId: f.date.id, quote: f.date.quote }];
      if (mode === 'numeric' && f.candidate.value.kind === 'numeric') f.candidate.value.comparator = 'eq';
      if (mode === 'blocking') f.candidate.issues = [{ code: 'blocking_original_conflict', message: '合成冲突' }];
      const result = projectDirectOriginalCandidateFields(f.candidate, f.manifest, f.options);
      expect(result.candidate).toBe(f.candidate); expect(result.reviews).toEqual([]);
    });

  it('签发日期不冒充临床日期，仍保留签发元数据', () => {
    const f = fixture(); f.metadata.times[0]!.role = 'report_issued';
    const result = projectDirectOriginalCandidateFields(f.candidate, f.manifest, f.options);
    expect(result.candidate.clinicalDate).toBeNull();
    expect(f.metadata.times[0]!.role).toBe('report_issued');
  });

  it('坏辅助标题不带走有效机构/时间，原元数据及坏引用保留审计', () => {
    const f = fixture(); f.metadata.title = { value: '合成标题', evidence: [{ sourceSpanId: 'missing', quote: '合成标题' }] };
    f.metadata.organization = { value: '合成机构', evidence: [{ sourceSpanId: f.identity.id, quote: f.identity.quote }] };
    const before = structuredClone(f.metadata);
    const projected = projectDirectOriginalMetadataFields(f.metadata, f.manifest, f.extraction.documentId);
    expect(projected.metadata!.title).toBeNull();
    expect(projected.metadata!.organization).toEqual(before.organization);
    expect(projected.metadata!.times).toEqual(before.times);
    expect(projected.reviews).toContainEqual(expect.objectContaining({ fieldPath: 'reportMetadata.title',
      reasonCodes: ['direct_original_metadata_field_unverified', 'direct_original_evidence_mismatch'] }));
    expect(f.metadata).toEqual(before);
  });
});

function headingAdditionFixture() {
  const f = fixture(); const resultQuote = f.finding.quote!; const title = '合成检查栏目';
  f.finding.quote = `${title}\n${resultQuote}\n合成其他记录`;
  const nextFinding = f.excerpt('synthetic-next-finding', 'finding', f.finding.quote);
  nextFinding.modelEvidence!.turnId = 'synthetic-next-turn';
  const heading = f.excerpt('synthetic-added-heading', 'heading', title);
  f.manifest.spans.push(nextFinding, heading);
  const next = structuredClone(f.candidate);
  next.localKey = 'synthetic-next-candidate';
  next.evidence = [{ sourceSpanId: nextFinding.id, quote: resultQuote }, f.candidate.evidence[1]!];
  next.sourceBinding = { findingEvidence: [next.evidence[0]!], headingEvidence: [{ sourceSpanId: heading.id, quote: null }] };
  const bindings = () => ({ old: resolveDirectOriginalSourceBinding(f.candidate, f.manifest), next: resolveDirectOriginalSourceBinding(next, f.manifest) });
  const compatible = () => {
    const result = bindings();
    return result.old.status === 'resolved' && result.next.status === 'resolved'
      && directOriginalHeadingAdditionProvesDuplicateSlot(result.next.binding, result.old.binding);
  };
  return { ...f, next, nextFinding, heading, title, resultQuote, bindings, compatible };
}

function alignedSourceFrameFixture() {
  const f = fixture();
  const oldFrame = '合成左侧项目\n合成比较项 <7 U/L\n合成行结束';
  f.finding.quote = oldFrame;
  const oldHeading = f.excerpt('synthetic-aligned-old-heading', 'heading', '左侧项目');
  const nextFinding = f.excerpt('synthetic-aligned-new-finding', 'finding', `合成页首\n${oldFrame}\n合成页末`);
  const nextHeading = f.excerpt('synthetic-aligned-new-heading', 'heading', '合成左侧项目');
  f.manifest.spans.push(oldHeading, nextFinding, nextHeading);
  const oldRef = { sourceSpanId: f.finding.id, quote: '<7 U/L' };
  const nextRef = { sourceSpanId: nextFinding.id, quote: '合成比较项 <7 U/L' };
  const oldCandidate: ObservationCandidate = { ...f.candidate, originalName: '合成比较项', clinicalDate: null,
    value: { kind: 'numeric', rawText: '<7', decimal: '7', comparator: 'lt' }, unitRaw: 'U/L',
    evidence: [oldRef], sourceBinding: { headingEvidence: [{ sourceSpanId: oldHeading.id, quote: null }], findingEvidence: [oldRef] } };
  const nextCandidate: ObservationCandidate = { ...structuredClone(oldCandidate), localKey: 'synthetic-aligned-next',
    evidence: [nextRef], sourceBinding: { headingEvidence: [{ sourceSpanId: nextHeading.id, quote: null }], findingEvidence: [nextRef] } };
  const bindings = () => {
    const old = resolveDirectOriginalSourceBinding(oldCandidate, f.manifest);
    const next = resolveDirectOriginalSourceBinding(nextCandidate, f.manifest);
    expect(old.status).toBe('resolved'); expect(next.status).toBe('resolved');
    if (old.status !== 'resolved' || next.status !== 'resolved') throw new Error('SYNTHETIC_ALIGNED_BINDINGS_REQUIRED');
    return { old: old.binding, next: next.binding };
  };
  return { ...f, oldFrame, oldHeading, nextFinding, nextHeading, oldCandidate, nextCandidate, oldRef, nextRef, bindings };
}

describe('完整来源frame的共同坐标身份', () => {
  it.each([false, true])('短frame与完整frame唯一嵌套、结果和标题分别嵌套时是同一槽；排版变化=%s', (layout) => {
    const f = alignedSourceFrameFixture();
    if (layout) f.finding.quote = f.oldFrame.replace(' <7 ', '\t<７\n');
    const before = structuredClone({ manifest: f.manifest, old: f.oldCandidate, next: f.nextCandidate });
    const result = f.bindings();
    expect(result.next.directOriginalField!.headingKeys).not.toEqual(result.old.directOriginalField!.headingKeys);
    expect(directOriginalAlignedSourceFramesProveSameSlot(result.next, result.old)).toBe(true);
    expect(directOriginalAlignedSourceFramesProveSameSlot(result.old, result.next)).toBe(true);
    expect(sameDirectOriginalField(result.next, result.old)).toBe(true);
    expect(directOriginalFieldsProvenDistinct(result.next, result.old)).toBe(false);
    expect({ manifest: f.manifest, old: f.oldCandidate, next: f.nextCandidate }).toEqual(before);
  });

  it.each([false, true])('独立标题完整frame唯一对齐后可在短finding之前定位；标题frame扩展公共坐标=%s', (expandedHeading) => {
    const f = alignedSourceFrameFixture();
    f.finding.quote = '合成比较项 <7 U/L\n合成行结束';
    const headingFrame = '合成独立栏目页眉\n合成左侧项目\n合成栏目说明';
    f.nextFinding.quote = `合成页首\n${headingFrame}\n${f.finding.quote}\n合成页末`;
    f.oldHeading.quote = expandedHeading ? `合成更完整页首\n${f.nextFinding.quote}\n合成更完整页末` : headingFrame;
    f.oldCandidate.sourceBinding!.headingEvidence = [{ sourceSpanId: f.oldHeading.id, quote: '左侧项目' }];
    const result = f.bindings();
    expect(directOriginalAlignedSourceFramesProveSameSlot(result.old, result.next)).toBe(true);
    expect(directOriginalAlignedSourceFramesProveSameSlot(result.next, result.old)).toBe(true);
    expect(sameDirectOriginalField(result.next, result.old)).toBe(true);
    expect(directOriginalFieldsProvenDistinct(result.next, result.old)).toBe(false);
  });

  it.each(['changed-heading-frame', 'repeated-heading-frame', 'repeated-heading-text', 'heading-after-finding',
    'cross-parent-heading', 'incompatible-complete-frames'] as const)('独立标题的%s不能借共同短标题取得来源权限', (mode) => {
    const f = alignedSourceFrameFixture();
    f.finding.quote = '合成比较项 <7 U/L\n合成行结束';
    const headingFrame = '合成独立栏目页眉\n合成左侧项目\n合成栏目说明';
    f.oldHeading.quote = headingFrame;
    f.oldCandidate.sourceBinding!.headingEvidence = [{ sourceSpanId: f.oldHeading.id, quote: '左侧项目' }];
    f.nextFinding.quote = `合成页首\n${headingFrame}\n${f.finding.quote}\n合成页末`;
    if (mode === 'changed-heading-frame') f.oldHeading.quote = headingFrame.replace('栏目说明', '另一段说明');
    if (mode === 'repeated-heading-frame') f.nextFinding.quote += `\n${headingFrame}`;
    if (mode === 'repeated-heading-text') f.nextFinding.quote += '\n合成另一页内位置 左侧项目';
    if (mode === 'heading-after-finding') f.nextFinding.quote = `合成页首\n${f.finding.quote}\n${headingFrame}\n合成页末`;
    if (mode === 'cross-parent-heading') {
      const other = { ...f.page, id: 'synthetic-independent-heading-other-page', page: 2, blockId: 'direct-original-page:2' };
      f.manifest.totalUnits = 2; f.manifest.coveredUnitIndexes = [0, 1]; f.manifest.spans.push(other);
      f.oldHeading.page = 2; f.oldHeading.blockId = `model-original-excerpt:${other.id}`;
      f.oldHeading.modelEvidence!.parentSourceSpanId = other.id;
    }
    if (mode === 'incompatible-complete-frames') {
      f.oldHeading.quote = `合成旧完整页首\n${f.nextFinding.quote}\n合成旧完整页末`;
      f.nextHeading.quote = `合成新完整页首\n${f.nextFinding.quote}\n合成新完整页末`;
      f.nextCandidate.sourceBinding!.headingEvidence = [{ sourceSpanId: f.nextHeading.id, quote: '合成左侧项目' }];
    }
    const result = f.bindings();
    expect(directOriginalAlignedSourceFramesProveSameSlot(result.old, result.next)).toBe(false);
    expect(directOriginalAlignedSourceFramesProveSameSlot(result.next, result.old)).toBe(false);
  });

  it('位置证明不依赖医疗字段，但不授权结果、左右侧、日期或条件变更', () => {
    const f = alignedSourceFrameFixture();
    f.nextCandidate.value = { kind: 'numeric', rawText: '>8', decimal: '8', comparator: 'gt' };
    f.nextCandidate.bodySite = '合成右侧'; f.nextCandidate.clinicalDate = '2026-08-19';
    f.nextCandidate.clinicalContext = { version: 1, status: 'complete', conditions: [] };
    const result = f.bindings();
    expect(directOriginalAlignedSourceFramesProveSameSlot(result.next, result.old)).toBe(true);
    const decision = reconcileReportFact({ recordId: 'new', binding: result.next, fact: candidateToReconciliationFact(f.nextCandidate) },
      [{ recordId: 'old', binding: result.old, fact: candidateToReconciliationFact(f.oldCandidate) }]);
    expect(decision).toMatchObject({ decision: 'conflict', reasonCodes: ['same_source_finding_semantic_conflict'] });
    expect(decision.changedFields).toEqual(expect.arrayContaining(['value', 'qualifier', 'bodySite', 'clinicalDate', 'clinicalContext']));
  });

  it('完整frame相同或嵌套时，分离的年份列/行仍是不同位置，不被相同名称和值合并', () => {
    const f = alignedSourceFrameFixture();
    f.finding.quote = '合成左侧项目\n2024年 合成比较项 <7 U/L\n2025年 合成比较项 <7 U/L\n合成行结束';
    f.oldRef.quote = '2024年 合成比较项 <7 U/L';
    f.nextFinding.quote = `合成页首\n${f.finding.quote}\n合成页末`;
    f.nextRef.quote = '2025年 合成比较项 <7 U/L';
    const result = f.bindings();
    expect(directOriginalAlignedSourceFramesProveSameSlot(result.next, result.old)).toBe(false);
    expect(sameDirectOriginalField(result.next, result.old)).toBe(false);
    expect(directOriginalFieldsProvenDistinct(result.next, result.old)).toBe(true);
  });

  it.each(['repeated-frame', 'nested-but-other-heading', 'heading-outside-frame', 'overlapping-heading',
    'whole-finding', 'null-finding', 'ocr-word-change', 'digit-token-join',
    'numeric-prefix', 'different-finding-role', 'expanded-past-result', 'heading-after-result'] as const)('%s不签发来源同槽证明', (mode) => {
    const f = alignedSourceFrameFixture();
    if (mode === 'repeated-frame') {
      f.nextFinding.quote += `\n${f.oldFrame}`;
      f.nextRef.quote = `合成页首\n${f.oldFrame}`;
    }
    if (mode === 'nested-but-other-heading') {
      f.nextFinding.quote = `合成另一栏目\n${f.nextFinding.quote}`; f.nextHeading.quote = '合成另一栏目';
    }
    if (mode === 'heading-outside-frame') f.nextHeading.quote = '完整frame外的合成栏目';
    if (mode === 'overlapping-heading') f.nextHeading.quote = '合成比较项';
    if (mode === 'whole-finding') f.nextRef.quote = f.nextFinding.quote!;
    if (mode === 'null-finding') f.nextRef.quote = null as unknown as string;
    if (mode === 'ocr-word-change') f.nextFinding.quote = f.nextFinding.quote!.replace('左侧项目', '右侧项目');
    if (mode === 'digit-token-join') {
      f.finding.quote = f.oldFrame.replace('<7', '<7 1'); f.nextFinding.quote = f.nextFinding.quote!.replace('<7', '<71');
      f.oldRef.quote = '<7 1 U/L'; f.nextRef.quote = '合成比较项 <71 U/L';
    }
    if (mode === 'numeric-prefix') {
      f.finding.quote = f.oldFrame.replace('<7', '7'); f.oldRef.quote = '7';
      f.nextFinding.quote = f.nextFinding.quote!.replace('<7', '17'); f.nextRef.quote = '合成比较项 17 U/L';
    }
    if (mode === 'different-finding-role') f.nextFinding.modelEvidence!.role = 'instruction';
    if (mode === 'expanded-past-result') f.nextRef.quote += '\n合成行结束';
    if (mode === 'heading-after-result') {
      f.oldHeading.quote = '行结束'; f.nextHeading.quote = '合成行结束';
    }
    const result = f.bindings();
    expect(directOriginalAlignedSourceFramesProveSameSlot(result.next, result.old)).toBe(false);
    if (mode === 'repeated-frame' || mode === 'nested-but-other-heading' || mode === 'heading-outside-frame') {
      expect(directOriginalFieldsProvenDistinct(result.next, result.old)).toBe(false);
    }
  });

  it('缺少任一真实栏目、不同原页和伪造绑定都不能提供共同坐标权限', () => {
    const noHeading = alignedSourceFrameFixture(); noHeading.oldCandidate.sourceBinding!.headingEvidence = [];
    const missing = noHeading.bindings();
    expect(directOriginalAlignedSourceFramesProveSameSlot(missing.next, missing.old)).toBe(false);
    const f = alignedSourceFrameFixture(); const result = f.bindings();
    expect(directOriginalAlignedSourceFramesProveSameSlot(result.next, structuredClone(result.old))).toBe(false);
    result.old.directOriginalField!.headingKeys.push('synthetic-forged-heading');
    expect(directOriginalAlignedSourceFramesProveSameSlot(result.next, result.old)).toBe(false);
    const page = alignedSourceFrameFixture();
    const other = { ...page.page, id: 'synthetic-other-parent', page: 2, blockId: 'direct-original-page:2' };
    page.manifest.totalUnits = 2; page.manifest.coveredUnitIndexes = [0, 1]; page.manifest.spans.push(other);
    for (const span of [page.nextFinding, page.nextHeading]) {
      span.page = 2; span.blockId = `model-original-excerpt:${other.id}`; span.modelEvidence!.parentSourceSpanId = other.id;
    }
    const crossPage = page.bindings();
    expect(directOriginalAlignedSourceFramesProveSameSlot(crossPage.next, crossPage.old)).toBe(false);
    expect(sameDirectOriginalField(crossPage.next, crossPage.old)).toBe(false);
  });

  it('来源位置证明不读展示名，同槽第三条改名也必须进入整组竞争审查而非宣称不同位置', () => {
    const f = alignedSourceFrameFixture();
    f.nextCandidate.originalName = '合成另一个展示名称';
    const result = f.bindings();
    expect(directOriginalAlignedSourceFramesProveSameSlot(result.next, result.old)).toBe(true);
    expect(sameDirectOriginalField(result.next, result.old)).toBe(false);
    expect(directOriginalFieldsProvenDistinct(result.next, result.old)).toBe(false);
    expect(reconcileReportFact({ recordId: 'new', binding: result.next, fact: candidateToReconciliationFact(f.nextCandidate) },
      [{ recordId: 'old', binding: result.old, fact: candidateToReconciliationFact(f.oldCandidate) }])).toMatchObject({
      decision: 'unresolved', reasonCodes: ['source_binding_requires_unique_mapping'] });
  });

  it('同一短frame可映射两个新来源时不选择其中一条', () => {
    const f = alignedSourceFrameFixture();
    const extra = f.excerpt('synthetic-aligned-second-frame', 'finding', `合成其他页内语境\n${f.oldFrame}\n合成结束`);
    f.manifest.spans.push(extra);
    f.nextCandidate.sourceBinding!.findingEvidence.push({ sourceSpanId: extra.id, quote: f.nextRef.quote });
    const result = f.bindings();
    expect(directOriginalAlignedSourceFramesProveSameSlot(result.next, result.old)).toBe(false);
  });

  it('两组多frame形成多对一链时不能靠遍历顺序凑出双向唯一匹配', () => {
    const f = alignedSourceFrameFixture();
    const oldExtra = f.excerpt('synthetic-aligned-old-extra', 'finding', `合成旧前文\n${f.oldFrame}\n合成旧后文`);
    f.nextFinding.quote = `合成新前文\n${oldExtra.quote}\n合成新后文`;
    const newExtra = f.excerpt('synthetic-aligned-new-extra', 'finding', `合成另一前文\n${f.nextFinding.quote}\n合成另一后文`);
    f.manifest.spans.push(oldExtra, newExtra);
    f.oldCandidate.sourceBinding!.findingEvidence.push({ sourceSpanId: oldExtra.id, quote: f.oldRef.quote });
    f.nextCandidate.sourceBinding!.findingEvidence.push({ sourceSpanId: newExtra.id, quote: f.nextRef.quote });
    const result = f.bindings();
    expect(directOriginalAlignedSourceFramesProveSameSlot(result.next, result.old)).toBe(false);
    expect(directOriginalAlignedSourceFramesProveSameSlot(result.old, result.next)).toBe(false);
  });
});

describe('来源连续匹配与真实栏目作用域', () => {
  function scopedFixture() {
    const f = fixture();
    const titles = ['合成检查甲栏目', '合成检查乙栏目'];
    const headings = titles.map((title, index) => f.excerpt(`synthetic-scope-heading-${index}`, 'heading', title));
    f.manifest.spans.push(...headings);
    f.finding.quote = `${titles[0]}\n合成结果：未见异常\n${titles[1]}\n合成结果：未见异常`;
    const candidates = headings.map((heading, index): ObservationCandidate => ({ ...structuredClone(f.candidate),
      localKey: `synthetic-scope-candidate-${index}`, originalName: '合成检查小结', clinicalDate: null,
      value: { kind: 'text', rawText: '未见异常' },
      evidence: [{ sourceSpanId: f.finding.id, quote: '未见异常' }], sourceBinding: {
        headingEvidence: [{ sourceSpanId: heading.id, quote: null }],
        findingEvidence: [{ sourceSpanId: f.finding.id, quote: '未见异常' }] } }));
    return { ...f, titles, headings, candidates };
  }

  it.each(['independent-heading', 'narrow-shared-heading'] as const)(
    '%s用真实栏目区分同段两个相同结论，不改原文或借候选值选occurrence', (mode) => {
      const f = scopedFixture();
      if (mode === 'narrow-shared-heading') f.candidates.forEach((candidate, index) => {
        candidate.sourceBinding!.headingEvidence = [{ sourceSpanId: f.finding.id, quote: f.titles[index]! }];
      });
      const before = structuredClone({ candidates: f.candidates, manifest: f.manifest });
      const bindings = f.candidates.map((candidate) => {
        expect(evaluateDirectOriginalObservationCandidate(candidate, f.manifest, f.options).decision).not.toBe('reject');
        return resolveDirectOriginalSourceBinding(candidate, f.manifest);
      });
      if (bindings[0]!.status !== 'resolved' || bindings[1]!.status !== 'resolved') throw new Error('SYNTHETIC_SCOPED_BINDINGS_REQUIRED');
      expect(bindings[0]!.binding.units[0]!.segmentStart).toBe(f.finding.quote!.indexOf('未见异常'));
      expect(bindings[1]!.binding.units[0]!.segmentStart).toBe(f.finding.quote!.lastIndexOf('未见异常'));
      expect(directOriginalFieldsProvenDistinct(bindings[0]!.binding, bindings[1]!.binding)).toBe(true);
      expect({ candidates: f.candidates, manifest: f.manifest }).toEqual(before);
    });

  it.each(['invented-heading', 'repeated-heading', 'unbounded-section', 'heading-after-results', 'same-section-repeat'] as const)(
    '%s不能用任意位置的栏目文本放行重复结论', (mode) => {
      const f = scopedFixture(); const candidate = f.candidates[0]!;
      if (mode === 'invented-heading') f.headings[0]!.quote = '原件不存在的合成栏目';
      if (mode === 'repeated-heading') f.finding.quote += `\n${f.titles[0]}\n合成结果：未见异常`;
      if (mode === 'unbounded-section') f.manifest.spans = f.manifest.spans.filter((span) => span.id !== f.headings[1]!.id);
      if (mode === 'heading-after-results') f.finding.quote = `合成结果：未见异常\n合成结果：未见异常\n${f.titles[0]}`;
      if (mode === 'same-section-repeat') f.finding.quote = f.finding.quote!.replace(f.titles[1]!, `合成结果：未见异常\n${f.titles[1]}`);
      expect(resolveDirectOriginalSourceBinding(candidate, f.manifest)).toMatchObject({ status: 'unresolved' });
    });

  it.each(['date', 'identity'] as const)('真实文本也不能将%s角色改作栏目或结果', (role) => {
    const f = scopedFixture(); f.headings[0]!.modelEvidence!.role = role;
    expect(evaluateDirectOriginalObservationCandidate(f.candidates[0]!, f.manifest, f.options)).toMatchObject({
      decision: 'reject', reasons: expect.arrayContaining(['direct_original_evidence_role_mismatch']) });
    expect(resolveDirectOriginalSourceBinding(f.candidates[0]!, f.manifest).status).toBe('unresolved');
  });

  it.each(['partial-finding', 'uncertain-heading', 'foreign-heading'] as const)('%s不能建立重复结果的可信栏目范围', (mode) => {
    const f = scopedFixture();
    if (mode === 'partial-finding') f.finding.readability = 'partial';
    if (mode === 'uncertain-heading') f.headings[0]!.modelEvidence!.clarity = 'uncertain';
    if (mode === 'foreign-heading') f.headings[0]!.modelEvidence!.originalSourceObjectId = 'synthetic-foreign-object';
    expect(resolveDirectOriginalSourceBinding(f.candidates[0]!, f.manifest).status).toBe('unresolved');
  });

  it('保留token边界后，跨格7 1不再冒充71或制造第二个71，171也不是71的窄来源', () => {
    const f = fixture(); f.finding.quote = '合成表格：7\t1\n合成其他值：171 71.5 -71 +71\n合成实际值：71';
    const ref = { sourceSpanId: f.finding.id, quote: '71' };
    f.candidate = { ...f.candidate, clinicalDate: null, value: { kind: 'numeric', rawText: '71', decimal: '71', comparator: 'eq' },
      evidence: [ref], sourceBinding: { headingEvidence: [], findingEvidence: [ref] } };
    const binding = resolveDirectOriginalSourceBinding(f.candidate, f.manifest);
    expect(binding.status).toBe('resolved');
    if (binding.status === 'resolved') expect(binding.binding.units[0]).toMatchObject({
      segmentStart: f.finding.quote.lastIndexOf('71'), segmentEnd: f.finding.quote.length });
    f.finding.quote = '合成甲格：71\n合成乙格：71';
    expect(resolveDirectOriginalSourceBinding(f.candidate, f.manifest)).toEqual({
      status: 'unresolved', reason: 'direct_original_finding_quote_not_unique' });
    f.finding.quote = '合成表格：7\t1';
    expect(evaluateDirectOriginalObservationCandidate(f.candidate, f.manifest, f.options)).toMatchObject({
      decision: 'reject', reasons: expect.arrayContaining(['direct_original_reference_changed']) });
    expect(resolveDirectOriginalSourceBinding(f.candidate, f.manifest).status).toBe('unresolved');
  });

  it('只折叠连续空白，真实引用中的数值、单位和日期仍按连续token保留', () => {
    const f = fixture(); f.finding.quote = '合成项目\t<71.5\nmm  2026-04-17';
    const ref = { sourceSpanId: f.finding.id, quote: '合成项目 <71.5 mm 2026-04-17' };
    f.candidate = { ...f.candidate, clinicalDate: null, evidence: [ref],
      sourceBinding: { headingEvidence: [], findingEvidence: [ref] } };
    expect(evaluateDirectOriginalObservationCandidate(f.candidate, f.manifest, f.options).decision).not.toBe('reject');
    expect(resolveDirectOriginalSourceBinding(f.candidate, f.manifest).status).toBe('resolved');
  });

  it.each(['右侧', '见异常', '>71.5', '715', 'cm', '2026-04-18'])(
    '引用不得改写侧别、否定、比较符、数值、单位或日期：%s', (replacement) => {
      const f = fixture(); f.finding.quote = '左侧 未见异常；测量 <71.5 mm；日期 2026-04-17';
      const originals = ['左侧', '未见异常', '<71.5', '71.5', 'mm', '2026-04-17'];
      const replacements = ['右侧', '见异常', '>71.5', '715', 'cm', '2026-04-18'];
      const quote = f.finding.quote.replace(originals[replacements.indexOf(replacement)]!, replacement);
      const ref = { sourceSpanId: f.finding.id, quote };
      f.candidate = { ...f.candidate, clinicalDate: null, evidence: [ref],
        sourceBinding: { headingEvidence: [], findingEvidence: [ref] } };
      expect(evaluateDirectOriginalObservationCandidate(f.candidate, f.manifest, f.options)).toMatchObject({
        decision: 'reject', reasons: expect.arrayContaining(['direct_original_reference_changed']) });
    });

  it('跨页指令不能凭短尾数值定位，完整连续行引用则可直接定位原页', () => {
    const f = scopedFixture(); const page = { ...f.page, id: 'synthetic-scope-page-2', page: 2, blockId: 'direct-original-page:2' };
    f.manifest.totalUnits = 2; f.manifest.coveredUnitIndexes = [0, 1]; f.manifest.spans.push(page);
    f.finding.page = 2; f.finding.blockId = `model-original-excerpt:${page.id}`;
    f.finding.modelEvidence!.parentSourceSpanId = page.id; f.finding.modelEvidence!.role = 'instruction';
    f.finding.quote = '合成第一行 2025年 71 mm\n合成第二行 2026年 71 mm';
    const candidate = f.candidates[0]!; candidate.value = { kind: 'text', rawText: '71 mm' };
    candidate.evidence[0]!.quote = '71'; candidate.sourceBinding!.findingEvidence[0]!.quote = '71';
    expect(resolveDirectOriginalSourceBinding(candidate, f.manifest)).toMatchObject({ status: 'unresolved' });
    candidate.evidence[0]!.quote = '合成第二行 2026年 71 mm';
    candidate.sourceBinding!.findingEvidence[0]!.quote = candidate.evidence[0]!.quote;
    const binding = resolveDirectOriginalSourceBinding(candidate, f.manifest);
    expect(binding.status).toBe('resolved');
    if (binding.status === 'resolved') expect(binding.binding.units[0]).toMatchObject({
      page: 2, segmentStart: f.finding.quote.indexOf('合成第二行'), segmentEnd: f.finding.quote.length });
  });
});

describe('原件候选结构化来源诊断', () => {
  it.each(['finding', 'instruction'] as const)('正常%s及同摘录窄标题不产生诊断，也不改变原件、候选或接纳决定', (role) => {
    const f = sharedHeadingFixture(role);
    const before = structuredClone({ candidate: f.candidate, manifest: f.manifest, options: f.options });
    const outcome = evaluateDirectOriginalObservationCandidate(f.candidate, f.manifest, f.options);
    expect(diagnoseDirectOriginalObservationCandidate(f.candidate, f.manifest, f.options)).toEqual([]);
    expect(evaluateDirectOriginalObservationCandidate(f.candidate, f.manifest, f.options)).toEqual(outcome);
    expect({ candidate: f.candidate, manifest: f.manifest, options: f.options }).toEqual(before);
  });

  it.each(['date', 'identity', 'heading', 'context'] as const)('findingEvidence的%s角色失败定位到本候选具体引用，不重抄正文', (role) => {
    const f = fixture(); f.finding.modelEvidence!.role = role;
    const result = diagnoseDirectOriginalObservationCandidate(f.candidate, f.manifest, f.options);
    expect(result).toContainEqual(expect.objectContaining({ targetId: f.candidate.localKey,
      reasonCode: 'direct_original_evidence_role_mismatch', fieldPath: 'sourceBinding.findingEvidence[0]',
      sourceSpanId: f.finding.id, actualRole: role, allowedRoles: ['finding', 'instruction'] }));
    const serialized = JSON.stringify(result);
    for (const text of [f.finding.quote!, f.candidate.originalName, f.candidate.value.rawText!]) expect(serialized).not.toContain(text);
    expect(new Set(result.map((diagnostic) => diagnostic.reasonCode))).toEqual(
      new Set((evaluateDirectOriginalObservationCandidate(f.candidate, f.manifest, f.options) as { reasons: string[] }).reasons));
  });

  it.each(['date', 'identity'] as const)('headingEvidence的%s角色失败保留标题职责，不将它解释为结果', (role) => {
    const f = fixture();
    const heading = f.excerpt('synthetic-heading-diagnostic', role, '仅为合成测试的栏目'); f.manifest.spans.push(heading);
    f.candidate.sourceBinding!.headingEvidence = [{ sourceSpanId: heading.id, quote: null }];
    expect(diagnoseDirectOriginalObservationCandidate(f.candidate, f.manifest, f.options))
      .toContainEqual(expect.objectContaining({ reasonCode: 'direct_original_evidence_role_mismatch',
        fieldPath: 'sourceBinding.headingEvidence[0]', sourceSpanId: heading.id, actualRole: role,
        allowedRoles: ['heading', 'context'] }));
  });

  it.each(['other-excerpt', 'overlap', 'whole-finding'] as const)('窄标题%s失败给出同候选同摘录及不重叠约束，而不是泛角色放行', (mode) => {
    const f = sharedHeadingFixture();
    if (mode === 'other-excerpt') {
      const other = f.excerpt('synthetic-other-heading-source', 'finding', f.finding.quote!); f.manifest.spans.push(other);
      f.headingRef.sourceSpanId = other.id;
    }
    if (mode === 'overlap') f.headingRef.quote = f.resultQuote;
    if (mode === 'whole-finding') f.findingRef.quote = f.finding.quote;
    const diagnostic = diagnoseDirectOriginalObservationCandidate(f.candidate, f.manifest, f.options)
      .find((item) => item.fieldPath === 'sourceBinding.headingEvidence[0]'
        && item.reasonCode === 'direct_original_evidence_role_mismatch')!;
    expect(diagnostic).toMatchObject({ targetId: f.candidate.localKey, actualRole: 'finding' });
    expect(diagnostic).not.toHaveProperty('allowedRoles');
    for (const requirement of ['本候选', '同一摘录', '唯一', '非整段', '任何一个结果范围重叠', '其他候选或其他摘录']) {
      expect(diagnostic.constraint).toContain(requirement);
    }
  });

  it.each(['wrong-file', 'changed-quote', 'missing-source', 'uncertain'] as const)('%s 使用同一证据校验准确定位 evidence[i]', (mode) => {
    const f = fixture();
    if (mode === 'wrong-file') f.finding.modelEvidence!.originalSourceObjectId = 'synthetic-another-object';
    if (mode === 'changed-quote') f.candidate.evidence[0]!.quote = '没有出现在所引摘录中的合成文字';
    if (mode === 'missing-source') f.candidate.evidence[0]!.sourceSpanId = 'synthetic-missing-source';
    if (mode === 'uncertain') f.finding.modelEvidence!.clarity = 'uncertain';
    const reasonCode = mode === 'changed-quote' ? 'direct_original_reference_changed'
      : mode === 'uncertain' ? 'direct_original_evidence_uncertain' : 'direct_original_evidence_mismatch';
    expect(diagnoseDirectOriginalObservationCandidate(f.candidate, f.manifest, f.options))
      .toContainEqual(expect.objectContaining({ targetId: f.candidate.localKey, reasonCode,
        fieldPath: 'evidence[0]', sourceSpanId: f.candidate.evidence[0]!.sourceSpanId }));
  });

  it.each(['heading', 'identity'] as const)('解释条件的%s角色失败定位到 conditions 原下标，不与标题或结果混为一谈', (role) => {
    const f = fixture(); const condition = f.excerpt('synthetic-condition-diagnostic', role, '合成检查条件');
    f.manifest.spans.push(condition);
    f.candidate.clinicalContext = { version: 1, status: 'complete', conditions: [
      { sourceSpanId: f.date.id, quote: f.date.quote! }, { sourceSpanId: condition.id, quote: condition.quote! }
    ] };
    expect(diagnoseDirectOriginalObservationCandidate(f.candidate, f.manifest, f.options))
      .toContainEqual(expect.objectContaining({ reasonCode: 'direct_original_evidence_role_mismatch',
        fieldPath: 'clinicalContext.conditions[1]', sourceSpanId: condition.id, actualRole: role,
        allowedRoles: ['finding', 'context', 'instruction', 'date'] }));
  });

  it('数值、日期、未知值及阻断事项按原门禁返回各自字段，不把未执行的后续校验冒充新失败', () => {
    const f = fixture();
    f.candidate.value = { kind: 'numeric', rawText: '<8', decimal: '9', comparator: 'eq' };
    f.candidate.clinicalDate = '2026-05-03';
    const result = diagnoseDirectOriginalObservationCandidate(f.candidate, f.manifest, f.options);
    expect(result).toContainEqual(expect.objectContaining({ reasonCode: 'direct_original_numeric_representation_conflict', fieldPath: 'value' }));
    expect(result).toContainEqual(expect.objectContaining({ reasonCode: 'direct_original_clinical_date_source_required', fieldPath: 'clinicalDate' }));
    f.candidate.value = { kind: 'unknown', rawText: null, reason: 'original_blank' };
    expect(diagnoseDirectOriginalObservationCandidate(f.candidate, f.manifest, f.options)).toEqual([
      expect.objectContaining({ reasonCode: 'value_unknown', fieldPath: 'value.kind' })
    ]);
    const good = fixture(); good.candidate.issues = [{ code: 'blocking_synthetic', message: '合成阻断正文不应复制' }];
    const blocked = diagnoseDirectOriginalObservationCandidate(good.candidate, good.manifest, good.options);
    expect(blocked).toEqual([expect.objectContaining({ reasonCode: 'blocking_synthetic', fieldPath: 'issues[0].code' })]);
    expect(JSON.stringify(blocked)).not.toContain(good.candidate.issues[0]!.message);
  });
});

describe('仅判重的可信窄槽栏目补齐证明', () => {
  it.each([null, '合成检查栏目'])('独立可信heading的引用 %j 可定位共同全文中的独立窄标题，不扩大通用字段身份', (quote) => {
    const f = headingAdditionFixture(); f.next.sourceBinding!.headingEvidence[0]!.quote = quote;
    const before = structuredClone({ old: f.candidate, next: f.next, source: f.manifest });
    const result = f.bindings();
    if (result.old.status !== 'resolved' || result.next.status !== 'resolved') throw new Error('SYNTHETIC_BINDINGS_REQUIRED');
    expect(sameDirectOriginalField(result.next.binding, result.old.binding)).toBe(false);
    expect(directOriginalFieldsProvenDistinct(result.next.binding, result.old.binding)).toBe(false);
    expect(directOriginalHeadingAdditionProvesDuplicateSlot(result.next.binding, result.old.binding)).toBe(true);
    expect(directOriginalHeadingAdditionProvesDuplicateSlot(result.old.binding, result.next.binding)).toBe(false);
    expect({ old: f.candidate, next: f.next, source: f.manifest }).toEqual(before);
  });

  it.each(['heading-outside', 'heading-repeat', 'heading-overlap', 'heading-full-result', 'heading-blank', 'heading-missing',
    'heading-context-null', 'finding-null', 'finding-whole', 'finding-repeat', 'finding-duplicate', 'changed-full-frame',
    'old-heading-present', 'implicit-new-heading', 'renamed-field'] as const)('%s不提供新判重权限，不能按同名同值代替硬来源证明', (kind) => {
    const f = headingAdditionFixture();
    if (kind === 'heading-outside') f.heading.quote = '共同全文中没有这个合成标题';
    if (kind === 'heading-repeat') { f.finding.quote += `\n${f.title}`; f.nextFinding.quote = f.finding.quote; }
    if (kind === 'heading-overlap') f.heading.quote = f.resultQuote.slice(0, 6);
    if (kind === 'heading-full-result') f.heading.quote = f.finding.quote;
    if (kind === 'heading-blank') f.heading.quote = '  ';
    if (kind === 'heading-missing') f.next.sourceBinding!.headingEvidence[0]!.sourceSpanId = 'no-such-source';
    if (kind === 'heading-context-null') f.heading.modelEvidence!.role = 'context';
    if (kind === 'finding-null' || kind === 'finding-whole') {
      f.candidate.sourceBinding!.findingEvidence[0]!.quote = kind === 'finding-null' ? null : f.finding.quote;
      f.next.sourceBinding!.findingEvidence[0]!.quote = kind === 'finding-null' ? null : f.nextFinding.quote;
    }
    if (kind === 'finding-repeat') { f.finding.quote += `\n${f.resultQuote}`; f.nextFinding.quote = f.finding.quote; }
    if (kind === 'finding-duplicate') f.next.sourceBinding!.findingEvidence.push({ ...f.next.sourceBinding!.findingEvidence[0]! });
    if (kind === 'changed-full-frame') f.nextFinding.quote += '\n新的一句不能证明完整frame相同';
    if (kind === 'old-heading-present') f.candidate.sourceBinding!.headingEvidence = [{ sourceSpanId: f.heading.id, quote: f.title }];
    if (kind === 'implicit-new-heading') { f.next.evidence.push(f.next.sourceBinding!.headingEvidence[0]!); delete f.next.sourceBinding; }
    if (kind === 'renamed-field') f.next.originalName = '另一个合成项目';
    expect(f.compatible()).toBe(false);
  });

  it.each(['hash', 'object', 'uncertain', 'partial', 'foreign-document', 'other-parent', 'duplicate-source-id', 'uncovered',
    'finding-partial', 'finding-uncertain', 'finding-missing-parent'] as const)(
    '标题来源%s不成立时拒绝，不能凭找到相同文本借用另一份出处', (kind) => {
      const f = headingAdditionFixture();
      if (kind === 'hash') f.heading.modelEvidence!.originalSha256 = 'b'.repeat(64);
      if (kind === 'object') f.heading.modelEvidence!.originalSourceObjectId = 'foreign-object';
      if (kind === 'uncertain') f.heading.modelEvidence!.clarity = 'uncertain';
      if (kind === 'partial') f.heading.readability = 'partial';
      if (kind === 'foreign-document') f.heading.documentId = 'foreign-doc';
      if (kind === 'other-parent') {
        f.manifest.totalUnits = 2; f.manifest.coveredUnitIndexes = [0, 1];
        f.manifest.spans.push({ ...f.page, id: 'synthetic-page-2', page: 2, blockId: 'direct-original-page:2' });
        f.heading.page = 2; f.heading.blockId = 'model-original-excerpt:synthetic-page-2';
        f.heading.modelEvidence!.parentSourceSpanId = 'synthetic-page-2';
      }
      if (kind === 'duplicate-source-id') f.manifest.spans.push({ ...f.heading });
      if (kind === 'uncovered') f.manifest.coveredUnitIndexes = [];
      if (kind === 'finding-partial') f.nextFinding.readability = 'partial';
      if (kind === 'finding-uncertain') f.nextFinding.modelEvidence!.clarity = 'uncertain';
      if (kind === 'finding-missing-parent') f.nextFinding.modelEvidence!.parentSourceSpanId = 'no-such-parent';
      expect(f.compatible()).toBe(false);
    });

  it('每个新增标题都须完整证明，不能挑一个有效标题掩盖其他外部引用', () => {
    const f = headingAdditionFixture(); const outside = f.excerpt('synthetic-outside-heading', 'heading', '全文外部栏目');
    f.manifest.spans.push(outside); f.next.sourceBinding!.headingEvidence.push({ sourceSpanId: outside.id, quote: null });
    expect(f.compatible()).toBe(false);
  });

  it.each(['sourceObjectId', 'sha256', 'documentId'] as const)('另一份已验证%s来源即使有相同原句和窄位置也不能借用证明', (kind) => {
    const f = headingAdditionFixture(); const old = resolveDirectOriginalSourceBinding(f.candidate, f.manifest);
    if (old.status !== 'resolved') throw new Error('SYNTHETIC_OLD_BINDING_REQUIRED');
    if (kind === 'sourceObjectId') {
      f.manifest.sourceObjectId = 'another-original-object';
      for (const span of f.manifest.spans) if (span.modelEvidence) span.modelEvidence.originalSourceObjectId = f.manifest.sourceObjectId;
    }
    if (kind === 'sha256') {
      f.manifest.sha256 = 'b'.repeat(64);
      for (const span of f.manifest.spans) if (span.modelEvidence) span.modelEvidence.originalSha256 = f.manifest.sha256;
    }
    if (kind === 'documentId') for (const span of f.manifest.spans) span.documentId = 'another-document';
    const next = resolveDirectOriginalSourceBinding(f.next, f.manifest);
    expect(next.status).toBe('resolved');
    if (next.status !== 'resolved') throw new Error('SYNTHETIC_NEXT_BINDING_REQUIRED');
    expect(directOriginalHeadingAdditionProvesDuplicateSlot(next.binding, old.binding)).toBe(false);
  });

  it('克隆、保存JSON或改过binding不能继承WeakMap来源证明', () => {
    const f = headingAdditionFixture(); const result = f.bindings();
    if (result.old.status !== 'resolved' || result.next.status !== 'resolved') throw new Error('SYNTHETIC_BINDINGS_REQUIRED');
    expect(directOriginalHeadingAdditionProvesDuplicateSlot(structuredClone(result.next.binding), result.old.binding)).toBe(false);
    expect(directOriginalHeadingAdditionProvesDuplicateSlot(result.next.binding, JSON.parse(JSON.stringify(result.old.binding)))).toBe(false);
    result.next.binding.directOriginalField!.headingKeys.push('forged-heading');
    expect(directOriginalHeadingAdditionProvesDuplicateSlot(result.next.binding, result.old.binding)).toBe(false);
  });
});

describe('显式映射的扩大摘录来源证明', () => {
  const expanded = () => {
    const f = headingAdditionFixture();
    // 旧版本只保存结果短摘录，新版本从同原件读取完整栏目语境。
    f.finding.quote = f.resultQuote;
    const compatible = () => {
      const result = f.bindings();
      return result.old.status === 'resolved' && result.next.status === 'resolved'
        && directOriginalExpandedFindingProvesSourceRefinement(result.next.binding, result.old.binding);
    };
    return { ...f, compatible };
  };

  it('旧整段短引用在新显式窄finding同原页唯一，允许专用映射但不改变默认判重身份', () => {
    const f = expanded(); const before = structuredClone({ old: f.candidate, next: f.next, manifest: f.manifest });
    const result = f.bindings();
    if (result.old.status !== 'resolved' || result.next.status !== 'resolved') throw new Error('SYNTHETIC_BINDINGS_REQUIRED');
    expect(directOriginalHeadingAdditionProvesDuplicateSlot(result.next.binding, result.old.binding)).toBe(false);
    expect(sameDirectOriginalField(result.next.binding, result.old.binding)).toBe(false);
    expect(directOriginalExpandedFindingProvesSourceRefinement(result.next.binding, result.old.binding)).toBe(true);
    expect({ old: f.candidate, next: f.next, manifest: f.manifest }).toEqual(before);
  });

  it.each(['whole-quote', 'whole-null', 'ambiguous-short-quote'] as const)(
    '旧两栏目大frame的%s不能凭新独立栏目猜旧归属或退回新增，两个新来源自身仍有效', (mode) => {
      const f = fixture(); const titles = ['合成栏目甲', '合成栏目乙']; const result = '未见异常';
      f.finding.quote = `${titles[0]}\n${result}\n${titles[1]}\n${result}`;
      const oldRef = { sourceSpanId: f.finding.id,
        quote: mode === 'whole-null' ? null : mode === 'whole-quote' ? f.finding.quote : result };
      const oldCandidate: ObservationCandidate = { ...f.candidate, clinicalDate: null, originalName: '合成检查小结',
        value: { kind: 'text', rawText: result }, evidence: [oldRef],
        sourceBinding: { headingEvidence: [], findingEvidence: [oldRef] } };
      const old = resolveDirectOriginalSourceBinding(oldCandidate, f.manifest);
      expect(old.status).toBe(mode === 'ambiguous-short-quote' ? 'unresolved' : 'resolved');
      const previous = { recordId: 'synthetic-old-ambiguous-row', fact: candidateToReconciliationFact(oldCandidate),
        binding: old.status === 'resolved' ? old.binding : null };
      const incoming = titles.map((title, index) => {
        const heading = f.excerpt(`synthetic-separated-heading-${index}`, 'heading', title);
        const frame = f.excerpt(`synthetic-separated-frame-${index}`, 'finding', `${title}\n${result}`);
        frame.modelEvidence!.turnId = 'synthetic-independent-reading'; f.manifest.spans.push(heading, frame);
        const ref = { sourceSpanId: frame.id, quote: result };
        const candidate: ObservationCandidate = { ...oldCandidate, localKey: `synthetic-separated-candidate-${index}`,
          evidence: [ref], sourceBinding: { headingEvidence: [{ sourceSpanId: heading.id, quote: null }], findingEvidence: [ref] } };
        const resolution = resolveDirectOriginalSourceBinding(candidate, f.manifest);
        if (resolution.status !== 'resolved') throw new Error('SYNTHETIC_SEPARATED_BINDING_REQUIRED');
        const bound = { recordId: `synthetic-separated-incoming-${index}`, fact: candidateToReconciliationFact(candidate), binding: resolution.binding };
        if (previous.binding) {
          expect(directOriginalHeadingAdditionProvesDuplicateSlot(bound.binding, previous.binding)).toBe(false);
          expect(directOriginalExpandedFindingProvesSourceRefinement(bound.binding, previous.binding)).toBe(false);
        }
        expect(createDirectOriginalSourceRefinementProof(bound, previous)).toBeNull();
        expect(reconcileReportFact(bound, [previous], { canRefineSourceBinding: () => true })).toMatchObject({
          decision: 'unresolved', reasonCodes: ['source_binding_requires_unique_mapping'] });
        expect(reconcileReportFact(bound, [])).toMatchObject({ decision: 'addition' });
        return bound;
      });
      expect(directOriginalFieldsProvenDistinct(incoming[0]!.binding, incoming[1]!.binding)).toBe(true);
    });

  it.each(['result-repeated', 'heading-repeated', 'new-whole', 'new-null', 'old-null',
    'heading-is-context', 'heading-overlap', 'old-heading', 'old-other-quote', 'new-other-parent'] as const)(
    '%s不能借显式映射猜测旧记录和新字段对应', (mode) => {
      const f = expanded();
      if (mode === 'result-repeated') f.nextFinding.quote += `\n${f.resultQuote}`;
      if (mode === 'heading-repeated') f.nextFinding.quote += `\n${f.title}`;
      if (mode === 'new-whole') f.next.sourceBinding!.findingEvidence[0]!.quote = f.nextFinding.quote;
      if (mode === 'new-null') f.next.sourceBinding!.findingEvidence[0]!.quote = null;
      if (mode === 'old-null') f.candidate.sourceBinding!.findingEvidence[0]!.quote = null;
      if (mode === 'heading-is-context') f.heading.modelEvidence!.role = 'context';
      if (mode === 'heading-overlap') f.heading.quote = f.resultQuote;
      if (mode === 'old-heading') f.candidate.sourceBinding!.headingEvidence = [{ sourceSpanId: f.heading.id, quote: f.title }];
      if (mode === 'old-other-quote') {
        f.finding.quote = '合成同值但另一处的原始结果';
        f.candidate.evidence[0]!.quote = f.finding.quote;
      }
      if (mode === 'new-other-parent') {
        const page = { ...f.page, id: 'synthetic-page-other', page: 2, blockId: 'direct-original-page:2' };
        f.manifest.totalUnits = 2; f.manifest.coveredUnitIndexes = [0, 1]; f.manifest.spans.push(page);
        f.nextFinding.page = 2; f.nextFinding.blockId = `model-original-excerpt:${page.id}`;
        f.nextFinding.modelEvidence!.parentSourceSpanId = page.id;
      }
      expect(f.compatible()).toBe(false);
    });

  it.each(['old-general-primary', 'old-explicit', 'new-explicit', 'same-frame-new-source'] as const)(
    '%s完全相同的原页全文与引用位置只算一个槽，证据与历史保持原样', (mode) => {
      const f = expanded();
      if (mode === 'old-general-primary') {
        const old = f.candidate.evidence[0]!;
        f.candidate.evidence.push({ ...old, sourceRole: 'primary' });
        delete f.candidate.sourceBinding;
      }
      if (mode === 'old-explicit') f.candidate.sourceBinding!.findingEvidence.push({ ...f.candidate.sourceBinding!.findingEvidence[0]! });
      if (mode === 'new-explicit') f.next.sourceBinding!.findingEvidence.push({ ...f.next.sourceBinding!.findingEvidence[0]! });
      if (mode === 'same-frame-new-source') {
        const same = { ...f.nextFinding, id: 'synthetic-same-frame', modelEvidence: { ...f.nextFinding.modelEvidence! } };
        f.manifest.spans.push(same);
        f.next.sourceBinding!.findingEvidence.push({ ...f.next.sourceBinding!.findingEvidence[0]!, sourceSpanId: same.id });
      }
      const before = structuredClone({ old: f.candidate, next: f.next, manifest: f.manifest });
      expect(f.compatible()).toBe(true);
      expect({ old: f.candidate, next: f.next, manifest: f.manifest }).toEqual(before);
    });

  it.each(['different-frame', 'different-parent'] as const)('%s同文不是相同位置，不合并或提供多对一映射', (mode) => {
    const f = expanded();
    const other = f.excerpt('synthetic-distinct-source', 'finding', `另一处栏目\n${f.resultQuote}\n另一处条件`);
    if (mode === 'different-parent') {
      const page = { ...f.page, id: 'synthetic-page-other', page: 2, blockId: 'direct-original-page:2' };
      f.manifest.totalUnits = 2; f.manifest.coveredUnitIndexes = [0, 1]; f.manifest.spans.push(page);
      other.page = 2; other.blockId = `model-original-excerpt:${page.id}`;
      other.modelEvidence!.parentSourceSpanId = page.id;
      other.quote = f.nextFinding.quote;
    }
    f.manifest.spans.push(other);
    f.next.sourceBinding!.findingEvidence.push({ sourceSpanId: other.id, quote: f.resultQuote });
    expect(f.compatible()).toBe(false);
  });

  it.each(['uncertain-heading', 'partial-heading', 'uncertain-finding', 'uncovered-heading', 'forged-hash'] as const)(
    '%s来源仍不可用，显式映射不放宽原件回执边界', (mode) => {
      const f = expanded();
      if (mode === 'uncertain-heading') f.heading.modelEvidence!.clarity = 'uncertain';
      if (mode === 'partial-heading') f.heading.readability = 'partial';
      if (mode === 'uncertain-finding') f.nextFinding.modelEvidence!.clarity = 'uncertain';
      if (mode === 'uncovered-heading') f.manifest.coveredUnitIndexes = [];
      if (mode === 'forged-hash') f.heading.modelEvidence!.originalSha256 = 'b'.repeat(64);
      expect(f.compatible()).toBe(false);
    });
});

const stores = new Set<WorkspaceStore>();
const roots: string[] = [];
afterEach(() => {
  for (const store of stores) store.close();
  stores.clear();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('原件模型识别的技术门禁，不再用 OCR 文本裁定报告', () => {
  it.each(['finding', 'instruction'] as const)('同一可信%s摘录的独立标题与结果窄范围共用来源，不改原句/角色/字段或生成副本', (role) => {
    const f = sharedHeadingFixture(role);
    const original = structuredClone({ candidate: f.candidate, manifest: f.manifest });
    expect(isDirectOriginalHeadingReferenceValid(f.candidate, f.manifest, f.headingRef)).toBe(true);
    expect(evaluateDirectOriginalObservationCandidate(f.candidate, f.manifest, f.options).decision).toBe('accept_with_warnings');
    const binding = resolveDirectOriginalSourceBinding(f.candidate, f.manifest);
    expect(binding.status).toBe('resolved');
    if (binding.status !== 'resolved') throw new Error('SYNTHETIC_SHARED_HEADING_BINDING_REQUIRED');
    expect(binding.binding.units).toHaveLength(1);
    expect(binding.binding.units[0]).toMatchObject({ sourceSpanId: f.finding.id,
      segmentStart: f.finding.quote!.indexOf(f.resultQuote), segmentEnd: f.finding.quote!.length });
    expect(binding.binding.directOriginalField!.headingKeys).toHaveLength(1);
    expect({ candidate: f.candidate, manifest: f.manifest }).toEqual(original);
  });

  it.each(['heading', 'context'] as const)('原有独立%s标题来源仍可用完整/null引用，不依赖新双用途例外', (role) => {
    const f = fixture(); const source = f.excerpt('synthetic-independent-heading', role, '合成独立栏目');
    f.manifest.spans.push(source);
    const ref = { sourceSpanId: source.id, quote: null };
    f.candidate.sourceBinding!.headingEvidence = [ref];
    expect(isDirectOriginalHeadingReferenceValid(f.candidate, f.manifest, ref)).toBe(true);
    expect(evaluateDirectOriginalObservationCandidate(f.candidate, f.manifest, f.options).decision).not.toBe('reject');
    expect(resolveDirectOriginalSourceBinding(f.candidate, f.manifest).status).toBe('resolved');
  });

  it.each(['heading-null', 'heading-blank', 'heading-whole', 'heading-missing', 'heading-repeated',
    'finding-null', 'finding-blank', 'finding-whole', 'finding-missing', 'finding-repeated',
    'same-range', 'overlap', 'additional-overlap', 'heading-duplicate', 'finding-only-duplicate', 'other-finding'] as const)(
    '双用途%s范围未获严格证明时仍拒绝，不凭项目值或名称补猜位置', (kind) => {
      const f = sharedHeadingFixture();
      if (kind === 'heading-null') f.headingRef.quote = null as unknown as string;
      if (kind === 'heading-blank') f.headingRef.quote = '  ';
      if (kind === 'heading-whole') f.headingRef.quote = f.finding.quote!;
      if (kind === 'heading-missing') f.headingRef.quote = '不在真实摘录的合成标题';
      if (kind === 'heading-repeated') f.finding.quote += `\n${f.headingRef.quote}`;
      if (kind === 'finding-null') f.findingRef.quote = null;
      if (kind === 'finding-blank') f.findingRef.quote = '  ';
      if (kind === 'finding-whole') f.findingRef.quote = f.finding.quote;
      if (kind === 'finding-missing') f.findingRef.quote = '不在真实摘录的合成结果';
      if (kind === 'finding-repeated') f.finding.quote += `\n${f.resultQuote}`;
      if (kind === 'same-range') f.headingRef.quote = f.resultQuote;
      if (kind === 'overlap') f.headingRef.quote += '\n左室';
      if (kind === 'additional-overlap') f.candidate.sourceBinding!.findingEvidence.push({ sourceSpanId: f.finding.id, quote: f.finding.quote });
      if (kind === 'heading-duplicate') Object.assign(f.headingRef, { sourceRole: 'duplicate_source' });
      if (kind === 'finding-only-duplicate') f.findingRef.sourceRole = 'duplicate_source';
      if (kind === 'other-finding') {
        const other = f.excerpt('synthetic-other-finding', 'finding', f.resultQuote);
        f.manifest.spans.push(other);
        f.candidate.sourceBinding!.findingEvidence = [{ sourceSpanId: other.id, quote: other.quote }];
      }
      expect(isDirectOriginalHeadingReferenceValid(f.candidate, f.manifest, f.headingRef)).toBe(false);
      expect(evaluateDirectOriginalObservationCandidate(f.candidate, f.manifest, f.options).decision).toBe('reject');
      expect(resolveDirectOriginalSourceBinding(f.candidate, f.manifest).status).toBe('unresolved');
    });

  it('其他候选的同页同文本finding也不能为本候选借用标题，未明示标题引用不获得例外', () => {
    const f = sharedHeadingFixture(); const other = f.excerpt('synthetic-other-candidate', 'finding', f.finding.quote!);
    f.manifest.spans.push(other);
    const ref = { sourceSpanId: other.id, quote: f.headingRef.quote };
    f.candidate.sourceBinding!.headingEvidence = [ref];
    expect(isDirectOriginalHeadingReferenceValid(f.candidate, f.manifest, ref)).toBe(false);
    expect(evaluateDirectOriginalObservationCandidate(f.candidate, f.manifest, f.options).decision).toBe('reject');
    f.candidate.sourceBinding!.headingEvidence = [];
    expect(isDirectOriginalHeadingReferenceValid(f.candidate, f.manifest, f.headingRef)).toBe(false);
  });

  it.each(['date', 'identity', 'heading'] as const)('%s角色不能冒充临床finding，窄范围也不提供该授权', (role) => {
    const f = sharedHeadingFixture(); f.finding.modelEvidence!.role = role;
    expect(evaluateDirectOriginalObservationCandidate(f.candidate, f.manifest, f.options).decision).toBe('reject');
    expect(resolveDirectOriginalSourceBinding(f.candidate, f.manifest).status).toBe('unresolved');
    if (role !== 'heading') expect(isDirectOriginalHeadingReferenceValid(f.candidate, f.manifest, f.headingRef)).toBe(false);
  });

  it.each(['uncertain', 'partial', 'unreadable', 'hash', 'object', 'page', 'foreign-document', 'missing-parent',
    'duplicate-source', 'duplicate-parent', 'visual', 'uncovered-page'] as const)(
    '双用途%s技术来源不成立时evaluate和binding均拒绝', (kind) => {
      const f = sharedHeadingFixture();
      if (kind === 'uncertain') f.finding.modelEvidence!.clarity = 'uncertain';
      if (kind === 'partial') f.finding.readability = 'partial';
      if (kind === 'unreadable') f.finding.readability = 'unreadable';
      if (kind === 'hash') f.finding.modelEvidence!.originalSha256 = 'b'.repeat(64);
      if (kind === 'object') f.finding.modelEvidence!.originalSourceObjectId = 'foreign-object';
      if (kind === 'page') f.finding.page = 2;
      if (kind === 'foreign-document') { f.page.documentId = 'foreign-doc'; f.finding.documentId = 'foreign-doc'; }
      if (kind === 'missing-parent') f.finding.modelEvidence!.parentSourceSpanId = 'missing-parent';
      if (kind === 'duplicate-source') f.manifest.spans.push({ ...f.finding });
      if (kind === 'duplicate-parent') f.manifest.spans.push({ ...f.page });
      if (kind === 'visual') f.page.visualEvidence = { version: 1, engine: 'apple-vision-local-v1',
        layoutVersion: 'local-visual-layout-v2', coordinateSystem: 'normalized-bottom-left', reading: {
          mode: 'full_image', fallbackUsed: false }, rows: [], omittedBoxes: [] };
      if (kind === 'uncovered-page') f.manifest.coveredUnitIndexes = [];
      expect(isDirectOriginalHeadingReferenceValid(f.candidate, f.manifest, f.headingRef)).toBe(false);
      expect(evaluateDirectOriginalObservationCandidate(f.candidate, f.manifest, f.options).decision).toBe('reject');
      expect(resolveDirectOriginalSourceBinding(f.candidate, f.manifest).status).toBe('unresolved');
    });

  it('同名不同实际结果槽可由同摘录标题发布，真数值冲突与撤权仍hold且旧结果原样保留', () => {
    const rootDirectory = mkdtempSync(join(tmpdir(), 'family-health-shared-heading-synthetic-')); roots.push(rootDirectory);
    const store = new WorkspaceStore({ rootDirectory }); stores.add(store);
    const person = store.createPerson({ displayName: '合成成员' });
    const source = store.putSourceObject({ bytes: Buffer.from('完全合成原件，不含私人资料'), mediaType: 'image/png', displayName: '合成原件.png' });
    const { documentId } = store.registerImportedDocument({ personId: person.id, sourceObjectId: source.id });
    const f = fixture(); f.manifest.sourceObjectId = source.id; f.manifest.sha256 = source.sha256;
    f.manifest.mediaType = 'image/png'; f.manifest.originalDisplayName = '合成原件.png';
    f.manifest.spans = [f.page, f.finding]; f.page.documentId = documentId; f.finding.documentId = documentId;
    f.finding.modelEvidence!.originalSourceObjectId = source.id; f.finding.modelEvidence!.originalSha256 = source.sha256;
    const title = '合成共同栏目'; const results = ['本次槽：合成重复项目 7 U/L', '历史槽：合成重复项目 9 U/L'];
    f.finding.quote = `${title}\n${results.join('\n')}`;
    store.saveSourceManifest({ ...f.manifest, spans: [f.page] });
    const fingerprint = 'synthetic-shared-heading-account';
    const consentId = store.createManualProcessingConsent({ documentIds: [documentId], personIds: [person.id], accountFingerprint: fingerprint, version: 1 });
    store.createWaitingAuthBatch({ cutoff: '2026-01-01T00:00:00Z', initialStatus: 'queued', consentId,
      groups: [{ personId: person.id, documentIds: [documentId], inputSignature: 'synthetic-heading-input' }] });
    const job = store.claimNextQueuedJob('synthetic-shared-heading-runner', fingerprint)!;
    const guard = { jobId: job.id, consentId, accountFingerprint: fingerprint,
      attemptId: store.startJobAttempt(job.id, 'synthetic', 'gpt-6.1-sol', 'medium') };
    store.saveDirectOriginalEvidenceForProcessing(f.manifest, { executionGuard: guard });
    const candidates = results.map((quote, index): ObservationCandidate => ({ ...f.candidate,
      localKey: `synthetic-repeat-${index}`, originalName: '合成重复项目', clinicalDate: null,
      value: { kind: 'numeric', rawText: index === 0 ? '7' : '9', decimal: index === 0 ? '7' : '9', comparator: 'eq' }, unitRaw: 'U/L',
      evidence: [{ sourceSpanId: f.finding.id, quote }], sourceBinding: {
        headingEvidence: [{ sourceSpanId: f.finding.id, quote: title }], findingEvidence: [{ sourceSpanId: f.finding.id, quote }] } }));
    const bindings = candidates.map((candidate) => resolveDirectOriginalSourceBinding(candidate, f.manifest));
    expect(bindings.every((binding) => binding.status === 'resolved')).toBe(true);
    if (bindings[0]!.status !== 'resolved' || bindings[1]!.status !== 'resolved') throw new Error('SYNTHETIC_TWO_SLOT_BINDINGS_REQUIRED');
    expect(directOriginalFieldsProvenDistinct(bindings[0]!.binding, bindings[1]!.binding)).toBe(true);
    const acceptanceId = store.saveAcceptanceDecision({ method: 'auto', actor: 'policy', rulesVersion: 'synthetic-shared-heading',
      inputSignature: 'synthetic-acceptance-input', outputHash: 'synthetic-acceptance-output', reviewRef: null, decision: 'accept_with_warnings' });
    const observation = (candidate: ObservationCandidate): PublishFactsInput['observations'][number] => ({
      conceptKey: candidate.originalName, originalName: candidate.originalName, modelStandardNameCandidate: null,
      rawText: candidate.value.rawText!, valueKind: 'numeric', decimalValue: candidate.value.kind === 'numeric' ? candidate.value.decimal : null,
      qualifier: 'eq', unit: candidate.unitRaw, referenceRange: null, clinicalDate: null, abnormalFlag: 'unknown', documentId,
      sourceSpanId: f.finding.id, acceptanceId, specimen: null, method: null, bodySite: null, clinicalContext: null,
      evidence: [...candidate.evidence, ...candidate.sourceBinding!.headingEvidence], sourceBinding: candidate.sourceBinding, candidate });
    const observations = candidates.map(observation);
    const preview = store.previewDirectOriginalAdmission({ personId: person.id, documentId, manifest: f.manifest, observations });
    expect(preview).toMatchObject({ acceptedCount: 2, held: [], duplicateCount: 0 });
    const publication = store.publishFacts({ personId: person.id, documentId, expectedRevision: 0,
      documentCommitKey: 'c'.repeat(64), changeSetHash: 'd'.repeat(64), summary: '合成双槽正常发布', observations, executionGuard: guard });
    expect(publication).toMatchObject({ heldCount: 0, duplicateCount: 0 });
    const original = store.listAcceptedObservations(person.id);
    expect(original.map((record) => record.rawText).sort()).toEqual(['7', '9']);
    const stored = store.getDocumentExtractionBundle(documentId).manifest;
    expect(stored.spans.filter((span) => span.modelEvidence)).toHaveLength(1);
    expect(stored.spans.find((span) => span.id === f.finding.id)?.quote).toBe(f.finding.quote);
    const issueId = store.saveExtractionReviewIssue({ documentId, stage: 'extract', kind: 'field_conflict', severity: 'warning',
      preserveDocumentStatus: true, candidateOptions: [], evidenceRefs: [], reasonCodes: ['SYNTHETIC_RECHECK'] });
    const conflict = { ...candidates[0]!, value: { kind: 'numeric' as const, rawText: '8', decimal: '8', comparator: 'eq' as const } };
    const update = { personId: person.id, documentId, expectedRevision: store.getFactRevision(person.id),
      summary: '合成同槽冲突仍隔离', observations: [observation(conflict)], executionGuard: guard,
      reviewUpdate: { issueId, remainingCandidates: [], remainingReasonCodes: [], remainingEvidenceRefs: [] } };
    expect(store.appendCommittedFacts(update).heldCandidates).toHaveLength(1);
    expect(store.listAcceptedObservations(person.id)).toEqual(original);
    store.revokeAllAiAuthorizations();
    expect(() => store.appendCommittedFacts({ ...update, expectedRevision: store.getFactRevision(person.id) })).toThrow('CONSENT_REVOKED');
    expect(store.listAcceptedObservations(person.id)).toEqual(original);
  });

  it.each(['finding', 'instruction', 'context', 'date', 'heading'] as const)(
    '整段%s引用只取精确ID的真实clear模型摘录，原标点、空格和换行原样保留', (role) => {
      const f = fixture(); const quote = '  合成原件完整摘录。\n保留限定词、符号≤及完整单位。  ';
      const selected = f.excerpt('synthetic-whole-source', role, quote);
      f.manifest.spans.push(selected);
      const original = structuredClone(f.manifest);
      expect(resolveDirectOriginalWholeExcerptQuote(f.manifest, f.page.documentId, selected.id)).toBe(quote);
      expect(f.manifest).toEqual(original);
    });

  it('未知引用不扫描别的同正文摘录，骨架或identity也不补成临床出处', () => {
    const f = fixture();
    f.manifest.spans.push(f.excerpt('same-text-other-id', 'instruction', f.finding.quote!));
    expect(resolveDirectOriginalWholeExcerptQuote(f.manifest, f.page.documentId, 'not-in-manifest')).toBeNull();
    expect(resolveDirectOriginalWholeExcerptQuote(f.manifest, f.page.documentId, f.page.id)).toBeNull();
    expect(resolveDirectOriginalWholeExcerptQuote(f.manifest, f.page.documentId, f.identity.id)).toBeNull();
    expect(resolveDirectOriginalWholeExcerptQuote(f.manifest, 'other-document', f.finding.id)).toBeNull();
  });

  it.each(['uncertain', 'partial', 'unreadable', 'missing-parent', 'hash', 'object', 'foreign-source-document',
    'foreign-parent-document', 'page', 'wrong-block', 'parent-not-page', 'parent-with-text', 'parent-model',
    'source-visual', 'parent-visual', 'legacy', 'empty-thread', 'blank-thread', 'empty-turn', 'blank-turn', 'blank-model',
    'parent-page-null', 'parent-page-outside-original', 'uncovered-parent-page', 'blank-quote', 'null-quote',
    'duplicate-source-id', 'duplicate-parent-id'] as const)(
    '无效%s出处不能通过整段引用解析，不能另找标题或正文替代', (kind) => {
      const f = fixture(); const selected = f.finding;
      const visual: NonNullable<SourceSpan['visualEvidence']> = { version: 1, engine: 'apple-vision-local-v1',
        layoutVersion: 'local-visual-layout-v2', coordinateSystem: 'normalized-bottom-left',
        reading: { mode: 'full_image', fallbackUsed: false }, rows: [], omittedBoxes: [] };
      if (kind === 'uncertain') selected.modelEvidence!.clarity = 'uncertain';
      if (kind === 'partial') selected.readability = 'partial';
      if (kind === 'unreadable') selected.readability = 'unreadable';
      if (kind === 'missing-parent') selected.modelEvidence!.parentSourceSpanId = 'not-in-manifest';
      if (kind === 'hash') selected.modelEvidence!.originalSha256 = 'b'.repeat(64);
      if (kind === 'object') selected.modelEvidence!.originalSourceObjectId = 'another-object';
      if (kind === 'foreign-source-document') selected.documentId = 'other-document';
      if (kind === 'foreign-parent-document') f.page.documentId = 'other-document';
      if (kind === 'page') selected.page = 2;
      if (kind === 'wrong-block') selected.blockId = 'another-block';
      if (kind === 'parent-not-page') f.page.spanKind = 'block';
      if (kind === 'parent-with-text') f.page.quote = '旧脚本转写不能作为direct骨架';
      if (kind === 'parent-model') f.page.modelEvidence = { ...selected.modelEvidence! };
      if (kind === 'source-visual') selected.visualEvidence = visual;
      if (kind === 'parent-visual') f.page.visualEvidence = visual;
      if (kind === 'legacy') { delete selected.modelEvidence; f.manifest.normalizerVersion = 'legacy-ocr-v1'; }
      if (kind === 'empty-thread') selected.modelEvidence!.threadId = '';
      if (kind === 'blank-thread') selected.modelEvidence!.threadId = '  ';
      if (kind === 'empty-turn') selected.modelEvidence!.turnId = '';
      if (kind === 'blank-turn') selected.modelEvidence!.turnId = '  ';
      if (kind === 'blank-model') selected.modelEvidence!.modelId = '  ';
      if (kind === 'parent-page-null') { f.page.page = null; selected.page = null; }
      if (kind === 'parent-page-outside-original') { f.page.page = 2; selected.page = 2; }
      if (kind === 'uncovered-parent-page') f.manifest.coveredUnitIndexes = [];
      if (kind === 'blank-quote') selected.quote = '  ';
      if (kind === 'null-quote') selected.quote = null;
      if (kind === 'duplicate-source-id') f.manifest.spans.push({ ...selected, quote: '另一个同ID片段' });
      if (kind === 'duplicate-parent-id') f.manifest.spans.push({ ...f.page });
      expect(resolveDirectOriginalWholeExcerptQuote(f.manifest, 'synthetic-doc', selected.id)).toBeNull();
    });

  it('左室标题、组合单位和明确英文日期直接保留，不按左右字典或日期格式误拦', () => {
    const f = fixture();
    expect(validateDirectOriginalExtraction(f.extraction, f.manifest)).toEqual([]);
    expect(evaluateDirectOriginalObservationCandidate(f.candidate, f.manifest, f.options).decision).toBe('accept_with_warnings');
  });

  it('明确栏目与结果各自有效即可，无需重复写入general evidence；日期仍需自身引用', () => {
    const f = fixture();
    const heading = f.excerpt('synthetic-heading', 'heading', '合成影像报告');
    f.manifest.spans.push(heading);
    const candidate = { ...f.candidate, originalName: '合成影像—左室检查结论', evidence: [f.candidate.evidence[1]!],
      sourceBinding: { headingEvidence: [{ sourceSpanId: heading.id, quote: heading.quote }],
        findingEvidence: [f.candidate.evidence[0]!] } };
    expect(evaluateDirectOriginalObservationCandidate(candidate, f.manifest, f.options).decision).not.toBe('reject');
    expect(resolveDirectOriginalSourceBinding(candidate, f.manifest).status).toBe('resolved');
    expect(evaluateDirectOriginalObservationCandidate({ ...candidate, evidence: [f.candidate.evidence[0]!] }, f.manifest, f.options))
      .toMatchObject({ decision: 'reject', reasons: ['direct_original_clinical_date_source_required'] });
    heading.modelEvidence!.originalSha256 = 'b'.repeat(64);
    expect(evaluateDirectOriginalObservationCandidate(candidate, f.manifest, f.options).decision).toBe('reject');
    expect(resolveDirectOriginalSourceBinding(candidate, f.manifest).status).toBe('unresolved');
  });

  it('duplicate_source保留为佐证但不参与主字段身份，只有佐证不能支持结果', () => {
    const f = fixture();
    const before = resolveDirectOriginalSourceBinding(f.candidate, f.manifest);
    const duplicate = f.excerpt('synthetic-duplicate', 'finding', '报告小结的另一段合成佐证');
    f.manifest.spans.push(duplicate);
    const support = { sourceSpanId: duplicate.id, quote: duplicate.quote, sourceRole: 'duplicate_source' as const,
      duplicateBasis: 'report_structure' as const };
    const after = resolveDirectOriginalSourceBinding({ ...f.candidate, evidence: [...f.candidate.evidence, support],
      sourceBinding: { headingEvidence: [], findingEvidence: [...f.candidate.sourceBinding!.findingEvidence, support] } }, f.manifest);
    expect(after.status).toBe('resolved');
    if (before.status === 'resolved' && after.status === 'resolved') {
      expect(after.binding.key).toBe(before.binding.key);
      expect(after.binding.directOriginalField).toEqual(before.binding.directOriginalField);
      expect(after.binding.units).toHaveLength(1);
    }
    const supportOnly = { ...f.candidate, evidence: [support], sourceBinding: { headingEvidence: [], findingEvidence: [support] } };
    expect(resolveDirectOriginalSourceBinding(supportOnly, f.manifest).status).toBe('unresolved');
    expect(evaluateDirectOriginalObservationCandidate({ ...supportOnly, clinicalDate: null }, f.manifest, f.options))
      .toMatchObject({ decision: 'reject', reasons: ['direct_original_finding_source_required'] });
  });

  it('窄引用只定位唯一实际范围，重复短结果不凭名称或值猜位置', () => {
    const f = fixture();
    f.finding.quote = '合成甲项 未见异常；合成乙项 未见异常';
    const make = (quote: string | null) => ({ ...f.candidate, clinicalDate: null,
      value: { kind: 'text' as const, rawText: '未见异常' }, evidence: [{ sourceSpanId: f.finding.id, quote }],
      sourceBinding: { headingEvidence: [], findingEvidence: [{ sourceSpanId: f.finding.id, quote }] } });
    const bound = resolveDirectOriginalSourceBinding(make('合成乙项 未见异常'), f.manifest);
    expect(bound.status).toBe('resolved');
    if (bound.status === 'resolved') {
      expect(bound.binding.units[0]).toMatchObject({ segmentStart: f.finding.quote.indexOf('合成乙项'), segmentEnd: f.finding.quote.length });
      expect(bound.binding.units[0]!.segmentStart).toBeGreaterThan(0);
    }
    expect(resolveDirectOriginalSourceBinding(make('未见异常'), f.manifest))
      .toEqual({ status: 'unresolved', reason: 'direct_original_finding_quote_not_unique' });
  });

  it('同名同正常结论的不同真实栏目不碰撞，general中的历史heading可恢复身份', () => {
    const f = fixture(); f.finding.quote = '未见异常';
    const headings = [f.excerpt('heading-a', 'heading', '合成科室甲'), f.excerpt('heading-b', 'heading', '合成科室乙')];
    f.manifest.spans.push(...headings);
    const make = (heading: SourceSpan) => ({ ...f.candidate, originalName: '检查小结', clinicalDate: null,
      value: { kind: 'text' as const, rawText: '未见异常' },
      evidence: [{ sourceSpanId: f.finding.id, quote: f.finding.quote }, { sourceSpanId: heading.id, quote: heading.quote }],
      sourceBinding: { headingEvidence: [{ sourceSpanId: heading.id, quote: heading.quote }],
        findingEvidence: [{ sourceSpanId: f.finding.id, quote: f.finding.quote }] } });
    const first = resolveDirectOriginalSourceBinding(make(headings[0]!), f.manifest);
    const second = resolveDirectOriginalSourceBinding(make(headings[1]!), f.manifest);
    const historical = resolveDirectOriginalSourceBinding({ ...make(headings[0]!), sourceBinding: undefined }, f.manifest);
    expect(first.status).toBe('resolved'); expect(second.status).toBe('resolved'); expect(historical.status).toBe('resolved');
    if (first.status === 'resolved' && second.status === 'resolved' && historical.status === 'resolved') {
      expect(first.binding.key).not.toBe(second.binding.key);
      expect(directOriginalFieldsProvenDistinct(first.binding, second.binding)).toBe(true);
      expect(sameDirectOriginalField(first.binding, historical.binding)).toBe(true);
    }
  });

  it('同字段的值、日期、方法、左右侧或否定变化不制造新的字段身份', () => {
    const f = fixture();
    const first = resolveDirectOriginalSourceBinding(f.candidate, f.manifest);
    const changed = resolveDirectOriginalSourceBinding({ ...f.candidate,
      value: { kind: 'numeric', rawText: '8', decimal: '8', comparator: 'eq' }, clinicalDate: '2026-04-18',
      method: '另一合成方法', bodySite: '另一侧', clinicalContext: { version: 1, status: 'complete', conditions: [] } }, f.manifest);
    if (first.status === 'resolved' && changed.status === 'resolved') {
      expect(first.binding.directOriginalField).toEqual(changed.binding.directOriginalField);
      expect(sameDirectOriginalField(first.binding, changed.binding)).toBe(true);
      expect(directOriginalFieldsProvenDistinct(first.binding, changed.binding)).toBe(false);
    } else throw new Error('SYNTHETIC_FIELD_RESOLUTION_REQUIRED');
  });

  it('保存JSON、克隆和修改字段标记都不获得应用的分字段权限', () => {
    const f = fixture(); const first = resolveDirectOriginalSourceBinding(f.candidate, f.manifest);
    expect(first.status).toBe('resolved');
    if (first.status !== 'resolved') return;
    expect(isVerifiedDirectOriginalSourceBinding(first.binding)).toBe(true);
    const clone = structuredClone(first.binding);
    expect(isVerifiedDirectOriginalSourceBinding(clone)).toBe(false);
    expect(sameDirectOriginalField(first.binding, clone)).toBe(false);
    first.binding.directOriginalField!.fieldKey = 'forged-key';
    expect(isVerifiedDirectOriginalSourceBinding(first.binding)).toBe(false);
  });

  it.each([
    { rawText: '<3.50E＋03', decimal: '3500', comparator: 'eq' as const },
    { rawText: '<3.50E＋03', decimal: '350', comparator: 'lt' as const },
    { rawText: '9007199254740993', decimal: '9007199254740992', comparator: 'eq' as const }
  ])('rawText、比较边界和decimal必须精确自洽，不用浮点舍入掩盖错值', (value) => {
    const f = fixture();
    expect(evaluateDirectOriginalObservationCandidate({ ...f.candidate, value: { kind: 'numeric', ...value } }, f.manifest, f.options))
      .toMatchObject({ decision: 'reject', reasons: ['direct_original_numeric_representation_conflict'] });
  });

  it('原件的医生原话可保存为来源事实，不用措辞词典把它当成应用诊断', () => {
    const f = fixture();
    f.finding.quote = '合成报告意见：考虑某疾病，结合临床随访。';
    f.finding.modelEvidence!.role = 'instruction';
    const ref = { sourceSpanId: f.finding.id, quote: f.finding.quote };
    const candidate = { ...f.candidate, originalName: '病理检查—报告意见', value: { kind: 'text' as const, rawText: f.finding.quote },
      clinicalDate: null, unitRaw: null, evidence: [ref], sourceBinding: { headingEvidence: [], findingEvidence: [ref] } };
    expect(evaluateDirectOriginalObservationCandidate(candidate, f.manifest, f.options).decision).toBe('accept_with_warnings');
  });

  it('科学计数法及边界、符号宽度与小数末尾零不损失', () => {
    const f = fixture();
    for (const value of [
      { kind: 'numeric' as const, rawText: '≤3.500e3', decimal: '3500.000', comparator: 'lte' as const },
      { kind: 'numeric' as const, rawText: '3.5E-03', decimal: '0.00350', comparator: 'eq' as const }
    ]) expect(evaluateDirectOriginalObservationCandidate({ ...f.candidate, value }, f.manifest, f.options).decision).not.toBe('reject');
  });

  it('两个独立数字 token 不会被空格消除拼接，指数附近排版空格仍可表达同一数值', () => {
    const f = fixture();
    expect(evaluateDirectOriginalObservationCandidate({ ...f.candidate,
      value: { kind: 'numeric', rawText: '1 2', decimal: '12', comparator: 'eq' } }, f.manifest, f.options).decision).toBe('reject');
    expect(evaluateDirectOriginalObservationCandidate({ ...f.candidate,
      value: { kind: 'numeric', rawText: '< 3.50 E +03', decimal: '3500', comparator: 'lt' } }, f.manifest, f.options).decision).not.toBe('reject');
  });

  it.each(['text', 'qualitative'] as const)('非unknown的%s空白不能冒充正常观测', (kind) => {
    const f = fixture();
    const value = kind === 'text' ? { kind, rawText: '  ' } : { kind, rawText: '  ', category: 'normal' };
    expect(evaluateDirectOriginalObservationCandidate({ ...f.candidate, value }, f.manifest, f.options))
      .toEqual({ decision: 'reject', reasons: ['direct_original_result_blank'] });
  });

  it('临床条件必须引用同原件清晰的模型出处，骨架空页不能证明未散瞳等条件', () => {
    const f = fixture();
    const condition = { sourceSpanId: f.page.id, quote: '合成解释条件' };
    const candidate = { ...f.candidate, clinicalContext: { version: 1 as const, status: 'complete' as const, conditions: [condition] } };
    expect(evaluateDirectOriginalObservationCandidate(candidate, f.manifest, f.options).decision).toBe('reject');
    f.finding.quote += '\n合成解释条件'; candidate.clinicalContext.conditions[0] = { sourceSpanId: f.finding.id, quote: '合成解释条件' };
    expect(evaluateDirectOriginalObservationCandidate(candidate, f.manifest, f.options).decision).not.toBe('reject');
  });

  it('同一clear日期出处可同时支持metadata与明确日期条件，不要求复制摘录或改写角色', () => {
    const f = fixture();
    const candidate: ObservationCandidate = { ...f.candidate, clinicalContext: { version: 1, status: 'complete',
      conditions: [{ sourceSpanId: f.date.id, quote: f.date.quote! }] } };
    const original = structuredClone({ candidate, metadata: f.metadata, manifest: f.manifest });
    expect(evaluateDirectOriginalObservationCandidate(candidate, f.manifest, f.options).decision).not.toBe('reject');
    expect(resolveDirectOriginalSourceBinding(candidate, f.manifest).status).toBe('resolved');
    expect(validateDirectOriginalExtraction({ ...f.extraction, candidates: [candidate] }, f.manifest)).toEqual([]);
    expect({ candidate, metadata: f.metadata, manifest: f.manifest }).toEqual(original);
  });

  it('监测区间条件不自动填项目clinicalDate或指定metadata主要日期', () => {
    const f = fixture();
    const period = f.excerpt('synthetic-period', 'date', '合成监测区间：2026-04-11至2026-04-17');
    f.manifest.spans.push(period);
    f.metadata.times.push({ value: '2026-04-11', precision: 'day', role: 'examined',
      evidence: [{ sourceSpanId: period.id, quote: period.quote }] });
    f.metadata.primaryClinicalTimeIndex = null;
    const candidate: ObservationCandidate = { ...f.candidate, clinicalDate: null, evidence: [f.candidate.evidence[0]!],
      clinicalContext: { version: 1, status: 'complete', conditions: [{ sourceSpanId: period.id, quote: period.quote! }] } };
    const original = structuredClone({ candidate, metadata: f.metadata });
    expect(evaluateDirectOriginalObservationCandidate(candidate, f.manifest, f.options).decision).not.toBe('reject');
    expect(resolveDirectOriginalSourceBinding(candidate, f.manifest).status).toBe('resolved');
    expect(validateDirectOriginalExtraction({ ...f.extraction, candidates: [candidate] }, f.manifest)).toEqual([]);
    expect({ candidate, metadata: f.metadata }).toEqual(original);
  });

  it('仅条件中的date不能代替项目自身日期引用，缺metadata授权也仍拒绝非null项目日期', () => {
    const f = fixture();
    const candidate: ObservationCandidate = { ...f.candidate, evidence: [f.candidate.evidence[0]!],
      clinicalContext: { version: 1, status: 'complete', conditions: [{ sourceSpanId: f.date.id, quote: f.date.quote! }] } };
    expect(evaluateDirectOriginalObservationCandidate(candidate, f.manifest, f.options))
      .toMatchObject({ decision: 'reject', reasons: ['direct_original_clinical_date_source_required'] });
    expect(evaluateDirectOriginalObservationCandidate({ ...candidate, evidence: f.candidate.evidence }, f.manifest,
      { ...f.options, reportMetadata: null })).toMatchObject({ decision: 'reject', reasons: ['direct_original_clinical_date_source_required'] });
    expect(candidate.clinicalDate).toBe(f.candidate.clinicalDate);
  });

  it.each(['unknown', 'report_issued'] as const)('条件date合法也不能把metadata.%s日期充作项目临床日期', (role) => {
    const f = fixture(); f.metadata.times[0]!.role = role;
    const candidate: ObservationCandidate = { ...f.candidate, clinicalContext: { version: 1, status: 'complete',
      conditions: [{ sourceSpanId: f.date.id, quote: f.date.quote! }] } };
    expect(evaluateDirectOriginalObservationCandidate(candidate, f.manifest, f.options))
      .toMatchObject({ decision: 'reject', reasons: ['direct_original_clinical_date_source_required'] });
    // 绑定只证明结果出处与条件出处，不能替代临床日期接纳门禁。
    expect(resolveDirectOriginalSourceBinding(candidate, f.manifest).status).toBe('resolved');
  });

  it('日期条件支持明示历史项目，仍不能把history_quoted设为报告主要日期', () => {
    const f = fixture(); f.metadata.times[0]!.role = 'history_quoted'; f.metadata.primaryClinicalTimeIndex = 0;
    const candidate: ObservationCandidate = { ...f.candidate, clinicalContext: { version: 1, status: 'complete',
      conditions: [{ sourceSpanId: f.date.id, quote: f.date.quote! }] } };
    expect(evaluateDirectOriginalObservationCandidate(candidate, f.manifest, f.options).decision).not.toBe('reject');
    expect(resolveDirectOriginalSourceBinding(candidate, f.manifest).status).toBe('resolved');
    expect(validateDirectOriginalExtraction({ ...f.extraction, candidates: [candidate] }, f.manifest))
      .toContain('direct_original_primary_clinical_time_invalid');
  });

  it.each(['unknown-reference', 'wrong-parent', 'hash', 'object', 'page', 'uncertain', 'changed-quote', 'wrong-role'] as const)(
    '日期条件的%s出处仍被evaluate与resolver同时拒绝，不把新增role当放宽原件范围', (kind) => {
      const f = fixture();
      const condition = f.excerpt('synthetic-condition-date', 'date', '合成监测日期区间');
      f.manifest.spans.push(condition);
      const ref = { sourceSpanId: condition.id, quote: condition.quote! };
      const candidate: ObservationCandidate = { ...f.candidate, clinicalContext: { version: 1, status: 'complete', conditions: [ref] } };
      if (kind === 'unknown-reference') ref.sourceSpanId = 'not-in-original';
      if (kind === 'wrong-parent') condition.modelEvidence!.parentSourceSpanId = 'not-in-original';
      if (kind === 'hash') condition.modelEvidence!.originalSha256 = 'b'.repeat(64);
      if (kind === 'object') condition.modelEvidence!.originalSourceObjectId = 'another-object';
      if (kind === 'page') condition.page = 2;
      if (kind === 'uncertain') { condition.readability = 'partial'; condition.modelEvidence!.clarity = 'uncertain'; }
      if (kind === 'changed-quote') ref.quote = '原件不存在的另一个日期区间';
      if (kind === 'wrong-role') condition.modelEvidence!.role = 'identity';
      expect(evaluateDirectOriginalObservationCandidate(candidate, f.manifest, f.options).decision).toBe('reject');
      expect(resolveDirectOriginalSourceBinding(candidate, f.manifest).status).toBe('unresolved');
    });

  it('不把签发时间、另一次检查日或没有日期依据的值作为检查时间', () => {
    const f = fixture();
    for (const reportMetadata of [null, { ...f.metadata, times: f.metadata.times.map((time) => ({ ...time, role: 'report_issued' as const })) },
      { ...f.metadata, times: f.metadata.times.map((time) => ({ ...time, value: '2026-04-18' })) }]) {
      expect(evaluateDirectOriginalObservationCandidate(f.candidate, f.manifest, { ...f.options, reportMetadata }).decision).toBe('reject');
    }
    expect(evaluateDirectOriginalObservationCandidate({ ...f.candidate, clinicalDate: null }, f.manifest, { ...f.options, reportMetadata: null }).decision)
      .not.toBe('reject');
  });

  it('日期角色仍需真实模型日期来源，不能拿任意正文或未知页填日期', () => {
    const f = fixture();
    f.date.modelEvidence!.role = 'context';
    expect(validateDirectOriginalExtraction(f.extraction, f.manifest)).toContain('direct_original_evidence_role_mismatch');
    expect(evaluateDirectOriginalObservationCandidate(f.candidate, f.manifest, f.options).decision).toBe('reject');
  });

  it('用户明确归属只解除主体来源门禁，原主体及其他来源原样保留', () => {
    const f = fixture();
    f.extraction.subject.evidence = [{ sourceSpanId: f.finding.id, quote: '原件没有的身份引用' }];
    const before = structuredClone({ extraction: f.extraction, manifest: f.manifest });
    expect(validateDirectOriginalExtraction(f.extraction, f.manifest).length).toBeGreaterThan(0);
    expect(validateDirectOriginalExtraction(f.extraction, f.manifest, { subjectPolicy: 'user_assigned' })).toEqual([]);
    expect({ extraction: f.extraction, manifest: f.manifest }).toEqual(before);
    f.date.modelEvidence!.role = 'identity';
    expect(validateDirectOriginalExtraction(f.extraction, f.manifest, { subjectPolicy: 'user_assigned' }))
      .toContain('direct_original_evidence_role_mismatch');
    expect(evaluateDirectOriginalObservationCandidate(f.candidate, f.manifest, f.options).decision).toBe('reject');
  });

  it('用户明确归属不解除文档范围、全页覆盖或元数据时间角色门禁', () => {
    const f = fixture();
    f.extraction.coveredSourceSpanIds = [];
    f.metadata.primaryClinicalTimeIndex = 0;
    f.metadata.times[0]!.role = 'report_issued';
    const errors = validateDirectOriginalExtraction(f.extraction, f.manifest, { subjectPolicy: 'user_assigned' });
    expect(errors).toContain('direct_original_page_coverage_incomplete');
    expect(errors).toContain('direct_original_primary_clinical_time_invalid');
  });

  it.each(['finding', 'instruction'] as const)('日期与结果共用%s原文时保留模型显式绑定，不要求复制date来源', (role) => {
    const f = fixture(); f.metadata.primaryClinicalTimeIndex = 0;
    f.finding.modelEvidence!.role = role;
    f.finding.quote = `检查日期：2026年4月17日\n${f.finding.quote}`;
    const ref = { sourceSpanId: f.finding.id, quote: null };
    f.metadata.times[0]!.evidence = [ref]; f.candidate.evidence = [ref];
    f.candidate.sourceBinding!.findingEvidence = [ref];
    const before = structuredClone({ metadata: f.metadata, candidate: f.candidate, manifest: f.manifest });
    expect(validateDirectOriginalExtraction(f.extraction, f.manifest)).toEqual([]);
    expect(evaluateDirectOriginalObservationCandidate(f.candidate, f.manifest, f.options).decision).not.toBe('reject');
    expect({ metadata: f.metadata, candidate: f.candidate, manifest: f.manifest }).toEqual(before);
  });

  it.each(['date_absent', 'narrow_quote_excludes_date', 'different_date', 'other_document', 'uncertain'] as const)(
    '共用finding日期的%s不能绕过原件绑定', (mode) => {
      const f = fixture(); f.metadata.primaryClinicalTimeIndex = 0;
      const resultQuote = f.finding.quote!;
      f.finding.quote = `检查日期：2026-04-17\n${resultQuote}`;
      const ref = { sourceSpanId: f.finding.id, quote: null as string | null };
      f.metadata.times[0]!.evidence = [ref]; f.candidate.evidence = [ref];
      f.candidate.sourceBinding!.findingEvidence = [ref];
      if (mode === 'date_absent') f.finding.quote = resultQuote;
      if (mode === 'narrow_quote_excludes_date') ref.quote = resultQuote;
      if (mode === 'different_date') f.metadata.times[0]!.value = '2026-04-18';
      if (mode === 'other_document') f.finding.documentId = 'synthetic-other-document';
      if (mode === 'uncertain') f.finding.modelEvidence!.clarity = 'uncertain';
      expect(validateDirectOriginalExtraction(f.extraction, f.manifest).length).toBeGreaterThan(0);
      expect(evaluateDirectOriginalObservationCandidate(f.candidate, f.manifest, f.options).decision).toBe('reject');
    });

  it('共用finding的签发日期可保存但仍不能成为项目临床日期，未知日期事实可以分析', () => {
    const f = fixture(); f.metadata.primaryClinicalTimeIndex = null;
    f.finding.quote = `报告日期：2026-04-17\n${f.finding.quote}`;
    const ref = { sourceSpanId: f.finding.id, quote: null };
    f.metadata.times[0]!.role = 'report_issued'; f.metadata.times[0]!.evidence = [ref];
    f.candidate.evidence = [ref]; f.candidate.sourceBinding!.findingEvidence = [ref];
    expect(validateDirectOriginalExtraction(f.extraction, f.manifest)).toEqual([]);
    expect(evaluateDirectOriginalObservationCandidate(f.candidate, f.manifest, f.options).decision).toBe('reject');
    expect(evaluateDirectOriginalObservationCandidate({ ...f.candidate, clinicalDate: null }, f.manifest, f.options).decision)
      .not.toBe('reject');
  });

  it('旧单一当前临床日期不要求selector，同日不同当前角色和明确历史日期不制造歧义', () => {
    const f = fixture();
    const history = f.excerpt('synthetic-history-date', 'date', '合成原件旧列日期');
    f.manifest.spans.push(history);
    f.metadata.times.push({ ...f.metadata.times[0]!, role: 'sampled' }, {
      value: '2025-02-11', precision: 'day', role: 'history_quoted', evidence: [{ sourceSpanId: history.id, quote: history.quote }] });
    expect(f.metadata.primaryClinicalTimeIndex).toBeUndefined();
    expect(validateDirectOriginalExtraction(f.extraction, f.manifest)).toEqual([]);
    expect(evaluateDirectOriginalObservationCandidate(f.candidate, f.manifest, f.options).decision).not.toBe('reject');
  });

  it('不同当前临床日期缺selector进入报告级定点修复，不抢改有独立依据的各项目日期', () => {
    const f = fixture();
    const second = f.excerpt('synthetic-current-date-b', 'date', '合成原件第二日期槽');
    f.manifest.spans.push(second);
    const ref = { sourceSpanId: second.id, quote: second.quote };
    f.metadata.times.push({ value: '2026-04-19', precision: 'day', role: 'sampled', evidence: [ref] });
    const unchanged = structuredClone(f.extraction);
    expect(validateDirectOriginalExtraction(f.extraction, f.manifest)).toEqual(['direct_original_primary_clinical_time_required']);
    expect(evaluateDirectOriginalObservationCandidate(f.candidate, f.manifest, f.options).decision).not.toBe('reject');
    const another = { ...f.candidate, clinicalDate: '2026-04-19', evidence: [f.candidate.evidence[0]!, ref] };
    expect(evaluateDirectOriginalObservationCandidate(another, f.manifest, f.options).decision).not.toBe('reject');
    expect(f.extraction).toEqual(unchanged);
  });

  it('显式null可保留报告事件日期未知，不能因此拒绝或清掉项目自身的真实日期', () => {
    const f = fixture();
    const second = f.excerpt('synthetic-current-date-b', 'date', '合成原件第二日期槽');
    f.manifest.spans.push(second);
    f.metadata.times.push({ value: '2026-04-19', precision: 'day', role: 'encounter',
      evidence: [{ sourceSpanId: second.id, quote: second.quote }] });
    f.metadata.primaryClinicalTimeIndex = null;
    const unchanged = structuredClone(f.extraction);
    expect(validateDirectOriginalExtraction(f.extraction, f.manifest)).toEqual([]);
    expect(evaluateDirectOriginalObservationCandidate(f.candidate, f.manifest, f.options).decision).not.toBe('reject');
    expect(f.extraction).toEqual(unchanged);
  });

  it.each(['sampled', 'examined', 'encounter'] as const)('selector可指向模型明示的%s，不按时间早晚、字段顺序或原文关键词改选', (role) => {
    const f = fixture();
    const selected = f.excerpt('synthetic-selected-current-date', 'date', '合成原件日期槽，无固定标签模式');
    f.manifest.spans.push(selected);
    f.metadata.times.push({ value: '2026-03-09', precision: 'day', role,
      evidence: [{ sourceSpanId: selected.id, quote: selected.quote }] });
    f.metadata.primaryClinicalTimeIndex = 1;
    const unchanged = structuredClone(f.metadata);
    expect(validateDirectOriginalExtraction(f.extraction, f.manifest)).toEqual([]);
    expect(f.metadata).toEqual(unchanged);
  });

  it.each(['history_quoted', 'report_issued', 'unknown'] as const)('selector不能把%s充作报告主要临床日期，历史项目有出处仍可保留自身日期', (role) => {
    const f = fixture();
    const other = f.excerpt('synthetic-noncurrent-date', 'date', '合成原件另一日期槽');
    f.manifest.spans.push(other);
    const ref = { sourceSpanId: other.id, quote: other.quote };
    f.metadata.times.push({ value: '2025-02-11', precision: 'day', role, evidence: [ref] });
    f.metadata.primaryClinicalTimeIndex = 1;
    expect(validateDirectOriginalExtraction(f.extraction, f.manifest)).toEqual(['direct_original_primary_clinical_time_invalid']);
    expect(evaluateDirectOriginalObservationCandidate(f.candidate, f.manifest, f.options).decision).not.toBe('reject');
    const historicalCandidate = { ...f.candidate, clinicalDate: '2025-02-11', evidence: [f.candidate.evidence[0]!, ref] };
    expect(evaluateDirectOriginalObservationCandidate(historicalCandidate, f.manifest, f.options).decision === 'reject')
      .toBe(role !== 'history_quoted');
  });

  it('越界selector拒绝，即使已有其他可用日期也不替模型按第一项补选', () => {
    const f = fixture(); f.metadata.primaryClinicalTimeIndex = 99;
    expect(validateDirectOriginalExtraction(f.extraction, f.manifest)).toEqual(['direct_original_primary_clinical_time_invalid']);
    expect(f.metadata.primaryClinicalTimeIndex).toBe(99);
    expect(evaluateDirectOriginalObservationCandidate(f.candidate, f.manifest, f.options).decision).not.toBe('reject');
  });

  it.each(['hash', 'object', 'page', 'uncertain', 'role', 'foreign-document', 'changed-quote'] as const)(
    '主要日期的%s技术出处不成立时拒绝selector，不靠日期文本猜正确值', (kind) => {
      const f = fixture(); f.metadata.primaryClinicalTimeIndex = 0;
      if (kind === 'hash') f.date.modelEvidence!.originalSha256 = 'b'.repeat(64);
      if (kind === 'object') f.date.modelEvidence!.originalSourceObjectId = 'another-object';
      if (kind === 'page') f.date.page = 2;
      if (kind === 'uncertain') { f.date.readability = 'partial'; f.date.modelEvidence!.clarity = 'uncertain'; }
      if (kind === 'role') f.date.modelEvidence!.role = 'context';
      if (kind === 'foreign-document') f.date.documentId = 'another-document';
      if (kind === 'changed-quote') f.metadata.times[0]!.evidence[0]!.quote = '不存在于该来源的其他引用';
      expect(validateDirectOriginalExtraction(f.extraction, f.manifest)).toContain('direct_original_primary_clinical_time_invalid');
      expect(f.metadata.primaryClinicalTimeIndex).toBe(0);
    });

  it.each(['hash', 'object', 'page', 'uncertain', 'ocr'] as const)('无效 %s 来源不能变成已确认事实', (kind) => {
    const f = fixture();
    if (kind === 'hash') f.finding.modelEvidence!.originalSha256 = 'b'.repeat(64);
    if (kind === 'object') f.finding.modelEvidence!.originalSourceObjectId = 'another-object';
    if (kind === 'page') f.finding.page = 2;
    if (kind === 'uncertain') { f.finding.readability = 'partial'; f.finding.modelEvidence!.clarity = 'uncertain'; }
    if (kind === 'ocr') delete f.finding.modelEvidence;
    expect(evaluateDirectOriginalObservationCandidate(f.candidate, f.manifest, f.options).decision).toBe('reject');
  });

  it('逐页覆盖是完整报告门禁；同一局部候选数值问题不升级成整份结构失败', () => {
    const f = fixture();
    expect(validateDirectOriginalExtraction({ ...f.extraction, coveredSourceSpanIds: [] }, f.manifest))
      .toContain('direct_original_page_coverage_incomplete');
    f.extraction.candidates[0] = { ...f.candidate, value: { kind: 'numeric', rawText: '4', decimal: '5', comparator: 'eq' } };
    expect(validateDirectOriginalExtraction(f.extraction, f.manifest)).toEqual([]);
  });

  it('未填写只保留引用，不伪造正常值或可分析的空值事实', () => {
    const f = fixture();
    expect(evaluateDirectOriginalObservationCandidate({ ...f.candidate, value: { kind: 'unknown', rawText: null, reason: 'original_blank' } },
      f.manifest, f.options)).toEqual({ decision: 'reject', reasons: ['value_unknown'] });
  });

  it('异常标记必须由模型输出已定义枚举，不将原符号或文字静默丢成unknown', () => {
    const f = fixture();
    for (const reportedAbnormalFlag of ['+', '-', 'high-ish']) {
      expect(evaluateDirectOriginalObservationCandidate({ ...f.candidate, reportedAbnormalFlag }, f.manifest, f.options))
        .toMatchObject({ decision: 'reject', reasons: ['direct_original_abnormal_representation_conflict'] });
    }
    for (const reportedAbnormalFlag of [null, 'unknown', 'normal', 'high']) {
      expect(evaluateDirectOriginalObservationCandidate({ ...f.candidate, reportedAbnormalFlag }, f.manifest, f.options).decision)
        .not.toBe('reject');
    }
  });

  it('来源稳定键不依赖候选localKey或新回执span编号，仍区分不同原页', () => {
    const f = fixture();
    const initial = resolveDirectOriginalSourceBinding(f.candidate, f.manifest);
    const copy = { ...f.finding, id: 'another-model-span', modelEvidence: { ...f.finding.modelEvidence!, turnId: 'another-turn' } };
    f.manifest.spans.push(copy);
    const ref = { sourceSpanId: copy.id, quote: copy.quote };
    const next = resolveDirectOriginalSourceBinding({ ...f.candidate, localKey: 'new-key', evidence: [ref],
      sourceBinding: { headingEvidence: [], findingEvidence: [ref] } }, f.manifest);
    expect(initial.status).toBe('resolved'); expect(next.status).toBe('resolved');
    if (initial.status === 'resolved' && next.status === 'resolved') expect(next.binding.key).toBe(initial.binding.key);
    const second = { ...f.page, id: 'another-page', page: 2 };
    f.manifest.spans.push(second); copy.page = 2; copy.blockId = `model-original-excerpt:${second.id}`;
    copy.modelEvidence!.parentSourceSpanId = second.id;
    const distinct = resolveDirectOriginalSourceBinding({ ...f.candidate, evidence: [ref], sourceBinding: { headingEvidence: [], findingEvidence: [ref] } }, f.manifest);
    if (initial.status === 'resolved' && distinct.status === 'resolved') expect(distinct.binding.key).not.toBe(initial.binding.key);
  });
});
