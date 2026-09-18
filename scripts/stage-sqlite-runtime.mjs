import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { assertBinaryTarget } from './binary-target.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const supportedTargets = new Set(['darwin-arm64', 'darwin-x64', 'win32-x64']);
const targetArgument = process.argv.find((argument) => argument.startsWith('--target='));
const defaultTarget = `${process.platform}-${process.arch}`;
const target = targetArgument?.slice('--target='.length) ?? defaultTarget;

if (!supportedTargets.has(target)) throw new Error(`UNSUPPORTED_SQLITE_RUNTIME_TARGET:${target}`);

const [platform, arch] = target.split('-');
const sqliteRoot = realpathSync(join(root, 'node_modules', 'better-sqlite3'));
const electronPackage = JSON.parse(readFileSync(join(root, 'node_modules', 'electron', 'package.json'), 'utf8'));
const sqlitePackage = JSON.parse(readFileSync(join(sqliteRoot, 'package.json'), 'utf8'));
const require = createRequire(import.meta.url);
const installer = require.resolve('prebuild-install/bin.js', { paths: [sqliteRoot] });
const nativePath = join(sqliteRoot, 'build', 'Release', 'better_sqlite3.node');
const cacheRoot = process.env.FAMILY_HEALTH_PREBUILD_CACHE ?? join(tmpdir(), 'family-health-prebuild-cache');

const result = spawnSync(process.execPath, [
  installer,
  '--runtime', 'electron',
  '--target', electronPackage.version,
  '--platform', platform,
  '--arch', arch,
  '--force'
], {
  cwd: sqliteRoot,
  env: { ...process.env, npm_config_cache: cacheRoot },
  encoding: 'utf8',
  stdio: 'inherit'
});

if (result.error) throw result.error;
if (result.status !== 0 || !existsSync(nativePath)) {
  throw new Error(`SQLITE_PREBUILD_INSTALL_FAILED:${target}:status=${result.status ?? 'unknown'}`);
}

await assertBinaryTarget(nativePath, target, 'better_sqlite3.node');
process.stdout.write(`SQLite ${sqlitePackage.version} / Electron ${electronPackage.version} 原生模块已锁定为 ${target}。\n`);
