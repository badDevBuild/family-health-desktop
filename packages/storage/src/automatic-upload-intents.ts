import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';

/** 上传意图只保存精确选择范围；恢复时只读已经进入本机保险库的原件。 */
export const AUTOMATIC_UPLOAD_INTENTS_SQL = `
  CREATE TABLE IF NOT EXISTS automatic_upload_intents (
    id TEXT PRIMARY KEY, person_id TEXT NOT NULL REFERENCES persons(id),
    account_fingerprint TEXT, authorization_epoch INTEGER NOT NULL,
    consent_version INTEGER NOT NULL, prompt_version TEXT NOT NULL, rules_version TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('importing','completed','stopped')),
    batch_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS automatic_upload_intent_items (
    intent_id TEXT NOT NULL REFERENCES automatic_upload_intents(id) ON DELETE CASCADE,
    item_index INTEGER NOT NULL, display_name TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('selected','saved','ready','queued','duplicate','failed')),
    document_id TEXT REFERENCES documents(id), source_object_id TEXT REFERENCES source_objects(id),
    source_sha256 TEXT, failure_code TEXT,
    PRIMARY KEY(intent_id,item_index)
  );
  CREATE INDEX IF NOT EXISTS automatic_upload_intent_document ON automatic_upload_intent_items(document_id);
`;
export interface AutomaticUploadIntentInput {
  personId: string; accountFingerprint: string | null; authorizationEpoch: number; version: number;
  promptVersion: string; rulesVersion: string; displayNames: string[];
}
export interface AutomaticUploadIntentBinding {
  intentId: string; itemIndex: number; documentId: string; sourceObjectId: string; sha256: string; duplicate: boolean;
}
export interface AutomaticUploadRecoveryItem {
  intentId: string; itemIndex: number; documentId: string; personId: string; sourceObjectId: string; sha256: string;
}
interface IntentRow {
  id: string; person_id: string; account_fingerprint: string | null; authorization_epoch: number;
  consent_version: number; prompt_version: string; rules_version: string; status: string; batch_id: string | null;
}
interface IntentItemRow {
  item_index: number; status: string; document_id: string | null; source_object_id: string | null; source_sha256: string | null;
}
export type AutomaticUploadIntentHooks = {
  getAuthorizationEpoch: () => number;
  createBatch: (input: { personId: string; documentIds: string[]; accountFingerprint: string | null;
    authorizationEpoch: number; version: number; promptVersion: string; rulesVersion: string }) => { batchId: string; idempotent: boolean };
};

export class AutomaticUploadIntentStore {
  constructor(private readonly db: Database.Database, private readonly now: () => Date,
    private readonly hooks: AutomaticUploadIntentHooks) {}

  begin(input: AutomaticUploadIntentInput): string {
    return this.db.transaction(() => {
      if (input.authorizationEpoch !== this.hooks.getAuthorizationEpoch()) throw new Error('AUTOMATIC_UPLOAD_AUTHORIZATION_CHANGED');
      if (!Number.isSafeInteger(input.version) || input.version < 1 || !input.promptVersion || !input.rulesVersion
        || !input.displayNames.length || input.displayNames.length > 100 || input.displayNames.some((name) => !name.trim())) {
        throw new Error('AUTOMATIC_UPLOAD_INTENT_SCOPE_INVALID');
      }
      if (!this.db.prepare('SELECT 1 FROM persons WHERE id=? AND archived_at IS NULL').get(input.personId)) throw new Error('PERSON_NOT_FOUND');
      const id = randomUUID(); const timestamp = this.now().toISOString();
      this.db.prepare(`INSERT INTO automatic_upload_intents VALUES (?,?,?,?,?,?,?,'importing',NULL,?,?)`)
        .run(id, input.personId, input.accountFingerprint, input.authorizationEpoch, input.version,
          input.promptVersion, input.rulesVersion, timestamp, timestamp);
      const insert = this.db.prepare(`INSERT INTO automatic_upload_intent_items
        (intent_id,item_index,display_name,status) VALUES (?,?,?,'selected')`);
      input.displayNames.forEach((name, index) => insert.run(id, index, name));
      return id;
    })();
  }

