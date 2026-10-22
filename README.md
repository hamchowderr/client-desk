# Client Desk

Otaku Solutions' internal desk for retainer clients and their requests. It is API first: one Mastra server (Hono under the hood) on Doltgres, version-controlled Postgres, that Chowderr, Chowderr's agents and each client's agent all talk to. The Retainer rules from the website are enforced by the server, so every caller gets the same answer.

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

**Clients** add a custom connector in Claude with the address `https://desk.otakusolutions.io/mcp` and press Connect. A sign-in page asks for their email and emails them a 6-digit code (sent by FluentCRM on the hub, so it comes from the usual Otaku Solutions address). After the code, they allow Claude once and get their own client's tools. Nothing to paste, and no Microsoft or Google app to set up.

How it works (`src/auth/`): [Better Auth](https://www.better-auth.com) with its MCP plugin is the OAuth 2.1 server for `/mcp`. It handles discovery, Client ID Metadata Documents (what Claude uses), dynamic registration, PKCE, consent, and one-hour access tokens with refresh tokens. The email code is its email-OTP plugin. The desk adds the two pages (`/sign-in`, `/consent`) and the rules:

- Only emails the desk knows get a code or an account: a client contact's email, or one in `DESK_OWNER_EMAILS`, which signs in to the admin tools. The page never says whether an email is on file.
- Every request re-checks the email against the contacts, so removing a contact or changing their email cuts off their access.
- Better Auth's tables live in Mastra's Postgres (`MASTRA_DATABASE_URL`, schema `desk_auth`) and are created on start, so sign-ins stay out of the versioned desk data.
- Its secret is `DESK_AUTH_SECRET`, or derived from `DESK_ADMIN_KEY` when unset (rotating the admin key then signs everyone out).
- Codes need `FLUENTCRM_AUTH`. Desk keys keep working at `/mcp` and everywhere else.

`test/e2e/oauth-smoke.ts` drives the whole flow with the MCP SDK's own OAuth client against a running server, with `test/e2e/fake-fluentcrm.mjs` standing in for the hub.

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

In hosts that support MCP Apps (Claude on the web, desktop and phone), the desk's tools open interactive screens in the chat instead of plain text. Clients see a request card that fills in while Claude drafts it and sends with one press, a tracker for each request (stage, progress, what they'll get, Approve or Ask for changes), their work at a glance with a full-screen view, and a calendar for pausing a month. Chowderr gets a command center (`show_board`): reply deadlines that warm up as they close in, capacity, and every client's lanes with Start next, Mark done and queue reordering. Whatever is pressed on a screen is passed back to Claude. Clients also get their plan and payments (`my_billing`) and a weekly recap (`my_week`); Chowderr gets a new-client form (`new_client`, one press runs `setup_client`), each client's recap with a Send button (`weekly_recap`, `send_recap`) and billing (`billing_history`). Other hosts get the same data as text. The first time a screen opens, Claude asks the person to allow it. The skills are also served as `skill://…/SKILL.md` resources, so any MCP client can read them.

## Client emails

When Chowderr delivers a request, asks the client a question, or posts a client-visible update, the desk emails each of the client's contacts with an email address, through the hub's FluentCRM mailer (the same as sign-in codes). Each email has a link that opens Claude on that request. Set `DESK_CLIENT_EMAILS=off` to stop them; without `FLUENTCRM_AUTH` none are sent. A mail failure never fails the desk action.

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

## Layout

```
src/db/          Drizzle schema and connection
src/domain/      Retainer rules: clients, retainers, requests, digest, keys, billing, crm
src/crm/         CRM adapters (FluentCRM)
src/mastra/      Mastra server: auth, REST routes, MCP servers (one ops list feeds both)
src/apps/        MCP Apps screens: one view (desk.html + desk.ts) that draws per tool from views/
plugin/          Claude Code plugin: MCP config and Chowderr's skills
skills/          Skills served only to client agents
drizzle/         SQL migrations
```

## Next phases

- **Phase 2**: billing in (Stripe done; FluentCart next if a client pays there), CRM out (FluentCRM done; HighLevel and others fit the same adapter; none is fine).
- **Phase 3**: per-client channel agents (Telegram, Slack in the client's own workspace) and a client portal for clients without a channel.
