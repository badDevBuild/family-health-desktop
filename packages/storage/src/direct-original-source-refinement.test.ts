import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { assembleDirectOriginalReadingRepair, directOriginalReadingRepairSchema, directOriginalReadingResultSchema,
  type DirectOriginalReadingResult, type ObservationCandidate, type SourceManifest, type SourceSpan } from '@contracts';
import { isVerifiedDirectOriginalSourceBinding, projectDirectOriginalLegacyWhitespaceBindingIdentity,
  resolveDirectOriginalSourceBinding, stableHash, type ResolvedReportSourceBinding } from '@core';
import { WorkspaceStore, type PublishFactsInput } from './index.js';
import { DIRECT_ORIGINAL_SOURCE_REFINEMENT_VERSION, directOriginalSourceRefinementReviewSignature,
  directOriginalSourceRefinementPartSignature, assembleDirectOriginalRefinementParts,
  verifyDirectOriginalSourceRefinementReview, type DirectOriginalSourceRefinementReceipt,
  type DirectOriginalSourceRefinementReview } from './direct-original-source-refinement.js';

function fixture() {
  const documentId = 'synthetic-document';
  const first: DirectOriginalReadingResult = directOriginalReadingResultSchema.parse({
    schemaVersion: 1, documentId,
    pageReadings: [{ sourceSpanId: 'page-1', status: 'read' }, { sourceSpanId: 'page-2', status: 'read' }],
    sourceExcerpts: [{ localKey: 'e-finding', pageSourceSpanId: 'page-2', quote: '合成文字结果。', role: 'instruction', clarity: 'clear' }],
    extraction: { schemaVersion: 1, documentId, subject: { reportedName: null, confidence: 'absent', evidence: [] },
      reportMetadata: null, coveredSourceSpanIds: ['page-1', 'page-2'], candidates: [{
        localKey: 'c-result', originalName: '合成安排', standardNameCandidate: null,
        value: { kind: 'text', rawText: '合成文字结果。' }, unitRaw: null, referenceRangeRaw: null,
        reportedAbnormalFlag: null, specimen: null, method: null, bodySite: null, clinicalDate: null,
        evidence: [{ sourceSpanId: 'e-finding', quote: '合成文字结果。' }],
        sourceBinding: { headingEvidence: [], findingEvidence: [{ sourceSpanId: 'e-finding', quote: '合成文字结果。', sourceRole: 'primary' }] }, issues: []
      }] }
  });
  const candidate = { ...first.extraction.candidates[0]!, sourceBinding: {
    headingEvidence: [{ sourceSpanId: 'e-heading', quote: '合成栏目甲' }],
    findingEvidence: [{ sourceSpanId: 'e-finding', quote: '合成文字结果。', sourceRole: 'primary' as const }]
  } };
  const review: DirectOriginalSourceRefinementReview = {
    sourceObjectId: 'synthetic-original', originalSha256: 'a'.repeat(64), factRevision: 3, firstReading: first,
    repair: { schemaVersion: 1, documentId, originalReadingHash: stableHash(first), results: [
      { targetId: 'c-result', action: 'replace', replacement: { nodeType: 'candidate', value: candidate } },
      { targetId: 'e-finding', action: 'replace', replacement: { nodeType: 'excerpt', value: {
        localKey: 'e-finding', pageSourceSpanId: 'page-2', quote: '合成栏目甲续页：合成文字结果。保留其后条件。', role: 'instruction', clarity: 'clear' } } },
      { targetId: 'e-heading', action: 'replace', replacement: { nodeType: 'excerpt', value: {
        localKey: 'e-heading', pageSourceSpanId: 'page-1', quote: '合成栏目甲', role: 'heading', clarity: 'clear' } } }
    ], sourceMappings: [{ candidateKey: 'c-result', comparisonRecordKey: 'ro_record_1', relation: 'same_original_field' }] },
    targets: [{ targetId: 'c-result', nodeType: 'candidate' }, { targetId: 'e-finding', nodeType: 'excerpt' },
      { targetId: 'e-heading', nodeType: 'excerpt' }],
    allowedPageSourceSpanIds: ['page-1', 'page-2'],
    refinementTargets: [{ candidateKey: 'c-result', comparisonRecordKey: 'ro_record_1', recordId: 'stored-result', recordRevision: 1,
      recordHash: 'b'.repeat(64) }],
    firstTransmissionId: 'transmission-first', firstInputSignature: 'c'.repeat(64),
    repairTransmissionId: 'transmission-repair', repairInputSignature: ''
  };
  review.repair = directOriginalReadingRepairSchema.parse(review.repair);
  review.repairInputSignature = directOriginalSourceRefinementReviewSignature(review);
  const receipts: DirectOriginalSourceRefinementReceipt[] = [
    { transmissionId: review.firstTransmissionId, stage: 'extract', proofVersion: DIRECT_ORIGINAL_SOURCE_REFINEMENT_VERSION,
      inputSignature: review.firstInputSignature, outputHash: stableHash(first), threadId: 'thread-first', turnId: 'turn-first' },
    { transmissionId: review.repairTransmissionId, stage: 'repair_extraction', proofVersion: DIRECT_ORIGINAL_SOURCE_REFINEMENT_VERSION,
      inputSignature: review.repairInputSignature, outputHash: stableHash(review.repair), threadId: 'thread-repair', turnId: 'turn-repair' }
  ];
  const manifest: SourceManifest = { id: 'synthetic-manifest', sourceObjectId: review.sourceObjectId, sha256: review.originalSha256,
    mediaType: 'application/pdf', originalDisplayName: '合成原件.pdf', totalUnits: 2, coveredUnitIndexes: [0, 1],
    normalizerVersion: 'direct-original-preparation-v1', conversionWarnings: [], createdAt: '2026-01-01T00:00:00Z',
    spans: [1, 2].map((page): SourceSpan => ({ id: `page-${page}`, documentId, spanKind: 'page', page,
      blockId: `direct-original-page:${page}`, lineStart: null, lineEnd: null, quote: null, readability: 'clear' })) };
  const assembled = assembleDirectOriginalReadingRepair({ original: first, repair: review.repair,
    originalReadingHash: stableHash(first), targets: review.targets, allowedPageSourceSpanIds: review.allowedPageSourceSpanIds });
  for (const excerpt of assembled.sourceExcerpts) {
    const receipt = receipts[1]!;
    manifest.spans.push({ id: `model-original-${stableHash({ documentId, originalSha256: manifest.sha256,
      parentId: excerpt.pageSourceSpanId, localKey: excerpt.localKey,
      receipt: { threadId: receipt.threadId, turnId: receipt.turnId }, quote: excerpt.quote, role: excerpt.role }).slice(0, 40)}`,
    documentId, spanKind: 'block', page: excerpt.pageSourceSpanId === 'page-1' ? 1 : 2,
    blockId: `model-original-excerpt:${excerpt.pageSourceSpanId}`, lineStart: null, lineEnd: null, quote: excerpt.quote,
    readability: 'clear', modelEvidence: { version: 1, engine: 'codex-original-reading-v1', modelId: 'gpt-6.1-sol',
      threadId: receipt.threadId, turnId: receipt.turnId, originalSha256: manifest.sha256,
      originalSourceObjectId: manifest.sourceObjectId, parentSourceSpanId: excerpt.pageSourceSpanId,
      inputKind: 'image', role: excerpt.role, clarity: excerpt.clarity } });
  }
  return { review, receipts, manifest, documentId, factRevision: 3 };
}

