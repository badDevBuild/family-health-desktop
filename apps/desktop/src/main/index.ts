import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, nativeTheme, Notification, powerMonitor, shell, Tray } from 'electron';
import { is } from '@electron-toolkit/utils';
import {
  accountStateSchema,
  aiPreferencesSchema,
  aiSettingsSchema,
  archivePersonInputSchema,
  confirmInboxBindingInputSchema,
  cleanupReceiptSchema,
  createActionItemInputSchema,
  createManualNoteInputSchema,
  createBackupInputSchema,
  createWorkspaceInputSchema,
  createPersonInputSchema,
  dashboardSnapshotSchema,
  deleteDocumentInputSchema,
  deleteDocumentReceiptSchema,
  deletedDocumentSummarySchema,
  disableInboxBindingInputSchema,
  displayPreferencesSchema,
  droppedFilePathsInputSchema,
  evidencePreviewRequestSchema,
  evidencePreviewSchema,
  exportMemberSummaryInputSchema,
  exportMemberSummaryReceiptSchema,
  inboxBindingSummarySchema,
  importFilesInputSchema,
  jobActionInputSchema,
  processNowInputSchema,
  personSchema,
  resolveReviewInputSchema,
  restoreBackupInputSchema,
  restorePersonInputSchema,
  releaseDeletedDocumentInputSchema,
  setDocumentInclusionInputSchema,
  setQueuePausedInputSchema,
  switchWorkspaceInputSchema,
  updateScheduleInputSchema,
  updateDesktopBehaviorInputSchema,
  updateDisplayPreferencesInputSchema,
  updateActionStatusInputSchema,
  updateAiPreferencesInputSchema,
  updatePersonDisplayInputSchema
} from '@contracts';
import { DEFAULT_AI_PREFERENCES } from '@contracts';
import type { AccountState, AiPreferences, ImportFilesReceipt } from '@contracts';
import { assertSafeInboxDirectory, INGESTION_LIMITS, loadLibreOfficeConverter, renderHeicImagesToPngs, renderPdfPagesToPngs, type LegacyDocConverter } from '@ingestion';
import { createDemoSnapshot } from '../../../../packages/test-fixtures/src/index.js';
import { CodexRuntimeManager } from './codex-runtime.js';
import { createEncryptedBackup, prepareEncryptedRestore, recoverInterruptedWorkspaceSwitch, replaceWorkspaceWithPreparedRestore } from './backup-service.js';
import { InboxWatcherManager } from './inbox-watcher.js';
import { ProcessingJobRunner } from './job-runner.js';
import { PersonalWorkspaceService } from './workspace-service.js';
import { buildMemberSummaryData, renderMemberSummaryHtml, renderMemberSummaryJson } from './export-service.js';
import { ensureLocalRecoveryPoints, getLocalRecoveryPointStatus } from './recovery-point-service.js';
import { buildDiagnosticBundle, renderDiagnosticBundle } from './diagnostic-service.js';
import { cleanupOwnedTemporaryEntries } from './cleanup-service.js';
import { resolveSmokeUserDataDirectory } from './smoke-user-data.js';

const smokeUserDataDirectory = resolveSmokeUserDataDirectory(process.argv, tmpdir());
if (smokeUserDataDirectory) {
  mkdirSync(smokeUserDataDirectory, { recursive: true, mode: 0o700 });
  app.commandLine.appendSwitch('user-data-dir', smokeUserDataDirectory);
  app.setPath('userData', smokeUserDataDirectory);
}

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let isQuitting = false;
let demoSnapshot = createDemoSnapshot(new Date());
let personalWorkspace: PersonalWorkspaceService | null = null;
let runtimeManager: CodexRuntimeManager | null = null;
let inboxWatcher: InboxWatcherManager | null = null;
let jobRunner: ProcessingJobRunner | null = null;
let activeWorkspaceMode: 'demo' | 'personal' = 'demo';
let scheduleTimer: NodeJS.Timeout | null = null;
let scheduleCoordinatorRunning = false;
let lastInboxReconcileAt = 0;
let recoveryPointDay: string | null = null;
let recoveryPointPromise: Promise<void> | null = null;
let activeRestoreAbortController: AbortController | null = null;
const pendingDirectorySelections = new Map<string, { canonicalPath: string; displayName: string; selectedAt: number }>();
const pendingBackupRestores = new Map<string, { path: string; displayName: string; selectedAt: number }>();

interface DesktopState {
  activeWorkspaceMode: 'demo' | 'personal';
  workspaceName: string | null;
  stayInTray: boolean | null;
  openAtLogin: boolean;
  notificationsEnabled: boolean;
  displayPreferences: {
    fontScale: 'standard' | 'large';
    reduceMotion: boolean;
    dateStyle: 'friendly' | 'numeric';
  };
  aiPreferences: AiPreferences;
}

const allowedExternalHosts = new Set(['auth.openai.com', 'chatgpt.com', 'openai.com']);
const lockedRuntimeVersion = '0.145.0';

function bundledCodexPath(): string {
  const executableName = process.platform === 'win32' ? 'codex.exe' : 'codex';
  const packagedResourcesRoot = dirname(app.getAppPath());
  return join(packagedResourcesRoot, 'runtime', 'codex', `${process.platform}-${process.arch}`, 'bin', executableName);
}

function resolveCodexExecutable(): string | null {
  const bundled = bundledCodexPath();
  if (existsSync(bundled)) return bundled;
  const explicitDevelopmentPath = is.dev ? process.env.FAMILY_HEALTH_CODEX_EXECUTABLE : undefined;
  return explicitDevelopmentPath && existsSync(explicitDevelopmentPath) ? explicitDevelopmentPath : null;
}

function resolveLegacyDocConverter(): LegacyDocConverter | null {
  const target = `${process.platform}-${process.arch}`;
  const packagedResourcesRoot = dirname(app.getAppPath());
  const bundledManifest = join(packagedResourcesRoot, 'runtime', 'libreoffice', target, 'component-manifest.json');
  const explicitDevelopmentManifest = is.dev ? process.env.FAMILY_HEALTH_LIBREOFFICE_MANIFEST : undefined;
  const manifestPath = existsSync(bundledManifest)
    ? bundledManifest
    : explicitDevelopmentManifest && existsSync(explicitDevelopmentManifest) ? explicitDevelopmentManifest : null;
  if (!manifestPath) return null;
  try {
    return loadLibreOfficeConverter({ manifestPath, expectedTarget: target });
  } catch {
    return null;
  }
}

function openPersonalWorkspace(rootDirectory: string, workspaceName: string): PersonalWorkspaceService {
  return new PersonalWorkspaceService(
    rootDirectory,
    workspaceName,
    () => new Date(),
    () => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
    resolveLegacyDocConverter()
  );
}

function isAllowedExternalUrl(rawUrl: string): boolean {
  try {
    const parsed = new URL(rawUrl);
    return parsed.protocol === 'https:' && allowedExternalHosts.has(parsed.hostname);
  } catch {
    return false;
  }
}

function currentAccountState(): AccountState {
  return runtimeManager?.getState() ?? accountStateSchema.parse({
    status: 'error',
    displayLabel: 'Codex 运行时未初始化',
    quota: { status: 'unknown', primaryUsedPercent: null, secondaryUsedPercent: null, resetsAt: null },
    runtimeVersion: null,
    lastCheckedAt: null
  });
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1100,
    minHeight: 720,
    show: false,
    backgroundColor: '#FAFAF8',
    title: '家庭健康看板',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      spellcheck: false
    }
  });

  mainWindow.once('ready-to-show', () => mainWindow?.show());
  mainWindow.on('close', (event) => {
    if (isQuitting || !mainWindow) return;
    event.preventDefault();
    const state = readDesktopState();
    if (state.stayInTray === true) {
      ensureTray();
      mainWindow.hide();
      return;
    }
    if (state.stayInTray === false) {
      isQuitting = true;
      app.quit();
      return;
    }
    void dialog.showMessageBox(mainWindow, {
      type: 'question',
      title: '关闭家庭健康看板',
      message: '关闭窗口后，是否让看板继续在后台检查已授权的报告目录？',
      detail: '驻留不会唤醒睡眠或关机的电脑；你可以随时从菜单栏/托盘真正退出，并在设置中更改。',
      buttons: ['驻留后台', '退出应用', '取消'],
      defaultId: 0,
      cancelId: 2,
      noLink: true
    }).then((result) => {
      if (result.response === 0) {
        writeDesktopState({ ...readDesktopState(), stayInTray: true });
        ensureTray();
        mainWindow?.hide();
      } else if (result.response === 1) {
        writeDesktopState({ ...readDesktopState(), stayInTray: false });
        isQuitting = true;
        app.quit();
      }
    });
  });
  mainWindow.on('closed', () => { mainWindow = null; });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (isAllowedExternalUrl(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (url !== mainWindow?.webContents.getURL()) event.preventDefault();
  });

  if (is.dev && process.env.ELECTRON_RENDERER_URL) {
    void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'));
  }
}

