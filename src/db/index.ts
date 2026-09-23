import 'dotenv/config';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error('DATABASE_URL is not set');
}

// TLS decision:
//  - DATABASE_SSL=require|disable overrides everything
//  - otherwise require TLS only for hosts with a dotted domain (managed
//    Postgres like Neon: ep-xxx.aws.neon.tech) — internal Docker/Coolify
//    hosts are single-label and speak plaintext.
const needsSsl = (() => {
  const override = process.env.DATABASE_SSL?.toLowerCase();
  if (override === 'require' || override === 'true') return true;
  if (override === 'disable' || override === 'false') return false;
  if (/[?&]sslmode=require/.test(connectionString)) return true;
  if (/[?&]sslmode=disable/.test(connectionString)) return false;
  try {
    const host = new URL(connectionString).hostname;
    return host.includes('.') && host !== '127.0.0.1';
  } catch {
    return false;
  }
})();

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
