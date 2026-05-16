// Manual uninstall — uses getSys32() from vcam-pipe for correct backslash paths

function _manualUninstall(callback, log) {
  const sys32 = getWinSys32();
  // Use string concat — NEVER path.join() for Windows paths (produces mixed slashes)
  const steps = [
    'cmd /c regsvr32.exe /s /u "' + sys32 + '\\PhoneCamFilter.dll" 2>nul',
    'cmd /c del /f /q "'           + sys32 + '\\PhoneCamFilter.dll" 2>nul',
    'cmd /c del /f /q "'           + sys32 + '\\turbojpeg.dll" 2>nul',
    'cmd /c del /f /q "'           + sys32 + '\\PhoneCamDriverUninstall.exe" 2>nul',
  ];
  for (const cmd of steps) {
    try { execSync(cmd, { stdio: ['pipe','pipe','pipe'], timeout: 5000, windowsHide: true }); }
    catch { /* file may not exist or be locked — continue */ }
  }
  if (log) log('   Manual cleanup complete\n');
  setTimeout(callback, 500);
}
/**
 * PhoneCam Connect — Desktop Main Process (Electron)
 *
 * Virtual Camera priority (Windows):
 *   1. PhoneCam DirectShow driver  → "PhoneCam Connect" in Zoom/Meet/Teams natively
 *   2. FFmpeg → named pipe         → OBS Media Source fallback
 *   3. MJPEG HTTP :7781/stream     → OBS Browser Source (always-on, all platforms)
 *
 * Virtual Camera (Linux):
 *   1. FFmpeg → /dev/video10 (v4l2loopback)
 *   2. MJPEG fallback
 */

const {
  app, BrowserWindow, Tray, Menu, ipcMain,
  nativeImage, shell, dialog, systemPreferences
} = require('electron');
const path  = require('path');
const os    = require('os');
const fs    = require('fs');
const http  = require('http');
const { spawn, exec, execSync } = require('child_process');
const { WebSocketServer } = require('ws');
const express = require('express');
const QRCode  = require('qrcode');

// ── Native driver pipe (Windows only — safe no-op on Linux/macOS) ─────────────
const vcamPipe = require('./vcam-pipe');

// ── Global crash protection ───────────────────────────────────────────────────
process.on('uncaughtException', (err) => {
  const msg  = err.message || '';
  const code = err.code    || '';

  // Suppress harmless pipe errors — these are normal when phone/driver disconnects
  if (msg.includes('write EOF') || msg.includes('EPIPE') || msg.includes('ECONNRESET') ||
      code === 'EPIPE' || code === 'ECONNRESET') {
    console.warn('[Main] Suppressed pipe error:', msg);
    if (virtualWebcamActive) {
      webcamProcess = null;
      mainWindow?.webContents.send('vcam-status', { active: true, mode: 'mjpeg',
        device: 'MJPEG stream (pipe reconnecting)',
        mjpegUrl: `http://localhost:${MJPEG_PORT}/stream` });
    }
    return;
  }
  // Log all other uncaught exceptions with full context
  console.error('[Main] UNCAUGHT EXCEPTION:', err.stack || err.message);
  console.error('[Main] App version:', app?.getVersion?.() || 'unknown');
  console.error('[Main] Platform:', process.platform, process.arch);
  console.error('[Main] Node:', process.version);
  // Show dialog in dev mode only — in production, log silently
  if (process.argv.includes('--dev') || process.env.NODE_ENV === 'development') {
    dialog.showErrorBox('Unexpected Error', err.stack || err.message);
  }
});

process.on('unhandledRejection', (reason) => {
  console.warn('[Main] Unhandled promise rejection:', reason);
});

// ─── App State ─────────────────────────────────────────────────────────────
let mainWindow         = null;
let tray               = null;
let wss                = null;
let httpServer         = null;
let connectedPhones    = new Map();  // socketId → { socket, deviceName, resolution, fps }
let virtualWebcamActive = false;
const PORT_WS   = 7779;
const PORT_HTTP = 7780;
const MJPEG_PORT = 7781;
const isDev     = process.argv.includes('--dev');

// ─── Get Local IP ───────────────────────────────────────────────────────────
function getLocalIP() {
  const interfaces = os.networkInterfaces();
  const skipPatterns = [
    /vmware/i, /virtualbox/i, /vbox/i, /docker/i, /^br-/i, /^veth/i,
    /hyper-v/i, /vEthernet/i, /^tun/i, /^tap/i, /^utun/i,
    /loopback/i, /pseudo/i, /teredo/i, /isatap/i,
  ];
  const wifiPatterns     = [/wi.?fi/i, /wlan/i, /wireless/i, /airport/i, /802\.11/i];
  const ethernetPatterns = [/^eth/i, /^en\d/i, /ethernet/i, /local area/i, /^eno/i, /^enp/i];
  const candidates = [];

  for (const [name, addrs] of Object.entries(interfaces)) {
    if (skipPatterns.some(p => p.test(name))) continue;
    for (const iface of addrs) {
      if (iface.family !== 'IPv4' || iface.internal) continue;
      if (iface.address.startsWith('169.254.') || iface.address.startsWith('0.')) continue;
      let priority = 1;
      if (wifiPatterns.some(p => p.test(name)))          priority = 3;
      else if (ethernetPatterns.some(p => p.test(name))) priority = 2;
      candidates.push({ address: iface.address, name, priority });
    }
  }

  if (candidates.length === 0) {
    console.warn('[IP] No suitable interface found, falling back to 127.0.0.1');
    return '127.0.0.1';
  }
  candidates.sort((a, b) => b.priority - a.priority);
  const best = candidates[0];
  console.log(`[IP] Using "${best.name}" → ${best.address}`);
  return best.address;
}

let _cachedIP = null, _ipCacheTime = 0;
function getLocalIPCached() {
  const now = Date.now();
  if (!_cachedIP || now - _ipCacheTime > 30_000) {
    _cachedIP    = getLocalIP();
    _ipCacheTime = now;
  }
  return _cachedIP;
}

// ─── Create Main Window ─────────────────────────────────────────────────────
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280, height: 820, minWidth: 900, minHeight: 600,
    frame: false, transparent: false, backgroundColor: '#0F0E0C',
    webPreferences: {
      preload:              path.join(__dirname, 'preload.js'),
      contextIsolation:     true,   // renderer has no Node.js access
      nodeIntegration:      false,  // require() not available in renderer
      webSecurity:          true,   // enforce SOP
      sandbox:              false,  // preload needs Node (contextBridge only)
      allowRunningInsecureContent: false,
      experimentalFeatures: false,
    },
    icon: path.join(__dirname, '..', 'assets', 'icon.png'),
    show: false,
  });
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  // Suppress harmless "Autofill.enable" DevTools Protocol noise in Electron 29.
  // Chrome DevTools tries to call this CDP command but Electron doesn't implement it.
  // Has zero effect on functionality — purely cosmetic console suppression.
  mainWindow.webContents.on('devtools-opened', () => {
    mainWindow.webContents.executeJavaScript(`
      (() => {
        const orig = console.error.bind(console);
        console.error = (...args) => {
          if (args[0] && String(args[0]).includes('Autofill.enable')) return;
          orig(...args);
        };
      })();
    `).catch(() => {});
  });

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    if (isDev) mainWindow.webContents.openDevTools();
  });
  mainWindow.on('close', () => { app.isQuitting = true; app.quit(); });
  return mainWindow;
}

