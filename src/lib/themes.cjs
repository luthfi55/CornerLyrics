'use strict';

const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_THEME = 'dark';
const THEMES = Object.freeze({
  dark: 'Dark',
  light: 'Light',
  ocean: 'Ocean',
  sunset: 'Sunset',
});

function normalizeTheme(value) {
  const theme = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return Object.hasOwn(THEMES, theme) ? theme : DEFAULT_THEME;
}

function loadTheme(filePath) {
  try {
    const settings = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return normalizeTheme(settings?.theme);
  } catch {
    return DEFAULT_THEME;
  }
}

function saveTheme(filePath, value) {
  const theme = normalizeTheme(value);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify({ theme }, null, 2)}\n`, 'utf8');
  return theme;
}

module.exports = { DEFAULT_THEME, THEMES, normalizeTheme, loadTheme, saveTheme };
