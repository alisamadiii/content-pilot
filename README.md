# content-pilot

Self-hosted AI content-edit runner. Clients (or you) submit plain-text edit requests for a website repo; a worker picks them up, runs [Claude Code](https://claude.com/claude-code) headless inside a clone of the repo, applies **content-only** changes (text, images, CMS JSON), commits and pushes to GitHub. Your existing CI/CD deploys the change.

- **Dashboard** — jobs with full Claude logs, repos, API keys. Single admin account.
- **API** — `x-api-key`-secured endpoints so your own dashboard/app can create jobs and read history.
- **Worker** — polls the database, one Claude invocation per job, hard guardrails:
  - Claude gets read/edit tools only — the worker itself does all git operations.
  - Requests outside content editing (new pages, redesigns, config changes) are rejected with a client-friendly reason.
  - A path denylist reverts any change touching `package.json`, lockfiles, `.github/`, configs, etc.

## Requirements

- Postgres
- `git` and the Claude Code CLI (`npm i -g @anthropic-ai/claude-code`) available to the worker, with `claude login` completed (or an API key configured for Claude Code)
- A GitHub fine-grained PAT with Contents read/write on the target repos

## Local development

```sh
pnpm install
docker compose up -d db          # Postgres on :5433
cp .env.example .env             # fill GITHUB_PAT, BETTER_AUTH_SECRET
pnpm db:push                     # create tables
pnpm dev                         # dashboard on http://localhost:3010
pnpm worker                      # poll loop (separate terminal)
pnpm seed <repoId> <owner> <repo> main "Change the hero headline to X"
```

Get a repo's id: `gh api repos/<owner>/<repo> --jq .id`

First visit to the dashboard creates the admin account (sign-up locks afterward).

## Self-hosting (Coolify / Docker)

A multi-arch image is published to GHCR on every push to `main`:

```
ghcr.io/<owner>/content-pilot:latest
```

1. Create a Postgres resource and a new service from the image above.
2. Set env vars: `DATABASE_URL`, `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL` (public URL), `GITHUB_PAT`.
3. Attach two persistent volumes:
   - `/data/workspace` — repo clones
   - `/home/nextjs/.claude` — Claude CLI auth
4. Deploy, open the URL, create the admin account, generate an API key.
5. One-time Claude auth inside the container:
   `docker exec -it <container> claude login`

The container runs schema sync (`drizzle-kit push`), the worker, and the web server; if either process dies the container exits and your orchestrator restarts it.

## API

All endpoints require the `x-api-key` header (create keys in Settings).

| Method | Path | Description |
| --- | --- | --- |
| POST | `/api/v1/jobs` | Create a job: `{ repoId, owner, repo, branch?, prompt, requesterId?, requestedBy? }` |
| GET | `/api/v1/jobs?repoId=&requesterId=&limit=` | List jobs (newest first, no logs) |
| GET | `/api/v1/jobs/:id` | Single job status |
| DELETE | `/api/v1/jobs/:id` | Cancel a job while still queued |

Job statuses: `queued → running → done | rejected | failed` (plus `canceled`).

`rejected` means the AI declined the request (out of scope) — the `error` field contains a client-friendly explanation you can show directly to end users.

## License

MIT
