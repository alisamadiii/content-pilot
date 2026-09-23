import {
  boolean,
  doublePrecision,
  index,
  integer,
  pgTable,
  serial,
  text,
  timestamp,
} from 'drizzle-orm/pg-core';

// ---------------------------------------------------------------------------
// better-auth tables (email + password, single admin)
// ---------------------------------------------------------------------------

export const user = pgTable('user', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  emailVerified: boolean('email_verified').notNull().default(false),
  image: text('image'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
});

export const session = pgTable('session', {
  id: text('id').primaryKey(),
  expiresAt: timestamp('expires_at').notNull(),
  token: text('token').notNull().unique(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
  ipAddress: text('ip_address'),
  userAgent: text('user_agent'),
  userId: text('user_id')
    .notNull()
    .references(() => user.id, { onDelete: 'cascade' }),
});

export const account = pgTable('account', {
  id: text('id').primaryKey(),
  accountId: text('account_id').notNull(),
  providerId: text('provider_id').notNull(),
  userId: text('user_id')
    .notNull()
    .references(() => user.id, { onDelete: 'cascade' }),
  accessToken: text('access_token'),
  refreshToken: text('refresh_token'),
  idToken: text('id_token'),
  accessTokenExpiresAt: timestamp('access_token_expires_at'),
  refreshTokenExpiresAt: timestamp('refresh_token_expires_at'),
  scope: text('scope'),
  password: text('password'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
});

export const verification = pgTable('verification', {
  id: text('id').primaryKey(),
  identifier: text('identifier').notNull(),
  value: text('value').notNull(),
  expiresAt: timestamp('expires_at').notNull(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
});

// ---------------------------------------------------------------------------
// Domain tables
// ---------------------------------------------------------------------------

export const apiKey = pgTable('api_key', {
  id: serial('id').primaryKey(),
  name: text('name').notNull(),
  // sha256 of the plaintext key; plaintext is shown once at creation
  keyHash: text('key_hash').notNull().unique(),
  lastUsedAt: timestamp('last_used_at'),
  revokedAt: timestamp('revoked_at'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
});

export const repo = pgTable('repo', {
  id: serial('id').primaryKey(),
  // GitHub repository id — the cross-system join key
  repoId: integer('repo_id').notNull().unique(),
  owner: text('owner').notNull(),
  repo: text('repo').notNull(),
  branch: text('branch').notNull().default('main'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
});

export const JOB_STATUS_VALUES = [
  'queued',
  'running',
  'done',
  'rejected',
  'failed',
  'canceled',
] as const;
export type JobStatus = (typeof JOB_STATUS_VALUES)[number];

export const job = pgTable(
  'job',
  {
    id: serial('id').primaryKey(),
    repoId: integer('repo_id').notNull(),
    // Denormalized so the worker never needs joins
    owner: text('owner').notNull(),
    repo: text('repo').notNull(),
    branch: text('branch').notNull(),
    prompt: text('prompt').notNull(),
    // Opaque caller user id (e.g. the hub's better-auth user id) for per-client history
    requesterId: text('requester_id'),
    // Display label (name/email) shown in the dashboard
    requestedBy: text('requested_by'),
    // Element-picker context
    fieldPath: text('field_path'),
    pageUrl: text('page_url'),
    elementSelector: text('element_selector'),
    // cms-bridge source annotation: `<project>:<file>:<line>` from data-cms-src,
    // and the element's current text, so the AI edits the exact source location.
    sourceRef: text('source_ref'),
    elementText: text('element_text'),
    status: text('status').$type<JobStatus>().notNull().default('queued'),
    // Client-facing error / rejection reason
    error: text('error'),
    resultSummary: text('result_summary'),
    commitSha: text('commit_sha'),
    // Exact input sent to Claude (guardrail skill + assembled batch prompt) as a
    // JSON array of { text, value? } segments, stored on the batch lead so the
    // dashboard can render template vs backend-value with different opacity.
    promptSent: text('prompt_sent'),
    // Claude stdout/stderr, dashboard-only, truncated
    logs: text('logs'),
    // Jobs solved together in one Claude session share the lead job's id;
    // usage/cost and full logs live on the lead job only.
    batchId: integer('batch_id'),
    // AI run info reported by the Claude CLI (stored on the batch lead)
    model: text('model'),
    inputTokens: integer('input_tokens'),
    outputTokens: integer('output_tokens'),
    costUsd: doublePrecision('cost_usd'),
    startedAt: timestamp('started_at'),
    finishedAt: timestamp('finished_at'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
  },
  (table) => [
    index('idx_job_repo_id_created_at').on(table.repoId, table.createdAt),
    index('idx_job_status').on(table.status),
    index('idx_job_requester_id_created_at').on(
      table.requesterId,
      table.createdAt
    ),
  ]
);
