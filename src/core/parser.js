'use strict';
// Parses v2ray-style share links into sing-box outbounds.
// Supported: vless, vmess, trojan, ss, hysteria2/hy2, tuic

function b64decode(s) {
  s = String(s).trim().replace(/\s+/g, '').replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  return Buffer.from(s, 'base64').toString('utf8');
}

function safeDecode(s) {
  try { return decodeURIComponent(s); } catch { return s; }
}

const FINGERPRINTS = ['chrome', 'firefox', 'edge', 'safari', '360', 'qq', 'ios', 'android', 'random', 'randomized'];

function truthy(v) {
  return ['1', 'true', 'yes'].includes(String(v || '').toLowerCase());
}

function cleanHost(h) {
  return String(h || '').replace(/^\[/, '').replace(/\]$/, '');
}

function buildTls(q, host, defaultSec) {
  const sec = (q.get('security') || defaultSec || 'none').toLowerCase();
  if (sec === 'none' || sec === '') return undefined;
  const tls = {
    enabled: true,
    server_name: q.get('sni') || q.get('peer') || q.get('host') || host,
    insecure: truthy(q.get('allowInsecure')) || truthy(q.get('insecure')),
  };
  const alpn = q.get('alpn');
  if (alpn) tls.alpn = alpn.split(',').map((a) => a.trim()).filter(Boolean);
  let fp = (q.get('fp') || '').toLowerCase();
  if (fp) {
    if (!FINGERPRINTS.includes(fp)) fp = 'chrome';
    tls.utls = { enabled: true, fingerprint: fp };
  }
  if (sec === 'reality') {
    const pbk = q.get('pbk');
    if (!pbk) throw new Error('reality without public key');
    tls.reality = { enabled: true, public_key: pbk, short_id: q.get('sid') || '' };
    if (!tls.utls) tls.utls = { enabled: true, fingerprint: 'chrome' };
    delete tls.alpn;
  }
  return tls;
}

function splitPathEarlyData(path) {
  // "/path?ed=2560" -> { path: "/path", ed: 2560 }
  const i = path.indexOf('?');
  if (i < 0) return { path, ed: 0 };
  const base = path.slice(0, i);
  const qs = new URLSearchParams(path.slice(i + 1));
  const ed = parseInt(qs.get('ed') || '0', 10) || 0;
  qs.delete('ed');
  const rest = qs.toString();
  return { path: (base || '/') + (rest ? '?' + rest : ''), ed };
}

function buildTransport(q) {
  const type = (q.get('type') || q.get('net') || 'tcp').toLowerCase();
  const host = q.get('host') || '';
  const rawPath = q.get('path') || '/';
  switch (type) {
    case 'tcp':
    case 'raw':
    case '': {
      if ((q.get('headerType') || '').toLowerCase() === 'http') {
        return { type: 'http', method: 'GET', path: rawPath, host: host ? host.split(',') : [] };
      }
      return undefined;
    }
    case 'ws':
    case 'websocket': {
      const { path, ed } = splitPathEarlyData(rawPath);
      const t = { type: 'ws', path: path || '/' };
      if (host) t.headers = { Host: host };
      if (ed > 0) {
        t.max_early_data = ed;
        t.early_data_header_name = 'Sec-WebSocket-Protocol';
      }
      return t;
    }
    case 'grpc':
      return { type: 'grpc', service_name: q.get('serviceName') || q.get('path') || '' };
    case 'httpupgrade':
      return { type: 'httpupgrade', host, path: rawPath };
    case 'http':
    case 'h2':
      return { type: 'http', host: host ? host.split(',') : [], path: rawPath };
    default:
      throw new Error(`transport "${type}" is not supported by sing-box`);
  }
}

function describe(ob) {
  return {
    transport: ob.transport ? ob.transport.type : 'tcp',
    security: ob.tls ? (ob.tls.reality ? 'reality' : 'tls') : 'none',
  };
}

function parseStdUrl(uri) {
  const u = new URL(uri);
  const name = safeDecode((u.hash || '').slice(1));
  const host = cleanHost(u.hostname);
  const port = parseInt(u.port, 10);
  if (!host || !port) throw new Error('bad host/port');
  return { u, q: u.searchParams, name, host, port };
}

function parseVless(uri) {
  const { u, q, name, host, port } = parseStdUrl(uri);
  const ob = {
    type: 'vless',
    server: host,
    server_port: port,
    uuid: safeDecode(u.username),
    packet_encoding: 'xudp',
    tls: buildTls(q, host, 'none'),
    transport: buildTransport(q),
  };
  const flow = q.get('flow');
  if (flow) {
    if (flow !== 'xtls-rprx-vision') throw new Error('unsupported flow ' + flow);
    ob.flow = flow;
  }
  return { name, host, port, outbound: ob };
}

function parseTrojan(uri) {
  const { u, q, name, host, port } = parseStdUrl(uri);
  const ob = {
    type: 'trojan',
    server: host,
    server_port: port,
    password: safeDecode(u.username),
    tls: buildTls(q, host, 'tls'),
    transport: buildTransport(q),
  };
  return { name, host, port, outbound: ob };
}

