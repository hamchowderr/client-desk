import { and, asc, desc, eq, inArray, max, min, sql } from 'drizzle-orm'
import type { Db, DbOrTx } from '../db/client'
import { isDolt } from '../db/dolt'
import {
  clients,
  requests,
  retainers,
  updates,
  type Client,
  type Request,
  type RequestStatus,
  type RequestType,
  REQUEST_TYPES,
} from '../db/schema'
import { DeskError, notFound, ruleBroken } from './errors'
import { type Principal, assertCanSeeClient, authorOf, requireAdmin } from './principal'
import { formatRequestId, isUuid, parseRequestId } from './refs'
import { resolveClient } from './clients'
import { presentFor, resolveFor } from './customers'
import { isPausedAt, listPauses, loadOpenRetainer } from './retainers'
import { replyDueAt } from './time'

export const MIN_SIZE_DAYS = 2
export const MAX_SIZE_DAYS = 5

type Loaded = { request: Request; client: Client }

/** Accepts "GMA-012" or a uuid. Client principals only resolve their own requests. */
export async function resolveRequest(db: DbOrTx, p: Principal, ref: string): Promise<Loaded> {
  let row: Loaded | undefined
  if (isUuid(ref)) {
    ;[row] = await db
      .select({ request: requests, client: clients })
      .from(requests)
      .innerJoin(clients, eq(requests.clientId, clients.id))
      .where(eq(requests.id, ref))
  } else {
    const parsed = parseRequestId(ref)
    if (!parsed) throw new DeskError('invalid', `"${ref}" is not a request id like GMA-012`)
    ;[row] = await db
      .select({ request: requests, client: clients })
      .from(requests)
      .innerJoin(clients, eq(requests.clientId, clients.id))
      .where(and(eq(clients.code, parsed.code), eq(requests.number, parsed.number)))
  }
  if (!row) throw notFound('Request')
  assertCanSeeClient(p, row.client.id)
  return row
}

export function presentRequest(client: Pick<Client, 'code'>, r: Request) {
  return {
    id: formatRequestId(client.code, r.number),
    uuid: r.id,
    title: r.title,
    type: r.type,
    trigger: r.trigger,
    result: r.result,
    systems: r.systems,
    currentWay: r.currentWay,
    links: r.links,
    for: presentFor(r),
    status: r.status,
    position: r.position,
    sizeDays: r.sizeDays,
    needsCall: r.needsCall,
    source: r.source,
    parentId: r.parentId,
    receivedAt: r.receivedAt,
    replyDueAt: r.replyDueAt,
    firstResponseAt: r.firstResponseAt,
    startedAt: r.startedAt,
    deliveredAt: r.deliveredAt,
    closedAt: r.closedAt,
    deliverableUrl: r.deliverableUrl,
  }
}

async function log(
  db: DbOrTx,
  p: Principal,
  requestId: string,
  body: string,
  opts: { kind?: 'note' | 'status' | 'client_message' | 'deliverable'; visibility?: 'internal' | 'client' } = {},
) {
  await db.insert(updates).values({
    requestId,
    author: authorOf(p),
    body,
    kind: opts.kind ?? 'status',
    visibility: opts.visibility ?? 'client',
  })
}

/** Any client-visible move by Chowderr counts as the reply the same-day clock waits for. */
async function markResponded(db: DbOrTx, p: Principal, r: Request, now: Date) {
  if (p.kind === 'admin' && !r.firstResponseAt && r.replyDueAt) {
    await db.update(requests).set({ firstResponseAt: now }).where(eq(requests.id, r.id))
  }
}

async function setStatus(db: DbOrTx, id: string, patch: Partial<typeof requests.$inferInsert>) {
  const [row] = await db
    .update(requests)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(requests.id, id))
    .returning()
  return row
}

function assertStatus(r: Request, allowed: RequestStatus[], action: string) {
  if (!allowed.includes(r.status)) {
    throw new DeskError('conflict', `Can't ${action} a request that is ${r.status.replace(/_/g, ' ')}`)
  }
}

