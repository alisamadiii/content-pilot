# content-pilot

Self-hosted AI website editor. A client opens a **live preview session** for their website repo and chats with an AI editor while watching the changes render in real time; on publish the edits are committed and pushed to GitHub, and your existing CI/CD deploys them.

- **Dashboard** — live sessions with full transcripts, workspaces, API keys. Single admin account.
- **API** — `x-api-key` (server-to-server) or short-lived edit-token (client site) secured endpoints to open sessions, send messages, and stream events.
- **Preview supervisor** — one ephemeral dev server + AI chat per repo, with guardrails:
  - Content-only editing scope; the AI edits inside a clone, the supervisor does all git operations.
  - Secrets, lockfiles, `package.json`, and `.github/` are blocked from any commit.
  - Per-repo provider: Gemini by default (cheap), Claude for paying clients.

## Requirements

- Postgres
- `git` and access to the AI provider (Claude Agent SDK via API key, or the Gemini CLI) available to the supervisor
- A GitHub fine-grained PAT with Contents read/write on the target repos

## Local development

Previews need TWO processes running side by side — the web app and the preview supervisor:

```sh
pnpm install
docker compose up -d db          # Postgres on :5433
cp .env.example .env             # fill GITHUB_PAT, BETTER_AUTH_SECRET, provider keys
pnpm db:push                     # create tables
pnpm dev                         # dashboard on http://localhost:3010
pnpm preview                     # preview supervisor (separate terminal) — REQUIRED, or sessions hang at "starting"
```

Get a repo's id: `gh api repos/<owner>/<repo> --jq .id`

First visit to the dashboard creates the admin account (sign-up locks afterward).

## Self-hosting (Coolify / Docker)

A multi-arch image is published to GHCR on every push to `main`:

```
ghcr.io/<owner>/content-pilot:latest
```

1. Create a Postgres resource and a new service from the image above.
2. Set env vars: `DATABASE_URL`, `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL` (public URL), `GITHUB_PAT`, `EDIT_TOKEN_SECRET` (shared with the hub), and the provider keys.
3. Attach two persistent volumes:
   - `/data/workspace` — repo clones
   - `/home/nextjs/.claude` — provider auth
4. Deploy, open the URL, create the admin account, generate an API key.

The container runs schema sync (`drizzle-kit push`), the preview supervisor, and the web server; if either process dies the container exits and your orchestrator restarts it.

## API

Endpoints accept either an `x-api-key` header (server-to-server) or a Bearer edit-token minted by the hub for a specific repo (client site). CORS is open — the edit-token is the security boundary.

| Method | Path | Description |
| --- | --- | --- |
| POST | `/api/v1/sessions` | Create or join a live session: `{ repoId, requestedBy? }` |
| GET | `/api/v1/sessions?repoId=` | Current session for a repo (omit `repoId`, api-key only, for all live sessions) |
| GET | `/api/v1/sessions/:id` | Session status |
| POST | `/api/v1/sessions/:id/messages` | Send a chat message (queues an AI edit turn) |
| GET | `/api/v1/sessions/:id/events` | SSE stream of status / chat / commit events (resumable via `Last-Event-ID`) |
| POST | `/api/v1/sessions/:id/heartbeat` | Keep the session alive |

Session statuses: `starting → installing → ready` (live); `paused` when idle-parked; `needs_config` when the site folder can't be resolved; plus `failed`, `closed`, `published`, `expired`.

## License

MIT
