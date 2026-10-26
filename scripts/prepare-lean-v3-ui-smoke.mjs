/* global process */
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative } from 'node:path';

/** 只复制已完成的纯合成回执；不打开数据库、不调用模型、不复制登录或运行时目录。 */
const familyFixtures = {
  'child-vision': '6ada2f40e5a966407d697fd8d894c9554908643f75c550656a3e23b79e6d3237',
  'adult-recent-change': 'f72067dfc6bac1bc0f7cceb4ca1b7d57bb8afd657692dbafee4475ef1b3d5f07',
  'older-bp-kidney': 'cd9417e6f62aa682e9088893412ef652746bbe088fa351d434e9df5c5f2e5920'
};
const familyInputHashes = {
  'child-vision': '1f13fe00c14a69a705fbb4c14631cc07588383a327a146d74fa5ad1c9d7df06c',
  'adult-recent-change': '63d070d33adf00ef4a06ee28c9df81d03acd5e4cd128df24ade5cff298eaad1e',
  'older-bp-kidney': 'e450467ac770852833b90622cb7f4b06b346cbe105ee2a7a22f46bfa581c1760'
};
const supportedFamilyVersions = new Set(['member-assessment-v19', 'member-assessment-v20', 'member-assessment-v21', 'member-assessment-v22', 'member-assessment-v23', 'member-assessment-v24', 'member-assessment-v25', 'member-assessment-v26']);
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const receiptArgument = process.argv.find((argument) => argument.startsWith('--receipt='))?.slice('--receipt='.length);
if (!receiptArgument) throw new Error('SYNTHETIC_VISUAL_RECEIPT_REQUIRED');
if (!lstatSync(receiptArgument).isFile() || lstatSync(receiptArgument).isSymbolicLink()) {
  throw new Error('SYNTHETIC_VISUAL_RECEIPT_PATH_REQUIRED');
}
const receiptPath = realpathSync(receiptArgument);
const sourceDirectory = dirname(receiptPath);
const temporaryRoot = realpathSync(tmpdir());
const familyDirectory = basename(sourceDirectory).startsWith('fhd-lean-v3-full-chain-synthetic-');
if (basename(receiptPath) !== 'receipt.json'
  || dirname(sourceDirectory) !== temporaryRoot
  || (!familyDirectory && !basename(sourceDirectory).startsWith('fhd-lean-v3-visual-smoke-'))) {
  throw new Error('SYNTHETIC_VISUAL_RECEIPT_PATH_REQUIRED');
}

const receiptBytes = readFileSync(receiptPath);
const receipt = JSON.parse(receiptBytes.toString('utf8'));
if (familyDirectory) {
  if (receipt.kind !== 'LEAN_V3_FULL_CHAIN_SYNTHETIC' || receipt.syntheticOnly !== true
    || !Object.hasOwn(familyFixtures, receipt.caseId)
    || receipt.fixtureSha256 !== familyFixtures[receipt.caseId]
    || receipt.syntheticScenarioInput?.sha256 !== receipt.fixtureSha256
    || receipt.scenarioInputSha256 !== familyInputHashes[receipt.caseId]
    || sha256(JSON.stringify({ referenceDate: '2026-09-22', ...receipt.syntheticScenarioInput })) !== receipt.scenarioInputSha256
    || receipt.runStatus !== 'completed' || receipt.sourceUnchanged !== true
    || receipt.chainPublished !== true || receipt.scenarioPassed !== true
    || receipt.finalSnapshotPresent !== true || receipt.automatedContentCheckStatus !== 'PASSED'
    || receipt.extraction?.status !== 'published' || receipt.assessment?.status !== 'published'
    || !supportedFamilyVersions.has(receipt.versions?.MEMBER_ASSESSMENT_PROMPT_VERSION)
    || !/^[a-f0-9]{64}$/.test(receipt.sourceFingerprint?.sha256 ?? '')
    || !Number.isInteger(receipt.sourceFingerprint?.fileCount) || receipt.sourceFingerprint.fileCount < 1
    || !Array.isArray(receipt.scenarioChecks) || receipt.scenarioChecks.length === 0
    || receipt.scenarioChecks.some((check) => check.passed !== true)
    || !Array.isArray(receipt.calls) || receipt.calls.length === 0
    || receipt.calls.some((call) => call.status !== 'completed')
    || !Array.isArray(receipt.finalContentProcessIssues) || receipt.finalContentProcessIssues.length !== 0) {
    throw new Error('COMPLETED_SYNTHETIC_FAMILY_ASSESSMENT_REQUIRED');
  }
  // 校验冻结展示文件，不把后来被改写的 JSON 当作本轮已完成回执。
  for (const name of ['published-snapshot.json', 'presented-snapshot.json', 'member-page-read-models.json']) {
    const path = join(sourceDirectory, name);
    if (receipt[name]?.path !== name || !lstatSync(path).isFile() || lstatSync(path).isSymbolicLink()
      || sha256(readFileSync(path)) !== receipt[name]?.sha256) {
      throw new Error('SYNTHETIC_FAMILY_PRESENTATION_HASH_MISMATCH');
    }
  }
} else if (receipt.kind !== 'P01_P02_IMAGE_SYNTHETIC' || receipt.syntheticOnly !== true
  || receipt.result?.status !== 'published' || receipt.assessment?.status !== 'published') {
  throw new Error('COMPLETED_SYNTHETIC_VISUAL_ASSESSMENT_REQUIRED');
}
const sourceWorkspace = join(sourceDirectory, 'synthetic-workspace');
if (!existsSync(join(sourceWorkspace, 'health.db')) || !existsSync(join(sourceWorkspace, 'vault'))) {
  throw new Error('SYNTHETIC_VISUAL_WORKSPACE_MISSING');
}
function assertRegularTree(path) {
  const entry = lstatSync(path);
  if (entry.isDirectory()) {
    return readdirSync(path).flatMap((name) => assertRegularTree(join(path, name)));
  } else if (!entry.isFile()) {
    throw new Error('SYNTHETIC_VISUAL_WORKSPACE_LINK_OR_SPECIAL_FILE');
  }
  return [path];
}
assertRegularTree(sourceWorkspace);
const sourceDatabase = join(sourceWorkspace, 'health.db');
const sourceVault = join(sourceWorkspace, 'vault');
if (!lstatSync(sourceWorkspace).isDirectory() || !lstatSync(sourceDatabase).isFile()
  || !lstatSync(sourceVault).isDirectory()) throw new Error('SYNTHETIC_VISUAL_WORKSPACE_MISSING');