function assertType(type: string | undefined | null): asserts type is RequestType | undefined | null {
  if (type != null && !REQUEST_TYPES.includes(type as RequestType)) {
    throw new DeskError('invalid', `Type must be one of: ${REQUEST_TYPES.join(', ')}`)
  }
}

function assertSize(size: number | undefined | null) {
  if (size != null && (!Number.isInteger(size) || size < MIN_SIZE_DAYS || size > MAX_SIZE_DAYS)) {
    throw ruleBroken(
      `Each request is sized to ${MIN_SIZE_DAYS} to ${MAX_SIZE_DAYS} business days. Split bigger work into several requests.`,
    )
  }
}

/**
 * What a client's request must say before it's sent, so Chowderr can act on it
 * without a round of questions. In plain words, for the client and their Claude.
 */
export const REQUEST_CONTEXT = [
  ['trigger', 'what starts it'],
  ['result', 'what they get back when it works'],
  ['systems', 'which tools, accounts or places it touches'],
  ['currentWay', "how it's done today, or what goes wrong now"],
  ['for', "who it's for: one of their customers, or someone on their team"],
] as const

export function missingContext(input: Partial<Record<(typeof REQUEST_CONTEXT)[number][0], string | null | undefined>>) {
  return REQUEST_CONTEXT.filter(([k]) => !input[k]?.trim()).map(([k, label]) => ({ field: k, label }))
}

export type NewRequest = {
  client: string
  title: string
  type?: RequestType | null
  trigger?: string | null
  result?: string | null
  systems?: string | null
  currentWay?: string | null
  links?: string | null
  /** Who it's for: one of the client's customers, a team member, or "team". */
  for?: string | null
  sizeDays?: number | null
  needsCall?: boolean
  source?: string
  submittedBy?: string
  /** For imports and tests. */
  receivedAt?: Date
}

/**
 * Take in a request. From a client it lands as `new` with the same-day reply clock
 * running; from the owner it can arrive already scoped.
 */
export async function createRequest(db: Db, p: Principal, input: NewRequest) {
  assertType(input.type)
  assertSize(input.sizeDays)
  if (!input.title?.trim()) throw new DeskError('invalid', 'A request needs a title')
  if (p.kind === 'client') {
    const missing = missingContext(input)
    if (missing.length) {
      throw new DeskError('invalid', `Before it's sent, the request needs ${missing.map((m) => m.label).join('; ')}.`)
    }
  }
  const dolt = await isDolt(db)
  return db.transaction(async (tx) => {
    const isUuidRef = /^[0-9a-f-]{36}$/i.test(input.client)
    const q = tx
      .select()
      .from(clients)
      .where(isUuidRef ? eq(clients.id, input.client) : eq(clients.code, input.client.trim().toUpperCase()))
    const [client] = await (dolt ? q : q.for('update'))
    if (client && dolt) await tx.update(clients).set({ claim: sql`gen_random_uuid()` }).where(eq(clients.id, client.id))
    if (!client) throw notFound('Client')
    assertCanSeeClient(p, client.id)
    const retainer = await loadOpenRetainer(tx, client.id)
    if (!retainer) throw ruleBroken(`${client.name} has no open retainer, so requests can't be taken`)
    const forWho = input.for?.trim() ? await resolveFor(tx, client, input.for) : null

    const number = client.requestSeq + 1
    await tx.update(clients).set({ requestSeq: number }).where(eq(clients.id, client.id))
    const receivedAt = input.receivedAt ?? new Date()
    const fromClient = p.kind === 'client'
    const [row] = await tx
      .insert(requests)
      .values({
        clientId: client.id,
        number,
        title: input.title.trim(),
        type: input.type ?? null,
        trigger: input.trigger ?? null,
        result: input.result ?? null,
        systems: input.systems?.trim() || null,
        currentWay: input.currentWay?.trim() || null,
        links: input.links?.trim() || null,
        forKind: forWho?.forKind ?? null,
        forId: forWho?.forId ?? null,
        forName: forWho?.forName ?? null,
        sizeDays: input.sizeDays ?? null,
        needsCall: input.needsCall ?? false,
        source: input.source ?? (fromClient ? 'client' : 'owner'),
        submittedBy: input.submittedBy ?? authorOf(p),
        status: 'new',
        receivedAt,
        replyDueAt: fromClient ? replyDueAt(receivedAt, client.timezone) : null,
      })
      .returning()
    await log(tx, p, row.id, fromClient ? 'Request received' : 'Request logged')
    return { ...presentRequest(client, row), client: client.code }
  })
}

