'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DEFAULT_THEME, THEMES, normalizeTheme, loadTheme, saveTheme } = require('../src/lib/themes.cjs');

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
  assert.deepEqual(JSON.parse(fs.readFileSync(settingsPath, 'utf8')), { theme: 'light' });
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

test('theme picker options stay in sync with the supported themes', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'index.html'), 'utf8');
  const options = [...html.matchAll(/data-theme-choice="([^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual(options, Object.keys(THEMES));
});
