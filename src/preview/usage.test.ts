import assert from 'node:assert/strict';
import { test } from 'node:test';
import { addUsage, resolveMessageCost } from './usage';

const usage = (
  inputTokens: number | null,
  outputTokens: number | null,
  costUsd: number | null,
  model: string | null = 'm'
) => ({ model, inputTokens, outputTokens, costUsd });

test('addUsage sums tokens across runs', () => {
  const out = addUsage(usage(100, 10, 0.01), usage(50, 5, 0.02));
  assert.equal(out.inputTokens, 150);
  assert.equal(out.outputTokens, 15);
});

test('addUsage default (claude): cost is latest-wins, not summed', () => {
  // Claude reports cumulative totals per run — adding would double count.
  const out = addUsage(usage(100, 10, 0.05), usage(200, 20, 0.09));
  assert.equal(out.costUsd, 0.09);
});

test('addUsage sumCost=true (gemini): per-run costs add up', () => {
  const out = addUsage(usage(100, 10, 0.01), usage(50, 5, 0.02), true);
  assert.ok(Math.abs(out.costUsd! - 0.03) < 1e-9);
});

test('addUsage keeps null tokens null when both runs are null', () => {
  const out = addUsage(usage(null, null, null), usage(null, null, null), true);
  assert.equal(out.inputTokens, null);
  assert.equal(out.outputTokens, null);
  assert.equal(out.costUsd, null);
});

test('resolveMessageCost cumulative (claude): stores the delta', () => {
  // Session already saw 0.05; this run's cumulative total is 0.08.
  const r = resolveMessageCost(0.08, 0.05, true);
  assert.ok(Math.abs(r.messageCost - 0.03) < 1e-9);
  assert.equal(r.newSessionTotal, 0.08);
});

test('resolveMessageCost cumulative: a drop below prev means a fresh convo', () => {
  // Stale-resume recovery restarted the conversation, so the run total IS the
  // message cost (not a negative delta).
  const r = resolveMessageCost(0.01, 0.05, true);
  assert.equal(r.messageCost, 0.01);
  assert.equal(r.newSessionTotal, 0.01);
});

test('resolveMessageCost per-message (gemini): stores as-is, accumulates total', () => {
  const r = resolveMessageCost(0.004, 0.02, false);
  assert.equal(r.messageCost, 0.004);
  assert.ok(Math.abs(r.newSessionTotal - 0.024) < 1e-9);
});
