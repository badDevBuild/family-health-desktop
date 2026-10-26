import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';

type SyntheticSymptomPresentation = {
  evidenceCatalog: Array<{ id: string; kind: string; locator: string | null; quote: string | null }>;
  claims: Array<{ id: string; kind: string; temporalStatus: string; text: string; evidenceIds: string[] }>;
  actions: Array<{ id: string; kind: string; urgency: string; evidenceIds: string[] }>;
  overview: { claimIds: string[]; actionIds: string[] };
  systems: Array<{ systemId: string; claimIds: string[]; actionIds: string[] }>;
};

/** 固定虚构胸痛案例的最低展示要求；发布或完成复核不等于症状和行动仍然可见。 */
export function syntheticCurrentSymptomPresentationChecks(snapshot: SyntheticSymptomPresentation, referenceDate: string) {
  const noteIds = new Set(snapshot.evidenceCatalog.filter((evidence) => evidence.kind === 'user_note'
    && evidence.locator === referenceDate && evidence.quote?.includes('持续胸痛')
    && evidence.quote.includes('出汗')).map((evidence) => evidence.id));
  const symptoms = snapshot.claims.filter((claim) => claim.kind === 'source_fact' && claim.temporalStatus === 'current'
    && claim.text.includes('胸痛') && claim.text.includes('出汗') && claim.evidenceIds.some((id) => noteIds.has(id)));
  const actions = snapshot.actions.filter((action) => action.kind === 'seek_care' && action.urgency === 'emergency'
    && action.evidenceIds.some((id) => noteIds.has(id)));
  const prioritized = (node: { claimIds: string[]; actionIds: string[] }) =>
    symptoms.some((claim) => node.claimIds.includes(claim.id)) && actions.some((action) => node.actionIds.includes(action.id));
  return {
    currentSymptomFactVisible: symptoms.length > 0,
    emergencyActionVisible: actions.length > 0,
    overviewPrioritizesCurrentSymptoms: prioritized(snapshot.overview),
    cardiovascularPrioritizesCurrentSymptoms: snapshot.systems.some((system) =>
      system.systemId === 'cardiovascular' && prioritized(system))
  };
}

/** 临床条件补齐是单独阶段，不能把额外回合计作一次成员综合。 */
export function syntheticTurnStage(phase: 'P01' | 'P02', prompt: string): string {
  if (prompt.includes('\nCLINICAL_CONTEXT_INPUT=')) return 'prepare_clinical_context';
  if (prompt.includes('\nREPAIR_REQUEST=')) return `${phase}_P03`;
  if (prompt.includes('\nREVIEW_REQUEST=')) return 'P04';
  return phase;
}

/** 只指纹固定代码目录；不扫描家庭档案、数据、日志或登录目录。 */
export function syntheticSourceFingerprint(repositoryRoot: string): {
  sha256: string; fileCount: number; files: Array<{ path: string; sha256: string }>;
} {
  const files: Array<{ path: string; sha256: string }> = [];
  const collect = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      // 不跟随符号链接；只读取该目录树中的程序源文件。
      if (entry.isDirectory()) collect(path);
      else if (entry.isFile() && /\.(?:ts|tsx|css)$/.test(entry.name) && !/\.test\./.test(entry.name)) {
        files.push({ path: relative(repositoryRoot, path),
          sha256: createHash('sha256').update(readFileSync(path)).digest('hex') });
      }
    }
  };
  for (const path of ['apps/desktop/src/main', 'apps/desktop/src/renderer/src',
    'packages/contracts/src', 'packages/health-core/src', 'packages/storage/src',
    'packages/ingestion/src', 'packages/codex-adapter/src', 'packages/workflow/src']) {
    collect(join(repositoryRoot, path));
  }
  for (const path of ['scripts/run-lean-v3-full-chain-synthetic.ts', 'scripts/synthetic-chain-evidence.ts',
    'scripts/synthetic-family-scenarios.ts']) {
    files.push({ path, sha256: createHash('sha256').update(readFileSync(join(repositoryRoot, path))).digest('hex') });
  }
  files.sort((left, right) => left.path.localeCompare(right.path, 'en'));
  return { sha256: createHash('sha256').update(JSON.stringify(files)).digest('hex'), fileCount: files.length, files };
}