  /** 必须在 registerImportedDocument 自身事务内调用，避免文档已保存却没有恢复归属。 */
  bindDocument(input: AutomaticUploadIntentBinding): void {
    const intent = this.intent(input.intentId);
    const item = this.item(input.intentId, input.itemIndex);
    if (intent.status !== 'importing' || item.status !== 'selected') throw new Error('AUTOMATIC_UPLOAD_INTENT_INACTIVE');
    const document = this.db.prepare(`SELECT d.person_id,d.source_object_id,d.status,d.excluded_from_analysis,s.sha256
      FROM documents d JOIN source_objects s ON s.id=d.source_object_id WHERE d.id=?`).get(input.documentId) as {
        person_id: string | null; source_object_id: string; status: string; excluded_from_analysis: number; sha256: string;
      } | undefined;
    if (!document || !input.duplicate && document.person_id !== intent.person_id || document.source_object_id !== input.sourceObjectId
      || document.sha256 !== input.sha256) throw new Error('AUTOMATIC_UPLOAD_INTENT_SOURCE_CHANGED');
    // 完成/旧本机/其他上传意图的重复文件都不扩大本次授权；原意图另行恢复。
    this.db.prepare(`UPDATE automatic_upload_intent_items SET status=?,document_id=?,source_object_id=?,source_sha256=?
      WHERE intent_id=? AND item_index=?`).run(input.duplicate ? 'duplicate' : 'saved', input.documentId,
      input.sourceObjectId, input.sha256, input.intentId, input.itemIndex);
  }

  markReady(intentId: string, itemIndex: number): void {
    this.db.transaction(() => {
      const intent = this.intent(intentId); const item = this.item(intentId, itemIndex);
      if (intent.status !== 'importing' || !['saved', 'ready'].includes(item.status) || !this.sourceCurrent(intent, item)) {
        throw new Error('AUTOMATIC_UPLOAD_INTENT_SOURCE_CHANGED');
      }
      const manifest = this.db.prepare(`SELECT 1 FROM source_manifests WHERE document_id=? AND source_object_id=? AND sha256=?`)
        .get(item.document_id, item.source_object_id, item.source_sha256);
      if (!manifest) throw new Error('AUTOMATIC_UPLOAD_INTENT_PREPARATION_INCOMPLETE');
      this.db.prepare(`UPDATE automatic_upload_intent_items SET status='ready' WHERE intent_id=? AND item_index=?`)
        .run(intentId, itemIndex);
    })();
  }

  markRejected(intentId: string, itemIndex: number, code: string): void {
    this.db.prepare(`UPDATE automatic_upload_intent_items SET status='failed',failure_code=?
      WHERE intent_id=? AND item_index=? AND status IN ('selected','saved','ready')`)
      .run(/^[A-Z][A-Z0-9_]{0,99}$/u.test(code) ? code : 'IMPORT_FAILED', intentId, itemIndex);
  }

  finalize(intentId: string): { batchId: string; accountFingerprint: string | null } | null {
    return this.db.transaction(() => {
      const intent = this.intent(intentId);
      if (intent.status === 'completed') return intent.batch_id ? { batchId: intent.batch_id, accountFingerprint: intent.account_fingerprint } : null;
      if (intent.status !== 'importing') return null;
      const items = this.items(intentId);
      if (items.some((item) => ['selected', 'saved'].includes(item.status))) return null;
      if (intent.authorization_epoch !== this.hooks.getAuthorizationEpoch()) {
        this.stop(intentId); return null;
      }
      const ready = items.filter((item) => item.status === 'ready').filter((item) => {
        if (this.sourceCurrent(intent, item)) return true;
        this.markRejected(intentId, item.item_index, 'AUTOMATIC_UPLOAD_INTENT_SOURCE_CHANGED'); return false;
      });
      if (!ready.length) { this.complete(intentId, null); return null; }
      const result = this.hooks.createBatch({ personId: intent.person_id,
        documentIds: ready.map((item) => item.document_id!), accountFingerprint: intent.account_fingerprint,
        authorizationEpoch: intent.authorization_epoch, version: intent.consent_version,
        promptVersion: intent.prompt_version, rulesVersion: intent.rules_version });
      this.db.prepare(`UPDATE automatic_upload_intent_items SET status='queued' WHERE intent_id=? AND status='ready'`).run(intentId);
      this.complete(intentId, result.batchId);
      return { batchId: result.batchId, accountFingerprint: intent.account_fingerprint };
    })();
  }

