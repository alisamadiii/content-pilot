// Canonical implementation lives in worker/git (sanitize/auth need it there);
// re-exported here so existing importers keep working. GitHub identity is
// always owner/repo, passed by the hub on session create.
export { parseRemote } from '@/worker/git';
