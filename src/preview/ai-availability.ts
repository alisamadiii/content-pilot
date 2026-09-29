/**
 * The preview (clone, install, dev server, proxy) never needs an AI key — only
 * chat runs do. So a missing/invalid key must not block the supervisor:
 * previews boot regardless, and the chat pump fails messages instantly with
 * this reason instead of letting the agent retry a bad key for minutes.
 * Checked per provider; a session runs on claude or gemini (its `provider`
 * column), so only that provider's key matters for its messages. Set once at
 * boot; changing a key requires a supervisor restart (env is read at process
 * start anyway).
 */

type AiProvider = 'claude' | 'gemini';

const unavailableReason: Record<AiProvider, string | null> = {
  claude: null,
  gemini: null,
};

export const aiUnavailableReason = (provider: AiProvider): string | null =>
  unavailableReason[provider];

export const checkAiAvailability = async (
  log: (message: string) => void
): Promise<void> => {
  await Promise.all([checkClaude(log), checkGemini(log)]);
};

const checkClaude = async (log: (message: string) => void): Promise<void> => {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) {
    unavailableReason.claude =
      'AI editing is not configured on this server (no API key).';
    log('ANTHROPIC_API_KEY not set — claude chat disabled (previews still run)');
    return;
  }
  // Only a definitive 401 disables AI; network hiccups don't.
  try {
    const res = await fetch('https://api.anthropic.com/v1/models?limit=1', {
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      signal: AbortSignal.timeout(10_000),
    });
    if (res.status === 401) {
      unavailableReason.claude =
        'AI editing is misconfigured on this server (invalid API key).';
      log(
        'ANTHROPIC_API_KEY is invalid (401) — claude chat disabled until the key is fixed and the supervisor restarts'
      );
    }
  } catch (error) {
    log(`claude key preflight skipped (network): ${(error as Error).message}`);
  }
};

const checkGemini = async (log: (message: string) => void): Promise<void> => {
  const key = process.env.GEMINI_API_KEY;
  if (!key) {
    unavailableReason.gemini =
      'AI editing is not configured on this server (no API key).';
    log('GEMINI_API_KEY not set — gemini chat disabled (previews still run)');
    return;
  }
  // Only a definitive 400/401/403 disables AI; network hiccups don't. The
  // ListModels endpoint validates the key without spending tokens.
  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(key)}&pageSize=1`,
      { signal: AbortSignal.timeout(10_000) }
    );
    if (res.status === 400 || res.status === 401 || res.status === 403) {
      unavailableReason.gemini =
        'AI editing is misconfigured on this server (invalid API key).';
      log(
        `GEMINI_API_KEY is invalid (${res.status}) — gemini chat disabled until the key is fixed and the supervisor restarts`
      );
    }
  } catch (error) {
    log(`gemini key preflight skipped (network): ${(error as Error).message}`);
  }
};