// ─── System Tray ────────────────────────────────────────────────────────────
function createTray() {
  const iconPath = path.join(__dirname, '..', 'assets', 'tray-icon.png');
  tray = new Tray(nativeImage.createFromPath(iconPath).resize({ width: 16, height: 16 }));

  const updateMenu = () => {
    const phoneList = [...connectedPhones.values()].map(p =>
      ({ label: `📱 ${p.deviceName} — ${p.resolution} @ ${p.fps}fps`, enabled: false }));
    const driverStr = vcamPipe.isDriverConnected()
      ? '✅ Native Driver Active'
      : virtualWebcamActive ? '✅ MJPEG Stream Active' : '⚫ Virtual Webcam Off';

    tray.setContextMenu(Menu.buildFromTemplate([
      { label: 'PhoneCam Connect', enabled: false },
      { type: 'separator' },
      ...(phoneList.length ? phoneList : [{ label: 'No phones connected', enabled: false }]),
      { type: 'separator' },
      { label: 'Open Dashboard', click: () => { mainWindow.show(); mainWindow.focus(); } },
      { label: driverStr, enabled: false },
      { type: 'separator' },
      { label: 'Quit PhoneCam', click: () => app.quit() },
    ]));
  };

  tray.setToolTip('PhoneCam Connect');
  tray.on('double-click', () => { mainWindow.show(); mainWindow.focus(); });
  updateMenu();
  global.updateTrayMenu = updateMenu;
}

// ─── Phone Connection Handler ────────────────────────────────────────────────
function handlePhoneConnection(socket, req) {
  const socketId    = `phone_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  let handshakeDone = false;
  let phoneInfo     = { deviceName: 'Unknown Phone', resolution: '1920x1080', fps: 30 };
  console.log(`[WS] Phone connected: ${socketId} from ${req.socket.remoteAddress}`);

  socket.on('message', (data) => {
    const buf    = Buffer.isBuffer(data) ? data : Buffer.from(data);
    const isJpeg = buf.length > 3 && buf[0] === 0xFF && buf[1] === 0xD8;

    if (isJpeg) {
      if (!handshakeDone) {
        handshakeDone = true;
        connectedPhones.set(socketId, { socket, ...phoneInfo });
        mainWindow?.webContents.send('phone-connected', { socketId, ...phoneInfo });
        global.updateTrayMenu?.();
        // Start streaming with default resolution — will restart when handshake arrives
        // with correct phone resolution (see handshake handler below)
        if (!virtualWebcamActive) {
          const [w, h] = (phoneInfo.resolution || '1920x1080').split('x');
          _autoStartStreaming(phoneInfo.fps || 30, w || '1920', h || '1080', socketId);
        }
      }
      pushFrameToVirtualWebcam(buf, socketId);
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('video-frame', {
          socketId,
          data: buf.toString('base64')
        });
      }
      return;
    }

    let msg;
    try { msg = JSON.parse(buf.toString()); } catch { return; }
    console.log('[WS] JSON:', msg.type);

    if (msg.type === 'handshake') {
      phoneInfo = {
        deviceName:   msg.deviceName   || 'Android Phone',
        resolution:   msg.resolution   || '1920x1080',
        fps:          msg.fps          || 30,
        batteryLevel: msg.batteryLevel != null ? Number(msg.batteryLevel) : null,
      };
      handshakeDone = true;
      connectedPhones.set(socketId, { socket, ...phoneInfo });
      socket.send(JSON.stringify({ type: 'handshake_ack', sessionId: socketId }));
      mainWindow?.webContents.send('phone-connected', { socketId, ...phoneInfo });
      global.updateTrayMenu?.();
      console.log(`[WS] ✅ Handshake: ${phoneInfo.deviceName} (${phoneInfo.resolution}@${phoneInfo.fps}fps)`);
      if (!virtualWebcamActive) {
        const [w, h] = (phoneInfo.resolution || '1920x1080').split('x');
        _autoStartStreaming(phoneInfo.fps || 30, w || '1920', h || '1080', socketId);
      }
    } else if (msg.type === 'ping') {
      socket.send(JSON.stringify({ type: 'pong' }));
    } else if (msg.type === 'settings_change') {
      if (connectedPhones.has(socketId)) {
        const p = connectedPhones.get(socketId);
        const resChanged = msg.resolution && msg.resolution !== p.resolution;
        const fpsChanged = msg.fps        && parseInt(msg.fps) !== parseInt(p.fps);
        p.resolution   = msg.resolution || p.resolution;
        p.fps          = msg.fps        || p.fps;
        p.quality      = msg.quality    || p.quality || 85;
        p.batteryLevel = msg.batteryLevel != null ? Number(msg.batteryLevel) : p.batteryLevel;
        connectedPhones.set(socketId, p);
        // Push to renderer — triggers full UI sync
        mainWindow?.webContents.send('phone-settings-changed', { socketId, ...p });
        // Restart pipeline if resolution/fps actually changed
        if (resChanged || fpsChanged) {
          _applyResolutionChange(socketId, p.resolution, p.fps);
        }
      }
    } else if (msg.type === 'battery_update') {
      if (connectedPhones.has(socketId)) {
        const p = connectedPhones.get(socketId);
        p.batteryLevel = Number(msg.level);
        connectedPhones.set(socketId, p);
        mainWindow?.webContents.send('phone-settings-changed', { socketId, ...p });
      }
    }
  });

  // ── Heartbeat: detect dead connections ─────────────────────────────────
  socket.isAlive = true;
  socket.on('pong', () => { socket.isAlive = true; });

  const heartbeat = setInterval(() => {
    if (!socket.isAlive) {
      console.log(`[WS] Heartbeat timeout: ${socketId}`);
      clearInterval(heartbeat);
      socket.terminate();
      return;
    }
    socket.isAlive = false;
    try { socket.ping(); } catch (_) {}
  }, 10000); // ping every 10s

  socket.on('close', () => {
    clearInterval(heartbeat);
    console.log(`[WS] Phone disconnected: ${socketId}`);
    connectedPhones.delete(socketId);
    // If this was active source, auto-switch to next phone
    if (activeWebcamSourceId === socketId) {
      const next = [...connectedPhones.keys()][0] || null;
      setWebcamSource(next);
      mainWindow?.webContents.send('vcam-status', {
        active: next ? virtualWebcamActive : false,
        activeSource: next,
        mjpegUrl: `http://localhost:${MJPEG_PORT}/stream`,
        driverInstalled: process.platform === 'win32' ? vcamPipe.isDriverInstalled() : false,
        driverConnected: false,
      });
    }
    mainWindow?.webContents.send('phone-disconnected', { socketId });
    global.updateTrayMenu?.();
  });

  socket.on('error', err => {
    clearInterval(heartbeat);
    console.error(`[WS] Socket error (${socketId}):`, err.message);
  });
}

// ── Auto-start on first phone connect ─────────────────────────────────────────
function _autoStartStreaming(fps, w, h, socketId) {
  // Set the first phone as the active webcam source
  if (socketId && !activeWebcamSourceId) {
    setWebcamSource(socketId);
    // Notify renderer of the active source
    mainWindow?.webContents.send('vcam-status', {
      active:          false,
      activeSource:    activeWebcamSourceId,
      mjpegUrl:        `http://localhost:${MJPEG_PORT}/stream`,
      driverInstalled: process.platform === 'win32' ? vcamPipe.isDriverInstalled() : false,
      driverConnected: false,
      mode:            null,
    });
  }
  // Always start MJPEG (zero-dependency, works everywhere)
  startMjpegServer(fps, w, h);
  // On Windows, also start native driver pipe if installed
  if (process.platform === 'win32') {
    _tryStartNativePipe();
  }
}

// ── Apply resolution change — restarts MJPEG + vcam pipeline ─────────────────
// Called when resolution/fps changes from: quality modal, dropdown, broadcastSetting
// or when mobile sends settings_change back
function _applyResolutionChange(socketId, resolution, fps) {
  // Only apply if this phone is the active webcam source
  if (socketId && socketId !== activeWebcamSourceId) return;

  const [w, h] = (resolution || '1920x1080').split('x');
  const f      = parseInt(fps) || 30;

  console.log(`[Resolution] Applying ${resolution}@${f}fps for ${socketId}`);

  // Restart MJPEG server with new resolution
  startMjpegServer(f, w, h);

  // If vcam is active, restart it too
  if (virtualWebcamActive) {
    stopVirtualWebcam();
    setTimeout(() => startVirtualWebcam(resolution, f), 300);
  }

  // Notify renderer of the resolution change so ALL UI elements update
  mainWindow?.webContents.send('resolution-changed', {
    socketId, resolution, fps: f,
    w: parseInt(w), h: parseInt(h),
  });
}

