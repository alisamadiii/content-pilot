import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { createAuthMiddleware, APIError } from 'better-auth/api';
import { count } from 'drizzle-orm';
import { db } from '@/db';
import * as schema from '@/db/schema';

export const auth = betterAuth({
  database: drizzleAdapter(db, {
    provider: 'pg',
    schema: {
      user: schema.user,
      session: schema.session,
      account: schema.account,
      verification: schema.verification,
    },
  }),
  secret: process.env.BETTER_AUTH_SECRET,
  baseURL: process.env.BETTER_AUTH_URL,
  emailAndPassword: {
    enabled: true,
  },
  hooks: {
    // Single-admin instance: block sign-up once a user exists.
    before: createAuthMiddleware(async (ctx) => {
      if (ctx.path === '/sign-up/email') {
        const [{ value }] = await db.select({ value: count() }).from(schema.user);
        if (value > 0) {
          throw new APIError('FORBIDDEN', {
            message: 'Sign-up is disabled: an admin account already exists.',
          });
        }
      }
    }),
  },
});

export type Session = typeof auth.$Infer.Session;
