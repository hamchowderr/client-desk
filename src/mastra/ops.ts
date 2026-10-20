import { z } from 'zod'
import type { Db } from '../db/client'
import { CHANNEL_KINDS, REQUEST_STATUSES, REQUEST_TYPES } from '../db/schema'
import {
  addChannel,
  addContact,
  createClient,
  resolveClient,
  getClientOverview,
  listClients,
  updateClient,
} from '../domain/clients'
import { billingHistory, linkBilling } from '../domain/billing'
import { crmFromEnv } from '../crm'
import { syncCrm } from '../domain/crm'
import { digest } from '../domain/digest'
import { inviteContact, unlinkContact } from '../domain/identities'
import { diffHistory, listHistory, restoreTo } from '../domain/history'
import { DeskError } from '../domain/errors'
import { listApiKeys, mintApiKey, revokeKey } from '../domain/keys'
import type { Principal } from '../domain/principal'
import {
  addUpdate,
  closeRequest,
  createRequest,
  declineRequest,
  deliverRequest,
  getRequest,
  listRequests,
  queueRequest,
  reopenRequest,
  reorderQueue,
  scopeRequest,
  splitRequest,
  startNext,
  startRequest,
  waitOnClient,
} from '../domain/requests'
import {
  cancelRetainer,
  logKickoff,
  pauseMonth,
  setActiveLimit,
  setNextCharge,
  startRetainer,
  unpauseMonth,
} from '../domain/retainers'

/**
 * Every desk action, defined once. Routes, MCP tools and agents are all
 * generated from this list, so the rules can't drift between interfaces.
 */
export type Op<I extends z.ZodTypeAny = z.ZodTypeAny> = {
  id: string
  description: string
  audience: 'admin' | 'client'
  input: I
  run: (db: Db, p: Principal, input: z.infer<I>) => Promise<unknown>
  /** HTTP mapping. Path params are merged into the input. */
  http: { method: 'GET' | 'POST' | 'PATCH'; path: string }
  /** 'manual' for operations that manage Doltgres history themselves. */
  versioning?: 'manual'
}

const op = <I extends z.ZodTypeAny>(o: Op<I>) => o

const clientRef = z.string().describe('Client code like GMA, or the client id')
const requestRef = z.string().describe('Request id like GMA-012')
const requestType = z.enum(REQUEST_TYPES).describe('build, fix, decision or working_session')
const size = z.number().int().min(2).max(5).describe('Business days, 2 to 5')
const month = z.string().regex(/^\d{4}-\d{2}$/).describe('Calendar month, e.g. 2026-12')

const clientOnly = (p: Principal) => {
  if (p.kind !== 'client') throw new DeskError('forbidden', 'This is for client keys; use the admin tools')
  return p
}

