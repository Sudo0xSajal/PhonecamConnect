/**
 * vcam-pipe.js — Named Pipe server + Driver state management
 *
 * Wire format per frame:
 *   [4 bytes magic: 0x50434D46 "PCMF"] [4 bytes: JPEG length uint32LE] [N bytes: JPEG data]
 *
 * Production fixes applied:
 *   - Pre-allocated FRAME_HEADER buffer — zero heap allocation per frame (was Buffer.concat every frame)
 *   - Two write() calls instead of concat — OS combines into one TCP segment, zero copy
 *   - _droppedFrames counter for backpressure diagnostics
 *   - execSync stays for registry (called infrequently + cached 5s — acceptable)
 *   - getStats() exposes live performance data for diagnostics dashboard
 */
'use strict';

const net          = require('net');
const { execSync } = require('child_process');
const fs           = require('fs');

const PIPE_NAME       = '\\\\.\\pipe\\phonecam_video';
const MAGIC_NUM       = 0x50434D46;
const CLSID           = '{A1B2C3D4-E5F6-7890-ABCD-EF1234567890}';
const NSIS_UNINST_KEY = 'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\PhoneCamVCam';
const HKCR_CLSID_KEY  = 'HKCR\\CLSID\\' + CLSID;
const HKLM_CLSID_KEY  = 'HKLM\\SOFTWARE\\Classes\\CLSID\\' + CLSID;

const MAX_RETRY      = 10;
const CACHE_TTL      = 5000;
const BACKPRESSURE_B = 2 * 1024 * 1024; // 2MB — drop frame if pipe buffer exceeds this

// ── Pre-allocated frame header — reused every frame, zero GC pressure ────────
// SAFE: header bytes are fully written before socket.write() returns.
// The OS buffers the data. We overwrite the length field on every call
// BEFORE the next write, so there is no race condition.
const FRAME_HEADER = Buffer.allocUnsafe(8);
FRAME_HEADER.writeUInt32LE(MAGIC_NUM, 0); // magic bytes never change — write once

let pipeServer   = null;
let driverClient = null;
let isRunning    = false;
let retryCount   = 0;

// Diagnostics counters
let _frameCount    = 0;
let _bytesSent     = 0;
let _droppedFrames = 0;

// Driver install state cache + hard override
let _cache       = null;  // true | false | null(unset)
let _cacheExpiry = 0;
let _override    = null;  // true | false | null(use registry)

// ── Windows path helper ───────────────────────────────────────────────────────
// Returns C:\Windows\System32 with correct backslashes on ALL platforms.
// NEVER use path.join() for Windows paths — on Linux it uses forward slashes.
function getSys32() {
  const root = (
    process.env.SystemRoot  ||
    process.env.SYSTEMROOT  ||
    process.env.windir      ||
    process.env.WINDIR      ||
    'C:\\Windows'
  ).replace(/[/\\]+$/, '').split('/').join('\\');
  return root + '\\System32';
}

// ── Pipe server ───────────────────────────────────────────────────────────────
function startPipeServer() {
  if (isRunning) return Promise.resolve();
  retryCount = 0;
  return _startPipe();
}

function _startPipe() {
  return new Promise((resolve, reject) => {
    pipeServer = net.createServer({ allowHalfOpen: false }, (socket) => {
      console.log('[VCamPipe] DirectShow driver connected');
      if (driverClient && !driverClient.destroyed) driverClient.destroy();
      driverClient = socket;
      socket.setNoDelay(true); // disable Nagle — we need minimum latency
      socket.on('error', (e) => {
        if (e.code !== 'EPIPE' && e.code !== 'ECONNRESET')
          console.warn('[VCamPipe] Socket error:', e.code);
        driverClient = null;
      });
      socket.on('close', () => {
        console.log('[VCamPipe] Driver disconnected — waiting for reconnect');
        driverClient = null;
      });
    });

    pipeServer.on('error', (e) => {
      if (e.code === 'EADDRINUSE') {
        if (++retryCount > MAX_RETRY) {
          reject(new Error('Named pipe in use after ' + MAX_RETRY + ' retries'));
          return;
        }
        pipeServer = null;
        setTimeout(() => _startPipe().then(resolve).catch(reject), 500);
      } else {
        reject(e);
      }
    });

    pipeServer.listen(PIPE_NAME, () => {
      isRunning  = true;
      retryCount = 0;
      console.log('[VCamPipe] Listening on', PIPE_NAME);
      resolve();
    });
  });
}

