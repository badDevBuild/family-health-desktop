import { describe, expect, it } from 'vitest';
import type { ExtractionResult } from '@contracts';
import {
  ACCEPTANCE_RULES_VERSION,
  DERIVED_PROMPT_VERSION,
  DERIVED_SAFETY_RULES_VERSION,
  EXTRACTION_PROMPT_VERSION,
  buildAdjudicateAbnormalFlagsPrompt,
  buildAdjudicateFactDifferencesPrompt,
  buildAnalyzePrompt,
  buildExtractPrompt,
  buildRecoverCoveragePrompt,
  buildRepairFactValidationPrompt,
  buildRepairDerivedPrompt,
  buildReviewDerivedPrompt,
  buildReviewFactsPrompt,
  promptMetaForStage
} from './index.js';

const sourcePackage = JSON.stringify({
  documentId: 'doc-1',
  spans: [{ sourceSpanId: 'span-visual-1', quote: 'LDL-C 4.2' }]
});

const extraction: ExtractionResult = {
  schemaVersion: 1,
  documentId: 'doc-1',
  subject: { reportedName: null, evidence: [], confidence: 'absent' },
  coveredSourceSpanIds: ['span-visual-1'],
  candidates: []
};

function instructionPart(prompt: string): string {
  const marker = '\n\n## 输入\n';
  const index = prompt.indexOf(marker);
  expect(index).toBeGreaterThan(0);
  return prompt.slice(0, index);
}

describe('pipeline prompts', () => {
  it('版本号与阶段签名保持一致', () => {
    expect(EXTRACTION_PROMPT_VERSION).toBe('extract-v3');
    expect(DERIVED_PROMPT_VERSION).toBe('derived-v2');
    expect(promptMetaForStage('extract')).toEqual({
      promptVersion: 'extract-v3',
      rulesVersion: ACCEPTANCE_RULES_VERSION
    });
    expect(promptMetaForStage('analyze')).toEqual({
      promptVersion: 'derived-v2',
      rulesVersion: DERIVED_SAFETY_RULES_VERSION
    });
  });

  it('提取提示词把数据块放在说明之后，并锁定关键硬规则', () => {
    const prompt = buildExtractPrompt({ personDisplayName: '测试成员', sourcePackage });
    const instructions = instructionPart(prompt);
    expect(instructions).toContain('你是健康报告事实提取器');
    expect(instructions).toContain('位于“趋势”列');
    expect(instructions).toContain('不得根据目标成员显示名反推');
    expect(instructions).not.toContain('SOURCE_PACKAGE=');
    expect(prompt).toContain('## 输入\nSOURCE_PACKAGE=');
    expect(prompt).toContain('span-visual-1');
    expect(prompt).toContain('测试成员');
  });

  it('独立复核不得把上一轮结果当成正确答案', () => {
    const prompt = buildReviewFactsPrompt({
      sourcePackage,
      candidateToReview: JSON.stringify(extraction)
    });
    expect(instructionPart(prompt)).toContain('不得因为前一份候选存在就默认接受');
    expect(prompt).toContain('CANDIDATE_TO_REVIEW=');
  });

  it('覆盖补救要求整篇重读并列出缺失片段', () => {
    const prompt = buildRecoverCoveragePrompt({
      stage: 'review_facts',
      sourcePackage,
      expectedSpanIds: ['span-visual-1', 'span-2'],
      missingSpanIds: ['span-2'],
      previousResult: extraction,
      candidateToReview: extraction
    });
    expect(instructionPart(prompt)).toContain('你是独立事实复核器');
    expect(instructionPart(prompt)).toContain('不是只检查缺失片段');
    expect(prompt).toContain('REQUIRED_SOURCE_SPAN_IDS=');
    expect(prompt).toContain('PREVIOUSLY_MISSING_SOURCE_SPAN_IDS=');
    expect(prompt).toContain('"span-2"');
  });

  it('异常标记裁决只处理目标分歧', () => {
    const prompt = buildAdjudicateAbnormalFlagsPrompt({
      sourcePackage,
      expectedSpanIds: ['span-visual-1'],
      differences: [{
        localKey: 'ldl-1',
        itemName: 'LDL-C',
        fields: ['reportedAbnormalFlag'],
        firstCandidate: null,
        secondCandidate: null
      }],
      first: extraction,
      second: extraction
    });
    expect(instructionPart(prompt)).toContain('健康报告事实分歧裁决器');
    expect(instructionPart(prompt)).toContain('位于“趋势”列');
    expect(prompt).toContain('TARGET_DIFFS=');
  });

  it('核心事实分歧一次性裁决全部目标且禁止创造第三个答案', () => {
    const prompt = buildAdjudicateFactDifferencesPrompt({
      sourcePackage,
      differences: [{
        localKey: 'ldl-1',
        itemName: 'LDL-C',
        fields: ['value'],
        firstCandidate: null,
        secondCandidate: null
      }]
    });
    const instructions = instructionPart(prompt);
    expect(instructions).toContain('一次性裁决全部核心差异');
    expect(instructions).toContain('不得创建第三个数值');
    expect(prompt).toContain('"differenceIndex":0');
  });

  it('事实证据修复一次接收全部本地校验错误且不得改动其他候选', () => {
    const prompt = buildRepairFactValidationPrompt({
      sourcePackage,
      validationErrors: [{ localKey: 'ldl-1', itemName: 'LDL-C', reasons: ['unit_not_bound_to_measurement'] }],
      candidate: extraction
    });
    const instructions = instructionPart(prompt);
    expect(instructions).toContain('一次性修复全部本地证据校验错误');
    expect(instructions).toContain('其他候选必须原样保留');
    expect(prompt).toContain('VALIDATION_ERRORS=');
  });

  it('派生分析包含器官归类、叙事分级和去标识化搜索规则', () => {
    const prompt = buildAnalyzePrompt(JSON.stringify({
      personId: 'p1',
      userReportedNotes: [{ text: '本人补充：近期作息不规律' }]
    }));
    const instructions = instructionPart(prompt);
    expect(instructions).toContain('cardiovascular 心血管');
    expect(instructions).toContain('association 关联层');
    expect(instructions).toContain('搜索词必须去标识化');
    expect(instructions).toContain('不得建议开始、停止、调整任何药物');
    expect(prompt).toContain('userReportedNotes');
    expect(prompt).toContain('本人补充：近期作息不规律');
  });

  it('结构修复禁止网页搜索并保留校验错误', () => {
    const prompt = buildRepairDerivedPrompt({
      validationErrors: ['evidence_mismatch:claim-1'],
      factPackage: '{}',
      candidate: '{}'
    });
    expect(instructionPart(prompt)).toContain('不得使用网页搜索');
    expect(prompt).toContain('VALIDATION_ERRORS=');
    expect(prompt).toContain('evidence_mismatch:claim-1');
  });

  it('安全复核要求逐项覆盖 claim 与 guidance', () => {
    const prompt = buildReviewDerivedPrompt({
      factPackage: '{}',
      candidate: '{"claims":[]}'
    });
    expect(instructionPart(prompt)).toContain('必须恰好覆盖候选中的每个 claimId 和 guidanceId');
    expect(instructionPart(prompt)).toContain('搜索词必须去标识化');
    expect(prompt).toContain('DERIVED_CANDIDATE=');
  });
});
