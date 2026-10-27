/**
 * Shared pieces for the desk's MCP Apps view: the host connection and theme,
 * calling desk tools, talking to Claude, and small drawing helpers.
 */
import {
  App,
  applyDocumentTheme,
  applyHostFonts,
  applyHostStyleVariables,
  type McpUiHostContext,
} from '@modelcontextprotocol/ext-apps'

export const app = new App(
  { name: 'client-desk', version: '2.0.0' },
  { availableDisplayModes: ['inline', 'fullscreen'] },
  { autoResize: true },
)

export const root = document.getElementById('root')!

// ---------- host context ----------

let ctx: Partial<McpUiHostContext> = {}
export const hostContext = () => ctx

export function applyContext(changed: Partial<McpUiHostContext>) {
  ctx = { ...ctx, ...changed }
  if (changed.theme) applyDocumentTheme(changed.theme)
  if (changed.styles?.variables) applyHostStyleVariables(changed.styles.variables)
  if (changed.styles?.css?.fonts) applyHostFonts(changed.styles.css.fonts)
  document.body.classList.toggle('fullscreen', ctx.displayMode === 'fullscreen')
  const inset = ctx.safeAreaInsets
  if (inset) {
    document.body.style.padding = `${inset.top}px ${inset.right}px ${inset.bottom}px ${inset.left}px`
  }
}

export const isFullscreen = () => ctx.displayMode === 'fullscreen'
export const canFullscreen = () => (ctx.availableDisplayModes ?? []).includes('fullscreen')
export const timeZone = () => ctx.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone

export async function toggleFullscreen() {
  const mode = isFullscreen() ? 'inline' : 'fullscreen'
  const res = await app.requestDisplayMode({ mode })
  applyContext({ displayMode: res.mode })
  return res.mode
}

// ---------- tools ----------

/** A tool result's data: structuredContent, or the JSON text for list results. */
export function dataOf(result: { structuredContent?: unknown; content?: Array<{ type: string; text?: string }> }) {
  if (result.structuredContent && Object.keys(result.structuredContent as object).length) return result.structuredContent
  const text = result.content?.find((c) => c.type === 'text')?.text
  if (!text) return null
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

/** Run a desk tool from the view. A refusal comes back as an Error with the desk's own words. */
export async function call<T = any>(name: string, args: Record<string, unknown> = {}): Promise<T> {
  const res = await app.callServerTool({ name, arguments: args })
  const data = dataOf(res as any)
  if (res.isError) {
    const msg = typeof data === 'string' ? data : (data as any)?.message ?? (data as any)?.error ?? 'That didn’t work'
    throw new Error(String(msg).replace(/^Error:\s*/, ''))
  }
  return data as T
}

// ---------- talking to Claude ----------

let superseded = false
export const isSuperseded = () => superseded

/** Put words in the chat as the person, for anything that needs Claude (free text, follow-ups). */
export function say(text: string) {
  if (superseded) return
  return app.sendMessage({ role: 'user', content: [{ type: 'text', text }] }).catch(() => undefined)
}

/** Tell Claude what the person did on the view, so its next answer knows. */
export function tell(text: string, structuredContent?: Record<string, unknown>) {
  if (superseded) return
  return app
    .updateModelContext({ content: [{ type: 'text', text }], ...(structuredContent && { structuredContent }) })
    .catch(() => undefined)
}

export function openLink(url: string) {
  return app.openLink({ url }).catch(() => window.open(url, '_blank', 'noopener'))
}

/**
 * Only the newest copy of a view about the same thing stays live (Claude keeps
 * every earlier copy mounted). Older ones grey out and stop talking to Claude.
 * The order comes from the server's time on the result, so it holds on reload.
 */
export function supersede(topic: string, at: number, onChange: () => void) {
  if (typeof BroadcastChannel === 'undefined' || !Number.isFinite(at)) return
  const me = String(ctx.toolInfo?.id ?? crypto.randomUUID())
  const channel = new BroadcastChannel(`client-desk:${topic}`)
  const newer = (o: { at: number; id: string }) => o.at > at || (o.at === at && o.id > me)
  channel.onmessage = (ev) => {
    const msg = ev.data as { type: string; at: number; id: string }
    if (!msg || msg.id === me) return
    if (msg.type === 'hello') channel.postMessage({ type: 'here', at, id: me })
    if (newer(msg) && !superseded) {
      superseded = true
      document.body.classList.add('superseded')
      onChange()
    }
  }
  channel.postMessage({ type: 'hello', at, id: me })
}

// ---------- drawing ----------

export const esc = (s: unknown) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)

const tz = () => ({ timeZone: timeZone() })
export const day = (iso: string | Date | null | undefined) =>
  iso ? new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', ...tz() }) : ''
export const dayTime = (iso: string | Date | null | undefined) =>
  iso
    ? new Date(iso).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', ...tz() })
    : ''
export const money = (cents: number, currency = 'usd') =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: currency.toUpperCase(), maximumFractionDigits: cents % 100 ? 2 : 0 }).format(cents / 100)
export const monthName = (ym: string, long = false) => {
  const [y, m] = ym.split('-').map(Number)
  return new Date(Date.UTC(y!, m! - 1, 15)).toLocaleDateString(undefined, { month: long ? 'long' : 'short', timeZone: 'UTC' })
}

/** "in 3h 20m", "2 days ago". */
export function fromNow(iso: string | Date, now = Date.now()) {
  const ms = new Date(iso).getTime() - now
  const past = ms < 0
  const m = Math.round(Math.abs(ms) / 60000)
  const text =
    m < 1 ? 'now' : m < 60 ? `${m}m` : m < 60 * 24 ? `${Math.floor(m / 60)}h${m % 60 ? ` ${m % 60}m` : ''}` : `${Math.round(m / 1440)} day${Math.round(m / 1440) === 1 ? '' : 's'}`
  if (text === 'now') return 'just now'
  return past ? `${text} ago` : `in ${text}`
}