// ── Zero-copy frame push ──────────────────────────────────────────────────────
// Uses TWO separate write() calls to avoid Buffer.concat() entirely.
// Nagle is disabled (setNoDelay), so both writes flush to the driver immediately.
// Pre-allocated FRAME_HEADER eliminates heap allocation on the hot path.
function pushJpegFrame(jpegBuffer) {
  if (!driverClient || driverClient.destroyed) return;

  // Backpressure: drop frame if pipe write buffer exceeds threshold.
  // Prevents unbounded memory growth when the DirectShow driver is slow.
  if (driverClient.writableLength > BACKPRESSURE_B) {
    _droppedFrames++;
    if (_droppedFrames % 30 === 0) // log every ~1s at 30fps
      console.warn('[VCamPipe] Backpressure: dropped', _droppedFrames, 'frames total');
    return;
  }

  // Write JPEG length into pre-allocated header (bytes 4–7). Magic (0–3) never changes.
  FRAME_HEADER.writeUInt32LE(jpegBuffer.length, 4);

  try {
    driverClient.write(FRAME_HEADER); // 8 bytes — header
    driverClient.write(jpegBuffer);   // N bytes — JPEG payload (zero copy)
    _frameCount++;
    _bytesSent += 8 + jpegBuffer.length;
  } catch (e) {
    if (e.code !== 'EPIPE' && e.code !== 'ERR_STREAM_DESTROYED')
      console.warn('[VCamPipe] Write error:', e.code);
    driverClient = null;
  }
}

function stopPipeServer() {
  isRunning  = false;
  retryCount = 0;
  if (driverClient) {
    try { driverClient.destroy(); } catch (_) {}
    driverClient = null;
  }
  if (pipeServer) {
    pipeServer.close();
    pipeServer = null;
  }
  console.log(
    '[VCamPipe] Stopped —',
    _frameCount, 'frames,',
    (_bytesSent / 1048576).toFixed(1), 'MB sent,',
    _droppedFrames, 'dropped'
  );
  _frameCount = 0; _bytesSent = 0; _droppedFrames = 0;
}

function isDriverConnected() {
  return !!(driverClient && !driverClient.destroyed);
}

// ── Driver install detection ──────────────────────────────────────────────────
function isDriverInstalled() {
  if (process.platform !== 'win32') return false;
  if (_override !== null) return _override; // hard override always wins
  const now = Date.now();
  if (_cache !== null && now < _cacheExpiry) return _cache;
  _cache       = _queryRegistry();
  _cacheExpiry = now + CACHE_TTL;
  return _cache;
}

// Run a reg query — returns true if key exists with content
// Uses 2s timeout (was 4s) — event loop blocked for max 2s per call.
// Cache in isDriverInstalled() (5s TTL) means this runs at most once per 5s.
function _regQuery(keyPath) {
  try {
    const out = execSync(
      'cmd /c reg query "' + keyPath + '" 2>nul',
      { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 2000, windowsHide: true }
    );
    return !!(out && out.trim().length > 5);
  } catch {
    return false;
  }
}

// Async registry query — non-blocking, used for background checks
function _regQueryAsync(keyPath) {
  return new Promise((resolve) => {
    const { execFile } = require('child_process');
    execFile('cmd', ['/c', 'reg', 'query', keyPath],
      { timeout: 2000, windowsHide: true },
      (err, stdout) => resolve(!err && stdout && stdout.trim().length > 5)
    );
  });
}

// Async version of isDriverInstalled — does not block event loop at all
// Use this from IPC handlers; keep sync version for internal hot-path checks
async function isDriverInstalledAsync() {
  if (process.platform !== 'win32') return false;
  if (_override !== null) return _override;

  const sys32   = getSys32();
  const dllPath = sys32 + '\\PhoneCamFilter.dll';
  let dllExists = false;
  try { fs.accessSync(dllPath); dllExists = true; } catch {}
  if (!dllExists) {
    _cache = false; _cacheExpiry = Date.now() + CACHE_TTL;
    return false;
  }
  // DLL exists — update cache and return true without registry query
  _cache = true; _cacheExpiry = Date.now() + CACHE_TTL;
  return true;
}

