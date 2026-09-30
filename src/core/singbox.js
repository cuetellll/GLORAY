'use strict';
const { spawn, execFile } = require('child_process');
const EventEmitter = require('events');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { net } = require('electron');

const FALLBACK_VERSION = '1.12.0';

function exists(p) { try { return fs.existsSync(p); } catch { return false; } }

function findBundled() {
  const candidates = [
    path.join(process.resourcesPath || '', 'bin', 'sing-box.exe'),
    path.join(__dirname, '..', '..', 'bin', 'sing-box.exe'),
  ];
  return candidates.find(exists);
}

function ps(command) {
  return new Promise((resolve, reject) => {
    execFile('powershell', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command],
      { windowsHide: true, timeout: 120000 }, (err, so, se) => (err ? reject(new Error(se || err.message)) : resolve(so)));
  });
}

function findFile(dir, name) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { const f = findFile(p, name); if (f) return f; }
    else if (e.name.toLowerCase() === name) return p;
  }
  return null;
}

async function download(url, dest, onProgress) {
  const res = await net.fetch(url, { headers: { 'User-Agent': 'GlowRay' } });
  if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);
  const total = parseInt(res.headers.get('content-length') || '0', 10);
  const reader = res.body.getReader();
  const chunks = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(Buffer.from(value));
    got += value.length;
    if (total && onProgress) onProgress(Math.floor((got / total) * 100));
  }
  fs.writeFileSync(dest, Buffer.concat(chunks));
}

// Returns path to sing-box.exe. Uses bundled binary, cached binary, or downloads the latest release.
async function ensureCore(dataDir, onProgress, log) {
  const bundled = findBundled();
  if (bundled) return bundled;
  const dir = path.join(dataDir, 'core');
  const exe = path.join(dir, 'sing-box.exe');
  if (exists(exe)) return exe;
  fs.mkdirSync(dir, { recursive: true });

  const arch = process.arch === 'arm64' ? 'arm64' : process.arch === 'ia32' ? '386' : 'amd64';
  let url = `https://github.com/SagerNet/sing-box/releases/download/v${FALLBACK_VERSION}/sing-box-${FALLBACK_VERSION}-windows-${arch}.zip`;
  try {
    const r = await net.fetch('https://api.github.com/repos/SagerNet/sing-box/releases/latest', { headers: { 'User-Agent': 'GlowRay' } });
    const rel = await r.json();
    const re = new RegExp(`^sing-box-[\\d.]+-windows-${arch}\\.zip$`);
    const asset = (rel.assets || []).find((a) => re.test(a.name));
    if (asset) url = asset.browser_download_url;
  } catch (e) { log && log('[core] GitHub API unreachable, using pinned version'); }

  log && log('[core] downloading ' + url);
  const zip = path.join(os.tmpdir(), `sing-box-${Date.now()}.zip`);
  const tmp = path.join(os.tmpdir(), `sing-box-${Date.now()}`);
  await download(url, zip, onProgress);
  await ps(`Expand-Archive -LiteralPath '${zip}' -DestinationPath '${tmp}' -Force`);
  const found = findFile(tmp, 'sing-box.exe');
  if (!found) throw new Error('sing-box.exe در فایل دانلودی پیدا نشد');
  fs.copyFileSync(found, exe);
  try { fs.rmSync(tmp, { recursive: true, force: true }); fs.rmSync(zip, { force: true }); } catch { /* ignore */ }
  log && log('[core] installed ' + exe);
  return exe;
}

function checkConfig(exe, cfg, cwd) {
  return new Promise((resolve) => {
    execFile(exe, ['check', '-c', cfg, '-D', cwd], { windowsHide: true, timeout: 30000 },
      (err, so, se) => resolve(err ? { ok: false, error: String(se || so || err.message) } : { ok: true }));
  });
}

function coreVersion(exe) {
  return new Promise((resolve) => {
    execFile(exe, ['version'], { windowsHide: true, timeout: 10000 }, (err, so) => {
      const m = String(so || '').match(/version\s+([\w.\-]+)/i);
      resolve(err ? null : (m ? m[1] : null));
    });
  });
}

class Core extends EventEmitter {
  constructor() { super(); this.proc = null; this.stopping = false; }
  get running() { return !!this.proc; }

  start(exe, cfg, cwd) {
    return new Promise((resolve, reject) => {
      this.stopping = false;
      const p = spawn(exe, ['run', '-c', cfg, '-D', cwd], { cwd, windowsHide: true });
      this.proc = p;
      let settled = false;
      const onData = (d) => String(d).split(/\r?\n/).filter(Boolean).forEach((l) => this.emit('log', l));
      p.stdout.on('data', onData);
      p.stderr.on('data', onData);
      p.on('error', (e) => { this.proc = null; if (!settled) { settled = true; reject(e); } });
      p.on('exit', (code) => {
        if (this.proc === p) this.proc = null;
        if (!settled) { settled = true; reject(new Error(`sing-box با کد ${code} بسته شد (لاگ را ببینید)`)); return; }
        if (!this.stopping) this.emit('crash', code);
      });
      setTimeout(() => { if (!settled) { settled = true; resolve(); } }, 800);
    });
  }

  stop() {
    return new Promise((resolve) => {
      const p = this.proc;
      if (!p) return resolve();
      this.stopping = true;
      this.proc = null;
      let done = false;
      const fin = () => { if (!done) { done = true; resolve(); } };
      p.once('exit', fin);
      execFile('taskkill', ['/PID', String(p.pid), '/T', '/F'], { windowsHide: true }, () => {});
      setTimeout(fin, 4000);
    });
  }
}

module.exports = { Core, ensureCore, checkConfig, coreVersion };
