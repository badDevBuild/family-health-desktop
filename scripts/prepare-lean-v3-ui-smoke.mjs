/* global process */
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';

/** 只从已完成的纯合成视觉评测复制数据，绝不接收真实个人工作区。 */
const receiptArgument = process.argv.find((argument) => argument.startsWith('--receipt='))?.slice('--receipt='.length);
if (!receiptArgument) throw new Error('SYNTHETIC_VISUAL_RECEIPT_REQUIRED');
const receiptPath = realpathSync(receiptArgument);
const sourceDirectory = dirname(receiptPath);
if (basename(receiptPath) !== 'receipt.json'
  || dirname(sourceDirectory) !== realpathSync(tmpdir())
  || !basename(sourceDirectory).startsWith('fhd-lean-v3-visual-smoke-')) {
  throw new Error('SYNTHETIC_VISUAL_RECEIPT_PATH_REQUIRED');
}

const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
if (receipt.kind !== 'P01_P02_IMAGE_SYNTHETIC' || receipt.syntheticOnly !== true
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
    for (const name of readdirSync(path)) assertRegularTree(join(path, name));
  } else if (!entry.isFile()) {
    throw new Error('SYNTHETIC_VISUAL_WORKSPACE_LINK_OR_SPECIAL_FILE');
  }
}
assertRegularTree(sourceWorkspace);

const userDataPath = mkdtempSync(join(tmpdir(), 'family-health-app-smoke-'));
const workspacePath = join(userDataPath, 'workspace');
mkdirSync(workspacePath, { recursive: true, mode: 0o700 });
cpSync(join(sourceWorkspace, 'health.db'), join(workspacePath, 'health.db'), { errorOnExist: true });
cpSync(join(sourceWorkspace, 'vault'), join(workspacePath, 'vault'), { recursive: true, errorOnExist: true });
writeFileSync(join(userDataPath, 'desktop-state.json'), `${JSON.stringify({
  activeWorkspaceMode: 'personal',
  workspaceName: '纯合成视觉测试',
  stayInTray: false,
  openAtLogin: false,
  notificationsEnabled: false,
  displayPreferences: { fontScale: 'standard', reduceMotion: true, dateStyle: 'friendly' }
}, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
process.stdout.write(`${JSON.stringify({ userDataPath, sourceReceiptPath: receiptPath })}\n`);