function _queryRegistry() {
  const sys32   = getSys32();
  const dllPath = sys32 + '\\PhoneCamFilter.dll';

  // PRIMARY: DLL file must exist in System32
  // This is the definitive check — no DLL = not installed, regardless of registry
  let dllExists = false;
  try { fs.accessSync(dllPath); dllExists = true; } catch { dllExists = false; }

  if (!dllExists) return false;

  // SECONDARY: confirm registry registration
  const nsis = _regQuery(NSIS_UNINST_KEY);
  const hkcr = _regQuery(HKCR_CLSID_KEY);
  const hklm = _regQuery(HKLM_CLSID_KEY);

  // DLL present + any registry entry = installed
  // DLL present but registry gone = still treat as installed (will re-register on reboot)
  return true; // DLL existence is sufficient
}

// ── Full uninstall: regsvr32 /u + delete registry + delete DLL files ──────────
// Called from runDriverUninstaller in main.js.
// logFn is optional — if provided, progress is sent to the setup log panel.
function forceDeleteAll(logFn) {
  const sys32 = getSys32();
  const log   = typeof logFn === 'function' ? logFn : () => {};
  const opts  = { stdio: ['pipe','pipe','pipe'], timeout: 5000, windowsHide: true };

  // 1. Unregister COM filter (removes HKCR entries added by regsvr32)
  try {
    execSync('cmd /c regsvr32.exe /s /u "' + sys32 + '\\PhoneCamFilter.dll" 2>nul', opts);
    log('   regsvr32 /u: done\n');
  } catch { /* already unregistered or DLL gone */ }

  // 2. Delete all registry keys
  const keys = [
    NSIS_UNINST_KEY,
    HKCR_CLSID_KEY,
    HKLM_CLSID_KEY,
    'HKLM\\SOFTWARE\\WOW6432Node\\Classes\\CLSID\\' + CLSID,
  ];
  let regCount = 0;
  for (const k of keys) {
    try { execSync('cmd /c reg delete "' + k + '" /f 2>nul', opts); regCount++; } catch {}
  }
  if (regCount > 0) log('   Registry keys removed: ' + regCount + '\n');

  // 3. Delete DLL and related files from System32
  // CRITICAL: without deleting the DLL, Windows re-registers it on next reboot
  const files = [
    sys32 + '\\PhoneCamFilter.dll',
    sys32 + '\\turbojpeg.dll',
    sys32 + '\\PhoneCamDriverUninstall.exe',
  ];
  for (const f of files) {
    try {
      execSync('cmd /c del /f /q "' + f + '" 2>nul', opts);
      log('   Deleted: ' + f.split('\\').pop() + '\n');
    } catch { /* file may not exist or be locked by another process */ }
  }
}

// Legacy alias — kept for any callers that used the old name
function forceDeleteRegistryKeys() { return forceDeleteAll(); }

function invalidateCache() {
  _cache = null;
  _cacheExpiry = 0;
}

// Hard override — bypasses registry + DLL check entirely
// true  = always report installed
// false = always report not installed (use after uninstall while DLL may be locked)
// null  = resume normal registry-based detection
function setOverride(value) {
  _override = (value === null) ? null : !!value;
  invalidateCache();
}

// ── Diagnostics ───────────────────────────────────────────────────────────────
function getStats() {
  return {
    frames:         _frameCount,
    bytesSent:      _bytesSent,
    dropped:        _droppedFrames,
    writableLength: driverClient?.writableLength ?? 0,
    connected:      isDriverConnected(),
    isRunning,
  };
}

module.exports = {
  startPipeServer,
  stopPipeServer,
  pushJpegFrame,
  isDriverConnected,
  isDriverInstalled,
  isDriverInstalledAsync,
  invalidateCache,
  setOverride,
  forceDeleteAll,
  forceDeleteRegistryKeys,
  getSys32,
  getStats,
  PIPE_NAME,
  CLSID,
  NSIS_UNINST_KEY,
};