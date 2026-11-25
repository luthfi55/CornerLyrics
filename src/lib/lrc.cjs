'use strict';

const TIMESTAMP = /\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g;
const META_TAG = /^\[(?:ar|ti|al|au|by|offset|length|re|ve):.*\]$/i;

function timestampToMs(minutes, seconds, fraction = '') {
  const minuteValue = Number(minutes);
  const secondValue = Number(seconds);
  const fractionValue = fraction ? Number(`0.${fraction}`) : 0;
  return Math.round((minuteValue * 60 + secondValue + fractionValue) * 1000);
}

function parseLrc(input, offsetMs = 0) {
  const text = String(input || '').replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const lines = [];
  const plainLines = [];

  for (const sourceLine of text.split('\n')) {
    const line = sourceLine.trim();
    if (!line) continue;

    const timestamps = [...line.matchAll(TIMESTAMP)];
    if (timestamps.length === 0) {
      if (!META_TAG.test(line)) plainLines.push(line);
      continue;
    }

    const lyric = line.replace(TIMESTAMP, '').trim();
    if (!lyric) continue;

    for (const match of timestamps) {
      const time = timestampToMs(match[1], match[2], match[3]) + offsetMs;
      if (Number.isFinite(time) && time >= 0) lines.push({ time, text: lyric });
    }
  }

  lines.sort((a, b) => a.time - b.time);

  const merged = [];
  for (const line of lines) {
    const previous = merged[merged.length - 1];
    if (previous && previous.time === line.time) {
      if (!previous.text.split(' / ').includes(line.text)) {
        previous.text += ` / ${line.text}`;
      }
    } else {
      merged.push({ ...line });
    }
  }

  return {
    lines: merged,
    plainText: plainLines.join('\n').trim(),
  };
}

function getActiveLineIndex(lines, positionMs) {
  if (!Array.isArray(lines) || lines.length === 0) return -1;

  const position = Math.max(0, Number(positionMs) || 0);
  let low = 0;
  let high = lines.length - 1;
  let result = -1;

  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    if (lines[middle].time <= position) {
      result = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }

  return result;
}

module.exports = { parseLrc, getActiveLineIndex, timestampToMs };
