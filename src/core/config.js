'use strict';
const path = require('path');

const TEST_URL = 'https://www.gstatic.com/generate_204';

// Builds a sing-box (1.12+) configuration.
function buildConfig({ nodes, mode, selectedTag, mixedPort, apiPort, secret, bypassIran, dataDir }) {
  const tags = nodes.map((n) => n.tag);

  const outbounds = [
    {
      type: 'selector',
      tag: 'proxy',
      outbounds: ['auto', ...tags],
      default: selectedTag || 'auto',
      interrupt_exist_connections: true,
    },
    {
      type: 'urltest',
      tag: 'auto',
      outbounds: tags,
      url: TEST_URL,
      interval: '3m',
      tolerance: 80,
      interrupt_exist_connections: true,
    },
    ...nodes.map((n) => ({ ...n.outbound, tag: n.tag })),
    { type: 'direct', tag: 'direct' },
  ];

  const inbounds = [
    { type: 'mixed', tag: 'mixed-in', listen: '127.0.0.1', listen_port: mixedPort },
  ];
  if (mode === 'tun') {
    inbounds.push({
      type: 'tun',
      tag: 'tun-in',
      interface_name: 'GlowRayTun',
      address: ['172.19.0.1/30'],
      mtu: 9000,
      auto_route: true,
      strict_route: true,
      stack: 'mixed',
    });
  }

  const dns = {
    servers: [
      { type: 'https', tag: 'dns-remote', server: '1.1.1.1', detour: 'proxy' },
      { type: 'local', tag: 'dns-local' },
    ],
    rules: [],
    final: 'dns-remote',
    strategy: 'ipv4_only',
  };

  const route = {
    rules: [
      { action: 'sniff' },
      { protocol: 'dns', action: 'hijack-dns' },
      { ip_is_private: true, outbound: 'direct' },
    ],
    final: 'proxy',
    auto_detect_interface: true,
    default_domain_resolver: { server: 'dns-local' },
  };

  if (bypassIran) {
    route.rule_set = [
      {
        tag: 'geoip-ir', type: 'remote', format: 'binary',
        url: 'https://raw.githubusercontent.com/Chocolate4U/Iran-sing-box-rules/rule-set/geoip-ir.srs',
        download_detour: 'proxy',
      },
      {
        tag: 'geosite-ir', type: 'remote', format: 'binary',
        url: 'https://raw.githubusercontent.com/Chocolate4U/Iran-sing-box-rules/rule-set/geosite-ir.srs',
        download_detour: 'proxy',
      },
    ];
    route.rules.push({ domain_suffix: ['.ir'], outbound: 'direct' });
    route.rules.push({ rule_set: ['geosite-ir', 'geoip-ir'], outbound: 'direct' });
    dns.rules.push({ domain_suffix: ['.ir'], server: 'dns-local' });
    dns.rules.push({ rule_set: ['geosite-ir'], server: 'dns-local' });
  }

  return {
    log: { level: 'info', timestamp: true },
    dns,
    inbounds,
    outbounds,
    route,
    experimental: {
      clash_api: { external_controller: `127.0.0.1:${apiPort}`, secret },
      cache_file: { enabled: true, path: path.join(dataDir, 'cache.db') },
    },
  };
}

module.exports = { buildConfig, TEST_URL, OUTBOUND_OFFSET: 2 };
