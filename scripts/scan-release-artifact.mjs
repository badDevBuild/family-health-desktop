import { readFile, readdir, stat } from 'node:fs/promises';
import { basename, join, relative, resolve } from 'node:path';
import { Buffer } from 'node:buffer';
import process from 'node:process';
import { assertBinaryTarget } from './binary-target.mjs';

const argumentsWithoutSeparator = process.argv.slice(2).filter((argument) => argument !== '--');
const appRoot = resolve(argumentsWithoutSeparator[0] ?? 'release/mac-arm64/家庭健康看板.app');
const expectedRuntimeTarget = argumentsWithoutSeparator[1] ?? 'darwin-arm64';
if (!['darwin-arm64', 'darwin-x64', 'win32-x64'].includes(expectedRuntimeTarget)) throw new Error(`UNSUPPORTED_RELEASE_SCAN_TARGET:${expectedRuntimeTarget}`);
const isWindows = expectedRuntimeTarget.startsWith('win32-');
const resourcesRoot = isWindows ? join(appRoot, 'resources') : join(appRoot, 'Contents', 'Resources');
const forbiddenNames = [
  /(^|\/)health\.db(?:-|$)/i,
  /\.(?:sqlite|sqlite3|fhbackup)$/i,
  /runtime-startup\.json$/i,
  /(^|\/)(?:sessions?|logs?|user-data|codex-home)(\/|$)/i,
  /(?:access|refresh|id)[_-]?token/i,
  /oauth.*(?:credential|secret)/i
];
const forbiddenContent = [
  Buffer.from('/Users/'),
  Buffer.from('"access_token":'),
  Buffer.from('"refresh_token":'),
  Buffer.from('"id_token":')
];

async function walk(directory) {
  const output = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) output.push(...await walk(path));
    else if (entry.isFile()) output.push(path);
  }
  return output;
}

const files = await walk(appRoot);
const violations = [];
for (const file of files) {
  const packagedPath = relative(appRoot, file).replaceAll('\\', '/');
  if (forbiddenNames.some((pattern) => pattern.test(packagedPath))) violations.push(`禁止的文件路径：${packagedPath}`);
}

const asarPath = join(resourcesRoot, 'app.asar');
const asar = await readFile(asarPath);
for (const marker of forbiddenContent) {
  if (asar.includes(marker)) violations.push(`app.asar 包含禁止内容标记：${marker.toString('utf8')}`);
}

const runtimeRoot = join(resourcesRoot, 'runtime', 'codex');
const runtimeTargets = await readdir(runtimeRoot, { withFileTypes: true })
  .then((entries) => entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort())
  .catch(() => []);
if (runtimeTargets.length !== 1 || runtimeTargets[0] !== expectedRuntimeTarget) {
  violations.push(`运行时目标不唯一或不匹配：expected=${expectedRuntimeTarget}, actual=${runtimeTargets.join(',') || 'missing'}`);
}

const required = [
  join(runtimeRoot, expectedRuntimeTarget, 'bin', isWindows ? 'codex.exe' : 'codex'),
  ...(isWindows ? [join(appRoot, '家庭健康看板.exe')] : [join(resourcesRoot, 'icon.icns')]),
  asarPath
];
for (const path of required) {
  const info = await stat(path).catch(() => null);
  if (!info?.isFile() || info.size === 0) violations.push(`缺少必要发行文件：${relative(appRoot, path)}`);
}

const nativeCandidates = files.filter((path) => path.endsWith('.node'));
for (const path of nativeCandidates) {
  try {
    await assertBinaryTarget(path, expectedRuntimeTarget, relative(appRoot, path));
  } catch (error) {
    violations.push(error instanceof Error ? error.message : String(error));
  }
}
try {
  await assertBinaryTarget(required[0], expectedRuntimeTarget, relative(appRoot, required[0]));
} catch (error) {
  violations.push(error instanceof Error ? error.message : String(error));
}

if (violations.length > 0) {
  for (const violation of violations) process.stderr.write(`${violation}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`PASS ${basename(appRoot)}：${files.length} 个文件；未发现工作区数据库、备份、会话目录、用户绝对路径或令牌值。\n`);
}