// ─── WebSocket + HTTP Server ────────────────────────────────────────────────
function startWebSocketServer() {
  const expressApp = express();

  // /obsview — clean MJPEG page for OBS Browser Source
  expressApp.get('/obsview', (req, res) => {
    res.send(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>PhoneCam</title>
<style>*{margin:0;padding:0}html,body{width:100%;height:100%;background:#000;overflow:hidden}
img{width:100%;height:100%;object-fit:contain}</style></head><body>
<img id="s" src="http://localhost:${MJPEG_PORT}/stream">
<script>const i=document.getElementById('s');i.onerror=()=>setTimeout(()=>{i.src='http://localhost:${MJPEG_PORT}/stream?t='+Date.now()},2000);</script>
</body></html>`);
  });

  // Discovery page — phone browser opens this after QR scan
  expressApp.get('/', (req, res) => {
    const ip    = getLocalIPCached();
    const wsUrl = `ws://${ip}:${PORT_WS}`;
    res.send(`<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>PhoneCam Connect — Server Running</title>
<style>*{box-sizing:border-box;margin:0;padding:0}
body{background:#0F0E0C;color:#F0EDE6;font-family:system-ui,sans-serif;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px}
.card{background:#161512;border:1px solid #2A2721;border-radius:20px;padding:32px 28px;max-width:360px;width:100%;text-align:center}
.badge{display:inline-flex;align-items:center;gap:8px;background:#16C78418;color:#16C784;border:1px solid #16C78440;border-radius:20px;padding:6px 14px;font-size:13px;font-weight:600;margin-bottom:20px}
.dot{width:8px;height:8px;border-radius:50%;background:#16C784;animation:pulse 1.5s infinite}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.4}}
h1{font-size:20px;font-weight:800;margin-bottom:6px}
.sub{color:#9A9080;font-size:13.5px;margin-bottom:24px;line-height:1.5}
.url-box{background:#0F0E0C;border:1px solid #342F28;border-radius:10px;padding:12px 14px;font-family:monospace;font-size:13px;color:#1B6FEB;word-break:break-all;margin-bottom:20px;text-align:left}
.url-label{font-size:11px;color:#5A5248;text-transform:uppercase;letter-spacing:.06em;margin-bottom:4px}
.stat{display:flex;justify-content:space-between;padding:10px 0;border-top:1px solid #2A2721;font-size:13.5px}
.stat-val{font-weight:700;color:#1B6FEB;font-family:monospace}
.stat-val.green{color:#16C784}
.footer{margin-top:20px;font-size:12px;color:#5A5248;line-height:1.6}
</style></head><body><div class="card">
<div class="badge"><span class="dot"></span> Server is Running</div>
<h1>PhoneCam Connect</h1>
<p class="sub">Open the PhoneCam app → tap <strong style="color:#F0EDE6">Scan QR Code</strong> or enter address below manually.</p>
<div class="url-box"><div class="url-label">WebSocket Address</div>${wsUrl}</div>
<div class="stat"><span>Status</span><span class="stat-val green">&#9679; Online</span></div>
<div class="stat"><span>Phones Connected</span><span class="stat-val">${connectedPhones.size}</span></div>
<div class="stat"><span>WebSocket Port</span><span class="stat-val">${PORT_WS}</span></div>
<p class="footer">Keep PhoneCam desktop open while streaming.</p>
</div></body></html>`);
  });

  httpServer = http.createServer(expressApp);
  httpServer.listen(PORT_HTTP, '0.0.0.0', () => {
    console.log(`[HTTP] Discovery page: http://${getLocalIPCached()}:${PORT_HTTP}`);
  });

  wss = new WebSocketServer({ port: PORT_WS, host: '0.0.0.0' });
  wss.on('connection', handlePhoneConnection);
  wss.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`[WS] Port ${PORT_WS} already in use! Close other apps using this port.`);
      mainWindow?.webContents.send('app-error', {
        title: 'Port Conflict',
        message: `Port ${PORT_WS} is already in use.\nClose any other app using this port and restart PhoneCam Connect.`
      });
    } else {
      console.error('[WS] Server error:', err.message);
    }
  });
  console.log(`[WS] Listening on ws://${getLocalIPCached()}:${PORT_WS}`);
}

// ─── Active webcam source ──────────────────────────────────────────────────
// Only frames from this socketId are routed to the virtual camera outputs.
// null = use any/first connected phone (legacy behaviour).
let activeWebcamSourceId = null;

// Called from IPC 'vcam-set-source', 'use-as-webcam', and on phone disconnect
// Notifies renderer and restarts resolution pipeline when switching phones
function setWebcamSource(socketId) {
  const prev = activeWebcamSourceId;
  activeWebcamSourceId = socketId || null;
  console.log('[VCam] Active source:', prev, '→', activeWebcamSourceId || '(none)');

  // When switching to a different phone, restart pipeline with new phone's resolution
  if (socketId && socketId !== prev && connectedPhones.has(socketId)) {
    const phone = connectedPhones.get(socketId);
    if (phone) {
      // Restart MJPEG/vcam with this phone's resolution + fps
      const [w, h] = (phone.resolution || '1920x1080').split('x');
      startMjpegServer(parseInt(phone.fps) || 30, w, h);
    }
  }

  // Always notify renderer of the source change
  mainWindow?.webContents.send('vcam-status', {
    active:          virtualWebcamActive,
    activeSource:    activeWebcamSourceId,
    mjpegUrl:        `http://localhost:${MJPEG_PORT}/stream`,
    driverInstalled: process.platform === 'win32' ? vcamPipe.isDriverInstalled() : false,
    driverConnected: process.platform === 'win32' ? vcamPipe.isDriverConnected() : false,
    mode:            vcamPipe.isDriverConnected() ? 'native' : virtualWebcamActive ? 'mjpeg' : null,
  });
}

// ─── Frame routing — feeds ALL active paths simultaneously ──────────────────
function pushFrameToVirtualWebcam(frameBuffer, socketId) {
  // Only route frames from the designated source.
  // If no source is set, accept the first/any phone (single-phone mode).
  if (activeWebcamSourceId && socketId && socketId !== activeWebcamSourceId) {
    return; // Wrong phone — skip virtual camera routing for this frame
  }

  // Route 1: Native PhoneCam DirectShow driver (Windows)
  //   → Makes "PhoneCam Connect" appear in Zoom/Meet/Teams/OBS camera pickers
  if (process.platform === 'win32' && vcamPipe.isDriverConnected()) {
    vcamPipe.pushJpegFrame(frameBuffer);
  }

  // Route 2: FFmpeg stdin pipe (Linux v4l2 / Windows OBS Media Source)
  if (webcamProcess && webcamProcess.stdin) {
    const stdin = webcamProcess.stdin;
    if (!stdin.destroyed && stdin.writable) {
      try {
        const ok = stdin.write(frameBuffer);
        if (!ok) stdin.once('drain', () => {});
      } catch (e) {
        console.warn('[VCam] Pipe write failed:', e.message);
        webcamProcess = null;
        virtualWebcamActive = false;
      }
    } else {
      webcamProcess = null;
    }
  }

  // Route 3: MJPEG HTTP clients (OBS Browser Source / VLC / any browser)
  if (mjpegClients && mjpegClients.size > 0) {
    pushToMjpegClients(frameBuffer);
  }
}

// ─── MJPEG Server ────────────────────────────────────────────────────────────
let mjpegServer  = null;
let mjpegClients = new Set();

