import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { syntheticFamilyInputHash, syntheticFamilyScenarios, type SyntheticFamilyCaseId } from './synthetic-family-scenarios.js';

const script = resolve('scripts/prepare-lean-v3-ui-smoke.mjs');
const temporaryRoots: string[] = [];
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');

// 准备器只做文件复制，不打开 SQLite；测试用头部桩避免切换原生 ABI 或触碰真实库。
function fixture(caseId: SyntheticFamilyCaseId = 'child-vision', version = 'member-assessment-v19') {
  const root = mkdtempSync(join(tmpdir(), 'fhd-ui-preparer-test-'));
  temporaryRoots.push(root);
  const source = join(root, 'fhd-lean-v3-full-chain-synthetic-test');
  const workspace = join(source, 'synthetic-workspace');
  const vault = join(workspace, 'vault');
  mkdirSync(vault, { recursive: true });
  const database = Buffer.from('SQLite format 3\0isolated-copy-test-not-a-real-database');
  writeFileSync(join(workspace, 'health.db'), database);
  const scenario = syntheticFamilyScenarios[caseId];
  const sourceBytes = readFileSync(resolve('packages/evaluation/fixtures', scenario.filename));
  writeFileSync(join(vault, scenario.sha256), sourceBytes);
  const receipt: Record<string, unknown> = {
    kind: 'LEAN_V3_FULL_CHAIN_SYNTHETIC', syntheticOnly: true, caseId,
    fixtureSha256: scenario.sha256, scenarioInputSha256: syntheticFamilyInputHash(caseId), syntheticScenarioInput: scenario,
    runStatus: 'completed', sourceUnchanged: true, chainPublished: true, scenarioPassed: true,
    finalSnapshotPresent: true, automatedContentCheckStatus: 'PASSED',
    extraction: { status: 'published' }, assessment: { status: 'published' },
    versions: { MEMBER_ASSESSMENT_PROMPT_VERSION: version },
    sourceFingerprint: { sha256: 'a'.repeat(64), fileCount: 70 },
    scenarioChecks: [{ id: 'test', passed: true }], calls: [{ phase: 'P01', status: 'completed' }], finalContentProcessIssues: []
  };
  for (const name of ['published-snapshot.json', 'presented-snapshot.json', 'member-page-read-models.json']) {
    const bytes = `${JSON.stringify({ syntheticOnly: true, caseId, artifact: name })}\n`;
    writeFileSync(join(source, name), bytes);
    receipt[name] = { path: name, sha256: hash(bytes) };
  }
  const receiptPath = join(source, 'receipt.json');
  const save = () => writeFileSync(receiptPath, JSON.stringify(receipt));
  save();
  return { root, source, workspace, vault, database, sourceBytes, receipt, receiptPath, save };
}

