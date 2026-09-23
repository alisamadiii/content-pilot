import 'dotenv/config';
import { mkdirSync } from 'fs';
import { resolve } from 'path';

const required = (name: string) => {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
};

export const config = {
  databaseUrl: required('DATABASE_URL'),
  // Optional: when empty, git falls back to the system's credential helper
  // (useful for local development; set a PAT in production).
  githubPat: process.env.GITHUB_PAT || '',
  workspaceDir: resolve(process.env.WORKSPACE_DIR || './workspace'),
  pollIntervalMs: Number(process.env.POLL_INTERVAL_MS) || 300_000,
  // Max queued jobs per repo merged into one Claude session
  batchLimit: Number(process.env.BATCH_LIMIT) || 5,
  jobTimeoutMs: Number(process.env.JOB_TIMEOUT_MS) || 600_000,
  claudeBin: process.env.CLAUDE_BIN || 'claude',
  // Simple content edits don't need a big model — haiku is fast and cheap.
  claudeModel: process.env.CLAUDE_MODEL || 'haiku',
  gitAuthorName: process.env.GIT_AUTHOR_NAME || 'AI Edit Bot',
  gitAuthorEmail: process.env.GIT_AUTHOR_EMAIL || 'ai-edits@localhost',
  staleRunningMinutes: Number(process.env.STALE_RUNNING_MINUTES) || 30,
  maxLogBytes: 100_000,
};

export const ensureWorkspace = () => {
  mkdirSync(config.workspaceDir, { recursive: true });
};