/** Scope a request: type, trigger, result, size, title, needs-call. */
export async function scopeRequest(
  db: DbOrTx,
  p: Principal,
  ref: string,
  patch: Partial<
    Pick<NewRequest, 'title' | 'type' | 'trigger' | 'result' | 'systems' | 'currentWay' | 'links' | 'for' | 'sizeDays' | 'needsCall'>
  >,
  now = new Date(),
) {
  requireAdmin(p)
  assertType(patch.type)
  assertSize(patch.sizeDays)
  const { request: r, client } = await resolveRequest(db, p, ref)
  assertStatus(r, ['new', 'scoping', 'queued', 'waiting_on_client'], 'rescope')
  const { for: forText, ...rest } = patch
  const row = await setStatus(db, r.id, {
    ...rest,
    ...(forText?.trim() ? await resolveFor(db, client, forText) : {}),
    status: r.status === 'new' ? 'scoping' : r.status,
  })
  await markResponded(db, p, r, now)
  return presentRequest(client, row)
}

/**
 * Say who a request is for. Chowderr or the client can, until it's finished;
 * the change shows in the request's story.
 */
export async function setRequestFor(db: DbOrTx, p: Principal, ref: string, text: string) {
  const { request: r, client } = await resolveRequest(db, p, ref)
  assertStatus(r, ['new', 'scoping', 'queued', 'active', 'in_review', 'waiting_on_client'], "change who it's for on")
  const who = await resolveFor(db, client, text)
  const row = await setStatus(db, r.id, who)
  await log(db, p, r.id, `Now for ${who.forName}`)
  return presentRequest(client, row)
}

function missingForQueue(r: Request): string[] {
  const missing: string[] = []
  if (!r.type) missing.push('type')
  if (!r.trigger) missing.push('trigger')
  if (!r.result) missing.push('result')
  if (!r.sizeDays) missing.push('size (2 to 5 days)')
  if (!r.forName) missing.push("who it's for")
  return missing
}

async function nextPosition(db: DbOrTx, clientId: string, front = false) {
  const [row] = await db
    .select({ hi: max(requests.position), lo: min(requests.position) })
    .from(requests)
    .where(and(eq(requests.clientId, clientId), eq(requests.status, 'queued')))
  if (front) return (row?.lo ?? 1) - 1
  return (row?.hi ?? 0) + 1
}

/** Put a scoped request at the back of the client's queue (or the front). */
export async function queueRequest(db: DbOrTx, p: Principal, ref: string, opts: { front?: boolean } = {}, now = new Date()) {
  requireAdmin(p)
  const { request: r, client } = await resolveRequest(db, p, ref)
  assertStatus(r, ['new', 'scoping', 'waiting_on_client'], 'queue')
  const missing = missingForQueue(r)
  if (missing.length) {
    throw ruleBroken(`Every request is typed and scoped before it's queued. Missing: ${missing.join(', ')}`)
  }
  const row = await setStatus(db, r.id, {
    status: 'queued',
    position: await nextPosition(db, client.id, opts.front),
  })
  await markResponded(db, p, r, now)
  await log(db, p, r.id, 'Queued')
  return presentRequest(client, row)
}

/**
 * Start a queued request. Enforces the retainer's active limit inside a
 * transaction that locks (or, on Doltgres, claims) the retainer row, so two
 * starts can't both slip in.
 */
