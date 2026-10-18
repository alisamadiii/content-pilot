/**
 * Provider failure classes worth telling the owner about honestly. The
 * Gemini free tier allows 250k input tokens per minute per model; the CLI
 * retries with backoff and finally exits non-zero with the quota text in
 * stderr (seen 2026-10-18 during break-testing). "The AI could not complete
 * this request" hides the real reason; this names it.
 */
export const isQuotaError = (stderr: string) =>
  /quota|RESOURCE_EXHAUSTED|rate[ -]?limit|\b429\b/i.test(stderr);

export const QUOTA_MESSAGE =
  'The AI service hit its per-minute limit for the moment, so nothing was applied. Wait about a minute and send the request again.';

/**
 * The daily free-tier cap (distinct from the per-minute burst limit): it does
 * NOT clear in a minute, so the message must not tell the owner to retry
 * shortly. Gemini's stderr says "exhausted your daily" / "per day".
 */
export const isDailyQuotaError = (stderr: string) =>
  /exhausted your daily|\bper day\b|daily limit|requests? per day|PerDay/i.test(stderr);

export const DAILY_QUOTA_MESSAGE =
  "This project has used up its free AI allowance for today, so nothing was applied. It resets tomorrow — or your developer can switch this project to the paid AI plan for higher limits.";
