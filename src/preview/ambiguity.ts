import { looksLikeEdit } from './prompt-context';

/**
 * Pre-run ambiguity check: "change the button text to Get Involved" on a page
 * with several buttons must become a question, never a guess (EmpowerHer
 * 2026-10-18: the model changed BOTH buttons in a section). Deterministic
 * and free: it scans the pinned page files for elements of the kind the
 * message names, and when there is more than one and the message does not
 * single one out, the supervisor replies with the list and asks which.
 *
 * Only runs for edit-like messages without a clicked element, an attachment
 * or a skill (those carry their own target).
 */

export type ElementKind = 'button' | 'image' | 'heading' | 'link';

const KINDS: Array<{ kind: ElementKind; word: RegExp; plural: string }> = [
  { kind: 'button', word: /\b(button|cta|call[- ]to[- ]action)\b/i, plural: 'buttons' },
  { kind: 'image', word: /\b(image|photo|picture|logo|icon)\b/i, plural: 'images' },
  { kind: 'heading', word: /\b(heading|headline|title|h1|h2)\b/i, plural: 'headings' },
  { kind: 'link', word: /\blink\b/i, plural: 'links' },
];

/** The owner means several at once — nothing to disambiguate. */
const PLURAL_OR_ALL =
  /\b(all|every|each|both|buttons|ctas|images|photos|pictures|logos|icons|headings|headlines|titles|links)\b/i;

/** The owner already scoped it (position, section) — the model can resolve. */
const SCOPED =
  /\b(first|second|third|fourth|fifth|sixth|last|1st|2nd|3rd|4th|5th|6th|top|bottom|left|right|hero|header|footer|nav|navigation|menu|banner|sidebar|card|section|form|modal|popup|newsletter|testimonial|faq|pricing|gallery|contact|mission|partners?|programs?|stats?|about)\b/i;

export const MAX_LISTED = 8;

const stripTags = (html: string) =>
  html
    .replace(/<[^>]*>/g, ' ')
    .replace(/\{[^}]*\}/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const attr = (attrs: string, name: string) => {
  const match = new RegExp(`\\b${name}=["']([^"']*)["']`, 'i').exec(attrs);
  return match?.[1]?.trim() ?? '';
};

/**
 * An anchor "looks like a button" when its class names say so (btn/button/
 * cta) or when it is styled as one in utility CSS: a flex/inline-flex pill
 * with padding or a fixed height (dad-portfolio: `inline-flex h-10 … rounded-lg
 * px-4`; EmpowerHer: `group/btn inline-flex rounded-full px-7`).
 */
const BUTTON_CLASS = /class=["'][^"']*\b(btn|button|cta)\b/i;
const TAILWIND_BUTTON =
  /class=["'](?=[^"']*\b(?:inline-flex|flex)\b)(?=[^"']*\brounded)(?=[^"']*\b(?:px-\d|py-\d|h-\d|p-\d))[^"']*["']/i;
const looksLikeButtonAnchor = (attrs: string) =>
  BUTTON_CLASS.test(attrs) || TAILWIND_BUTTON.test(attrs);

/** Static, human-readable labels of every `kind` element in `content`. */
export const extractCandidates = (kind: ElementKind, content: string): string[] => {
  const out: string[] = [];
  const push = (label: string) => {
    const clean = label.trim();
    if (clean && clean.length <= 80) out.push(clean);
  };
  if (kind === 'button') {
    for (const m of content.matchAll(/<button\b[^>]*>([\s\S]*?)<\/button>/gi)) push(stripTags(m[1]));
    for (const m of content.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
      if (looksLikeButtonAnchor(m[1])) push(stripTags(m[2]));
    }
    for (const m of content.matchAll(
      /<([A-Z]\w*(?:Button|Cta|CTA))\b([^>]*?)(?:\/>|>([\s\S]*?)<\/\1>)/g
    )) {
      push(stripTags(m[3] ?? '') || attr(m[2], 'label') || attr(m[2], 'text') || attr(m[2], 'title'));
    }
  } else if (kind === 'heading') {
    for (const m of content.matchAll(/<h[1-3]\b[^>]*>([\s\S]*?)<\/h[1-3]>/gi)) push(stripTags(m[1]));
  } else if (kind === 'image') {
    for (const m of content.matchAll(/<(?:img|Image|Picture)\b([^>]*?)\/?>/g)) {
      const alt = attr(m[1], 'alt');
      const src = attr(m[1], 'src');
      const file = src && !src.startsWith('{') ? src.split('/').pop() ?? '' : '';
      push(alt || file);
    }
  } else if (kind === 'link') {
    for (const m of content.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) push(stripTags(m[2]));
  }
  // Dedupe, keep order.
  return [...new Set(out)];
};

/** The element kind the message is about, by specificity (button beats "text"). */
export const requestedKind = (message: string): ElementKind | null => {
  for (const entry of KINDS) if (entry.word.test(message)) return entry.kind;
  return null;
};

const quote = (label: string) => `“${label}”`;

/**
 * The question to ask instead of running the agent, or null when the request
 * is unambiguous enough to run.
 */
export const findAmbiguity = (
  message: string,
  files: Array<{ path: string; content: string }>
): string | null => {
  if (!files.length || !looksLikeEdit(message)) return null;
  if (PLURAL_OR_ALL.test(message) || SCOPED.test(message)) return null;
  const kind = requestedKind(message);
  if (!kind) return null;
  const candidates = [...new Set(files.flatMap((file) => extractCandidates(kind, file.content)))];
  if (candidates.length < 2) return null;
  // The owner named one of them ("the Donate button", "the 'Apply now' link").
  const lower = message.toLowerCase();
  if (candidates.some((label) => label.length >= 3 && lower.includes(label.toLowerCase()))) {
    return null;
  }
  const plural = KINDS.find((entry) => entry.kind === kind)!.plural;
  const listed = candidates.slice(0, MAX_LISTED).map(quote).join(', ');
  const more = candidates.length > MAX_LISTED ? ` and ${candidates.length - MAX_LISTED} more` : '';
  const how =
    kind === 'image'
      ? 'Tell me which one, or click it in the preview, and I will change just that one.'
      : 'Tell me the exact current text of the one you mean, or click it in the preview, and I will change just that one.';
  return `I found ${candidates.length} ${plural} on this page: ${listed}${more}. Which one do you mean? ${how}`;
};