export async function startRequest(db: Db, p: Principal, ref: string, now = new Date()) {
  requireAdmin(p)
  const dolt = await isDolt(db)
  return db.transaction(async (tx) => {
    const { request: r, client } = await resolveRequest(tx, p, ref)
    assertStatus(r, ['queued'], 'start')
    const q = tx
      .select()
      .from(retainers)
      .where(and(eq(retainers.clientId, client.id), sql`${retainers.status} <> 'ended'`))
    const [retainer] = await (dolt ? q : q.for('update'))
    if (retainer && dolt) await tx.update(retainers).set({ claim: sql`gen_random_uuid()` }).where(eq(retainers.id, retainer.id))
    if (!retainer) throw ruleBroken(`${client.name} has no open retainer`)
    if (retainer.status === 'onboarding') {
      throw ruleBroken('A kickoff call starts every retainer. Log the kickoff before starting work.')
    }
    const months = (await listPauses(tx, retainer.id)).map((x) => x.month)
    if (isPausedAt(retainer, months, now)) throw ruleBroken(`${client.name} is paused this month`)
    const [{ n }] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(requests)
      .where(and(eq(requests.clientId, client.id), eq(requests.status, 'active')))
    if (n >= retainer.activeLimit) {
      throw ruleBroken(
        `${client.name} already has ${n} active request${n === 1 ? '' : 's'}; their limit is ${retainer.activeLimit}`,
      )
    }
    const row = await setStatus(tx, r.id, { status: 'active', position: null, startedAt: now })
    await markResponded(tx, p, r, now)
    await log(tx, p, r.id, 'Work started')
    return presentRequest(client, row)
  })
}

/** Fill free active slots from the front of the queue. Returns what started. */
export async function startNext(db: Db, p: Principal, clientRef: string, now = new Date()) {
  requireAdmin(p)
  const client = await resolveClient(db, p, clientRef)
  const started = []
  for (;;) {
    const [next] = await db
      .select()
      .from(requests)
      .where(and(eq(requests.clientId, client.id), eq(requests.status, 'queued')))
      .orderBy(asc(requests.position))
      .limit(1)
    if (!next) break
    try {
      started.push(await startRequest(db, p, next.id, now))
    } catch (e) {
      if (e instanceof DeskError && e.code === 'rule') break
      throw e
    }
  }
  return started
}

/** Hand the result back. Frees the slot; optionally starts what's next. */
export async function deliverRequest(
  db: Db,
  p: Principal,
  ref: string,
  input: { note: string; deliverableUrl?: string; startNext?: boolean },
  now = new Date(),
) {
  requireAdmin(p)
  const { request: r, client } = await resolveRequest(db, p, ref)
  assertStatus(r, ['active'], 'deliver')
  const row = await setStatus(db, r.id, {
    status: 'in_review',
    deliveredAt: now,
    deliverableUrl: input.deliverableUrl ?? r.deliverableUrl,
  })
  await log(db, p, r.id, input.deliverableUrl ? `${input.note}\n${input.deliverableUrl}` : input.note, {
    kind: 'deliverable',
  })
  const started = input.startNext === false ? [] : await startNext(db, p, client.id, now)
  return { delivered: presentRequest(client, row), started }
}

/** The client accepted it, or it's otherwise finished. */
export async function closeRequest(db: DbOrTx, p: Principal, ref: string, now = new Date()) {
  requireAdmin(p)
  const { request: r, client } = await resolveRequest(db, p, ref)
  assertStatus(r, ['in_review', 'active'], 'close')
  const row = await setStatus(db, r.id, { status: 'done', closedAt: now, position: null })
  await log(db, p, r.id, 'Done')
  return presentRequest(client, row)
}

/** The client wants changes to what was delivered: back to the front of the queue. */
export async function reopenRequest(db: DbOrTx, p: Principal, ref: string, reason: string) {
  requireAdmin(p)
  const { request: r, client } = await resolveRequest(db, p, ref)
  assertStatus(r, ['in_review', 'done'], 'reopen')
  const row = await setStatus(db, r.id, {
    status: 'queued',
    position: await nextPosition(db, client.id, true),
    closedAt: null,
  })
  await log(db, p, r.id, `Reopened: ${reason}`)
  return presentRequest(client, row)
}

/** Blocked on the client. Frees the slot so the queue keeps moving. */
export async function waitOnClient(db: DbOrTx, p: Principal, ref: string, question: string, now = new Date()) {
  requireAdmin(p)
  const { request: r, client } = await resolveRequest(db, p, ref)
  assertStatus(r, ['new', 'scoping', 'queued', 'active'], 'pause on the client for')
  const row = await setStatus(db, r.id, { status: 'waiting_on_client', position: null })
  await markResponded(db, p, r, now)
  await log(db, p, r.id, question, { kind: 'note' })
  return presentRequest(client, row)
}

