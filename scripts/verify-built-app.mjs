import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const mainPath = resolve('out/main/index.js');
const preloadPath = resolve('out/preload/index.js');
const [main, preload] = await Promise.all([
  readFile(mainPath, 'utf8'),
  readFile(preloadPath, 'utf8')
]);

if (!main.includes("../preload/index.js")) {
  throw new Error('BUILD_SMOKE_PRELOAD_PATH_MISMATCH');
}
if (!preload.includes('require("electron")') || /\bimport\s/.test(preload)) {
  throw new Error('BUILD_SMOKE_PRELOAD_NOT_SANDBOX_CJS');
}