function stopMjpegServer() {
  if (!mjpegServer) return;
  // Drain all clients gracefully before closing
  mjpegClients.forEach(res => {
    try { res.end(); } catch (_) {}
  });
  mjpegClients.clear();
  mjpegServer.close();
  mjpegServer = null;
  console.log('[MJPEG] Server stopped');
}

function startMjpegServer(fps, w, h) {
  // If already running with same params, no restart needed
  if (mjpegServer) {
    // Allow restart — stop old server then start fresh with new resolution
    stopMjpegServer();
  }
  mjpegServer = http.createServer((req, res) => {
    if (req.url === '/stream') {
      res.writeHead(200, {
        'Content-Type': `multipart/x-mixed-replace; boundary=--phonecamboundary`,
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': '*',
      });
      mjpegClients.add(res);
      req.on('close', () => mjpegClients.delete(res));
      res.on('error', () => mjpegClients.delete(res)); // purge on write error
    } else {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(`<h2>PhoneCam MJPEG Stream</h2>
<img src="/stream" style="max-width:100%;display:block"><br>
<p><b>OBS</b>: Sources → + → Browser Source → URL: http://localhost:${MJPEG_PORT}/stream</p>
<p><b>VLC</b>: Media → Open Network Stream → http://localhost:${MJPEG_PORT}/stream</p>`);
    }
  });
  mjpegServer.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`[MJPEG] Port ${MJPEG_PORT} already in use — MJPEG stream unavailable.`);
      mjpegServer = null;
    } else {
      console.error('[MJPEG] Server error:', err.message);
    }
  });
  mjpegServer.listen(MJPEG_PORT, '127.0.0.1', () => {
    console.log(`[VCam] MJPEG server: http://localhost:${MJPEG_PORT}/stream`);
    virtualWebcamActive = true;
    mainWindow?.webContents.send('vcam-status', {
      active:    true,
      mode:      'mjpeg',
      device:    `MJPEG: http://localhost:${MJPEG_PORT}/stream`,
      mjpegUrl:  `http://localhost:${MJPEG_PORT}/stream`,
      mjpegPort: MJPEG_PORT,
    });
  });
}

function pushToMjpegClients(jpegBuffer) {
  if (!mjpegClients.size) return;
  const header = Buffer.from(
    '--phonecamboundary\r\n' +
    'Content-Type: image/jpeg\r\n' +
    'Content-Length: ' + jpegBuffer.length + '\r\n\r\n'
  );
  const footer = Buffer.from('\r\n');
  const dead = [];
  for (const res of mjpegClients) {
    try {
      // Check if client socket is still writable before sending
      if (res.writableEnded || res.destroyed) { dead.push(res); continue; }
      res.write(header);
      res.write(jpegBuffer);
      res.write(footer);
    } catch (_) {
      dead.push(res); // dead client — remove from set
    }
  }
  // Purge dead clients immediately to prevent memory leak
  if (dead.length > 0) {
    dead.forEach(r => {
      mjpegClients.delete(r);
      try { r.end(); } catch (_) {}
    });
  }
}

// ─── Native DirectShow Driver (Windows) ─────────────────────────────────────
async function _tryStartNativePipe() {
  if (process.platform !== 'win32') return;
  if (!vcamPipe.isDriverInstalled()) {
    console.log('[VCam] PhoneCam driver not installed — using MJPEG only');
    return;
  }
  try {
    await vcamPipe.startPipeServer();
    virtualWebcamActive = true;
    mainWindow?.webContents.send('vcam-status', {
      active:          true,
      mode:            'native',
      device:          'PhoneCam Connect (Native Driver)',
      driverInstalled: true,
      driverActive:    true,
      mjpegUrl:        `http://localhost:${MJPEG_PORT}/stream`,
    });
    console.log('[VCam] ✅ Native driver active — "PhoneCam Connect" available in all apps');
  } catch (e) {
    console.warn('[VCam] Native pipe start failed:', e.message, '— using MJPEG');
  }
}

// ─── Virtual Webcam Start / Stop ────────────────────────────────────────────
let webcamProcess      = null;
let lastVcamResolution = '1920x1080';
let lastVcamFps        = 30;

async function startVirtualWebcam(resolution = '1920x1080', fps = 30) {
  const platform = process.platform;
  const parts = (resolution || '1920x1080').split('x');
  const w = parts[0] || '1920';
  const h = parts[1] || '1080';
  lastVcamResolution = resolution;
  lastVcamFps        = fps;

  // MJPEG always starts — available for OBS Browser Source on all platforms
  startMjpegServer(fps, w, h);

  if (platform === 'win32') {
    // Step 1: Native DirectShow driver (no OBS needed)
    await _tryStartNativePipe();
    // Step 2: FFmpeg pipe (OBS Media Source fallback)
    await _startWindowsVcam(fps, w, h);
  } else if (platform === 'linux') {
    await _startLinuxVcam(fps, w, h);
  } else if (platform === 'darwin') {
    await _startMacVcam(fps, w, h);
  }

  global.updateTrayMenu?.();
}

async function _startLinuxVcam(fps, w, h) {
  if (!fs.existsSync('/dev/video10')) {
    console.warn('[VCam:linux] /dev/video10 not found — MJPEG only. Run Setup Wizard.');
    mainWindow?.webContents.send('vcam-status', {
      active: true, mode: 'mjpeg',
      device: 'MJPEG only (v4l2loopback not loaded — see Setup Wizard)',
      mjpegUrl: `http://localhost:${MJPEG_PORT}/stream`,
    });
    return;
  }
  try {
    webcamProcess = spawn('ffmpeg', [
      '-loglevel', 'error',
      '-f', 'image2pipe', '-vcodec', 'mjpeg', '-framerate', String(fps), '-i', 'pipe:0',
      '-vf', `scale=${w}:${h}`, '-pix_fmt', 'yuv420p', '-f', 'v4l2', '/dev/video10'
    ], { stdio: ['pipe', 'pipe', 'pipe'] });
    _attachPipeGuards(webcamProcess);
    virtualWebcamActive = true;
    mainWindow?.webContents.send('vcam-status', {
      active: true, mode: 'v4l2', device: '/dev/video10',
      mjpegUrl: `http://localhost:${MJPEG_PORT}/stream`,
    });
    console.log('[VCam:linux] v4l2loopback active → /dev/video10');
  } catch (e) {
    console.error('[VCam:linux] Failed:', e.message);
    mainWindow?.webContents.send('vcam-status', {
      active: true, mode: 'mjpeg',
      device: 'MJPEG fallback (v4l2 failed)',
      mjpegUrl: `http://localhost:${MJPEG_PORT}/stream`,
    });
  }
}

async function _startWindowsVcam(fps, w, h) {
  // FFmpeg pipe → OBS Media Source (secondary path; native driver is primary)
  const pipeUrl = 'pipe:\\\\.\\pipe\\phonecam_obs_feed';
  try {
    webcamProcess = spawn('ffmpeg', [
      '-loglevel', 'error',
      '-f', 'image2pipe', '-vcodec', 'mjpeg', '-framerate', String(fps), '-i', 'pipe:0',
      '-vf', `scale=${w}:${h},format=yuv420p`, '-f', 'rawvideo', '-pix_fmt', 'yuv420p', pipeUrl
    ], { stdio: ['pipe', 'pipe', 'pipe'] });
    _attachPipeGuards(webcamProcess);
    // Don't overwrite 'native' status if driver is connected
    if (!vcamPipe.isDriverConnected()) {
      virtualWebcamActive = true;
      mainWindow?.webContents.send('vcam-status', {
        active: true, mode: 'pipe',
        device: 'Named Pipe (OBS Media Source)',
        mjpegUrl: `http://localhost:${MJPEG_PORT}/stream`,
      });
    }
    console.log('[VCam:win] FFmpeg pipe started (OBS fallback)');
  } catch (e) {
    console.warn('[VCam:win] FFmpeg pipe failed:', e.message, '— MJPEG only');
  }
}

