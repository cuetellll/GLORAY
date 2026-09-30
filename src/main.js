'use strict';
const { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, shell, net: enet } = require('electron');
const path = require('path');
const fs = require('fs');
const netm = require('net');
const crypto = require('crypto');
const { execFile } = require('child_process');

const { parseList } = require('./core/parser');
const { buildConfig, TEST_URL, OUTBOUND_OFFSET } = require('./core/config');
const { Core, ensureCore, checkConfig, coreVersion } = require('./core/singbox');
const sysproxy = require('./core/sysproxy');
const { tcpPingAll } = require('./core/tester');
const { ClashApi } = require('./core/clash');

const DEFAULT_SUB = 'https://gist.githubusercontent.com/cuetellll/75cbac9ada21968d8b31e21bc68fe050/raw/28065c4035d1d9808e276b9dc08be20b5e6be723/configs.txt';

if (!app.requestSingleInstanceLock()) { app.quit(); }

const DATA = app.getPath('userData');
fs.mkdirSync(DATA, { recursive: true });
const P = {
  settings: path.join(DATA, 'settings.json'),
  subCache: path.join(DATA, 'subscription.txt'),
  config: path.join(DATA, 'config.json'),
  proxyLock: path.join(DATA, 'proxy.lock'),
};

let settings = { subUrl: DEFAULT_SUB, mode: 'proxy', bypassIran: false, selected: 'auto' };
try { settings = { ...settings, ...JSON.parse(fs.readFileSync(P.settings, 'utf8')) }; } catch { /* first run */ }
const saveSettings = () => fs.writeFileSync(P.settings, JSON.stringify(settings, null, 2));

let win = null;
let tray = null;
let api = null;
let pollTimer = null;
let quitting = false;
const core = new Core();

const state = {
  nodes: [], runNodes: [], status: 'disconnected', mode: settings.mode,
  connectedAt: 0, busy: false, cancel: false, mixedPort: 10808, coreVersion: null,
};