function trayIcon(): Electron.NativeImage {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32"><path fill="black" d="M16 28C8 23 4 18 4 11a6 6 0 0 1 11-3 6 6 0 0 1 11 3c0 7-4 12-10 17Z"/><path fill="white" d="M8 15h5l2-4 3 8 2-4h4v3h-2l-4 7-3-8-1 2H8Z"/></svg>`;
  const image = nativeImage.createFromDataURL(`data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`).resize({ width: 18, height: 18 });
  if (process.platform === 'darwin') image.setTemplateImage(true);
  return image;
}

function showMainWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) createWindow();
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function rebuildTrayMenu(): void {
  if (!tray) return;
  const snapshot = currentSnapshot();
  const paused = personalWorkspace?.store.isQueuePaused() ?? false;
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '打开家庭健康看板', click: showMainWindow },
    { label: `${snapshot.pendingInboxCount} 份资料待处理`, enabled: false },
    { label: '立即处理…', enabled: activeWorkspaceMode === 'personal', click: () => {
      showMainWindow();
      mainWindow?.webContents.send('tray:process-now-requested');
    } },
    { type: 'separator' },
    { label: paused ? '继续处理队列' : '暂停处理队列', enabled: Boolean(personalWorkspace), click: () => {
      if (!personalWorkspace) return;
      personalWorkspace.store.setQueuePaused(!paused);
      emitSnapshotChanged();
      if (paused) void jobRunner?.runAvailableJobs(personalWorkspace.store);
    } },
    { type: 'separator' },
    { label: '退出家庭健康看板', click: () => {
      isQuitting = true;
      app.quit();
    } }
  ]));
}

function ensureTray(): void {
  if (!tray) {
    tray = new Tray(trayIcon());
    tray.setToolTip('家庭健康看板');
    tray.on('click', showMainWindow);
  }
  rebuildTrayMenu();
}

function validateSender(event: Electron.IpcMainInvokeEvent): void {
  if (!mainWindow || event.sender.id !== mainWindow.webContents.id) {
    throw new Error('IPC_SENDER_REJECTED');
  }
}

function statePath(): string {
  return join(app.getPath('userData'), 'desktop-state.json');
}

function personalWorkspacePath(): string {
  return join(app.getPath('userData'), 'workspace');
}