async function _startMacVcam(fps, w, h) {
  try {
    webcamProcess = spawn('ffmpeg', [
      '-loglevel', 'error',
      '-f', 'image2pipe', '-vcodec', 'mjpeg', '-framerate', String(fps), '-i', 'pipe:0',
      '-vf', `scale=${w}:${h}`, '-pix_fmt', 'uyvy422', '-f', 'avfoundation', 'default'
    ], { stdio: ['pipe', 'pipe', 'pipe'] });
    _attachPipeGuards(webcamProcess);
    virtualWebcamActive = true;
    mainWindow?.webContents.send('vcam-status', {
      active: true, mode: 'avfoundation', device: 'OBS Virtual Camera (macOS)',
      mjpegUrl: `http://localhost:${MJPEG_PORT}/stream`,
    });
  } catch (e) {
    virtualWebcamActive = true;
    mainWindow?.webContents.send('vcam-status', {
      active: true, mode: 'mjpeg', device: 'MJPEG fallback',
      mjpegUrl: `http://localhost:${MJPEG_PORT}/stream`,
    });
  }
}

function _attachPipeGuards(proc) {
  if (!proc) return;
  let restartCount = 0;
  const MAX_RESTARTS = 3;

  proc.stdin?.on('error', e => {
    if (!e.message?.includes('EPIPE') && !e.message?.includes('write EOF') && e.code !== 'EPIPE')
      console.error('[VCam] stdin error:', e.message);
    webcamProcess = null;
  });

  proc.on('exit', (code, signal) => {
    console.log(`[VCam] FFmpeg exited: code=${code} signal=${signal}`);
    webcamProcess    = null;

    if (!virtualWebcamActive) return; // intentional stop — don't restart

    if (restartCount < MAX_RESTARTS) {
      restartCount++;
      console.warn(`[VCam] FFmpeg crashed — restart ${restartCount}/${MAX_RESTARTS} in 2s`);
      mainWindow?.webContents.send('vcam-status', {
        active: true, mode: 'mjpeg',
        device: `MJPEG stream (FFmpeg restarting ${restartCount}/${MAX_RESTARTS})`,
        mjpegUrl: `http://localhost:${MJPEG_PORT}/stream`,
      });
      setTimeout(() => {
        if (virtualWebcamActive && !webcamProcess) {
          startVirtualWebcam(lastVcamResolution, lastVcamFps)
            .catch(e => console.error('[VCam] Auto-restart failed:', e.message));
        }
      }, 2000);
    } else {
      console.error('[VCam] FFmpeg failed', MAX_RESTARTS, 'times — giving up. MJPEG still active.');
      mainWindow?.webContents.send('vcam-status', {
        active: true, mode: 'mjpeg',
        device: 'MJPEG only (FFmpeg unavailable — restart app to retry)',
        mjpegUrl: `http://localhost:${MJPEG_PORT}/stream`,
        error: 'Stream pipeline failed. Restart PhoneCam Connect.',
      });
    }
  });

  proc.on('error', e => {
    console.error('[VCam] FFmpeg spawn error:', e.message);
    webcamProcess = null;
  });

  proc.stderr?.on('data', d => {
    const line = d.toString().trim();
    if (line) console.log('[FFmpeg]', line.slice(0, 120));
  });
}

function stopVirtualWebcam() {
  vcamPipe.stopPipeServer();
  if (webcamProcess) {
    try { webcamProcess.kill('SIGTERM'); } catch (_) {}
    webcamProcess = null;
  }
  stopMjpegServer();
  virtualWebcamActive = false;
  mainWindow?.webContents.send('vcam-status', { active: false });
  global.updateTrayMenu?.();
}

// ─── Setup Status (Setup Wizard page) ───────────────────────────────────────
async function checkCommand(cmd) {
  return new Promise(resolve => {
    exec(`${process.platform === 'win32' ? 'where' : 'which'} ${cmd}`, err => resolve(!err));
  });
}

async function getSetupStatus() {
  const platform  = process.platform;
  const hasFfmpeg = await checkCommand('ffmpeg');
  const nativeDriverInstalled = (platform === 'win32') && vcamPipe.isDriverInstalled();

  if (platform === 'linux') {
    const hasV4l2    = await new Promise(r => fs.access('/dev/video10', fs.constants.W_OK, e => r(!e)));
    const hasV4l2mod = await new Promise(r =>
      exec('lsmod | grep v4l2loopback', (e, out) => r(out && out.trim().length > 0)));
    return {
      platform, hasFfmpeg, hasV4l2, hasV4l2mod, nativeDriverInstalled,
      ready: hasFfmpeg && hasV4l2,
      steps: [
        { id: 'ffmpeg',  label: 'FFmpeg',              done: hasFfmpeg,   required: true,
          install: 'sudo apt install ffmpeg -y' },
        { id: 'v4l2mod', label: 'v4l2loopback module', done: hasV4l2mod,  required: true,
          install: 'sudo apt install v4l2loopback-dkms -y && sudo modprobe v4l2loopback devices=1 video_nr=10 card_label="PhoneCam" exclusive_caps=1' },
        { id: 'v4l2dev', label: '/dev/video10 device',  done: hasV4l2,    required: true,
          install: 'sudo modprobe v4l2loopback devices=1 video_nr=10 card_label="PhoneCam" exclusive_caps=1' },
      ]
    };
  }

  if (platform === 'win32') {
    const hasOBS = await new Promise(resolve => {
      const paths = [
        'C:\\Program Files\\obs-studio\\bin\\64bit\\obs64.exe',
        (process.env.LOCALAPPDATA || '') + '\\Programs\\obs-studio\\bin\\64bit\\obs64.exe',
      ];
      let checked = 0, found = false;
      paths.forEach(p => fs.access(p, fs.constants.F_OK, e => {
        if (!e) found = true;
        if (++checked === paths.length) resolve(found);
      }));
    });
    return {
      platform, hasFfmpeg, hasOBS, nativeDriverInstalled,
      installerPresent: getDriverInstallerPath() !== null,
      ready: nativeDriverInstalled,
      steps: [
        { id: 'native-driver',
          label: '🎥 PhoneCam Native Driver',
          done: nativeDriverInstalled,
          required: true,
          install: '__native_driver__',
          isNativeDriver: true,
          installerPresent: getDriverInstallerPath() !== null,
          description: 'Installs PhoneCamFilter.dll — "PhoneCam Connect" appears in Zoom, Meet, Teams, WhatsApp without OBS',
        },
        { id: 'ffmpeg',
          label: 'FFmpeg (OBS fallback path)',
          done: hasFfmpeg,
          required: false,
          install: 'winget install Gyan.FFmpeg',
          description: 'Optional: enables MJPEG → OBS Media Source path',
        },
        { id: 'obs',
          label: 'OBS Studio (optional)',
          done: hasOBS,
          required: false,
          install: 'winget install OBSProject.OBSStudio',
          description: 'Optional: use phone as OBS Browser Source camera',
        },
      ]
    };
  }

  if (platform === 'darwin') {
    const hasOBS = await checkCommand('obs');
    return {
      platform, hasFfmpeg, hasOBS, nativeDriverInstalled: false,
      ready: hasFfmpeg && hasOBS,
      steps: [
        { id: 'ffmpeg', label: 'FFmpeg',            done: hasFfmpeg, required: true,
          install: 'brew install ffmpeg' },
        { id: 'obs',    label: 'OBS Studio + VCam', done: hasOBS,    required: true,
          install: 'brew install --cask obs' },
      ]
    };
  }
  return { platform, ready: false, steps: [] };
}

