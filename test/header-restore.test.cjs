'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const rendererDir = path.join(__dirname, '..', 'src', 'renderer');
// Strip comments so selector/declaration parsing stays robust regardless of
// where explanatory comments sit relative to the rules they describe.
const css = fs.readFileSync(path.join(rendererDir, 'styles.css'), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '');
const html = fs.readFileSync(path.join(rendererDir, 'index.html'), 'utf8');
const js = fs.readFileSync(path.join(rendererDir, 'renderer.js'), 'utf8');

function parseRules(source) {
  const rules = [];
  const pattern = /([^{}]+)\{([^{}]*)\}/g;
  let match;
  while ((match = pattern.exec(source))) {
    rules.push({ selector: match[1].trim(), declarations: match[2] });
  }
  return rules;
}

const rules = parseRules(css);

function ruleFor(selector) {
  return rules.find((rule) =>
    rule.selector.split(',').some((part) => part.trim() === selector),
  );
}

function declarationsOf(rule) {
  const declarations = new Map();
  for (const chunk of rule.declarations.split(';')) {
    const colon = chunk.indexOf(':');
    if (colon === -1) continue;
    declarations.set(chunk.slice(0, colon).trim(), chunk.slice(colon + 1).trim());
  }
  return declarations;
}

test('show-header button exposes a large hit area pinned to the top-right corner', () => {
  const rule = ruleFor('.icon-button.header-restore');
  assert.ok(rule, 'styles.css must define an .icon-button.header-restore rule');
  const declarations = declarationsOf(rule);

  assert.equal(declarations.get('position'), 'absolute', 'button must be absolutely positioned');
  assert.equal(declarations.get('top'), '0', 'button must touch the top edge of the card');
  assert.equal(declarations.get('right'), '0', 'button must touch the right edge of the card');
  assert.ok(
    Number.parseFloat(declarations.get('width')) >= 40,
    'transparent hit area must be at least 40px wide',
  );
  assert.ok(
    Number.parseFloat(declarations.get('height')) >= 40,
    'transparent hit area must be at least 40px tall',
  );
  assert.ok(
    Number(declarations.get('z-index')) >= 10,
    'button must sit above every other overlay layer',
  );
  assert.equal(
    declarations.get('pointer-events'),
    'auto',
    'button must explicitly receive pointer events',
  );
  assert.equal(
    declarations.get('-webkit-app-region'),
    'no-drag',
    'button must explicitly opt out of the drag region',
  );
  assert.equal(
    declarations.get('background'),
    'transparent',
    'the oversized hit box itself must stay visually silent',
  );
});

test('show-header button keeps a compact visible pill while the hit box grows', () => {
  const rule = ruleFor('.icon-button.header-restore::before');
  assert.ok(rule, 'styles.css must define an .icon-button.header-restore::before rule');
  const declarations = declarationsOf(rule);

  assert.ok(
    Number.parseFloat(declarations.get('inset')) <= 10,
    'the painted pill must stay compact inside the oversized hit box',
  );
  assert.ok(declarations.has('border'), 'the pill must carry a visible border on every theme');
  assert.ok(
    declarations.get('background') && declarations.get('background') !== 'transparent',
    'the pill must carry a readable background',
  );
});

test('hidden-mode card stays clickable while the lyric body becomes the drag region', () => {
  const hiddenCard = ruleFor('.lyrics-card.header-hidden');
  assert.ok(hiddenCard, 'styles.css must define a .lyrics-card.header-hidden rule');
  assert.equal(
    declarationsOf(hiddenCard).get('-webkit-app-region'),
    'no-drag',
    'the lyrics-only card must avoid native caption hit-testing so buttons remain clickable',
  );
  assert.equal(declarationsOf(hiddenCard).get('cursor'), 'default');

  const iconButton = ruleFor('.icon-button');
  assert.ok(iconButton, 'styles.css must define an .icon-button rule');
  assert.equal(
    declarationsOf(iconButton).get('-webkit-app-region'),
    'no-drag',
    'icon buttons must opt out of the draggable card',
  );
  assert.match(
    html,
    /<button id="show-header-button" class="icon-button header-restore"/,
    'the show-header button must reuse the icon-button styling and no-drag behavior',
  );
});

test('show-header button is visible immediately in hidden mode, without hover', () => {
  const rule = ruleFor('.icon-button.header-restore');
  assert.ok(rule, 'styles.css must define an .icon-button.header-restore rule');
  const declarations = declarationsOf(rule);

  assert.ok(
    !declarations.has('opacity') || Number.parseFloat(declarations.get('opacity')) > 0,
    'button must not default to opacity 0',
  );

  for (const candidate of rules) {
    for (const part of candidate.selector.split(',')) {
      if (!part.includes('.header-restore')) continue;
      assert.ok(
        !part.includes(':hover') && !part.includes(':focus-within'),
        `button visibility must not depend on pointer state, found selector: ${part.trim()}`,
      );
    }
  }
});

