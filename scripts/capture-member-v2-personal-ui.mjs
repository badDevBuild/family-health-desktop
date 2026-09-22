/* global process, fetch, WebSocket, setTimeout, Buffer */
import { mkdir, writeFile } from 'node:fs/promises';
import { relative, resolve } from 'node:path';

function argument(name, fallback) {
  const prefix = `--${name}=`;
  return process.argv.find((item) => item.startsWith(prefix))?.slice(prefix.length) ?? fallback;
}

const port = Number(argument('port', '9229'));
const outputDirectory = resolve(argument('out', 'artifacts/member-v2-personal-ui'));
const adoptAction = argument('adopt', 'false') === 'true';
const captureProcessing = argument('processing', 'false') === 'true';
const systemLabel = argument('system', '');
const metricLabel = argument('metric', '低密度脂蛋白');
const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((response) => response.json());
const target = targets.find((item) => item.type === 'page' && item.webSocketDebuggerUrl);
if (!target) throw new Error('CDP_PAGE_TARGET_NOT_FOUND');

class CdpClient {
  constructor(url) {
    this.socket = new WebSocket(url);
    this.nextId = 1;
    this.pending = new Map();
  }

  async connect() {
    await new Promise((resolveConnection, reject) => {
      this.socket.addEventListener('open', resolveConnection, { once: true });
      this.socket.addEventListener('error', reject, { once: true });
    });
    this.socket.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data));
      if (!message.id) return;
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result);
    });
  }

  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolveCommand, reject) => {
      this.pending.set(id, { resolve: resolveCommand, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  close() {
    this.socket.close();
  }
}

const client = new CdpClient(target.webSocketDebuggerUrl);
await client.connect();
await client.send('Page.enable');
await client.send('Runtime.enable');
await mkdir(outputDirectory, { recursive: true });

async function evaluate(expression) {
  const result = await client.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text ?? 'CDP_EVALUATION_FAILED');
  return result.result?.value;
}

async function waitFor(expression, timeoutMs = 10_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await evaluate(expression)) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error(`WAIT_TIMEOUT: ${expression}`);
}

async function clickButton(label, exact = false) {
  const clicked = await evaluate(`(() => {
    const element = [...document.querySelectorAll('button')].find((button) => {
      const text = button.textContent?.trim() ?? '';
      return ${exact ? `text === ${JSON.stringify(label)}` : `text.includes(${JSON.stringify(label)})`};
    });
    if (!element) return false;
    element.click();
    return true;
  })()`);
  if (!clicked) throw new Error(`BUTTON_NOT_FOUND: ${label}`);
  await new Promise((resolveWait) => setTimeout(resolveWait, 180));
}

async function selectSystem(label) {
  if (!label) return false;
  const selected = await evaluate(`(() => {
    const element = [...document.querySelectorAll('.system-directory button')]
      .find((button) => button.textContent?.includes(${JSON.stringify(label)}));
    if (!element) return false;
    element.click();
    return true;
  })()`);
  if (!selected) throw new Error(`SYSTEM_NOT_FOUND: ${label}`);
  await new Promise((resolveWait) => setTimeout(resolveWait, 180));
  return true;
}

async function screenshot(name) {
  const { data } = await client.send('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false });
  await writeFile(resolve(outputDirectory, `${name}.png`), Buffer.from(data, 'base64'));
}

async function setViewport(width, height, deviceScaleFactor = 1) {
  await client.send('Emulation.setDeviceMetricsOverride', {
    width,
    height,
    deviceScaleFactor,
    mobile: false,
    screenWidth: width,
    screenHeight: height
  });
  await new Promise((resolveWait) => setTimeout(resolveWait, 180));
}

async function pressKey(key, code, windowsVirtualKeyCode) {
  const base = { key, code, windowsVirtualKeyCode, nativeVirtualKeyCode: windowsVirtualKeyCode };
  await client.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...base });
  if (key === 'Enter') await client.send('Input.dispatchKeyEvent', { type: 'char', ...base, text: '\r', unmodifiedText: '\r' });
  await client.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
  await new Promise((resolveWait) => setTimeout(resolveWait, 160));
}

