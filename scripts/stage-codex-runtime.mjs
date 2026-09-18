import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { cp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { delimiter, dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import process from 'node:process';

const require = createRequire(import.meta.url);

const lockedVersion = '0.145.0';
const target = process.argv.find((argument) => argument.startsWith('--target='))?.slice('--target='.length)
  ?? `${process.platform}-${process.arch}`;
const targets = {
  'darwin-arm64': { triple: 'aarch64-apple-darwin', packageName: 'codex-darwin-arm64', executable: 'codex' },
  'darwin-x64': { triple: 'x86_64-apple-darwin', packageName: 'codex-darwin-x64', executable: 'codex' },
  'win32-x64': { triple: 'x86_64-pc-windows-msvc', packageName: 'codex-win32-x64', executable: 'codex.exe' }
};
const config = targets[target];
if (!config) throw new Error(`UNSUPPORTED_CODEX_RUNTIME_TARGET:${target}`);

function findOnPath(name) {
  const extensions = process.platform === 'win32' ? ['', '.exe', '.cmd'] : [''];
  for (const directory of (process.env.PATH ?? '').split(delimiter)) {
    for (const extension of extensions) {
      const candidate = join(directory, `${name}${extension}`);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

async function locateVendorRoot() {
  const envName = `FAMILY_HEALTH_CODEX_VENDOR_${target.replaceAll('-', '_').toUpperCase()}`;
  const explicit = process.env[envName] ?? process.env.FAMILY_HEALTH_CODEX_VENDOR_ROOT;
  if (explicit) return resolve(explicit);
  const packageRoots = [];
  try {
    packageRoots.push(dirname(require.resolve('@openai/codex/package.json')));
  } catch {
    // 兼容只在开发机全局安装 Codex 的旧路径。
  }
  const launcher = findOnPath('codex');
  if (launcher) {
    const realLauncher = await realpath(launcher);
    packageRoots.push(resolve(dirname(realLauncher), '..'));
  }
  const npmRoot = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['root', '--global'], { encoding: 'utf8' });
  if (npmRoot.status === 0 && npmRoot.stdout.trim()) {
    packageRoots.push(join(npmRoot.stdout.trim(), '@openai', 'codex'));
  }
  const candidates = packageRoots.flatMap((packageRoot) => [
    join(dirname(packageRoot), config.packageName, 'vendor', config.triple),
    join(packageRoot, 'node_modules', '@openai', config.packageName, 'vendor', config.triple),
    join(packageRoot, 'vendor', config.triple)
  ]);
  const found = candidates.find((candidate) => existsSync(join(candidate, 'bin', config.executable)));
  if (!found) {
    if (target !== `${process.platform}-${process.arch}`) throw new Error(`CODEX_VENDOR_ROOT_REQUIRED:${envName}`);
    throw new Error(launcher ? `CODEX_VENDOR_BINARY_NOT_FOUND:${target}` : 'CODEX_CLI_NOT_FOUND');
  }
  return found;
}

const vendorRoot = await locateVendorRoot();
const executable = join(vendorRoot, 'bin', config.executable);
const vendorManifestPath = join(vendorRoot, 'codex-package.json');
const vendorManifestBytes = await readFile(vendorManifestPath);
const vendorManifest = JSON.parse(vendorManifestBytes.toString('utf8'));
if (vendorManifest.version !== lockedVersion || vendorManifest.target !== config.triple || vendorManifest.entrypoint !== `bin/${config.executable}`) {
  throw new Error(`CODEX_RUNTIME_MANIFEST_MISMATCH:expected=${lockedVersion}/${config.triple}`);
}
let verificationMethod = 'vendor-manifest';
if (target.startsWith(`${process.platform}-`)) {
  const probeHome = resolve('.runtime-stage', 'probe-codex-home');
  await rm(probeHome, { recursive: true, force: true });
  await mkdir(probeHome, { recursive: true, mode: 0o700 });
  const versionCheck = spawnSync(executable, ['--version'], {
    encoding: 'utf8',
    env: { ...process.env, CODEX_HOME: probeHome }
  });
  await rm(probeHome, { recursive: true, force: true });
  if (versionCheck.status !== 0 || !`${versionCheck.stdout}${versionCheck.stderr}`.includes(lockedVersion)) {
    throw new Error(`CODEX_RUNTIME_VERSION_MISMATCH:expected=${lockedVersion}`);
  }
  verificationMethod = 'vendor-manifest-and-executable-probe';
}
const destinationBase = resolve('.runtime-stage', 'codex');
const destinationRoot = join(destinationBase, target);
await rm(destinationBase, { recursive: true, force: true });
await mkdir(dirname(destinationRoot), { recursive: true });
await cp(vendorRoot, destinationRoot, { recursive: true, force: true, preserveTimestamps: true });
const binary = await readFile(join(destinationRoot, 'bin', config.executable));
await writeFile(join(destinationRoot, 'runtime-manifest.json'), `${JSON.stringify({
  version: lockedVersion,
  target,
  verificationMethod,
  vendorManifestSha256: createHash('sha256').update(vendorManifestBytes).digest('hex'),
  executableSha256: createHash('sha256').update(binary).digest('hex')
}, null, 2)}\n`, { mode: 0o600 });
process.stdout.write(`Staged Codex ${lockedVersion} for ${target}\n`);
