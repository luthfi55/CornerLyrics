'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  DEFAULT_THEME,
  DEFAULT_HEADER_VISIBLE,
  THEMES,
  normalizeTheme,
  normalizeHeaderVisible,
  loadSettings,
  saveSettings,
  loadTheme,
  saveTheme,
} = require('../src/lib/themes.cjs');

test('provides the four supported English theme names', () => {
  assert.deepEqual(THEMES, {
    dark: 'Dark',
    light: 'Light',
    ocean: 'Ocean',
    sunset: 'Sunset',
  });
  assert.equal(DEFAULT_THEME, 'dark');
});

test('normalizes valid values and rejects unknown or unsafe theme names', () => {
  assert.equal(normalizeTheme(' OCEAN '), 'ocean');
  assert.equal(normalizeTheme('sunset'), 'sunset');
  assert.equal(normalizeTheme('neon'), DEFAULT_THEME);
  assert.equal(normalizeTheme('__proto__'), DEFAULT_THEME);
  assert.equal(normalizeTheme(null), DEFAULT_THEME);
});

test('persists and reloads a theme from the supplied app-data directory', (t) => {
  const dataDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'cornerlyrics-themes-'));
  t.after(() => fs.rmSync(dataDirectory, { recursive: true, force: true }));
  const settingsPath = path.join(dataDirectory, 'settings.json');

  assert.equal(saveTheme(settingsPath, 'light'), 'light');
  assert.deepEqual(JSON.parse(fs.readFileSync(settingsPath, 'utf8')), { theme: 'light', headerVisible: true });
  assert.equal(loadTheme(settingsPath), 'light');
});

test('falls back to Dark when settings are missing, invalid, or unknown', (t) => {
  const dataDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'cornerlyrics-themes-'));
  t.after(() => fs.rmSync(dataDirectory, { recursive: true, force: true }));
  const settingsPath = path.join(dataDirectory, 'settings.json');

  assert.equal(loadTheme(settingsPath), DEFAULT_THEME);
  fs.writeFileSync(settingsPath, '{not json', 'utf8');
  assert.equal(loadTheme(settingsPath), DEFAULT_THEME);
  fs.writeFileSync(settingsPath, JSON.stringify({ theme: 'neon' }), 'utf8');
  assert.equal(loadTheme(settingsPath), DEFAULT_THEME);
});

test('header visibility defaults to shown and only accepts booleans', () => {
  assert.equal(DEFAULT_HEADER_VISIBLE, true);
  assert.equal(normalizeHeaderVisible(false), false);
  assert.equal(normalizeHeaderVisible(true), true);
  assert.equal(normalizeHeaderVisible('false'), DEFAULT_HEADER_VISIBLE);
  assert.equal(normalizeHeaderVisible(null), DEFAULT_HEADER_VISIBLE);
});

test('saves theme and header visibility together without dropping either setting', (t) => {
  const dataDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'cornerlyrics-settings-'));
  t.after(() => fs.rmSync(dataDirectory, { recursive: true, force: true }));
  const settingsPath = path.join(dataDirectory, 'settings.json');

  assert.deepEqual(saveSettings(settingsPath, { theme: 'ocean', headerVisible: false }), {
    theme: 'ocean',
    headerVisible: false,
  });
  assert.deepEqual(saveSettings(settingsPath, { theme: 'sunset' }), {
    theme: 'sunset',
    headerVisible: false,
  });
  assert.deepEqual(loadSettings(settingsPath), { theme: 'sunset', headerVisible: false });
});

test('theme picker options stay in sync with the supported themes', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'index.html'), 'utf8');
  const options = [...html.matchAll(/data-theme-choice="([^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual(options, Object.keys(THEMES));
});

test('renderer exposes both hide-header and show-header controls', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'index.html'), 'utf8');
  assert.match(html, /id="hide-header-button"/);
  assert.match(html, /id="show-header-button"/);
});
