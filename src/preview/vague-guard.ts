/**
 * "Make the mentorship page pop" / "make it better": with no element, no
 * text and no direction, flash-lite invents content (EmpowerHer 2026-10-18:
 * a fake "Applications Open for 2026 Cycles" badge). A vague styling wish is
 * answered with one specific question, no agent run, no tokens. Anything
 * that names an element, quotes text, or gives a concrete direction runs.
 */

const VAGUE =
  /\b(?:pop|better|nicer|prettier|modern|fresh(?:er)?|improve|enhance|polish|spice|jazz|wow|professional|engaging|appealing|stand\s+out|look\s+(?:good|great|nice|better)|more\s+(?:lively|dynamic|attractive|beautiful))\b/i;
const CONCRETE =
  /\b(?:heading|headline|title|button|link|image|photo|picture|logo|icon|colou?r|font|text|copy|paragraph|section|card|footer|header|nav|hero|background|spacing|padding|margin|size|bigger|smaller|larger|bold|italic|align|center|centre|left|right|red|blue|green|yellow|orange|purple|pink|black|white|gr[ae]y|dark|light)\b/i;
const QUOTED = /["“”'‘’][^"“”'‘’]{2,}["“”'‘’]/;

export const isVagueStylingRequest = (message: string) => {
  const text = message.trim();
  if (text.length > 120) return false;
  if (!VAGUE.test(text)) return false;
  if (CONCRETE.test(text) || QUOTED.test(text)) return false;
  return true;
};

export const VAGUE_REPLY =
  'Happy to improve it. Tell me what you would like changed and I will do exactly that: for example the colours, the spacing, a heading, an image, or a button. You can also click the part of the page you mean in the preview.';
