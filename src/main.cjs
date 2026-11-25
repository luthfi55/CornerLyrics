'use strict';

const { app, BrowserWindow, ipcMain, screen } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const readline = require('node:readline');
const { fetchLyrics } = require('./lib/lyrics.cjs');
const { parseLrc } = require('./lib/lrc.cjs');

const APP_NAME = 'CornerLyrics';
app.setName(APP_NAME);
if (process.env.PORTABLE_EXECUTABLE_DIR) {
  app.setPath('userData', path.join(process.env.PORTABLE_EXECUTABLE_DIR, 'CornerLyrics Data'));
}

const isWindows = process.platform === 'win32';
const WINDOW_STATE_FILE = () => path.join(app.getPath('userData'), 'window-state.json');
const MIN_WINDOW_WIDTH = 320;
const MIN_WINDOW_HEIGHT = 140;

function runtimePath(filePath) {
  const packedDirectory = `app.asar${path.sep}`;
  return filePath.includes(packedDirectory)
    ? filePath.replace(packedDirectory, `app.asar.unpacked${path.sep}`)
    : filePath;
}

let mainWindow = null;
let mediaProcess = null;
let mediaRestartTimer = null;
let windowSaveTimer = null;
let quitting = false;
let latestMedia = emptyMedia();
let latestLyrics = idleLyrics();
let systemState = { status: 'starting', message: '' };
let currentMediaKey = '';
let lyricsRequestId = 0;
let activeLyricsController = null;
const lyricsCache = new Map();
const gotSingleInstanceLock = app.requestSingleInstanceLock();

function emptyMedia() {
  return {
    playing: false,
    title: '',
    artist: '',
    album: '',
    source: '',
    position: 0,
    duration: 0,
    rate: 1,
    updated: 0,
  };
}

function idleLyrics() {
  return {
    key: '',
    status: 'idle',
    lines: [],
    plainText: '',
    instrumental: false,
    error: '',
  };
}

function mediaKey(media) {
  return [media.artist, media.title, media.album]
    .map((value) => String(value || '').trim().toLocaleLowerCase())
    .join('\u0000');
}

function send(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

function setSystemState(status, message = '') {
  systemState = { status, message };
  send('system:update', systemState);
}

function clampBounds(bounds) {
  const display = screen.getDisplayMatching(bounds);
  const area = display.workArea;
  const width = Math.min(Math.max(Math.round(bounds.width || 420), MIN_WINDOW_WIDTH), area.width);
  const height = Math.min(Math.max(Math.round(bounds.height || 164), MIN_WINDOW_HEIGHT), area.height);
  const x = Math.min(Math.max(bounds.x, area.x + 8), area.x + area.width - width - 8);
  const y = Math.min(Math.max(bounds.y, area.y + 8), area.y + area.height - height - 8);
  return { x, y, width, height };
}

function defaultBounds() {
  const area = screen.getPrimaryDisplay().workArea;
  const width = 420;
  const height = 164;
  return {
    x: area.x + area.width - width - 24,
    y: area.y + area.height - height - 24,
    width,
    height,
  };
}

async function migrateLegacyWindowState() {
  const target = WINDOW_STATE_FILE();
  const legacy = path.join(app.getPath('appData'), 'PojokLirik', 'window-state.json');

  try {
    await fs.access(target);
    return;
  } catch {
    // Continue with the legacy state only when the new app has no saved bounds.
  }

  try {
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.copyFile(legacy, target);
  } catch {
    // First install or an unavailable legacy profile simply uses default bounds.
  }
}

async function loadWindowBounds() {
  try {
    const raw = JSON.parse(await fs.readFile(WINDOW_STATE_FILE(), 'utf8'));
    if (['x', 'y', 'width', 'height'].every((key) => Number.isFinite(raw[key]))) {
      return clampBounds(raw);
    }
  } catch {
    // A missing or invalid state file simply restores the default corner.
  }
  return defaultBounds();
}

async function saveWindowBounds() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const bounds = mainWindow.getBounds();
  try {
    await fs.mkdir(path.dirname(WINDOW_STATE_FILE()), { recursive: true });
    await fs.writeFile(WINDOW_STATE_FILE(), JSON.stringify(bounds), 'utf8');
  } catch {
    // Position persistence is best-effort; the overlay keeps working without it.
  }
}

function scheduleWindowSave() {
  clearTimeout(windowSaveTimer);
  windowSaveTimer = setTimeout(saveWindowBounds, 250);
}

