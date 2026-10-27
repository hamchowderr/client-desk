import { sql } from 'drizzle-orm'
import {
  boolean,
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'

/**
 * Desk tables live in the default schema of their own Doltgres database, so every
 * change is versioned. (Doltgres 1.4 breaks foreign keys in non-public schemas.)
 */
const desk = { table: pgTable }

export const REQUEST_TYPES = ['build', 'fix', 'decision', 'working_session'] as const
export type RequestType = (typeof REQUEST_TYPES)[number]

export const REQUEST_STATUSES = [
  'new',
  'scoping',
  'queued',
  'active',
  'in_review',
  'done',
  'waiting_on_client',
  'declined',
  'split',
] as const
export type RequestStatus = (typeof REQUEST_STATUSES)[number]

export const RETAINER_STATUSES = ['onboarding', 'active', 'cancelling', 'ended'] as const
export type RetainerStatus = (typeof RETAINER_STATUSES)[number]

export const CHANNEL_KINDS = ['telegram', 'slack', 'portal', 'email'] as const
export type ChannelKind = (typeof CHANNEL_KINDS)[number]

const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow()

export const clients = desk.table('clients', {
  id: uuid('id').primaryKey().defaultRandom(),
  /** Short code used in request ids, e.g. GMA -> GMA-012. */
  code: text('code').notNull().unique(),
  name: text('name').notNull(),
  company: text('company'),
  /** IANA zone. Drives the same-day reply clock. */
  timezone: text('timezone').notNull().default('America/New_York'),
  status: text('status').$type<'active' | 'past'>().notNull().default('active'),
  /** Path of the client's note in the Obsidian vault. */
  vaultNote: text('vault_note'),
  notes: text('notes'),
  /** Last request number handed out for this client. */
  requestSeq: integer('request_seq').notNull().default(0),
  /**
   * Rewritten with a fresh value by transactions that must not overlap (Doltgres
   * has no row locks, but rejects two transactions that change the same cell).
   */
  claim: uuid('claim'),
  createdAt: createdAt(),
})

export const contacts = desk.table(
  'contacts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    clientId: uuid('client_id')
      .notNull()
      .references(() => clients.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    email: text('email'),
    /** The owner is the one who can pause or cancel. */
    role: text('role').$type<'owner' | 'member'>().notNull().default('member'),
    telegramId: text('telegram_id'),
    slackId: text('slack_id'),
    createdAt: createdAt(),
  },
  (t) => [index('contacts_client_idx').on(t.clientId)],
)

export const retainers = desk.table(
  'retainers',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    clientId: uuid('client_id')
      .notNull()
      .references(() => clients.id, { onDelete: 'cascade' }),
    status: text('status').$type<RetainerStatus>().notNull().default('onboarding'),
    /** Locked at joining; a price change never touches an existing retainer. */
    monthlyRateCents: integer('monthly_rate_cents').notNull(),
    currency: text('currency').notNull().default('usd'),
    /** How many requests can be active at once. 1 today; may rise to 3 or 5. */
    activeLimit: integer('active_limit').notNull().default(1),
    libraryAccess: boolean('library_access').notNull().default(true),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    kickoffAt: timestamp('kickoff_at', { withTimezone: true }),
    /** Next charge date. Pauses are judged against it. */
    currentPeriodEnd: timestamp('current_period_end', { withTimezone: true }).notNull(),
    cancelAt: timestamp('cancel_at', { withTimezone: true }),
    /** Stripe subscription id, FluentCart order id, etc. */
    billingRef: text('billing_ref'),
    /**
     * Rewritten with a fresh value by transactions that must not overlap (Doltgres
     * has no row locks, but rejects two transactions that change the same cell).
     */
    claim: uuid('claim'),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('retainers_one_open_per_client')
      .on(t.clientId)
      .where(sql`${t.status} <> 'ended'`),
    check('retainers_active_limit_positive', sql`${t.activeLimit} between 1 and 10`),
  ],
)

