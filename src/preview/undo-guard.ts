/**
 * Chat guard for undo / revert requests. The AI never reverts anything
 * (2026-10-18, EmpowerHer + dad-portfolio: a "revert" prompt made Gemini
 * reconstruct the old heading from memory and get it wrong). Such messages
 * are answered instantly with a fixed reply pointing at the manual path —
 * the header Changes dialog, where every file has a Revert button — and no
 * agent run happens, so no tokens are spent either.
 */

const UNDO_RE =
  /\b(undo|revert|reverse|roll\s?back|rollback|restore|put\s+(?:\w+\s+){0,3}back|bring\s+(?:\w+\s+){0,3}back|change\s+(?:\w+\s+){0,3}back|go\s+back(?:\s+to)?|take\s+(?:it|that|this)\s+back|(?:liked|preferred|wanted)\s+(?:it|that|this)\s+before|(?:like|as)\s+(?:it\s+was\s+)?before|back\s+to\s+(?:the\s+|its\s+|it'?s\s+|their\s+)?(?:original|previous|old|way)|(?:original|previous|old)\s+(?:data|version|text|state|content|one)|(?:how|what|the\s+way)\s+(?:it|they|that|this)\s+(?:was|were)(?:\s+before)?|as\s+(?:it|they)\s+(?:was|were)(?:\s+before)?)\b/i;

/**
 * A real undo request is a short imperative ("revert that", "change the
 * heading back"). Pasted content (a story, a bio) runs to thousands of
 * characters and can contain an undo phrase incidentally — EmpowerHer,
 * 2026-10-19: "no longer possible like before" inside a submitted story
 * tripped the guard and the add was refused. Above this ceiling the message
 * is a content submission / detailed edit, not an undo; it goes to the AI.
 */
const UNDO_MAX_LEN = 400;

/** Cheap undo-intent check (no AI call), mirroring looksLikeEdit. */
export const looksLikeUndo = (message: string) => {
  const trimmed = message.trim();
  if (trimmed.length > UNDO_MAX_LEN) return false;
  return UNDO_RE.test(trimmed);
};

/** What the owner sees instead of an AI run. */
export const UNDO_REPLY =
  'We are not able to revert back to the original data automatically. Please use the Changes button in the header of this page, go through all your changes, and revert the ones you want back manually.';
