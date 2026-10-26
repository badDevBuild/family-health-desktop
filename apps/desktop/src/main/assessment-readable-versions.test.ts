import { describe, expect, it } from 'vitest';
import { MEMBER_ASSESSMENT_PROMPT_VERSION, MEMBER_ASSESSMENT_RULES_VERSION } from './prompts/index.js';
import { isReadableAssessmentVersion, READABLE_ASSESSMENT_VERSIONS } from './assessment-readable-versions.js';

describe('已发布综合的阅读兼容契约', () => {
  it('发布当前生成规则时必须登记完整版本对，以便下一次升级后仍能读取', () => {
    expect(isReadableAssessmentVersion(MEMBER_ASSESSMENT_PROMPT_VERSION, MEMBER_ASSESSMENT_RULES_VERSION)).toBe(true);
  });

  it('保留实际已发布的 v35 解读，不能因安装新版而丢失可读正文', () => {
    expect(isReadableAssessmentVersion('member-assessment-v35', 'lean-health-v3.40+assessment-validation-v30')).toBe(true);
  });

  it('否定语义规则升级仍保留上一版正式综合，不强迫其他成员重新生成', () => {
    expect(isReadableAssessmentVersion('member-assessment-v45', 'lean-health-v3.51+assessment-validation-v36')).toBe(true);
    expect(isReadableAssessmentVersion('member-assessment-v45', 'lean-health-v3.52+assessment-validation-v37')).toBe(true);
    expect(isReadableAssessmentVersion('member-assessment-v45', 'lean-health-v3.53+assessment-validation-v38')).toBe(true);
    expect(isReadableAssessmentVersion('member-assessment-v45', 'lean-health-v3.54+assessment-validation-v38')).toBe(true);
    expect(isReadableAssessmentVersion('member-assessment-v45', 'lean-health-v3.54+assessment-validation-v37')).toBe(false);
    expect(isReadableAssessmentVersion('member-assessment-v45', 'lean-health-v3.52+assessment-validation-v38')).toBe(false);
    expect(isReadableAssessmentVersion('member-assessment-v45', 'lean-health-v3.51+assessment-validation-v37')).toBe(false);
  });

  it.each([
    ['member-assessment-v35', 'lean-health-v3.40+assessment-validation-v33'],
    ['member-assessment-v35', 'lean-health-v3.47+assessment-validation-v33'],
    ['member-assessment-v20', 'lean-health-v3.18+assessment-validation-v18'],
    ['member-assessment-v999', 'lean-health-v3.999+assessment-validation-v999'],
    ['unknown-version', 'lean-health-v3.47+assessment-validation-v33']
  ])('不放行未知或错配的版本：%s / %s', (promptVersion, rulesVersion) => {
    expect(isReadableAssessmentVersion(promptVersion, rulesVersion)).toBe(false);
  });

  it('版本对没有重复登记', () => {
    expect(new Set(READABLE_ASSESSMENT_VERSIONS.map((pair) => JSON.stringify(pair))).size)
      .toBe(READABLE_ASSESSMENT_VERSIONS.length);
  });
});
