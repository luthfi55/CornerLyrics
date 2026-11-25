'use strict';

const api = window.cornerLyrics;
const elements = {
  statusDot: document.getElementById('status-dot'),
  sourceName: document.getElementById('source-name'),
  trackTitle: document.getElementById('track-title'),
  trackArtist: document.getElementById('track-artist'),
  previousLine: document.getElementById('previous-line'),
  currentLine: document.getElementById('current-line'),
  nextLine: document.getElementById('next-line'),
  syncedView: document.getElementById('synced-view'),
  plainView: document.getElementById('plain-view'),
  lyricsStatus: document.getElementById('lyrics-status'),
  positionStatus: document.getElementById('position-status'),
  themeButton: document.getElementById('theme-button'),
  themePicker: document.getElementById('theme-picker'),
  themeAnnouncement: document.getElementById('theme-announcement'),
  refreshButton: document.getElementById('refresh-button'),
  minimizeButton: document.getElementById('minimize-button'),
  closeButton: document.getElementById('close-button'),
};

const THEME_NAMES = Object.freeze({
  dark: 'Dark',
  light: 'Light',
  ocean: 'Ocean',
  sunset: 'Sunset',
});
const themeButtons = [...document.querySelectorAll('[data-theme-choice]')];
let activeTheme = 'dark';

function applyTheme(theme) {
  activeTheme = Object.hasOwn(THEME_NAMES, theme) ? theme : 'dark';
  document.documentElement.dataset.theme = activeTheme;
  for (const button of themeButtons) {
    button.setAttribute('aria-pressed', String(button.dataset.themeChoice === activeTheme));
  }
}

function closeThemePicker({ restoreFocus = false } = {}) {
  elements.themePicker.hidden = true;
  elements.themeButton.setAttribute('aria-expanded', 'false');
  if (restoreFocus) elements.themeButton.focus({ preventScroll: true });
}

function toggleThemePicker() {
  const opening = elements.themePicker.hidden;
  elements.themePicker.hidden = !opening;
  elements.themeButton.setAttribute('aria-expanded', String(opening));
  if (opening) {
    themeButtons.find((button) => button.dataset.themeChoice === activeTheme)?.focus({ preventScroll: true });
  } else {
    elements.themeButton.focus({ preventScroll: true });
  }
}

async function chooseTheme(theme) {
  if (!Object.hasOwn(THEME_NAMES, theme)) return;
  applyTheme(theme);
  closeThemePicker({ restoreFocus: true });
  setText(elements.themeAnnouncement, `${THEME_NAMES[theme]} theme applied`);

  try {
    await api.setTheme(theme);
  } catch {
    setText(elements.themeAnnouncement, `${THEME_NAMES[theme]} theme applied, but could not be saved`);
  }
}

const requestedTheme = new URLSearchParams(window.location.search).get('theme');
applyTheme(Object.hasOwn(THEME_NAMES, requestedTheme || '') ? requestedTheme : 'dark');

const state = {
  media: {
    playing: false,
    title: '',
    artist: '',
    album: '',
    source: '',
    position: 0,
    duration: 0,
    rate: 1,
    updated: 0,
  },
  lyrics: {
    key: '',
    status: 'idle',
    lines: [],
    plainText: '',
    instrumental: false,
    error: '',
  },
  system: { status: 'starting', message: '' },
  activeIndex: -1,
};

function sourceLabel(source) {
  const names = {
    'spotify.exe': 'Spotify',
    'chrome.exe': 'Chrome',
    'msedge.exe': 'Microsoft Edge',
    'firefox.exe': 'Firefox',
    'vlc.exe': 'VLC',
    'foobar2000.exe': 'foobar2000',
    'music.ui.exe': 'Music app',
    'microsoft.media.player': 'Media player',
  };
  const key = String(source || '').toLowerCase();
  if (names[key]) return names[key];
  if (!key) return 'Windows Media';
  return key.split(/[._]/).filter(Boolean).pop() || key;
}

function setText(element, text) {
  if (element.textContent !== text) element.textContent = text;
}

function playbackPosition() {
  let position = Math.max(0, Number(state.media.position) || 0);
  if (state.media.playing && state.media.updated) {
    const elapsed = Math.max(0, Date.now() - state.media.updated);
    position += elapsed * Math.max(0, Number(state.media.rate) || 1);
  }
  const durationMs = Number(state.media.duration) * 1000;
  if (durationMs > 0) position = Math.min(position, durationMs);
  return position;
}

function renderMedia() {
  const hasTrack = Boolean(state.media.title || state.media.artist);
  setText(elements.trackTitle, hasTrack ? state.media.title || 'Title unavailable' : 'No song playing');
  setText(elements.trackArtist, hasTrack ? state.media.artist || '' : 'Play music in an app or browser');
  setText(elements.sourceName, sourceLabel(state.media.source));
  elements.statusDot.className = `status-dot${state.media.playing && hasTrack ? ' playing' : hasTrack ? ' paused' : ''}`;

  if (hasTrack) {
    const position = playbackPosition();
    const minutes = Math.floor(position / 60000);
    const seconds = Math.floor((position % 60000) / 1000);
    setText(elements.positionStatus, `${minutes}:${String(seconds).padStart(2, '0')}`);
  } else {
    setText(elements.positionStatus, 'CornerLyrics');
  }

  renderLyrics();
}

function renderSystem() {
  if (state.system.status === 'error' || state.system.status === 'unsupported') {
    setText(elements.sourceName, 'Windows media unavailable');
    setText(elements.trackTitle, 'Automatic detection stopped');
    setText(elements.trackArtist, state.system.message || 'Use Windows 10 or 11.');
    elements.statusDot.className = 'status-dot';
  }
}

