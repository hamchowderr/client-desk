---
name: desk-status
description: Report where retainer clients and their requests stand, from the Client Desk. Use for "what's due today", "where are we with <client>", "what's active", morning check-ins, or before replying to a client about status.
---

# Reporting status

## Across all clients

Use `show_board` when the host can show it (Claude Desktop renders it as a board). Otherwise `digest`. Lead with what needs Chowderr:

1. **Replies overdue**, then **replies due today**. The Retainer page promises: sent before 10pm the client's time on a business day, the reply lands that day. Any client-visible move by Chowderr (scoping, queueing, a client-visible update) counts as the reply.
2. Active work per client, and anything in review waiting on the client's OK.
3. Requests waiting on a client, and what was asked.

Keep it to what changed or needs action. Don't list clients with nothing open unless asked.

## One client

`get_client` gives the retainer (status, next charge, paused months, active limit), active work, queue in order, intake and items in review. For one request's history, `get_request`.

## Writing to a client

Only client-visible updates reach them: `add_update` with `visibility: "client"`. Internal notes never leave the desk. Write in plain words, lead with what changed and what happens next, and never promise a date the queue doesn't support.
