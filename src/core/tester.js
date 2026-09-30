'use strict';
const net = require('net');

function tcpPing(host, port, timeout = 3000) {
  return new Promise((resolve) => {
    const t0 = process.hrtime.bigint();
    const s = net.connect({ host, port });
    let done = false;
    const fin = (v) => { if (done) return; done = true; s.destroy(); resolve(v); };
    s.setTimeout(timeout, () => fin(-1));
    s.on('connect', () => fin(Math.max(1, Math.round(Number(process.hrtime.bigint() - t0) / 1e6))));
    s.on('error', () => fin(-1));
  });
}

// TCP handshake latency for every node (UDP protocols are skipped; they are tested by sing-box).
async function tcpPingAll(nodes, onEach, concurrency = 24) {
  let i = 0;
  const worker = async () => {
    while (i < nodes.length) {
      const n = nodes[i++];
      if (n.udp) { n.latency = null; if (onEach) onEach(n); continue; }
      let best = -1;
      for (let k = 0; k < 2; k++) {
        const v = await tcpPing(n.host, n.port);
        if (v > 0 && (best < 0 || v < best)) best = v;
        if (v < 0) break;
      }
      n.latency = best;
      if (onEach) onEach(n);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, nodes.length) }, worker));
}

module.exports = { tcpPing, tcpPingAll };
