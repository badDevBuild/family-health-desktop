import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const MAX_PROCESS_OUTPUT_BYTES = 32 * 1024;
const MAX_CONVERTED_PDF_BYTES = 200 * 1024 * 1024;

export interface LegacyDocConversionResult {
  bytes: Uint8Array;
  mediaType: 'application/pdf';
  sha256: string;
  converterId: 'libreoffice-headless';
  converterVersion: string;
  executableSha256: string;
}

export interface LegacyDocConverter {
  convert(bytes: Uint8Array): Promise<LegacyDocConversionResult>;
}

export interface LibreOfficeRuntimeManifest {
  schemaVersion: 1;
  component: 'libreoffice';
  version: string;
  target: string;
  executable: string;
  executableSha256: string;
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function appendBounded(current: string, chunk: Buffer): string {
  if (current.length >= MAX_PROCESS_OUTPUT_BYTES) return current;
  return `${current}${chunk.toString('utf8')}`.slice(0, MAX_PROCESS_OUTPUT_BYTES);
}

async function runProcess(input: {
  executablePath: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
}): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(input.executablePath, input.args, {
      cwd: input.cwd,
      env: input.env,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) rejectPromise(error);
      else resolvePromise({ stdout, stderr });
    };
    child.stdout.on('data', (chunk: Buffer) => { stdout = appendBounded(stdout, chunk); });
    child.stderr.on('data', (chunk: Buffer) => { stderr = appendBounded(stderr, chunk); });
    child.once('error', () => finish(new Error('LEGACY_DOC_CONVERTER_START_FAILED')));
    child.once('exit', (code, signal) => {
      if (code === 0) finish();
      else finish(new Error(signal ? 'LEGACY_DOC_CONVERTER_TERMINATED' : `LEGACY_DOC_CONVERTER_EXIT_${code ?? 'UNKNOWN'}`));
    });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(new Error('LEGACY_DOC_CONVERSION_TIMEOUT'));
    }, input.timeoutMs);
    timer.unref();
  });
}

function profileRegistryXml(): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<oor:items xmlns:oor="http://openoffice.org/2001/registry">
  <item oor:path="/org.openoffice.Office.Common/Security/Scripting">
    <prop oor:name="MacroSecurityLevel" oor:op="fuse"><value>3</value></prop>
    <prop oor:name="SecureURL" oor:op="fuse"><value></value></prop>
    <prop oor:name="BlockUntrustedRefererLinks" oor:op="fuse"><value>true</value></prop>
  </item>
