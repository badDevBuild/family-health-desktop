import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import afterPack, { expectedCanvasPackage } from './after-pack.mjs';

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('发行工件目标架构清理', () => {
  it('只保留目标 Canvas 原生包并移除 SQLite 测试扩展', async () => {
    const root = mkdtempSync(join(tmpdir(), 'family-health-after-pack-'));
    directories.push(root);
    const appOutDir = join(root, 'mac');
    const modules = join(appOutDir, 'Fixture.app', 'Contents', 'Resources', 'app.asar.unpacked', 'node_modules');
    const napiScope = join(modules, '@napi-rs');
    const x64Canvas = join(napiScope, 'canvas-darwin-x64');
    const armCanvas = join(napiScope, 'canvas-darwin-arm64');
    const winCanvas = join(napiScope, 'canvas-win32-x64-msvc');
    const sqliteRoot = join(modules, 'better-sqlite3', 'build', 'Release');
    for (const directory of [x64Canvas, armCanvas, winCanvas, sqliteRoot]) mkdirSync(directory, { recursive: true });
    const machoX64 = Buffer.alloc(8);
    machoX64.writeUInt32LE(0xfeedfacf, 0);
    machoX64.writeUInt32LE(0x01000007, 4);
    writeFileSync(join(x64Canvas, 'skia.darwin-x64.node'), machoX64);
    writeFileSync(join(armCanvas, 'skia.darwin-arm64.node'), 'arm64');
    writeFileSync(join(winCanvas, 'skia.win32-x64-msvc.node'), 'win32');
    writeFileSync(join(sqliteRoot, 'better_sqlite3.node'), machoX64);
    writeFileSync(join(sqliteRoot, 'test_extension.node'), 'test-only');
    const codexRoot = join(appOutDir, 'Fixture.app', 'Contents', 'Resources', 'runtime', 'codex', 'darwin-x64', 'bin');
    mkdirSync(codexRoot, { recursive: true });
    writeFileSync(join(codexRoot, 'codex'), machoX64);

    await afterPack({
      electronPlatformName: 'darwin',
      arch: 1,
      appOutDir,
      packager: { appInfo: { productFilename: 'Fixture' } }
    });

    expect(expectedCanvasPackage('darwin', 1)).toBe('canvas-darwin-x64');
    expect(existsSync(x64Canvas)).toBe(true);
    expect(existsSync(armCanvas)).toBe(false);
    expect(existsSync(winCanvas)).toBe(false);
    expect(existsSync(join(sqliteRoot, 'test_extension.node'))).toBe(false);
    expect(existsSync(join(sqliteRoot, 'better_sqlite3.node'))).toBe(true);
  });

  it('拒绝未定义的发行目标', () => {
    expect(() => expectedCanvasPackage('linux', 1)).toThrow('UNSUPPORTED_AFTER_PACK_TARGET');
  });

  it('拒绝目标平台错误的 SQLite 原生模块', async () => {
    const root = mkdtempSync(join(tmpdir(), 'family-health-after-pack-mismatch-'));
    directories.push(root);
    const appOutDir = join(root, 'mac');
    const resources = join(appOutDir, 'Fixture.app', 'Contents', 'Resources');
    const modules = join(resources, 'app.asar.unpacked', 'node_modules');
    const canvasRoot = join(modules, '@napi-rs', 'canvas-darwin-arm64');
    const sqliteRoot = join(modules, 'better-sqlite3', 'build', 'Release');
    const codexRoot = join(resources, 'runtime', 'codex', 'darwin-arm64', 'bin');
    for (const directory of [canvasRoot, sqliteRoot, codexRoot]) mkdirSync(directory, { recursive: true });
    const machoArm64 = Buffer.alloc(8);
    machoArm64.writeUInt32LE(0xfeedfacf, 0);
    machoArm64.writeUInt32LE(0x0100000c, 4);
    const peX64 = Buffer.alloc(0x90);
    peX64.write('MZ', 0, 'ascii');
    peX64.writeUInt32LE(0x80, 0x3c);
    peX64.write('PE\0\0', 0x80, 'binary');
    peX64.writeUInt16LE(0x8664, 0x84);
    writeFileSync(join(canvasRoot, 'skia.darwin-arm64.node'), machoArm64);
    writeFileSync(join(sqliteRoot, 'better_sqlite3.node'), peX64);
    writeFileSync(join(codexRoot, 'codex'), machoArm64);

    await expect(afterPack({
      electronPlatformName: 'darwin',
      arch: 3,
      appOutDir,
      packager: { appInfo: { productFilename: 'Fixture' } }
    })).rejects.toThrow('BINARY_TARGET_MISMATCH:better_sqlite3');
  });
});
