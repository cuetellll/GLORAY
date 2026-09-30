'use strict';
const $ = (s) => document.querySelector(s);
const api = window.api;

const S = {
  nodes: [], status: 'disconnected', mode: 'proxy', selected: 'auto', settings: {},
  connectedAt: 0, liveId: null, filter: '', down: 0, up: 0, downTotal: 0, upTotal: 0, hist: new Array(60).fill(0),
};

// ---------- utils ----------
function fmtBytes(b) {
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (b >= 1024 && i < u.length - 1) { b /= 1024; i++; }
  return `${b.toFixed(i && b < 100 ? 1 : 0)} ${u[i]}`;
}
function esc(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
let toastT;
function toast(msg, err) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'toast show' + (err ? ' err' : '');
  clearTimeout(toastT);
  toastT = setTimeout(() => { t.className = 'toast' + (err ? ' err' : ''); }, 3800);
}
function confirmBox(text) {
  return new Promise((resolve) => {
    $('#confirmText').textContent = text;
    $('#confirmModal').classList.add('open');
    const done = (v) => { $('#confirmModal').classList.remove('open'); $('#confirmYes').onclick = $('#confirmNo').onclick = null; resolve(v); };
    $('#confirmYes').onclick = () => done(true);
    $('#confirmNo').onclick = () => done(false);
  });
}
const PROTO = { vless: 'VLESS', vmess: 'VMESS', trojan: 'TROJAN', shadowsocks: 'SS', hysteria2: 'HY2', tuic: 'TUIC' };

function pingInfo(n) {
  const v = n.delay !== undefined && n.delay !== null ? n.delay : n.latency;
  const real = n.delay !== undefined && n.delay !== null;
  if (v === undefined || v === null) return { txt: n.udp ? 'UDP' : '--', cls: '' };
  if (v < 0) return { txt: 'timeout', cls: 'bad' };
  const cls = v < (real ? 600 : 250) ? 'good' : v < (real ? 1500 : 600) ? 'mid' : 'bad';
  return { txt: `${v} ms`, cls, real };
}

// ---------- render ----------
function renderList() {
  const list = $('#list');
  const f = S.filter.toLowerCase();
  const nodes = S.nodes.filter((n) => !f || n.name.toLowerCase().includes(f) || n.host.toLowerCase().includes(f) || n.type.includes(f));
  $('#count').textContent = S.nodes.length;
  if (!S.nodes.length) {
    list.innerHTML = '<div class="empty">هنوز سروری نیست<br>روی دکمه بروزرسانی بزنید</div>';
    return;
  }
  const autoLive = S.status === 'connected' && S.selected === 'auto';
  let html = `<div class="node ${S.selected === 'auto' ? 'sel' : ''} ${autoLive ? 'live' : ''}" data-id="auto" style="animation-delay:0s">
      <span class="proto p-auto">AUTO</span>
      <div class="n-body"><div class="n-name">بهترین سرور (خودکار)</div><div class="n-meta">تست واقعی + انتخاب سریع‌ترین</div></div>
      <span class="ping good">⚡</span></div>`;
  html += nodes.map((n, i) => {
    const p = pingInfo(n);
    const live = S.status === 'connected' && S.liveId === n.id;
    return `<div class="node ${S.selected === n.id ? 'sel' : ''} ${live ? 'live' : ''}" data-id="${n.id}" style="animation-delay:${Math.min(i, 20) * 0.02}s">
      <span class="proto p-${n.type}">${PROTO[n.type] || n.type.toUpperCase()}</span>
      <div class="n-body"><div class="n-name">${esc(n.name)}</div><div class="n-meta">${esc(n.host)}:${n.port} · ${n.transport} · ${n.security}</div></div>
      <span class="ping ${p.cls}" title="${p.real ? 'تاخیر واقعی (از طریق تونل)' : 'پینگ TCP'}">${p.txt}</span></div>`;
  }).join('');
  list.innerHTML = html;
}

