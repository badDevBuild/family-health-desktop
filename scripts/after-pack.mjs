import { readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { assertBinaryTarget } from './binary-target.mjs';

const ARCH_X64 = 1;
const ARCH_ARM64 = 3;

export function expectedCanvasPackage(platform, arch) {
  if (platform === 'darwin' && arch === ARCH_X64) return 'canvas-darwin-x64';
  if (platform === 'darwin' && arch === ARCH_ARM64) return 'canvas-darwin-arm64';
  if (platform === 'win32' && arch === ARCH_X64) return 'canvas-win32-x64-msvc';
  throw new Error(`UNSUPPORTED_AFTER_PACK_TARGET:${platform}/${arch}`);
}

export function expectedTarget(platform, arch) {
  const canvasPackage = expectedCanvasPackage(platform, arch);
  if (canvasPackage === 'canvas-darwin-arm64') return 'darwin-arm64';
  if (canvasPackage === 'canvas-darwin-x64') return 'darwin-x64';
  return 'win32-x64';
}

export default async function afterPack(context) {
  const platform = context.electronPlatformName;
  const productName = context.packager.appInfo.productFilename;
  const resourcesRoot = platform === 'darwin'
    ? join(context.appOutDir, `${productName}.app`, 'Contents', 'Resources')
    : join(context.appOutDir, 'resources');
  const unpackedModules = join(resourcesRoot, 'app.asar.unpacked', 'node_modules');
  const napiScope = join(unpackedModules, '@napi-rs');
  const expectedCanvas = expectedCanvasPackage(platform, context.arch);
  const target = expectedTarget(platform, context.arch);
  const entries = await readdir(napiScope, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (entry.isDirectory() && entry.name.startsWith('canvas-') && entry.name !== expectedCanvas) {
      await rm(join(napiScope, entry.name), { recursive: true, force: true });
    }
  }
  const expectedNative = await readdir(join(napiScope, expectedCanvas)).catch(() => []);
  const canvasNative = expectedNative.find((name) => name.endsWith('.node'));
  if (!canvasNative) throw new Error(`TARGET_CANVAS_NATIVE_MISSING:${expectedCanvas}`);
  await assertBinaryTarget(join(napiScope, expectedCanvas, canvasNative), target, 'canvas');

  const sqliteRoot = join(unpackedModules, 'better-sqlite3', 'build', 'Release');
  await rm(join(sqliteRoot, 'test_extension.node'), { force: true });
  const sqliteNative = await stat(join(sqliteRoot, 'better_sqlite3.node')).catch(() => null);
  if (!sqliteNative?.isFile() || sqliteNative.size === 0) throw new Error('TARGET_SQLITE_NATIVE_MISSING');
  await assertBinaryTarget(join(sqliteRoot, 'better_sqlite3.node'), target, 'better_sqlite3');

  const runtimeExecutable = join(resourcesRoot, 'runtime', 'codex', target, 'bin', platform === 'win32' ? 'codex.exe' : 'codex');
  await assertBinaryTarget(runtimeExecutable, target, 'codex');
}