async function auditCurrentPage(name) {
  const audit = await evaluate(`(() => ({
    name: ${JSON.stringify(name)},
    viewport: { width: innerWidth, height: innerHeight, devicePixelRatio },
    documentScrollWidth: document.documentElement.scrollWidth,
    documentClientWidth: document.documentElement.clientWidth,
    horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
    visibleHeading: [...document.querySelectorAll('h1,h2')].find((element) => {
      const rect = element.getBoundingClientRect();
      return rect.bottom > 0 && rect.top < innerHeight;
    })?.textContent?.trim() ?? null
  }))()`);
  return audit;
}

async function auditAssessmentActionLayout() {
  return evaluate(`(() => {
    const card = document.querySelector('.assessment-action-card');
    const title = card?.querySelector('.panel__heading h3');
    if (!card || !title) return null;
    const cardRect = card.getBoundingClientRect();
    const titleRect = title.getBoundingClientRect();
    return {
      cardWidth: Math.round(cardRect.width),
      titleWidth: Math.round(titleRect.width),
      titleHeight: Math.round(titleRect.height),
      readable: titleRect.width >= 180 && titleRect.height < 150
    };
  })()`);
}

await client.send('Page.reload', { ignoreCache: true });
await waitFor(`document.querySelector('.app-shell') !== null`);
await setViewport(1440, 900, 1);
if (captureProcessing) {
  await clickButton('处理中心', true);
  await screenshot('00-processing-center');
}
await clickButton('成员档案', true);
await waitFor(`[role="tab"] !== null`);

const desktopTabs = [
  ['健康总览', '01-overview'],
  ['身体与指标', '02-body'],
  ['检查时间线', '04-timeline'],
  ['生活与行动', '06-guidance'],
  ['原始资料', '07-sources']
];
let desktopAssessmentActionLayout = null;
for (const [label, name] of desktopTabs) {
  await clickButton(label, true);
  if (label === '身体与指标') await selectSystem(systemLabel);
  if (label === '生活与行动') desktopAssessmentActionLayout = await auditAssessmentActionLayout();
  await screenshot(name);
}

await clickButton('身体与指标', true);
await selectSystem(systemLabel);
await new Promise((resolveWait) => setTimeout(resolveWait, 500));
const metricOpened = await evaluate(`(() => {
  const element = [...document.querySelectorAll('.system-detail button')]
    .find((button) => button.textContent?.includes(${JSON.stringify(metricLabel)}));
  if (!element) return false;
  element.click();
  return true;
})()`);
if (metricOpened) {
  await new Promise((resolveWait) => setTimeout(resolveWait, 180));
  await screenshot('03-metric-detail');
}

await clickButton('检查时间线', true);
await waitFor(`document.querySelector('.timeline-list button') !== null`);
const eventOpened = await evaluate(`(() => {
  const element = document.querySelector('.timeline-list button');
  if (!element) return false;
  element.click();
  return true;
})()`);
if (eventOpened) {
  await new Promise((resolveWait) => setTimeout(resolveWait, 180));
  await screenshot('05-event-detail');
}

await clickButton('原始资料', true);
await waitFor(`document.querySelector('.source-document-list') !== null`);
const sourceOpened = await evaluate(`(() => {
  const element = [...document.querySelectorAll('.source-document-list button')].find((button) => button.textContent?.trim() === '查看原件');
  if (!element) return false;
  element.click();
  return true;
})()`);
if (sourceOpened) {
  await waitFor(`document.querySelector('.evidence-panel') !== null`);
  await screenshot('08-evidence-panel');
  await evaluate(`document.querySelector('[aria-label="关闭证据侧栏"]')?.click()`);
  await new Promise((resolveWait) => setTimeout(resolveWait, 120));
}

