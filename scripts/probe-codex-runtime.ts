import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnCodexAppServer } from '../packages/codex-adapter/src/index.js';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(scriptDirectory, '..');
const privateRoot = mkdtempSync(resolve(tmpdir(), 'family-health-codex-probe-'));
const codexHome = resolve(privateRoot, 'codex-home');
const taskDirectory = resolve(privateRoot, 'task');
mkdirSync(codexHome, { recursive: true, mode: 0o700 });
mkdirSync(taskDirectory, { recursive: true, mode: 0o700 });

const executable = process.env.CODEX_EXECUTABLE ?? 'codex';
const version = execFileSync(executable, ['--version'], { encoding: 'utf8' }).trim();
const startedAt = new Date();
const receipt: Record<string, unknown> = {
  status: 'started',
  startedAt: startedAt.toISOString(),
  platform: process.platform,
  arch: process.arch,
  runtimeVersion: version,
  privateCodexHome: true,
  realLoginAttempted: false,
  realHealthDataUsed: false
};

const { client, process: child } = spawnCodexAppServer({ executable, codexHome, cwd: taskDirectory });
const stderr: string[] = [];
client.on('stderr', (line) => stderr.push(String(line).slice(0, 1_000)));

try {
  await client.initialize();
  const account = await client.request<{ account: unknown; requiresOpenaiAuth: boolean }>('account/read', { refreshToken: false });
  const models = await client.request<{ data: unknown[]; nextCursor: string | null }>('model/list', { limit: 10, includeHidden: false });
  receipt.status = 'passed';
  receipt.initialize = 'passed';
  receipt.initializedNotification = 'sent';
  receipt.accountRead = {
    authenticated: account.account !== null,
    requiresOpenaiAuth: account.requiresOpenaiAuth
  };
  receipt.modelList = { count: models.data.length, availableWithoutLogin: models.data.length > 0 };
} catch (error) {
  receipt.status = 'failed';
  receipt.errorCode = error instanceof Error ? error.message.split(':').slice(0, 2).join(':') : 'UNKNOWN';
} finally {
  client.shutdown();
  await new Promise<void>((resolveExit) => {
    if (child.exitCode !== null || child.killed) return resolveExit();
    const timer = setTimeout(() => { child.kill('SIGKILL'); resolveExit(); }, 2_000);
    child.once('exit', () => { clearTimeout(timer); resolveExit(); });
  });
  receipt.stderrSummary = stderr.slice(-5);
  receipt.finishedAt = new Date().toISOString();
  receipt.elapsedMs = Date.now() - startedAt.getTime();
  const evidenceDirectory = resolve(projectRoot, 'docs', 'desktop', 'integration-evidence');
  mkdirSync(evidenceDirectory, { recursive: true });
  writeFileSync(resolve(evidenceDirectory, 'g0-local-probe.json'), `${JSON.stringify(receipt, null, 2)}\n`);
  rmSync(privateRoot, { recursive: true, force: true });
}

if (receipt.status !== 'passed') process.exitCode = 1;

