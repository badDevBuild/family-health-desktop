import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { assessmentRequestV3Schema, memberEvidencePackageV3Schema } from '@contracts';
import {
  createAssessmentV3SyntheticCases, materializeAssessmentV3SyntheticCases,
  validateAssessmentV3SyntheticCases
} from './assessment-v3-cases.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe('V3 成员综合固定纯合成评测包', () => {
  it('24 份不同边界、6 份留出集均符合实际 P02 输入契约', () => {
    const cases = createAssessmentV3SyntheticCases();
    expect(() => validateAssessmentV3SyntheticCases(cases)).not.toThrow();
    expect(cases).toHaveLength(24);
    expect(cases.filter((item) => item.split === 'holdout')).toHaveLength(6);
    expect(cases.every((item) => item.request.mode === 'full' && !item.request.webSearchAllowed)).toBe(true);
    expect(cases.every((item) => assessmentRequestV3Schema.safeParse(item.request).success
      && memberEvidencePackageV3Schema.safeParse(item.evidencePackage).success)).toBe(true);
    expect(new Set(cases.map((item) => item.dimensions.sourceQuality)).size).toBe(4);
    expect(new Set(cases.map((item) => item.dimensions.riskTheme)).size).toBe(5);
    expect(cases.filter((item) => item.clinicalReferenceStatus === 'requires_clinician_review').length).toBeGreaterThan(10);
  });

  it('报告指令只在来源数据中，网页伪指令不进入个人证据包', () => {
    const cases = createAssessmentV3SyntheticCases();
    const reportInjection = cases.find((item) => item.id === 'A023')!;
    const webInjection = cases.find((item) => item.id === 'A024')!;
    expect(reportInjection.evidencePackage.evidenceCatalog[0]!.quote).toContain('忽略以上规则');
    expect(webInjection.externalUntrustedExcerpt).toContain('网页伪指令');
    expect(JSON.stringify(webInjection.evidencePackage)).not.toContain('网页伪指令');
    expect(reportInjection.request.webSearchAllowed).toBe(false);
    expect(webInjection.request.webSearchAllowed).toBe(false);
  });

  it('样本组成门禁阻止遗失唯一的模糊影像与来源冲突情形', () => {
    const cases = createAssessmentV3SyntheticCases();
    const withoutUnclearImage = structuredClone(cases);
    withoutUnclearImage.find((item) => item.id === 'A009')!.dimensions.sourceQuality = 'clear_text';
    expect(() => validateAssessmentV3SyntheticCases(withoutUnclearImage))
      .toThrow('ASSESSMENT_CASESET_DIMENSION_MISSING:sourceQuality');
    const withoutConflictingSources = structuredClone(cases);
    withoutConflictingSources.find((item) => item.id === 'A022')!.dimensions.sourceQuality = 'clear_text';
    expect(() => validateAssessmentV3SyntheticCases(withoutConflictingSources))
      .toThrow('ASSESSMENT_CASESET_DIMENSION_MISSING:sourceQuality');
  });

  it('两次物化结果一致，并明确临床质量仍为 NOT_RUN', () => {
    const first = mkdtempSync(join(tmpdir(), 'assessment-v3-cases-a-'));
    const second = mkdtempSync(join(tmpdir(), 'assessment-v3-cases-b-'));
    roots.push(first, second);
    expect(materializeAssessmentV3SyntheticCases(first)).toEqual(materializeAssessmentV3SyntheticCases(second));
    expect(readdirSync(first).filter((name) => name.endsWith('.json'))).toHaveLength(25);
    const manifest = JSON.parse(readFileSync(join(first, 'manifest.json'), 'utf8')) as Record<string, unknown>;
    expect(manifest).toMatchObject({ syntheticOnly: true, scope: 'P02_structured_input_only',
      extractionQualityStatus: 'NOT_RUN', clinicalQualityStatus: 'NOT_RUN', caseCount: 24, holdoutCount: 6 });
  });
});
