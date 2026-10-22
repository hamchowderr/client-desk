---
name: desk-status
description: Report where retainer clients and their requests stand, from the Client Desk. Use for "what's due today", "where are we with <client>", "what's active", morning check-ins, or before replying to a client about status.
---

# Reporting status

## Across all clients

Use `show_board` when the host can show it (Claude renders it as an interactive command center). Otherwise `digest`. Lead with what needs Chowderr:

1. **Replies overdue**, then **replies due today**. The Retainer page promises: sent before 10pm the client's time on a business day, the reply lands that day. Any client-visible move by Chowderr (scoping, queueing, a client-visible update) counts as the reply.
2. Active work per client, and anything in review waiting on the client's OK.
3. Requests waiting on a client, and what was asked.

Keep it to what changed or needs action. Don't list clients with nothing open unless asked.

## One client

`get_client` gives the retainer (status, next charge, paused months, active limit), active work, queue in order, intake and items in review. For one request's history, `get_request`.

## Their week, and billing

`weekly_recap` shows one client's last seven days (delivered, in progress, waiting on them, up next); from its screen Chowderr can email it to them (`send_recap`). Only send it when Chowderr says to. `billing_history` shows a client's plan, next charge, paused months and Stripe payments.

## Adding a client

Use `new_client` with whatever Chowderr has said (name, contact, email, rate, first charge date). It opens a form; Chowderr checks it and presses Create, which adds the client, their main contact, the retainer and the kickoff in one step. Don't call `create_client`, `add_contact` and `start_retainer` separately unless the form can't show.

## Writing to a client

Only client-visible updates reach them: `add_update` with `visibility: "client"`. Those, deliveries (`deliver_request`) and questions (`wait_on_client`) are also emailed to the client's people, so write them to be read on their own. Internal notes never leave the desk. Write in plain words, lead with what changed and what happens next, and never promise a date the queue doesn't support.
