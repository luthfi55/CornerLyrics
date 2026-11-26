'use strict';

// Drives a REAL OS-level mouse click (user32 SendInput) at the Show-header
// button / lyrics card, then checks the renderer state over CDP. Unlike CDP
// Input.dispatchMouseEvent, this exercises the native hit-testing path
// (frameless resize borders + -webkit-app-region drag capture) that swallows
// clicks in real Windows use.
//
// Usage: node scripts/native-click.cjs <port> <button|drag> [outLabel]

const fs = require('node:fs/promises');
const path = require('node:path');
const { execFile } = require('node:child_process');

function powershell(scriptPath, args) {
  return new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath, ...args],
      { windowsHide: true },
      (error, stdout, stderr) => {
        if (error) reject(new Error(`${error.message}\n${stderr}`));
        else resolve(stdout.trim());
      },
    );
  });
}

async function main() {
  const port = Number(process.argv[2] || 9222);
  const mode = process.argv[3] || 'button';
  const outLabel = process.argv[4] || `native-${mode}`;
  const outputDir = path.join(__dirname, '..', 'artifacts');
  const report = { mode, port, before: null, after: null, click: null, pass: false };
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
    });
    const send = (method, params = {}) =>
      new Promise((resolve, reject) => {
        const id = nextId++;
        pending.set(id, { resolve, reject });
        socket.send(JSON.stringify({ id, method, params }));
      });
    const evaluate = async (expression) => {
      const result = await send('Runtime.evaluate', { expression, returnByValue: true });
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || 'evaluate failed');
      return result.result.value;
    };
    const readState = () => evaluate(`(() => ({
      headerHidden: document.querySelector('.lyrics-card').classList.contains('header-hidden'),
      restoreHidden: document.getElementById('show-header-button').hidden,
      screenX: window.screenX,
      screenY: window.screenY
    }))()`);

    report.before = await readState();
    if (!report.before.headerHidden) {
      // Set up: hide the header through the app's own control (synthetic click
      // is fine for setup; the assertion under test is the native click).
      const hideRect = await evaluate(`(() => {
        const rect = document.getElementById('hide-header-button').getBoundingClientRect();
        return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
      })()`);
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: hideRect.x, y: hideRect.y, button: 'none' });
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: hideRect.x, y: hideRect.y, button: 'left', clickCount: 1 });
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: hideRect.x, y: hideRect.y, button: 'left', clickCount: 1 });
      await new Promise((resolve) => setTimeout(resolve, 400));
      report.before = await readState();
      if (!report.before.headerHidden) throw new Error('setup failed: header did not hide');
    }

    const geometry = await evaluate(`(() => {
      const button = document.getElementById('show-header-button');
      const card = document.querySelector('.lyrics-card');
      const view = document.querySelector('.lyrics-card.header-hidden .synced-view');
      const buttonRect = button.getBoundingClientRect();
      const cardRect = card.getBoundingClientRect();
      const viewRect = view.getBoundingClientRect();
      return {
        screenX: window.screenX,
        screenY: window.screenY,
        dpr: window.devicePixelRatio,
        button: { left: buttonRect.left, top: buttonRect.top, width: buttonRect.width, height: buttonRect.height },
        view: { left: viewRect.left, top: viewRect.top, width: viewRect.width, height: viewRect.height },
        card: { left: cardRect.left, top: cardRect.top, width: cardRect.width, height: cardRect.height },
      };
    })()`);
    report.geometry = geometry;

    const hitTarget = mode === 'drag' ? geometry.view : geometry.button;
    const dipX = geometry.screenX + hitTarget.left + hitTarget.width / 2;
    const dipY = geometry.screenY + hitTarget.top + hitTarget.height / 2;
    const physicalX = Math.round(dipX * geometry.dpr);
    const physicalY = Math.round(dipY * geometry.dpr);
    report.click = { dipX, dipY, physicalX, physicalY, dpr: geometry.dpr };

    const clickScript = path.join(__dirname, 'native-click.ps1');
    const clickArgs = ['-X', String(physicalX), '-Y', String(physicalY)];
    const DRAG_DX_PHYSICAL = 80;
    const DRAG_DY_PHYSICAL = 40;
    if (mode === 'drag') {
      // Relative SendInput deltas are DPI-scaled mickeys: at dpr 2, one raw unit
      // moves the cursor two physical pixels. Divide by dpr so the cursor (and
      // the window following it) travels exactly DRAG_*_PHYSICAL pixels.
      clickArgs.push(
        '-DragDx', String(Math.round(DRAG_DX_PHYSICAL / geometry.dpr)),
        '-DragDy', String(Math.round(DRAG_DY_PHYSICAL / geometry.dpr)),
      );
    }
    report.nativeOutput = await powershell(clickScript, clickArgs);

    await new Promise((resolve) => setTimeout(resolve, 600));
    report.after = await readState();
    if (mode === 'drag') {
      // Native caption drag: the window must travel WITH the cursor in the
      // drag direction and nothing may toggle. Relative mickeys pass through
      // the OS pointer-acceleration curve, so the exact distance is not
      // reproducible; assert meaningful same-direction travel instead.
      const expectedDx = DRAG_DX_PHYSICAL / geometry.dpr;
      const expectedDy = DRAG_DY_PHYSICAL / geometry.dpr;
      const actualDx = report.after.screenX - report.before.screenX;
      const actualDy = report.after.screenY - report.before.screenY;
      report.drag = { expectedDx, expectedDy, actualDx, actualDy };
      report.pass = report.after.headerHidden === true
        && report.after.restoreHidden === false
        && actualDx >= 15
        && actualDy >= 6;
    } else {
      report.pass = report.after.headerHidden === false && report.after.restoreHidden === true;
    }
  } catch (error) {
    report.error = error.message;
  } finally {
    if (socket && socket.readyState === WebSocket.OPEN) socket.close();
  }

  await fs.mkdir(outputDir, { recursive: true });
  await fs.writeFile(
    path.join(outputDir, `${outLabel}-native-click.json`),
    `${JSON.stringify(report, null, 2)}\n`,
    'utf8',
  );
  console.log(JSON.stringify(report, null, 2));
  process.exitCode = report.pass ? 0 : 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
