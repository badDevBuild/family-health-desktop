import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createHealthThreadStartParams } from '../apps/desktop/src/main/codex-thread-config.js';
import { spawnCodexAppServer } from '../packages/codex-adapter/src/index.js';

const expectedRuntimeVersion = '0.145.0';
const targetByPlatform = {
  'darwin-arm64': { packageName: '@openai/codex-darwin-arm64', triple: 'aarch64-apple-darwin', executableName: 'codex' },
  'darwin-x64': { packageName: '@openai/codex-darwin-x64', triple: 'x86_64-apple-darwin', executableName: 'codex' },
  'win32-x64': { packageName: '@openai/codex-win32-x64', triple: 'x86_64-pc-windows-msvc', executableName: 'codex.exe' }
} as const;

function resolveLockedCodexExecutable(): string {
  if (process.env.CODEX_EXECUTABLE) return process.env.CODEX_EXECUTABLE;
  const target = targetByPlatform[`${process.platform}-${process.arch}` as keyof typeof targetByPlatform];
  if (!target) throw new Error(`CODEX_RUNTIME_UNSUPPORTED:${process.platform}-${process.arch}`);
  const projectRequire = createRequire(import.meta.url);
  const codexRequire = createRequire(projectRequire.resolve('@openai/codex/package.json'));
  const platformPackage = codexRequire.resolve(`${target.packageName}/package.json`);
  const executablePath = join(dirname(platformPackage), 'vendor', target.triple, 'bin', target.executableName);
  if (!existsSync(executablePath)) throw new Error(`CODEX_RUNTIME_MISSING:${target.packageName}`);
  return executablePath;
}

const executable = resolveLockedCodexExecutable();
const runtimeVersion = execFileSync(executable, ['--version'], { encoding: 'utf8' }).trim();
if (!runtimeVersion.includes(expectedRuntimeVersion)) {
  throw new Error(`CODEX_RUNTIME_VERSION_MISMATCH:${runtimeVersion}`);
}

const privateRoot = mkdtempSync(resolve(tmpdir(), 'family-health-thread-config-'));
const codexHome = resolve(privateRoot, 'codex-home');
const taskDirectory = resolve(privateRoot, 'task');
mkdirSync(codexHome, { recursive: true, mode: 0o700 });
mkdirSync(taskDirectory, { recursive: true, mode: 0o700 });

const { client, process: child } = spawnCodexAppServer({ executable, codexHome, cwd: taskDirectory });

try {
  await client.initialize();
  for (const allowWebSearch of [false, true]) {
    const response = await client.request<{ thread: { id: string } }>('thread/start', createHealthThreadStartParams({
      workingDirectory: taskDirectory,
      aiPreferences: { modelId: 'gpt-5.6-sol', reasoningEffort: 'medium' },
      allowWebSearch
    }));
    if (!response.thread.id) throw new Error('CODEX_THREAD_START_MISSING_ID');
  }
  process.stdout.write(`Codex ${expectedRuntimeVersion} thread/start 兼容性探针通过（Web Search 禁用/实时）\n`);
} finally {
  client.shutdown();
  await new Promise<void>((resolveExit) => {
    if (child.exitCode !== null || child.killed) return resolveExit();
    const timer = setTimeout(() => { child.kill('SIGKILL'); resolveExit(); }, 2_000);
    child.once('exit', () => { clearTimeout(timer); resolveExit(); });
  });
  rmSync(privateRoot, { recursive: true, force: true });
}
