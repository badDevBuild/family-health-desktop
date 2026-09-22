import { lstatSync, readFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { WORKSPACE_SCHEMA_VERSION } from '@storage';
import { PersonalWorkspaceService } from '../apps/desktop/src/main/workspace-service.js';

/** 只在固定前缀的系统临时目录中，将既有合成 v2 种子准备为 v34 升级冒烟库。 */
const rawUserData = process.argv.find((arg) => arg.startsWith('--user-data='))?.slice('--user-data='.length);
if (!rawUserData) throw new Error('SYNTHETIC_UPGRADE_USER_DATA_REQUIRED');
const userData = resolve(rawUserData);
if (dirname(userData) !== resolve(tmpdir()) || !basename(userData).startsWith('family-health-app-smoke-')) {
  throw new Error('SYNTHETIC_UPGRADE_PATH_NOT_ALLOWED');
}
if (WORKSPACE_SCHEMA_VERSION !== 35) throw new Error('SYNTHETIC_UPGRADE_SCHEMA_FIXTURE_OUTDATED');

const workspaceRoot = join(userData, 'workspace');
const databasePath = join(workspaceRoot, 'health.db');
for (const path of [userData, workspaceRoot, databasePath]) {
  if (lstatSync(path).isSymbolicLink()) throw new Error('SYNTHETIC_UPGRADE_SYMLINK_NOT_ALLOWED');
}
const localState = JSON.parse(readFileSync(join(userData, 'desktop-state.json'), 'utf8')) as {
  activeWorkspaceMode?: string; workspaceName?: string;
};
if (localState.activeWorkspaceMode !== 'personal' || localState.workspaceName !== '合成验收工作区') {
  throw new Error('SYNTHETIC_UPGRADE_STATE_MARKER_MISMATCH');
}
// 服务构造函数会迁移数据库；必须先以只读方式证明这里确为尚未处理的纯合成种子。
const preflight = new Database(databasePath, { readonly: true, fileMustExist: true });
try {
  const count = (table: string): number => (preflight.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count;
  const persons = preflight.prepare('SELECT display_name FROM persons').all() as Array<{ display_name: string }>;
  const sources = preflight.prepare('SELECT display_name FROM source_occurrences').all() as Array<{ display_name: string }>;
  const proposals = preflight.prepare('SELECT status FROM lifestyle_proposals_v2').all() as Array<{ status: string }>;
  if (preflight.pragma('user_version', { simple: true }) !== 35
    || persons.length !== 1 || persons[0]?.display_name !== '合成成员甲'
    || sources.length !== 1 || sources[0]?.display_name !== '合成年度健康报告.txt'
    || count('observations') !== 4 || count('member_assessment_snapshots_v3') !== 0
    || count('action_adoptions_v2') !== 0 || proposals.length !== 1 || proposals[0]?.status !== 'proposed') {
    throw new Error('SYNTHETIC_UPGRADE_PREFLIGHT_MISMATCH');
  }
} finally {
  preflight.close();
}
const service = new PersonalWorkspaceService(workspaceRoot, '合成升级验收工作区', () => new Date('2026-09-22T00:00:00Z'));
let personId: string;
let adoptedId: string;
let factCount: number;
try {
  const persons = service.store.listPersons();
  if (persons.length !== 1 || persons[0]?.displayName !== '合成成员甲') {
    throw new Error('SYNTHETIC_UPGRADE_MEMBER_SEED_REQUIRED');
  }
  personId = persons[0].id;
  const proposals = service.getLifestylePlan(personId).proposals;
  if (proposals.length !== 1 || proposals[0]?.status !== 'proposed') {
    throw new Error('SYNTHETIC_UPGRADE_LEGACY_PROPOSAL_REQUIRED');
  }
  factCount = service.store.listAcceptedObservations(personId).length;
  if (factCount !== 4) throw new Error('SYNTHETIC_UPGRADE_FACT_SEED_MISMATCH');
  // 用底层存储模拟旧版已采纳记录；当前应用服务入口不再接受旧建议的新采纳。
  const adopted = service.store.adoptLifestyleProposal({
    personId, proposalId: proposals[0].id, userGoal: '携带合成报告讨论复查安排',
    selectedStartingOption: '先整理合成资料', plannedTime: '下次就诊时', owner: '本人',
    progressNote: '已整理合成报告', dueDate: null
  });
  adoptedId = adopted.id;
  service.updateActionStatus({ actionId: adopted.id, status: 'completed', expectedRevision: 1 });
  if (service.getLifestylePlan(personId).adoptedActions[0]?.status !== 'completed') {
    throw new Error('SYNTHETIC_UPGRADE_ACTION_NOT_COMPLETED');
  }
} finally {
  service.close();
}

const database = new Database(databasePath);
try {
  if (database.pragma('user_version', { simple: true }) !== 35) throw new Error('SYNTHETIC_UPGRADE_SOURCE_SCHEMA_MISMATCH');
  const sourceNames = database.prepare(`SELECT display_name FROM source_occurrences`).all() as Array<{ display_name: string }>;
  if (sourceNames.length !== 1 || sourceNames[0]?.display_name !== '合成年度健康报告.txt') {
    throw new Error('SYNTHETIC_UPGRADE_SOURCE_FILE_MISMATCH');
  }
  const currentSnapshots = database.prepare(`SELECT COUNT(*) AS count FROM member_assessment_snapshots_v3`).get() as { count: number };
  if (currentSnapshots.count !== 0) throw new Error('SYNTHETIC_UPGRADE_CURRENT_SNAPSHOT_MUST_BE_EMPTY');
  database.exec('BEGIN IMMEDIATE');
  try {
    // v35 相对 v34 只新增此表；故只删除空的新表，不触碰旧数据表或 vault 原件。
    database.exec(`
      DROP TABLE member_assessment_snapshots_v3;
      UPDATE workspaces SET schema_version = 34;
      PRAGMA user_version = 34;
    `);
    database.exec('COMMIT');
  } catch (error) {
    if (database.inTransaction) database.exec('ROLLBACK');
    throw error;
  }
  if (database.pragma('user_version', { simple: true }) !== 34) throw new Error('SYNTHETIC_UPGRADE_TARGET_SCHEMA_MISMATCH');
  process.stdout.write(`${JSON.stringify({
    syntheticOnly: true, userData, schemaVersion: 34, personId, factCount,
    adoptedActionId: adoptedId, adoptedActionStatus: 'completed', sourceNames: sourceNames.map((item) => item.display_name)
  }, null, 2)}\n`);
} finally {
  database.close();
}
