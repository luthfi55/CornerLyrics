'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { fetchLyrics, pickBestResult, normalizeForMatch, validDuration } = require('../src/lib/lyrics.cjs');

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

test('normalizes common metadata differences', () => {
  assert.equal(normalizeForMatch('Cigarettes After Sex (Official Video)'), 'cigarettes after sex');
  assert.equal(normalizeForMatch('Song feat. Someone'), 'song');
});

test('chooses an exact synced match over a weaker plain result', () => {
  const best = pickBestResult(
    { title: 'Sunset', artist: 'Artist', album: 'Album' },
    [
      { trackName: 'Sunset (Live)', artistName: 'Other', plainLyrics: 'plain' },
      { trackName: 'Sunset', artistName: 'Artist', albumName: 'Album', syncedLyrics: '[00:01.00]Line' },
    ],
  );

  assert.equal(best.artistName, 'Artist');
  assert.equal(best.syncedLyrics, '[00:01.00]Line');
});

test('fetches lyrics through LRCLIB search', async () => {
  const result = await fetchLyrics(
    { title: 'Sunset', artist: 'Artist', album: 'Album' },
    {
      fetchImpl: async (url) => {
        assert.match(url, /^https:\/\/lrclib\.net\/api\/search\?/);
        assert.match(url, /q=Artist\+Sunset/);
        return jsonResponse([
          { trackName: 'Sunset', artistName: 'Artist', syncedLyrics: '[00:01.00]Line' },
        ]);
      },
    },
  );

  assert.equal(result.status, 'found');
  assert.equal(result.syncedLyrics, '[00:01.00]Line');
});

test('uses duration-aware exact lookup when the timeline provides a valid duration', async () => {
  assert.equal(validDuration({ duration: 233 }), true);
  assert.equal(validDuration({ duration: 0 }), false);
  assert.equal(validDuration({ duration: 3601 }), false);

  const result = await fetchLyrics(
    { title: 'Apocalypse', artist: 'Cigarettes After Sex', album: 'Cigarettes After Sex', duration: 279 },
    {
      fetchImpl: async (url) => {
        assert.match(url, /^https:\/\/lrclib\.net\/api\/get\?/);
        assert.match(url, /duration=279/);
        assert.match(url, /album_name=Cigarettes\+After\+Sex/);
        return jsonResponse({ trackName: 'Apocalypse', artistName: 'Cigarettes After Sex', syncedLyrics: '[00:01.00]Line' });
      },
    },
  );

  assert.equal(result.status, 'found');
});

test('falls back to search after an exact-lookup 404', async () => {
  const calls = [];
  const result = await fetchLyrics(
    { title: 'Apocalypse', artist: 'Cigarettes After Sex', duration: 279 },
    {
      fetchImpl: async (url) => {
        calls.push(url);
        if (calls.length === 1) return jsonResponse({}, 404);
        return jsonResponse([{ trackName: 'Apocalypse', artistName: 'Cigarettes After Sex', syncedLyrics: '[00:01.00]Line' }]);
      },
    },
  );

  assert.equal(calls.length, 2);
  assert.match(calls[1], /\/api\/search\?/);
  assert.equal(result.status, 'found');
});

test('stops cleanly when a newer track aborts the previous request', async () => {
  const controller = new AbortController();
  controller.abort();
  const result = await fetchLyrics(
    { title: 'Apocalypse' },
    { signal: controller.signal, fetchImpl: async () => { throw new Error('should not run'); } },
  );
  assert.equal(result.status, 'aborted');
});

test('returns a not-found state when LRCLIB has no match', async () => {
  const result = await fetchLyrics(
    { title: 'Unknown', artist: 'Nobody' },
    { fetchImpl: async () => jsonResponse([]) },
  );
  assert.equal(result.status, 'not-found');
});

test('handles rate limiting and network failures', async () => {
  const limited = await fetchLyrics(
    { title: 'Sunset' },
    { fetchImpl: async () => jsonResponse({}, 429) },
  );
  assert.equal(limited.status, 'rate-limited');

  const failed = await fetchLyrics(
    { title: 'Sunset' },
    { fetchImpl: async () => { throw new Error('offline'); } },
  );
  assert.equal(failed.status, 'network-error');
});