function prepare(input: ReturnType<typeof fixture>, receiptPath = input.receiptPath) {
  return spawnSync(process.execPath, [script, `--receipt=${receiptPath}`], {
    encoding: 'utf8', env: { ...process.env, TMPDIR: input.root, TMP: input.root, TEMP: input.root }
  });
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('已冻结合成结果的隔离 UI 准备器', () => {
  it.each(['child-vision', 'adult-recent-change', 'older-bp-kidney'] as const)('复制 %s，不改变冻结源，不复制登录或运行目录', (caseId) => {
    const input = fixture(caseId);
    for (const name of ['codex-home', 'codex-workspace']) {
      mkdirSync(join(input.source, name));
      writeFileSync(join(input.source, name, 'auth.json'), 'test-marker-not-a-credential');
    }
    mkdirSync(join(input.workspace, 'codex-home'));
    writeFileSync(join(input.workspace, 'codex-home', 'auth.json'), 'test-marker-not-a-credential');
    const receiptBefore = readFileSync(input.receiptPath);
    const result = prepare(input);
    expect(result.status, result.stderr).toBe(0);
    const output = JSON.parse(result.stdout) as { userDataPath: string; sourceDatabaseSha256: string; modelCalls: number };
    expect(dirname(output.userDataPath)).toBe(input.root);
    expect(output.userDataPath).toContain('family-health-app-smoke-');
    expect(readFileSync(join(output.userDataPath, 'workspace', 'health.db'))).toEqual(input.database);
    expect(output.sourceDatabaseSha256).toBe(hash(input.database));
    expect(readdirSync(output.userDataPath).sort()).toEqual(['desktop-state.json', 'workspace']);
    expect(readdirSync(join(output.userDataPath, 'workspace')).sort()).toEqual(['health.db', 'vault']);
    const state = JSON.parse(readFileSync(join(output.userDataPath, 'desktop-state.json'), 'utf8'));
    expect(state).toMatchObject({ activeWorkspaceMode: 'personal', stayInTray: false,
      openAtLogin: false, notificationsEnabled: false, aiPreferences: { modelId: 'gpt-6.1-sol', reasoningEffort: 'medium' } });
    expect(readFileSync(input.receiptPath)).toEqual(receiptBefore);
    expect(readFileSync(join(input.workspace, 'health.db'))).toEqual(input.database);
    expect(output.modelCalls).toBe(0);
  });

  it.each(['member-assessment-v20', 'member-assessment-v21', 'member-assessment-v22', 'member-assessment-v23', 'member-assessment-v24', 'member-assessment-v25', 'member-assessment-v26'])('明确接受 %s，不要求再次运行模型', (version) => {
    const input = fixture('child-vision', version);
    expect(prepare(input).status).toBe(0);
  });

  it('每次创建新副本，互不覆盖', () => {
    const input = fixture();
    const first = JSON.parse(prepare(input).stdout).userDataPath;
    const second = JSON.parse(prepare(input).stdout).userDataPath;
    expect(first).not.toBe(second);
    expect(existsSync(join(first, 'workspace', 'health.db'))).toBe(true);
  });

  it.each([
    ['syntheticOnly', false], ['caseId', 'unknown-case'], ['fixtureSha256', '0'.repeat(64)],
    ['scenarioInputSha256', '0'.repeat(64)], ['runStatus', 'running'], ['sourceUnchanged', false],
    ['chainPublished', false], ['scenarioPassed', false], ['finalSnapshotPresent', false],
    ['automatedContentCheckStatus', 'FAILED'], ['extraction', { status: 'needs_review' }],
    ['assessment', { status: 'rejected' }], ['versions', { MEMBER_ASSESSMENT_PROMPT_VERSION: 'member-assessment-v18' }],
    ['sourceFingerprint', { sha256: 'not-a-hash', fileCount: 70 }],
    ['scenarioChecks', []], ['scenarioChecks', [{ passed: false }]], ['calls', [{ status: 'failed' }]],
    ['finalContentProcessIssues', ['unfixed-process-copy']]
  ])('拒绝非冻结或不支持的回执字段 %s=%j', (key, value) => {
    const input = fixture();
    input.receipt[String(key)] = value;
    input.save();
    const result = prepare(input);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('COMPLETED_SYNTHETIC_FAMILY_ASSESSMENT_REQUIRED');
    expect(readdirSync(input.root).filter((name) => name.startsWith('family-health-app-smoke-'))).toEqual([]);
  });

  it('拒绝被替换的成员背景，即使仍声称是同一回执哈希', () => {
    const input = fixture();
    input.receipt.syntheticScenarioInput = { ...syntheticFamilyScenarios['child-vision'], member: { displayName: 'other' } };
    input.save();
    expect(prepare(input).stderr).toContain('COMPLETED_SYNTHETIC_FAMILY_ASSESSMENT_REQUIRED');
  });

  it.each(['published-snapshot.json', 'presented-snapshot.json', 'member-page-read-models.json'])('拒绝冻结文件被修改：%s', (name) => {
    const input = fixture();
    writeFileSync(join(input.source, name), '{}');
    expect(prepare(input).stderr).toContain('SYNTHETIC_FAMILY_PRESENTATION_HASH_MISMATCH');
  });

  it.each(['-wal', '-shm', '-journal'])('拒绝尚未关闭的数据库文件 %s', (suffix) => {
    const input = fixture();
    writeFileSync(join(input.workspace, `health.db${suffix}`), 'not-checkpointed');
    expect(prepare(input).stderr).toContain('SYNTHETIC_WORKSPACE_MUST_BE_CLOSED');
  });

  it('拒绝源 vault 中的未知资料', () => {
    const input = fixture();
    writeFileSync(join(input.vault, 'unrelated-file'), 'not-the-frozen-fixture');
    expect(prepare(input).stderr).toContain('SYNTHETIC_FAMILY_VAULT_MISMATCH');
  });

  it('拒绝 SQLite 头部不正确的文件', () => {
    const input = fixture();
    writeFileSync(join(input.workspace, 'health.db'), 'not-a-database');
    expect(prepare(input).stderr).toContain('SYNTHETIC_DATABASE_HEADER_INVALID');
  });

  it('拒绝白名单目录之外的回执', () => {
    const input = fixture();
    const outside = join(input.root, 'untrusted-receipt');
    mkdirSync(outside);
    const path = join(outside, 'receipt.json');
    writeFileSync(path, JSON.stringify(input.receipt));
    expect(prepare(input, path).stderr).toContain('SYNTHETIC_VISUAL_RECEIPT_PATH_REQUIRED');
  });

  it.skipIf(process.platform === 'win32')('拒绝源数据库或回执符号链接', () => {
    const input = fixture();
    const receiptLink = join(input.root, 'receipt.json');
    symlinkSync(input.receiptPath, receiptLink);
    expect(prepare(input, receiptLink).stderr).toContain('SYNTHETIC_VISUAL_RECEIPT_PATH_REQUIRED');
    const database = join(input.workspace, 'health.db');
    rmSync(database);
    symlinkSync(input.receiptPath, database);
    expect(prepare(input).stderr).toContain('SYNTHETIC_VISUAL_WORKSPACE_LINK_OR_SPECIAL_FILE');
  });

  it('保留原有纯合成 PNG 成功回执入口', () => {
    const input = fixture();
    const source = join(input.root, 'fhd-lean-v3-visual-smoke-test');
    mkdirSync(join(source, 'synthetic-workspace', 'vault'), { recursive: true });
    writeFileSync(join(source, 'synthetic-workspace', 'health.db'), input.database);
    writeFileSync(join(source, 'synthetic-workspace', 'vault', 'image'), 'synthetic-image');
    const path = join(source, 'receipt.json');
    writeFileSync(path, JSON.stringify({ kind: 'P01_P02_IMAGE_SYNTHETIC', syntheticOnly: true,
      result: { status: 'published' }, assessment: { status: 'published' } }));
    expect(prepare(input, path).status).toBe(0);
  });

  it('主进程启动时不为隔离验收写系统登录项', () => {
    const main = readFileSync(resolve('apps/desktop/src/main/index.ts'), 'utf8');
    expect(main).toContain('if (!smokeUserDataDirectory) app.setLoginItemSettings({ openAtLogin: desktopState.openAtLogin });');
  });

  it('隔离验收保存桌面设置时也不写系统登录项', () => {
    const main = readFileSync(resolve('apps/desktop/src/main/index.ts'), 'utf8');
    expect(main).toContain('if (!smokeUserDataDirectory) app.setLoginItemSettings({ openAtLogin: input.openAtLogin });');
  });
});
