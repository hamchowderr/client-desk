/**
 * The board, as an MCP Apps view. Rendered inside Claude Desktop (and any host
 * that supports MCP Apps) when the `show_board` tool runs.
 */
import { App } from '@modelcontextprotocol/ext-apps'

type Item = { id: string; title: string; type: string | null; sizeDays: number | null }
type Board = {
  at: string
  repliesDue: Array<{ id: string; client: string; title: string; dueAt: string; overdue: boolean }>
  counts: { overdueReplies: number; repliesDueToday: number; active: number; queued: number; waitingOnClients: number }
  spots: { taken: number; capacity: number }
  clients: Array<{
    code: string
    name: string
    retainer: { status: string; activeLimit: number; nextChargeAt: string | null }
    active: Item[]
    queued: Item[]
    intake: Item[]
    inReview: Item[]
    waitingOnClient: Item[]
  }>
}

const root = document.getElementById('root')!
const esc = (s: unknown) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
const when = (iso: string) =>
  new Date(iso).toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' })
const typeLabel = (t: string | null) => (t ? t.replace('_', ' ') : 'untyped')

function list(title: string, items: Item[]) {
  if (!items.length) return ''
  return `<div class="group"><div class="label">${esc(title)}</div>${items
    .map(
      (i) =>
        `<div class="row"><span class="rid">${esc(i.id)}</span><span class="title">${esc(i.title)}</span><span class="meta">${esc(
          typeLabel(i.type),
        )}${i.sizeDays ? ` · ${i.sizeDays}d` : ''}</span></div>`,
    )
    .join('')}</div>`
}

function render(b: Board) {
  const stat = (n: number, label: string, warn = false) =>
    `<div class="stat${warn && n ? ' warn' : ''}"><div class="n">${n}</div><div class="l">${esc(label)}</div></div>`
  root.innerHTML = `
    <header>
      <h1>Client Desk</h1>
      <button id="refresh" type="button">Refresh</button>
    </header>
    <div class="stats">
      ${stat(b.counts.overdueReplies, 'replies overdue', true)}
      ${stat(b.counts.repliesDueToday, 'replies due today')}
      ${stat(b.counts.active, 'active')}
      ${stat(b.counts.queued, 'queued')}
      ${stat(b.counts.waitingOnClients, 'waiting on clients')}
      <div class="stat"><div class="n">${b.spots.taken}/${b.spots.capacity}</div><div class="l">spots taken</div></div>
    </div>
    ${
      b.repliesDue.length
        ? `<section><h2>Replies owed</h2>${b.repliesDue
            .map(
              (r) =>
                `<div class="row${r.overdue ? ' overdue' : ''}"><span class="rid">${esc(r.id)}</span><span class="title">${esc(
                  r.title,
                )}</span><span class="meta">${esc(r.client)} · ${r.overdue ? 'overdue since' : 'by'} ${esc(when(r.dueAt))}</span></div>`,
            )
            .join('')}</section>`
        : ''
    }
    <section class="clients">${b.clients
      .map(
        (c) => `<article>
          <div class="chead"><strong>${esc(c.name)}</strong><span class="pill ${esc(c.retainer.status)}">${esc(
            c.retainer.status,
          )}</span><span class="meta">${c.active.length}/${c.retainer.activeLimit} active</span></div>
          ${list('Active', c.active)}${list('In review', c.inReview)}${list('Waiting on client', c.waitingOnClient)}${list(
            'Queue',
            c.queued,
          )}${list('Intake', c.intake)}
          ${
            !c.active.length && !c.queued.length && !c.intake.length && !c.inReview.length && !c.waitingOnClient.length
              ? '<div class="empty">Nothing open</div>'
              : ''
          }
        </article>`,
      )
      .join('')}</section>`
  document.getElementById('refresh')!.onclick = refresh
}

const app = new App({ name: 'client-desk-board', version: '1.0.0' }, {}, { autoResize: true })

async function refresh() {
  root.classList.add('loading')
  try {
    const res = await app.callServerTool({ name: 'show_board', arguments: {} })
    if (res.structuredContent) render(res.structuredContent as unknown as Board)
  } finally {
    root.classList.remove('loading')
  }
}

app.ontoolresult = (params) => {
  if (params.structuredContent) render(params.structuredContent as unknown as Board)
}

app.connect().catch((e: unknown) => {
  root.textContent = `Could not connect to the host: ${String(e)}`
})