function renderLyrics() {
  const lyrics = state.lyrics;
  const hasTrack = Boolean(state.media.title || state.media.artist);
  const showPlain = lyrics.status === 'ready' && lyrics.lines.length === 0 && Boolean(lyrics.plainText);

  elements.syncedView.hidden = showPlain;
  elements.plainView.hidden = !showPlain;
  elements.refreshButton.classList.toggle('refreshing', lyrics.status === 'loading');

  if (state.system.status === 'error' || state.system.status === 'unsupported') {
    setText(elements.currentLine, state.system.message || 'Automatic detection is unavailable.');
    elements.currentLine.classList.add('placeholder');
    setText(elements.previousLine, '');
    setText(elements.nextLine, '');
    setText(elements.lyricsStatus, 'Check the Windows media connection');
    return;
  }

  if (!hasTrack) {
    setText(elements.previousLine, '');
    setText(elements.currentLine, 'Play a song to show lyrics…');
    elements.currentLine.classList.add('placeholder');
    setText(elements.nextLine, '');
    setText(elements.lyricsStatus, state.system.status === 'ready' ? 'Ready to read Windows media' : 'Starting app');
    return;
  }

  if (lyrics.status === 'loading') {
    setText(elements.previousLine, '');
    setText(elements.currentLine, 'Finding lyrics…');
    elements.currentLine.classList.add('placeholder');
    setText(elements.nextLine, '');
    setText(elements.lyricsStatus, 'Contacting LRCLIB');
    return;
  }

  if (lyrics.status !== 'ready') {
    const messages = {
      'not-found': 'Lyrics not found',
      'network-error': 'Lyrics connection lost',
      timeout: 'Lyrics search timed out',
      'rate-limited': 'Too many requests',
      'http-error': 'Lyrics service unavailable',
    };
    setText(elements.previousLine, '');
    setText(elements.currentLine, messages[lyrics.status] || 'Lyrics unavailable');
    elements.currentLine.classList.add('placeholder');
    setText(elements.nextLine, state.media.artist || '');
    setText(elements.lyricsStatus, lyrics.status === 'rate-limited' ? 'Try again in a moment' : 'Press the refresh button to try again');
    return;
  }

  if (lyrics.instrumental) {
    setText(elements.previousLine, '');
    setText(elements.currentLine, '♪ Instrumental ♪');
    elements.currentLine.classList.remove('placeholder');
    setText(elements.nextLine, '');
    setText(elements.lyricsStatus, 'Instrumental track');
    return;
  }

  if (showPlain) {
    setText(elements.plainView, lyrics.plainText);
    setText(elements.lyricsStatus, 'Lyrics found, but not synced');
    return;
  }

  const activeIndex = activeLineIndex(lyrics.lines, playbackPosition());
  state.activeIndex = activeIndex;
  elements.currentLine.classList.remove('placeholder');

  if (activeIndex < 0) {
    setText(elements.previousLine, '');
    setText(elements.currentLine, 'Lyrics will start shortly…');
    elements.currentLine.classList.add('placeholder');
    setText(elements.nextLine, lyrics.lines[0]?.text || '');
  } else {
    setText(elements.previousLine, lyrics.lines[activeIndex - 1]?.text || '');
    setText(elements.currentLine, lyrics.lines[activeIndex].text);
    setText(elements.nextLine, lyrics.lines[activeIndex + 1]?.text || '');
  }

  setText(elements.lyricsStatus, state.media.playing ? 'Synced with player' : 'Player paused');
}

function activeLineIndex(lines, positionMs) {
  if (!lines.length) return -1;
  const position = Math.max(0, Number(positionMs) || 0);
  let low = 0;
  let high = lines.length - 1;
  let result = -1;

  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    if (lines[middle].time <= position) {
      result = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return result;
}

api.onMediaUpdate((media) => {
  state.media = media;
  renderMedia();
  renderSystem();
});

api.onLyricsUpdate((lyrics) => {
  state.lyrics = lyrics;
  state.activeIndex = -1;
  renderLyrics();
});

api.onSystemUpdate((system) => {
  state.system = system;
  renderSystem();
  renderLyrics();
});

elements.themeButton.addEventListener('click', toggleThemePicker);
for (const button of themeButtons) {
  button.addEventListener('click', () => chooseTheme(button.dataset.themeChoice));
}

document.addEventListener('pointerdown', (event) => {
  if (!elements.themePicker.hidden && !elements.themePicker.contains(event.target) && !elements.themeButton.contains(event.target)) {
    closeThemePicker();
  }
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !elements.themePicker.hidden) {
    event.preventDefault();
    closeThemePicker({ restoreFocus: true });
  }
});

elements.refreshButton.addEventListener('click', () => {
  api.refreshLyrics();
  elements.refreshButton.classList.add('refreshing');
  setTimeout(() => elements.refreshButton.classList.remove('refreshing'), 1200);
});
elements.minimizeButton.addEventListener('click', () => api.minimizeWindow());
elements.closeButton.addEventListener('click', () => api.closeWindow());

api.getSnapshot().then((snapshot) => {
  if (!snapshot) return;
  state.media = snapshot.media;
  state.lyrics = snapshot.lyrics;
  state.system = snapshot.system;
  applyTheme(Object.hasOwn(THEME_NAMES, snapshot.theme || '') ? snapshot.theme : activeTheme);
  renderMedia();
  renderSystem();
  renderLyrics();
});

setInterval(() => {
  if (state.media.playing && state.lyrics.status === 'ready' && state.lyrics.lines.length > 0) {
    renderLyrics();
  }
}, 200);
