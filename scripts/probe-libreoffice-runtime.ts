import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { buildPdfManifest, LibreOfficeLegacyDocConverter } from '../packages/ingestion/src/index.ts';

const executablePath = process.argv.find((argument) => argument.startsWith('--executable='))?.slice('--executable='.length);
const version = process.argv.find((argument) => argument.startsWith('--version='))?.slice('--version='.length);
if (!executablePath || !version) {
  throw new Error('用法：tsx scripts/probe-libreoffice-runtime.ts --executable=/path/to/soffice --version=26.8.0.3');
}

const resolvedExecutable = resolve(executablePath);
const executableSha256 = createHash('sha256').update(readFileSync(resolvedExecutable)).digest('hex');
const root = mkdtempSync(join(tmpdir(), 'family-health-lo-probe-'));
try {
  const sourceText = join(root, 'synthetic-source.txt');
  const sourceDoc = join(root, 'synthetic-legacy.doc');
  writeFileSync(sourceText, '纯合成健康资料\nLDL 3.8 mmol/L\n仅用于本机兼容组件验证\n', { encoding: 'utf8', mode: 0o600 });
  execFileSync('/usr/bin/textutil', [
    '-convert', 'doc', '-format', 'txt', '-output', sourceDoc,
    '-title', '家庭健康看板兼容组件合成探针', '-author', 'Family Health Synthetic Probe',
    '--', sourceText
  ], { stdio: 'pipe' });

  const sourceBytes = readFileSync(sourceDoc);
  const converter = new LibreOfficeLegacyDocConverter(resolvedExecutable, executableSha256, version);
  const converted = await converter.convert(sourceBytes);
  const documentId = randomUUID();
  const manifest = await buildPdfManifest({
    sourceObjectId: randomUUID(),
    documentId,
    sha256: createHash('sha256').update(sourceBytes).digest('hex'),
    displayName: 'synthetic-legacy.doc',
    bytes: converted.bytes,
    createdAt: new Date().toISOString()
  });
  process.stdout.write(`${JSON.stringify({
    syntheticOnly: true,
    version,
    executableSha256,
    sourceSha256: createHash('sha256').update(sourceBytes).digest('hex'),
    convertedSha256: converted.sha256,
    convertedBytes: converted.bytes.byteLength,
    pageCount: manifest.totalUnits,
    extractedQuotes: manifest.spans.map((span) => span.quote).filter(Boolean)
  }, null, 2)}\n`);
} finally {
  rmSync(root, { recursive: true, force: true });
}