export const adminOps = [
  op({
    id: 'digest',
    description:
      "Today's view across all clients: replies owed (overdue first), active work, queues, what's waiting on clients, and spots taken.",
    audience: 'admin',
    input: z.object({}),
    run: (db, p) => digest(db, p),
    http: { method: 'GET', path: '/desk/digest' },
  }),
  op({
    id: 'list_clients',
    description: 'All current clients with retainer status and counts of active, queued and waiting requests.',
    audience: 'admin',
    input: z.object({ includePast: z.boolean().optional() }),
    run: (db, p, i) => listClients(db, p, i),
    http: { method: 'GET', path: '/desk/clients' },
  }),
  op({
    id: 'get_client',
    description: "One client: their retainer, active request(s), queue in order, intake, items in review, and contacts.",
    audience: 'admin',
    input: z.object({ client: clientRef }),
    run: (db, p, i) => getClientOverview(db, p, i.client),
    http: { method: 'GET', path: '/desk/clients/:client' },
  }),
  op({
    id: 'create_client',
    description: 'Add a client. Code is 2 to 6 letters used in request ids (GMA -> GMA-001). Timezone is IANA, e.g. America/Chicago.',
    audience: 'admin',
    input: z.object({
      code: z.string(),
      name: z.string(),
      company: z.string().optional(),
      timezone: z.string().optional(),
      vaultNote: z.string().optional().describe('Path of the client note in the Obsidian vault'),
      notes: z.string().optional(),
    }),
    run: (db, p, i) => createClient(db, p, i),
    http: { method: 'POST', path: '/desk/clients' },
  }),
  op({
    id: 'update_client',
    description: 'Change a client’s name, company, timezone, notes, or mark them past.',
    audience: 'admin',
    input: z.object({
      client: clientRef,
      name: z.string().optional(),
      company: z.string().optional(),
      timezone: z.string().optional(),
      vaultNote: z.string().optional(),
      notes: z.string().optional(),
      status: z.enum(['active', 'past']).optional(),
    }),
    run: (db, p, { client, ...patch }) => updateClient(db, p, client, patch),
    http: { method: 'PATCH', path: '/desk/clients/:client' },
  }),
  op({
    id: 'add_contact',
    description: "Add a person on the client's side. The owner can pause or cancel; members can submit requests.",
    audience: 'admin',
    input: z.object({
      client: clientRef,
      name: z.string(),
      email: z.string().optional(),
      role: z.enum(['owner', 'member']).optional(),
      telegramId: z.string().optional(),
      slackId: z.string().optional(),
    }),
    run: (db, p, { client, ...rest }) => addContact(db, p, client, rest),
    http: { method: 'POST', path: '/desk/clients/:client/contacts' },
  }),
  op({
    id: 'invite_contact',
    description:
      "Get a one-time code for a client contact to link their chat account (Teams, and other channels later) to the client agent. Send them the code; they message it to the agent. Valid 7 days. A contact whose email the platform shares is linked automatically.",
    audience: 'admin',
    input: z.object({ client: clientRef, contact: z.string().describe('Contact email or id') }),
    run: (db, p, i) => inviteContact(db, p, i.client, i.contact),
    http: { method: 'POST', path: '/desk/clients/:client/contacts/invite' },
  }),
  op({
    id: 'unlink_contact',
    description: "Disconnect a contact's chat accounts from the client agent, e.g. when they leave the client's team.",
    audience: 'admin',
    input: z.object({ client: clientRef, contact: z.string().describe('Contact id') }),
    run: (db, p, i) => unlinkContact(db, p, i.client, i.contact),
    http: { method: 'POST', path: '/desk/clients/:client/contacts/:contact/unlink' },
  }),
  op({
    id: 'link_channel',
    description: "Link a client's channel (Telegram chat id, Slack channel id, email address, portal slug) so their agent knows who is talking.",
    audience: 'admin',
    input: z.object({ client: clientRef, kind: z.enum(CHANNEL_KINDS), externalId: z.string() }),
    run: (db, p, { client, ...rest }) => addChannel(db, p, client, rest),
    http: { method: 'POST', path: '/desk/clients/:client/channels' },
  }),
  op({
    id: 'start_retainer',
    description:
      'Start a retainer for a client. Rate is locked at joining. Set kickoffDone for clients already working with you (imports).',
    audience: 'admin',
    input: z.object({
      client: clientRef,
      monthlyRateCents: z.number().int().positive().describe('e.g. 54900 for $549'),
      currency: z.string().optional(),
      activeLimit: z.number().int().min(1).max(10).optional(),
      startedAt: z.coerce.date().optional(),
      nextChargeAt: z.coerce.date().describe('Next charge date (ISO)'),
      billingRef: z.string().optional().describe('Stripe subscription id or FluentCart order id'),
      kickoffDone: z.boolean().optional(),
    }),
    run: (db, p, i) => startRetainer(db, p, i),
    http: { method: 'POST', path: '/desk/clients/:client/retainer' },
  }),
  op({
    id: 'log_kickoff',
    description: 'Log the kickoff call. A new retainer stays in onboarding, and no work starts, until this is done.',
    audience: 'admin',
    input: z.object({ client: clientRef }),
    run: (db, p, i) => logKickoff(db, p, i.client),
    http: { method: 'POST', path: '/desk/clients/:client/retainer/kickoff' },
  }),
  op({
    id: 'set_active_limit',
    description: 'How many requests this client can have active at once (1 by default).',
    audience: 'admin',
    input: z.object({ client: clientRef, limit: z.number().int().min(1).max(10) }),
    run: (db, p, i) => setActiveLimit(db, p, i.client, i.limit),
    http: { method: 'POST', path: '/desk/clients/:client/retainer/active-limit' },
  }),
  op({
    id: 'set_next_charge',
    description: 'Record the next charge date (after a renewal is paid).',
    audience: 'admin',
    input: z.object({ client: clientRef, nextChargeAt: z.coerce.date() }),
    run: (db, p, i) => setNextCharge(db, p, i.client, i.nextChargeAt),
    http: { method: 'POST', path: '/desk/clients/:client/retainer/next-charge' },
  }),
  op({
    id: 'link_billing',
    description:
      'Link a retainer to its Stripe customer (cus_…) or subscription (sub_…), so paid invoices move its next charge on automatically. Usually not needed: the first paid invoice links itself when its email matches a client contact.',
    audience: 'admin',
    input: z.object({ client: clientRef, ref: z.string().describe('Stripe customer or subscription id') }),
    run: (db, p, i) => linkBilling(db, p, i.client, i.ref),
    http: { method: 'POST', path: '/desk/clients/:client/retainer/billing' },
  }),
  op({
    id: 'billing_history',
    description: 'Stripe payments the desk has seen for a client, newest first, with what each one did to the next charge date.',
    audience: 'admin',
    input: z.object({ client: clientRef }),
    run: (db, p, i) => billingHistory(db, p, i.client),
    http: { method: 'GET', path: '/desk/clients/:client/billing' },
  }),
  op({
    id: 'sync_crm',
    description:
      'Push clients into the CRM (FluentCRM) now: each contact tagged Desk client, their client code and the retainer state. One client, or all. Changes sync on their own; this is for a backfill or a check.',
    audience: 'admin',
    input: z.object({ client: clientRef.optional() }),
    run: async (db, p, i) => syncCrm(db, p, crmFromEnv(), i.client ? (await resolveClient(db, p, i.client)).id : undefined),
    http: { method: 'POST', path: '/desk/crm/sync' },
  }),
  op({
    id: 'pause_month',
    description: 'Pause a client for a month. Must be asked before that month’s charge; at most three months in a row. Queue is kept.',
    audience: 'admin',
    input: z.object({ client: clientRef, month }),
    run: (db, p, i) => pauseMonth(db, p, i.client, i.month),
    http: { method: 'POST', path: '/desk/clients/:client/retainer/pause' },
  }),
  op({
    id: 'unpause_month',
    description: 'Remove a pause for a month that has not started yet.',
    audience: 'admin',
    input: z.object({ client: clientRef, month }),
    run: (db, p, i) => unpauseMonth(db, p, i.client, i.month),
    http: { method: 'POST', path: '/desk/clients/:client/retainer/unpause' },
  }),
  op({
    id: 'cancel_retainer',
    description: 'Cancel a retainer. It stays active until the end of the paid month.',
    audience: 'admin',
    input: z.object({ client: clientRef }),
    run: (db, p, i) => cancelRetainer(db, p, i.client),
    http: { method: 'POST', path: '/desk/clients/:client/retainer/cancel' },
  }),
  op({
    id: 'list_requests',
    description: 'Requests across clients, newest first. Filter by client and status.',
    audience: 'admin',
    input: z.object({
      client: clientRef.optional(),
      status: z.array(z.enum(REQUEST_STATUSES)).optional(),
      limit: z.number().int().max(500).optional(),
    }),
    run: (db, p, i) => listRequests(db, p, i),
    http: { method: 'GET', path: '/desk/requests' },
  }),
  op({
    id: 'get_request',
    description: 'One request with its full timeline (internal and client-visible).',
    audience: 'admin',
    input: z.object({ request: requestRef }),
    run: (db, p, i) => getRequest(db, p, i.request),
    http: { method: 'GET', path: '/desk/requests/:request' },
  }),
  op({
    id: 'create_request',
    description:
      'Log a request for a client. One request is one trigger and one result. Type and size can be set now or while scoping.',
    audience: 'admin',
    input: z.object({
      client: clientRef,
      title: z.string(),
      type: requestType.optional(),
      trigger: z.string().optional().describe('What starts it'),
      result: z.string().optional().describe('What comes back to the client'),
      sizeDays: size.optional(),
      needsCall: z.boolean().optional(),
      source: z.string().optional().describe('Where it came from: telegram, slack, email, call, owner'),
      receivedAt: z.coerce.date().optional(),
    }),
    run: (db, p, i) => createRequest(db, p, i),
    http: { method: 'POST', path: '/desk/requests' },
  }),
  op({
    id: 'scope_request',
    description: 'Set or change a request’s title, type, trigger, result, size or needs-call flag.',
    audience: 'admin',
    input: z.object({
      request: requestRef,
      title: z.string().optional(),
      type: requestType.optional(),
      trigger: z.string().optional(),
      result: z.string().optional(),
      sizeDays: size.optional(),
      needsCall: z.boolean().optional(),
    }),
    run: (db, p, { request, ...patch }) => scopeRequest(db, p, request, patch),
    http: { method: 'PATCH', path: '/desk/requests/:request' },
  }),
  op({
    id: 'queue_request',
    description: 'Queue a scoped request at the back of the client’s queue (or the front). Needs type, trigger, result and size.',
    audience: 'admin',
    input: z.object({ request: requestRef, front: z.boolean().optional() }),
    run: (db, p, i) => queueRequest(db, p, i.request, { front: i.front }),
    http: { method: 'POST', path: '/desk/requests/:request/queue' },
  }),
  op({
    id: 'start_request',
    description: 'Start a queued request. Refused at the client’s active limit, while paused, or before kickoff.',
    audience: 'admin',
    input: z.object({ request: requestRef }),
    run: (db, p, i) => startRequest(db, p, i.request),
    http: { method: 'POST', path: '/desk/requests/:request/start' },
  }),
  op({
    id: 'start_next',
    description: 'Fill the client’s free active slots from the front of their queue.',
    audience: 'admin',
    input: z.object({ client: clientRef }),
    run: (db, p, i) => startNext(db, p, i.client),
    http: { method: 'POST', path: '/desk/clients/:client/start-next' },
  }),
  op({
    id: 'deliver_request',
    description:
      'Hand the result back to the client: posts a client-visible delivery note, frees the slot, and starts the next queued request unless startNext is false.',
    audience: 'admin',
    input: z.object({
      request: requestRef,
      note: z.string().describe('What was delivered, in words the client will read'),
      deliverableUrl: z.string().optional(),
      startNext: z.boolean().optional(),
    }),
    run: (db, p, { request, ...rest }) => deliverRequest(db, p, request, rest),
    http: { method: 'POST', path: '/desk/requests/:request/deliver' },
  }),
  op({
    id: 'close_request',
    description: 'Mark a delivered request done.',
    audience: 'admin',
    input: z.object({ request: requestRef }),
    run: (db, p, i) => closeRequest(db, p, i.request),
    http: { method: 'POST', path: '/desk/requests/:request/close' },
  }),
  op({
    id: 'reopen_request',
    description: 'The client wants changes to a delivered request: it goes to the front of their queue.',
    audience: 'admin',
    input: z.object({ request: requestRef, reason: z.string() }),
    run: (db, p, i) => reopenRequest(db, p, i.request, i.reason),
    http: { method: 'POST', path: '/desk/requests/:request/reopen' },
  }),
  op({
    id: 'wait_on_client',
    description: 'Blocked on the client. Records the question and frees the active slot.',
    audience: 'admin',
    input: z.object({ request: requestRef, question: z.string() }),
    run: (db, p, i) => waitOnClient(db, p, i.request, i.question),
    http: { method: 'POST', path: '/desk/requests/:request/wait' },
  }),
  op({
    id: 'decline_request',
    description: 'Decline a request that is out of scope for the retainer.',
    audience: 'admin',
    input: z.object({ request: requestRef, reason: z.string() }),
    run: (db, p, i) => declineRequest(db, p, i.request, i.reason),
    http: { method: 'POST', path: '/desk/requests/:request/decline' },
  }),
  op({
    id: 'split_request',
    description: 'Split work bigger than 5 days into parts (2 to 5 days each) that queue in order where the original sat.',
    audience: 'admin',
    input: z.object({
      request: requestRef,
      parts: z
        .array(
          z.object({
            title: z.string(),
            sizeDays: size,
            type: requestType.optional(),
            trigger: z.string().optional(),
            result: z.string().optional(),
          }),
        )
        .min(2),
    }),
    run: (db, p, i) => splitRequest(db, p, i.request, i.parts),
    http: { method: 'POST', path: '/desk/requests/:request/split' },
  }),
  op({
    id: 'reorder_queue',
    description: 'Set the order of a client’s queue. List every queued request id, first to last.',
    audience: 'admin',
    input: z.object({ client: clientRef, order: z.array(requestRef).min(1) }),
    run: (db, p, i) => reorderQueue(db, p, i.client, i.order),
    http: { method: 'POST', path: '/desk/clients/:client/queue/order' },
  }),
  op({
    id: 'add_update',
    description: 'Add a note to a request’s timeline. Internal by default; set visibility to client for something the client should see.',
    audience: 'admin',
    input: z.object({
      request: requestRef,
      body: z.string(),
      visibility: z.enum(['internal', 'client']).optional(),
    }),
    run: (db, p, { request, ...rest }) => addUpdate(db, p, request, rest),
    http: { method: 'POST', path: '/desk/requests/:request/updates' },
  }),
  op({
    id: 'history',
    description: 'Every change to the desk, newest first: commit, who made it, when, and what it was.',
    audience: 'admin',
    input: z.object({ limit: z.number().int().min(1).max(500).optional() }),
    run: (db, p, i) => listHistory(db, p, i.limit),
    http: { method: 'GET', path: '/desk/history' },
  }),
  op({
    id: 'history_diff',
    description:
      'What a commit changed, row by row with before and after values. Pass `to` to diff everything between two commits.',
    audience: 'admin',
    input: z.object({ commit: z.string().describe('Commit hash from history'), to: z.string().optional() }),
    run: (db, p, i) => diffHistory(db, p, i),
    http: { method: 'GET', path: '/desk/history/:commit/diff' },
  }),
  op({
    id: 'restore',
    description:
      'Roll the whole desk back to a commit. The current state is kept on a branch first, so this can be undone. Confirm with Chowderr before using.',
    audience: 'admin',
    input: z.object({ commit: z.string().describe('Commit hash from history') }),
    run: (db, p, i) => restoreTo(db, p, i.commit),
    http: { method: 'POST', path: '/desk/history/:commit/restore' },
    versioning: 'manual',
  }),
  op({
    id: 'create_key',
    description:
      'Create an API key: admin, or client-scoped for one client’s team or agent. The key is returned once; store it in Infisical straight away.',
    audience: 'admin',
    input: z.object({
      label: z.string().min(1).describe('Who or what uses it, e.g. "rachel-telegram"'),
      scope: z.enum(['admin', 'client']),
      client: clientRef.optional().describe('Required for client keys'),
    }),
    run: (db, p, i) => mintApiKey(db, p, i),
    http: { method: 'POST', path: '/desk/keys' },
  }),
  op({
    id: 'list_keys',
    description: 'Every API key with its label, scope, client and last use. Never shows the keys themselves.',
    audience: 'admin',
    input: z.object({}),
    run: (db, p) => listApiKeys(db, p),
    http: { method: 'GET', path: '/desk/keys' },
  }),
  op({
    id: 'revoke_key',
    description: 'Revoke an API key by its id from list_keys. It stops working immediately.',
    audience: 'admin',
    input: z.object({ key: z.string().describe('Key id from list_keys') }),
    run: (db, p, i) => revokeKey(db, p, i.key),
    http: { method: 'POST', path: '/desk/keys/:key/revoke' },
  }),
] as const