describe('正式来源补齐回执与原页物化核验', () => {
  it('真实两轮回执可将短引用映射到扩大原句及前页栏目，医疗内容保持原样', () => {
    const f = fixture(); const before = structuredClone(f);
    const result = verifyDirectOriginalSourceRefinementReview(f);
    expect(result).toHaveLength(1);
    expect(result[0]!.target).toEqual(f.review.refinementTargets[0]);
    expect(result[0]!.candidate.value).toEqual(f.review.firstReading.extraction.candidates[0]!.value);
    expect(result[0]!.candidate.evidence[0]!.sourceSpanId).toMatch(/^model-original-/);
    expect(result[0]!.candidate.sourceBinding!.headingEvidence[0]!.sourceSpanId).toMatch(/^model-original-/);
    expect(f).toEqual(before);
  });

  it.each(['missing_first', 'missing_repair', 'wrong_stage', 'wrong_version', 'wrong_input', 'wrong_output',
    'same_transmission', 'same_thread', 'same_turn', 'empty_thread', 'wrong_original', 'wrong_object',
    'wrong_revision', 'wrong_document', 'incomplete_pages', 'extra_allowed_page', 'tampered_target',
    'missing_materialized', 'forged_span_id', 'span_wrong_turn', 'span_wrong_parent', 'span_wrong_hash', 'span_wrong_model', 'span_wrong_engine'] as const)(
    '%s不能借用、伪造或放宽来源补齐权限', (mode) => {
      const f = fixture();
      switch (mode) {
        case 'missing_first': f.receipts.shift(); break;
        case 'missing_repair': f.receipts.pop(); break;
        case 'wrong_stage': f.receipts[1]!.stage = 'analyze'; break;
        case 'wrong_version': f.receipts[1]!.proofVersion = 'legacy'; break;
        case 'wrong_input': f.receipts[1]!.inputSignature = 'f'.repeat(64); break;
        case 'wrong_output': f.receipts[1]!.outputHash = 'f'.repeat(64); break;
        case 'same_transmission': f.review.repairTransmissionId = f.review.firstTransmissionId; break;
        case 'same_thread': f.receipts[1]!.threadId = f.receipts[0]!.threadId; break;
        case 'same_turn': f.receipts[1]!.turnId = f.receipts[0]!.turnId; break;
        case 'empty_thread': f.receipts[1]!.threadId = ''; break;
        case 'wrong_original': f.manifest.sha256 = 'f'.repeat(64); break;
        case 'wrong_object': f.manifest.sourceObjectId = 'other-original'; break;
        case 'wrong_revision': f.factRevision++; break;
        case 'wrong_document': f.documentId = 'other-document'; break;
        case 'incomplete_pages': f.review.firstReading.pageReadings.pop(); break;
        case 'extra_allowed_page': f.review.allowedPageSourceSpanIds.push('other-page'); break;
        case 'tampered_target': f.review.refinementTargets[0]!.recordId = 'other-record'; break;
        case 'missing_materialized': f.manifest.spans.pop(); break;
        case 'forged_span_id': f.manifest.spans[2]!.id = 'forged-source'; break;
        case 'span_wrong_turn': f.manifest.spans[2]!.modelEvidence!.turnId = 'other-turn'; break;
        case 'span_wrong_parent': f.manifest.spans[2]!.modelEvidence!.parentSourceSpanId = 'other-page'; break;
        case 'span_wrong_hash': f.manifest.spans[2]!.modelEvidence!.originalSha256 = 'f'.repeat(64); break;
        case 'span_wrong_model': f.manifest.spans[2]!.modelEvidence!.modelId = 'synthetic-other-model'; break;
        case 'span_wrong_engine': (f.manifest.spans[2]!.modelEvidence! as { engine: string }).engine = 'synthetic-other-engine'; break;
      }
      expect(() => verifyDirectOriginalSourceRefinementReview(f)).toThrow();
    });

  it('uncertain关系没有补齐授权；同一旧行或候选的竞争映射直接拒绝', () => {
    const f = fixture(); f.review.repair.sourceMappings![0]!.relation = 'uncertain';
    f.receipts[1]!.outputHash = stableHash(f.review.repair);
    expect(verifyDirectOriginalSourceRefinementReview(f)).toEqual([]);
    f.review.repair.sourceMappings!.push({ candidateKey: 'c-result', comparisonRecordKey: 'ro_record_2', relation: 'same_original_field' });
    f.receipts[1]!.outputHash = stableHash(f.review.repair);
    expect(() => verifyDirectOriginalSourceRefinementReview(f)).toThrow('DIRECT_ORIGINAL_SOURCE_MAPPING_NOT_UNIQUE');
  });

  it('未点名的旧记录和候选不能借专用映射扩大范围', () => {
    for (const key of ['candidateKey', 'comparisonRecordKey'] as const) {
      const f = fixture(); f.review.repair.sourceMappings![0]![key] = 'not-authorized';
      f.receipts[1]!.outputHash = stableHash(f.review.repair);
      expect(() => verifyDirectOriginalSourceRefinementReview(f)).toThrow('DIRECT_ORIGINAL_SOURCE_REFINEMENT_REVIEW_INVALID');
    }
  });
});