await setViewport(720, 450, 2);
const compactAudits = [];
let compactAssessmentActionLayout = null;
let compactActionScreenshot = false;
for (const [label, name] of desktopTabs) {
  await clickButton(label, true);
  if (label === '身体与指标') await selectSystem(systemLabel);
  if (label === '生活与行动') compactAssessmentActionLayout = await auditAssessmentActionLayout();
  const compactName = `${name}-200-percent`;
  await screenshot(compactName);
  compactAudits.push(await auditCurrentPage(compactName));
  if (label === '生活与行动' && compactAssessmentActionLayout) {
    await evaluate(`document.querySelector('.assessment-action-card')?.scrollIntoView({ block: 'center' })`);
    await screenshot('06-guidance-action-200-percent');
    compactActionScreenshot = true;
  }
}

await setViewport(1440, 900, 1);
await client.send('Page.reload', { ignoreCache: true });
await waitFor(`document.querySelector('.app-shell') !== null`);
await clickButton('成员档案', true);
await waitFor(`[role="tab"] !== null`);
const focusedBodyTab = await evaluate(`(() => {
  const element = [...document.querySelectorAll('[role="tab"]')].find((tab) => tab.textContent?.trim() === '身体与指标');
  element?.focus();
  return document.activeElement === element;
})()`);
await pressKey('Enter', 'Enter', 13);
await waitFor(`document.querySelector('.system-directory button') !== null`);
const focusedSystem = await evaluate(`(() => {
  const element = ${systemLabel
    ? `[...document.querySelectorAll('.system-directory button')].find((button) => button.textContent?.includes(${JSON.stringify(systemLabel)}))`
    : `document.querySelector('.system-directory button')`};
  element?.focus();
  return document.activeElement === element;
})()`);
await pressKey('Enter', 'Enter', 13);
await waitFor(`document.querySelector('.system-metric-list > button') !== null`);
const focusedMetric = await evaluate(`(() => {
  const element = [...document.querySelectorAll('.system-metric-list > button')]
    .find((button) => button.textContent?.includes(${JSON.stringify(metricLabel)}));
  element?.focus();
  return document.activeElement === element;
})()`);
await pressKey('Enter', 'Enter', 13);
await waitFor(`document.querySelector('.member-metric-detail .evidence-link') !== null`);
const focusedEvidenceTrigger = await evaluate(`(() => {
  const element = document.querySelector('.member-metric-detail .evidence-link');
  element?.setAttribute('data-keyboard-audit-trigger', 'true');
  element?.focus();
  return document.activeElement === element;
})()`);
await pressKey('Enter', 'Enter', 13);
await waitFor(`document.querySelector('.evidence-panel') !== null`);
const evidenceCloseFocused = await evaluate(`document.activeElement?.getAttribute('aria-label') === '关闭证据侧栏'`);
await pressKey('Escape', 'Escape', 27);
await waitFor(`document.querySelector('.evidence-panel') === null`);
const evidenceTriggerFocusRestored = await evaluate(`document.activeElement?.getAttribute('data-keyboard-audit-trigger') === 'true'`);
const keyboardJourney = {
  focusedBodyTab,
  focusedSystem,
  focusedMetric,
  focusedEvidenceTrigger,
  evidenceCloseFocused,
  evidenceTriggerFocusRestored,
  passed: [focusedBodyTab, focusedSystem, focusedMetric, focusedEvidenceTrigger, evidenceCloseFocused, evidenceTriggerFocusRestored].every(Boolean)
};