export const clientOps = [
  op({
    id: 'my_status',
    description: 'This client’s retainer (status, next charge, paused months), active work, queue and anything waiting on them.',
    audience: 'client',
    input: z.object({}),
    run: (db, p) => getClientOverview(db, p, clientOnly(p).clientId),
    http: { method: 'GET', path: '/desk/me' },
  }),
  op({
    id: 'my_requests',
    description: 'This client’s requests, newest first. Optionally filter by status.',
    audience: 'client',
    input: z.object({ status: z.array(z.enum(REQUEST_STATUSES)).optional() }),
    run: (db, p, i) => listRequests(db, clientOnly(p), i),
    http: { method: 'GET', path: '/desk/me/requests' },
  }),
  op({
    id: 'get_my_request',
    description: 'One of this client’s requests with its client-visible timeline.',
    audience: 'client',
    input: z.object({ request: requestRef }),
    run: (db, p, i) => getRequest(db, clientOnly(p), i.request),
    http: { method: 'GET', path: '/desk/me/requests/:request' },
  }),
  op({
    id: 'submit_request',
    description:
      'Submit a new request for this client. Ask the client what triggers it and what result they expect before submitting. It lands as new; Chowderr confirms scope and size.',
    audience: 'client',
    input: z.object({
      title: z.string(),
      type: requestType.optional(),
      trigger: z.string().optional(),
      result: z.string().optional(),
      source: z.string().optional().describe('telegram, slack, email or portal'),
      submittedBy: z.string().optional().describe('Name of the person on the client side'),
    }),
    run: (db, p, i) => createRequest(db, clientOnly(p), { ...i, client: clientOnly(p).clientId }),
    http: { method: 'POST', path: '/desk/me/requests' },
  }),
  op({
    id: 'add_message',
    description: 'Add a message from the client to one of their requests (more detail, an answer, feedback on a delivery).',
    audience: 'client',
    input: z.object({ request: requestRef, body: z.string() }),
    run: (db, p, i) => addUpdate(db, clientOnly(p), i.request, { body: i.body }),
    http: { method: 'POST', path: '/desk/me/requests/:request/messages' },
  }),
  op({
    id: 'request_pause',
    description: 'Pause this client for a month. Only the retainer owner should ask; must be before that month’s charge, max three months in a row.',
    audience: 'client',
    input: z.object({ month }),
    run: (db, p, i) => pauseMonth(db, clientOnly(p), clientOnly(p).clientId, i.month),
    http: { method: 'POST', path: '/desk/me/pause' },
  }),
] as const

export const allOps: readonly Op[] = [...adminOps, ...clientOps]
