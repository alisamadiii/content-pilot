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
  'The AI service hit its usage limit for the moment, so nothing was applied. Wait about a minute and send the request again.';
