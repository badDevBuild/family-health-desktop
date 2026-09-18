import type { DashboardSnapshot, DiagnosticBundle } from '@contracts';
import { diagnosticBundleSchema } from '@contracts';

function counts(values: string[], key: 'status' | 'stage'): Array<Record<'count' | typeof key, string | number>> {
  const grouped = new Map<string, number>();
  for (const value of values) grouped.set(value, (grouped.get(value) ?? 0) + 1);
  return [...grouped.entries()].sort(([left], [right]) => left.localeCompare(right))
    .map(([value, count]) => ({ [key]: value, count })) as Array<Record<'count' | typeof key, string | number>>;
}

export function buildDiagnosticBundle(input: {
  snapshot: DashboardSnapshot;
  applicationVersion: string;
  platform: string;
  arch: string;
  now?: Date;
}): DiagnosticBundle {
  const { snapshot } = input;
  return diagnosticBundleSchema.parse({
    formatVersion: 1,
    generatedAt: (input.now ?? new Date()).toISOString(),
    application: {
      version: input.applicationVersion,
      platform: input.platform,
      arch: input.arch,
      runtimeVersion: snapshot.account.runtimeVersion,
      runtimeStatus: snapshot.account.status
    },
    workspace: {
      mode: snapshot.workspaceMode,
      personCount: snapshot.persons.length,
      documentCount: snapshot.inbox.length,
      pendingInboxCount: snapshot.pendingInboxCount,
      actionCount: snapshot.actions.length,
      openReviewCount: snapshot.openReviewCount,
      queuePaused: snapshot.queuePaused,
      scheduleEnabled: snapshot.scheduleEnabled
    },
    taskSummary: {
      total: snapshot.jobs.length,
      statuses: counts(snapshot.jobs.map((job) => job.status), 'status'),
      stages: counts(snapshot.jobs.map((job) => job.stage), 'stage')
    },
    privacy: {
      telemetryEnabled: false,
      containsHealthContent: false,
      containsFileNames: false,
      containsPaths: false,
      containsCredentials: false
    }
  });
}

export function renderDiagnosticBundle(bundle: DiagnosticBundle): string {
  return `${JSON.stringify(bundle, null, 2)}\n`;
}
