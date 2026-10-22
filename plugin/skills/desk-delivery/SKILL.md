---
name: desk-delivery
description: Deliver a finished retainer request, close it, or handle feedback, in the Client Desk. Use when Chowderr says a request is done, shares a deliverable link, or a client asks for changes.
---

# Delivering

1. `deliver_request` with a `note` the client will read (what was done, how to use it, anything they need to do) and the `deliverableUrl` if there is one.
   - This posts a client-visible delivery update, frees the active slot, and starts the next queued request automatically. Pass `startNext: false` only if Chowderr says to hold.
2. When the client confirms it works, `close_request`.
3. If they want changes to what was delivered, `reopen_request` with the reason. It goes to the front of their queue, so it runs next.
4. If the change is really new work (a new trigger or a new result), log it as a new request instead (see desk-intake).

After delivering, say which request started next, if any, so Chowderr knows what's next.