// ---------- helpers ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function send(ch, d) { if (win && !win.isDestroyed()) win.webContents.send(ch, d); }
function log(line) { send('log', line); }
function publicNodes() {
  return state.nodes.map((n) => ({
    id: n.id, name: n.name, type: n.type, host: n.host, port: n.port,
    transport: n.transport, security: n.security, latency: n.latency, delay: n.delay, udp: n.udp,
  }));
}
function setStatus(status, extra = {}) {
  state.status = status;
  send('status', { status, mode: state.mode, connectedAt: state.connectedAt, mixedPort: state.mixedPort, ...extra });
  updateTray();
}
function checkpoint() { if (state.cancel) throw new Error('اتصال لغو شد'); }
function withTimeout(p, ms, msg) {
  return Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(msg || 'timeout')), ms))]);
}
function freePort(preferred) {
  const tryPort = (port) => new Promise((resolve) => {
    const s = netm.createServer();
    s.once('error', () => resolve(null));
    s.listen(port, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
  return tryPort(preferred).then((p) => p || tryPort(0));
}

// ---------- subscription ----------
async function fetchText(url) {
  const r = await enet.fetch(url, { cache: 'no-store', headers: { 'User-Agent': 'GlowRay/1.0 (sing-box)' } });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.text();
}

async function updateSubs() {
  if (state.status !== 'disconnected' && state.nodes.length) {
    return { ok: false, error: 'برای بروزرسانی لیست، اول اتصال را قطع کنید' };
  }
  const urls = String(settings.subUrl || DEFAULT_SUB).split(/\s+/).map((s) => s.trim()).filter(Boolean);
  let texts = [];
  let fromCache = false;
  const results = await Promise.allSettled(urls.map((u) => withTimeout(fetchText(u), 20000, 'timeout')));
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') texts.push(r.value);
    else log(`[sub] ${urls[i]} -> ${r.reason.message}`);
  });
  if (texts.length) fs.writeFileSync(P.subCache, texts.join('\n'));
  else if (fs.existsSync(P.subCache)) { texts = [fs.readFileSync(P.subCache, 'utf8')]; fromCache = true; }
  else return { ok: false, error: 'دریافت لیست کانفیگ‌ها ناموفق بود' };

  const { nodes, errors } = parseList(texts.join('\n'));
  errors.forEach((e) => log('[parse] ' + e));
  nodes.forEach((n, i) => { n.id = i; n.tag = 'n' + i; n.latency = undefined; n.delay = undefined; });
  state.nodes = nodes;
  if (settings.selected !== 'auto' && !nodes.find((n) => n.id === settings.selected)) settings.selected = 'auto';
  send('nodes', publicNodes());
  return { ok: true, count: nodes.length, fromCache, skipped: errors.length };
}

// ---------- latency ----------
async function pingAll() {
  let last = 0;
  await tcpPingAll(state.nodes, () => {
    if (Date.now() - last > 250) { last = Date.now(); send('nodes', publicNodes()); }
  });
  send('nodes', publicNodes());
}

function applyDelays(map) {
  for (const n of state.runNodes) {
    if (Object.prototype.hasOwnProperty.call(map, n.tag)) n.delay = map[n.tag] > 0 ? map[n.tag] : -1;
    else if (n.delay === undefined) n.delay = -1;
  }
  send('nodes', publicNodes());
}

async function realTest() {
  if (!api || state.status !== 'connected') return pingAll();
  try { applyDelays(await api.groupDelay('auto', TEST_URL, 6000)); } catch (e) { log('[test] ' + e.message); }
  await pollCurrent();
}

// ---------- monitors ----------
async function pollCurrent() {
  if (!api) return;
  try {
    const sel = await api.get('/proxies/proxy', 3000);
    let now = sel.now;
    if (now === 'auto') now = (await api.get('/proxies/auto', 3000)).now;
    const info = await api.get('/proxies/' + encodeURIComponent(now), 3000);
    const h = info.history || [];
    const delay = h.length ? h[h.length - 1].delay : null;
    const node = state.runNodes.find((n) => n.tag === now);
    send('current', { id: node ? node.id : null, name: node ? node.name : now, type: node ? node.type : '', delay, auto: sel.now === 'auto' });
  } catch { /* ignore */ }
}

function startMonitors() {
  api.stream('/traffic', (o) => send('traffic', o));
  pollCurrent();
  pollTimer = setInterval(pollCurrent, 3000);
}

function stopMonitors() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
  if (api) api.close();
}

// ---------- connect / disconnect ----------
async function teardown() {
  stopMonitors();
  api = null;
  if (fs.existsSync(P.proxyLock)) {
    await sysproxy.disable();
    try { fs.unlinkSync(P.proxyLock); } catch { /* */ }
  }
  await core.stop();
  state.connectedAt = 0;
}