export async function declineRequest(db: DbOrTx, p: Principal, ref: string, reason: string, now = new Date()) {
  requireAdmin(p)
  const { request: r, client } = await resolveRequest(db, p, ref)
  assertStatus(r, ['new', 'scoping', 'queued', 'waiting_on_client'], 'decline')
  const row = await setStatus(db, r.id, { status: 'declined', position: null, closedAt: now })
  await markResponded(db, p, r, now)
  await log(db, p, r.id, `Declined: ${reason}`)
  return presentRequest(client, row)
}

/**
 * "Bigger work is split into requests that queue behind each other."
 * The parent is closed as `split`; parts take its place in the queue, in order.
 */
export async function splitRequest(
  db: Db,
  p: Principal,
  ref: string,
  parts: Array<{ title: string; sizeDays: number; trigger?: string; result?: string; type?: RequestType }>,
  now = new Date(),
) {
  requireAdmin(p)
  if (parts.length < 2) throw new DeskError('invalid', 'Split into at least two parts')
  parts.forEach((x) => {
    assertType(x.type)
    assertSize(x.sizeDays)
  })
  const dolt = await isDolt(db)
  return db.transaction(async (tx) => {
    const { request: parent, client } = await resolveRequest(tx, p, ref)
    assertStatus(parent, ['new', 'scoping', 'queued', 'waiting_on_client'], 'split')
    const q = tx.select().from(clients).where(eq(clients.id, client.id))
    const [locked] = await (dolt ? q : q.for('update'))
    if (dolt) await tx.update(clients).set({ claim: sql`gen_random_uuid()` }).where(eq(clients.id, client.id))
    let seq = locked.requestSeq
    let pos = parent.status === 'queued' && parent.position != null ? parent.position : await nextPosition(tx, client.id)
    if (parent.status === 'queued') {
      // Make room right where the parent sat.
      await tx
        .update(requests)
        .set({ position: sql`${requests.position} + ${parts.length}` })
        .where(
          and(
            eq(requests.clientId, client.id),
            eq(requests.status, 'queued'),
            sql`${requests.position} > ${parent.position}`,
          ),
        )
    }
    const created = []
    for (const part of parts) {
      seq++
      const type = part.type ?? parent.type
      const trigger = part.trigger ?? parent.trigger
      const result = part.result ?? parent.result
      const ready = Boolean(type && trigger && result && parent.forName)
      const [row] = await tx
        .insert(requests)
        .values({
          clientId: client.id,
          number: seq,
          title: part.title,
          type,
          trigger,
          result,
          sizeDays: part.sizeDays,
          systems: parent.systems,
          currentWay: parent.currentWay,
          links: parent.links,
          forKind: parent.forKind,
          forId: parent.forId,
          forName: parent.forName,
          parentId: parent.id,
          source: parent.source,
          submittedBy: parent.submittedBy,
          receivedAt: parent.receivedAt,
          status: ready ? 'queued' : 'scoping',
          position: ready ? pos++ : null,
        })
        .returning()
      await tx.insert(updates).values({
        requestId: row.id,
        author: authorOf(p),
        kind: 'status',
        visibility: 'client',
        body: `Split from ${formatRequestId(client.code, parent.number)}`,
      })
      created.push(presentRequest(client, row))
    }
    await tx.update(clients).set({ requestSeq: seq }).where(eq(clients.id, client.id))
    await setStatus(tx, parent.id, { status: 'split', position: null, closedAt: now })
    await markResponded(tx, p, parent, now)
    await tx.insert(updates).values({
      requestId: parent.id,
      author: authorOf(p),
      kind: 'status',
      visibility: 'client',
      body: `Split into ${created.map((c) => c.id).join(', ')}`,
    })
    return { parent: formatRequestId(client.code, parent.number), parts: created }
  })
}