/** 0 calm … 3 overdue, for colouring reply deadlines. */
export function heat(dueIso: string | Date, now = Date.now()) {
  const h = (new Date(dueIso).getTime() - now) / 3_600_000
  return h < 0 ? 3 : h < 2 ? 2 : h < 8 ? 1 : 0
}

export const typeLabel: Record<string, string> = {
  build: 'Build',
  fix: 'Fix',
  decision: 'Decision',
  working_session: 'Working session',
}

export const statusLabel: Record<string, string> = {
  new: 'Received',
  scoping: 'Being scoped',
  queued: 'In the queue',
  active: 'In progress',
  in_review: 'Ready for review',
  waiting_on_client: 'Waiting on you',
  done: 'Done',
  declined: 'Declined',
}

export const statusTone: Record<string, string> = {
  new: 'info',
  scoping: 'info',
  queued: '',
  active: 'ok',
  in_review: 'warn',
  waiting_on_client: 'warn',
  done: 'ok',
  declined: 'bad',
}

export const pill = (text: string, tone = '') => `<span class="pill ${tone}"><span class="dot"></span>${esc(text)}</span>`

const STAGES = [
  ['new', 'Received'],
  ['scoping', 'Scoped'],
  ['queued', 'Queued'],
  ['active', 'In progress'],
  ['in_review', 'Review'],
  ['done', 'Done'],
] as const

/** The request's journey as a row of segments, the current one lit. */
export function stages(status: string) {
  if (status === 'declined') return ''
  const at = status === 'waiting_on_client' ? 'active' : status
  const idx = STAGES.findIndex(([s]) => s === at)
  return `<div class="stages" style="--n:${STAGES.length}" role="img" aria-label="Stage: ${esc(statusLabel[status] ?? status)}">${STAGES.map(
    ([s, label], i) =>
      `<div class="stage ${i < idx ? 'done' : i === idx ? `now${status === 'active' ? ' pulse' : ''}` : ''}"><span>${esc(
        i === idx && status === 'waiting_on_client' ? 'Waiting on you' : label,
      )}</span></div>`,
  ).join('')}</div>`
}

/** Days in progress against its size: "Day 2 of 3". */
export function progress(startedAt: string | null, sizeDays: number | null) {
  if (!startedAt || !sizeDays) return ''
  const elapsed = Math.max(1, Math.ceil((Date.now() - new Date(startedAt).getTime()) / 86_400_000))
  const pct = Math.min(100, Math.round((elapsed / sizeDays) * 100))
  return `<div class="row small muted" style="margin-top:6px"><div class="bar grow"><i style="width:${pct}%"></i></div><span>Day ${Math.min(
    elapsed,
    sizeDays,
  )} of ${sizeDays}</span></div>`
}

export const icons = {
  expand:
    '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="M9.5 2.5h4v4M6.5 13.5h-4v-4M13.5 2.5 9 7M2.5 13.5 7 9"/></svg>',
  collapse:
    '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="M13.5 6.5h-4v-4M2.5 9.5h4v4M9.5 6.5 14 2M6.5 9.5 2 14"/></svg>',
  refresh:
    '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9M13.5 2.5v3h-3"/></svg>',
  arrow:
    '<svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="M3 9h12M11 5l4 4-4 4"/></svg>',
  up: '<svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="M3 8.5 7 4.5l4 4"/></svg>',
  down: '<svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="M3 5.5 7 9.5l4-4"/></svg>',
}

/** The expand/collapse button, only where the host offers full screen. */
export const fullscreenButton = () =>
  canFullscreen()
    ? `<button class="icon ghost" data-act="fullscreen" aria-label="${isFullscreen() ? 'Exit full screen' : 'Full screen'}" title="${
        isFullscreen() ? 'Exit full screen' : 'Full screen'
      }">${isFullscreen() ? icons.collapse : icons.expand}</button>`
    : ''

// ---------- actions ----------

type Handler = (el: HTMLElement) => unknown
const handlers: Record<string, Handler> = {
  fullscreen: async () => {
    await toggleFullscreen().catch(() => undefined)
    rerender()
  },
}
let rerender: () => void = () => undefined

/** Register the view's buttons (data-act="name") and how to redraw it. */
export function on(acts: Record<string, Handler>, redraw: () => void) {
  Object.assign(handlers, acts)
  rerender = redraw
}

root.addEventListener('click', async (e) => {
  const el = (e.target as HTMLElement).closest<HTMLElement>('[data-act]')
  if (!el || superseded) return
  const handler = handlers[el.dataset.act!]
  if (!handler) return
  e.preventDefault()
  const card = el.closest('.card') ?? root
  card.classList.add('busy')
  try {
    await handler(el)
  } catch (err) {
    flash((err as Error).message, 'bad')
  } finally {
    card.classList.remove('busy')
  }
})

/** A short note under the view. */
export function flash(text: string, tone: 'ok' | 'bad' | '' = '') {
  root.querySelector('.toast')?.remove()
  const el = document.createElement('div')
  el.className = `toast ${tone} appear`
  el.setAttribute('role', tone === 'bad' ? 'alert' : 'status')
  el.textContent = text
  root.appendChild(el)
}

export function draw(html: string) {
  root.innerHTML = html
}

/** " · For Rene Gonzalez, The Tax Doctor": who a request is for, as a meta-line piece. */
export function forText(f: string | { name: string } | null | undefined) {
  const name = typeof f === 'string' ? f : f?.name
  return name ? ` · For ${esc(name)}` : ''
}
