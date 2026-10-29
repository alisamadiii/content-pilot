/**
 * Projects are keyed by the hub's `hub_project.id` (a uuid). It names the
 * workspace dir, scopes edit/import tokens and keys per-project settings.
 */
export const PROJECT_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const isProjectId = (value: unknown): value is string =>
  typeof value === 'string' && PROJECT_ID_RE.test(value);