test('hidden-mode lyric body is the native drag region and no custom drag remains', () => {
  const bodyRule = ruleFor('.lyrics-card.header-hidden .lyrics-body');
  assert.ok(
    bodyRule,
    'styles.css must define the hidden-mode lyric body rule that carries the caption',
  );
  const bodyDecls = declarationsOf(bodyRule);
  assert.equal(
    bodyDecls.get('-webkit-app-region'),
    'drag',
    'the lyric body must become the native caption drag region in hidden mode',
  );
  assert.equal(
    bodyDecls.get('cursor'),
    'default',
    'dragging the lyrics must show the default arrow cursor, not the move crosshair',
  );

  // The restore button must be a DESCENDANT of the drag element: Windows only
  // carves a no-drag hole out of a caption for descendants, never for sibling
  // overlays (verified via WM_NCHITTEST in round 5).
  const bodyMatch = /<div class="lyrics-body">[\s\S]*?<button id="show-header-button"/.exec(html);
  assert.ok(
    bodyMatch,
    'index.html must nest the show-header button inside .lyrics-body',
  );
  const viewsInsideBody = /<div class="lyrics-body">[\s\S]*?<section id="synced-view"[\s\S]*?<section id="plain-view"/.exec(html);
  assert.ok(viewsInsideBody, 'index.html must nest both lyric views inside .lyrics-body');

  // The views themselves must NOT declare a drag region: sibling no-drag
  // overlays lose to drag regions, so the button hole depends on the body.
  const viewRule = ruleFor('.lyrics-card.header-hidden .synced-view');
  assert.ok(viewRule, 'styles.css must keep the hidden-mode lyric view layout rule');
  const viewDecls = declarationsOf(viewRule);
  assert.notEqual(
    viewDecls.get('-webkit-app-region'),
    'drag',
    'the lyric views must not carry their own drag region; the body owns it',
  );

  const baseBodyRule = ruleFor('.lyrics-body');
  assert.ok(baseBodyRule, 'styles.css must define the base .lyrics-body layout rule');
  assert.equal(
    declarationsOf(baseBodyRule).get('position'),
    'relative',
    'the body must be the positioned anchor for the corner restore button',
  );

  // No renderer drag machinery may remain.
  assert.doesNotMatch(
    js,
    /headerDrag|pendingWindowPosition|flushPendingWindowPosition|setPointerCapture/,
    'the custom pointer-drag machinery must be gone',
  );
  assert.doesNotMatch(
    js,
    /elements\.lyricsCard\.addEventListener\('pointerdown'|elements\.lyricsCard\.addEventListener\('dblclick'/,
    'the card itself must not intercept presses or double-clicks',
  );
  assert.doesNotMatch(
    js,
    /elements\.showHeaderButton\.addEventListener\(eventName/,
    'no stopPropagation shield is needed once the button is real client area',
  );
  assert.doesNotMatch(js, /api\.moveWindow\(/, 'the renderer must not move the window over IPC');

  const mainJs = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.cjs'), 'utf8');
  assert.doesNotMatch(mainJs, /window:move/, 'main.cjs must not expose a window:move IPC channel');
  const preloadJs = fs.readFileSync(path.join(__dirname, '..', 'src', 'preload.cjs'), 'utf8');
  assert.doesNotMatch(preloadJs, /moveWindow/, 'preload must not bridge a window move API');
});

test('renderer only hides the show-header button while the header is visible', () => {
  assert.match(
    html,
    /id="show-header-button"[^>]* aria-label="Show header"[^>]* hidden/,
    'button must ship hidden and expose an English accessible name',
  );
  assert.match(js, /elements\.showHeaderButton\.hidden = state\.headerVisible;/);
  assert.match(js, /elements\.showHeaderButton\.addEventListener\('click', \(\) => setHeaderVisibility\(true\)\);/);

  const hiddenRule = ruleFor('.header-restore[hidden]');
  assert.ok(hiddenRule, 'styles.css must keep the hidden attribute authoritative');
  assert.equal(declarationsOf(hiddenRule).get('display'), 'none');
});

test('eye icon is layered above the pill and carries explicit rendering attributes', () => {
  // The compact pill is painted by an absolutely-positioned ::before, which
  // would cover a non-positioned inline svg. The icon must be re-layered.
  assert.match(
    html,
    /<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"/,
    'index.html must ship the eye svg with explicit size, fill, stroke and stroke-width attributes',
  );

  const svgRule = ruleFor('.icon-button.header-restore svg');
  assert.ok(svgRule, 'styles.css must re-layer the header-restore svg above the ::before pill');
  const svgDecls = declarationsOf(svgRule);
  assert.ok(['relative', 'absolute', 'fixed'].includes(svgDecls.get('position')), 'svg must be positioned so it paints above the ::before pill');
  assert.ok(parseInt(svgDecls.get('z-index'), 10) >= 1, 'svg must sit in a stacking slot above the pill');
  assert.equal(svgDecls.get('stroke-width'), '2', 'stroke must stay thick enough at 16px');
  assert.ok(parseInt(svgDecls.get('width'), 10) >= 14, 'icon must remain legibly sized');
  assert.ok(parseInt(svgDecls.get('height'), 10) >= 14, 'icon must remain legibly sized');
  assert.equal(svgDecls.get('color'), 'var(--text)', 'glyph must draw at full foreground contrast, not the muted secondary color');
});
