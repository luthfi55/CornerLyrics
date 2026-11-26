'use strict';

const assert = require('node:assert/strict');

async function main() {
  const port = Number(process.argv[2] || 9231);
  const mode = process.argv[3] || 'hide';
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const target = targets.find((item) => item.type === 'page' && item.url.includes('index.html'));
  if (!target) throw new Error('Renderer target not found');

  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });

  let nextId = 1;
  const pending = new Map();
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (!message.id || !pending.has(message.id)) return;
    const { resolve, reject } = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) reject(new Error(message.error.message));
    else resolve(message.result);
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
    if (response.exceptionDetails) throw new Error(response.exceptionDetails.text || 'Renderer evaluation failed');
    return response.result.value;
  }

  if (mode === 'hide') {
    await evaluate(`document.getElementById('hide-header-button').click()`);
    await new Promise((resolve) => setTimeout(resolve, 350));
  }

  const result = await evaluate(`(async () => {
    const snapshot = await window.cornerLyrics.getSnapshot();
    return {
      headerVisible: snapshot.headerVisible,
      headerHidden: document.querySelector('.lyrics-card').classList.contains('header-hidden'),
      cardHeight: document.querySelector('.lyrics-card').getBoundingClientRect().height,
      headerDisplay: getComputedStyle(document.querySelector('.track-header')).display,
      footerDisplay: getComputedStyle(document.querySelector('.lyrics-footer')).display
    };
  })()`);

  if (mode === 'hide') assert.equal(result.headerVisible, false, 'Header setting was not saved');
  if (mode === 'verify') assert.equal(result.headerVisible, false, 'Header setting was not restored');
  assert.equal(result.headerHidden, true, 'Compact layout is not active');
  assert.equal(result.headerDisplay, 'none', 'Header is still visible');
  assert.equal(result.footerDisplay, 'none', 'Footer is still visible');
  assert.ok(result.cardHeight <= 100, 'Compact layout did not shrink');

  console.log(JSON.stringify({ mode, ...result }, null, 2));
  await evaluate('window.cornerLyrics.closeWindow()');
  socket.close();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
