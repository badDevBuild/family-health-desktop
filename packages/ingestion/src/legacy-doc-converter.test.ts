import { createHash } from 'node:crypto';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { LibreOfficeLegacyDocConverter } from './legacy-doc-converter.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fakeExecutable(body: string): { path: string; sha256: string } {
  const root = mkdtempSync(join(tmpdir(), 'fake-libreoffice-'));
  roots.push(root);
  const path = join(root, 'soffice');
  writeFileSync(path, `#!/bin/sh\nset -eu\n${body}\n`, { mode: 0o700 });
  chmodSync(path, 0o700);
  return { path, sha256: createHash('sha256').update(readFileSync(path)).digest('hex') };
}

describe.skipIf(process.platform === 'win32')('LibreOfficeLegacyDocConverter', () => {
  it('校验固定运行时后使用独立 profile、参数数组和受控输出目录转换', async () => {
    const executable = fakeExecutable(`
if [ "\${1:-}" = "--version" ]; then
  echo "LibreOffice 25.8.7.2"
  exit 0
fi
outdir=""
profile=""
previous=""
for argument in "$@"; do
  if [ "$previous" = "--outdir" ]; then outdir="$argument"; fi
  case "$argument" in
    -env:UserInstallation=file://*) profile="$argument" ;;
    --accept=*) exit 91 ;;
  esac
  previous="$argument"
done
[ -n "$outdir" ]
[ -n "$profile" ]
printf '%s' '%PDF-1.4\n%%EOF' > "$outdir/source.pdf"
`);
    const converter = new LibreOfficeLegacyDocConverter(executable.path, executable.sha256, '25.8.7.2');
    const result = await converter.convert(Buffer.from('synthetic legacy doc'));
    expect(result).toMatchObject({
      mediaType: 'application/pdf',
      converterId: 'libreoffice-headless',
      converterVersion: '25.8.7.2',
      executableSha256: executable.sha256
    });
    expect(Buffer.from(result.bytes).subarray(0, 5).toString()).toBe('%PDF-');
  });

  it('组件哈希不匹配时在启动前失败关闭', async () => {
    const executable = fakeExecutable('echo "LibreOffice 25.8.7.2"');
    const converter = new LibreOfficeLegacyDocConverter(executable.path, '0'.repeat(64), '25.8.7.2');
    await expect(converter.convert(Buffer.from('synthetic legacy doc'))).rejects.toThrow('LEGACY_DOC_CONVERTER_HASH_MISMATCH');
  });

  it('转换超时会终止自己的子进程并清理临时目录', async () => {
    const executable = fakeExecutable(`
if [ "\${1:-}" = "--version" ]; then echo "LibreOffice 25.8.7.2"; exit 0; fi
sleep 5
`);
    const converter = new LibreOfficeLegacyDocConverter(executable.path, executable.sha256, '25.8.7.2', 80);
    await expect(converter.convert(Buffer.from('synthetic legacy doc'))).rejects.toThrow('LEGACY_DOC_CONVERSION_TIMEOUT');
  });
});
