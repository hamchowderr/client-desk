# Client Desk

Otaku Solutions' internal desk for retainer clients and their requests. It is API first: one Mastra server (Hono under the hood) on Doltgres, version-controlled Postgres, that Chowderr, his agents and each client's agent all talk to. The Retainer rules from the website are enforced by the server, so every caller gets the same answer.

| Surface | Where | Who |
|---|---|---|
| REST | `/desk/*` (OpenAPI at `/api/openapi.json` with a key; Swagger UI at `/swagger-ui`) | scripts, webhooks, a future portal |
| MCP, one address | `/mcp`, with sign-in (OAuth) | clients adding the Otaku Solutions connector in Claude; Chowderr too |
| MCP, admin | `/api/mcp/desk/mcp` (admin key) | Chowderr in Claude Code / Claude Desktop |
| MCP, client | `/api/mcp/desk-client/mcp` (client key) | a client's own agent, by key |
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

**Clients** add a custom connector in Claude with the address `https://desk.otakusolutions.io/mcp` and press Connect. A sign-in page opens with Continue with Microsoft and Continue with Google; the email they sign in with is matched to their contact on the desk, and they get their own client's tools. Nothing to paste. An email the desk doesn't know gets a page telling them to ask Otaku Solutions to add it.

How it works (`src/oauth/`): the desk is its own OAuth 2.1 authorization server for `/mcp`, as the MCP spec describes. It publishes protected-resource and authorization-server metadata, accepts Client ID Metadata Documents (what Claude uses) and dynamic registration, requires PKCE S256, and issues one-hour access tokens with 30-day refresh tokens. Registrations, sign-in state, codes and tokens are sealed (AES-GCM, key from `DESK_OAUTH_SECRET`, or derived from `DESK_ADMIN_KEY`) rather than stored, so nothing lands in the versioned desk data. Every token is checked against the contact on each use: remove a contact or change their email and their access stops. Emails in `DESK_OWNER_EMAILS` sign in to the admin tools instead. Desk keys keep working at `/mcp` and everywhere else.

One-time setup, both apps owned by Otaku Solutions:

- **Microsoft**: Entra ID > App registrations > New, supported accounts "any organizational directory and personal Microsoft accounts", web redirect `https://desk.otakusolutions.io/oauth/callback/microsoft`. Under Token configuration add the optional ID-token claims `email` and `xms_edov` (the desk only trusts a Microsoft email when the tenant has verified its domain). Create a client secret. Env: `MICROSOFT_CLIENT_ID`, `MICROSOFT_CLIENT_SECRET`.
- **Google**: Google Cloud > APIs & Services > Credentials > OAuth client ID (Web application), redirect `https://desk.otakusolutions.io/oauth/callback/google`, consent screen External and published, scopes `openid email profile`. Env: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`.

Only the configured buttons show. `npx tsx test/e2e/oauth-smoke.ts <email>` drives the flow with the MCP SDK's own OAuth client against a running server.

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

## Billing

Stripe tells the desk when an invoice is paid, so the next charge date moves on by itself.

1. In Stripe, add a webhook endpoint `https://desk.otakusolutions.io/desk/webhooks/stripe` for the `invoice.paid` event.
2. Set its signing secret as `STRIPE_WEBHOOK_SECRET` on the server. Without it the endpoint answers 503.

A paid invoice finds its retainer by the Stripe customer or subscription id (`link_billing`), or, the first time, by the invoice email matching one of the client's contacts; that match saves the customer id for next time. A payment within 10 days of the next charge (or after it) moves the charge on a month. An earlier payment, an invoice that matches no client, and any other event are logged and change nothing. Redelivered events are ignored. Every payment is listed by `billing_history`, and on Doltgres each one is a commit authored by `stripe`.

## CRM

The desk mirrors its clients into FluentCRM on the hub. Each contact with an email gets the tags `Desk client`, their client code (e.g. `Desk: KBS`) and the retainer's state (`Desk: Active`, `Paused`, `Onboarding`, `Cancelling` or `Ended`; one at a time). New contacts are added as transactional, not as a marketing opt-in, and an existing contact keeps its status.

It syncs after any change to a client, contact or retainer, and every six hours for changes that come with the calendar (a paused month starting). `sync_crm` runs it on demand. Set `FLUENTCRM_AUTH` to `username:application password` for a hub user who can manage FluentCRM contacts (and `FLUENTCRM_URL` for a site other than the hub); without it the desk skips the CRM.

## Client agent

One agent works in each client's own chat. Every chat platform plugs into the same agent as a channel (Microsoft Teams today; Slack, email and others are another adapter, using [Chat SDK](https://chat-sdk.dev/adapters) adapters through Mastra channels).

Before each message runs, the desk checks who sent it. The sender must be a linked client contact, and the run then acts as that client, so the agent only ever sees and does what that client's own key could. Its playbook is `skills/client-agent`. A contact links their chat account one of two ways:

- **Automatically**, when the platform shares their email and exactly one contact has it.
- **With a code**: `invite_contact` returns a one-time code (valid 7 days); they send `link <code>` to the agent. `unlink_contact` disconnects them.

Anyone else gets a short "ask Chowderr for a link code" reply, and the agent doesn't run.

Webhook: `https://desk.otakusolutions.io/api/agents/client-agent/channels/<platform>/webhook`. Each platform verifies its own requests there (Teams with a Microsoft-signed token).

Settings: `ANTHROPIC_API_KEY` (and optionally `DESK_AGENT_MODEL`) for the model. Teams needs `TEAMS_APP_ID`, `TEAMS_APP_PASSWORD` and `TEAMS_APP_TENANT_ID` from an Azure Bot the client creates in their own Azure (single tenant), with its messaging endpoint set to the webhook above. A channel without settings stays off.

## Layout

```
src/db/          Drizzle schema and connection
src/domain/      Retainer rules: clients, retainers, requests, digest, keys, billing, crm
src/crm/         CRM adapters (FluentCRM)
src/mastra/      Mastra server: auth, REST routes, MCP servers (one ops list feeds both), client agent
src/apps/        MCP Apps views (board)
plugin/          Claude Code plugin: MCP config and Chowderr's skills
skills/          Skills served only to client agents
drizzle/         SQL migrations
```

## Next phases

- **Phase 2**: billing in (Stripe done; FluentCart next if a client pays there), CRM out (FluentCRM done; HighLevel and others fit the same adapter; none is fine).
- **Phase 3**: the client agent (Teams done; more channels plug in the same way) and a client portal for clients without a channel.
