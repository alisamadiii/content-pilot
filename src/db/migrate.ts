import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import { join } from 'path';
import 'dotenv/config';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { needsSsl } from './ssl';

/**
 * Applies pending SQL migrations from ./drizzle to DATABASE_URL.
 *
 * Runs first in the container entrypoint (replaces `drizzle-kit push`), so a
 * deploy migrates prod from committed files — nothing is inferred from a live
 * schema diff. Local workflow: edit schema.ts → `pnpm db:generate` →
 * `pnpm db:migrate` (local DATABASE_URL) → commit the drizzle/ files.
 *
 * Baseline: 0000_baseline recreates the schema that already exists on every
 * database set up with db:push. On such a database the journal is empty and
 * the tables are present, so the baseline is recorded as applied without
 * running it; a brand-new database runs it for real.
 */
const migrationsFolder = join(__dirname, '..', '..', 'drizzle');

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error('[migrate] DATABASE_URL is not set');
  process.exit(1);
}
// Own single connection (not the app's pool): drizzle's migrator always runs
// `create … if not exists` for its journal and postgres-js would print the
// resulting NOTICEs into the container log.
const client = postgres(connectionString, {
  max: 1,
  onnotice: () => {},
  ...(needsSsl(connectionString) ? { ssl: 'require' as const } : {}),
});
const db = drizzle(client);

const baselineIfNeeded = async () => {
  const journal = JSON.parse(
    readFileSync(join(migrationsFolder, 'meta', '_journal.json'), 'utf8')
  ) as { entries: Array<{ idx: number; tag: string; when: number }> };
  const baseline = journal.entries.find((entry) => entry.idx === 0);
  if (!baseline) return;

  const journalTable = await db.execute(
    sql`select to_regclass('drizzle.__drizzle_migrations') as reg`
  );
  if (journalTable[0]?.reg) {
    const applied = await db.execute(
      sql`select count(*)::int as count from "drizzle"."__drizzle_migrations"`
    );
    if (Number(applied[0]?.count ?? 0) > 0) return;
  }

  const existing = await db.execute(
    sql`select to_regclass('public.preview_session') as reg`
  );
  if (!existing[0]?.reg) return; // fresh database — let the baseline run

  if (!journalTable[0]?.reg) {
    await db.execute(sql`create schema if not exists "drizzle"`);
    await db.execute(
      sql`create table if not exists "drizzle"."__drizzle_migrations" (id serial primary key, hash text not null, created_at bigint)`
    );
  }
  const file = readFileSync(join(migrationsFolder, `${baseline.tag}.sql`));
  const hash = createHash('sha256').update(file).digest('hex');
  await db.execute(
    sql`insert into "drizzle"."__drizzle_migrations" ("hash", "created_at") values (${hash}, ${baseline.when})`
  );
  console.log(`[migrate] existing schema detected — recorded ${baseline.tag} as applied`);
};

const main = async () => {
  try {
    await baselineIfNeeded();
    console.log('[migrate] applying pending migrations...');
    await migrate(db, { migrationsFolder });
    console.log('[migrate] up to date');
    await client.end();
    process.exit(0);
  } catch (error) {
    console.error(`[migrate] failed: ${(error as Error).message}`);
    await client.end().catch(() => {});
    process.exit(1);
  }
};

void main();
