/* global process */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

const files = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '*.md'], { encoding: 'utf8' })
  .split('\0')
  .filter(Boolean);
const failures = [];
const markdownLink = /\[[^\]]*\]\(([^)]+)\)/g;

for (const file of files) {
  const text = readFileSync(file, 'utf8');
  for (const match of text.matchAll(markdownLink)) {
    const rawTarget = match[1]?.trim();
    if (!rawTarget || rawTarget.startsWith('#') || /^[a-z][a-z0-9+.-]*:/i.test(rawTarget)) continue;
    const withoutTitle = rawTarget.startsWith('<') && rawTarget.endsWith('>')
      ? rawTarget.slice(1, -1)
      : rawTarget.split(/\s+["']/)[0];
    const [relativePath] = withoutTitle.split('#');
    if (!relativePath) continue;
    const target = resolve(dirname(file), decodeURIComponent(relativePath));
    if (!existsSync(target) || (!statSync(target).isFile() && !statSync(target).isDirectory())) {
      failures.push(`${file} -> ${rawTarget}`);
    }
  }
}

if (failures.length > 0) {
  process.stderr.write(`Broken documentation links:\n${failures.map((item) => `- ${item}`).join('\n')}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`Checked ${files.length} Markdown files; all relative links resolve.\n`);
}
