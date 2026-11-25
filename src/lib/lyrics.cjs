'use strict';

const API_ROOT = 'https://lrclib.net/api';
const USER_AGENT = 'CornerLyrics/1.0.3';

function normalizeForMatch(value) {
  return String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\([^)]*(?:official|video|audio|lyrics?|remaster|hd|4k)[^)]*\)/g, ' ')
    .replace(/\[[^\]]*(?:official|video|audio|lyrics?|remaster|hd|4k)[^\]]*\]/g, ' ')
    .replace(/\b(feat|ft)\.?\s.+/g, ' ')
    .replace(/[^a-z0-9\u00c0-\u024f]+/g, ' ')
    .trim();
}

function scoreResult(media, result) {
  const title = normalizeForMatch(media.title);
  const artist = normalizeForMatch(media.artist);
  const album = normalizeForMatch(media.album);
  const resultTitle = normalizeForMatch(result.trackName || result.name || result.title);
  const resultArtist = normalizeForMatch(result.artistName);
  const resultAlbum = normalizeForMatch(result.albumName);

  let score = 0;

  if (title && resultTitle) {
    if (title === resultTitle) score += 70;
    else if (title.includes(resultTitle) || resultTitle.includes(title)) score += 35;
  }

  if (artist && resultArtist) {
    if (artist === resultArtist) score += 55;
    else if (artist.includes(resultArtist) || resultArtist.includes(artist)) score += 25;
  }

  if (album && resultAlbum) {
    if (album === resultAlbum) score += 15;
    else if (album.includes(resultAlbum) || resultAlbum.includes(album)) score += 7;
  }

  if (result.syncedLyrics) score += 35;
  else if (result.plainLyrics) score += 10;

  if (result.instrumental) score += 1;
  return score;
}

function pickBestResult(media, results) {
  if (!Array.isArray(results) || results.length === 0) return null;
  return results
    .map((result) => ({ result, score: scoreResult(media, result) }))
    .sort((a, b) => b.score - a.score)[0].result;
}

async function fetchWithTimeout(url, timeoutMs, fetchImpl, externalSignal) {
  const controller = new AbortController();
  const abort = () => controller.abort();

  if (externalSignal?.aborted) controller.abort();
  else externalSignal?.addEventListener('abort', abort, { once: true });

  const timeout = setTimeout(abort, timeoutMs);
  try {
    return await fetchImpl(url, {
      headers: {
        Accept: 'application/json',
        'User-Agent': USER_AGENT,
      },
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
    externalSignal?.removeEventListener('abort', abort);
  }
}

function retryAfterMs(response) {
  const value = response.headers?.get?.('Retry-After');
  if (!value) return 10000;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.max(1000, seconds * 1000);
  const date = Date.parse(value);
  if (Number.isFinite(date)) return Math.max(1000, date - Date.now());
  return 10000;
}

function foundResult(track) {
  return {
    status: 'found',
    track,
    syncedLyrics: String(track.syncedLyrics || ''),
    plainLyrics: String(track.plainLyrics || ''),
    instrumental: Boolean(track.instrumental),
  };
}

function validDuration(media) {
  const duration = Number(media.duration);
  return Number.isFinite(duration) && duration >= 1 && duration <= 3600;
}

function exactLookupUrl(media) {
  const url = new URL(`${API_ROOT}/get`);
  url.searchParams.set('track_name', String(media.title).trim());
  url.searchParams.set('artist_name', String(media.artist).trim());
  if (String(media.album || '').trim()) url.searchParams.set('album_name', String(media.album).trim());
  url.searchParams.set('duration', String(Math.round(Number(media.duration))));
  return url;
}

function searchUrl(media) {
  const title = String(media.title || '').trim();
  const artist = String(media.artist || '').trim();
  const url = new URL(`${API_ROOT}/search`);
  url.searchParams.set('q', [artist, title].filter(Boolean).join(' '));
  return url;
}

async function fetchLyrics(media, options = {}) {
  const fetchImpl = options.fetchImpl || fetch;
  const timeoutMs = options.timeoutMs || 12000;
  const externalSignal = options.signal;
  const title = String(media.title || '').trim();
  const artist = String(media.artist || '').trim();

  if (externalSignal?.aborted) return { status: 'aborted' };
  if (!title) return { status: 'not-found' };

  try {
    if (artist && validDuration(media)) {
      const response = await fetchWithTimeout(exactLookupUrl(media).toString(), timeoutMs, fetchImpl, externalSignal);

      if (response.status === 429) return { status: 'rate-limited', retryAfterMs: retryAfterMs(response) };
      if (response.ok) return foundResult(await response.json());
      if (response.status !== 404) return { status: 'http-error', statusCode: response.status };
    }

    const response = await fetchWithTimeout(searchUrl(media).toString(), timeoutMs, fetchImpl, externalSignal);
    if (response.status === 429) return { status: 'rate-limited', retryAfterMs: retryAfterMs(response) };
    if (!response.ok) return { status: 'http-error', statusCode: response.status };

    const results = await response.json();
    const best = pickBestResult(media, results);
    return best ? foundResult(best) : { status: 'not-found' };
  } catch (error) {
    if (externalSignal?.aborted || (error && error.name === 'AbortError')) return { status: 'aborted' };
    return { status: 'network-error', message: error instanceof Error ? error.message : String(error) };
  }
}

module.exports = {
  fetchLyrics,
  normalizeForMatch,
  pickBestResult,
  scoreResult,
  validDuration,
};
