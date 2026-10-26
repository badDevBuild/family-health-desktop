import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import process from 'node:process';
import { assertBinaryTarget } from './binary-target.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const target = process.argv.find((value) => value.startsWith('--target='))?.slice(9)
  ?? `${process.platform}-${process.arch}`;
const stageRoot = join(root, '.runtime-stage', 'vision');
mkdirSync(stageRoot, { recursive: true });
if (target === 'win32-x64') {
  // 无本机 OCR 引擎时保留明确边界，不能恢复图片候选的静默放行。
  writeFileSync(join(stageRoot, 'availability.json'), JSON.stringify({ localOcrAvailable: false }));
} else {
  if (process.platform !== 'darwin' || !['darwin-arm64', 'darwin-x64'].includes(target)) {
    throw new Error('LOCAL_VISION_BUILD_TARGET_UNAVAILABLE');
  }
  const arch = target === 'darwin-arm64' ? 'arm64' : 'x86_64';
  const destination = join(stageRoot, target, 'vision-ocr');
  mkdirSync(dirname(destination), { recursive: true });
  const moduleCache = join(root, '.runtime-stage', 'swift-module-cache');
  mkdirSync(moduleCache, { recursive: true });
  const compiled = spawnSync('/usr/bin/xcrun', ['swiftc', '-O', '-module-cache-path', moduleCache,
    '-target', `${arch}-apple-macosx13.0`,
    join(root, 'packages/ingestion/native/vision-ocr.swift'), '-o', destination], { stdio: 'inherit' });
  if (compiled.error || compiled.status !== 0) throw new Error('LOCAL_VISION_BUILD_FAILED');
  await assertBinaryTarget(destination, target, 'vision-ocr');
  process.stdout.write(`本机图像文字核验已准备：${target}。\n`);
}
