/* global process, fetch, WebSocket, setTimeout, Buffer */
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

function argument(name, fallback) {
  const prefix = `--${name}=`;
  return process.argv.find((item) => item.startsWith(prefix))?.slice(prefix.length) ?? fallback;
}

const port = Number(argument('port', '9229'));
const outputDirectory = resolve(argument('out', 'artifacts/member-v2-ui'));

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

async function clickButton(label) {
  const clicked = await evaluate(`(() => {
    const element = [...document.querySelectorAll('button')].find((button) => button.textContent?.trim().includes(${JSON.stringify(label)}));
    if (!element) return false;
    element.click();
    return true;
  })()`);
  if (!clicked) throw new Error(`BUTTON_NOT_FOUND: ${label}`);
  await new Promise((resolveWait) => setTimeout(resolveWait, 120));
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
  await new Promise((resolveWait) => setTimeout(resolveWait, 120));
}

await waitFor(`document.querySelector('.app-shell') !== null`);
await setViewport(1440, 900, 1);

const pages = [
  ['家庭总览', '01-family-overview'],
  ['成员档案', '02-member-profile'],
  ['报告收件箱', '03-inbox'],
  ['处理中心', '04-processing'],
  ['后续事项', '05-actions'],
  ['设置', '06-settings']
];
for (const [label, name] of pages) {
  await clickButton(label);
  await screenshot(name);
}

await clickButton('家庭总览');
const evidenceTrigger = await evaluate(`(() => {
  const element = document.querySelector('.organ-row');
  if (!element) return false;
  element.click();
  return true;
})()`);
if (evidenceTrigger) {
  await waitFor(`document.querySelector('.evidence-panel') !== null`);
  await screenshot('07-evidence-panel');
  await evaluate(`document.querySelector('[aria-label="关闭证据侧栏"]')?.click()`);
}

await clickButton('成员档案');
await setViewport(720, 450, 2);
await screenshot('08-member-profile-200-percent');

const audit = await evaluate(`(() => ({
  viewport: { width: innerWidth, height: innerHeight, devicePixelRatio },
  bodyScrollWidth: document.body.scrollWidth,
  bodyClientWidth: document.body.clientWidth,
  horizontalOverflow: document.body.scrollWidth > document.body.clientWidth,
  focusedLabel: document.activeElement?.getAttribute?.('aria-label') ?? document.activeElement?.textContent?.trim().slice(0, 80) ?? null
}))()`);
await writeFile(resolve(outputDirectory, 'audit.json'), `${JSON.stringify(audit, null, 2)}\n`);

client.close();
process.stdout.write(`${JSON.stringify({ outputDirectory, pages: pages.length + 2, audit }, null, 2)}\n`);
