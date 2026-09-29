import 'dotenv/config';
import { mkdirSync } from 'fs';
import { resolve } from 'path';

export const config = {
  // Optional: when empty, git falls back to the system's credential helper
  // (useful for local development; set a PAT in production).
  githubPat: process.env.GITHUB_PAT || '',
  workspaceDir: resolve(process.env.WORKSPACE_DIR || './workspace'),
  gitAuthorName: process.env.GIT_AUTHOR_NAME || 'AI Edit Bot',
  gitAuthorEmail: process.env.GIT_AUTHOR_EMAIL || 'ai-edits@localhost',
};

export const ensureWorkspace = () => {
  mkdirSync(config.workspaceDir, { recursive: true });
};
