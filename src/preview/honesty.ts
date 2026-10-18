/**
 * Post-run honesty check. Flash-lite sometimes answers "I've re-added it!"
 * after a run that only read a file (EmpowerHer 2026-10-18, message #219:
 * one Read, zero edits, no commit, reply claimed success). The supervisor
 * knows the truth — `git status` is empty — so a reply that claims a change
 * while nothing changed triggers one forced repair run: do it, or say so.
 */

const CLAIM_RE =
  /\b(?:I(?:'ve| have|'ll have)?\s+(?:just\s+|now\s+|successfully\s+|also\s+)?(?:re-?added|added|updated|removed|changed|replaced|deleted|swapped|inserted|moved|renamed|edited|applied|fixed|set|put|uploaded|restored|reverted|created|adjusted|increased|reduced|hidden|hid|shown|switched|translated|rewrote|rewritten|shortened|linked|bolded)|(?:has|have)\s+been\s+(?:re-?added|added|updated|removed|changed|replaced|deleted|swapped|inserted|moved|renamed|edited|applied|fixed|uploaded|restored|reverted|created|adjusted)|is\s+now\s+(?:live|updated|showing|set|removed|gone|in\s+place))\b/i;

/** True when the assistant reply reads as "I changed the site". */
export const claimsChange = (reply: string) => CLAIM_RE.test(reply);

/** Repair prompt when the reply claims a change but no file changed. */
export const HONESTY_REPAIR_PROMPT =
  'Automated check: your reply says you changed the site, but no file was modified — nothing was added, edited or removed. Either make the requested change now, exactly as asked (if it means adding an item that already exists, add it anyway — the owner asked for it), or reply honestly that you did not change anything and say why. Never claim a change you did not make.';
