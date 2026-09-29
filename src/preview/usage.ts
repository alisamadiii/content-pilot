import type { ClaudeUsage } from '../worker/runner';

/**
 * Combines per-run AI usage across the initial run + repair runs. Tokens are
 * per-run and add up. costUsd differs by provider: Claude reports the
 * CUMULATIVE conversation total per run (a resumed run's total includes every
 * prior run), so latest wins; Gemini reports PER-RUN cost, so repair runs are
 * summed. `sumCost` picks the mode.
 */
export const addUsage = (
  a: ClaudeUsage,
  b: ClaudeUsage,
  sumCost = false
): ClaudeUsage => ({
  model: b.model ?? a.model,
  inputTokens:
    a.inputTokens === null && b.inputTokens === null
      ? null
      : (a.inputTokens ?? 0) + (b.inputTokens ?? 0),
  outputTokens:
    a.outputTokens === null && b.outputTokens === null
      ? null
      : (a.outputTokens ?? 0) + (b.outputTokens ?? 0),
  costUsd: sumCost
    ? a.costUsd === null && b.costUsd === null
      ? null
      : (a.costUsd ?? 0) + (b.costUsd ?? 0)
    : (b.costUsd ?? a.costUsd),
});

/**
 * Converts a run's reported cost into the per-message cost to store, plus the
 * new cumulative total to persist on the session. Claude's total_cost_usd is
 * CUMULATIVE for the resumed conversation, so the per-message cost is the delta
 * against the session's last-seen total (a drop below it means a fresh
 * conversation — stale-resume recovery — and the run's total IS the message's
 * cost). Gemini's cost is already per-message, so it is stored as-is and simply
 * added to the running session total.
 */
export const resolveMessageCost = (
  runCost: number,
  prevSessionTotal: number,
  costIsCumulative: boolean
): { messageCost: number; newSessionTotal: number } => {
  if (costIsCumulative) {
    const messageCost =
      runCost >= prevSessionTotal ? runCost - prevSessionTotal : runCost;
    return { messageCost, newSessionTotal: runCost };
  }
  return {
    messageCost: runCost,
    newSessionTotal: prevSessionTotal + runCost,
  };
};
