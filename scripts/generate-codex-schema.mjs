import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const versionText = execFileSync('codex', ['--version'], { encoding: 'utf8' }).trim();
const version = versionText.replace(/^codex-cli\s+/, '');
if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`无法识别 Codex 版本：${versionText}`);

const root = resolve(import.meta.dirname, '..');
const schemaRoot = resolve(root, 'schemas', 'codex', version);
const tsDirectory = resolve(schemaRoot, 'ts');
const jsonDirectory = resolve(schemaRoot, 'json');
mkdirSync(tsDirectory, { recursive: true });
mkdirSync(jsonDirectory, { recursive: true });

execFileSync('codex', ['app-server', 'generate-ts', '--experimental', '--out', tsDirectory], { stdio: 'inherit' });
execFileSync('codex', ['app-server', 'generate-json-schema', '--experimental', '--out', jsonDirectory], { stdio: 'inherit' });

const hash = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');
const lock = {
  schemaVersion: 1,
  status: 'development-probe-only',
  generatedAt: new Date().toISOString(),
  runtime: { version, bundled: false },
  protocol: {
    generatedWithExperimental: true,
    typescriptDirectory: `schemas/codex/${version}/ts`,
    jsonSchemaDirectory: `schemas/codex/${version}/json`,
    v1BundleSha256: hash(resolve(jsonDirectory, 'codex_app_server_protocol.schemas.json')),
    v2BundleSha256: hash(resolve(jsonDirectory, 'codex_app_server_protocol.v2.schemas.json'))
  },
  verification: {
    schemaGeneration: 'passed-on-developer-machine',
    stdioInitialize: 'not-run',
    chatgptLogin: 'not-run',
    imageInput: 'not-run',
    structuredOutput: 'not-run',
    interrupt: 'not-run',
    permissionBoundary: 'not-run',
    macArm64Package: 'not-run',
    macX64Package: 'not-run',
    windowsX64Package: 'not-run'
  }
};
writeFileSync(resolve(root, 'runtime-lock.json'), `${JSON.stringify(lock, null, 2)}\n`);