  /** 启动恢复不重新打开用户原路径；未复制项终止，已存原件才进入准备队列。 */
  listRecoveryItems(): AutomaticUploadRecoveryItem[] {
    return this.db.transaction(() => {
      const intents = this.db.prepare(`SELECT * FROM automatic_upload_intents WHERE status='importing' ORDER BY created_at,id`)
        .all() as IntentRow[];
      const result: AutomaticUploadRecoveryItem[] = [];
      for (const intent of intents) {
        if (intent.authorization_epoch !== this.hooks.getAuthorizationEpoch()) { this.stop(intent.id); continue; }
        this.db.prepare(`UPDATE automatic_upload_intent_items SET status='failed',failure_code='UPLOAD_INTERRUPTED_BEFORE_COPY'
          WHERE intent_id=? AND status='selected'`).run(intent.id);
        for (const item of this.items(intent.id)) {
          if (!['saved', 'ready'].includes(item.status)) continue;
          if (!this.sourceCurrent(intent, item)) { this.markRejected(intent.id, item.item_index, 'AUTOMATIC_UPLOAD_INTENT_SOURCE_CHANGED'); continue; }
          result.push({ intentId: intent.id, itemIndex: item.item_index, documentId: item.document_id!,
            personId: intent.person_id, sourceObjectId: item.source_object_id!, sha256: item.source_sha256! });
        }
      }
      return result;
    })();
  }

  listOpenIntentIds(): string[] {
    return (this.db.prepare(`SELECT id FROM automatic_upload_intents WHERE status='importing'`).all() as { id: string }[]).map((row) => row.id);
  }

  hasPendingPerson(personId: string, accountFingerprint: string | null): boolean {
    return Boolean(this.db.prepare(`SELECT 1 FROM automatic_upload_intents i
      JOIN automatic_upload_intent_items x ON x.intent_id=i.id
      WHERE i.person_id=? AND i.status='importing' AND i.authorization_epoch=? AND i.account_fingerprint IS ?
      AND x.status IN ('selected','saved','ready') LIMIT 1`).get(personId, this.hooks.getAuthorizationEpoch(), accountFingerprint));
  }

  /** 永久删除原件前撤销其未完成意图，并移除该资料在意图中的显示名与外键。 */
  detachDocument(documentId: string): void {
    this.db.transaction(() => {
      const linked = this.db.prepare('SELECT DISTINCT intent_id FROM automatic_upload_intent_items WHERE document_id=?')
        .all(documentId) as { intent_id: string }[];
      for (const row of linked) this.stop(row.intent_id);
      this.db.prepare('DELETE FROM automatic_upload_intent_items WHERE document_id=?').run(documentId);
    })();
  }

  private sourceCurrent(intent: IntentRow, item: IntentItemRow): boolean {
    return Boolean(this.db.prepare(`SELECT 1 FROM documents d JOIN persons p ON p.id=d.person_id AND p.archived_at IS NULL
      JOIN source_objects s ON s.id=d.source_object_id
      WHERE d.id=? AND d.person_id=? AND d.source_object_id=? AND s.sha256=?
      AND d.status='queued' AND d.excluded_from_analysis=0 AND d.person_assignment_basis IN ('user_selected','identity_confirmed')`)
      .get(item.document_id, intent.person_id, item.source_object_id, item.source_sha256));
  }
  private intent(id: string): IntentRow {
    const row = this.db.prepare('SELECT * FROM automatic_upload_intents WHERE id=?').get(id) as IntentRow | undefined;
    if (!row) throw new Error('AUTOMATIC_UPLOAD_INTENT_NOT_FOUND'); return row;
  }
  private item(id: string, index: number): IntentItemRow {
    const row = this.db.prepare('SELECT * FROM automatic_upload_intent_items WHERE intent_id=? AND item_index=?').get(id, index) as IntentItemRow | undefined;
    if (!row) throw new Error('AUTOMATIC_UPLOAD_INTENT_ITEM_NOT_FOUND'); return row;
  }
  private items(id: string): IntentItemRow[] {
    return this.db.prepare('SELECT * FROM automatic_upload_intent_items WHERE intent_id=? ORDER BY item_index').all(id) as IntentItemRow[];
  }
  private complete(id: string, batchId: string | null): void {
    this.db.prepare(`UPDATE automatic_upload_intents SET status='completed',batch_id=?,updated_at=? WHERE id=?`)
      .run(batchId, this.now().toISOString(), id);
  }
  private stop(id: string): void {
    this.db.prepare(`UPDATE automatic_upload_intents SET status='stopped',updated_at=? WHERE id=?`).run(this.now().toISOString(), id);
  }
}