// 只复制已关闭的单文件数据库；不忽略尚未 checkpoint 的写入，也不修改冻结原库。
if (['-wal', '-shm', '-journal'].some((suffix) => existsSync(`${sourceDatabase}${suffix}`))) {
  throw new Error('SYNTHETIC_WORKSPACE_MUST_BE_CLOSED');
}
const databaseBytes = readFileSync(sourceDatabase);
if (!databaseBytes.subarray(0, 16).equals(Buffer.from('SQLite format 3\0'))) {
  throw new Error('SYNTHETIC_DATABASE_HEADER_INVALID');
}
const sourceDatabaseSha256 = sha256(databaseBytes);
const vaultFiles = assertRegularTree(sourceVault);
const vaultHashes = vaultFiles.map((path) => ({ path, relativePath: relative(sourceVault, path), sha256: sha256(readFileSync(path)) }));
if (familyDirectory && (vaultFiles.length !== 1 || sha256(readFileSync(vaultFiles[0])) !== receipt.fixtureSha256)) {
  throw new Error('SYNTHETIC_FAMILY_VAULT_MISMATCH');
}

const userDataPath = mkdtempSync(join(tmpdir(), 'family-health-app-smoke-'));
const workspacePath = join(userDataPath, 'workspace');
try {
  mkdirSync(workspacePath, { recursive: true, mode: 0o700 });
  cpSync(sourceDatabase, join(workspacePath, 'health.db'), { errorOnExist: true, force: false });
  cpSync(sourceVault, join(workspacePath, 'vault'), { recursive: true, errorOnExist: true, force: false });
  for (const path of assertRegularTree(workspacePath)) chmodSync(path, 0o600);
  if (sha256(readFileSync(join(workspacePath, 'health.db'))) !== sourceDatabaseSha256
    || sha256(readFileSync(sourceDatabase)) !== sourceDatabaseSha256
    || sha256(readFileSync(receiptPath)) !== sha256(receiptBytes)
    || vaultHashes.some((file) => sha256(readFileSync(file.path)) !== file.sha256
      || sha256(readFileSync(join(workspacePath, 'vault', file.relativePath))) !== file.sha256)
    || ['-wal', '-shm', '-journal'].some((suffix) => existsSync(`${sourceDatabase}${suffix}`))) {
    throw new Error('SYNTHETIC_WORKSPACE_CHANGED_DURING_COPY');
  }
  writeFileSync(join(userDataPath, 'desktop-state.json'), `${JSON.stringify({
    activeWorkspaceMode: 'personal',
    workspaceName: familyDirectory ? `纯合成家庭验收 · ${receipt.caseId}` : '纯合成视觉测试',
    stayInTray: false,
    openAtLogin: false,
    notificationsEnabled: false,
    aiPreferences: { modelId: 'gpt-6.1-sol', reasoningEffort: 'medium' },
    aiPreferencesScopeVersion: 2,
    displayPreferences: { fontScale: 'standard', reduceMotion: true, dateStyle: 'friendly' }
  }, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  process.stdout.write(`${JSON.stringify({ userDataPath, sourceReceiptPath: receiptPath,
    caseId: familyDirectory ? receipt.caseId : null, sourceDatabaseSha256,
    sourceReceiptSha256: sha256(receiptBytes), modelCalls: 0, copiedEntries: ['workspace/health.db', 'workspace/vault'] })}\n`);
} catch (error) {
  // 只清理本次新建的临时副本，不触碰原回执及其工作区。
  rmSync(userDataPath, { recursive: true, force: true });
  throw error;
}