/** Set the client's queue order. `order` must name every queued request. */
export async function reorderQueue(db: Db, p: Principal, clientRef: string, order: string[]) {
  requireAdmin(p)
  return db.transaction(async (tx) => {
    const resolved = await Promise.all(order.map((ref) => resolveRequest(tx, p, ref)))
    const clientIds = new Set(resolved.map((x) => x.client.id))
    if (clientIds.size !== 1) throw new DeskError('invalid', 'All requests must belong to one client')
    const client = await resolveClient(tx, p, clientRef)
    if (resolved[0].client.id !== client.id) {
      throw new DeskError('invalid', 'Those requests belong to a different client')
    }
    const queued = await tx
      .select({ id: requests.id })
      .from(requests)
      .where(and(eq(requests.clientId, client.id), eq(requests.status, 'queued')))
    const want = new Set(resolved.map((x) => x.request.id))
    if (queued.length !== want.size || queued.some((q) => !want.has(q.id))) {
      throw new DeskError('invalid', 'List every queued request for this client, once each')
    }
    for (const [i, x] of resolved.entries()) {
      await tx.update(requests).set({ position: i + 1 }).where(eq(requests.id, x.request.id))
    }
    return resolved.map((x, i) => ({ id: formatRequestId(client.code, x.request.number), position: i + 1 }))
  })
}

/**
 * Add to a request's timeline. From a client it's a client message; from the
 * owner it's internal unless marked for the client.
 */
export async function addUpdate(
  db: DbOrTx,
  p: Principal,
  ref: string,
  input: { body: string; visibility?: 'internal' | 'client' },
  now = new Date(),
) {
  if (!input.body?.trim()) throw new DeskError('invalid', 'Update is empty')
  const { request: r, client } = await resolveRequest(db, p, ref)
  const fromClient = p.kind === 'client'
  const visibility = fromClient ? 'client' : (input.visibility ?? 'internal')
  const [row] = await db
    .insert(updates)
    .values({
      requestId: r.id,
      author: authorOf(p),
      kind: fromClient ? 'client_message' : 'note',
      body: input.body.trim(),
      visibility,
      createdAt: now,
    })
    .returning()
  if (fromClient && r.firstResponseAt) {
    // A new message from the client restarts the reply clock.
    await db
      .update(requests)
      .set({ firstResponseAt: null, replyDueAt: replyDueAt(now, client.timezone), updatedAt: now })
      .where(eq(requests.id, r.id))
  } else if (!fromClient && visibility === 'client') {
    await markResponded(db, p, r, now)
  }
  return row
}

/** A request with its timeline; clients only see the client-visible part. */
export async function getRequest(db: DbOrTx, p: Principal, ref: string) {
  const { request: r, client } = await resolveRequest(db, p, ref)
  const timeline = await db
    .select()
    .from(updates)
    .where(
      p.kind === 'client'
        ? and(eq(updates.requestId, r.id), eq(updates.visibility, 'client'))
        : eq(updates.requestId, r.id),
    )
    .orderBy(asc(updates.createdAt))
  return {
    ...presentRequest(client, r),
    client: client.code,
    timeline: timeline.map((u) => ({
      at: u.createdAt,
      author: u.author,
      kind: u.kind,
      body: u.body,
      ...(p.kind === 'admin' ? { visibility: u.visibility } : {}),
    })),
  }
}

export async function listRequests(
  db: DbOrTx,
  p: Principal,
  filter: { client?: string; status?: RequestStatus[]; for?: string; limit?: number } = {},
) {
  const conds = []
  if (p.kind === 'client') conds.push(eq(requests.clientId, p.clientId))
  if (filter.client) {
    const c = await resolveClient(db, p, filter.client)
    conds.push(eq(requests.clientId, c.id))
  }
  if (filter.status?.length) conds.push(inArray(requests.status, filter.status))
  if (filter.for?.trim()) conds.push(sql`lower(${requests.forName}) like ${`%${filter.for.trim().toLowerCase()}%`}`)
  const rows = await db
    .select({ request: requests, client: clients })
    .from(requests)
    .innerJoin(clients, eq(requests.clientId, clients.id))
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(desc(requests.receivedAt))
    .limit(Math.min(filter.limit ?? 100, 500))
  return rows.map((x) => ({ ...presentRequest(x.client, x.request), client: x.client.code }))
}
