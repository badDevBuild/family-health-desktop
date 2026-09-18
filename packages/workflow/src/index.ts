import { createHash, randomUUID } from 'node:crypto';

export interface ScheduleConfig {
  id: string;
  enabled: boolean;
  localTime: `${number}:${number}`;
  timeZone: string;
  revision: number;
  lastSlot: string | null;
}

export interface EligibleSlot {
  key: string;
  localDate: string;
  scheduledLocalTime: string;
  observedAtUtc: string;
  scheduleRevision: number;
  missed: boolean;
}

function localParts(date: Date, timeZone: string): { date: string; time: string } {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23'
  });
  const parts = Object.fromEntries(formatter.formatToParts(date).map((part) => [part.type, part.value]));
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    time: `${parts.hour}:${parts.minute}`
  };
}

export function nextScheduledRunUtc(localTime: `${number}:${number}`, timeZone: string, now: Date): string {
  const start = new Date(Math.floor(now.getTime() / 60_000) * 60_000 + 60_000);
  const current = localParts(now, timeZone);
  for (let minute = 0; minute < 72 * 60; minute += 1) {
    const candidate = new Date(start.getTime() + minute * 60_000);
    const local = localParts(candidate, timeZone);
    const sameDayStillEligible = local.date === current.date && current.time < localTime;
    const futureDay = local.date > current.date;
    if ((sameDayStillEligible || futureDay) && local.time >= localTime) return candidate.toISOString();
  }
  throw new Error('SCHEDULE_TIME_UNRESOLVABLE');
}

export function determineEligibleSlot(config: ScheduleConfig, now: Date, hasReadySources: boolean): EligibleSlot | null {
  if (!config.enabled || !hasReadySources) return null;
  const local = localParts(now, config.timeZone);
  if (local.time < config.localTime) return null;
  const lastLocalDate = config.lastSlot?.match(/^[^:]+:(\d{4}-\d{2}-\d{2}):r\d+$/)?.[1] ?? null;
  if (lastLocalDate === local.date) return null;
  const key = `${config.id}:${local.date}:r${config.revision}`;
  if (config.lastSlot === key) return null;
  return {
    key,
    localDate: local.date,
    scheduledLocalTime: config.localTime,
    observedAtUtc: now.toISOString(),
    scheduleRevision: config.revision,
    missed: local.time > config.localTime
  };
}

export interface ReadySource {
  id: string;
  stableAt: string;
  personId: string | null;
  consentValid: boolean;
}

export interface FrozenBatch {
  id: string;
  trigger: 'manual' | 'scheduled' | 'missed';
  slotKey: string | null;
  cutoff: string;
  sourceIds: string[];
  createdAt: string;
}

export function freezeBatch(input: {
  trigger: FrozenBatch['trigger'];
  slotKey?: string | null;
  cutoff: Date;
  sources: ReadySource[];
  maxFiles: number;
}): FrozenBatch {
  const cutoffTime = input.cutoff.getTime();
  const sourceIds = input.sources
    .filter((source) => source.consentValid && source.personId !== null && new Date(source.stableAt).getTime() <= cutoffTime)
    .sort((a, b) => a.stableAt.localeCompare(b.stableAt) || a.id.localeCompare(b.id))
    .slice(0, input.maxFiles)
    .map((source) => source.id);
  return {
    id: randomUUID(),
    trigger: input.trigger,
    slotKey: input.slotKey ?? null,
    cutoff: input.cutoff.toISOString(),
    sourceIds,
    createdAt: input.cutoff.toISOString()
  };
}

export function jobInputSignature(input: {
  stage: string;
  personId: string;
  sourceRevisionIds: string[];
  factRevision: number;
  contextRevision: number;
  promptVersion: string;
  rulesVersion: string;
}): string {
  const canonical = JSON.stringify({
    ...input,
    sourceRevisionIds: [...input.sourceRevisionIds].sort()
  });
  return createHash('sha256').update(canonical).digest('hex');
}

export class LeaseCoordinator {
  private activeAiJobId: string | null = null;
  private readonly personWriters = new Map<string, string>();
  private readonly sourceOwners = new Map<string, string>();

  claimAi(jobId: string): boolean {
    if (this.activeAiJobId && this.activeAiJobId !== jobId) return false;
    this.activeAiJobId = jobId;
    return true;
  }

  releaseAi(jobId: string): void {
    if (this.activeAiJobId === jobId) this.activeAiJobId = null;
  }

  claimPersonWrite(jobId: string, personId: string): boolean {
    const owner = this.personWriters.get(personId);
    if (owner && owner !== jobId) return false;
    this.personWriters.set(personId, jobId);
    return true;
  }

  releasePersonWrite(jobId: string, personId: string): void {
    if (this.personWriters.get(personId) === jobId) this.personWriters.delete(personId);
  }

  claimSources(jobId: string, sourceIds: string[]): boolean {
    if (sourceIds.some((sourceId) => {
      const owner = this.sourceOwners.get(sourceId);
      return owner !== undefined && owner !== jobId;
    })) return false;
    for (const sourceId of sourceIds) this.sourceOwners.set(sourceId, jobId);
    return true;
  }

  releaseSources(jobId: string): void {
    for (const [sourceId, owner] of this.sourceOwners.entries()) {
      if (owner === jobId) this.sourceOwners.delete(sourceId);
    }
  }
}

export interface RetryDecision {
  action: 'retry' | 'wait_auth' | 'wait_quota' | 'wait_user' | 'fail';
  delayMs: number | null;
}

export function decideRetry(errorCode: string, attemptCount: number): RetryDecision {
  if (errorCode === 'AUTH_REQUIRED' || errorCode === 'AUTH_EXPIRED') return { action: 'wait_auth', delayMs: null };
  if (errorCode === 'QUOTA_UNAVAILABLE' || errorCode === 'QUOTA_EXHAUSTED') return { action: 'wait_quota', delayMs: null };
  if (errorCode === 'PERSON_CONFLICT' || errorCode === 'EVIDENCE_MISMATCH') return { action: 'wait_user', delayMs: null };
  if (['MODEL_REFUSAL', 'UNSUPPORTED_TOOL_REQUEST', 'RUNTIME_INCOMPATIBLE'].includes(errorCode)) return { action: 'fail', delayMs: null };
  if (attemptCount >= 3) return { action: 'fail', delayMs: null };
  return { action: 'retry', delayMs: 1_000 * (2 ** attemptCount) };
}
