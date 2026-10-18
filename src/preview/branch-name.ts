// Branch names a client may run a preview session on. `preview/<id>` is
// reserved for the ephemeral main-preview branches the API creates itself;
// everything else must be a plain, safe git ref component.

export const PREVIEW_BRANCH_PREFIX = 'preview/';

export const isPreviewBranch = (branch: string) =>
  branch.startsWith(PREVIEW_BRANCH_PREFIX);

export const MAX_BRANCH_NAME_LENGTH = 100;

/**
 * Mirrors `git check-ref-format --branch` for the subset we accept, plus the
 * `preview/` reservation. Pure so the hub can ship the same rules.
 */
export const isValidBranchName = (name: string) => {
  if (!name || name.length > MAX_BRANCH_NAME_LENGTH) return false;
  if (isPreviewBranch(name)) return false;
  if (name.startsWith('-') || name.startsWith('/') || name.startsWith('.')) return false;
  if (name.endsWith('/') || name.endsWith('.') || name.endsWith('.lock')) return false;
  if (name.includes('..') || name.includes('//') || name.includes('@{')) return false;
  if (name === '@') return false;
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x20\x7f~^:?*[\\]/.test(name)) return false;
  return true;
};

/**
 * Turns a human label ("New hero test") into a branch slug ("new-hero-test").
 * Lowercase ASCII, hyphen-separated, capped at 60 chars. Empty when nothing
 * usable remains.
 */
export const slugifyBranchName = (label: string) =>
  label
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/g, '');
