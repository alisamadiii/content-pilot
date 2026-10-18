/**
 * Deterministic backstop for blind photo reframing. The AI cannot see images,
 * so changing an image's object-position / object-fit is a guess it can't
 * verify — and it tends to claim success anyway (Hazara Oregon 2026-10-18: six
 * messages fighting a team photo, a per-name `objectPosition` ternary written
 * into the repo, "his head is fully visible" each time, never true).
 *
 * The prompt rule asks the model not to do it; this guarantees it. Unlike a
 * pre-emptive regex guard on the MESSAGE (which can't tell a photo reframe from
 * other element work), this keys on what the agent ACTUALLY changed: when every
 * changed line in the turn's diff is an object-position / object-fit edit, it is
 * by definition a blind reframe, so the edit is reverted and the owner is told
 * to upload an edited replacement. A real change (text, size, a src swap, any
 * other class) leaves a line with no object-position/object-fit, so legitimate
 * work is never reverted.
 *
 * Keyed on object-position / object-fit specifically (not the Tailwind
 * object-cover/contain words): those are almost always their own attribute
 * line, which keeps an unrelated edit that merely sits on an `object-cover`
 * image line (e.g. changing its alt text) from being mistaken for a reframe.
 */

const FRAMING = /object-position|objectposition|object-fit|objectfit/i;

/**
 * True when every changed line in a unified `git diff` is an object-position /
 * object-fit edit. Empty diffs, or any diff with a non-framing change, return
 * false.
 */
export const isFramingOnlyDiff = (diff: string): boolean => {
  let changed = 0;
  for (const line of diff.split('\n')) {
    // Skip file headers; +++/--- must be checked before the +/- branch.
    if (line.startsWith('+++') || line.startsWith('---')) continue;
    if (line.startsWith('+') || line.startsWith('-')) {
      const body = line.slice(1).trim();
      if (!body) continue; // a blank line added/removed
      changed++;
      if (!FRAMING.test(body)) return false;
    }
  }
  return changed > 0;
};

export const REFRAME_REPLY =
  "I can't see your photos, so I can't reliably zoom, crop, or reposition them to get a face or the right part in frame — I'd only be guessing, and I don't want to tell you it looks right when I can't check. The best fix is to crop or edit the photo on your device exactly how you want it, then upload the edited version here and I'll replace the current one with it.";