function renderStatus(d) {
  S.status = d.status;
  if (d.connectedAt !== undefined) S.connectedAt = d.connectedAt;
  document.body.className = 's-' + d.status;
  const labels = { disconnected: 'اتصال', connecting: 'لغو', connected: 'قطع اتصال' };
  const texts = { disconnected: 'متصل نیستید', connecting: 'در حال اتصال...', connected: 'متصل هستید' };
  $('#orbLabel').textContent = labels[d.status];
  $('#statusText').textContent = texts[d.status];
  if (d.status === 'connecting') $('#stepText').textContent = d.step || '';
  else if (d.status === 'connected') $('#stepText').textContent = d.mode === 'tun' ? 'تمام ترافیک سیستم از تونل عبور می‌کند' : `پروکسی سیستم فعال شد · 127.0.0.1:${d.mixedPort}`;
  else $('#stepText').textContent = 'با یک کلیک به سریع‌ترین سرور وصل شوید';
  if (d.error) toast(d.error, true);
  if (d.status !== 'connected') { S.liveId = null; S.down = S.up = 0; updateSpeeds(); renderCurrentIdle(); }
  renderList();
}

function renderCurrentIdle() {
  if (S.selected === 'auto') { $('#curIco').textContent = '⚡'; $('#curName').textContent = 'بهترین سرور (خودکار)'; }
  else { const n = S.nodes.find((x) => x.id === S.selected); $('#curIco').textContent = '🌐'; $('#curName').textContent = n ? n.name : '---'; }
  $('#curLabel').textContent = 'سرور انتخابی';
  $('#curDelay').textContent = '';
}

function updateSpeeds() {
  $('#downSpeed').textContent = fmtBytes(S.down) + '/s';
  $('#upSpeed').textContent = fmtBytes(S.up) + '/s';
  $('#downTotal').textContent = fmtBytes(S.downTotal);
  $('#upTotal').textContent = fmtBytes(S.upTotal);
}

function setMode(mode, animate = true) {
  S.mode = mode;
  const btns = [...document.querySelectorAll('#modeSwitch button')];
  btns.forEach((b) => b.classList.toggle('active', b.dataset.mode === mode));
  const a = btns.find((b) => b.dataset.mode === mode);
  const pill = $('#modeSwitch .pill');
  if (!animate) pill.style.transition = 'none';
  pill.style.left = a.offsetLeft + 'px';
  pill.style.width = a.offsetWidth + 'px';
  if (!animate) requestAnimationFrame(() => { pill.style.transition = ''; });
}

// ---------- actions ----------
async function doConnect() {
  const r = await api.invoke('vpn:connect', { mode: S.mode, id: S.selected });
  if (r && r.needAdmin) {
    const ok = await confirmBox('حالت تونل کامل (TUN) به دسترسی Administrator نیاز دارد. برنامه با دسترسی ادمین دوباره اجرا شود؟');
    if (ok) { const x = await api.invoke('app:relaunchAdmin'); if (!x.ok) toast(x.error, true); }
  }
}

$('#btnConnect').onclick = async () => {
  if (S.status === 'disconnected') doConnect();
  else api.invoke('vpn:disconnect');
};

document.querySelectorAll('#modeSwitch button').forEach((b) => {
  b.onclick = async () => {
    const mode = b.dataset.mode;
    if (mode === S.mode) return;
    setMode(mode);
    api.invoke('settings:set', { mode });
    if (S.status === 'connected') {
      toast('در حال تغییر حالت اتصال...');
      await api.invoke('vpn:disconnect');
      doConnect();
    }
  };
});

$('#list').onclick = async (e) => {
  const el = e.target.closest('.node');
  if (!el) return;
  const id = el.dataset.id === 'auto' ? 'auto' : parseInt(el.dataset.id, 10);
  S.selected = id;
  renderList();
  if (S.status !== 'connected') renderCurrentIdle();
  const r = await api.invoke('vpn:select', id);
  if (r && r.error) toast(r.error, true);
};
$('#list').ondblclick = (e) => { if (e.target.closest('.node') && S.status === 'disconnected') doConnect(); };

$('#search').oninput = (e) => { S.filter = e.target.value; renderList(); };