async function connect(opts = {}) {
  if (state.busy || state.status === 'connected') return { ok: false };
  state.busy = true;
  state.cancel = false;
  state.mode = opts.mode === 'tun' ? 'tun' : 'proxy';
  settings.mode = state.mode;
  saveSettings();
  try {
    setStatus('connecting', { step: 'آماده‌سازی...' });
    if (state.mode === 'tun' && !(await sysproxy.isAdmin())) return { ok: false, needAdmin: true };

    if (!state.nodes.length) {
      setStatus('connecting', { step: 'دریافت لیست سرورها...' });
      const r = await updateSubs();
      if (!r.ok) throw new Error(r.error);
    }
    if (!state.nodes.length) throw new Error('هیچ کانفیگ معتبری پیدا نشد');

    setStatus('connecting', { step: 'آماده‌سازی هسته sing-box...' });
    const exe = await ensureCore(DATA, (p) => setStatus('connecting', { step: `دانلود هسته sing-box... ${p}%` }), log);
    if (!state.coreVersion) { state.coreVersion = await coreVersion(exe); send('core', state.coreVersion); }
    checkpoint();

    let selected = opts.id !== undefined && opts.id !== null && opts.id !== 'auto'
      ? state.nodes.find((n) => n.id === opts.id) : null;
    let run;
    if (!selected) {
      setStatus('connecting', { step: 'پینگ همه سرورها...' });
      await pingAll();
      checkpoint();
      const tcp = state.nodes.filter((n) => !n.udp && n.latency > 0).sort((a, b) => a.latency - b.latency);
      const udp = state.nodes.filter((n) => n.udp);
      run = [...tcp.slice(0, 40), ...udp.slice(0, 15)];
      if (!run.length) { log('[warn] هیچ سروری به پینگ TCP جواب نداد، همه تست می‌شوند'); run = state.nodes.slice(0, 60); }
    } else {
      run = state.nodes.slice();
    }

    const mixedPort = await freePort(10808);
    const apiPort = await freePort(19090);
    const secret = crypto.randomBytes(16).toString('hex');
    state.mixedPort = mixedPort;

    setStatus('connecting', { step: 'بررسی کانفیگ‌ها...' });
    let valid = false;
    for (let attempt = 0; attempt < 40 && run.length; attempt++) {
      const cfg = buildConfig({
        nodes: run, mode: state.mode, selectedTag: selected ? selected.tag : null,
        mixedPort, apiPort, secret, bypassIran: settings.bypassIran, dataDir: DATA,
      });
      fs.writeFileSync(P.config, JSON.stringify(cfg, null, 2));
      const res = await checkConfig(exe, P.config, DATA);
      if (res.ok) { valid = true; break; }
      const m = res.error.match(/outbounds?\[(\d+)\]/);
      const idx = m ? parseInt(m[1], 10) - OUTBOUND_OFFSET : -1;
      if (idx >= 0 && idx < run.length) {
        log(`[skip] ${run[idx].name}: ${res.error.trim().split('\n').pop()}`);
        if (run[idx] === selected) selected = null;
        run.splice(idx, 1);
        continue;
      }
      throw new Error(res.error.trim().split('\n').pop());
    }
    if (!valid) throw new Error('هیچ کانفیگ سازگاری با sing-box پیدا نشد');
    state.runNodes = run;
    checkpoint();

    setStatus('connecting', { step: state.mode === 'tun' ? 'ساخت تونل کل سیستم...' : 'راه‌اندازی پروکسی...' });
    await core.start(exe, P.config, DATA);
    api = new ClashApi(apiPort, secret);
    await api.waitReady(20000, () => core.running);
    checkpoint();

    if (state.mode === 'proxy') {
      fs.writeFileSync(P.proxyLock, String(mixedPort));
      await sysproxy.enable(mixedPort);
    }

    if (!selected && run.length > 1) {
      setStatus('connecting', { step: `تست واقعی ${run.length} سرور و انتخاب سریع‌ترین...` });
      try { applyDelays(await api.groupDelay('auto', TEST_URL, 6000)); } catch (e) { log('[test] ' + e.message); }
      checkpoint();
    }

    state.connectedAt = Date.now();
    setStatus('connected');
    startMonitors();
    return { ok: true };
  } catch (e) {
    log('[error] ' + e.message);
    await teardown();
    setStatus('disconnected', { error: state.cancel ? null : e.message });
    return { ok: false, error: e.message };
  } finally {
    state.busy = false;
    if (state.status === 'connecting') setStatus('disconnected');
  }
}

async function disconnect() {
  if (state.busy) { state.cancel = true; await core.stop(); return { ok: true }; }
  await teardown();
  setStatus('disconnected');
  return { ok: true };
}

async function selectServer(id) {
  settings.selected = id;
  saveSettings();
  if (state.status !== 'connected' || !api) return { ok: true };
  if (id === 'auto') { await api.select('proxy', 'auto'); await pollCurrent(); return { ok: true }; }
  const node = state.runNodes.find((n) => n.id === id);
  if (node) { await api.select('proxy', node.tag); await pollCurrent(); return { ok: true }; }
  // not part of the running set: reconnect with it
  await disconnect();
  return connect({ mode: state.mode, id });
}

core.on('log', (l) => log(l));
core.on('crash', async (code) => {
  log(`[core] sing-box stopped unexpectedly (${code})`);
  await teardown();
  setStatus('disconnected', { error: 'هسته sing-box متوقف شد، لاگ را بررسی کنید' });
});