</oor:items>
`;
}

export class LibreOfficeLegacyDocConverter implements LegacyDocConverter {
  constructor(
    private readonly executablePath: string,
    private readonly expectedExecutableSha256: string,
    private readonly expectedVersion: string,
    private readonly timeoutMs = 45_000
  ) {}

  async convert(bytes: Uint8Array): Promise<LegacyDocConversionResult> {
    if (!existsSync(this.executablePath)) throw new Error('LEGACY_DOC_CONVERTER_MISSING');
    const executableSha256 = sha256(readFileSync(this.executablePath));
    if (executableSha256 !== this.expectedExecutableSha256) throw new Error('LEGACY_DOC_CONVERTER_HASH_MISMATCH');

    const root = await mkdtemp(join(tmpdir(), 'family-health-doc-convert-'));
    chmodSync(root, 0o700);
    try {
      const profile = join(root, 'profile');
      const profileUser = join(profile, 'user');
      const output = join(root, 'output');
      mkdirSync(profileUser, { recursive: true, mode: 0o700 });
      mkdirSync(output, { recursive: true, mode: 0o700 });
      writeFileSync(join(profileUser, 'registrymodifications.xcu'), profileRegistryXml(), { encoding: 'utf8', mode: 0o600 });

      const version = await runProcess({
        executablePath: this.executablePath,
        args: ['--version'],
        cwd: root,
        env: this.restrictedEnvironment(root),
        timeoutMs: Math.min(this.timeoutMs, 10_000)
      });
      if (!`${version.stdout}\n${version.stderr}`.includes(this.expectedVersion)) {
        throw new Error('LEGACY_DOC_CONVERTER_VERSION_MISMATCH');
      }

      const sourcePath = join(root, 'source.doc');
      writeFileSync(sourcePath, bytes, { mode: 0o600 });
      const profileUrl = pathToFileURL(profile).href;
      await runProcess({
        executablePath: this.executablePath,
        args: [
          '--headless', '--nologo', '--nodefault', '--norestore', '--nolockcheck', '--nofirststartwizard',
          `-env:UserInstallation=${profileUrl}`,
          '--convert-to', 'pdf:writer_pdf_Export', '--outdir', output, sourcePath
        ],
        cwd: root,
        env: this.restrictedEnvironment(root),
        timeoutMs: this.timeoutMs
      });

      const outputPath = join(output, 'source.pdf');
      if (!existsSync(outputPath)) throw new Error('LEGACY_DOC_CONVERSION_OUTPUT_MISSING');
      const converted = readFileSync(outputPath);
      if (converted.byteLength === 0 || converted.byteLength > MAX_CONVERTED_PDF_BYTES) {
        throw new Error('LEGACY_DOC_CONVERSION_OUTPUT_LIMIT_EXCEEDED');
      }
      if (!converted.subarray(0, 5).equals(Buffer.from('%PDF-'))) throw new Error('LEGACY_DOC_CONVERSION_OUTPUT_INVALID');
      return {
        bytes: converted,
        mediaType: 'application/pdf',
        sha256: sha256(converted),
        converterId: 'libreoffice-headless',
        converterVersion: this.expectedVersion,
        executableSha256
      };
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  private restrictedEnvironment(root: string): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: root, TMPDIR: root, TEMP: root, TMP: root, SAL_DISABLE_CUPS: '1' };
    for (const key of Object.keys(env)) {
      if (/^(?:all|http|https|ftp|no)_proxy$/i.test(key)) delete env[key];
    }
    return env;
  }
}

export function loadLibreOfficeConverter(input: {
  manifestPath: string;
  expectedTarget: string;
}): LibreOfficeLegacyDocConverter {
  const manifestPath = resolve(input.manifestPath);
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Partial<LibreOfficeRuntimeManifest>;
  if (manifest.schemaVersion !== 1 || manifest.component !== 'libreoffice') throw new Error('LEGACY_DOC_CONVERTER_MANIFEST_INVALID');
  if (manifest.target !== input.expectedTarget) throw new Error('LEGACY_DOC_CONVERTER_TARGET_MISMATCH');
  if (!manifest.version || !manifest.executable || !manifest.executableSha256?.match(/^[a-f0-9]{64}$/)) {
    throw new Error('LEGACY_DOC_CONVERTER_MANIFEST_INVALID');
  }
  const root = realpathSync(resolve(manifestPath, '..'));
  const unresolvedExecutablePath = resolve(root, manifest.executable);
  if (unresolvedExecutablePath !== root && !unresolvedExecutablePath.startsWith(`${root}/`) && !unresolvedExecutablePath.startsWith(`${root}\\`)) {
    throw new Error('LEGACY_DOC_CONVERTER_PATH_INVALID');
  }
  if (!existsSync(unresolvedExecutablePath)) throw new Error('LEGACY_DOC_CONVERTER_MISSING');
  const executablePath = realpathSync(unresolvedExecutablePath);
  if (executablePath !== root && !executablePath.startsWith(`${root}/`) && !executablePath.startsWith(`${root}\\`)) {
    throw new Error('LEGACY_DOC_CONVERTER_PATH_INVALID');
  }
  return new LibreOfficeLegacyDocConverter(executablePath, manifest.executableSha256, manifest.version);
}
