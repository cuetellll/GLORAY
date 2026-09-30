'use strict';
const http = require('http');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Minimal client for sing-box's Clash-compatible API.
class ClashApi {
  constructor(port, secret) { this.port = port; this.secret = secret; this.streams = []; }

  headers(extra = {}) { return { Authorization: `Bearer ${this.secret}`, ...extra }; }

  req(method, p, body, timeout = 8000) {
    return new Promise((resolve, reject) => {
      const data = body ? JSON.stringify(body) : null;
      const r = http.request({
        host: '127.0.0.1', port: this.port, path: p, method, timeout,
        headers: this.headers(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}),
      }, (resp) => {
        let s = '';
        resp.setEncoding('utf8');
        resp.on('data', (c) => { s += c; });
        resp.on('end', () => {
          if (resp.statusCode >= 400) return reject(new Error(`API ${resp.statusCode}: ${s}`));
          try { resolve(s ? JSON.parse(s) : {}); } catch { resolve({}); }
        });
      });
      r.on('timeout', () => r.destroy(new Error('timeout')));
      r.on('error', reject);
      if (data) r.write(data);
      r.end();
    });
  }

  get(p, t) { return this.req('GET', p, null, t); }
  put(p, b) { return this.req('PUT', p, b); }

  async waitReady(ms, alive) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (alive && !alive()) throw new Error('sing-box متوقف شد (لاگ را ببینید)');
      try { await this.get('/version', 1500); return; } catch { /* retry */ }
      await sleep(300);
    }
    throw new Error('هسته sing-box پاسخ نداد');
  }

  groupDelay(group, url, timeout = 5000) {
    return this.get(`/group/${encodeURIComponent(group)}/delay?url=${encodeURIComponent(url)}&timeout=${timeout}`, 120000);
  }

  select(group, name) { return this.put(`/proxies/${encodeURIComponent(group)}`, { name }); }

  stream(p, onObj) {
    const r = http.get({ host: '127.0.0.1', port: this.port, path: p, headers: this.headers() }, (resp) => {
      let buf = '';
      resp.setEncoding('utf8');
      resp.on('data', (c) => {
        buf += c;
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i).trim();
          buf = buf.slice(i + 1);
          if (line) { try { onObj(JSON.parse(line)); } catch { /* ignore */ } }
        }
      });
    });
    r.on('error', () => {});
    this.streams.push(r);
    return r;
  }

  close() { this.streams.forEach((s) => { try { s.destroy(); } catch { /* */ } }); this.streams = []; }
}

module.exports = { ClashApi };