async function updateSubs(silent) {
  const b = $('#btnUpdate');
  b.classList.add('spin');
  const r = await api.invoke('subs:update');
  b.classList.remove('spin');
  if (!r.ok) toast(r.error, true);
  else if (!silent || r.fromCache) toast(`${r.count} سرور دریافت شد${r.fromCache ? ' (از حافظه)' : ''}${r.skipped ? ` · ${r.skipped} مورد ناسازگار` : ''}`);
}
$('#btnUpdate').onclick = () => updateSubs(false);

$('#btnTest').onclick = async () => {
  const b = $('#btnTest');
  if (b.classList.contains('spin')) return;
  b.classList.add('spin');
  toast(S.status === 'connected' ? 'تست سرعت واقعی از داخل تونل...' : 'در حال پینگ سرورها...');
  await api.invoke('nodes:test');
  b.classList.remove('spin');
};

// settings
$('#btnSettings').onclick = () => {
  $('#subUrl').value = S.settings.subUrl || '';
  $('#bypassIran').checked = !!S.settings.bypassIran;
  $('#settingsModal').classList.add('open');
};
$('#btnCancelSettings').onclick = () => $('#settingsModal').classList.remove('open');
$('#btnOpenData').onclick = () => api.invoke('app:openData');
$('#btnSaveSettings').onclick = async () => {
  const subChanged = $('#subUrl').value.trim() !== (S.settings.subUrl || '');
  S.settings = await api.invoke('settings:set', { subUrl: $('#subUrl').value.trim(), bypassIran: $('#bypassIran').checked });
  $('#settingsModal').classList.remove('open');
  toast('تنظیمات ذخیره شد' + (S.status === 'connected' ? ' (بعد از اتصال مجدد اعمال می‌شود)' : ''));
  if (subChanged && S.status === 'disconnected') updateSubs(false);
};

// log drawer
const logEl = $('#log');
let logLines = [];
$('#btnLog').onclick = () => $('#logDrawer').classList.toggle('open');
$('#btnCloseLog').onclick = () => $('#logDrawer').classList.remove('open');
$('#btnClearLog').onclick = () => { logLines = []; logEl.textContent = ''; };

// window
$('#wMin').onclick = () => api.invoke('win:min');
$('#wMax').onclick = () => api.invoke('win:max');
$('#wClose').onclick = () => api.invoke('win:close');

// ---------- events ----------
api.on('status', renderStatus);
api.on('nodes', (nodes) => { S.nodes = nodes; renderList(); });
api.on('core', (v) => { if (v) $('#coreVer').textContent = 'sing-box ' + v; });
api.on('log', (l) => {
  logLines.push(l);
  if (logLines.length > 500) logLines = logLines.slice(-400);
  logEl.textContent = logLines.join('\n');
  logEl.scrollTop = logEl.scrollHeight;
});
api.on('current', (c) => {
  if (S.status !== 'connected') return;
  const changed = S.liveId !== c.id;
  S.liveId = c.id;
  $('#curLabel').textContent = c.auto ? 'متصل به (انتخاب خودکار)' : 'متصل به';
  $('#curIco').textContent = c.auto ? '⚡' : '🌐';
  $('#curName').textContent = c.name || '---';
  const d = c.delay;
  $('#curDelay').textContent = d ? `${d} ms` : '';
  $('#curDelay').style.color = !d ? '' : d < 600 ? 'var(--ok)' : d < 1500 ? 'var(--warn)' : 'var(--bad)';
  if (changed) renderList();
});
api.on('traffic', (t) => {
  S.down = t.down || 0; S.up = t.up || 0;
  S.downTotal += S.down; S.upTotal += S.up;
  S.hist.push(S.down); S.hist.shift();
  updateSpeeds();
});