function partitionedFixture() {
  const f = fixture();
  const originalTargets = [...f.review.targets];
  const repair = structuredClone(f.review.repair);
  f.review.targets.push({ targetId: 'subject', nodeType: 'subject' });
  f.review.repairPlan = [
    { index: 0, targets: originalTargets, refinementTargets: f.review.refinementTargets, promptHash: 'd'.repeat(64) },
    { index: 1, targets: [{ targetId: 'subject', nodeType: 'subject' }], refinementTargets: [], promptHash: 'e'.repeat(64) }
  ];
  f.review.repairParts = [
    { index: 0, repair, repairTransmissionId: 'transmission-repair', repairInputSignature: '' },
    { index: 1, repair: { schemaVersion: 1, documentId: f.documentId, originalReadingHash: stableHash(f.review.firstReading),
      results: [{ targetId: 'subject', action: 'unchanged', replacement: null }] },
    repairTransmissionId: 'transmission-repair-2', repairInputSignature: '' }
  ];
  for (const part of f.review.repairParts) {
    part.repairInputSignature = directOriginalSourceRefinementPartSignature(f.review, f.review.repairPlan, part.index);
  }
  f.review.repair = assembleDirectOriginalRefinementParts({ ...f.review,
    repairPlan: f.review.repairPlan, repairParts: f.review.repairParts });
  f.review.repairInputSignature = directOriginalSourceRefinementReviewSignature(f.review);
  f.receipts[1]!.inputSignature = f.review.repairParts[0]!.repairInputSignature;
  f.receipts.push({ ...f.receipts[1]!, transmissionId: 'transmission-repair-2', threadId: 'thread-repair-2', turnId: 'turn-repair-2',
    inputSignature: f.review.repairParts[1]!.repairInputSignature, outputHash: stableHash(f.review.repairParts[1]!.repair) });
  return f;
}

