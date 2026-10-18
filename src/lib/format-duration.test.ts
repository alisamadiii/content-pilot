import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatDuration } from './format-duration';

const at = (iso: string) => new Date(iso);

test('formatDuration: null/undefined or negative spans render as a dash', () => {
  assert.equal(formatDuration(null, at('2026-10-18T07:47:49Z')), '—');
  assert.equal(formatDuration(at('2026-10-18T07:32:12Z'), null), '—');
  assert.equal(formatDuration(undefined, undefined), '—');
  // last activity before created (clock skew / bad data) → dash, not negative.
  assert.equal(formatDuration(at('2026-10-18T07:47:49Z'), at('2026-10-18T07:32:12Z')), '—');
});

test('formatDuration: seconds under a minute', () => {
  assert.equal(formatDuration(at('2026-10-18T00:00:00Z'), at('2026-10-18T00:00:00Z')), '0s');
  assert.equal(formatDuration(at('2026-10-18T00:00:00Z'), at('2026-10-18T00:00:45Z')), '45s');
  assert.equal(formatDuration(at('2026-10-18T00:00:00Z'), at('2026-10-18T00:00:59Z')), '59s');
});

test('formatDuration: whole minutes under an hour', () => {
  assert.equal(formatDuration(at('2026-10-18T00:00:00Z'), at('2026-10-18T00:01:00Z')), '1m');
  // Hazara ke9l0ln4uuef: 07:32:12 → 07:47:49 is 15m37s → "15m".
  assert.equal(formatDuration(at('2026-10-18T07:32:12Z'), at('2026-10-18T07:47:49Z')), '15m');
  assert.equal(formatDuration(at('2026-10-18T00:00:00Z'), at('2026-10-18T00:59:59Z')), '59m');
});

test('formatDuration: hours, with minutes dropped on an exact hour', () => {
  assert.equal(formatDuration(at('2026-10-18T00:00:00Z'), at('2026-10-18T01:00:00Z')), '1h');
  assert.equal(formatDuration(at('2026-10-18T00:00:00Z'), at('2026-10-18T02:00:00Z')), '2h');
  assert.equal(formatDuration(at('2026-10-18T00:00:00Z'), at('2026-10-18T01:03:30Z')), '1h 3m');
  assert.equal(formatDuration(at('2026-10-18T00:00:00Z'), at('2026-10-18T03:45:00Z')), '3h 45m');
});
