'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');

const THEME_NAMES = Object.freeze({
  dark: 'Dark',
  light: 'Light',
  ocean: 'Ocean',
  sunset: 'Sunset',
});

async function main() {
  const port = Number(process.argv[2] || 9222);
  const label = process.argv[3] || 'cornerlyrics';
  const expectedInitialTheme = process.argv[4] || null;
  const outputDir = path.join(__dirname, '..', 'artifacts');
  const report = {
    label,
    expectedInitialTheme,
    initial: null,
    pickerWorks: false,
    themes: [],
    exceptions: [],
  };
  let socket;
  let nextId = 1;

  try {
    const targetsResponse = await fetch(`http://127.0.0.1:${port}/json/list`);
    if (!targetsResponse.ok) throw new Error(`CDP target list failed: ${targetsResponse.status}`);
    const targets = await targetsResponse.json();
    const target = targets.find((item) => item.type === 'page' && item.url.includes('index.html'));
    if (!target) throw new Error('Electron renderer target not found');

    socket = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      socket.addEventListener('open', resolve, { once: true });
      socket.addEventListener('error', reject, { once: true });
    });

    const pending = new Map();

    socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (message.id && pending.has(message.id)) {
        const { resolve, reject } = pending.get(message.id);
        pending.delete(message.id);
        if (message.error) reject(new Error(message.error.message));
        else resolve(message.result);
      }
      if (message.method === 'Runtime.exceptionThrown') {
        const details = message.params.exceptionDetails;
        report.exceptions.push(details.exception?.description || details.text || 'Renderer exception');
      }
      if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') {
        report.exceptions.push(`Console error: ${message.params.args.map((arg) => arg.value || arg.description).join(' ')}`);
      }
      if (message.method === 'Log.entryAdded' && message.params.entry.level === 'error') {
        report.exceptions.push(`Renderer log: ${message.params.entry.text}`);
      }
    });

    function send(method, params = {}) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        socket.send(JSON.stringify({ id, method, params }));
      });
    }

    async function evaluate(expression) {
      const response = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
      if (response.exceptionDetails) {
        const details = response.exceptionDetails;
        throw new Error(details.exception?.description || details.text || 'Renderer evaluation failed');
      }
      return response.result.value;
    }

    async function captureScreenshot(fileName) {
      const screenshot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
      await fs.writeFile(path.join(outputDir, fileName), Buffer.from(screenshot.data, 'base64'));
    }

    await send('Runtime.enable');
    await send('Page.enable');
    await send('Log.enable');
    await new Promise((resolve) => setTimeout(resolve, 2500));

    report.initial = await evaluate(`(async () => {
      const snapshot = await window.cornerLyrics.getSnapshot();
      const picker = document.getElementById('theme-picker');
      return {
        title: document.title,
        url: window.location.href,
        apiReady: Boolean(window.cornerLyrics),
        snapshotTheme: snapshot.theme,
        theme: document.documentElement.dataset.theme,
        pickerHidden: picker.hidden,
        cardHeight: document.querySelector('.lyrics-card').getBoundingClientRect().height,
        text: document.body.innerText,
        alwaysOnTopNote: 'Configured in BrowserWindow'
      };
    })()`);

    assert.equal(report.initial.apiReady, true, 'Preload API is unavailable');
    assert.equal(report.initial.pickerHidden, true, 'Theme picker should be hidden by default');
    assert.ok(report.initial.cardHeight > 0 && report.initial.cardHeight < 200, 'Overlay should stay compact');
    assert.equal(report.initial.snapshotTheme, report.initial.theme, 'Initial DOM and saved theme should match');
    if (expectedInitialTheme) {
      assert.equal(report.initial.theme, expectedInitialTheme, 'Saved theme was not restored after restart');
    }
    await captureScreenshot(`${label}-preview.png`);

    await evaluate(`state.media = {
      playing: true,
      title: 'Apocalypse',
      artist: 'Cigarettes After Sex',
      album: 'Cigarettes After Sex',
      source: 'spotify.exe',
      position: 73240,
      duration: 279,
      rate: 1,
      updated: Date.now()
    };
    state.lyrics = {
      key: 'preview',
      status: 'ready',
      lines: [
        { time: 61000, text: "Thought you'd sing a love song" },
        { time: 69000, text: 'But you never did' },
        { time: 76000, text: 'And the world keeps turning' },
        { time: 84000, text: 'While I stand here still' }
      ],
      plainText: '',
      instrumental: false,
      error: ''
    };
    state.system = { status: 'ready', message: '' };
    renderMedia();
    renderSystem();
    renderLyrics();`);

    const picker = await evaluate(`(() => {
      const button = document.getElementById('theme-button');
      const picker = document.getElementById('theme-picker');
      button.click();
      const pickerRect = picker.getBoundingClientRect();
      const cardRect = document.querySelector('.lyrics-card').getBoundingClientRect();
      return {
        open: !picker.hidden && button.getAttribute('aria-expanded') === 'true',
        optionNames: [...picker.querySelectorAll('[data-theme-choice]')].map((option) => option.textContent.trim()),
        fitsOverlay: pickerRect.left >= cardRect.left && pickerRect.right <= cardRect.right &&
          pickerRect.top >= cardRect.top && pickerRect.bottom <= cardRect.bottom
      };
    })()`);

    assert.equal(picker.open, true, 'Theme picker did not open');
    assert.deepEqual(picker.optionNames, Object.values(THEME_NAMES));
    assert.equal(picker.fitsOverlay, true, 'Theme picker does not fit inside the overlay');
    report.pickerWorks = true;

    for (const theme of Object.keys(THEME_NAMES)) {
      await evaluate(`document.querySelector('[data-theme-choice="${theme}"]').click()`);
      await new Promise((resolve) => setTimeout(resolve, 150));
      const result = await evaluate(`(() => {
        const option = document.querySelector('[data-theme-choice="${theme}"]');
        const rootStyle = getComputedStyle(document.documentElement);
        const cardStyle = getComputedStyle(document.querySelector('.lyrics-card'));
        return {
          theme: document.documentElement.dataset.theme,
          pressed: option.getAttribute('aria-pressed'),
          pickerHidden: document.getElementById('theme-picker').hidden,
          textColor: rootStyle.color,
          cardColor: cardStyle.backgroundColor,
          currentLine: document.getElementById('current-line').textContent
        };
      })()`);

      assert.equal(result.theme, theme, `${THEME_NAMES[theme]} was not applied`);
      assert.equal(result.pressed, 'true', `${THEME_NAMES[theme]} was not marked selected`);
      assert.equal(result.pickerHidden, true, 'Picker should close after selection');
      report.themes.push({ name: THEME_NAMES[theme], ...result });
      await captureScreenshot(`${label}-theme-${theme}.png`);
    }

    assert.equal(new Set(report.themes.map((theme) => `${theme.textColor}|${theme.cardColor}`)).size, 4,
      'Every theme should have a distinct appearance');

    await fs.mkdir(outputDir, { recursive: true });
    report.checkedAt = new Date().toISOString();
    await fs.writeFile(
      path.join(outputDir, `${label}-smoke.json`),
      `${JSON.stringify(report, null, 2)}\n`,
      'utf8',
    );

    assert.deepEqual(report.exceptions, [], 'Renderer exceptions or console errors were reported');
    console.log(JSON.stringify(report, null, 2));
  } catch (error) {
    await fs.mkdir(outputDir, { recursive: true });
    report.failure = error.message;
    await fs.writeFile(
      path.join(outputDir, `${label}-smoke.json`),
      `${JSON.stringify(report, null, 2)}\n`,
      'utf8',
    );
    throw error;
  } finally {
    if (socket && socket.readyState === WebSocket.OPEN) {
      try {
        const id = nextId++;
        socket.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression: 'window.cornerLyrics.closeWindow()' } }));
      } catch {
        // The app may already have closed after a failed smoke test.
      }
      socket.close();
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