describe('补核分包回执完整性', () => {
  it('每包真实独立回执、同一全量计划和完整目标覆盖共同产生一份正式映射', () => {
    const f = partitionedFixture(); const before = structuredClone(f);
    expect(verifyDirectOriginalSourceRefinementReview(f)).toHaveLength(1);
    expect(f).toEqual(before);
  });

  it('候选对只读旧对照仍不确定时保留说明，不冒充CAS许可也不拖停其他分包', () => {
    const f = partitionedFixture();
    f.review.refinementTargets = [];
    f.review.repairPlan![0]!.refinementTargets = [];
    f.review.repairParts![0]!.repair.sourceMappings![0]!.relation = 'uncertain';
    for (const part of f.review.repairParts!) {
      part.repairInputSignature = directOriginalSourceRefinementPartSignature(f.review, f.review.repairPlan!, part.index);
      const receipt = f.receipts.find((entry) => entry.transmissionId === part.repairTransmissionId)!;
      receipt.inputSignature = part.repairInputSignature; receipt.outputHash = stableHash(part.repair);
    }
    f.review.repair = assembleDirectOriginalRefinementParts({ ...f.review,
      repairPlan: f.review.repairPlan!, repairParts: f.review.repairParts! });
    f.review.repairInputSignature = directOriginalSourceRefinementReviewSignature(f.review);
    expect(verifyDirectOriginalSourceRefinementReview(f)).toEqual([]);
  });

  it.each(['missing_receipt', 'wrong_part_output', 'wrong_part_input', 'changed_plan', 'missing_part',
    'repeated_part', 'reordered_part', 'reused_turn', 'extra_target', 'different_root', 'tampered_aggregate',
    'moved_mapping', 'incomplete_mapping', 'forged_part_origin'] as const)('%s拒绝部分成功冒充整包完整验真', (mode) => {
    const f = partitionedFixture(); const plan = f.review.repairPlan!; const parts = f.review.repairParts!;
    switch (mode) {
      case 'missing_receipt': f.receipts.pop(); break;
      case 'wrong_part_output': f.receipts[2]!.outputHash = '0'.repeat(64); break;
      case 'wrong_part_input': f.receipts[2]!.inputSignature = '0'.repeat(64); break;
      case 'changed_plan': plan[1]!.promptHash = '0'.repeat(64); break;
      case 'missing_part': parts.pop(); break;
      case 'repeated_part': parts[1] = parts[0]!; break;
      case 'reordered_part': parts.reverse(); break;
      case 'reused_turn': f.receipts[2]!.turnId = f.receipts[1]!.turnId; break;
      case 'extra_target': plan[1]!.targets.push({ targetId: 'metadata', nodeType: 'metadata' }); break;
      case 'different_root': f.review.factRevision += 1; break;
      case 'tampered_aggregate': f.review.repair.results.pop(); break;
      case 'moved_mapping': plan[1]!.refinementTargets = plan[0]!.refinementTargets; plan[0]!.refinementTargets = []; break;
      case 'incomplete_mapping': plan[0]!.refinementTargets = []; break;
      case 'forged_part_origin': f.manifest.spans[2]!.modelEvidence!.turnId = 'turn-repair-2'; break;
    }
    expect(() => verifyDirectOriginalSourceRefinementReview(f)).toThrow();
  });

  it('即使最终合并包含所有目标，也不能把共享excerpt与依赖candidate拆到两个独立修改包', () => {
    const f = partitionedFixture(); const plan = f.review.repairPlan!; const parts = f.review.repairParts!;
    const candidateTarget = plan[0]!.targets.shift()!;
    plan[1]!.targets.push(candidateTarget);
    parts[1]!.repair.results.push(parts[0]!.repair.results.shift()!);
    expect(() => assembleDirectOriginalRefinementParts({ ...f.review, repairPlan: plan, repairParts: parts }))
      .toThrow('DIRECT_ORIGINAL_REPAIR_SHARED_EXCERPT_UNAUTHORIZED');
  });

  it('新来源只在另一包回包中出现时，不能被本包的主体或候选提前借用', () => {
    const f = partitionedFixture();
    f.review.repairParts![1]!.repair.results[0] = { targetId: 'subject', action: 'replace', replacement: {
      nodeType: 'subject', value: { reportedName: null, confidence: 'absent',
        evidence: [{ sourceSpanId: 'e-heading', quote: '合成栏目甲' }] } } };
    expect(() => assembleDirectOriginalRefinementParts({ ...f.review,
      repairPlan: f.review.repairPlan!, repairParts: f.review.repairParts! }))
      .toThrow('DIRECT_ORIGINAL_SOURCE_REFINEMENT_REVIEW_INVALID');
  });
});

