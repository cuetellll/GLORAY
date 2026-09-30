'use strict';
const { contextBridge, ipcRenderer } = require('electron');

const INVOKE = ['init', 'subs:update', 'nodes:test', 'vpn:connect', 'vpn:disconnect', 'vpn:select',
  'settings:set', 'app:relaunchAdmin', 'app:openData', 'win:min', 'win:max', 'win:close', 'app:quit'];
const EVENTS = ['status', 'nodes', 'current', 'traffic', 'log', 'core'];

contextBridge.exposeInMainWorld('api', {
  invoke: (ch, ...args) => (INVOKE.includes(ch) ? ipcRenderer.invoke(ch, ...args) : Promise.reject(new Error('blocked'))),
  on: (ch, cb) => { if (EVENTS.includes(ch)) ipcRenderer.on(ch, (_, d) => cb(d)); },
});