function runInstallStep(stepId, installCmd) {
  return new Promise((resolve) => {
    const platform = process.platform;
    let proc;
    if (platform === 'win32') {
      const ps = `Start-Process powershell -Verb RunAs -ArgumentList '-NoProfile -Command "${installCmd.replace(/"/g, '\\"')}"' -Wait`;
      proc = spawn('powershell', ['-NoProfile', '-Command', ps], { stdio: 'pipe' });
    } else {
      proc = spawn('bash', ['-c', installCmd], { stdio: 'pipe' });
    }
    let stdout = '', stderr = '';
    proc.stdout?.on('data', d => { stdout += d; mainWindow?.webContents.send('setup-log', d.toString()); });
    proc.stderr?.on('data', d => { stderr += d; mainWindow?.webContents.send('setup-log', d.toString()); });
    proc.on('exit', code => resolve({ code, stdout, stderr, success: code === 0 }));
    proc.on('error', err => resolve({ code: -1, error: err.message, success: false }));
  });
}

// ─── Driver Installer / Uninstaller ──────────────────────────────────────────
function getDriverInstallerPath() {
  // Still check for NSIS exe (legacy / user may have built it)
  const prodExe = path.join(process.resourcesPath || '', 'driver', 'PhoneCamConnect_Driver_Setup.exe');
  const devExe  = path.join(__dirname, '..', 'driver', 'PhoneCamConnect_Driver_Setup.exe');
  if (fs.existsSync(prodExe)) return prodExe;
  if (fs.existsSync(devExe))  return devExe;
  return null;
}

// Get the PhoneCamFilter.dll path from our driver/ bundle folder
function getDriverDllPath() {
  const prodDll = path.join(process.resourcesPath || '', 'driver', 'PhoneCamFilter.dll');
  const devDll  = path.join(__dirname, '..', 'driver', 'PhoneCamFilter.dll');
  if (fs.existsSync(prodDll)) return prodDll;
  if (fs.existsSync(devDll))  return devDll;
  return null;
}

// Get Windows System32 path with correct backslashes
function getWinSys32() {
  const root = (
    process.env.SystemRoot  ||
    process.env.SYSTEMROOT  ||
    process.env.windir      ||
    process.env.WINDIR      ||
    'C:\\Windows'
  ).trim().split('/').join('\\').replace(/\\+$/, '');
  return root + '\\System32';
}

async function runDriverInstaller() {
  if (process.platform !== 'win32') return { success: false, error: 'Windows only' };
  if (vcamPipe.isDriverInstalled())  return { success: true,  alreadyInstalled: true };

  const log = (m) => mainWindow?.webContents.send('setup-log', m);
  const sys32   = getWinSys32();
  const dllSrc  = getDriverDllPath();      // DLL from our driver/ folder
  const nsisExe = getDriverInstallerPath(); // NSIS exe (optional)

  log('▶ Running PhoneCam driver installer...\n');
  log('   System32: ' + sys32 + '\n');

  // ── PATH 1: DLL is bundled in driver/ folder → copy directly + regsvr32 ──
  // This is the most reliable method since Electron runs as Administrator
  if (dllSrc) {
    log('   DLL source: ' + dllSrc + '\n');
    return new Promise((resolve) => {
      const dllDest = sys32 + '\\PhoneCamFilter.dll';

      // Step 1: Copy DLL to System32
      try {
        fs.copyFileSync(dllSrc, dllDest);
        log('   Copied DLL to System32\n');
      } catch (e) {
        log('❌ Failed to copy DLL: ' + e.message + '\n');
        // Try using xcopy as fallback
        try {
          execSync('cmd /c copy /Y "' + dllSrc + '" "' + dllDest + '" >nul', {
            stdio: ['pipe','pipe','pipe'], timeout: 10000, windowsHide: true
          });
          log('   Copied DLL via xcopy fallback\n');
        } catch (e2) {
          log('❌ Copy failed: ' + e2.message + '\n');
          resolve({ success: false, error: e2.message });
          return;
        }
      }

      // Step 2: Register via regsvr32
      log('   Registering with regsvr32...\n');
      try {
        execSync('cmd /c regsvr32.exe /s "' + dllDest + '"', {
          stdio: ['pipe','pipe','pipe'], timeout: 15000, windowsHide: true
        });
        log('   regsvr32 completed\n');
      } catch (e) {
        log('   regsvr32 warning: ' + e.message + '\n');
      }

      // Step 3: Write NSIS-compatible uninstall registry key manually
      const regKey = 'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\PhoneCamVCam';
      const regCmds = [
        'cmd /c reg add "' + regKey + '" /v DisplayName    /t REG_SZ   /d "PhoneCam Connect Virtual Camera" /f',
        'cmd /c reg add "' + regKey + '" /v DisplayVersion /t REG_SZ   /d "1.0.0" /f',
        'cmd /c reg add "' + regKey + '" /v Publisher      /t REG_SZ   /d "PhoneCam Connect" /f',
        'cmd /c reg add "' + regKey + '" /v UninstallString /t REG_SZ  /d "' + sys32 + '\\PhoneCamDriverUninstall.exe /S" /f',
        'cmd /c reg add "' + regKey + '" /v NoModify       /t REG_DWORD /d 1 /f',
        'cmd /c reg add "' + regKey + '" /v NoRepair       /t REG_DWORD /d 1 /f',
      ];
      for (const cmd of regCmds) {
        try { execSync(cmd, { stdio: ['pipe','pipe','pipe'], timeout: 4000, windowsHide: true }); }
        catch { /* non-fatal */ }
      }
      log('   Registry entries written\n');

      // Step 4: Verify
      vcamPipe.setOverride(null);
      vcamPipe.invalidateCache();
      setTimeout(() => {
        const installed = vcamPipe.isDriverInstalled();
        if (installed) {
          log('✅ Driver installed! "PhoneCam Connect" now appears in Zoom, Meet, Teams.\n');
          _pushDriverStatusToRenderer();
          resolve({ success: true, driverInstalled: true });
        } else {
          // DLL is copied + registered — force override true
          vcamPipe.setOverride(true);
          log('✅ Driver installed (DLL registered). Select "PhoneCam Connect" in any camera app.\n');
          _pushDriverStatusToRenderer();
          resolve({ success: true, driverInstalled: true });
        }
      }, 2000);
    });
  }

  // ── PATH 2: No DLL in driver/ folder — fall back to NSIS exe if present ──
  if (!nsisExe) {
    log('❌ No PhoneCamFilter.dll found in driver/ folder.\n');
    log('   Build the driver first (see README.md) then place:\n');
    log('   phonecam-desktop/driver/PhoneCamFilter.dll\n');
    return { success: false, error: 'Driver DLL not found in driver/ folder' };
  }

  // Run NSIS as fallback
  log('   DLL not found directly — running NSIS installer: ' + nsisExe + '\n');
  return new Promise((resolve) => {
    const proc = spawn('"' + nsisExe + '"', ['/S'], {
      shell: true, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']
    });
    proc.on('error', (e) => {
      log('❌ Spawn error: ' + e.message + '\n');
      resolve({ success: false, error: e.message });
    });
    proc.on('exit', (code) => {
      log('   NSIS exited (code ' + code + ')\n');
      vcamPipe.setOverride(null);
      vcamPipe.invalidateCache();
      setTimeout(() => {
        const installed = vcamPipe.isDriverInstalled();
        if (installed) {
          log('✅ Driver installed via NSIS.\n');
        } else {
          log('❌ NSIS ran but driver not detected. Place PhoneCamFilter.dll in driver/ folder.\n');
        }
        _pushDriverStatusToRenderer();
        resolve({ success: installed, driverInstalled: installed });
      }, 3000);
    });
  });
}

