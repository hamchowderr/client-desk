# Client Desk

Otaku Solutions' internal desk for retainer clients and their requests. It is API first: one Mastra server (Hono under the hood) on Doltgres, version-controlled Postgres, that Chowderr, his agents and each client's agent all talk to. The Retainer rules from the website are enforced by the server, so every caller gets the same answer.

| Surface | Where | Who |
|---|---|---|
| REST | `/desk/*` (OpenAPI at `/api/openapi.json` with a key; Swagger UI at `/swagger-ui`) | scripts, webhooks, a future portal |
| MCP, admin | `/api/mcp/desk/mcp` | Chowderr in Claude Code / Claude Desktop |
| MCP, client | `/api/mcp/desk-client/mcp` | one client's agent in their Slack or Telegram |
| Health | `/health` (no key) | Coolify |

Both MCP servers speak the 2026-07-28 protocol and the older 2025-11-25 one, so current and older Claude clients connect.

## What the rules mean in code

- **Requests** get ids per client (`GMA-012`), move `new → scoping → queued → active → in_review → done`, and can wait on the client, be declined or be split.
- **Queueing** needs a type (build, fix, decision, working session), one trigger, one result and a size of 2–5 business days. Bigger work is split; the parts take the parent's place in the queue.
- **Active limit** is per retainer (default 1, up to 10). Starting past it is refused. Delivering one starts the next in the queue.
- **Reply clock**: a client message received before 10pm in the client's time zone on a business day is due a reply that day; otherwise by the end of the next business day. Your first client-visible note stops the clock.
- **Kickoff** gates work: a retainer is `onboarding` until the kickoff is logged.
- **Pauses** are by billing month, set before that month's charge, at most 3 in a row. Paused retainers can't start work.
- **Cancelling** takes effect at the end of the paid month.
- **Client keys** only ever see their own client and only client-visible updates; anything else reads as not found.

## Set up

1. Run Doltgres (on Coolify, `docker-compose.yaml` brings its own) and point `DATABASE_URL` at it. Plain Postgres works too, without history.
2. Point `MASTRA_DATABASE_URL` at plain Postgres (Supabase) for Mastra's own tables.
3. Generate a bootstrap admin key (`openssl rand -hex 24`) and store it as `DESK_ADMIN_KEY`.
4. Install and migrate:
   ```sh
   npm ci
   DATABASE_URL=... npm run db:migrate
   ```
5. Load your current retainer clients. Copy `clients.example.json`, fill it in, then:
   ```sh
   DATABASE_URL=... npm run import -- clients.json
   ```
   Re-running skips clients that already exist.
6. Mint keys (each is printed once; store it in Infisical):
   ```sh
   DATABASE_URL=... npm run key:create -- admin claude-code
   DATABASE_URL=... npm run key:create -- client GMA gma-telegram
   ```
   On the live desk, use the admin API instead: `POST /desk/keys` with `{"label": "gma-telegram", "scope": "client", "client": "GMA"}` returns the key once. `GET /desk/keys` lists keys (never the keys themselves) and `POST /desk/keys/:id/revoke` turns one off. The same actions are MCP tools (`create_key`, `list_keys`, `revoke_key`).

## History

On Doltgres every change through the API or MCP is its own commit, authored by the caller (`owner`, `agent:<label>`, `client-agent:<label>`) and named after the action, e.g. `scope_request KBS-001`.

- `history` lists the commits, newest first.
- `history_diff` shows what a commit changed, row by row, before and after.
- `restore` puts the whole desk back the way it was at a commit. The state it replaces is kept on a `before-restore-…` branch, so a restore can be undone.

Doltgres 1.4 has no row locks, so transactions that must not overlap (taking a request number, starting work against the active limit) rewrite a `claim` column instead: Doltgres rejects the second of two transactions that change the same cell, and the server retries it. Desk tables sit in the `public` schema because Doltgres 1.4 breaks foreign keys in other schemas.

## Run

```sh
npm run dev        # local, with Mastra Studio
npm run build && DATABASE_URL=... MASTRA_DATABASE_URL=... npm start
```

On Coolify, deploy `docker-compose.yaml` (the desk plus its Doltgres) with `MASTRA_DATABASE_URL`, `DESK_ADMIN_KEY` and optionally `DESK_CAPACITY` set; Coolify generates the Doltgres password. The desk container runs migrations, then serves on port 4111. To move an existing desk from plain Postgres, set `COPY_FROM_DATABASE_URL` for one start: an empty desk copies every row across, ids and all.

## Use it from Claude

**Claude Code**: add this repo as a plugin marketplace and install `client-desk`. It brings the MCP server and the `desk-intake`, `desk-status` and `desk-delivery` skills. Set `DESK_API_KEY` (an admin key) and, if the server isn't at `https://desk.otakusolutions.io`, `DESK_URL`.

```sh
/plugin marketplace add hamchowderr/client-desk
/plugin install client-desk@otaku-client-desk
```

**Claude Desktop**: add a custom connector, or in `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "client-desk": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "https://desk.otakusolutions.io/api/mcp/desk/mcp", "--header", "Authorization:Bearer ${DESK_API_KEY}"],
      "env": { "DESK_API_KEY": "desk_admin_..." }
    }
  }
}
```

Ask for "the board" and the `show_board` tool renders the board inline in hosts that support MCP Apps; other hosts get the same data as text. The skills are also served as `skill://…/SKILL.md` resources, so any MCP client can read them.

## Test

```sh
npm test                    # Retainer rules against an in-memory Postgres (PGlite)
TEST_DATABASE_URL=postgresql://postgres:password@localhost:5432/postgres npm test   # same on a Doltgres server, plus two-caller races
npm run typecheck
DESK_ADMIN=... DESK_CLIENT=... npm run test:mcp            # against a running server
MCP_LEGACY=1 DESK_ADMIN=... DESK_CLIENT=... npm run test:mcp   # same, older protocol
```

## Layout

```
src/db/          Drizzle schema and connection
src/domain/      Retainer rules: clients, retainers, requests, digest, keys
src/mastra/      Mastra server: auth, REST routes, MCP servers (one ops list feeds both)
src/apps/        MCP Apps views (board)
plugin/          Claude Code plugin: MCP config and Chowderr's skills
skills/          Skills served only to client agents
drizzle/         SQL migrations
```

## Next phases

- **Phase 2**: billing in (Stripe / FluentCart webhooks move retainers and charge dates), CRM out (FluentCRM first; HighLevel and others behind the same adapter; none is fine).
- **Phase 3**: per-client channel agents (Telegram, Slack in the client's own workspace) and a client portal for clients without a channel.
