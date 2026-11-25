'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseLrc, getActiveLineIndex, timestampToMs } = require('../src/lib/lrc.cjs');

test('converts common LRC timestamp formats', () => {
  assert.equal(timestampToMs('01', '02', '34'), 62340);
  assert.equal(timestampToMs('00', '05', '5'), 5500);
  assert.equal(timestampToMs('00', '05', '50'), 5500);
  assert.equal(timestampToMs('00', '05'), 5000);
});

test('parses, sorts, and merges multiple timestamps', () => {
  const parsed = parseLrc('[00:10.00]Baris kedua\n[00:01.00]Baris pertama\n[00:01.00]Baris pertama');
  assert.deepEqual(parsed.lines, [
    { time: 1000, text: 'Baris pertama' },
    { time: 10000, text: 'Baris kedua' },
  ]);
});

test('applies LRC offsets and ignores metadata', () => {
  const parsed = parseLrc('[ar:Artist]\n[00:01.00]Lirik', 500);
  assert.deepEqual(parsed.lines, [{ time: 1500, text: 'Lirik' }]);
});

test('keeps untimed lyrics as plain text', () => {
  const parsed = parseLrc('[ti:Judul]\nLirik tanpa waktu');
  assert.deepEqual(parsed.lines, []);
  assert.equal(parsed.plainText, 'Lirik tanpa waktu');
});

test('selects the latest line at or before the playback position', () => {
  const lines = [
    { time: 1000, text: 'Satu' },
    { time: 3000, text: 'Tiga' },
    { time: 5000, text: 'Lima' },
  ];
  assert.equal(getActiveLineIndex(lines, 0), -1);
  assert.equal(getActiveLineIndex(lines, 1000), 0);
  assert.equal(getActiveLineIndex(lines, 4999), 1);
  assert.equal(getActiveLineIndex(lines, 9000), 2);
});
