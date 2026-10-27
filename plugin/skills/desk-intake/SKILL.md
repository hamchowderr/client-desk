---
name: desk-intake
description: Take a retainer client's ask and turn it into a typed, scoped, queued request in the Client Desk. Use when Chowderr says a client asked for something, pastes a client message, or says "queue this for <client>".
---

# Taking a request in

The Client Desk enforces the Retainer rules. Your job is to get each ask into the shape those rules need, then let the tools do the checking.

## What a request is

One request is **one trigger and one result** handed back to the client. It has one of four types:

| Type | Use when |
| --- | --- |
| `build` | Something new gets made: an automation, an agent, a workflow |
| `fix` | Something that worked is broken or wrong |
| `decision` | The client needs a recommendation or a choice made with them |
| `working_session` | Time together to do or teach something live |

Every request is sized to **2 to 5 business days**. Anything bigger is split.

## Steps

1. Find the client: `get_client` with their code (e.g. `GMA`). If you don't know the code, `list_clients`.
2. Log it: `create_request` with a short title in the client's words and `source` (telegram, slack, email, call, owner).
3. Scope it: `scope_request` with `type`, `trigger` (what starts it), `result` (what comes back), `systems` (which tools, accounts or places it touches), `currentWay` (how it's done today, or what goes wrong now), `for` (who it's for: one of the client's customers, a team member, or the client's own company; `who_for` lists them, `add_customer` adds someone with first name, last name and company), any `links`, and `sizeDays`.
   - If you can't tell the trigger or result from what the client said, don't guess. Ask Chowderr, or `wait_on_client` with the question.
   - If it needs a call to understand, set `needsCall: true`.
4. Too big for 5 days? `split_request` into parts of 2 to 5 days that each have their own result. They queue in order where the original sat.
5. `queue_request`. If the client has a free active slot, `start_next` starts it.

## Rules the tools enforce (don't work around them)

- A client can't send a request without trigger, result, systems, current way and who it's for. Requests Chowderr logs can start bare and be filled in while scoping.
- A request can't be queued without type, trigger, result, size and who it's for.
- Clients can send unlimited requests; only how many are active at once is capped.
- A client can't have more active requests than their retainer's active limit (1 unless Chowderr raised it).
- Nothing starts before the kickoff call is logged, or in a paused month.
- Retainer work always goes ahead of hourly work.

When a tool refuses, tell Chowderr the rule in plain words and what would unblock it.