export const pauses = desk.table(
  'pauses',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    retainerId: uuid('retainer_id')
      .notNull()
      .references(() => retainers.id, { onDelete: 'cascade' }),
    /** Calendar month paused, YYYY-MM. */
    month: text('month').notNull(),
    requestedAt: timestamp('requested_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('pauses_retainer_month').on(t.retainerId, t.month)],
)

export const requests = desk.table(
  'requests',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    clientId: uuid('client_id')
      .notNull()
      .references(() => clients.id, { onDelete: 'cascade' }),
    number: integer('number').notNull(),
    title: text('title').notNull(),
    /** Required before a request can be queued. */
    type: text('type').$type<RequestType>(),
    /** What starts it: the one trigger. */
    trigger: text('trigger'),
    /** What comes back: the one result handed to the client. */
    result: text('result'),
    /** The tools, accounts and places it touches (e.g. their HighLevel, n8n, Vercel). */
    systems: text('systems'),
    /** How it's done today, or what goes wrong now. */
    currentWay: text('current_way'),
    /** Examples, files or links that show what they mean. */
    links: text('links'),
    /** Who the work is for: one of the client's own customers, or someone on their team. */
    forKind: text('for_kind').$type<'customer' | 'team'>(),
    /** A customers.id or contacts.id, depending on forKind. */
    forId: uuid('for_id'),
    /** The name shown with the request, kept with it so lists need no joins. */
    forName: text('for_name'),
    status: text('status').$type<RequestStatus>().notNull().default('new'),
    /** Order in the client's queue; lower runs first. Only set while queued. */
    position: integer('position'),
    sizeDays: integer('size_days'),
    parentId: uuid('parent_id'),
    needsCall: boolean('needs_call').notNull().default(false),
    source: text('source').notNull().default('owner'),
    submittedBy: text('submitted_by'),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
    replyDueAt: timestamp('reply_due_at', { withTimezone: true }),
    firstResponseAt: timestamp('first_response_at', { withTimezone: true }),
    startedAt: timestamp('started_at', { withTimezone: true }),
    deliveredAt: timestamp('delivered_at', { withTimezone: true }),
    closedAt: timestamp('closed_at', { withTimezone: true }),
    deliverableUrl: text('deliverable_url'),
    createdAt: createdAt(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('requests_client_number').on(t.clientId, t.number),
    index('requests_client_status_idx').on(t.clientId, t.status),
    check('requests_size_days', sql`${t.sizeDays} is null or ${t.sizeDays} between 2 and 5`),
  ],
)

/** A client's own customers, so each request can say who it's for (e.g. Rene Gonzalez, The Tax Doctor). */
export const customers = desk.table(
  'customers',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    clientId: uuid('client_id')
      .notNull()
      .references(() => clients.id, { onDelete: 'cascade' }),
    firstName: text('first_name').notNull(),
    lastName: text('last_name'),
    company: text('company'),
    notes: text('notes'),
    createdAt: createdAt(),
  },
  (t) => [index('customers_client_idx').on(t.clientId)],
)

export type Customer = typeof customers.$inferSelect

export const updates = desk.table(
  'updates',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    requestId: uuid('request_id')
      .notNull()
      .references(() => requests.id, { onDelete: 'cascade' }),
    /** 'owner', 'system', 'agent:<id>' or 'contact:<id>'. */
    author: text('author').notNull(),
    kind: text('kind')
      .$type<'note' | 'status' | 'client_message' | 'deliverable'>()
      .notNull()
      .default('note'),
    body: text('body').notNull(),
    visibility: text('visibility').$type<'internal' | 'client'>().notNull().default('internal'),
    createdAt: createdAt(),
  },
  (t) => [index('updates_request_idx').on(t.requestId, t.createdAt)],
)

export const channels = desk.table(
  'channels',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    clientId: uuid('client_id')
      .notNull()
      .references(() => clients.id, { onDelete: 'cascade' }),
    kind: text('kind').$type<ChannelKind>().notNull(),
    /** Telegram chat id, Slack channel id, email address, or portal slug. */
    externalId: text('external_id').notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('channels_kind_external').on(t.kind, t.externalId)],
)

/**
 * Payments seen from billing (Stripe webhooks today). The event id makes a
 * redelivered webhook a no-op; `outcome` says what the desk did with it.
 */
export const billingEvents = desk.table(
  'billing_events',
  {
    id: text('id').primaryKey(),
    source: text('source').$type<'stripe'>().notNull(),
    kind: text('kind').notNull(),
    retainerId: uuid('retainer_id').references(() => retainers.id, { onDelete: 'set null' }),
    invoiceId: text('invoice_id'),
    amountCents: integer('amount_cents'),
    currency: text('currency'),
    paidAt: timestamp('paid_at', { withTimezone: true }),
    outcome: text('outcome').notNull(),
    createdAt: createdAt(),
  },
  (t) => [index('billing_events_retainer_idx').on(t.retainerId, t.createdAt)],
)

export const apiKeys = desk.table('api_keys', {
  id: uuid('id').primaryKey().defaultRandom(),
  label: text('label').notNull(),
  scope: text('scope').$type<'admin' | 'client'>().notNull(),
  clientId: uuid('client_id').references(() => clients.id, { onDelete: 'cascade' }),
  /** sha256 of the key; the key itself is shown once. */
  hash: text('hash').notNull().unique(),
  prefix: text('prefix').notNull(),
  lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  createdAt: createdAt(),
})

export type Client = typeof clients.$inferSelect
export type Contact = typeof contacts.$inferSelect
export type Retainer = typeof retainers.$inferSelect
export type Pause = typeof pauses.$inferSelect
export type Request = typeof requests.$inferSelect
export type Update = typeof updates.$inferSelect
export type Channel = typeof channels.$inferSelect
export type ApiKey = typeof apiKeys.$inferSelect
export type BillingEvent = typeof billingEvents.$inferSelect
