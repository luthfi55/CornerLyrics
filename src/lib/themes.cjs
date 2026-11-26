'use strict';

const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_THEME = 'dark';
const DEFAULT_HEADER_VISIBLE = true;
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

function normalizeHeaderVisible(value) {
  return typeof value === 'boolean' ? value : DEFAULT_HEADER_VISIBLE;
}

function loadSettings(filePath) {
  try {
    const settings = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return {
      theme: normalizeTheme(settings?.theme),
      headerVisible: normalizeHeaderVisible(settings?.headerVisible),
    };
  } catch {
    return { theme: DEFAULT_THEME, headerVisible: DEFAULT_HEADER_VISIBLE };
  }
}

function saveSettings(filePath, value) {
  const current = loadSettings(filePath);
  const settings = {
    theme: normalizeTheme(value?.theme ?? current.theme),
    headerVisible: normalizeHeaderVisible(value?.headerVisible ?? current.headerVisible),
  };
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
  return settings;
}

function loadTheme(filePath) {
  return loadSettings(filePath).theme;
}

function saveTheme(filePath, value) {
  return saveSettings(filePath, { theme: value }).theme;
}

module.exports = {
  DEFAULT_THEME,
  DEFAULT_HEADER_VISIBLE,
  THEMES,
  normalizeTheme,
  normalizeHeaderVisible,
  loadSettings,
  saveSettings,
  loadTheme,
  saveTheme,
};
