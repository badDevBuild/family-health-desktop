/**
 * 已验证可继续阅读的综合版本，包含当前生成版本。
 * 阅读兼容与生成缓存分开：旧版仍标记为此前解读，不取得新版生成或采纳权限。
 * 每次发布新规则都登记完整版本对；契约测试要求当前版本已登记，避免升级后漏掉上一版。
 */
export const READABLE_ASSESSMENT_VERSIONS = [
  ['member-assessment-v11', 'lean-health-v3.9+assessment-validation-v10'],
  ['member-assessment-v12', 'lean-health-v3.10+assessment-validation-v11'],
  ['member-assessment-v12', 'lean-health-v3.11+assessment-validation-v12'],
  ['member-assessment-v12', 'lean-health-v3.12+assessment-validation-v13'],
  ['member-assessment-v13', 'lean-health-v3.12+assessment-validation-v13'],
  ['member-assessment-v14', 'lean-health-v3.13+assessment-validation-v13'],
  ['member-assessment-v14', 'lean-health-v3.13+assessment-validation-v14'],
  ['member-assessment-v14', 'lean-health-v3.15+assessment-validation-v15'],
  ['member-assessment-v15', 'lean-health-v3.16+assessment-validation-v15'],
  ['member-assessment-v16', 'lean-health-v3.16+assessment-validation-v16'],
  ['member-assessment-v16', 'lean-health-v3.17+assessment-validation-v17'],
  ['member-assessment-v17', 'lean-health-v3.17+assessment-validation-v17'],
  ['member-assessment-v18', 'lean-health-v3.18+assessment-validation-v18'],
  ['member-assessment-v19', 'lean-health-v3.18+assessment-validation-v18'],
  ['member-assessment-v23', 'lean-health-v3.25+assessment-validation-v25'],
  ['member-assessment-v24', 'lean-health-v3.26+assessment-validation-v25'],
  ['member-assessment-v25', 'lean-health-v3.27+assessment-validation-v26'],
  ['member-assessment-v26', 'lean-health-v3.28+assessment-validation-v26'],
  ['member-assessment-v27', 'lean-health-v3.30+assessment-validation-v26'],
  ['member-assessment-v27', 'lean-health-v3.31+assessment-validation-v26'],
  ['member-assessment-v28', 'lean-health-v3.32+assessment-validation-v26'],
  ['member-assessment-v29', 'lean-health-v3.33+assessment-validation-v26'],
  ['member-assessment-v30', 'lean-health-v3.34+assessment-validation-v27'],
  ['member-assessment-v31', 'lean-health-v3.35+assessment-validation-v27'],
  ['member-assessment-v32', 'lean-health-v3.36+assessment-validation-v27'],
  ['member-assessment-v33', 'lean-health-v3.37+assessment-validation-v28'],
  ['member-assessment-v34', 'lean-health-v3.38+assessment-validation-v29'],
  ['member-assessment-v35', 'lean-health-v3.39+assessment-validation-v30'],
  ['member-assessment-v35', 'lean-health-v3.40+assessment-validation-v30'],
  ['member-assessment-v36', 'lean-health-v3.41+assessment-validation-v31'],
  ['member-assessment-v36', 'lean-health-v3.42+assessment-validation-v32'],
  ['member-assessment-v37', 'lean-health-v3.43+assessment-validation-v33'],
  ['member-assessment-v38', 'lean-health-v3.44+assessment-validation-v33'],
  ['member-assessment-v39', 'lean-health-v3.45+assessment-validation-v33'],
  ['member-assessment-v40', 'lean-health-v3.46+assessment-validation-v33'],
  ['member-assessment-v41', 'lean-health-v3.47+assessment-validation-v33'],
  ['member-assessment-v42', 'lean-health-v3.48+assessment-validation-v33'],
  ['member-assessment-v43', 'lean-health-v3.49+assessment-validation-v34'],
  ['member-assessment-v44', 'lean-health-v3.50+assessment-validation-v35'],
  ['member-assessment-v45', 'lean-health-v3.51+assessment-validation-v36'],
  ['member-assessment-v45', 'lean-health-v3.52+assessment-validation-v37'],
  ['member-assessment-v45', 'lean-health-v3.53+assessment-validation-v38'],
  ['member-assessment-v45', 'lean-health-v3.54+assessment-validation-v38'],
  ['member-assessment-v45', 'lean-health-v3.55+assessment-validation-v38'],
  ['member-assessment-v46', 'lean-health-v3.56+assessment-validation-v39'],
  ['member-assessment-v47', 'lean-health-v3.57+assessment-validation-v40'],
  ['member-assessment-v48', 'lean-health-v3.58+assessment-validation-v40'],
  ['member-assessment-v49', 'lean-health-v3.59+assessment-validation-v41'],
  ['member-assessment-v50', 'lean-health-v3.60+assessment-validation-v42'],
  ['member-assessment-v51', 'lean-health-v3.61+assessment-validation-v43']
] as const;

const readableVersionKeys = new Set<string>(READABLE_ASSESSMENT_VERSIONS.map((pair) => JSON.stringify(pair)));

/** 仅识别登记过的完整配对，不按版本数字大小放行未知规则。 */
export function isReadableAssessmentVersion(promptVersion: string, rulesVersion: string): boolean {
  return readableVersionKeys.has(JSON.stringify([promptVersion, rulesVersion]));
}