async function createWindow() {
  const bounds = await loadWindowBounds();
  mainWindow = new BrowserWindow({
    ...bounds,
    minWidth: MIN_WINDOW_WIDTH,
    minHeight: MIN_WINDOW_HEIGHT,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    alwaysOnTop: true,
    resizable: true,
    maximizable: false,
    minimizable: true,
    fullscreenable: false,
    show: false,
    title: APP_NAME,
    icon: path.join(__dirname, '..', 'assets', 'icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.setAlwaysOnTop(true, 'floating');
  mainWindow.setOpacity(0.97);
  mainWindow.on('move', scheduleWindowSave);
  mainWindow.on('resize', scheduleWindowSave);
  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  await mainWindow.loadFile(path.join(__dirname, 'renderer/index.html'));
  mainWindow.showInactive();
  send('media:update', latestMedia);
  send('lyrics:update', latestLyrics);
  setSystemState(systemState.status, systemState.message);
}

function parseMediaUpdate(value) {
  if (!value || typeof value !== 'object') return null;
  return {
    playing: Boolean(value.playing),
    title: String(value.title || '').trim(),
    artist: String(value.artist || '').trim(),
    album: String(value.album || '').trim(),
    source: String(value.source || '').trim(),
    position: Math.max(0, Number(value.position) || 0),
    duration: Math.max(0, Number(value.duration) || 0),
    rate: Math.max(0, Number(value.rate) || 1),
    updated: Number(value.updated) || Date.now(),
  };
}

function scheduleMediaRestart() {
  if (quitting) return;
  clearTimeout(mediaRestartTimer);
  mediaRestartTimer = setTimeout(() => {
    if (!mediaProcess) startMediaMonitor();
  }, 2500);
}

function startMediaMonitor() {
  if (!isWindows) {
    setSystemState('unsupported', 'Automatic detection is only available on Windows.');
    return;
  }

  const script = runtimePath(path.join(__dirname, '..', 'scripts', 'windows-media.ps1'));
  const child = spawn(
    'powershell.exe',
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script],
    { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  mediaProcess = child;
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');

  const lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
  lines.on('line', (line) => {
    if (!line.trim()) return;
    try {
      const media = parseMediaUpdate(JSON.parse(line));
      if (!media) return;
      latestMedia = media;
      setSystemState('ready');
      send('media:update', latestMedia);

      const key = mediaKey(media);
      if (!media.title) {
        activeLyricsController?.abort();
        activeLyricsController = null;
        currentMediaKey = '';
        lyricsRequestId += 1;
        latestLyrics = idleLyrics();
        send('lyrics:update', latestLyrics);
      } else if (key !== currentMediaKey) {
        currentMediaKey = key;
        loadLyrics();
      }
    } catch {
      // Ignore malformed lines; the next PowerShell poll provides a fresh snapshot.
    }
  });

  let lastError = '';
  child.stderr.on('data', (chunk) => {
    lastError = `${lastError}${chunk}`.slice(-1000);
  });

  child.on('error', (error) => {
    setSystemState('error', `Could not start the media reader: ${error.message}`);
  });

  child.on('exit', (code) => {
    if (mediaProcess === child) mediaProcess = null;
    if (!quitting) {
      setSystemState(
        'error',
        code === 0 ? '' : lastError.trim() || 'Windows media reader stopped. Reconnecting…',
      );
      scheduleMediaRestart();
    }
  });
}

async function loadLyrics({ force = false } = {}) {
  const media = { ...latestMedia };
  const key = mediaKey(media);
  if (!media.title) return;

  const requestId = ++lyricsRequestId;
  activeLyricsController?.abort();
  activeLyricsController = null;

  const cached = lyricsCache.get(key);
  if (cached && !force) {
    latestLyrics = cached;
    send('lyrics:update', latestLyrics);
    return;
  }

  latestLyrics = { ...idleLyrics(), key, status: 'loading' };
  send('lyrics:update', latestLyrics);

  const controller = new AbortController();
  activeLyricsController = controller;

  try {
    const result = await fetchLyrics(media, { signal: controller.signal });
    if (activeLyricsController === controller) activeLyricsController = null;
    if (requestId !== lyricsRequestId || result.status === 'aborted') return;

    if (result.status !== 'found') {
      latestLyrics = {
        ...idleLyrics(),
        key,
        status: result.status,
        error: result.message || '',
      };
      send('lyrics:update', latestLyrics);
      return;
    }

    if (result.instrumental) {
      latestLyrics = { key, status: 'ready', lines: [], plainText: '', instrumental: true, error: '' };
    } else {
      const source = result.syncedLyrics || result.plainLyrics;
      const parsed = parseLrc(source);
      if (parsed.lines.length === 0 && !parsed.plainText) {
        latestLyrics = { ...idleLyrics(), key, status: 'not-found' };
      } else {
        latestLyrics = {
          key,
          status: 'ready',
          lines: parsed.lines,
          plainText: parsed.plainText,
          instrumental: false,
          error: '',
        };
      }
    }

    lyricsCache.set(key, latestLyrics);
    if (lyricsCache.size > 30) lyricsCache.delete(lyricsCache.keys().next().value);
    send('lyrics:update', latestLyrics);
  } catch (error) {
    if (activeLyricsController === controller) activeLyricsController = null;
    if (requestId !== lyricsRequestId) return;
    latestLyrics = {
      ...idleLyrics(),
      key,
      status: 'network-error',
      error: error instanceof Error ? error.message : String(error),
    };
    send('lyrics:update', latestLyrics);
  }
}

function registerIpc() {
  ipcMain.handle('app:get-snapshot', () => ({
    media: latestMedia,
    lyrics: latestLyrics,
    system: systemState,
  }));

  ipcMain.on('lyrics:refresh', () => loadLyrics({ force: true }));
  ipcMain.on('window:minimize', () => mainWindow?.minimize());
  ipcMain.on('window:close', () => mainWindow?.close());
}

if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });

  app.whenReady().then(async () => {
    if (isWindows) app.setAppUserModelId('id.pojoklirik.desktop');
    registerIpc();
    await migrateLegacyWindowState();
    await createWindow();
    startMediaMonitor();
  });

  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', () => {
    quitting = true;
    clearTimeout(mediaRestartTimer);
    clearTimeout(windowSaveTimer);
    activeLyricsController?.abort();
    if (mediaProcess) mediaProcess.kill();
  });
}