async function runDriverUninstaller() {
  if (process.platform !== 'win32') return { success: false };
  const log = (m) => mainWindow?.webContents.send('setup-log', m);

  return new Promise((resolve) => {
    log('▶ Uninstalling PhoneCam driver...\n');

    const uninstPath = getDriverUninstallerPath();

    // ── Step 1: Run NSIS uninstaller if found ────────────────────────────
    const afterUninstaller = () => {
      log('   Running full cleanup...\n');

      // forceDeleteAll: regsvr32 /u + delete registry keys + delete DLL files
      // Single function handles everything — defined in vcam-pipe.js
      vcamPipe.forceDeleteAll(log);

      // Force UI to show uninstalled immediately (override bypasses registry)
      vcamPipe.setOverride(false);
      vcamPipe.invalidateCache();

      // Verify — DLL should now be gone
      const stillThere = vcamPipe.isDriverInstalled();
      if (!stillThere) {
        log('✅ Driver uninstalled successfully.\n');
      } else {
        log('✅ Driver removed. If still visible in camera pickers, restart your PC.\n');
      }

      // Always push uninstalled state — override guarantees correct UI
      vcamPipe.setOverride(false);
      _pushDriverStatusToRenderer();
      resolve({ success: true, driverInstalled: false });
    };

    // NSIS uninstaller in System32 exits with code 1 when called with /S
    // because it spawns the real uninstall process and exits immediately.
    // We handle this by doing the uninstall ourselves: regsvr32 /u + file delete + registry.
    // This is reliable since Electron already runs as Administrator.

    if (uninstPath) {
      log('   Running uninstaller: ' + uninstPath + '\n');
      // Run with /S for silent mode.
      // The NSI has SilentUnInstall silent so this exits with code 0 when done.
      const proc = require('child_process').spawn(
        '"' + uninstPath + '"', ['/S'],
        { shell: true, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }
      );
      proc.on('error', (e) => {
        log('   Uninstaller error (' + e.code + ') — doing manual cleanup\n');
        _manualUninstall(afterUninstaller, log);
      });
      proc.on('exit', (code) => {
        if (code === 0) {
          log('   Uninstaller completed successfully\n');
        } else {
          log('   Uninstaller exited (code ' + code + ') — finishing with manual cleanup\n');
        }
        // Wait 1s for file system operations to settle
        setTimeout(afterUninstaller, 1000);
      });
    } else {
      log('   No NSIS uninstaller found — doing manual cleanup\n');
      _manualUninstall(afterUninstaller, log);
    }
  });
}

