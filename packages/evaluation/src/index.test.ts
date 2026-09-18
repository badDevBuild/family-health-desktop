import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createSyntheticGoldDataset,
  evaluateGoldCandidates,
  goldFormats,
  materializeSyntheticGoldDataset,
  validateSyntheticGoldDataset,
  type GoldCandidateField
} from './index.js';

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('固定纯合成金标与安全故障资产', () => {
  it('固定覆盖 40 份来源、1000 个字段、20% 留出集、全部目标格式和至少 15 个故障样例', () => {
    const dataset = createSyntheticGoldDataset();
    const summary = validateSyntheticGoldDataset(dataset);

    expect(summary).toMatchObject({
      caseCount: 40,
      fieldCount: 1_000,
      holdoutCaseCount: 8,
      safetyCaseCount: 18
    });
    expect(goldFormats.every((format) => summary.formats[format] > 0)).toBe(true);
    expect(dataset.cases.every((testCase) => testCase.synthetic && testCase.memberKey.startsWith('synthetic-member-'))).toBe(true);
    expect(dataset.safetyCases.every((testCase) => testCase.synthetic && testCase.mustNot.length > 0)).toBe(true);
  });

  it('可在临时目录物化为不含真实资料的可审查 JSON 包，并生成稳定 manifest 哈希', () => {
    const firstRoot = mkdtempSync(join(tmpdir(), 'family-health-gold-first-'));
    const secondRoot = mkdtempSync(join(tmpdir(), 'family-health-gold-second-'));
    directories.push(firstRoot, secondRoot);

    const first = materializeSyntheticGoldDataset(firstRoot);
    const second = materializeSyntheticGoldDataset(secondRoot);
    expect(first).toEqual(second);
    expect(readdirSync(join(firstRoot, 'cases')).filter((name) => name.endsWith('.json'))).toHaveLength(40);
    expect(JSON.parse(readFileSync(join(firstRoot, 'manifest.json'), 'utf8'))).toMatchObject({
      syntheticOnly: true,
      summary: { fieldCount: 1_000, safetyCaseCount: 18 }
    });
    expect(readFileSync(join(firstRoot, 'safety-cases.json'), 'utf8')).not.toMatch(/token|cookie|authorization header/i);
  });

  it('把精确率、覆盖率、成员错配、伪造证据、诊断升级和处方违规分开计算', () => {
    const dataset = createSyntheticGoldDataset();
    const expectedFields = dataset.cases.flatMap((testCase) => testCase.fields
      .filter((field) => field.expectedAction === 'extract')
      .map((field): GoldCandidateField => ({
        caseId: testCase.id,
        fieldId: field.id,
        status: 'extract',
        valueFingerprint: field.valueFingerprint,
        memberKey: field.memberKey,
        sourceSpanId: field.sourceSpanId,
        ...(field.kind === 'statement_boundary' ? { statementClassification: 'clinical_document_reported' as const } : {})
      })));
    const perfect = evaluateGoldCandidates(dataset, expectedFields);
    expect(perfect).toMatchObject({
      precision: 1,
      coverage: 1,
      memberAttributionErrors: 0,
      fabricatedEvidenceCount: 0,
      diagnosisBoundaryViolations: 0,
      prescriptionViolations: 0
    });

    const first = expectedFields[0]!;
    const unsafe: GoldCandidateField[] = [
      ...expectedFields.slice(1),
      {
        ...first,
        memberKey: 'synthetic-wrong-member',
        sourceSpanId: 'fabricated-span',
        statementClassification: 'ai_confirmed_diagnosis',
        proposedMedicationAction: 'start synthetic prescription'
      },
      {
        caseId: 'G001', fieldId: 'fabricated-field', status: 'extract', valueFingerprint: 'invented',
        memberKey: 'synthetic-member-1', sourceSpanId: 'fabricated-span'
      }
    ];
    const result = evaluateGoldCandidates(dataset, unsafe);
    expect(result.precision).toBeLessThan(1);
    expect(result.coverage).toBeLessThan(1);
    expect(result).toMatchObject({
      memberAttributionErrors: 1,
      fabricatedEvidenceCount: 2,
      diagnosisBoundaryViolations: 1,
      prescriptionViolations: 1
    });
  });
});
