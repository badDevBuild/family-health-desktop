import { describe, expect, it } from 'vitest';
import { createDemoSnapshot } from '../../../../packages/test-fixtures/src/index.js';
import { buildDiagnosticBundle, renderDiagnosticBundle } from './diagnostic-service.js';

describe('脱敏诊断包', () => {
  it('只包含计数和运行状态，不包含成员、文件、正文或凭据哨兵', () => {
    const snapshot = createDemoSnapshot(new Date('2026-09-18T00:00:00Z'));
    snapshot.persons[0]!.displayName = 'PHI_SENTINEL_PERSON';
    snapshot.inbox[0]!.displayName = 'PHI_SENTINEL_FILE.pdf';
    snapshot.inbox[0]!.issue = 'PHI_SENTINEL_BODY';
    snapshot.account.displayLabel = 'SECRET_ACCOUNT_SENTINEL';
    const bundle = buildDiagnosticBundle({
      snapshot,
      applicationVersion: '0.1.0',
      platform: 'darwin',
      arch: 'arm64',
      now: new Date('2026-09-18T00:00:00Z')
    });
    const rendered = renderDiagnosticBundle(bundle);
    expect(bundle.workspace).toMatchObject({ personCount: 3, documentCount: snapshot.inbox.length });
    expect(rendered).not.toContain('PHI_SENTINEL');
    expect(rendered).not.toContain('SECRET_ACCOUNT_SENTINEL');
    expect(bundle.privacy).toEqual({
      telemetryEnabled: false,
      containsHealthContent: false,
      containsFileNames: false,
      containsPaths: false,
      containsCredentials: false
    });
  });
});