function parseVmess(uri) {
  const body = uri.slice('vmess://'.length);
  const j = JSON.parse(b64decode(body.split('#')[0]));
  const q = new URLSearchParams();
  const set = (k, v) => { if (v !== undefined && v !== null && v !== '') q.set(k, String(v)); };
  set('security', j.tls === 'tls' || j.tls === 'reality' ? j.tls : 'none');
  set('sni', j.sni);
  set('alpn', j.alpn);
  set('fp', j.fp);
  set('pbk', j.pbk);
  set('sid', j.sid);
  set('allowInsecure', j.allowInsecure || j.insecure);
  set('type', j.net || 'tcp');
  set('host', j.host);
  set('path', j.path);
  set('headerType', j.type);
  if ((j.net || '') === 'grpc') set('serviceName', j.path);
  const host = cleanHost(j.add);
  const port = parseInt(j.port, 10);
  if (!host || !port) throw new Error('bad vmess host');
  const ob = {
    type: 'vmess',
    server: host,
    server_port: port,
    uuid: j.id,
    security: j.scy || 'auto',
    alter_id: parseInt(j.aid, 10) || 0,
    packet_encoding: 'xudp',
    tls: buildTls(q, host, 'none'),
    transport: buildTransport(q),
  };
  return { name: j.ps || '', host, port, outbound: ob };
}

function parseSS(uri) {
  let body = uri.slice('ss://'.length);
  let name = '';
  const hi = body.indexOf('#');
  if (hi >= 0) { name = safeDecode(body.slice(hi + 1)); body = body.slice(0, hi); }
  let query = '';
  const qi = body.indexOf('?');
  if (qi >= 0) { query = body.slice(qi + 1); body = body.slice(0, qi); }
  body = body.replace(/\/$/, '');
  if (!body.includes('@')) body = b64decode(body);
  const at = body.lastIndexOf('@');
  let userinfo = safeDecode(body.slice(0, at));
  const hostport = body.slice(at + 1);
  if (!userinfo.includes(':')) userinfo = b64decode(userinfo);
  const ci = userinfo.indexOf(':');
  const method = userinfo.slice(0, ci);
  const password = userinfo.slice(ci + 1);
  const m = hostport.match(/^\[?([^\]]+?)\]?:(\d+)$/);
  if (!m) throw new Error('bad ss host');
  const host = m[1];
  const port = parseInt(m[2], 10);
  const ob = { type: 'shadowsocks', server: host, server_port: port, method, password };
  const q = new URLSearchParams(query);
  const plugin = q.get('plugin');
  if (plugin) {
    const parts = safeDecode(plugin).split(';');
    const pname = parts.shift();
    if (!['obfs-local', 'v2ray-plugin'].includes(pname)) throw new Error('unsupported ss plugin');
    ob.plugin = pname;
    ob.plugin_opts = parts.join(';');
  }
  return { name, host, port, outbound: ob };
}

function parseHysteria2(uri) {
  const norm = uri.replace(/^hy2:\/\//i, 'hysteria2://');
  const { u, q, name, host, port } = parseStdUrl(norm);
  const auth = u.password ? `${safeDecode(u.username)}:${safeDecode(u.password)}` : safeDecode(u.username);
  const ob = {
    type: 'hysteria2',
    server: host,
    server_port: port,
    password: auth,
    tls: {
      enabled: true,
      server_name: q.get('sni') || host,
      insecure: truthy(q.get('insecure')) || truthy(q.get('allowInsecure')),
      alpn: (q.get('alpn') || 'h3').split(','),
    },
  };
  if ((q.get('obfs') || '') === 'salamander') {
    ob.obfs = { type: 'salamander', password: q.get('obfs-password') || '' };
  }
  return { name, host, port, outbound: ob, udp: true };
}

function parseTuic(uri) {
  const { u, q, name, host, port } = parseStdUrl(uri);
  const ob = {
    type: 'tuic',
    server: host,
    server_port: port,
    uuid: safeDecode(u.username),
    password: safeDecode(u.password),
    congestion_control: q.get('congestion_control') || 'bbr',
    udp_relay_mode: q.get('udp_relay_mode') || 'native',
    tls: {
      enabled: true,
      server_name: q.get('sni') || host,
      insecure: truthy(q.get('allow_insecure')) || truthy(q.get('insecure')) || truthy(q.get('allowInsecure')),
      alpn: (q.get('alpn') || 'h3').split(','),
    },
  };
  return { name, host, port, outbound: ob, udp: true };
}

function parseUri(line) {
  const scheme = line.split('://')[0].toLowerCase();
  let r;
  switch (scheme) {
    case 'vless': r = parseVless(line); break;
    case 'vmess': r = parseVmess(line); break;
    case 'trojan': r = parseTrojan(line); break;
    case 'ss': r = parseSS(line); break;
    case 'hysteria2':
    case 'hy2': r = parseHysteria2(line); break;
    case 'tuic': r = parseTuic(line); break;
    default: return null;
  }
  const d = describe(r.outbound);
  return {
    name: r.name || `${r.outbound.type} ${r.host}:${r.port}`,
    type: r.outbound.type,
    host: r.host,
    port: r.port,
    udp: !!r.udp,
    transport: r.udp ? 'quic' : d.transport,
    security: d.security,
    outbound: JSON.parse(JSON.stringify(r.outbound)), // strips undefined
    raw: line,
  };
}

function parseList(text) {
  let t = String(text || '').trim();
  if (!/:\/\//.test(t)) {
    try { const d = b64decode(t); if (/:\/\//.test(d)) t = d; } catch { /* not base64 */ }
  }
  const seen = new Set();
  const nodes = [];
  const errors = [];
  for (const raw of t.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || !line.includes('://')) continue;
    try {
      const n = parseUri(line);
      if (!n) continue;
      const key = JSON.stringify(n.outbound);
      if (seen.has(key)) continue;
      seen.add(key);
      nodes.push(n);
    } catch (e) {
      errors.push(`${line.slice(0, 40)}...: ${e.message}`);
    }
  }
  return { nodes, errors };
}

module.exports = { parseList, parseUri };
