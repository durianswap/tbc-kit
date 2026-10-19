import assert from 'node:assert/strict';
import test from 'node:test';
import { parseProtocolTimestamp, formatProtocolTimestamp, hashCanonical, isValidTws } from '../dist/esm/index.js';

test('protocol time accepts seconds and 1-3 fraction digits without rounding', () => {
  const base = '2026-10-07T00:00:00';
  const epoch = Date.parse(`${base}Z`);
  for (const [suffix, offset] of [['Z',0],['.000Z',0],['.1Z',100],['.12Z',120],['.123Z',123],['.999Z',999]]) {
    assert.equal(parseProtocolTimestamp(base + suffix), epoch + offset);
    assert.equal(isValidTws('clockNowResult', {now:base + suffix}), true);
  }
  assert.equal(formatProtocolTimestamp(epoch), `${base}.000Z`);
  assert.equal(formatProtocolTimestamp(epoch + 123), `${base}.123Z`);
  assert.equal(parseProtocolTimestamp(`${base}.001Z`) > parseProtocolTimestamp(`${base}Z`), true);
});

test('invalid date, offset, microseconds and non-protocol time stay rejected', () => {
  for (const value of ['2026-02-30T00:00:00Z','2026-10-07T24:00:00Z','2026-10-07T00:00:60Z','2026-10-07T00:00:00+00:00','2026-10-07T00:00:00.123456Z','2026-10-07T00:00:00.Z']) {
    assert.throws(() => parseProtocolTimestamp(value));
  }
  assert.throws(() => formatProtocolTimestamp(NaN));
  assert.throws(() => formatProtocolTimestamp(0.1));
});

test('equivalent instants do not authorize rewriting a bound timestamp', () => {
  const seconds = {expiresAt:'2026-10-07T00:00:00Z'};
  const millis = {expiresAt:'2026-10-07T00:00:00.000Z'};
  assert.equal(parseProtocolTimestamp(seconds.expiresAt), parseProtocolTimestamp(millis.expiresAt));
  assert.notEqual(hashCanonical(seconds), hashCanonical(millis));
  assert.equal(seconds.expiresAt, '2026-10-07T00:00:00Z');
});
