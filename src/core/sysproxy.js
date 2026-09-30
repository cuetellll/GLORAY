'use strict';
const { execFile } = require('child_process');
const fs = require('fs');

const KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';
const BYPASS = 'localhost;127.*;10.*;172.16.*;172.17.*;172.18.*;172.19.*;172.20.*;172.21.*;172.22.*;172.23.*;172.24.*;172.25.*;172.26.*;172.27.*;172.28.*;172.29.*;172.30.*;172.31.*;192.168.*;<local>';

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { windowsHide: true, timeout: 20000 }, (e, so, se) => (e ? reject(new Error(se || e.message)) : resolve(so)));
  });
}

const reg = (args) => run('reg', args);

// Tell WinINet (browsers, most apps) that the proxy settings changed.
function refresh() {
  const script = [
    "$sig='[DllImport(\"wininet.dll\", SetLastError=true)] public static extern bool InternetSetOption(IntPtr h, int o, IntPtr b, int l);'",
    '$t=Add-Type -MemberDefinition $sig -Name WinInet -Namespace GlowRay -PassThru',
    '[void]$t::InternetSetOption([IntPtr]::Zero,39,[IntPtr]::Zero,0)',
    '[void]$t::InternetSetOption([IntPtr]::Zero,37,[IntPtr]::Zero,0)',
  ].join(';');
  return run('powershell', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script]).catch(() => {});
}

async function enable(port) {
  await reg(['add', KEY, '/v', 'ProxyServer', '/t', 'REG_SZ', '/d', `127.0.0.1:${port}`, '/f']);
  await reg(['add', KEY, '/v', 'ProxyOverride', '/t', 'REG_SZ', '/d', BYPASS, '/f']);
  await reg(['add', KEY, '/v', 'ProxyEnable', '/t', 'REG_DWORD', '/d', '1', '/f']);
  await refresh();
}

async function disable() {
  await reg(['add', KEY, '/v', 'ProxyEnable', '/t', 'REG_DWORD', '/d', '0', '/f']).catch(() => {});
  await refresh();
}

// If the app crashed while the system proxy was on, turn it off on next start.
async function cleanupStale(lockPath) {
  if (!fs.existsSync(lockPath)) return;
  await disable();
  try { fs.unlinkSync(lockPath); } catch { /* */ }
}

function isAdmin() {
  return new Promise((resolve) => execFile('net', ['session'], { windowsHide: true }, (e) => resolve(!e)));
}

module.exports = { enable, disable, cleanupStale, isAdmin };
