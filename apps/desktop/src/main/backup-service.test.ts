import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { WorkspaceStore } from '@storage';
import { PersonalWorkspaceService } from './workspace-service.js';
import { assertBackupArchiveEntryPath, BACKUP_SECURITY_PROFILE, createEncryptedBackup, prepareEncryptedRestore, recoverInterruptedWorkspaceSwitch, replaceWorkspaceWithPreparedRestore } from './backup-service.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('encrypted workspace backup', () => {
  it('创建加密一致性快照，错误口令失败，正确口令恢复并核验对象', async () => {
    const root = mkdtempSync(join(tmpdir(), 'family-health-backup-test-'));
    roots.push(root);
    const liveRoot = join(root, 'workspace');
    const service = new PersonalWorkspaceService(liveRoot, '测试家庭档案', () => new Date('2026-09-18T02:00:00Z'));
    const personId = service.ensurePrimaryMember({ displayName: '测试用户', relation: '本人' });
    await service.importFiles([{ path: '/tmp/虚构备份报告.txt', bytes: Buffer.from('纯虚构备份资料') }], personId);
    const backupPath = join(root, 'family-health.fhbackup');
    const receipt = await createEncryptedBackup({
      store: service.store,
      workspaceName: service.workspaceName,
      targetPath: backupPath,
      passphrase: 'correct horse battery staple',
      temporaryRoot: root,
      now: () => new Date('2026-09-18T02:00:00Z')
    });
    expect(receipt).toEqual({ objectCount: 1, createdAt: '2026-09-18T02:00:00.000Z' });
    await expect(prepareEncryptedRestore({
      backupPath,
      passphrase: 'wrong password',
      temporaryRoot: root
    })).rejects.toThrow('BACKUP_PASSPHRASE_OR_INTEGRITY_INVALID');

    const prepared = await prepareEncryptedRestore({
      backupPath,
      passphrase: 'correct horse battery staple',
      temporaryRoot: root
    });
    expect(prepared.workspaceName).toBe('测试家庭档案');
    const restored = new WorkspaceStore({ rootDirectory: prepared.stagedRoot });
    expect(restored.integrityCheck()).toBe('ok');
    expect(restored.listPersons()).toEqual([expect.objectContaining({ displayName: '测试用户' })]);
    expect(restored.listImportedDocuments()).toHaveLength(1);
    restored.close();

    service.close();
    const replacement = await replaceWorkspaceWithPreparedRestore({ liveRoot, stagedRoot: prepared.stagedRoot });
    const reopened = new WorkspaceStore({ rootDirectory: liveRoot });
    expect(reopened.listPersons()).toEqual([expect.objectContaining({ displayName: '测试用户' })]);
    reopened.close();
    expect(replacement.recoveryRoot).toContain('.before-restore-');
  });

  it('篡改或截断备份会整体失败并清理准备目录，现有工作区不受影响', async () => {
    const root = mkdtempSync(join(tmpdir(), 'family-health-backup-tamper-'));
    roots.push(root);
    const liveRoot = join(root, 'workspace');
    const service = new PersonalWorkspaceService(liveRoot, '原工作区', () => new Date('2026-09-18T02:00:00Z'));
    const personId = service.ensurePrimaryMember({ displayName: '仍然存在', relation: '本人' });
    await service.importFiles([{ path: '/tmp/虚构备份报告.txt', bytes: Buffer.from('纯虚构备份资料') }], personId);
    const backupPath = join(root, 'valid.fhbackup');
    await createEncryptedBackup({
      store: service.store,
      workspaceName: service.workspaceName,
      targetPath: backupPath,
      passphrase: 'correct horse battery staple',
      temporaryRoot: root
    });
    const validBytes = readFileSync(backupPath);
    const tampered = Buffer.from(validBytes);
    tampered[Math.floor(tampered.length / 2)]! ^= 0xff;
    const tamperedPath = join(root, 'tampered.fhbackup');
    writeFileSync(tamperedPath, tampered);
    const truncatedPath = join(root, 'truncated.fhbackup');
    writeFileSync(truncatedPath, validBytes.subarray(0, 20));

    await expect(prepareEncryptedRestore({ backupPath: tamperedPath, passphrase: 'correct horse battery staple', temporaryRoot: root })).rejects.toThrow('BACKUP_PASSPHRASE_OR_INTEGRITY_INVALID');
    await expect(prepareEncryptedRestore({ backupPath: truncatedPath, passphrase: 'correct horse battery staple', temporaryRoot: root })).rejects.toThrow('BACKUP_TRUNCATED');
    expect(readdirSync(root).filter((name) => name.startsWith('family-health-restore-'))).toEqual([]);
    expect(service.store.listPersons()).toEqual([expect.objectContaining({ displayName: '仍然存在' })]);
    expect(service.store.integrityCheck()).toBe('ok');
    service.close();
  });

  it('拒绝备份路径穿越且备份格式没有攻击者可控的 KDF 参数', () => {
    expect(() => assertBackupArchiveEntryPath('../health.db')).toThrow('BACKUP_ENTRY_PATH_REJECTED');
    expect(() => assertBackupArchiveEntryPath('vault/aa/bb/../../escape')).toThrow('BACKUP_ENTRY_PATH_REJECTED');
    expect(() => assertBackupArchiveEntryPath('vault/aa/bb/not-a-hash')).toThrow('BACKUP_ENTRY_PATH_REJECTED');
    expect(BACKUP_SECURITY_PROFILE).toMatchObject({
      kdf: 'scrypt-fixed-v1',
      acceptsArchiveKdfParameters: false,
      derivedKeyBytes: 32
    });
  });

  it('准备副本切换失败时原子回滚到旧工作区', async () => {
    const root = mkdtempSync(join(tmpdir(), 'family-health-restore-rollback-'));
    roots.push(root);
    const liveRoot = join(root, 'workspace');
    const service = new PersonalWorkspaceService(liveRoot, '原工作区', () => new Date('2026-09-18T02:00:00Z'));
    service.ensurePrimaryMember({ displayName: '回滚后仍存在', relation: '本人' });
    service.close();

    await expect(replaceWorkspaceWithPreparedRestore({
      liveRoot,
      stagedRoot: join(root, 'missing-prepared-workspace')
    })).rejects.toThrow();
    expect(existsSync(liveRoot)).toBe(true);
    const reopened = new WorkspaceStore({ rootDirectory: liveRoot });
    expect(reopened.listPersons()).toEqual([expect.objectContaining({ displayName: '回滚后仍存在' })]);
    expect(reopened.integrityCheck()).toBe('ok');
    reopened.close();
  });

  it('恢复可取消，模拟磁盘不足会清理准备副本且不触碰当前工作区', async () => {
    const root = mkdtempSync(join(tmpdir(), 'family-health-restore-faults-'));
    roots.push(root);
    const liveRoot = join(root, 'workspace');
    const service = new PersonalWorkspaceService(liveRoot, '原工作区', () => new Date('2026-09-18T02:00:00Z'));
    const personId = service.ensurePrimaryMember({ displayName: '原成员', relation: '本人' });
    await service.importFiles([{ path: '/tmp/恢复故障测试.txt', bytes: Buffer.from('纯虚构资料') }], personId);
    const backupPath = join(root, 'valid.fhbackup');
    await createEncryptedBackup({
      store: service.store,
      workspaceName: service.workspaceName,
      targetPath: backupPath,
      passphrase: 'correct horse battery staple',
      temporaryRoot: root
    });

    const controller = new AbortController();
    controller.abort();
    await expect(prepareEncryptedRestore({
      backupPath,
      passphrase: 'correct horse battery staple',
      temporaryRoot: root,
      signal: controller.signal
    })).rejects.toThrow('BACKUP_RESTORE_CANCELLED');
    await expect(prepareEncryptedRestore({
      backupPath,
      passphrase: 'correct horse battery staple',
      temporaryRoot: root,
      failureInjector: () => { throw new Error('ENOSPC: no space left on device'); }
    })).rejects.toThrow('ENOSPC');
    expect(readdirSync(root).filter((name) => name.startsWith('family-health-restore-'))).toEqual([]);
    expect(service.store.listPersons()).toEqual([expect.objectContaining({ displayName: '原成员' })]);
    expect(service.store.integrityCheck()).toBe('ok');
    service.close();
  });

  it('启动时找回原子切换窗口中遗留的旧工作区', () => {
    const root = mkdtempSync(join(tmpdir(), 'family-health-restore-crash-'));
    roots.push(root);
    const liveRoot = join(root, 'workspace');
    const recoveryRoot = `${liveRoot}.before-restore-crash-fixture`;
    const interrupted = new PersonalWorkspaceService(recoveryRoot, '崩溃前工作区', () => new Date('2026-09-18T02:00:00Z'));
    interrupted.ensurePrimaryMember({ displayName: '可恢复成员', relation: '本人' });
    interrupted.close();

    expect(recoverInterruptedWorkspaceSwitch(liveRoot)).toEqual({ recovered: true, recoveryRoot });
    expect(existsSync(liveRoot)).toBe(true);
    expect(existsSync(recoveryRoot)).toBe(false);
    const reopened = new WorkspaceStore({ rootDirectory: liveRoot });
    expect(reopened.listPersons()).toEqual([expect.objectContaining({ displayName: '可恢复成员' })]);
    expect(reopened.integrityCheck()).toBe('ok');
    reopened.close();
  });
});
