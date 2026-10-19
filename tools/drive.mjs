/**
 * Headless Brave + CDP driver: loads the game, captures console + errors,
 * takes screenshots, runs JS in the page. Usage:
 *   node tools/drive.mjs '<json script>'
 */
import { spawn, execSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';

const BRAVE = '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser';
const PORT = 9222;
const URL = process.env.GAME_URL || 'http://localhost:5183/?autostart';

const steps = JSON.parse(process.argv[2] || '[]');

process.on('exit', () => { try { chrome.kill('SIGKILL'); } catch (e) {} });
process.on('SIGINT', () => process.exit(0));
const chrome = spawn(BRAVE, [
  '--headless=new', `--remote-debugging-port=${PORT}`,
  '--use-angle=metal', '--enable-unsafe-webgpu', '--enable-gpu',
  '--window-size=1600,900', '--hide-scrollbars', '--mute-audio',
  `--user-data-dir=/tmp/railelf-profile-${Date.now()}`,
  'about:blank',
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getWsUrl() {
  for (let i = 0; i < 40; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const tabs = await res.json();
      const page = tabs.find((t) => t.type === 'page');
      if (page) return page.webSocketDebuggerUrl;
    } catch (e) { /* not up yet */ }
    await sleep(250);
  }
  throw new Error('no debug target');
}

const ws = new WebSocket(await getWsUrl());
let mid = 0;
const pending = new Map();
const consoleLog = [];
const errors = [];

ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg);
    pending.delete(msg.id);
  } else if (msg.method === 'Runtime.consoleAPICalled') {
    const text = msg.params.args.map((a) => a.value ?? a.description ?? JSON.stringify(a.preview?.properties?.slice(0,6)) ?? '').join(' ');
    consoleLog.push(`[${msg.params.type}] ${text}`);
  } else if (msg.method === 'Runtime.exceptionThrown') {
    const d = msg.params.exceptionDetails;
    errors.push(`${d.text} ${d.exception?.description ?? ''}`);
  } else if (msg.method === 'Log.entryAdded') {
    const e = msg.params.entry;
    if (e.level === 'error' || e.level === 'warning') consoleLog.push(`[log:${e.level}] ${e.text}`);
  }
};

function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++mid;
    pending.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params }));
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error('timeout ' + method)); } }, 30000);
  });
}

await new Promise((r) => { ws.onopen = r; });
await send('Runtime.enable');
await send('Page.enable');
await send('Page.addScriptToEvaluateOnNewDocument', { source: `
  window.__bootErrs = [];
  const _ce = console.error.bind(console);
  console.error = (...a) => { window.__bootErrs.push(a.map(x=>String(x)).join(' ')); _ce(...a); };
  const _cw = console.warn.bind(console);
  console.warn = (...a) => { window.__bootErrs.push('[w] '+a.map(x=>String(x)).join(' ')); _cw(...a); };
`});
await send('Log.enable');
await send('Page.navigate', { url: URL });

let shotIdx = 0;
mkdirSync('testshots', { recursive: true });

for (const step of steps) {
  if (step.wait) await sleep(step.wait);
  if (step.eval) {
    const r = await send('Runtime.evaluate', { expression: step.eval, awaitPromise: true, returnByValue: true });
    if (r.result?.exceptionDetails) errors.push('eval: ' + JSON.stringify(r.result.exceptionDetails.text));
    else if (step.log !== false) consoleLog.push('EVAL> ' + JSON.stringify(r.result?.result?.value));
  }
  if (step.key) {
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: step.key, code: step.code || step.key });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: step.key, code: step.code || step.key });
  }
  if (step.down) {
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: step.down[0], y: step.down[1], button: 'left', clickCount: 1 });
  }
  if (step.up) {
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: step.up[0], y: step.up[1], button: 'left', clickCount: 1 });
  }
  if (step.keyDown) {
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: step.keyDown, code: step.code || step.keyDown });
  }
  if (step.keyUp) {
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: step.keyUp, code: step.code || step.keyUp });
  }
  if (step.click) {
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: step.click[0], y: step.click[1], button: 'left', clickCount: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: step.click[0], y: step.click[1], button: 'left', clickCount: 1 });
  }
  if (step.mouse) {
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: step.mouse[0], y: step.mouse[1] });
  }
  if (step.shot) {
    const r = await send('Page.captureScreenshot', { format: 'png' });
    const name = `testshots/${String(shotIdx++).padStart(2, '0')}-${step.shot}.png`;
    writeFileSync(name, Buffer.from(r.result.data, 'base64'));
    consoleLog.push('SHOT ' + name);
  }
}

console.log('═══ CONSOLE ═══');
for (const l of consoleLog.slice(-80)) console.log(l);
console.log('═══ ERRORS ═══');
for (const e of errors.slice(-20)) console.log(e);
if (!errors.length) console.log('(none)');

try { chrome.kill('SIGKILL'); } catch (e) {}
process.exit(0);