describe('历史 direct 来源身份摘要的受控恢复', () => {
  type Observation = PublishFactsInput['observations'][number];
  const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
  const legacyText = (value: string) => value.normalize('NFKC').replace(/\s+/gu, '');

  // 只在脱敏测试里重现旧算法，生成独立于当前 matcher/兼容 helper 的已保存 JSON。
  function legacyRange(source: string, quote: string | null) {
    if (quote === null) return { segmentStart: 0, segmentEnd: source.length };
    const offsets: number[] = [];
    let text = '';
    for (let index = 0; index < source.length; index += 1) {
      const normalized = legacyText(source[index]!);
      text += normalized;
      offsets.push(...Array.from({ length: normalized.length }, () => index));
    }
    const start = text.indexOf(legacyText(quote));
    if (start < 0 || text.indexOf(legacyText(quote), start + 1) >= 0) throw new Error('SYNTHETIC_LEGACY_QUOTE_NOT_UNIQUE');
    return { segmentStart: offsets[start]!, segmentEnd: offsets[start + legacyText(quote).length - 1]! + 1 };
  }

  function compatibilityFixture(options: { splitToken?: boolean; nullFinding?: boolean; withoutHeading?: boolean } = {}) {
    const documentId = 'synthetic-legacy-document';
    const page: SourceSpan = { id: 'synthetic-legacy-page', documentId, spanKind: 'page', page: 1,
      blockId: 'direct-original-page:1', lineStart: null, lineEnd: null, quote: null, readability: 'clear' };
    const manifest: SourceManifest = { id: 'synthetic-legacy-manifest', sourceObjectId: 'synthetic-legacy-original',
      sha256: 'e'.repeat(64), mediaType: 'application/pdf', originalDisplayName: '合成历史来源.pdf', totalUnits: 1,
      coveredUnitIndexes: [0], normalizerVersion: 'direct-original-preparation-v1', spans: [page],
      conversionWarnings: [], createdAt: '2026-01-01T00:00:00Z' };
    const excerpt = (id: string, role: NonNullable<SourceSpan['modelEvidence']>['role'], quote: string): SourceSpan => ({
      id, documentId, spanKind: 'block', page: 1, blockId: `model-original-excerpt:${page.id}`,
      lineStart: null, lineEnd: null, quote, readability: 'clear', modelEvidence: {
        version: 1, engine: 'codex-original-reading-v1', modelId: 'synthetic-model', threadId: 'synthetic-thread',
        turnId: 'synthetic-turn', originalSha256: manifest.sha256, originalSourceObjectId: manifest.sourceObjectId,
        parentSourceSpanId: page.id, inputKind: 'image', role, clarity: 'clear' } });
    const first = excerpt('synthetic-legacy-finding-a', 'finding', `合成栏目 甲\n合成项目 甲：${options.splitToken ? '7 1' : '71'} mm / s\n保留其他说明。`);
    const second = excerpt('synthetic-legacy-finding-b', 'instruction', '合成栏目 甲\n合成条件：左侧未见增高 < 3.5 mm\n保留其后条件。');
    const heading = excerpt('synthetic-legacy-heading', 'heading', '合成栏目 甲');
    manifest.spans.push(first, second, heading);
    const findings = [{ sourceSpanId: first.id, quote: options.nullFinding ? null : '71 mm / s' },
      { sourceSpanId: second.id, quote: '左侧未见增高 < 3.5 mm' }];
    const headings = options.withoutHeading ? [] : [{ sourceSpanId: heading.id, quote: heading.quote }];
    const candidate: ObservationCandidate = { localKey: 'synthetic-legacy-candidate', originalName: '合成 项目',
      standardNameCandidate: null, value: { kind: 'text', rawText: '71 mm / s；左侧未见增高 < 3.5 mm' },
      unitRaw: null, referenceRangeRaw: null, reportedAbnormalFlag: null, specimen: null, method: null,
      bodySite: null, clinicalDate: null, evidence: [...findings, ...headings],
      sourceBinding: { findingEvidence: findings, headingEvidence: headings }, issues: [] };
    const units = findings.map((ref) => {
      const span = manifest.spans.find((item) => item.id === ref.sourceSpanId)!;
      return { sourceSpanId: span.id, page: span.page, spanKind: span.spanKind, blockId: span.blockId,
        lineStart: span.lineStart, lineEnd: span.lineEnd, ...legacyRange(span.quote!, ref.quote) };
    });
    const parents = [JSON.stringify([page.id, page.page])];
    const headingKeys = options.withoutHeading ? [] : [digest([page.id, page.page, legacyText(heading.quote!)])];
    const fieldKey = digest([manifest.sourceObjectId, manifest.sha256, documentId, parents,
      legacyText(candidate.originalName).toLowerCase(), headingKeys]);
    const identities = findings.map((ref, index) => {
      const span = manifest.spans.find((item) => item.id === ref.sourceSpanId)!;
      return JSON.stringify([parents[0], span.modelEvidence!.role, legacyText(span.quote!),
        legacyText(span.quote!.slice(0, units[index]!.segmentStart)).length,
        legacyText(span.quote!.slice(0, units[index]!.segmentEnd)).length]);
    }).sort();
    const saved = JSON.parse(JSON.stringify({ version: 1, sourceObjectId: manifest.sourceObjectId,
      sourceSha256: manifest.sha256, documentId, normalizerVersion: manifest.normalizerVersion,
      sourceViewId: `codex-original:${manifest.sha256}`, key: digest([fieldKey, identities]), units,
      directOriginalField: { version: 1, fieldKey, headingKeys } })) as ResolvedReportSourceBinding;
    const observation: Observation = { conceptKey: 'synthetic-concept', originalName: candidate.originalName,
      rawText: candidate.value.rawText!, valueKind: 'text', decimalValue: null, qualifier: null, unit: null,
      referenceRange: null, clinicalDate: null, abnormalFlag: 'unknown', documentId, sourceSpanId: first.id,
      acceptanceId: 'synthetic-acceptance', specimen: null, method: null, bodySite: null,
      evidence: structuredClone(candidate.evidence) };
    // 此方法仅做内存来源校验；不构造 WorkspaceStore，也不打开 SQLite/生产数据。
    const restore = () => (WorkspaceStore.prototype as unknown as {
      restoreStoredDirectSourceRoles(observation: Observation, saved: ResolvedReportSourceBinding, manifest: SourceManifest): Observation;
    }).restoreStoredDirectSourceRoles(observation, saved, manifest);
    return { manifest, first, second, heading, candidate, observation, saved, restore };
  }

  it.each([false, true])('旧删空白 JSON（整段 finding=%s）只能恢复相同原始槽位，并输出当前身份', (nullFinding) => {
    const f = compatibilityFixture({ nullFinding });
    const before = structuredClone({ manifest: f.manifest, observation: f.observation, saved: f.saved });
    const current = resolveDirectOriginalSourceBinding(f.candidate, f.manifest);
    if (current.status !== 'resolved') throw new Error('SYNTHETIC_CURRENT_BINDING_REQUIRED');
    expect(current.binding.key).not.toBe(f.saved.key);
    const legacy = projectDirectOriginalLegacyWhitespaceBindingIdentity(current.binding);
    expect(legacy).toEqual(f.saved);
    expect(isVerifiedDirectOriginalSourceBinding(legacy!)).toBe(false);
    const restored = f.restore();
    expect(restored).not.toBe(f.observation);
    expect(restored.sourceBinding).toEqual(f.candidate.sourceBinding);
    const resolved = resolveDirectOriginalSourceBinding({ ...f.candidate, sourceBinding: restored.sourceBinding }, f.manifest);
    expect(resolved.status === 'resolved' && isVerifiedDirectOriginalSourceBinding(resolved.binding)).toBe(true);
    expect(resolved.status === 'resolved' && resolved.binding.key).toBe(current.binding.key);
    expect({ manifest: f.manifest, observation: f.observation, saved: f.saved }).toEqual(before);
  });

  it('旧算法能拼出的71不能通过当前 token 边界重新获得来源权限', () => {
    const f = compatibilityFixture({ splitToken: true });
    expect(f.saved.units[0]!.segmentStart).toBe(f.first.quote!.indexOf('7 1'));
    expect(resolveDirectOriginalSourceBinding(f.candidate, f.manifest).status).toBe('unresolved');
    expect(f.restore()).toBe(f.observation);
  });

  it('没有历史栏目时只恢复原来的空栏目，不凭同页其他标题补齐字段身份', () => {
    const f = compatibilityFixture({ withoutHeading: true });
    const restored = f.restore();
    expect(restored).not.toBe(f.observation);
    expect(restored.sourceBinding!.headingEvidence).toEqual([]);
  });

  it.each(['first_offset', 'second_offset', 'heading_key', 'heading_text', 'finding_role', 'changed_allowed_role', 'heading_role',
    'original_sha', 'source_object', 'saved_key', 'missing_ref', 'repeated_finding', 'wrong_parent'] as const)(
    '%s变化不能只凭历史 hash 或部分相同槽位恢复', (mode) => {
      const f = compatibilityFixture();
      switch (mode) {
        case 'first_offset': f.saved.units[0]!.segmentStart++; break;
        case 'second_offset': f.saved.units[1]!.segmentEnd--; break;
        case 'heading_key': f.saved.directOriginalField!.headingKeys[0] = 'f'.repeat(64); break;
        case 'heading_text': f.heading.quote = '虚构另一栏目'; break;
        case 'finding_role': f.first.modelEvidence!.role = 'date'; break;
        case 'changed_allowed_role': f.first.modelEvidence!.role = 'instruction'; break;
        case 'heading_role': f.heading.modelEvidence!.role = 'identity'; break;
        case 'original_sha': f.first.modelEvidence!.originalSha256 = 'f'.repeat(64); break;
        case 'source_object': f.second.modelEvidence!.originalSourceObjectId = 'other-original'; break;
        case 'saved_key': f.saved.key = 'f'.repeat(64); break;
        case 'missing_ref': f.observation.evidence.splice(1, 1); break;
        case 'repeated_finding': f.first.quote += '\n71 mm / s'; break;
        case 'wrong_parent': f.first.modelEvidence!.parentSourceSpanId = 'other-page'; break;
      }
      expect(f.restore()).toBe(f.observation);
    });

  it('JSON clone、修改后的当前身份和不清晰原摘录不产生历史兼容摘要', () => {
    const f = compatibilityFixture();
    const current = resolveDirectOriginalSourceBinding(f.candidate, f.manifest);
    if (current.status !== 'resolved') throw new Error('SYNTHETIC_CURRENT_BINDING_REQUIRED');
    expect(projectDirectOriginalLegacyWhitespaceBindingIdentity(structuredClone(current.binding))).toBeNull();
    current.binding.units[0]!.segmentStart++;
    expect(projectDirectOriginalLegacyWhitespaceBindingIdentity(current.binding)).toBeNull();
    f.first.readability = 'partial';
    const partial = resolveDirectOriginalSourceBinding(f.candidate, f.manifest);
    if (partial.status !== 'resolved') throw new Error('SYNTHETIC_PARTIAL_BINDING_REQUIRED');
    expect(projectDirectOriginalLegacyWhitespaceBindingIdentity(partial.binding)).toBeNull();
    expect(f.restore()).toBe(f.observation);
  });
});
