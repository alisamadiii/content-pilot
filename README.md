# content-pilot

Self-hosted AI website editor. A client opens a **live preview session** for their website repo and chats with an AI editor while watching the changes render in real time; on publish the edits are committed and pushed to GitHub, and your existing CI/CD deploys them.

- **Dashboard** — live sessions with full transcripts, workspaces, API keys. Single admin account.
- **API** — `x-api-key` (server-to-server) or short-lived edit-token (client site) secured endpoints to open sessions, send messages, and stream events.
- **Preview supervisor** — one ephemeral dev server + AI chat per repo, with guardrails:
  - Content-only editing scope; the AI edits inside a clone, the supervisor does all git operations.
  - Secrets, lockfiles, `package.json`, and `.github/` are blocked from any commit.
  - Per-repo provider: Gemini by default (cheap), Claude for paying clients.
  - Token diet: the file for the page being edited (plus its components) is inlined into every request, uploaded images are placed by the server so the AI only adds the reference, and Gemini runs with a replacement system prompt, six tools and LOW thinking. `/skill` messages inline the repo's `.claude/skills/<name>/SKILL.md` for Gemini (Claude's harness expands them itself). `pnpm exec tsx scripts/gemini-probe.ts <projectId> "<message>"` measures one message's tokens and tool calls against a clone.

## Requirements

- Postgres
- `git` and access to the AI provider (Claude Agent SDK via API key, or the Gemini CLI) available to the supervisor
- A GitHub App (Contents read/write) installed on the target repos — set `GITHUB_APP_ID` + `GITHUB_APP_PRIVATE_KEY`

## Local development

Previews need TWO processes running side by side — the web app and the preview supervisor:

```sh
pnpm install
docker compose up -d db          # Postgres on :5433
cp .env.example .env             # fill GITHUB_APP_ID / GITHUB_APP_PRIVATE_KEY, BETTER_AUTH_SECRET, provider keys (app creds optional locally — git falls back to your credential helper)
pnpm db:migrate                  # create / update tables from drizzle/
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
2. Set env vars: `DATABASE_URL`, `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL` (public URL), `GITHUB_APP_ID` + `GITHUB_APP_PRIVATE_KEY` (base64 PEM), `EDIT_TOKEN_SECRET` (shared with the hub), and the provider keys.
3. Attach two persistent volumes:
   - `/data/workspace` — repo clones, plus the Gemini CLI home (`.gemini-home`), per-session Gemini system prompts (`.cp-prompts`) and staged uploads (`.uploads`)
   - `/home/nextjs/.claude` — provider auth
4. Deploy, open the URL, create the admin account, generate an API key.

The container applies pending migrations (`src/db/migrate.ts`, from the committed `drizzle/` folder), then starts the preview supervisor and the web server; if either process dies the container exits and your orchestrator restarts it.

## API

Endpoints accept either an `x-api-key` header (server-to-server) or a Bearer edit-token minted by the hub for a specific repo (client site). CORS is open — the edit-token is the security boundary.

| Method | Path | Description |
| --- | --- | --- |
| POST | `/api/v1/sessions` | Create or join a live session: `{ projectId, owner, repo, source?, requestedBy?, branch? }` (`projectId` = the hub project uuid; one workspace per project). `branch` runs the session on a named branch (commits persist there); omitted = ephemeral `preview/<id>` off the default branch. 409 `branch_mismatch` when the project's live session is on another branch (close it first) |
| GET | `/api/v1/sessions?projectId=` | Current session for a project (omit `projectId`, api-key only, for all live sessions) |
| GET | `/api/v1/sessions/:id` | Session status |
| POST | `/api/v1/sessions/:id/messages` | Send a chat message (queues an AI edit turn) |
| GET | `/api/v1/sessions/:id/events` | SSE stream of status / chat / commit events (resumable via `Last-Event-ID`) |
| POST | `/api/v1/sessions/:id/heartbeat` | Keep the session alive |

Session statuses: `starting → installing → ready` (live); `paused` when idle-parked; `needs_config` when the site folder can't be resolved; plus `failed`, `closed`, `published`, `expired`.

## License

MIT
