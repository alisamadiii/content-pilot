import 'dotenv/config';
import { db, client } from '../src/db';
import { apiKey } from '../src/db/schema';
import { generateApiKey, hashApiKey } from '../src/lib/api-key';

/**
 * Creates an API key from the CLI (alternative to the dashboard).
 * Usage: pnpm exec tsx scripts/create-key.ts [name]
 */
const main = async () => {
  const name = process.argv[2] || 'cli';
  const key = generateApiKey();
  await db.insert(apiKey).values({ name, keyHash: hashApiKey(key) });
  console.log(key);
  await client.end();
};

main();