// timer
setInterval(() => {
  let s = S.status === 'connected' && S.connectedAt ? Math.floor((Date.now() - S.connectedAt) / 1000) : 0;
  const h = String(Math.floor(s / 3600)).padStart(2, '0'); s %= 3600;
  $('#timer').textContent = `${h}:${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}, 500);

// ---------- sparkline ----------
const spark = $('#spark');
const sctx = spark.getContext('2d');
function drawSpark() {
  const dpr = devicePixelRatio || 1;
  const w = spark.clientWidth, h = spark.clientHeight;
  if (spark.width !== w * dpr) { spark.width = w * dpr; spark.height = h * dpr; }
  sctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  sctx.clearRect(0, 0, w, h);
  const max = Math.max(...S.hist, 50 * 1024);
  const pts = S.hist.map((v, i) => [(i / (S.hist.length - 1)) * w, h - 4 - (v / max) * (h - 10)]);
  const col = S.status === 'connected' ? '#1dffa3' : '#8b5cff';
  const g = sctx.createLinearGradient(0, 0, 0, h);
  g.addColorStop(0, col + '66'); g.addColorStop(1, col + '00');
  sctx.beginPath();
  pts.forEach(([x, y], i) => (i ? sctx.lineTo(x, y) : sctx.moveTo(x, y)));
  sctx.lineTo(w, h); sctx.lineTo(0, h); sctx.closePath();
  sctx.fillStyle = g; sctx.fill();
  sctx.beginPath();
  pts.forEach(([x, y], i) => (i ? sctx.lineTo(x, y) : sctx.moveTo(x, y)));
  sctx.strokeStyle = col; sctx.lineWidth = 2; sctx.shadowColor = col; sctx.shadowBlur = 12; sctx.stroke(); sctx.shadowBlur = 0;
  requestAnimationFrame(drawSpark);
}

// ---------- particles background ----------
const bg = $('#bg');
const ctx = bg.getContext('2d');
let parts = [];
function resizeBg() {
  bg.width = innerWidth * devicePixelRatio; bg.height = innerHeight * devicePixelRatio;
  ctx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
  parts = Array.from({ length: Math.floor((innerWidth * innerHeight) / 16000) }, () => ({
    x: Math.random() * innerWidth, y: Math.random() * innerHeight,
    vx: (Math.random() - 0.5) * 0.3, vy: (Math.random() - 0.5) * 0.3, r: Math.random() * 1.6 + 0.4,
  }));
}
function drawBg() {
  ctx.clearRect(0, 0, innerWidth, innerHeight);
  const speed = S.status === 'connecting' ? 4 : S.status === 'connected' ? 1.6 : 1;
  const col = S.status === 'connected' ? '29,255,163' : S.status === 'connecting' ? '0,229,255' : '139,92,255';
  for (const p of parts) {
    p.x += p.vx * speed; p.y += p.vy * speed;
    if (p.x < 0) p.x = innerWidth; if (p.x > innerWidth) p.x = 0;
    if (p.y < 0) p.y = innerHeight; if (p.y > innerHeight) p.y = 0;
    ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
    ctx.fillStyle = `rgba(${col},.75)`; ctx.shadowColor = `rgb(${col})`; ctx.shadowBlur = 8; ctx.fill();
  }
  ctx.shadowBlur = 0;
  for (let i = 0; i < parts.length; i++) {
    for (let j = i + 1; j < parts.length; j++) {
      const a = parts[i], b = parts[j];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      if (d < 110) {
        ctx.strokeStyle = `rgba(${col},${(1 - d / 110) * 0.18})`;
        ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
      }
    }
  }
  requestAnimationFrame(drawBg);
}
addEventListener('resize', () => { resizeBg(); setMode(S.mode, false); });

// ---------- boot ----------
(async function boot() {
  resizeBg(); drawBg(); drawSpark();
  const init = await api.invoke('init');
  S.settings = init.settings;
  S.selected = init.settings.selected ?? 'auto';
  S.nodes = init.nodes;
  if (init.coreVersion) $('#coreVer').textContent = 'sing-box ' + init.coreVersion;
  setMode(init.autoTun ? 'tun' : init.settings.mode || 'proxy', false);
  renderStatus({ status: init.status, connectedAt: init.connectedAt, mode: init.mode });
  renderCurrentIdle();
  if (!S.nodes.length) await updateSubs(true);
  if (init.autoTun && init.isAdmin && S.status === 'disconnected') doConnect();
})();
