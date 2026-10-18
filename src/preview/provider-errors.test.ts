import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isQuotaError, QUOTA_MESSAGE } from './provider-errors';

test('isQuotaError: Gemini free-tier quota text, RESOURCE_EXHAUSTED and 429 are quota errors', () => {
  assert.ok(isQuotaError('Attempt 3 failed: You exceeded your current quota, please check your plan and billing details. Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_input_token_count, limit: 250000'));
  assert.ok(isQuotaError('Error: 429 Too Many Requests'));
  assert.ok(isQuotaError('status: RESOURCE_EXHAUSTED'));
  assert.ok(isQuotaError('rate limit reached'));
});

test('isQuotaError: ordinary failures are not quota errors', () => {
  assert.ok(!isQuotaError('Error resuming session: No previous sessions found'));
  assert.ok(!isQuotaError('old_string not found in file'));
  assert.ok(!isQuotaError(''));
});

test('QUOTA_MESSAGE tells the owner nothing was applied and to retry shortly', () => {
  assert.match(QUOTA_MESSAGE, /nothing was applied/);
  assert.match(QUOTA_MESSAGE, /send the request again/);
});

test('isDailyQuotaError: the daily free-tier cap is distinguished from the per-minute burst (2026-10-18)', async () => {
  const { isDailyQuotaError, DAILY_QUOTA_MESSAGE, QUOTA_MESSAGE } = await import('./provider-errors');
  assert.ok(isDailyQuotaError('API Error: You have exhausted your daily quota for this model'));
  assert.ok(isDailyQuotaError('limit: 200, model: ... requests per day'));
  assert.ok(isDailyQuotaError('GenerateRequestsPerDayPerProjectPerModel exceeded'));
  // A per-minute burst is NOT a daily cap.
  assert.ok(!isDailyQuotaError('Quota exceeded for metric: generate_content_free_tier_input_token_count, limit: 250000 per minute'));
  assert.notEqual(DAILY_QUOTA_MESSAGE, QUOTA_MESSAGE);
  assert.match(DAILY_QUOTA_MESSAGE, /today/);
  assert.match(DAILY_QUOTA_MESSAGE, /resets tomorrow|paid AI plan/);
  assert.doesNotMatch(DAILY_QUOTA_MESSAGE, /minute/);
});
