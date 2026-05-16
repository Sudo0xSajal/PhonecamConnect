/**
 * PhoneCam Connect — Preload Script
 *
 * Security architecture:
 *   - contextIsolation: true  → renderer has ZERO access to Node.js APIs
 *   - nodeIntegration: false  → require() not available in renderer
 *   - contextBridge.exposeInMainWorld() → explicitly chosen, named API only
 *   - Channel whitelist → unknown IPC channels are rejected before reaching main
 *   - URL validation → openExternal only allows known HTTPS domains
 *
 * IMPORTANT: main.js BrowserWindow must have:
 *   contextIsolation: true
 *   nodeIntegration: false
 *   (remove webSecurity: false)
 */
'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// ── Whitelisted IPC channels ──────────────────────────────────────────────────
const INVOKE_CHANNELS = new Set([
  'get-app-info', 'get-qr-code',
  'vcam-start', 'vcam-stop', 'vcam-status', 'vcam-set-source', 'use-as-webcam',
  'driver-uninstall', 'driver-status', 'driver-diagnose',
  'phones-list', 'phone-set-quality', 'phone-set-active',
  'phone-command', 'phone-disconnect',
  'setup-get-status', 'setup-run-step',
  'save-dialog',
]);

const LISTEN_CHANNELS = new Set([
  'video-frame', 'driver-status-changed', 'phone-connected',
  'phone-disconnected', 'phone-settings-changed', 'vcam-status',
  'resolution-changed', 'setup-log',
]);

// ── URL validator for openExternal ────────────────────────────────────────────
const ALLOWED_ORIGINS = [
  'https://phonecam.app',
  'https://github.com',
];
function isSafeUrl(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && ALLOWED_ORIGINS.some(o => u.origin === o);
  } catch { return false; }
}

// ── Expose API to renderer via contextBridge ──────────────────────────────────
contextBridge.exposeInMainWorld('phonecam', {

  // ── App Info ──────────────────────────────────────────────────────────────
  getAppInfo: ()     => ipcRenderer.invoke('get-app-info'),
  getQRCode:  (opts) => ipcRenderer.invoke('get-qr-code', opts),

  // ── Window Controls ───────────────────────────────────────────────────────
  minimize: () => ipcRenderer.send('window-minimize'),
  maximize: () => ipcRenderer.send('window-maximize'),
  close:    () => ipcRenderer.send('window-close'),
  hide:     () => ipcRenderer.send('window-hide'),

  // ── Virtual Webcam ────────────────────────────────────────────────────────
  vcamStart:     (opts) => ipcRenderer.invoke('vcam-start',      opts),
  vcamStop:      ()     => ipcRenderer.invoke('vcam-stop'),
  vcamStatus:    ()     => ipcRenderer.invoke('vcam-status'),
  vcamSetSource: (id)   => ipcRenderer.invoke('vcam-set-source', { socketId: id }),
  useAsWebcam:   (id, res, fps) =>
    ipcRenderer.invoke('use-as-webcam', { socketId: id, resolution: res, fps }),

  // ── Native Driver (Windows DirectShow) ───────────────────────────────────
  // Install is via website download — only uninstall/status/diagnose in app
  driverUninstall: ()     => ipcRenderer.invoke('driver-uninstall'),
  driverStatus:    (opts) => ipcRenderer.invoke('driver-status',  opts || {}),
  driverDiagnose:  ()     => ipcRenderer.invoke('driver-diagnose'),

  // ── Phone Management ──────────────────────────────────────────────────────
  phonesList:      ()                           => ipcRenderer.invoke('phones-list'),
  phoneSetQuality: (socketId, res, fps, qual)   => ipcRenderer.invoke('phone-set-quality',
    { socketId, resolution: res, fps, quality: qual }),
  phoneSetActive:  (socketId)                   => ipcRenderer.invoke('phone-set-active', { socketId }),
  phoneCommand:    (socketId, command, payload) => ipcRenderer.invoke('phone-command',
    { socketId, command, payload }),
  phoneDisconnect: (socketId)                   => ipcRenderer.invoke('phone-disconnect', { socketId }),

  // ── Setup Wizard ──────────────────────────────────────────────────────────
  setupGetStatus: ()            => ipcRenderer.invoke('setup-get-status'),
  setupRunStep:   (stepId, cmd) => ipcRenderer.invoke('setup-run-step', { stepId, installCmd: cmd }),

  // ── Events (typed subscriptions — no raw channel access) ─────────────────
  onVideoFrame:           (cb) => ipcRenderer.on('video-frame',            (_, d) => cb(d)),
  onDriverStatusChanged:  (cb) => ipcRenderer.on('driver-status-changed',  (_, d) => cb(d)),
  onPhoneConnected:       (cb) => ipcRenderer.on('phone-connected',        (_, d) => cb(d)),
  onPhoneDisconnected:    (cb) => ipcRenderer.on('phone-disconnected',     (_, d) => cb(d)),
  onPhoneSettingsChanged: (cb) => ipcRenderer.on('phone-settings-changed', (_, d) => cb(d)),
  onVcamStatus:           (cb) => ipcRenderer.on('vcam-status',            (_, d) => cb(d)),
  onResolutionChanged:    (cb) => ipcRenderer.on('resolution-changed',     (_, d) => cb(d)),
  onSetupLog:             (cb) => ipcRenderer.on('setup-log',              (_, d) => cb(d)),

  // ── Safe channel access (whitelisted) ────────────────────────────────────
  invoke: (channel, ...args) => {
    if (!INVOKE_CHANNELS.has(channel))
      return Promise.reject(new Error('IPC channel not allowed: ' + channel));
    return ipcRenderer.invoke(channel, ...args);
  },
  on: (channel, cb) => {
    if (!LISTEN_CHANNELS.has(channel)) return;
    ipcRenderer.on(channel, (_, data) => cb(data));
  },

  // ── System ────────────────────────────────────────────────────────────────
  // openExternal: validates URL before passing to shell — blocks file:// and unknown domains
  openExternal:   (url) => {
    if (!isSafeUrl(url)) {
      console.warn('[Preload] Blocked unsafe URL:', url);
      return;
    }
    ipcRenderer.send('open-external', url);
  },
  showSaveDialog: (opts) => ipcRenderer.invoke('save-dialog', opts),

  removeAllListeners: (channel) => {
    if (LISTEN_CHANNELS.has(channel)) ipcRenderer.removeAllListeners(channel);
  },
});

console.log('[Preload] contextBridge API ready');