function currentLocalDay(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

async function ensureRecoveryPointBeforeWrite(): Promise<void> {
  if (!personalWorkspace) throw new Error('PERSONAL_WORKSPACE_REQUIRED');
  const day = currentLocalDay();
  if (recoveryPointDay === day) return;
  if (!recoveryPointPromise) {
    recoveryPointPromise = ensureLocalRecoveryPoints({ store: personalWorkspace.store })
      .then(() => { recoveryPointDay = day; })
      .finally(() => { recoveryPointPromise = null; });
  }
  await recoveryPointPromise;
}

async function importSelectedPaths(paths: string[], personId: string | null): Promise<ImportFilesReceipt> {
  if (!personalWorkspace) throw new Error('PERSONAL_WORKSPACE_REQUIRED');
  const receipt: ImportFilesReceipt = {
    selectedCount: paths.length,
    importedCount: 0,
    duplicateCount: 0,
    suppressedCount: 0,
    rejected: []
  };
  if (paths.length === 0) return receipt;
  await ensureRecoveryPointBeforeWrite();
  for (const selectedPath of paths.slice(0, INGESTION_LIMITS.maxBatchFiles)) {
    const displayName = basename(selectedPath);
    try {
      const metadata = await stat(selectedPath);
      if (!metadata.isFile()) throw new Error('NOT_A_REGULAR_FILE');
      if (metadata.size <= 0) throw new Error('FILE_EMPTY');
      if (metadata.size > INGESTION_LIMITS.maxFileBytes) throw new Error('INPUT_LIMIT_EXCEEDED');
      const single = await personalWorkspace.importFiles([{ path: selectedPath, bytes: await readFile(selectedPath) }], personId);
      receipt.importedCount += single.importedCount;
      receipt.duplicateCount += single.duplicateCount;
      receipt.suppressedCount += single.suppressedCount;
      receipt.rejected.push(...single.rejected);
    } catch (error) {
      receipt.rejected.push({ displayName, code: error instanceof Error ? error.message : 'IMPORT_FAILED' });
    }
  }
  return receipt;
}

function readDesktopState(): DesktopState {
  try {
    const parsed = JSON.parse(readFileSync(statePath(), 'utf8')) as Partial<DesktopState>;
    return {
      activeWorkspaceMode: parsed.activeWorkspaceMode === 'personal' ? 'personal' : 'demo',
      workspaceName: typeof parsed.workspaceName === 'string' ? parsed.workspaceName : null,
      stayInTray: typeof parsed.stayInTray === 'boolean' ? parsed.stayInTray : null,
      openAtLogin: parsed.openAtLogin === true,
      notificationsEnabled: parsed.notificationsEnabled !== false,
      displayPreferences: displayPreferencesSchema.catch({ fontScale: 'standard', reduceMotion: false, dateStyle: 'friendly' }).parse(parsed.displayPreferences),
      aiPreferences: aiPreferencesSchema.catch(DEFAULT_AI_PREFERENCES).parse(parsed.aiPreferences)
    };
  } catch {
    return { activeWorkspaceMode: 'demo', workspaceName: null, stayInTray: null, openAtLogin: false, notificationsEnabled: true, displayPreferences: { fontScale: 'standard', reduceMotion: false, dateStyle: 'friendly' }, aiPreferences: DEFAULT_AI_PREFERENCES };
  }
}

function writeDesktopState(state: DesktopState): void {
  mkdirSync(app.getPath('userData'), { recursive: true, mode: 0o700 });
  const target = statePath();
  const temporary = `${target}.${randomUUID()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  renameSync(temporary, target);
}

function initializeWorkspaceState(): void {
  const state = readDesktopState();
  if (state.workspaceName) recoverInterruptedWorkspaceSwitch(personalWorkspacePath());
  if (state.workspaceName && existsSync(join(personalWorkspacePath(), 'health.db'))) {
    personalWorkspace = openPersonalWorkspace(personalWorkspacePath(), state.workspaceName);
    activeWorkspaceMode = state.activeWorkspaceMode;
  } else {
    activeWorkspaceMode = 'demo';
  }
}

function initializeRuntime(): void {
  const executable = resolveCodexExecutable();
  runtimeManager = new CodexRuntimeManager({
    executable,
    runtimeVersion: executable ? lockedRuntimeVersion : null,
    codexHome: join(app.getPath('userData'), 'codex-home'),
    workingDirectory: join(app.getPath('userData'), 'runtime-work')
  });
  jobRunner = new ProcessingJobRunner(runtimeManager, () => readDesktopState().aiPreferences);
  jobRunner.on('changed', emitSnapshotChanged);
  jobRunner.on('terminal', ({ status }: { status: string }) => {
    if (!readDesktopState().notificationsEnabled) return;
    if (!Notification.isSupported()) return;
    const presentation = status === 'succeeded'
      ? { title: '家庭健康资料已处理', body: '报告事实和说明已完成保存，可打开看板查看。' }
      : status === 'waiting_user'
        ? { title: '家庭健康资料需要确认', body: '有一项来源或内容需要你打开看板核对。' }
        : status === 'cancelled'
          ? { title: '家庭健康处理已停止', body: '已保存的事实仍然保留。' }
          : { title: '家庭健康处理暂未完成', body: '请打开看板查看等待原因和可恢复操作。' };
    const notification = new Notification(presentation);
    notification.on('click', showMainWindow);
    notification.show();
  });
  runtimeManager.on('stateChanged', (state: AccountState) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('account:state-changed', accountStateSchema.parse(state));
    if (state.status === 'connected' && personalWorkspace) {
      void (async () => {
        await ensureRecoveryPointBeforeWrite();
        if (!personalWorkspace) return;
        personalWorkspace.store.requeueWaitingJobs('waiting_auth');
        if (state.quota.status === 'available' || state.quota.status === 'low') personalWorkspace.store.requeueWaitingJobs('waiting_quota');
        void runScheduleCoordinator();
        void jobRunner?.runAvailableJobs(personalWorkspace.store);
      })().catch(() => undefined);
    }
  });
  if (executable) void runtimeManager.start().catch(() => undefined);
}

async function runScheduleCoordinator(forceReconcile = false): Promise<void> {
  if (!personalWorkspace || scheduleCoordinatorRunning) return;
  scheduleCoordinatorRunning = true;
  try {
    await ensureRecoveryPointBeforeWrite();
    const schedule = personalWorkspace.getSchedule();
    const scheduleDue = schedule.enabled && schedule.nextRunUtc !== null
      && new Date(schedule.nextRunUtc).getTime() <= Date.now();
    if (forceReconcile || scheduleDue || Date.now() - lastInboxReconcileAt >= 15 * 60_000) {
      await syncInboxWatcher();
      await inboxWatcher?.reconcile(personalWorkspace.store.listActiveInboxBindings());
      lastInboxReconcileAt = Date.now();
    }
    const outcome = personalWorkspace.runScheduleCheck(currentAccountState());
    if (outcome.created) emitSnapshotChanged();
    if (outcome.queued) await jobRunner?.runAvailableJobs(personalWorkspace.store);
  } finally {
    scheduleCoordinatorRunning = false;
  }
}

function startScheduleCoordinator(): void {
  if (scheduleTimer) clearInterval(scheduleTimer);
  scheduleTimer = setInterval(() => void runScheduleCoordinator(), 60_000);
  void runScheduleCoordinator(true);
}

function emitSnapshotChanged(): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('dashboard:snapshot-changed', dashboardSnapshotSchema.parse(currentSnapshot()));
  }
  rebuildTrayMenu();
}

async function syncInboxWatcher(): Promise<void> {
  if (!personalWorkspace) {
    await inboxWatcher?.close();
    inboxWatcher = null;
    return;
  }
  if (!inboxWatcher) {
    inboxWatcher = new InboxWatcherManager({
      importFile: async ({ bindingId, personId, path, bytes }) => {
        if (!personalWorkspace) return;
        await ensureRecoveryPointBeforeWrite();
        await personalWorkspace.importFiles([{ path, bytes }], personId, bindingId);
        emitSnapshotChanged();
        void runScheduleCoordinator();
      }
    });
  }
  await inboxWatcher.sync(personalWorkspace.store.listActiveInboxBindings());
}

function currentSnapshot() {
  if (activeWorkspaceMode === 'personal' && personalWorkspace) {
    return personalWorkspace.getSnapshot(currentAccountState());
  }
  demoSnapshot = createDemoSnapshot(new Date());
  return { ...demoSnapshot, account: currentAccountState() };
}

function registerIpc(): void {
  ipcMain.handle('app:get-bootstrap', async (event) => {
    validateSender(event);
    const desktopState = readDesktopState();
    if (personalWorkspace) await ensureRecoveryPointBeforeWrite();
    const recoveryStatus = personalWorkspace
      ? await getLocalRecoveryPointStatus(personalWorkspace.store.rootDirectory)
      : { pointCount: 0, totalBytes: 0, latestAt: null };
    return {
      platform: process.platform,
      versions: {
        app: app.getVersion(),
        electron: process.versions.electron,
        chrome: process.versions.chrome,
        node: process.versions.node
      },
      desktopBehavior: {
        stayInTray: desktopState.stayInTray,
        openAtLogin: app.getLoginItemSettings().openAtLogin,
        notificationsEnabled: desktopState.notificationsEnabled
      },
      displayPreferences: desktopState.displayPreferences,
      aiPreferences: desktopState.aiPreferences,
      recoveryStatus
    };
  });

  ipcMain.handle('diagnostics:get-preview', (event) => {
    validateSender(event);
    return {
      ok: true,
      data: buildDiagnosticBundle({
        snapshot: currentSnapshot(),
        applicationVersion: app.getVersion(),
        platform: process.platform,
        arch: process.arch
      })
    };
  });

  ipcMain.handle('diagnostics:export', async (event) => {
    validateSender(event);
    if (!mainWindow) throw new Error('MAIN_WINDOW_UNAVAILABLE');
    const generatedAt = new Date();
    const bundle = buildDiagnosticBundle({
      snapshot: currentSnapshot(),
      applicationVersion: app.getVersion(),
      platform: process.platform,
      arch: process.arch,
      now: generatedAt
    });
    const result = await dialog.showSaveDialog(mainWindow, {
      title: '保存脱敏诊断信息',
      buttonLabel: '保存到本机',
      defaultPath: `家庭健康看板-脱敏诊断-${generatedAt.toISOString().slice(0, 10)}.json`,
      filters: [{ name: 'JSON', extensions: ['json'] }]
    });
    if (result.canceled || !result.filePath) return { ok: true, data: null };
    await writeFile(result.filePath, renderDiagnosticBundle(bundle), { encoding: 'utf8', mode: 0o600 });
    return { ok: true, data: { displayName: basename(result.filePath), generatedAt: bundle.generatedAt } };
  });

  ipcMain.handle('privacy:cleanup-expired', async (event) => {
    validateSender(event);
    const now = new Date();
    const temporaryEntriesRemoved = await cleanupOwnedTemporaryEntries({
      temporaryRoot: app.getPath('temp'),
      olderThan: new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000)
    });
    let terminalTaskAttemptsRemoved = 0;
    if (personalWorkspace) {
      await ensureRecoveryPointBeforeWrite();
      terminalTaskAttemptsRemoved = personalWorkspace.store.cleanupTerminalTaskAttempts(
        new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString()
      );
    }
    return {
      ok: true,
      data: cleanupReceiptSchema.parse({
        temporaryEntriesRemoved,
        terminalTaskAttemptsRemoved,
        codexSessionDataRemoved: false,
        explanation: '只清理本应用超过 7 天的临时渲染目录和超过 30 天、且没有开放核对事项的终结任务尝试记录。正式报告、事实、事项、审计和其他 Codex 工作区未删除；当前锁定运行时没有经过验证的逐会话清理接口，因此本应用 Codex 会话资料未自动删除。'
      })
    };
  });

  ipcMain.handle('dashboard:get-snapshot', (event) => {
    validateSender(event);
    return dashboardSnapshotSchema.parse(currentSnapshot());
  });

  ipcMain.handle('desktop:update-behavior', (event, rawInput: unknown) => {
    validateSender(event);
    const input = updateDesktopBehaviorInputSchema.parse(rawInput);
    const state = { ...readDesktopState(), ...input };
    writeDesktopState(state);
    app.setLoginItemSettings({ openAtLogin: input.openAtLogin });
    if (input.stayInTray) ensureTray();
    else if (mainWindow?.isVisible()) {
      tray?.destroy();
      tray = null;
    }
    return {
      ok: true,
      data: { stayInTray: state.stayInTray, openAtLogin: app.getLoginItemSettings().openAtLogin, notificationsEnabled: state.notificationsEnabled }
    };
  });

  ipcMain.handle('display:update-preferences', (event, rawInput: unknown) => {
    validateSender(event);
    const displayPreferences = updateDisplayPreferencesInputSchema.parse(rawInput);
    writeDesktopState({ ...readDesktopState(), displayPreferences });
    return { ok: true, data: displayPreferences };
  });

  ipcMain.handle('ai:get-settings', async (event) => {
    validateSender(event);
    try {
      if (!runtimeManager) throw new Error('CODEX_RUNTIME_UNAVAILABLE');
      return {
        ok: true,
        data: aiSettingsSchema.parse({
          preferences: readDesktopState().aiPreferences,
          models: await runtimeManager.listModels()
        })
      };
    } catch (error) {
      return { ok: false, error: { code: error instanceof Error ? error.message : 'AI_SETTINGS_UNAVAILABLE', messageKey: 'ai.settings_unavailable', retryable: true, correlationId: randomUUID() } };
    }
  });

  ipcMain.handle('ai:update-preferences', async (event, rawInput: unknown) => {
    validateSender(event);
    try {
      const preferences = updateAiPreferencesInputSchema.parse(rawInput);
      if (!runtimeManager) throw new Error('CODEX_RUNTIME_UNAVAILABLE');
      const models = await runtimeManager.listModels();
      const model = models.find((item) => item.id === preferences.modelId);
      if (!model) throw new Error('AI_MODEL_UNAVAILABLE');
      if (!model.supportedReasoningEfforts.some((item) => item.reasoningEffort === preferences.reasoningEffort)) {
        throw new Error('AI_REASONING_EFFORT_UNAVAILABLE');
      }
      writeDesktopState({ ...readDesktopState(), aiPreferences: preferences });
      return { ok: true, data: preferences };
    } catch (error) {
      return { ok: false, error: { code: error instanceof Error ? error.message : 'AI_PREFERENCES_INVALID', messageKey: 'ai.preferences_invalid', retryable: false, correlationId: randomUUID() } };
    }
  });

  ipcMain.handle('documents:get-evidence', async (event, rawInput: unknown) => {
    validateSender(event);
    if (activeWorkspaceMode !== 'personal' || !personalWorkspace) {
      return { ok: false, error: { code: 'PERSONAL_WORKSPACE_REQUIRED', messageKey: 'workspace.personal_required', retryable: false, correlationId: randomUUID() } };
    }
    try {
      const input = evidencePreviewRequestSchema.parse(rawInput);
      const evidence = input.sourceSpanId
        ? personalWorkspace.store.getEvidenceAccess({ sourceSpanId: input.sourceSpanId })
        : personalWorkspace.store.getEvidenceAccess({ documentId: input.documentId! });
      let previewImageDataUrl: string | null = null;
      let previewPath: string | null = null;
      let temporaryRoot: string | null = null;
      try {
        if (evidence.mediaType === 'application/pdf') {
          if (evidence.sourcePage === null) throw new Error('PDF_PAGE_NUMBER_INVALID');
          temporaryRoot = await mkdtemp(join(tmpdir(), 'family-health-preview-'));
          const rendered = await renderPdfPagesToPngs({
            bytes: readFileSync(evidence.sourcePath), outputDirectory: temporaryRoot, pageNumbers: [evidence.sourcePage],
            maxScale: 1.5, maxPixels: 3_000_000
          });
          previewPath = rendered[0]?.path ?? null;
        } else if (['image/heic', 'image/heif'].includes(evidence.mediaType)) {
          if (evidence.sourcePage === null) throw new Error('HEIC_IMAGE_INDEX_INVALID');
          temporaryRoot = await mkdtemp(join(tmpdir(), 'family-health-preview-'));
          const rendered = await renderHeicImagesToPngs({
            bytes: readFileSync(evidence.sourcePath), outputDirectory: temporaryRoot, imageIndexes: [evidence.sourcePage]
          });
          previewPath = rendered[0]?.path ?? null;
        } else if (evidence.mediaType === 'image/jpeg' || evidence.mediaType === 'image/png') {
          previewPath = evidence.sourcePath;
        }
        if (previewPath) {
          const image = nativeImage.createFromPath(previewPath);
        if (image.isEmpty()) throw new Error('IMAGE_PREVIEW_UNAVAILABLE');
        const size = image.getSize();
        if (size.width <= 0 || size.height <= 0 || size.width * size.height > 80_000_000) {
          throw new Error('IMAGE_PIXEL_LIMIT_EXCEEDED');
        }
        const scale = Math.min(1, 1_400 / size.width, 1_800 / size.height);
        const resized = scale < 1
          ? image.resize({ width: Math.max(1, Math.round(size.width * scale)), height: Math.max(1, Math.round(size.height * scale)), quality: 'better' })
          : image;
        previewImageDataUrl = `data:image/jpeg;base64,${resized.toJPEG(84).toString('base64')}`;
        }
      } finally {
        if (temporaryRoot) await rm(temporaryRoot, { recursive: true, force: true });
      }
      return {
        ok: true,
        data: evidencePreviewSchema.parse({
          sourceSpanId: evidence.sourceSpanId,
          documentId: evidence.documentId,
          displayName: evidence.displayName,
          mediaType: evidence.mediaType,
          locator: evidence.locator,
          quote: evidence.quote,
          readability: evidence.readability,
          conversionView: evidence.conversionView,
          previewImageDataUrl
        })
      };
    } catch (error) {
      const code = error instanceof Error ? error.message : 'EVIDENCE_PREVIEW_FAILED';
      return { ok: false, error: { code, messageKey: 'documents.evidence_unavailable', retryable: false, correlationId: randomUUID() } };
    }
  });

  ipcMain.handle('reviews:resolve', async (event, rawInput: unknown) => {
    validateSender(event);
    if (activeWorkspaceMode !== 'personal' || !personalWorkspace) {
      return { ok: false, error: { code: 'PERSONAL_WORKSPACE_REQUIRED', messageKey: 'workspace.personal_required', retryable: false, correlationId: randomUUID() } };
    }
    try {
      await ensureRecoveryPointBeforeWrite();
      const input = resolveReviewInputSchema.parse(rawInput);
      if (input.action === 'assign_person') {
        personalWorkspace.store.assignDocumentPerson(input.documentId, input.personId);
      } else if (input.action === 'confirm_identity') {
        personalWorkspace.store.confirmDocumentIdentity(input);
      } else if (input.action === 'accept_correction') {
        personalWorkspace.acceptCorrectedFacts(input);
      } else {
        personalWorkspace.store.resolveReviewIssue(input);
      }
      emitSnapshotChanged();
      void jobRunner?.runAvailableJobs(personalWorkspace.store);
      return { ok: true, data: { action: input.action } };
    } catch (error) {
      const code = error instanceof Error ? error.message : 'REVIEW_RESOLUTION_FAILED';
      return { ok: false, error: { code, messageKey: 'review.resolution_failed', retryable: false, correlationId: randomUUID() } };
    }
  });

  ipcMain.handle('workspace:create', async (event, rawInput: unknown) => {
    validateSender(event);
    const input = createWorkspaceInputSchema.parse(rawInput);
    await inboxWatcher?.close();
    inboxWatcher = null;
    personalWorkspace?.close();
    personalWorkspace = openPersonalWorkspace(personalWorkspacePath(), input.workspaceName);
    recoveryPointDay = null;
    personalWorkspace.ensurePrimaryMember({ displayName: input.primaryMemberName, relation: input.relation });
    activeWorkspaceMode = 'personal';
    writeDesktopState({ ...readDesktopState(), activeWorkspaceMode, workspaceName: input.workspaceName });
    await syncInboxWatcher();
    return { ok: true, data: personalWorkspace.getSnapshot(currentAccountState()) };
  });

  ipcMain.handle('workspace:switch', (event, rawInput: unknown) => {
    validateSender(event);
    const input = switchWorkspaceInputSchema.parse(rawInput);
    if (input.mode === 'personal' && !personalWorkspace) {
      return { ok: false, error: { code: 'WORKSPACE_NOT_CREATED', messageKey: 'workspace.not_created', retryable: false, correlationId: randomUUID() } };
    }
    activeWorkspaceMode = input.mode;
    writeDesktopState({ ...readDesktopState(), activeWorkspaceMode, workspaceName: personalWorkspace?.workspaceName ?? null });
    return { ok: true, data: dashboardSnapshotSchema.parse(currentSnapshot()) };
  });

  ipcMain.handle('people:create', async (event, rawInput: unknown) => {
    validateSender(event);
    const input = createPersonInputSchema.parse(rawInput);
    if (activeWorkspaceMode !== 'personal' || !personalWorkspace) {
      return { ok: false, error: { code: 'PERSONAL_WORKSPACE_REQUIRED', messageKey: 'workspace.personal_required', retryable: false, correlationId: randomUUID() } };
    }
    try {
      await ensureRecoveryPointBeforeWrite();
      const personId = personalWorkspace.createMember(input);
      return { ok: true, data: { personId, snapshot: personalWorkspace.getSnapshot(currentAccountState()) } };
    } catch (error) {
      const code = error instanceof Error ? error.message : 'PERSON_CREATE_FAILED';
      return { ok: false, error: { code, messageKey: 'person.create_failed', retryable: true, correlationId: randomUUID() } };
    }
  });

  ipcMain.handle('people:update-display', async (event, rawInput: unknown) => {
    validateSender(event);
    const input = updatePersonDisplayInputSchema.parse(rawInput);
    if (activeWorkspaceMode !== 'personal' || !personalWorkspace) {
      return { ok: false, error: { code: 'PERSONAL_WORKSPACE_REQUIRED', messageKey: 'workspace.personal_required', retryable: false, correlationId: randomUUID() } };
    }
    try {
      await ensureRecoveryPointBeforeWrite();
      personalWorkspace.updateMemberDisplay(input);
      return { ok: true, data: personalWorkspace.getSnapshot(currentAccountState()) };
    } catch (error) {
      const code = error instanceof Error ? error.message : 'PERSON_UPDATE_FAILED';
      return { ok: false, error: { code, messageKey: 'person.update_failed', retryable: code.startsWith('REVISION_CONFLICT'), correlationId: randomUUID() } };
    }
  });

  ipcMain.handle('people:list-archived', (event) => {
    validateSender(event);
    if (activeWorkspaceMode !== 'personal' || !personalWorkspace) return { ok: true, data: [] };
    return { ok: true, data: personSchema.array().parse(personalWorkspace.listArchivedMembers()) };
  });

  ipcMain.handle('people:archive', async (event, rawInput: unknown) => {
    validateSender(event);
    const input = archivePersonInputSchema.parse(rawInput);
    if (activeWorkspaceMode !== 'personal' || !personalWorkspace) {
      return { ok: false, error: { code: 'PERSONAL_WORKSPACE_REQUIRED', messageKey: 'workspace.personal_required', retryable: false, correlationId: randomUUID() } };
    }
    try {
      await ensureRecoveryPointBeforeWrite();
      personalWorkspace.archiveMember(input);
      await syncInboxWatcher();
      const snapshot = personalWorkspace.getSnapshot(currentAccountState());
      emitSnapshotChanged();
      return { ok: true, data: snapshot };
    } catch (error) {
      const code = error instanceof Error ? error.message : 'PERSON_ARCHIVE_FAILED';
      return { ok: false, error: { code, messageKey: 'person.archive_failed', retryable: code === 'PERSON_HAS_RUNNING_JOB' || code.startsWith('REVISION_CONFLICT'), correlationId: randomUUID() } };
    }
  });

  ipcMain.handle('people:restore', async (event, rawInput: unknown) => {
    validateSender(event);
    const input = restorePersonInputSchema.parse(rawInput);
    if (activeWorkspaceMode !== 'personal' || !personalWorkspace) {
      return { ok: false, error: { code: 'PERSONAL_WORKSPACE_REQUIRED', messageKey: 'workspace.personal_required', retryable: false, correlationId: randomUUID() } };
    }
    try {
      await ensureRecoveryPointBeforeWrite();
      const person = personalWorkspace.restoreMember(input);
      const snapshot = personalWorkspace.getSnapshot(currentAccountState());
      emitSnapshotChanged();
      return { ok: true, data: { person: personSchema.parse(person), snapshot } };
    } catch (error) {
      const code = error instanceof Error ? error.message : 'PERSON_RESTORE_FAILED';
      return { ok: false, error: { code, messageKey: 'person.restore_failed', retryable: code.startsWith('REVISION_CONFLICT'), correlationId: randomUUID() } };
    }
  });

  ipcMain.handle('documents:set-included', async (event, rawInput: unknown) => {
    validateSender(event);
    const input = setDocumentInclusionInputSchema.parse(rawInput);
    if (activeWorkspaceMode !== 'personal' || !personalWorkspace) {
      return { ok: false, error: { code: 'PERSONAL_WORKSPACE_REQUIRED', messageKey: 'workspace.personal_required', retryable: false, correlationId: randomUUID() } };
    }
    try {
      await ensureRecoveryPointBeforeWrite();
      personalWorkspace.setDocumentIncluded(input);
      const snapshot = personalWorkspace.getSnapshot(currentAccountState());
      emitSnapshotChanged();
      return { ok: true, data: snapshot };
    } catch (error) {
      const code = error instanceof Error ? error.message : 'DOCUMENT_INCLUSION_FAILED';
      return { ok: false, error: { code, messageKey: 'document.inclusion_failed', retryable: code === 'DOCUMENT_HAS_ACTIVE_JOB', correlationId: randomUUID() } };
    }
  });

  ipcMain.handle('documents:list-deleted', (event) => {
    validateSender(event);
    if (activeWorkspaceMode !== 'personal' || !personalWorkspace) return { ok: true, data: [] };
    return { ok: true, data: deletedDocumentSummarySchema.array().parse(personalWorkspace.listDeletedDocuments()) };
  });

  ipcMain.handle('documents:delete', async (event, rawInput: unknown) => {
    validateSender(event);
    const input = deleteDocumentInputSchema.parse(rawInput);
    if (activeWorkspaceMode !== 'personal' || !personalWorkspace) {
      return { ok: false, error: { code: 'PERSONAL_WORKSPACE_REQUIRED', messageKey: 'workspace.personal_required', retryable: false, correlationId: randomUUID() } };
    }
    try {
      await ensureRecoveryPointBeforeWrite();
      const receipt = await personalWorkspace.deleteDocument(input);
      const snapshot = personalWorkspace.getSnapshot(currentAccountState());
      emitSnapshotChanged();
      return { ok: true, data: { receipt: deleteDocumentReceiptSchema.parse(receipt), snapshot } };
    } catch (error) {
      const code = error instanceof Error ? error.message : 'DOCUMENT_DELETE_FAILED';
      return { ok: false, error: { code, messageKey: 'document.delete_failed', retryable: code === 'DOCUMENT_HAS_ACTIVE_JOB', correlationId: randomUUID() } };
    }
  });

  ipcMain.handle('documents:release-deleted', async (event, rawInput: unknown) => {
    validateSender(event);
    const input = releaseDeletedDocumentInputSchema.parse(rawInput);
    if (activeWorkspaceMode !== 'personal' || !personalWorkspace) {
      return { ok: false, error: { code: 'PERSONAL_WORKSPACE_REQUIRED', messageKey: 'workspace.personal_required', retryable: false, correlationId: randomUUID() } };
    }
    try {
      await ensureRecoveryPointBeforeWrite();
      personalWorkspace.releaseDeletedDocument(input.sourceHash);
      return { ok: true, data: { sourceHash: input.sourceHash } };
    } catch (error) {
      const code = error instanceof Error ? error.message : 'DELETED_DOCUMENT_RELEASE_FAILED';
      return { ok: false, error: { code, messageKey: 'document.release_deleted_failed', retryable: false, correlationId: randomUUID() } };
    }
  });

  ipcMain.handle('inbox:select-files', async (event, rawInput: unknown) => {
    validateSender(event);
    const input = importFilesInputSchema.parse(rawInput);
    if (activeWorkspaceMode !== 'personal' || !personalWorkspace || !mainWindow) {
      return { ok: false, error: { code: 'PERSONAL_WORKSPACE_REQUIRED', messageKey: 'workspace.personal_required', retryable: false, correlationId: randomUUID() } };
    }
    const selection = await dialog.showOpenDialog(mainWindow, {
      title: '选择健康资料',
      buttonLabel: '导入到本机',
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: '健康资料', extensions: ['pdf', 'jpg', 'jpeg', 'png', 'heic', 'heif', 'docx', 'doc', 'txt'] }
      ]
    });
    if (selection.canceled) {
      return { ok: true, data: { selectedCount: 0, importedCount: 0, duplicateCount: 0, suppressedCount: 0, rejected: [] } };
    }
    const selectedPaths = selection.filePaths.slice(0, 100);
    return { ok: true, data: await importSelectedPaths(selectedPaths, input.personId) };
  });

  ipcMain.handle('inbox:import-dropped', async (event, rawInput: unknown) => {
    validateSender(event);
    const input = droppedFilePathsInputSchema.parse(rawInput);
    if (activeWorkspaceMode !== 'personal' || !personalWorkspace) {
      return { ok: false, error: { code: 'PERSONAL_WORKSPACE_REQUIRED', messageKey: 'workspace.personal_required', retryable: false, correlationId: randomUUID() } };
    }
    try {
      return { ok: true, data: await importSelectedPaths(input.paths, input.personId) };
    } catch (error) {
      const code = error instanceof Error ? error.message : 'DROPPED_FILE_IMPORT_FAILED';
      return { ok: false, error: { code, messageKey: 'inbox.dropped_import_failed', retryable: true, correlationId: randomUUID() } };
    }
  });

  ipcMain.handle('inbox:pick-directory', async (event) => {
    validateSender(event);
    if (!personalWorkspace || !mainWindow) {
      return { ok: false, error: { code: 'PERSONAL_WORKSPACE_REQUIRED', messageKey: 'workspace.personal_required', retryable: false, correlationId: randomUUID() } };
    }
    const selection = await dialog.showOpenDialog(mainWindow, {
      title: '选择报告收件箱目录',
      buttonLabel: '选择此目录',
      properties: ['openDirectory', 'createDirectory']
    });
    if (selection.canceled || !selection.filePaths[0]) return { ok: true, data: null };
    try {
      const forbiddenRoots = [
        app.getPath('userData'),
        app.getAppPath(),
        personalWorkspace.store.rootDirectory
      ].filter((path) => existsSync(path));
      const canonicalPath = assertSafeInboxDirectory(selection.filePaths[0], forbiddenRoots);
      const selectionId = randomUUID();
      const displayName = canonicalPath.split(/[\\/]/).filter(Boolean).at(-1) ?? '所选目录';
      pendingDirectorySelections.set(selectionId, { canonicalPath, displayName, selectedAt: Date.now() });
      return { ok: true, data: { selectionId, displayName } };
    } catch (error) {
      const code = error instanceof Error ? error.message : 'INBOX_DIRECTORY_REJECTED';
      return { ok: false, error: { code, messageKey: 'inbox.directory_rejected', retryable: false, correlationId: randomUUID() } };
    }
  });

  ipcMain.handle('inbox:confirm-directory', async (event, rawInput: unknown) => {
    validateSender(event);
    if (!personalWorkspace) {
      return { ok: false, error: { code: 'PERSONAL_WORKSPACE_REQUIRED', messageKey: 'workspace.personal_required', retryable: false, correlationId: randomUUID() } };
    }
    const input = confirmInboxBindingInputSchema.parse(rawInput);
    const selected = pendingDirectorySelections.get(input.selectionId);
    pendingDirectorySelections.delete(input.selectionId);
    if (!selected || Date.now() - selected.selectedAt > 10 * 60_000) {
      return { ok: false, error: { code: 'DIRECTORY_SELECTION_EXPIRED', messageKey: 'inbox.selection_expired', retryable: true, correlationId: randomUUID() } };
    }
    const account = currentAccountState();
    if (input.allowScheduledAiProcessing && account.status !== 'connected') {
      return { ok: false, error: { code: 'ACCOUNT_REQUIRED_FOR_AI_CONSENT', messageKey: 'inbox.account_required', retryable: true, action: 'login', correlationId: randomUUID() } };
    }
    try {
      await ensureRecoveryPointBeforeWrite();
      const binding = personalWorkspace.createInboxBinding({
        canonicalPath: selected.canonicalPath,
        personId: input.personId,
        recursive: input.recursive,
        allowScheduledAiProcessing: input.allowScheduledAiProcessing,
        consentVersion: input.consentVersion,
        accountState: account
      });
      await syncInboxWatcher();
      return { ok: true, data: inboxBindingSummarySchema.parse(binding) };
    } catch (error) {
      const code = error instanceof Error ? error.message : 'INBOX_BINDING_FAILED';
      return { ok: false, error: { code, messageKey: 'inbox.binding_failed', retryable: false, correlationId: randomUUID() } };
    }
  });

  ipcMain.handle('inbox:list-directories', (event) => {
    validateSender(event);
    if (!personalWorkspace) return { ok: true, data: [] };
    return { ok: true, data: personalWorkspace.listInboxBindings().map((binding) => inboxBindingSummarySchema.parse(binding)) };
  });

  ipcMain.handle('inbox:disable-directory', async (event, rawInput: unknown) => {
    validateSender(event);
    if (!personalWorkspace) {
      return { ok: false, error: { code: 'PERSONAL_WORKSPACE_REQUIRED', messageKey: 'workspace.personal_required', retryable: false, correlationId: randomUUID() } };
    }
    const input = disableInboxBindingInputSchema.parse(rawInput);
    try {
      await ensureRecoveryPointBeforeWrite();
      personalWorkspace.disableInboxBinding(input.bindingId);
      await syncInboxWatcher();
      return { ok: true, data: { bindingId: input.bindingId } };
    } catch (error) {
      const code = error instanceof Error ? error.message : 'INBOX_BINDING_DISABLE_FAILED';
      return { ok: false, error: { code, messageKey: 'inbox.binding_disable_failed', retryable: false, correlationId: randomUUID() } };
    }
  });

  ipcMain.handle('actions:set-status', async (event, rawInput: unknown) => {
    validateSender(event);
    const input = updateActionStatusInputSchema.parse(rawInput);
    if (activeWorkspaceMode === 'personal' && personalWorkspace) {
      try {
        await ensureRecoveryPointBeforeWrite();
        const action = personalWorkspace.updateActionStatus(input);
        emitSnapshotChanged();
        return { ok: true, data: action, revision: action.userRevision };
      } catch (error) {
        const code = error instanceof Error ? error.message : 'ACTION_UPDATE_FAILED';
        return { ok: false, error: { code, messageKey: 'action.update_failed', retryable: false, correlationId: randomUUID() } };
      }
    }
    const target = demoSnapshot.actions.find((item) => item.id === input.actionId);
    if (!target) throw new Error('ACTION_NOT_FOUND');
    if (target.userRevision !== input.expectedRevision) {
      return { ok: false, error: { code: 'ACTION_REVISION_CONFLICT', messageKey: 'action.revision_conflict', retryable: true, correlationId: randomUUID() } };
    }
    demoSnapshot = {
      ...demoSnapshot,
      actions: demoSnapshot.actions.map((item) => item.id === target.id
        ? { ...item, status: input.status, userRevision: item.userRevision + 1, updatedAt: new Date().toISOString() }
        : item),
      generatedAt: new Date().toISOString()
    };
    return { ok: true, data: demoSnapshot.actions.find((item) => item.id === input.actionId)!, revision: input.expectedRevision + 1 };
  });

  ipcMain.handle('actions:create', async (event, rawInput: unknown) => {
    validateSender(event);
    if (activeWorkspaceMode !== 'personal' || !personalWorkspace) {
      return { ok: false, error: { code: 'PERSONAL_WORKSPACE_REQUIRED', messageKey: 'workspace.personal_required', retryable: false, correlationId: randomUUID() } };
    }
    try {
      await ensureRecoveryPointBeforeWrite();
      const action = personalWorkspace.createAction(createActionItemInputSchema.parse(rawInput));
      emitSnapshotChanged();
      return { ok: true, data: action, revision: action.userRevision };
    } catch (error) {
      const code = error instanceof Error ? error.message : 'ACTION_CREATE_FAILED';
      return { ok: false, error: { code, messageKey: 'action.create_failed', retryable: false, correlationId: randomUUID() } };
    }
  });

  ipcMain.handle('notes:create', async (event, rawInput: unknown) => {
    validateSender(event);
    if (activeWorkspaceMode !== 'personal' || !personalWorkspace) {
      return { ok: false, error: { code: 'PERSONAL_WORKSPACE_REQUIRED', messageKey: 'workspace.personal_required', retryable: false, correlationId: randomUUID() } };
    }
    try {
      await ensureRecoveryPointBeforeWrite();
      const note = personalWorkspace.createManualNote(createManualNoteInputSchema.parse(rawInput));
      emitSnapshotChanged();
      return { ok: true, data: note, revision: note.revision };
    } catch (error) {
      const code = error instanceof Error ? error.message : 'MANUAL_NOTE_CREATE_FAILED';
      return { ok: false, error: { code, messageKey: 'note.create_failed', retryable: code.startsWith('REVISION_CONFLICT'), correlationId: randomUUID() } };
    }
  });

  ipcMain.handle('jobs:process-now', async (event, rawInput: unknown) => {
    validateSender(event);
    if (activeWorkspaceMode === 'demo' || !personalWorkspace) {
      return { ok: false, error: { code: 'DEMO_MODE', messageKey: 'demo.process_disabled', retryable: false, correlationId: randomUUID() } };
    }
    try {
      await ensureRecoveryPointBeforeWrite();
      const input = processNowInputSchema.parse(rawInput);
      const result = personalWorkspace.processNow({
        accountState: currentAccountState(),
        consentVersion: input.consentVersion,
        ...(input.documentIds ? { documentIds: input.documentIds } : {})
      });
      void jobRunner?.runAvailableJobs(personalWorkspace.store);
      return { ok: true, data: { batchId: result.batchId }, revision: result.idempotent ? 0 : 1 };
    } catch (error) {
      const code = error instanceof Error ? error.message : 'PROCESS_FAILED';
      return { ok: false, error: { code, messageKey: code === 'NO_READY_DOCUMENTS' || code === 'DOCUMENT_ALREADY_IN_PROCESSING' ? 'jobs.no_ready_documents' : code === 'AUTH_REQUIRED' ? 'jobs.auth_required' : 'jobs.process_failed', retryable: code === 'AUTH_REQUIRED', action: code === 'AUTH_REQUIRED' ? 'login' : undefined, correlationId: randomUUID() } };
    }
  });

  ipcMain.handle('schedule:update', async (event, rawInput: unknown) => {
    validateSender(event);
    if (activeWorkspaceMode !== 'personal' || !personalWorkspace) {
      return { ok: false, error: { code: 'PERSONAL_WORKSPACE_REQUIRED', messageKey: 'workspace.personal_required', retryable: false, correlationId: randomUUID() } };
    }
    try {
      await ensureRecoveryPointBeforeWrite();
      const input = updateScheduleInputSchema.parse(rawInput);
      personalWorkspace.updateSchedule(input);
      emitSnapshotChanged();
      void runScheduleCoordinator();
      return { ok: true, data: dashboardSnapshotSchema.parse(currentSnapshot()) };
    } catch (error) {
      const code = error instanceof Error ? error.message : 'SCHEDULE_UPDATE_FAILED';
      return { ok: false, error: { code, messageKey: 'schedule.update_failed', retryable: code.startsWith('REVISION_CONFLICT'), correlationId: randomUUID() } };
    }
  });

  ipcMain.handle('jobs:cancel', async (event, rawInput: unknown) => {
    validateSender(event);
    if (activeWorkspaceMode !== 'personal' || !personalWorkspace || !jobRunner) {
      return { ok: false, error: { code: 'PERSONAL_WORKSPACE_REQUIRED', messageKey: 'workspace.personal_required', retryable: false, correlationId: randomUUID() } };
    }
    try {
      await ensureRecoveryPointBeforeWrite();
      const input = jobActionInputSchema.parse(rawInput);
      const result = await jobRunner.cancelJob(personalWorkspace.store, input.jobId);
      emitSnapshotChanged();
      return { ok: true, data: result };
    } catch (error) {
      const code = error instanceof Error ? error.message : 'JOB_CANCEL_FAILED';
      return { ok: false, error: { code, messageKey: 'jobs.cancel_failed', retryable: true, correlationId: randomUUID() } };
    }
  });

  ipcMain.handle('jobs:retry', async (event, rawInput: unknown) => {
    validateSender(event);
    if (activeWorkspaceMode !== 'personal' || !personalWorkspace) {
      return { ok: false, error: { code: 'PERSONAL_WORKSPACE_REQUIRED', messageKey: 'workspace.personal_required', retryable: false, correlationId: randomUUID() } };
    }
    try {
      await ensureRecoveryPointBeforeWrite();
      const input = jobActionInputSchema.parse(rawInput);
      personalWorkspace.store.retryFailedJob(input.jobId);
      emitSnapshotChanged();
      void jobRunner?.runAvailableJobs(personalWorkspace.store);
      return { ok: true, data: { jobId: input.jobId } };
    } catch (error) {
      const code = error instanceof Error ? error.message : 'JOB_RETRY_FAILED';
      return { ok: false, error: { code, messageKey: 'jobs.retry_failed', retryable: false, correlationId: randomUUID() } };
    }
  });

  ipcMain.handle('jobs:set-queue-paused', async (event, rawInput: unknown) => {
    validateSender(event);
    if (activeWorkspaceMode !== 'personal' || !personalWorkspace) {
      return { ok: false, error: { code: 'PERSONAL_WORKSPACE_REQUIRED', messageKey: 'workspace.personal_required', retryable: false, correlationId: randomUUID() } };
    }
    await ensureRecoveryPointBeforeWrite();
    const input = setQueuePausedInputSchema.parse(rawInput);
    personalWorkspace.store.setQueuePaused(input.paused);
    emitSnapshotChanged();
    if (!input.paused) void jobRunner?.runAvailableJobs(personalWorkspace.store);
    return { ok: true, data: { paused: input.paused } };
  });

  ipcMain.handle('export:member-summary', async (event, rawInput: unknown) => {
    validateSender(event);
    if (activeWorkspaceMode !== 'personal' || !personalWorkspace || !mainWindow) {
      return { ok: false, error: { code: 'PERSONAL_WORKSPACE_REQUIRED', messageKey: 'workspace.personal_required', retryable: false, correlationId: randomUUID() } };
    }
    try {
      const input = exportMemberSummaryInputSchema.parse(rawInput);
      const snapshot = personalWorkspace.getSnapshot(currentAccountState());
      const summary = buildMemberSummaryData(snapshot, input);
      const safeMemberName = [...summary.member.displayName]
        .map((character) => character.charCodeAt(0) < 32 ? '_' : character)
        .join('')
        .replace(/[<>:"/\\|?*]/g, '_')
        .slice(0, 60) || '家庭成员';
      const extensions = { pdf: 'pdf', html: 'html', json: 'json' } as const;
      const labels = { pdf: 'PDF 文档', html: 'HTML 网页', json: '结构化 JSON' } as const;
      const selection = await dialog.showSaveDialog(mainWindow, {
        title: `导出${summary.member.displayName}的健康资料摘要`,
        buttonLabel: '导出到本机',
        defaultPath: join(app.getPath('documents'), `${safeMemberName}-健康资料摘要-${new Date().toISOString().slice(0, 10)}.${extensions[input.format]}`),
        filters: [{ name: labels[input.format], extensions: [extensions[input.format]] }]
      });
      if (selection.canceled || !selection.filePath) return { ok: true, data: null };
      const html = renderMemberSummaryHtml(summary);
      if (input.format === 'html') {
        await writeFile(selection.filePath, html, { encoding: 'utf8', mode: 0o600 });
      } else if (input.format === 'json') {
        await writeFile(selection.filePath, renderMemberSummaryJson(summary), { encoding: 'utf8', mode: 0o600 });
      } else {
        const temporaryRoot = await mkdtemp(join(app.getPath('temp'), 'family-health-export-'));
        const htmlPath = join(temporaryRoot, 'summary.html');
        let exportWindow: BrowserWindow | null = null;
        try {
          await writeFile(htmlPath, html, { encoding: 'utf8', mode: 0o600 });
          exportWindow = new BrowserWindow({
            show: false,
            webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true }
          });
          await exportWindow.loadFile(htmlPath);
          const pdf = await exportWindow.webContents.printToPDF({ printBackground: true, pageSize: 'A4' });
          await writeFile(selection.filePath, pdf, { mode: 0o600 });
        } finally {
          exportWindow?.destroy();
          await rm(temporaryRoot, { recursive: true, force: true });
        }
      }
      return {
        ok: true,
        data: exportMemberSummaryReceiptSchema.parse({
          displayName: basename(selection.filePath),
          format: input.format,
          exportedAt: summary.exportedAt
        })
      };
    } catch (error) {
      const code = error instanceof Error ? error.message : 'MEMBER_SUMMARY_EXPORT_FAILED';
      return { ok: false, error: { code, messageKey: 'export.member_summary_failed', retryable: true, correlationId: randomUUID() } };
    }
  });

  ipcMain.handle('backup:create', async (event, rawInput: unknown) => {
    validateSender(event);
    if (activeWorkspaceMode !== 'personal' || !personalWorkspace || !mainWindow) {
      return { ok: false, error: { code: 'PERSONAL_WORKSPACE_REQUIRED', messageKey: 'workspace.personal_required', retryable: false, correlationId: randomUUID() } };
    }
    const input = createBackupInputSchema.parse(rawInput);
    const selection = await dialog.showSaveDialog(mainWindow, {
      title: '创建加密家庭健康备份',
      buttonLabel: '保存加密备份',
      defaultPath: join(app.getPath('documents'), `家庭健康备份-${new Date().toISOString().slice(0, 10)}.fhbackup`),
      filters: [{ name: '家庭健康加密备份', extensions: ['fhbackup'] }]
    });
    if (selection.canceled || !selection.filePath) return { ok: true, data: null };
    const wasPaused = personalWorkspace.store.isQueuePaused();
    personalWorkspace.store.setQueuePaused(true);
    emitSnapshotChanged();
    try {
      const receipt = await createEncryptedBackup({
        store: personalWorkspace.store,
        workspaceName: personalWorkspace.workspaceName,
        targetPath: selection.filePath,
        passphrase: input.passphrase,
        temporaryRoot: app.getPath('temp')
      });
      return { ok: true, data: { ...receipt, displayName: basename(selection.filePath) } };
    } catch (error) {
      const code = error instanceof Error ? error.message : 'BACKUP_CREATE_FAILED';
      return { ok: false, error: { code, messageKey: 'backup.create_failed', retryable: true, correlationId: randomUUID() } };
    } finally {
      personalWorkspace?.store.setQueuePaused(wasPaused);
      emitSnapshotChanged();
      if (!wasPaused && personalWorkspace) void jobRunner?.runAvailableJobs(personalWorkspace.store);
    }
  });

  ipcMain.handle('backup:pick-restore', async (event) => {
    validateSender(event);
    if (!mainWindow) return { ok: true, data: null };
    const selection = await dialog.showOpenDialog(mainWindow, {
      title: '选择家庭健康加密备份',
      buttonLabel: '选择此备份',
      properties: ['openFile'],
      filters: [{ name: '家庭健康加密备份', extensions: ['fhbackup'] }]
    });
    if (selection.canceled || !selection.filePaths[0]) return { ok: true, data: null };
    const selectionId = randomUUID();
    pendingBackupRestores.set(selectionId, {
      path: selection.filePaths[0],
      displayName: basename(selection.filePaths[0]),
      selectedAt: Date.now()
    });
    return { ok: true, data: { selectionId, displayName: basename(selection.filePaths[0]) } };
  });

  ipcMain.handle('backup:cancel-restore', (event) => {
    validateSender(event);
    const cancelled = activeRestoreAbortController !== null;
    activeRestoreAbortController?.abort();
    return { ok: true, data: { cancelled } };
  });

  ipcMain.handle('backup:restore', async (event, rawInput: unknown) => {
    validateSender(event);
    if (activeWorkspaceMode !== 'personal' || !personalWorkspace) {
      return { ok: false, error: { code: 'PERSONAL_WORKSPACE_REQUIRED', messageKey: 'workspace.personal_required', retryable: false, correlationId: randomUUID() } };
    }
    const input = restoreBackupInputSchema.parse(rawInput);
    const selected = pendingBackupRestores.get(input.selectionId);
    pendingBackupRestores.delete(input.selectionId);
    if (!selected || Date.now() - selected.selectedAt > 10 * 60_000) {
      return { ok: false, error: { code: 'BACKUP_SELECTION_EXPIRED', messageKey: 'backup.selection_expired', retryable: true, correlationId: randomUUID() } };
    }
    if (personalWorkspace.store.listStoredJobs().some((job) => job.status === 'running')) {
      return { ok: false, error: { code: 'RESTORE_ACTIVE_JOB', messageKey: 'backup.active_job', retryable: true, correlationId: randomUUID() } };
    }
    if (activeRestoreAbortController) {
      return { ok: false, error: { code: 'RESTORE_ALREADY_RUNNING', messageKey: 'backup.restore_running', retryable: true, correlationId: randomUUID() } };
    }
    const restoreController = new AbortController();
    activeRestoreAbortController = restoreController;
    const previousWorkspaceName = personalWorkspace.workspaceName;
    let prepared: Awaited<ReturnType<typeof prepareEncryptedRestore>> | null = null;
    let recoveryRoot: string | null = null;
    try {
      prepared = await prepareEncryptedRestore({
        backupPath: selected.path,
        passphrase: input.passphrase,
        temporaryRoot: dirname(personalWorkspacePath()),
        signal: restoreController.signal
      });
      await inboxWatcher?.close();
      inboxWatcher = null;
      personalWorkspace.close();
      personalWorkspace = null;
      const replacement = await replaceWorkspaceWithPreparedRestore({
        liveRoot: personalWorkspacePath(),
        stagedRoot: prepared.stagedRoot,
        signal: restoreController.signal
      });
      recoveryRoot = replacement.recoveryRoot;
      personalWorkspace = openPersonalWorkspace(personalWorkspacePath(), prepared.workspaceName);
      recoveryPointDay = null;
      personalWorkspace.store.sanitizeRestoredMachineState();
      if (personalWorkspace.store.integrityCheck() !== 'ok') throw new Error('RESTORED_WORKSPACE_INTEGRITY_FAILED');
      writeDesktopState({ ...readDesktopState(), activeWorkspaceMode: 'personal', workspaceName: prepared.workspaceName });
      await syncInboxWatcher();
      await rm(recoveryRoot, { recursive: true, force: true }).catch(() => undefined);
      recoveryRoot = null;
      await rm(dirname(prepared.stagedRoot), { recursive: true, force: true }).catch(() => undefined);
      emitSnapshotChanged();
      void runScheduleCoordinator(true);
      return { ok: true, data: dashboardSnapshotSchema.parse(currentSnapshot()) };
    } catch (error) {
      personalWorkspace?.close();
      personalWorkspace = null;
      if (recoveryRoot) {
        const failedRoot = `${personalWorkspacePath()}.failed-restore-${randomUUID()}`;
        await rename(personalWorkspacePath(), failedRoot).catch(() => undefined);
        await rename(recoveryRoot, personalWorkspacePath()).catch(() => undefined);
        await rm(failedRoot, { recursive: true, force: true }).catch(() => undefined);
      }
      if (existsSync(join(personalWorkspacePath(), 'health.db'))) {
        personalWorkspace = openPersonalWorkspace(personalWorkspacePath(), previousWorkspaceName);
        recoveryPointDay = null;
        await syncInboxWatcher().catch(() => undefined);
      }
      if (prepared) await rm(dirname(prepared.stagedRoot), { recursive: true, force: true }).catch(() => undefined);
      const code = error instanceof Error ? error.message : 'BACKUP_RESTORE_FAILED';
      return { ok: false, error: { code, messageKey: 'backup.restore_failed', retryable: true, correlationId: randomUUID() } };
    } finally {
      if (activeRestoreAbortController === restoreController) activeRestoreAbortController = null;
    }
  });

  ipcMain.handle('account:start-login', async (event) => {
    validateSender(event);
    if (!runtimeManager) {
      return { ok: false, error: { code: 'CODEX_RUNTIME_UNAVAILABLE', messageKey: 'account.runtime_unavailable', retryable: false, correlationId: randomUUID() } };
    }
    try {
      const login = await runtimeManager.startChatGptLogin();
      if (!isAllowedExternalUrl(login.authUrl)) {
        await runtimeManager.cancelLogin(login.loginId).catch(() => undefined);
        return { ok: false, error: { code: 'CODEX_LOGIN_URL_REJECTED', messageKey: 'account.login_url_rejected', retryable: false, correlationId: randomUUID() } };
      }
      await shell.openExternal(login.authUrl);
      return { ok: true, data: { loginStarted: true } };
    } catch (error) {
      const code = error instanceof Error && error.message === 'CODEX_RUNTIME_UNAVAILABLE' ? 'CODEX_RUNTIME_UNAVAILABLE' : 'CODEX_LOGIN_FAILED';
      return { ok: false, error: { code, messageKey: code === 'CODEX_RUNTIME_UNAVAILABLE' ? 'account.runtime_unavailable' : 'account.login_failed', retryable: code !== 'CODEX_RUNTIME_UNAVAILABLE', correlationId: randomUUID() } };
    }
  });

  ipcMain.handle('account:refresh', async (event) => {
    validateSender(event);
    if (!runtimeManager) {
      return { ok: false, error: { code: 'CODEX_RUNTIME_UNAVAILABLE', messageKey: 'account.runtime_unavailable', retryable: false, correlationId: randomUUID() } };
    }
    try {
      return { ok: true, data: accountStateSchema.parse(await runtimeManager.refreshAccount()) };
    } catch (error) {
      const code = error instanceof Error ? error.message : 'CODEX_ACCOUNT_REFRESH_FAILED';
      return { ok: false, error: { code, messageKey: 'account.refresh_failed', retryable: code !== 'CODEX_RUNTIME_UNAVAILABLE', correlationId: randomUUID() } };
    }
  });

  ipcMain.handle('account:logout', async (event) => {
    validateSender(event);
    if (!runtimeManager) {
      return { ok: false, error: { code: 'CODEX_RUNTIME_UNAVAILABLE', messageKey: 'account.runtime_unavailable', retryable: false, correlationId: randomUUID() } };
    }
    if (personalWorkspace?.store.listStoredJobs().some((job) => job.status === 'running')) {
      return { ok: false, error: { code: 'ACCOUNT_HAS_RUNNING_JOB', messageKey: 'account.running_job', retryable: true, correlationId: randomUUID() } };
    }
    try {
      if (personalWorkspace) {
        await ensureRecoveryPointBeforeWrite();
        personalWorkspace.store.revokeAllAiAuthorizations();
      }
      const state = accountStateSchema.parse(await runtimeManager.logout());
      emitSnapshotChanged();
      return { ok: true, data: state };
    } catch (error) {
      const code = error instanceof Error ? error.message : 'CODEX_LOGOUT_FAILED';
      return { ok: false, error: { code, messageKey: 'account.logout_failed', retryable: code !== 'CODEX_RUNTIME_UNAVAILABLE', correlationId: randomUUID() } };
    }
  });
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  void app.whenReady().then(() => {
    nativeTheme.themeSource = 'light';
    const desktopState = readDesktopState();
    app.setLoginItemSettings({ openAtLogin: desktopState.openAtLogin });
    initializeRuntime();
    initializeWorkspaceState();
    void syncInboxWatcher();
    registerIpc();
    createWindow();
    if (desktopState.stayInTray) ensureTray();
    startScheduleCoordinator();
    powerMonitor.on('resume', () => void runScheduleCoordinator(true));
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  isQuitting = true;
  if (scheduleTimer) clearInterval(scheduleTimer);
  scheduleTimer = null;
  scheduleCoordinatorRunning = false;
  lastInboxReconcileAt = 0;
  pendingDirectorySelections.clear();
  pendingBackupRestores.clear();
  activeRestoreAbortController?.abort();
  activeRestoreAbortController = null;
  tray?.destroy();
  tray = null;
  void inboxWatcher?.close();
  inboxWatcher = null;
  runtimeManager?.shutdown();
  runtimeManager = null;
  jobRunner = null;
  personalWorkspace?.close();
  personalWorkspace = null;
});
