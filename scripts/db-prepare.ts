import 'dotenv/config';
import { client } from '../src/db';

/**
 * Pre-push cleanup, run by the container entrypoint before `drizzle-kit push`.
 *
 * `push` is non-interactive in the container (no TTY), but any table present in
 * the database and absent from the schema makes drizzle-kit ask a
 * deleted-or-renamed question — which throws instead of prompting, silently
 * exits 0, and leaves new tables uncreated (the preview supervisor then
 * crash-loops on the missing preview_session relation). Drop known-removed
 * tables here so push only ever sees pure additions.
 */
const removedTables = [
  // Removed 2026-09-25: projects derive from the workspace dir + job/session
  // history instead of a stored repo list.
  'repo',
];

const main = async () => {
  for (const table of removedTables) {
    await client.unsafe(`drop table if exists "${table}" cascade`);
    console.log(`[db-prepare] dropped legacy table if present: ${table}`);
  }
  await client.end();
};

void main();
