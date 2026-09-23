import 'dotenv/config';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error('DATABASE_URL is not set');
}

// Neon and most managed Postgres require TLS; local docker does not.
const needsSsl = !/localhost|127\.0\.0\.1|@db:/.test(connectionString);

const globalForDb = globalThis as unknown as {
  pgClient?: ReturnType<typeof postgres>;
};

export const client =
  globalForDb.pgClient ??
  postgres(connectionString, {
    max: 5,
    ...(needsSsl ? { ssl: 'require' as const } : {}),
  });

if (process.env.NODE_ENV !== 'production') {
  globalForDb.pgClient = client;
}

export const db = drizzle(client, { schema });
export * as tables from './schema';