let adoptionJourney = null;
if (adoptAction) {
  await clickButton('生活与行动', true);
  await waitFor(`document.querySelector('.member-proposal-list') !== null`);
  const assessmentAction = await evaluate(`document.querySelector('.assessment-action-card') !== null`);
  if (assessmentAction) {
    const alreadyAdopted = await evaluate(`document.querySelector('.assessment-action-card')?.textContent?.includes('已加入后续事项') === true`);
    if (!alreadyAdopted) {
      const clicked = await evaluate(`(() => {
        const button = [...document.querySelectorAll('.assessment-action-card button')]
          .find((element) => element.textContent?.trim() === '加入后续事项');
        button?.click();
        return Boolean(button);
      })()`);
      if (!clicked) throw new Error('ASSESSMENT_ADOPTION_BUTTON_NOT_FOUND');
      await waitFor(`document.querySelector('.assessment-action-card')?.textContent?.includes('已加入后续事项') === true`);
    }
    const adoptedActionCount = await evaluate(`document.querySelectorAll('.adopted-action-card').length`);
    await evaluate(`document.querySelector('.adopted-action-card')?.scrollIntoView({ block: 'center' })`);
    await screenshot('09-adopted-action');
    await client.send('Page.reload', { ignoreCache: true });
    await waitFor(`document.querySelector('.app-shell') !== null`);
    await clickButton('成员档案', true);
    await waitFor(`[role="tab"] !== null`);
    await clickButton('生活与行动', true);
    await waitFor(`document.querySelector('.assessment-action-card') !== null`);
    const persistedAfterReload = await evaluate(`document.querySelector('.assessment-action-card')?.textContent?.includes('已加入后续事项') === true`);
    const countAfterReload = await evaluate(`document.querySelectorAll('.adopted-action-card').length`);
    adoptionJourney = {
      kind: 'assessment-v3', startedFrom: alreadyAdopted ? 'adopted' : 'proposed',
      adopted: adoptedActionCount > 0, adoptedActionCount,
      persistedAfterReload, countAfterReload, noDuplicateAfterReload: countAfterReload === adoptedActionCount
    };
    if (!adoptionJourney.adopted || !persistedAfterReload || !adoptionJourney.noDuplicateAfterReload) {
      throw new Error('ASSESSMENT_ADOPTION_PERSISTENCE_FAILED');
    }
    await evaluate(`document.querySelector('.adopted-action-card')?.scrollIntoView({ block: 'center' })`);
    await screenshot('10-adopted-action-after-reload');
  } else {
    const alreadyAdopted = await evaluate(`document.querySelector('.proposal-adopted') !== null`);
    if (!alreadyAdopted) {
      await clickButton('采纳为我的行动', true);
      await waitFor(`document.querySelector('.proposal-adoption-form') !== null`);
      const formVisible = await evaluate(`document.querySelector('.proposal-adoption-form') !== null`);
      await clickButton('确认加入行动', true);
      await waitFor(`document.querySelector('.proposal-adopted') !== null`);
      adoptionJourney = { kind: 'legacy-proposal', startedFrom: 'proposed', formVisible, adopted: true };
    } else {
      adoptionJourney = { kind: 'legacy-proposal', startedFrom: 'adopted', formVisible: false, adopted: true };
    }
    await screenshot('09-adopted-action');
  }
}

const accessibilityAudit = await evaluate(`(() => ({
  tabs: [...document.querySelectorAll('[role="tab"]')].map((tab) => ({
    label: tab.textContent?.trim(), selected: tab.getAttribute('aria-selected')
  })),
  dialogs: [...document.querySelectorAll('[role="dialog"]')].length,
  unlabeledButtons: [...document.querySelectorAll('button')].filter((button) => {
    const text = button.textContent?.trim();
    return !text && !button.getAttribute('aria-label') && !button.getAttribute('title');
  }).length
}))()`);

const result = {
  outputDirectory: relative(process.cwd(), outputDirectory),
  syntheticOnly: true,
  processingScreenshot: captureProcessing,
  selectedSystem: systemLabel || null,
  selectedMetric: metricLabel,
  detailCoverage: { metricOpened, eventOpened, sourceOpened },
  desktopScreenshots: desktopTabs.length + Number(metricOpened) + Number(eventOpened) + Number(sourceOpened),
  compactScreenshots: desktopTabs.length,
  compactActionScreenshot,
  compactAudits,
  assessmentActionLayout: {
    desktop: desktopAssessmentActionLayout,
    compact: compactAssessmentActionLayout,
    readable: [desktopAssessmentActionLayout, compactAssessmentActionLayout]
      .filter(Boolean).every((layout) => layout.readable)
  },
  allCompactPagesWithoutHorizontalOverflow: compactAudits.every((item) => !item.horizontalOverflow),
  keyboardJourney,
  adoptionJourney,
  accessibilityAudit
};
await writeFile(resolve(outputDirectory, 'audit.json'), `${JSON.stringify(result, null, 2)}\n`);
client.close();
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
if (!result.assessmentActionLayout.readable) process.exitCode = 1;
