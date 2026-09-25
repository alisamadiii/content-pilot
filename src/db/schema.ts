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

// ---------------------------------------------------------------------------
// Outbound webhooks: notify downstream apps when a job reaches a terminal state.
// ---------------------------------------------------------------------------

export const WEBHOOK_EVENT_VALUES = ['done', 'rejected', 'failed'] as const;
export type WebhookEvent = (typeof WEBHOOK_EVENT_VALUES)[number];

export const webhook = pgTable('webhook', {
  id: serial('id').primaryKey(),
  name: text('name').notNull(),
  url: text('url').notNull(),
  // Signing secret (whsec_…). Stored recoverably — unlike api_key.keyHash — because
  // the worker must recompute the HMAC on every send.
  secret: text('secret').notNull(),
  // null = all repos; otherwise the GitHub repo id (matches job.repoId).
  repoId: integer('repo_id'),
  // JSON array of WebhookEvent this webhook fires on (like promptSent's JSON convention).
  events: text('events').notNull(),
  enabled: boolean('enabled').notNull().default(true),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
});

export const webhookDelivery = pgTable(
  'webhook_delivery',
  {
    id: serial('id').primaryKey(),
    webhookId: integer('webhook_id').notNull(),
    jobId: integer('job_id'),
    repoId: integer('repo_id'),
    // The job status that fired this delivery.
    event: text('event').notNull(),
    url: text('url').notNull(),
    requestBody: text('request_body'),
    responseStatus: integer('response_status'),
    // Truncated response body for debugging.
    responseBody: text('response_body'),
    // Network/timeout error, when the request never got a response.
    error: text('error'),
    durationMs: integer('duration_ms'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  (table) => [
    index('idx_webhook_delivery_webhook_created').on(
      table.webhookId,
      table.createdAt
    ),
  ]
);

// ---------------------------------------------------------------------------
// Live-preview AI sessions: an ephemeral dev server + Claude chat per repo.
// The preview supervisor (src/preview/) owns these rows end to end.
// ---------------------------------------------------------------------------

export const PREVIEW_SESSION_STATUS_VALUES = [
  'starting',
  'installing',
  'ready',
  'restarting',
  'failed',
  'closed',
  'published',
  'expired',
] as const;
export type PreviewSessionStatus =
  (typeof PREVIEW_SESSION_STATUS_VALUES)[number];

/** Statuses in which a session owns its repo clone and dev server. */
export const PREVIEW_SESSION_LIVE_STATUSES = [
  'starting',
  'installing',
  'ready',
  'restarting',
] as const;

export const previewSession = pgTable(
  'preview_session',
  {
    // nanoid(12), lowercase — doubles as the preview subdomain label and the
    // suffix of the git branch (preview/<id>).
    id: text('id').primaryKey(),
    repoId: integer('repo_id').notNull(),
    // Denormalized like job — the supervisor never needs joins
    owner: text('owner').notNull(),
    repo: text('repo').notNull(),
    branch: text('branch').notNull(),
    status: text('status')
      .$type<PreviewSessionStatus>()
      .notNull()
      .default('starting'),
    // Dev-server runtime state, persisted for boot reconciliation
    port: integer('port'),
    pid: integer('pid'),
    // Claude Code CLI session id (from the stream-json init event); --resume
    // target so the chat keeps conversational context across messages.
    claudeSessionId: text('claude_session_id'),
    // Client-facing error when status = failed
    error: text('error'),
    requestedBy: text('requested_by'),
    lastActivityAt: timestamp('last_activity_at').notNull().defaultNow(),
    closedAt: timestamp('closed_at'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
  },
  (table) => [
    index('idx_preview_session_repo_status').on(table.repoId, table.status),
  ]
);

export const PREVIEW_MESSAGE_STATUS_VALUES = [
  'queued',
  'running',
  'done',
  'failed',
  'rejected',
] as const;
export type PreviewMessageStatus =
  (typeof PREVIEW_MESSAGE_STATUS_VALUES)[number];

export const previewMessage = pgTable(
  'preview_message',
  {
    id: serial('id').primaryKey(),
    sessionId: text('session_id').notNull(),
    role: text('role').$type<'user' | 'assistant'>().notNull(),
    content: text('content').notNull(),
    status: text('status')
      .$type<PreviewMessageStatus>()
      .notNull()
      .default('queued'),
    commitSha: text('commit_sha'),
    error: text('error'),
    model: text('model'),
    inputTokens: integer('input_tokens'),
    outputTokens: integer('output_tokens'),
    costUsd: doublePrecision('cost_usd'),
    startedAt: timestamp('started_at'),
    finishedAt: timestamp('finished_at'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  (table) => [index('idx_preview_message_session').on(table.sessionId, table.id)]
);

export const PREVIEW_EVENT_TYPE_VALUES = [
  'status',
  'claude',
  'commit',
  'message-done',
  'session-error',
] as const;
export type PreviewEventType = (typeof PREVIEW_EVENT_TYPE_VALUES)[number];

// SSE backing store: every chat/session event is a row so reconnecting
// clients replay losslessly via Last-Event-ID. Pruned on session close.
export const previewEvent = pgTable(
  'preview_event',
  {
    id: serial('id').primaryKey(),
    sessionId: text('session_id').notNull(),
    messageId: integer('message_id'),
    type: text('type').$type<PreviewEventType>().notNull(),
    // JSON payload, shape depends on type
    data: text('data').notNull(),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  (table) => [index('idx_preview_event_session').on(table.sessionId, table.id)]
);

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
    // Admin-triggered rerun with guardrails off (dashboard "retry without
    // limits" on a rejected job). Never settable through the public API.
    unrestricted: boolean('unrestricted').notNull().default(false),
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
