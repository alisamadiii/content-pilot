import { sql } from 'drizzle-orm';
import { db } from '@/db';

export const GET = async () => {
  try {
    await db.execute(sql`SELECT 1`);
    return Response.json({ ok: true });
  } catch {
    return Response.json({ ok: false }, { status: 503 });
  }
};