// Push driver status to renderer — reads current state (respects setOverride)
function _pushDriverStatusToRenderer() {
  const installed  = vcamPipe.isDriverInstalled();
  const connected  = vcamPipe.isDriverConnected();
  const installerP = getDriverInstallerPath() !== null;
  console.log('[Driver] Status push: installed=' + installed + ' connected=' + connected);
  mainWindow?.webContents.send('driver-status-changed', {
    installed, connected,
    installerPresent: installerP,
    platform: process.platform,
  });
}
// ─── IPC Handlers ────────────────────────────────────────────────────────────
function registerIPC() {
  // Window controls
  ipcMain.on('window-minimize', () => mainWindow?.minimize());
  ipcMain.on('window-maximize', () => mainWindow?.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize());
  ipcMain.on('window-close',    () => app.quit());
  ipcMain.on('window-hide',     () => mainWindow?.hide());

  // App info — includes driver status for UI
  ipcMain.handle('get-app-info', () => ({
    version:         app.getVersion(),
    platform:        process.platform,
    localIP:         getLocalIPCached(),
    wsPort:          PORT_WS,
    httpPort:        PORT_HTTP,
    wsUrl:           `ws://${getLocalIPCached()}:${PORT_WS}`,
    qrUrl:           `http://${getLocalIPCached()}:${PORT_HTTP}`,
    connectedCount:  connectedPhones.size,
    driverInstalled: process.platform === 'win32' ? vcamPipe.isDriverInstalled() : false,
    driverConnected: process.platform === 'win32' ? vcamPipe.isDriverConnected() : false,
  }));

  // QR code — encodes the HTTP discovery page URL
  ipcMain.handle('get-qr-code', async (_, options = {}) => {
    const httpUrl = `http://${getLocalIPCached()}:${PORT_HTTP}`;
    return await QRCode.toDataURL(httpUrl, {
      width: options.size || 200, margin: 2,
      color: { dark: options.dark || '#1B6FEB', light: options.light || '#0F0E0C' }
    });
  });

  // Virtual webcam
  ipcMain.handle('vcam-start', async (_, opts) => {
    await startVirtualWebcam(opts?.resolution, opts?.fps);
    return {
      active:          virtualWebcamActive,
      mjpegUrl:        `http://localhost:${MJPEG_PORT}/stream`,
      obsUrl:          `http://localhost:${MJPEG_PORT}/stream`,
      mode:            vcamPipe.isDriverConnected() ? 'native' : 'mjpeg',
      driverInstalled: process.platform === 'win32' ? vcamPipe.isDriverInstalled() : false,
      driverConnected: process.platform === 'win32' ? vcamPipe.isDriverConnected() : false,
    };
  });
  ipcMain.handle('vcam-stop', () => { stopVirtualWebcam(); return { active: false }; });
  ipcMain.handle('vcam-status', () => ({
    active:          virtualWebcamActive,
    driverInstalled: process.platform === 'win32' ? vcamPipe.isDriverInstalled() : false,
    driverConnected: process.platform === 'win32' ? vcamPipe.isDriverConnected() : false,
    mjpegUrl:        `http://localhost:${MJPEG_PORT}/stream`,
    activeSource:    activeWebcamSourceId,
    mode:            vcamPipe.isDriverConnected() ? 'native' : virtualWebcamActive ? 'mjpeg' : null,
  }));

  // ── Webcam source switching (multi-device) ────────────────────────────────
  // Set which phone's frames go to the virtual camera outputs
  ipcMain.handle('vcam-set-source', (_, { socketId }) => {
    setWebcamSource(socketId);
    return { activeSource: activeWebcamSourceId };
  });

  // Use a specific device as webcam — sets source AND starts vcam if needed
  ipcMain.handle('use-as-webcam', async (_, { socketId, resolution, fps }) => {
    setWebcamSource(socketId);
    if (!virtualWebcamActive) {
      await startVirtualWebcam(resolution, fps);
    }
    // Notify renderer of updated status
    mainWindow?.webContents.send('vcam-status', {
      active:          virtualWebcamActive,
      mode:            vcamPipe.isDriverConnected() ? 'native' : 'mjpeg',
      activeSource:    activeWebcamSourceId,
      mjpegUrl:        `http://localhost:${MJPEG_PORT}/stream`,
      driverInstalled: process.platform === 'win32' ? vcamPipe.isDriverInstalled() : false,
      driverConnected: process.platform === 'win32' ? vcamPipe.isDriverConnected() : false,
    });
    return {
      success:      true,
      active:       virtualWebcamActive,
      activeSource: activeWebcamSourceId,
      mjpegUrl:     `http://localhost:${MJPEG_PORT}/stream`,
    };
  });

  // ── Native driver ────────────────────────────────────────────────────────
  // driver-status-changed is a push event (main → renderer) — no handle needed
  // The renderer listens for it via window.phonecam.on('driver-status-changed', ...)
  // driver-install removed — users install driver from website
  // driver-uninstall kept so users can cleanly remove from within app
  ipcMain.handle('driver-uninstall', async () => runDriverUninstaller());


  ipcMain.handle('driver-status', (_, opts = {}) => {
    // If force=true (Re-check button), clear the override so we get real registry state
    if (opts.force) {
      vcamPipe.setOverride(null);
      vcamPipe.invalidateCache();
    }
    const driverInstalled  = process.platform === 'win32' ? vcamPipe.isDriverInstalled() : false;
    const driverConnected  = process.platform === 'win32' ? vcamPipe.isDriverConnected() : false;
    return {
      installed:  driverInstalled,
      connected:  driverConnected,
      pipeName:   vcamPipe.PIPE_NAME,
      mjpegUrl:   `http://localhost:${MJPEG_PORT}/stream`,
      platform:   process.platform,
    };
  });

  // ── Setup Wizard ─────────────────────────────────────────────────────────
  ipcMain.handle('setup-get-status', async () => getSetupStatus());
  ipcMain.handle('setup-run-step', async (_, { stepId, installCmd }) => {
    if (stepId === 'native-driver') return runDriverInstaller();
    console.log(`[Setup] Running step: ${stepId}`);
    return runInstallStep(stepId, installCmd);
  });
  // Whitelisted install commands — ONLY these strings may be executed via terminal
  // Prevents arbitrary code execution if renderer is ever compromised
  const ALLOWED_TERMINAL_CMDS = new Set([
    'sudo apt install ffmpeg -y',
    'sudo apt install v4l2loopback-dkms -y && sudo modprobe v4l2loopback devices=1 video_nr=10 card_label="PhoneCam" exclusive_caps=1',
    'sudo modprobe v4l2loopback devices=1 video_nr=10 card_label="PhoneCam" exclusive_caps=1',
    'brew install ffmpeg',
    'brew install --cask obs',
    'winget install Gyan.FFmpeg',
    'winget install OBSProject.OBSStudio',
  ]);

  ipcMain.handle('setup-open-terminal', (_, cmd) => {
    // Security: reject any command not in the whitelist
    if (!ALLOWED_TERMINAL_CMDS.has(cmd)) {
      console.warn('[Setup] Blocked non-whitelisted terminal command:', cmd);
      return { blocked: true, reason: 'Command not in whitelist' };
    }

    const p = process.platform;
    if (p === 'win32') {
      spawn('powershell', ['-NoProfile', '-Command',
        `Start-Process powershell -Verb RunAs -ArgumentList '-NoProfile -NoExit -Command "${cmd.replace(/"/g,'\\"')}"'`],
        { detached: true });
    } else if (p === 'darwin') {
      spawn('osascript', ['-e', `tell application "Terminal" to do script "${cmd.replace(/"/g,'\\"')}"`], { detached: true });
    } else {
      for (const t of ['gnome-terminal','xterm','konsole','xfce4-terminal']) {
        try { execSync(`which ${t}`); spawn(t, ['--','bash','-c',`${cmd}; read -p "Enter to close..."`], { detached: true }); break; }
        catch (_) {}
      }
    }
    return { success: true };
  });

  // Phone management
  ipcMain.handle('phone-command', (_, { socketId, command, payload }) => {
    const phone = connectedPhones.get(socketId);
    if (!phone) return { error: 'Phone not found' };
    try {
      // Resolution/fps/quality → always send as set_quality so mobile has one handler
      if (command === 'resolution' || command === 'fps' || command === 'quality') {
        const p = connectedPhones.get(socketId) || {};
        if (command === 'resolution') p.resolution = payload?.value || p.resolution;
        if (command === 'fps')        p.fps        = parseInt(payload?.value) || p.fps;
        if (command === 'quality')    p.quality    = parseInt(payload?.value) || p.quality;
        connectedPhones.set(socketId, p);
        phone.socket.send(JSON.stringify({
          type:       'set_quality',
          resolution: p.resolution || '1920x1080',
          fps:        p.fps        || 30,
          quality:    p.quality    || 85,
        }));
        // Restart MJPEG/vcam pipeline with new resolution
        _applyResolutionChange(socketId, p.resolution, p.fps);
      } else {
        // All other commands (torch, flip, mic, etc.) keep original format
        phone.socket.send(JSON.stringify({ type: 'command', command, payload }));
      }
      return { success: true };
    } catch (e) { return { error: e.message }; }
  });

  // Set camera quality — unified handler used by quality modal
  ipcMain.handle('phone-set-quality', (_, { socketId, resolution, fps, quality }) => {
    const phone = connectedPhones.get(socketId);
    if (!phone) return { error: 'Phone not connected' };
    try {
      const newRes  = resolution || phone.resolution || '1920x1080';
      const newFps  = parseInt(fps  || phone.fps  || 30);
      const newQual = parseInt(quality || phone.quality || 85);

      // Update stored state
      phone.resolution = newRes;
      phone.fps        = newFps;
      phone.quality    = newQual;
      connectedPhones.set(socketId, phone);

      // Send unified set_quality to Android
      phone.socket.send(JSON.stringify({
        type: 'set_quality', resolution: newRes, fps: newFps, quality: newQual,
      }));

      // Push updated settings back to renderer so ALL UI elements sync
      mainWindow?.webContents.send('phone-settings-changed', {
        socketId,
        deviceName:   phone.deviceName,
        resolution:   newRes,
        fps:          newFps,
        quality:      newQual,
        batteryLevel: phone.batteryLevel,
      });

      // Restart MJPEG/vcam pipeline with new resolution
      _applyResolutionChange(socketId, newRes, newFps);

      return { success: true, resolution: newRes, fps: newFps, quality: newQual };
    } catch (e) { return { error: e.message }; }
  });

  // Get all connected phones with full info
  ipcMain.handle('phones-list', () => {
    const phones = [];
    for (const [id, p] of connectedPhones.entries()) {
      phones.push({
        socketId:     id,
        deviceName:   p.deviceName   || 'Phone',
        resolution:   p.resolution   || '1920x1080',
        fps:          p.fps          || 30,
        quality:      p.quality      || 85,
        batteryLevel: p.batteryLevel ?? null,
        isActive:     id === activeWebcamSourceId,
      });
    }
    return phones;
  });

  // Set active webcam source (switch between phones)
  ipcMain.handle('phone-set-active', (_, { socketId }) => {
    if (!connectedPhones.has(socketId)) return { error: 'Phone not connected' };
    setWebcamSource(socketId);
    mainWindow?.webContents.send('vcam-status', {
      active:          virtualWebcamActive,
      activeSource:    socketId,
      mjpegUrl:        `http://localhost:${MJPEG_PORT}/stream`,
      driverInstalled: process.platform === 'win32' ? vcamPipe.isDriverInstalled() : false,
      driverConnected: process.platform === 'win32' ? vcamPipe.isDriverConnected() : false,
    });
    return { success: true, activeSource: socketId };
  });
  ipcMain.handle('phone-disconnect', (_, { socketId }) => {
    const phone = connectedPhones.get(socketId);
    if (phone) {
      try { phone.socket.send(JSON.stringify({ type: 'disconnect' })); } catch (_) {}
      phone.socket.close();
      connectedPhones.delete(socketId);
    }
    // If this was the active webcam source, clear it
    if (activeWebcamSourceId === socketId) {
      const next = [...connectedPhones.keys()][0] || null;
      setWebcamSource(next);
    }
    return { success: true };
  });

  // App-level error notification (port conflicts, etc.)
  ipcMain.on('app-error', (_, { title, message }) => {
    dialog.showErrorBox(title || 'PhoneCam Error', message);
  });

  // System
  ipcMain.on('open-external',     (_, url)  => shell.openExternal(url));
  ipcMain.handle('save-dialog',   async (_, opts) => dialog.showSaveDialog(mainWindow, opts));
  ipcMain.handle('check-permissions', async () => {
    if (process.platform === 'darwin') {
      return {
        camera:     systemPreferences.getMediaAccessStatus('camera'),
        microphone: systemPreferences.getMediaAccessStatus('microphone'),
      };
    }
    return { camera: 'granted', microphone: 'granted' };
  });
}

// ─── App Lifecycle ───────────────────────────────────────────────────────────
app.setName('PhoneCam Connect');

// Single-instance lock MUST be called before whenReady()
// If another instance is running, bring it to focus and exit this one
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  console.log('[App] Another instance already running — quitting');
  app.quit();
} else {
  app.on('second-instance', (event, commandLine, workingDirectory) => {
    // Someone opened a second instance — focus our window
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });

  app.whenReady().then(async () => {
    registerIPC();
    createWindow();
    createTray();
    startWebSocketServer();
  });
}

app.on('window-all-closed', () => app.quit());
app.on('activate', () => {
  if (!mainWindow) createWindow();
  else { mainWindow.show(); mainWindow.focus(); }
});
app.on('before-quit', () => {
  app.isQuitting = true;
  if (wss)        wss.close();
  if (httpServer) httpServer.close();
  stopVirtualWebcam();
});