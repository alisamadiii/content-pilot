import { domainToASCII } from 'url';

/**
 * Pure hostname/slug rules for upload-project domains (free subdomains under
 * the preview wildcard + customer-owned custom domains). DB-free like
 * settings-rules.ts so everything here is unit-testable.
 *
 * The serving map lives in app_setting as `domain:<host>` -> repoId; the
 * preview proxy resolves the FULL normalized Host header against it before any
 * session-label logic, so a mapped host can never reach a session.
 */

export const domainKey = (host: string) => `domain:${host}`;

/** Hosts that may never be claimed as a slug label. */
export const RESERVED_SLUGS = new Set([
  'www',
  'pilot',
  'api',
  'mail',
  'smtp',
  'mx',
  'ns1',
  'ns2',
  'preview',
  'admin',
  'app',
  'dashboard',
  'site',
  'sites',
  'static',
  'assets',
  'cdn',
  'dev',
  'staging',
  'test',
  'blog',
  'docs',
  'status',
  'support',
  'help',
  'ftp',
  'root',
  'fallback',
]);

/**
 * Normalizes a raw hostname: trim, lowercase, strip :port and trailing dot,
 * punycode via domainToASCII. Returns '' when the input is not a hostname.
 */
export const normalizeHost = (raw: string): string => {
  const trimmed = raw.trim().toLowerCase();
  if (!trimmed) return '';
  // Strip a :port suffix (but leave IPv6 bracket forms to fail validation).
  const withoutPort = trimmed.replace(/:\d+$/, '');
  const withoutDot = withoutPort.replace(/\.$/, '');
  if (!withoutDot) return '';
  const ascii = domainToASCII(withoutDot);
  return ascii || '';
};

const LABEL_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

/**
 * Validates a free-subdomain slug. Throws with a client-facing message.
 * Must never collide with the proxy's other label namespaces:
 *  - `site-<id>` live labels;
 *  - 12-char [a-z0-9] session ids.
 */
export const validateSlug = (slug: string): string => {
  const value = slug.trim().toLowerCase();
  if (value.length < 3 || value.length > 63) {
    throw new Error('Name must be 3 to 63 characters.');
  }
  if (!LABEL_RE.test(value) ) {
    throw new Error(
      'Name can only contain lowercase letters, numbers and hyphens, and cannot start or end with a hyphen.'
    );
  }
  if (/^site-\d+$/.test(value)) {
    throw new Error('That name is reserved.');
  }
  if (/^[a-z0-9]{12}$/.test(value)) {
    // Exactly the session-id label shape — a session could shadow it.
    throw new Error('Pick a name with a hyphen, or a different length.');
  }
  if (RESERVED_SLUGS.has(value)) {
    throw new Error('That name is reserved.');
  }
  return value;
};

const IPV4_RE = /^\d{1,3}(\.\d{1,3}){3}$/;

/**
 * Validates a customer-owned hostname. v1 is SUBDOMAINS ONLY (>= 3 labels):
 * apex domains need registrar-side redirects instead. Throws client-facing
 * messages. `ownHosts` are hostnames (and their subdomains) we serve ourselves
 * and must never accept as a customer domain.
 */
export const validateCustomHost = (
  host: string,
  options: { ownHosts: string[] }
): string => {
  const value = normalizeHost(host);
  if (!value) throw new Error('Enter a valid domain.');
  if (value.length > 253) throw new Error('Domain is too long.');
  if (IPV4_RE.test(value) || value.includes(':')) {
    throw new Error('Enter a domain name, not an IP address.');
  }
  const labels = value.split('.');
  if (labels.some((label) => !LABEL_RE.test(label) || label.length > 63)) {
    throw new Error('Enter a valid domain.');
  }
  if (value === 'localhost' || value.endsWith('.localhost')) {
    throw new Error('Enter a valid domain.');
  }
  if (labels.length < 3) {
    throw new Error(
      'Root domains are not supported yet. Use a subdomain like www.yourdomain.com and set up a redirect from your root domain at your registrar.'
    );
  }
  for (const own of options.ownHosts) {
    const ownNorm = normalizeHost(own);
    if (!ownNorm) continue;
    if (value === ownNorm || value.endsWith(`.${ownNorm}`)) {
      throw new Error('That domain is not available.');
    }
  }
  return value;
};

/**
 * The wildcard base host of PREVIEW_URL_BASE (port stripped): the suffix free
 * subdomains live under. `http://{id}.localhost:3020` -> 'localhost';
 * `https://{id}.alisamadii.dev` -> 'alisamadii.dev'.
 */
export const previewBaseHost = (urlBase: string): string => {
  try {
    const host = new URL(urlBase.replace('{id}', 'x')).hostname;
    return host.replace(/^x\./, '');
  } catch {
    return '';
  }
};

/** The full host a slug maps to, e.g. 'acme' -> 'acme.alisamadii.dev'. */
export const slugHost = (slug: string, urlBase: string): string =>
  `${slug}.${previewBaseHost(urlBase)}`;
