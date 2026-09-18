/* global process, console */
import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync, statSync } from 'node:fs';
import { extname } from 'node:path';

const MAX_PUBLIC_FILE_BYTES = 10 * 1024 * 1024;
const root = process.cwd();

function git(...args) {
  return execFileSync('git', args, { cwd: root, encoding: 'buffer', stdio: ['ignore', 'pipe', 'pipe'] });
}

function nulList(buffer) {
  return buffer.toString('utf8').split('\0').filter(Boolean);
}

const files = nulList(git('ls-files', '-z'));
if (files.length === 0) throw new Error('PUBLIC_SCAN_EMPTY_GIT_INDEX');

const forbiddenPathRules = [
  { test: (path) => /^(?:node_modules|out|dist|release|release-[^/]+|\.runtime-stage|coverage|workspace|vault|backups|diagnostics|runtime-data)(?:\/|$)/i.test(path), reason: '生成物或本地运行数据' },
  { test: (path) => /(^|\/)\.env(?:\.|$)/i.test(path) && !path.endsWith('.env.example'), reason: '环境变量文件' },
  { test: (path) => /(?:^|\/)family-health-desktop-spec-v1\.zip$/i.test(path), reason: '重复的规格压缩包' },
  { test: (path) => /\.(?:db|sqlite|sqlite3|fhbackup|dmg|exe|blockmap|pem|key|p12|pfx)$/i.test(path), reason: '数据库、备份、安装包或密钥材料' }
];

const contentRules = [
  { pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/, reason: '私钥内容' },
  { pattern: /\bgh[pousr]_[A-Za-z0-9]{30,}\b/, reason: 'GitHub 令牌' },
  { pattern: /\bsk-(?:proj-)?[A-Za-z0-9_-]{24,}\b/, reason: 'API 密钥' },
  { pattern: /\bAKIA[0-9A-Z]{16}\b/, reason: '云访问密钥' },
  { pattern: /Authorization:\s*Bearer\s+[A-Za-z0-9._~-]{20,}/i, reason: 'Bearer 凭据' },
  { pattern: /\/Users\/(?!example\/|username\/|your-name\/)[A-Za-z0-9._-]+\//, reason: 'macOS 用户绝对路径' },
  { pattern: /[A-Za-z]:\\Users\\(?!example\\|username\\)[^\\\r\n]+\\/i, reason: 'Windows 用户绝对路径' }
];

const failures = [];
for (const path of files) {
  for (const rule of forbiddenPathRules) {
    if (rule.test(path)) failures.push(`${path}: ${rule.reason}`);
  }
  const metadata = lstatSync(path);
  if (metadata.isSymbolicLink()) {
    failures.push(`${path}: 不允许符号链接`);
    continue;
  }
  if (!metadata.isFile()) continue;
  if (statSync(path).size > MAX_PUBLIC_FILE_BYTES) {
    failures.push(`${path}: 单文件超过 10 MiB`);
    continue;
  }
  const bytes = readFileSync(path);
  const binary = bytes.includes(0) || ['.png', '.ico', '.icns'].includes(extname(path).toLowerCase());
  if (binary) continue;
  const content = bytes.toString('utf8');
  for (const rule of contentRules) {
    if (rule.pattern.test(content)) failures.push(`${path}: ${rule.reason}`);
  }
}

if (failures.length > 0) {
  console.error('公开仓库扫描失败：');
  for (const failure of [...new Set(failures)]) console.error(`- ${failure}`);
  process.exitCode = 1;
} else {
  console.log(`公开仓库扫描通过：${files.length} 个已跟踪文件，未发现受禁内容。`);
}
