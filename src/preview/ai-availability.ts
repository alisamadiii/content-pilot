/**
 * The preview (clone, install, dev server, proxy) never needs Anthropic —
 * only chat runs do. So a missing/invalid ANTHROPIC_API_KEY must not block
 * the supervisor: previews boot regardless, and the chat pump fails messages
 * instantly with this reason instead of letting the SDK retry a bad key for
 * minutes. Set once at boot; changing the key requires a supervisor restart
 * (env is read at process start anyway).
 */
let unavailableReason: string | null = null;

export const aiUnavailableReason = () => unavailableReason;

export const checkAiAvailability = async (
  log: (message: string) => void
): Promise<void> => {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) {
    unavailableReason =
      'AI editing is not configured on this server (no API key).';
    log('ANTHROPIC_API_KEY not set — previews will run, AI chat is disabled');
    return;
  }
  // Only a definitive 401 disables AI; network hiccups don't.
  try {
    const res = await fetch('https://api.anthropic.com/v1/models?limit=1', {
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      signal: AbortSignal.timeout(10_000),
    });
    if (res.status === 401) {
      unavailableReason =
        'AI editing is misconfigured on this server (invalid API key).';
      log(
        'ANTHROPIC_API_KEY is invalid (401) — previews will run, AI chat is disabled until the key is fixed and the supervisor restarts'
      );
    }
  } catch (error) {
    log(`api key preflight skipped (network): ${(error as Error).message}`);
  }
};