// ---------- admin relaunch (for TUN) ----------
function relaunchAsAdmin() {
  const q = (s) => s.replace(/'/g, "''");
  const args = process.argv.slice(1).filter((a) => !a.startsWith('--inspect') && a !== '--auto-tun');
  args.push('--auto-tun');
  const argList = args.map((a) => `'"${q(a)}"'`).join(',');
  const cmd = `Start-Process -FilePath '${q(process.execPath)}' -ArgumentList ${argList} -Verb RunAs`;
  return new Promise((resolve) => {
    app.releaseSingleInstanceLock();
    execFile('powershell', ['-NoProfile', '-WindowStyle', 'Hidden', '-Command', cmd], { windowsHide: true }, async (err) => {
      if (err) { app.requestSingleInstanceLock(); resolve({ ok: false, error: 'اجرای ادمین لغو شد' }); return; }
      resolve({ ok: true });
      quitting = true;
      await teardown();
      app.exit(0);
    });
  });
}

// ---------- window & tray ----------
function createWindow() {
  win = new BrowserWindow({
    width: 1080, height: 700, minWidth: 940, minHeight: 620,
    frame: false, backgroundColor: '#06060d', show: false,
    icon: path.join(__dirname, 'assets', 'icon.png'),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.once('ready-to-show', () => win.show());
  win.on('close', (e) => { if (!quitting) { e.preventDefault(); win.hide(); } });
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
}

function updateTray() {
  if (!tray) return;
  const connected = state.status === 'connected';
  tray.setToolTip(`GlowRay: ${connected ? 'متصل' : state.status === 'connecting' ? 'در حال اتصال' : 'قطع'}`);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'نمایش GlowRay', click: () => { win.show(); win.focus(); } },
    { type: 'separator' },
    connected || state.status === 'connecting'
      ? { label: 'قطع اتصال', click: () => disconnect() }
      : { label: 'اتصال به بهترین سرور', click: () => connect({ mode: settings.mode, id: settings.selected }) },
    { type: 'separator' },
    { label: 'خروج', click: () => app.quit() },
  ]));
}

function createTray() {
  const img = nativeImage.createFromPath(path.join(__dirname, 'assets', 'icon.png')).resize({ width: 16, height: 16 });
  tray = new Tray(img);
  tray.on('click', () => { win.show(); win.focus(); });
  updateTray();
}

// ---------- IPC ----------
ipcMain.handle('init', async () => ({
  settings, nodes: publicNodes(), status: state.status, mode: state.mode,
  connectedAt: state.connectedAt, isAdmin: await sysproxy.isAdmin(), coreVersion: state.coreVersion,
  autoTun: process.argv.includes('--auto-tun'),
}));
ipcMain.handle('subs:update', () => updateSubs().catch((e) => ({ ok: false, error: e.message })));
ipcMain.handle('nodes:test', () => realTest().then(() => ({ ok: true })));
ipcMain.handle('vpn:connect', (_, o) => connect(o || {}));
ipcMain.handle('vpn:disconnect', () => disconnect());
ipcMain.handle('vpn:select', (_, id) => selectServer(id).catch((e) => ({ ok: false, error: e.message })));
ipcMain.handle('settings:set', (_, s) => { settings = { ...settings, ...s }; saveSettings(); return settings; });
ipcMain.handle('app:relaunchAdmin', () => relaunchAsAdmin());
ipcMain.handle('app:openData', () => shell.openPath(DATA));
ipcMain.handle('win:min', () => win.minimize());
ipcMain.handle('win:max', () => (win.isMaximized() ? win.unmaximize() : win.maximize()));
ipcMain.handle('win:close', () => win.hide());
ipcMain.handle('app:quit', () => app.quit());

// ---------- lifecycle ----------
app.on('second-instance', () => { if (win) { win.show(); win.focus(); } });

app.whenReady().then(async () => {
  app.setAppUserModelId('com.mahyar.glowray');
  await sysproxy.cleanupStale(P.proxyLock);
  createWindow();
  createTray();
});

app.on('before-quit', async (e) => {
  if (quitting && !core.running && !fs.existsSync(P.proxyLock)) return;
  e.preventDefault();
  quitting = true;
  try { await teardown(); } catch { /* */ }
  app.exit(0);
});

app.on('window-all-closed', () => { /* keep running in tray */ });
