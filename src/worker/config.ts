import 'dotenv/config';
import { mkdirSync } from 'fs';
import { resolve } from 'path';

export const config = {
  // GitHub App ("Ali Samadi App"): every clone/push runs on a per-repo
  // installation token. The private key is the base64 of GitHub's PKCS#1 PEM
  // so it fits a single-line env var. Required in production; without them
  // git falls back to the system credential helper (local dev only).
  githubAppId: process.env.GITHUB_APP_ID || '',
  githubAppPrivateKey: process.env.GITHUB_APP_PRIVATE_KEY || '',
  workspaceDir: resolve(process.env.WORKSPACE_DIR || './workspace'),
  gitAuthorName: process.env.GIT_AUTHOR_NAME || 'AI Edit Bot',
  gitAuthorEmail: process.env.GIT_AUTHOR_EMAIL || 'ai-edits@localhost',
};

export const ensureWorkspace = () => {
  mkdirSync(config.workspaceDir, { recursive: true });
};
