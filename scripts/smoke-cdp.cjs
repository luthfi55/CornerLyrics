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
    headerToggleWorks: false,
    themes: [],
    eyeThemes: [],
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
        snapshotHeaderVisible: snapshot.headerVisible,
        headerHidden: document.querySelector('.lyrics-card').classList.contains('header-hidden'),
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
    assert.equal(report.initial.headerHidden, !report.initial.snapshotHeaderVisible, 'Initial header visibility should match saved settings');
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

    await evaluate(`document.getElementById('hide-header-button').click()`);
    await new Promise((resolve) => setTimeout(resolve, 300));
    const hiddenHeader = await evaluate(`(() => {
      const card = document.querySelector('.lyrics-card');
      const body = document.querySelector('.lyrics-card.header-hidden .lyrics-body');
      const restore = document.getElementById('show-header-button');
      const bodyStyle = getComputedStyle(body);
      const restoreStyle = getComputedStyle(restore);
      const cardStyle = getComputedStyle(card);
      return {
        hidden: card.classList.contains('header-hidden'),
        headerDisplay: getComputedStyle(document.querySelector('.track-header')).display,
        footerDisplay: getComputedStyle(document.querySelector('.lyrics-footer')).display,
        restoreHidden: restore.hidden,
        cardHeight: card.getBoundingClientRect().height,
        cardAppRegion: cardStyle.getPropertyValue('-webkit-app-region').trim(),
        cardCursor: cardStyle.cursor,
        bodyAppRegion: bodyStyle.getPropertyValue('-webkit-app-region').trim(),
        bodyCursor: bodyStyle.cursor,
        buttonAppRegion: restoreStyle.getPropertyValue('-webkit-app-region').trim(),
        currentLine: document.getElementById('current-line').textContent
      };
    })()`);

    assert.equal(hiddenHeader.hidden, true, 'Hide Header should add the compact layout class');
    assert.equal(hiddenHeader.headerDisplay, 'none', 'Track header should be hidden');
    assert.equal(hiddenHeader.footerDisplay, 'none', 'Footer should be hidden with the header');
    assert.equal(hiddenHeader.restoreHidden, false, 'Show Header control should be available');
    assert.ok(hiddenHeader.cardHeight <= 110, 'Hidden-header layout should shrink the window');
    assert.equal(
      hiddenHeader.cardAppRegion,
      'no-drag',
      'The lyrics-only card itself must stay out of the caption region so the restore button remains a real click target',
    );
    assert.equal(
      hiddenHeader.bodyAppRegion,
      'drag',
      'The lyric body must become the native caption drag region in hidden mode',
    );
    assert.equal(
      hiddenHeader.bodyCursor,
      'default',
      'Dragging the lyrics must keep the default arrow cursor, not the move crosshair',
    );
    assert.equal(
      hiddenHeader.buttonAppRegion,
      'no-drag',
      'The Show-header button must declare its own no-drag region: descendant carve-outs win, so real clicks reach it even inside the drag body',
    );
    assert.equal(
      hiddenHeader.cardCursor,
      'default',
      'The hidden card must keep the default arrow cursor',
    );
    report.nativeRegions = {
      cardAppRegion: hiddenHeader.cardAppRegion,
      cardCursor: hiddenHeader.cardCursor,
      bodyAppRegion: hiddenHeader.bodyAppRegion,
      bodyCursor: hiddenHeader.bodyCursor,
      buttonAppRegion: hiddenHeader.buttonAppRegion,
    };
    assert.ok(hiddenHeader.currentLine.length > 0, 'Lyrics should remain visible');


    const restoreButton = await evaluate(`(() => {
      const button = document.getElementById('show-header-button');
      const style = getComputedStyle(button);
      const pill = getComputedStyle(button, '::before');
      const rect = button.getBoundingClientRect();
      const card = document.querySelector('.lyrics-card').getBoundingClientRect();
      return {
        hidden: button.hidden,
        display: style.display,
        visibility: style.visibility,
        opacity: style.opacity,
        pointerEvents: style.pointerEvents,
        appRegion: style.getPropertyValue('-webkit-app-region').trim(),
        zIndex: style.zIndex,
        pillBorderWidth: parseFloat(pill.borderTopWidth),
        pillBackground: pill.backgroundColor,
        width: rect.width,
        height: rect.height,
        topGap: rect.top - card.top,
        rightGap: card.right - rect.right,
        svg: (() => {
          const icon = button.querySelector('svg');
          const iconStyle = getComputedStyle(icon);
          const iconRect = icon.getBoundingClientRect();
          return {
            computedWidth: iconStyle.width,
            computedHeight: iconStyle.height,
            rootText: getComputedStyle(document.documentElement).color,
            fill: iconStyle.fill,
            stroke: iconStyle.stroke,
            strokeWidth: iconStyle.strokeWidth,
            position: iconStyle.position,
            zIndex: iconStyle.zIndex,
            rectWidth: iconRect.width,
            rectHeight: iconRect.height
          };
        })()
      };
    })()`);

    assert.equal(restoreButton.hidden, false, 'Show Header control must be present in hidden mode');
    assert.notEqual(restoreButton.display, 'none', 'Show Header control must render in hidden mode');
    assert.equal(restoreButton.visibility, 'visible', 'Show Header control must be visible without hover');
    assert.ok(
      Number.parseFloat(restoreButton.opacity) >= 0.9,
      'Show Header control must not stay transparent without hover',
    );
    assert.equal(restoreButton.pointerEvents, 'auto', 'Show Header hit box must receive pointer events');
    assert.equal(restoreButton.appRegion, 'no-drag', 'Show Header hit box must sit outside the drag region');
    assert.ok(
      Number.parseInt(restoreButton.zIndex, 10) >= 10,
      'Show Header hit box must sit above every other overlay',
    );
    assert.ok(
      restoreButton.pillBorderWidth >= 1 && !['rgba(0, 0, 0, 0)', 'transparent'].includes(restoreButton.pillBackground),
      'Show Header pill must stay visible inside the oversized hit box',
    );
    assert.ok(
      restoreButton.width >= 40 && restoreButton.height >= 40,
      `Show Header hit box must be oversized for reliable clicks (got ${restoreButton.width}x${restoreButton.height})`,
    );
    assert.ok(restoreButton.topGap <= 1, 'Show Header hit box must touch the top edge');
    assert.ok(restoreButton.rightGap <= 1, 'Show Header hit box must touch the right edge');

    const eye = restoreButton.svg;
    assert.equal(eye.computedWidth, '16px', 'Eye icon must compute to its explicit 16px size');
    assert.equal(eye.computedHeight, '16px', 'Eye icon must compute to its explicit 16px size');
    assert.equal(eye.fill, 'none', 'Eye glyph must stay an unfilled outline');
    assert.notEqual(eye.stroke, 'none', 'Eye glyph must inherit a visible stroke color');
    assert.equal(eye.strokeWidth, '2px', 'Eye stroke must stay thick enough to read');
    assert.ok(['relative', 'absolute', 'fixed'].includes(eye.position), 'Eye svg must be positioned to paint above the pill');
    assert.ok(Number.parseInt(eye.zIndex, 10) >= 1, 'Eye svg must sit above the ::before pill');
    assert.ok(eye.rectWidth >= 14 && eye.rectHeight >= 14, 'Eye glyph must be a real rendered box, not clipped away');

    // Round 3: prove the eye glyph itself renders at full foreground
    // contrast on every theme while hidden.
    for (const theme of ['dark', 'light', 'ocean', 'sunset']) {
      await evaluate(`document.querySelector('[data-theme-choice="${theme}"]').click()`);
      await new Promise((resolve) => setTimeout(resolve, 150));
      const eyeTheme = await evaluate(`(() => {
        const rootStyle = getComputedStyle(document.documentElement);
        const iconStyle = getComputedStyle(document.querySelector('#show-header-button svg'));
        return { rootText: rootStyle.color, stroke: iconStyle.stroke };
      })()`);
      assert.equal(eyeTheme.stroke, eyeTheme.rootText, `${theme}: eye glyph must draw at full foreground contrast`);
      report.eyeThemes.push(eyeTheme);
      await captureScreenshot(`${label}-eye-${theme}.png`);
    }
    report.restoreButton = restoreButton;
    await captureScreenshot(`${label}-header-hidden.png`);

    // Hide again so the corner-button click path runs from the same state.
    await evaluate(`document.getElementById('hide-header-button').click()`);
    await new Promise((resolve) => setTimeout(resolve, 300));

    const restoreCenter = await evaluate(`(() => {
      const rect = document.getElementById('show-header-button').getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    })()`);
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: restoreCenter.x, y: restoreCenter.y, button: 'none' });
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: restoreCenter.x, y: restoreCenter.y, button: 'left', clickCount: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: restoreCenter.x, y: restoreCenter.y, button: 'left', clickCount: 1 });
    await new Promise((resolve) => setTimeout(resolve, 300));
    const shownHeader = await evaluate(`(() => ({
      hidden: document.querySelector('.lyrics-card').classList.contains('header-hidden'),
      restoreHidden: document.getElementById('show-header-button').hidden,
      cardHeight: document.querySelector('.lyrics-card').getBoundingClientRect().height
    }))()`);

    assert.equal(shownHeader.hidden, false, 'Show Header should restore the full layout');
    assert.equal(shownHeader.restoreHidden, true, 'Show Header control should hide again');
    assert.ok(shownHeader.cardHeight >= 140, 'Full layout should restore the expanded height');
    report.headerToggleWorks = true;

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
