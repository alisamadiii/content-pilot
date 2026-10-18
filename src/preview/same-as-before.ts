/**
 * "Do the same for the resources page" — Gemini runs every message as a
 * fresh conversation with a text recap, and flash-lite does not resolve
 * "the same" from the recap (EmpowerHer 2026-10-18, message #170 asked
 * "what change?" right after a rename). Deterministic fix: when a short
 * message refers back, restate the owner's previous request inline. Costs a
 * sentence, saves a round trip.
 */

const REFERS_BACK =
  /\b(?:(?:do|apply|make|repeat|try)\s+(?:the\s+)?same(?:\s+thing|\s+change|\s+edit)?|same\s+(?:thing|change|edit|here|for|on)|(?:that|this|it)(?:\s+one)?\s+(?:too|as\s+well|also)|also\s+(?:do\s+(?:it|that|this)|for|on|here)|again\s+(?:for|on|here)|likewise)\b/i;

/** True when the message leans on the previous request to make sense. */
export const refersToPrevious = (message: string) =>
  message.trim().length <= 160 && REFERS_BACK.test(message);

/** The request text with the previous request restated. */
export const withPreviousRequest = (message: string, previous: string) => {
  const prior = previous.replace(/\s+/g, ' ').trim().slice(0, 300);
  return `${message}\n\n(By "the same" the owner means their previous request: "${prior}". Apply that request to what they name now, and nothing else.)`;
};

const REFERS_EARLIER =
  /\b(?:(?:i|we)\s+(?:just\s+)?(?:added|created|uploaded|made|wrote|changed|updated|edited)\s+(?:earlier|before|previously|a\s+(?:minute|moment|while)\s+ago|yesterday|today)?|the\s+(?:one|\w+)\s+(?:i|we)\s+(?:just\s+)?(?:added|created|uploaded|made|wrote|changed|updated|edited)|(?:earlier|previously)\b)/i;

/** "update the resource I added earlier": the target lives in an earlier request. */
export const refersToEarlierItem = (message: string) => REFERS_EARLIER.test(message);

/** Append the last few requests verbatim so "the one I added earlier" resolves. */
export const withRecentRequests = (message: string, recent: string[]) => {
  const lines = recent
    .map((text) => text.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .slice(0, 4)
    .map((text, index) => `${index + 1}. "${text.slice(0, 220)}"`);
  if (!lines.length) return message;
  return `${message}\n\n(The owner refers to something from an earlier request. Their most recent requests, newest first:\n${lines.join('\n')}\nResolve "the one I added/changed earlier" against these; if none matches, ask which item instead of guessing.)`;
};
